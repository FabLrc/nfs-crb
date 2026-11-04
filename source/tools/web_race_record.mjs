#!/usr/bin/env node
// Records a race someone plays by hand: opens the local web build in a normal browser window
// (no menu driving, no viewport override) and, until build/bench/<time>-<label>/STOP exists or
// the browser closes, saves every 30 s:
//   frames.jsonl   the presented frames since the last chunk (RECOMP_D3D9_STATS rows) with the chunk number
//   profile-NNN.json  a CPU profile of the page and every worker over that chunk
//   shot-NNN.jpg   a screenshot at the end of the chunk
// and the page's console (the game's log) in console.txt, with the time of each line.
//
//   node tools/web_race_record.mjs [--label NAME] [--chunk 30] [--fps-cap 120] [--env RECOMP_X=1 ...]
//       [--interval 1000] [--chrome PATH] [--port 9333]
//
// Analyse with node tools/web_race_record_report.mjs <dir> [symbols].
import { spawn } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = {
  label: "race", chunk: 30, fpsCap: "120", env: ["RECOMP_AUDIO_STATS=1", "RECOMP_IMPORT_RATES=30"], interval: 1000,
  port: 9333, url: "http://localhost:8000/nfsc/",
  chrome: process.platform === "win32"
    ? join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe")
    : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" : "google-chrome",
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === "--label") opt.label = next();
  else if (a === "--chunk") opt.chunk = +next();
  else if (a === "--fps-cap") opt.fpsCap = next();
  else if (a === "--env") opt.env.push(next());
  else if (a === "--interval") opt.interval = +next();
  else if (a === "--chrome") opt.chrome = next();
  else if (a === "--port") opt.port = +next();
  else { console.error(`unknown option ${a}`); process.exit(2); }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[record ${new Date().toISOString().slice(11, 19)}]`, ...a);
const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const out = join(ROOT, "build/bench", `${stamp}-${opt.label}`);
mkdirSync(out, { recursive: true });

const params = new URLSearchParams({ RECOMP_D3D9_STATS: "1", RECOMP_FRAME_LIMIT: opt.fpsCap });
for (const kv of opt.env) { const i = kv.indexOf("="); params.set(kv.slice(0, i), kv.slice(i + 1)); }
const gameUrl = `${opt.url}?${params}`;

// A browser left on the port (an earlier run; Edge outlives its process on Windows) is closed first.
const portUp = async () => { try { return (await (await fetch(`http://127.0.0.1:${opt.port}/json/version`)).json()).webSocketDebuggerUrl; } catch { return null; } };
{
  const old = await portUp();
  if (old) {
    const s = new WebSocket(old);
    await new Promise((r) => { s.onopen = r; s.onerror = r; });
    try { s.send(JSON.stringify({ id: 1, method: "Browser.close" })); } catch {}
    for (let i = 0; i < 75 && await portUp(); i++) await sleep(200);
  }
}
spawn(opt.chrome, [
  `--user-data-dir=${join(tmpdir(), "nfsc-chrome")}`, `--remote-debugging-port=${opt.port}`,
  "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check",
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding", "--disable-backgrounding-occluded-windows",
  ...(process.platform === "win32" ? ["--disable-features=CalculateNativeWinOcclusion"] : []),
  "--start-maximized", "about:blank",
], { stdio: "ignore", detached: true }).unref();

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) { wsUrl = await portUp(); if (!wsUrl) await sleep(200); }
if (!wsUrl) { console.error("the browser did not open its debugging port"); process.exit(1); }
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1, closed = false;
const pending = new Map(), handlers = [];
ws.onclose = () => { closed = true; };
ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { ok, fail } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? fail(new Error(m.error.message)) : ok(m.result);
  } else if (m.method) for (const h of handlers) h(m);
};
const send = (method, p = {}, sessionId) => new Promise((ok, fail) => {
  if (closed) return fail(new Error("closed"));
  const id = nextId++;
  pending.set(id, { ok, fail });
  ws.send(JSON.stringify({ id, method, params: p, ...(sessionId ? { sessionId } : {}) }));
});

const { targetInfos } = await send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
const workers = new Map(); // sessionId -> name
let profiling = false;
const t0 = Date.now();
handlers.push((m) => {
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker") {
    const s = m.params.sessionId;
    workers.set(s, `w${workers.size}`);
    // A worker that appears mid-chunk is profiled from the next chunk.
    send("Profiler.enable", {}, s).catch(() => {});
  }
  if (m.method === "Target.detachedFromTarget") workers.delete(m.params.sessionId);
  if (m.method === "Runtime.consoleAPICalled") {
    const line = m.params.args.map((a) => a.value ?? a.description ?? "").join(" ");
    appendFileSync(join(out, "console.txt"), `${((Date.now() - t0) / 1000).toFixed(1).padStart(7)} ${line}\n`);
  }
});
await send("Page.enable", {}, page);
await send("Runtime.enable", {}, page);
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
await send("Profiler.enable", {}, page);
await send("Page.navigate", { url: gameUrl }, page);
writeFileSync(join(out, "url.txt"), gameUrl + "\n");
log("recording", gameUrl);
log(`results in ${out}; create ${join(out, "STOP")} to stop`);

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true }, page);
  return r.result?.value;
};
const sessions = () => [["main", page], ...[...workers].map(([s, n]) => [n, s])];

async function startProfiles() {
  for (const [, s] of sessions()) {
    try {
      await send("Profiler.setSamplingInterval", { interval: opt.interval }, s);
      await send("Profiler.start", {}, s);
    } catch {}
  }
  profiling = true;
}
async function stopProfiles(n) {
  const profiles = [];
  for (const [name, s] of sessions()) {
    try { profiles.push({ name, profile: (await send("Profiler.stop", {}, s)).profile }); } catch {}
  }
  profiling = false;
  writeFileSync(join(out, `profile-${String(n).padStart(3, "0")}.json`), JSON.stringify(profiles));
}

let chunk = 0;
await sleep(5000);
await startProfiles();
while (!closed && !existsSync(join(out, "STOP"))) {
  for (let t = 0; t < opt.chunk * 1000 && !closed && !existsSync(join(out, "STOP")); t += 1000) await sleep(1000);
  if (closed) break;
  const rows = await evaluate("(globalThis.__d3d9Frames || []).splice(0)").catch(() => null);
  if (rows && rows.length) appendFileSync(join(out, "frames.jsonl"), JSON.stringify({ chunk, at: (Date.now() - t0) / 1000, rows }) + "\n");
  await stopProfiles(chunk).catch(() => {});
  try {
    const { data } = await send("Page.captureScreenshot", { format: "jpeg", quality: 60 }, page);
    writeFileSync(join(out, `shot-${String(chunk).padStart(3, "0")}.jpg`), Buffer.from(data, "base64"));
  } catch (e) {
    log(`chunk ${chunk}: no screenshot (${e.message})`);
  }
  const fps = rows && rows.length > 1 ? (rows.length / ((rows.at(-1)[0] - rows[0][0]) / 1000)).toFixed(1) : "-";
  const draws = rows && rows.length ? Math.round(rows.reduce((a, r) => a + r[4], 0) / rows.length) : 0;
  log(`chunk ${chunk}: ${rows ? rows.length : 0} frames, ${fps} fps, ${draws} draws`);
  chunk++;
  if (!existsSync(join(out, "STOP")) && !closed) await startProfiles();
}
if (profiling && !closed) await stopProfiles(chunk).catch(() => {});
log("stopped after", chunk, "chunks");
process.exit(0);
