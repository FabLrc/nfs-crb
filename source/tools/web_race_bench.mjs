#!/usr/bin/env bun
// Browser race benchmark: launches Chrome on the local web build, drives the menus to the first
// Quick Race (Circuit, Main Street), waits for the start, then records the frame timings
// (RECOMP_D3D9_STATS) and a CPU profile of every thread (the page and each pthread worker).
//
//   bun tools/web_race_bench.mjs [--label NAME] [--seconds 45] [--fps-cap 120]
//       [--env RECOMP_X=1 ...] [--throttle] [--no-profile] [--keep-open]
//
// Needs Bun or Node >= 22 (a global WebSocket) and the local server of LOCAL-TESTING.md
// (http://localhost:8000/nfsc/). Results go to build/bench/<time>-<label>/: frames.json,
// profile.json (raw CPU profiles), report.txt (also printed).
//
// Steps: title -> Continue -> cancel "Connecting to EA Nation" -> Quick Race -> six Accepts
// (race, mode, car, transmission, wingman) -> the race scene (over 1300 draws a frame) ->
// settle -> measure. The car stays on the grid unless --throttle holds the accelerator. The
// window is pinned to 1200x736 @2x so every run renders the same pixels.
//
// Separate runs differ by up to 3x in fps on the same build: the browser's threads land on
// faster or slower cores (performance or efficiency cores, clock). The audio thread's "free
// run" share is the sound mixer, a fixed amount of work per second (48 kHz), so it says how
// fast this run's cores were: compare runs only at a similar share, or use an in-run A/B
// (--env RECOMP_AB_PERIOD=10 --env RECOMP_AB_SWITCHES=...), whose phases share the cores.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
// Chrome's usual install place on each system; --chrome overrides it.
const defaultChrome = process.platform === "win32"
  ? join(process.env.PROGRAMFILES || "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe")
  : process.platform === "darwin" ? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
  : "google-chrome";

// ---- options ----
const argv = process.argv.slice(2);
const opt = {
  label: "run", seconds: 45, settle: 5, fpsCap: "120", env: [], throttle: false, profile: true,
  keepOpen: false, url: "http://localhost:8000/nfsc/", port: 9333,
  chrome: defaultChrome,
  // A profile of its own, kept between runs: the streamed game files stay cached in it.
  userDataDir: join(tmpdir(), "nfsc-chrome"), symbols: join(ROOT, "build/web/recomp/CarbonRecomp.js.symbols"),
  out: join(ROOT, "build/bench"),
};
for (let i = 0; i < argv.length; i++) {
  const a = argv[i], next = () => argv[++i];
  if (a === "--label") opt.label = next();
  else if (a === "--seconds") opt.seconds = +next();
  else if (a === "--settle") opt.settle = +next();
  else if (a === "--fps-cap") opt.fpsCap = next();
  else if (a === "--env") opt.env.push(next());
  else if (a === "--throttle") opt.throttle = true;
  else if (a === "--no-profile") opt.profile = false;
  else if (a === "--keep-open") opt.keepOpen = true;
  else if (a === "--url") opt.url = next();
  else if (a === "--port") opt.port = +next();
  else if (a === "--chrome") opt.chrome = next();
  else if (a === "--user-data-dir") opt.userDataDir = next();
  else if (a === "--symbols") opt.symbols = next();
  else if (a === "--out") opt.out = next();
  else { console.error(`unknown option ${a}; see the header of ${fileURLToPath(import.meta.url)}`); process.exit(2); }
}
if (typeof WebSocket === "undefined") { console.error("needs a global WebSocket: Bun, or Node >= 22"); process.exit(2); }

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(`[bench ${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---- Chrome and the DevTools protocol ----
const params = new URLSearchParams({ RECOMP_D3D9_STATS: "1", RECOMP_FRAME_LIMIT: opt.fpsCap });
for (const kv of opt.env) { const i = kv.indexOf("="); params.set(kv.slice(0, i), kv.slice(i + 1)); }
const gameUrl = `${opt.url}?${params}`;

const chrome = spawn(opt.chrome, [
  // WebGPU is on by default; --enable-unsafe-webgpu would add an infobar that shrinks the page.
  `--user-data-dir=${opt.userDataDir}`, `--remote-debugging-port=${opt.port}`,
  "--autoplay-policy=no-user-gesture-required", "--no-first-run", "--no-default-browser-check",
  // A covered or unfocused window must not be throttled while it is measured.
  "--disable-background-timer-throttling", "--disable-renderer-backgrounding",
  "--disable-backgrounding-occluded-windows", "--window-size=1240,900",
  // Windows: a covered window stops presenting (about 1 fps) despite the flags above.
  ...(process.platform === "win32" ? ["--disable-features=CalculateNativeWinOcclusion"] : []),
  "about:blank",
], { stdio: "ignore" });
// The next run reuses the profile and the port: wait until this Chrome has really gone.
const exited = new Promise((r) => chrome.once("exit", r));
const quit = async () => {
  if (opt.keepOpen) return;
  chrome.kill();
  await Promise.race([exited, sleep(15000)]);
};

let wsUrl = null;
for (let i = 0; i < 100 && !wsUrl; i++) {
  try { wsUrl = (await (await fetch(`http://127.0.0.1:${opt.port}/json/version`)).json()).webSocketDebuggerUrl; }
  catch { await sleep(200); }
}
if (!wsUrl) { console.error("Chrome did not open its debugging port"); await quit(); process.exit(1); }

const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let nextId = 1;
const pending = new Map(), handlers = [];
ws.onmessage = (ev) => {
  const m = JSON.parse(typeof ev.data === "string" ? ev.data : ev.data.toString());
  if (m.id && pending.has(m.id)) {
    const { resolve: ok, reject: fail } = pending.get(m.id);
    pending.delete(m.id);
    m.error ? fail(new Error(`${m.error.message} (${m.error.code})`)) : ok(m.result);
  } else if (m.method) for (const h of handlers) h(m);
};
const send = (method, p = {}, sessionId) => new Promise((ok, fail) => {
  const id = nextId++;
  pending.set(id, { resolve: ok, reject: fail });
  ws.send(JSON.stringify({ id, method, params: p, ...(sessionId ? { sessionId } : {}) }));
});

const { targetInfos } = await send("Target.getTargets");
const pageTarget = targetInfos.find((t) => t.type === "page");
const { sessionId: page } = await send("Target.attachToTarget", { targetId: pageTarget.targetId, flatten: true });
const workers = new Map(); // sessionId -> label
const consoleLines = []; // the page's console (the game's stdout and stderr), saved as console.txt
handlers.push((m) => {
  if (m.method === "Target.attachedToTarget" && m.params.targetInfo.type === "worker")
    workers.set(m.params.sessionId, `w${workers.size}`);
  if (m.method === "Target.detachedFromTarget") workers.delete(m.params.sessionId);
  if (m.method === "Runtime.consoleAPICalled")
    consoleLines.push(m.params.args.map((a) => a.value ?? a.description ?? "").join(" "));
});
await send("Page.enable", {}, page);
await send("Runtime.enable", {}, page);
await send("Target.setAutoAttach", { autoAttach: true, waitForDebuggerOnStart: false, flatten: true }, page);
await send("Emulation.setDeviceMetricsOverride", { width: 1200, height: 736, deviceScaleFactor: 2, mobile: false }, page);
await send("Network.enable", {}, page);
await send("Network.setCacheDisabled", { cacheDisabled: true }, page); // always the build on disk
await send("Page.navigate", { url: gameUrl }, page);
log("loading", gameUrl);

const evaluate = async (expression) => {
  const r = await send("Runtime.evaluate", { expression, returnByValue: true, awaitPromise: true }, page);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || "evaluate failed");
  return r.result.value;
};
const KEYS = { Enter: 13, ArrowRight: 39, ArrowUp: 38 };
const keyDown = (key) => send("Input.dispatchKeyEvent",
  { type: "keyDown", key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key], ...(key === "Enter" ? { text: "\r" } : {}) }, page);
const keyUp = (key) => send("Input.dispatchKeyEvent", { type: "keyUp", key, code: key, windowsVirtualKeyCode: KEYS[key], nativeVirtualKeyCode: KEYS[key] }, page);
const press = async (key, gap = 700) => { await keyDown(key); await sleep(120); await keyUp(key); await sleep(gap); };
const click = async (x, y) => {
  await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y }, page);
  await sleep(300);
  await send("Input.dispatchMouseEvent", { type: "mousePressed", x, y, button: "left", clickCount: 1 }, page);
  await sleep(150);
  await send("Input.dispatchMouseEvent", { type: "mouseReleased", x, y, button: "left", clickCount: 1 }, page);
};
const shot = async (name) => {
  const { data } = await send("Page.captureScreenshot", { format: "png" }, page);
  writeFileSync(join(outDir, `${name}.png`), Buffer.from(data, "base64"));
};
// Mean draws of the last 30 frames handed to the presenter (d3d9_host.cpp __d3d9Frames).
const draws = () => evaluate(`(() => { const f = globalThis.__d3d9Frames || []; const s = f.slice(-30);
  return s.length ? s.reduce((a, r) => a + r[4], 0) / s.length : 0; })()`);
const frameCount = () => evaluate("(globalThis.__d3d9Frames || []).length");

const stamp = new Date().toISOString().replace(/[:T]/g, "-").slice(0, 19);
const outDir = join(opt.out, `${stamp}-${opt.label}`);
mkdirSync(outDir, { recursive: true });

async function fail(why) {
  log("FAILED:", why);
  await shot("failure").catch(() => {});
  log("screenshot:", join(outDir, "failure.png"));
  writeFileSync(join(outDir, "console.txt"), consoleLines.join("\n"));
  await quit();
  process.exit(1);
}
const until = async (what, test, seconds, every = 1000) => {
  for (let t = 0; t < seconds * 1000; t += every) { if (await test()) return true; await sleep(every); }
  return false;
};

// ---- menus ----
if (!await until("title", async () => (await frameCount().catch(() => 0)) > 300, 240, 2000)) await fail("the game never presented frames");
log("title screen; continuing");
await click(600, 460);
// "Load complete" (~500 draws) after the profile loads; Continue, then cancel the EA Nation
// dialog (~600 draws) that the offline game raises right after it.
if (!await until("load", async () => (await draws()) > 450, 90, 2000)) await fail("no Load complete screen");
await sleep(3000);
await press("Enter", 6000);
let menu = false;
for (let attempt = 0; attempt < 4 && !menu; attempt++) {
  const d = await draws();
  if (d > 570) { log(`EA Nation dialog (${d.toFixed(0)} draws); cancelling`); await press("Enter", 6000); }
  else if (d < 508) { log(`still on Load complete (${d.toFixed(0)} draws); Continue`); await press("Enter", 6000); }
  else menu = true;
}
if (!menu) await fail("the main menu did not come up");
log("main menu; Quick Race");
for (let i = 0; i < 3; i++) await press("ArrowRight");
await sleep(1500);
await shot("menu");
for (let i = 0; i < 6; i++) await press("Enter", 4500); // map, race, mode, car, transmission, wingman
// The race scene draws over 1300 a frame, the menus 500-620. A screen still loading swallows an
// Accept, so while the menus are up one more is pressed; loading screens ignore it.
let raced = false;
for (let t = 0; t < 150 && !raced; t += 2) {
  const d = await draws();
  raced = d > 1300;
  if (!raced && d > 400 && d < 700 && t < 60 && t % 8 === 6) await press("Enter", 0);
  if (!raced) await sleep(2000);
}
if (!raced) await fail(`no Quick Race start (${(await draws()).toFixed(0)} draws)`);
log("racing");
if (opt.throttle) await keyDown("ArrowUp");
await sleep(opt.settle * 1000);

// ---- measurement ----
await evaluate("globalThis.__d3d9Frames.length = 0");
const sessions = [["main", page], ...[...workers].map(([s, n]) => [n, s])];
if (opt.profile) for (const [, s] of sessions) {
  await send("Profiler.enable", {}, s);
  await send("Profiler.setSamplingInterval", { interval: 500 }, s);
  await send("Profiler.start", {}, s);
}
log(`measuring ${opt.seconds} s (${sessions.length - 1} workers)`);
await sleep(opt.seconds * 1000);
const profiles = [];
if (opt.profile) for (const [name, s] of sessions) profiles.push({ name, profile: (await send("Profiler.stop", {}, s)).profile });
const rows = await evaluate("globalThis.__d3d9Frames.slice()");
if (opt.throttle) await keyUp("ArrowUp");
await shot("race");
writeFileSync(join(outDir, "frames.json"), JSON.stringify(rows));
if (opt.profile) writeFileSync(join(outDir, "profile.json"), JSON.stringify(profiles));
writeFileSync(join(outDir, "console.txt"), consoleLines.join("\n"));
await quit();
ws.close();

// ---- report ----
const sym = new Map();
if (existsSync(opt.symbols))
  for (const line of readFileSync(opt.symbols, "utf8").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) sym.set(+line.slice(0, i), line.slice(i + 1));
  }
const nm = (f) => { const m = /^wasm-function\[(\d+)\]$/.exec(f); return m ? sym.get(+m[1]) || f : f || "(anon)"; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(p * s.length))]; };
const mean = (a) => a.reduce((x, y) => x + y, 0) / (a.length || 1);
const fx = (v, n = 2) => +v.toFixed(n);

function frameStats(r) {
  const dt = r.slice(1).map((x, i) => x[0] - r[i][0]);
  return { frames: r.length, fps: fx(r.length / ((r.at(-1)[0] - r[0][0]) / 1000)), dt_p50: fx(q(dt, 0.5)), dt_p95: fx(q(dt, 0.95)),
    dt_p99: fx(q(dt, 0.99)), pump_ms: fx(mean(r.map((x) => x[1]))), game_wait_ms: fx(mean(r.map((x) => x[2]))), draws: fx(mean(r.map((x) => x[4])), 0) };
}
// An in-run A/B (RECOMP_AB_PERIOD): the last column says which phase drew the frame.
function abStats(r) {
  const ph = [[], []];
  for (let i = 1; i < r.length; i++) if (r[i][5] === r[i - 1][5]) ph[r[i][5] ? 1 : 0].push(r[i][0] - r[i - 1][0]);
  if (!ph[0].length || !ph[1].length) return null;
  const s = (d) => ({ frames: d.length, fps: fx(1000 * d.length / d.reduce((a, b) => a + b, 0)), dt_p95: fx(q(d, 0.95)) });
  const cur = s(ph[0]), old = s(ph[1]);
  return { current: cur, earlier: old, gain_pct: fx(100 * (cur.fps / old.fps - 1), 1) };
}

const IDLE = new Set(["(idle)", "(program)", "(garbage collector)", "_do_futex_wait"]);
const freeRun = (() => {
  const env = params.get("RECOMP_FREE_RUN");
  if (env) return env === "0" ? [] : env.split(",").map((a) => `fn_${a.trim().padStart(8, "0").toLowerCase()}`);
  const m = /^free_run\s*=\s*\[([^\]]*)\]/m.exec(readFileSync(join(ROOT, "game.toml"), "utf8"));
  return m ? m[1].split(",").map((a) => `fn_${a.trim().replace(/^0x/, "").padStart(8, "0").toLowerCase()}`).filter((a) => a !== "fn_00000000") : [];
})();

function analyze({ name, profile }) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const fname = (id) => nm(byId.get(id).callFrame.functionName);
  const self = new Map(), incl = new Map(), waits = new Map();
  let total = 0, held = 0, free = 0;
  profile.samples.forEach((id, k) => {
    const dt = (profile.timeDeltas[k] || 0) / 1000;
    total += dt;
    const f = fname(id);
    self.set(f, (self.get(f) || 0) + dt);
    const chain = [];
    for (let p = id; p !== undefined; p = parent.get(p)) chain.push(fname(p));
    for (const g of new Set(chain)) incl.set(g, (incl.get(g) || 0) + dt);
    if (f === "_do_futex_wait") {
      const key = chain.slice(1).filter((x) => !/futex|timedwait|pthread_cond|condition_variable|__wait/.test(x)).slice(0, 3).join(" < ");
      waits.set(key, (waits.get(key) || 0) + dt);
    } else if (!IDLE.has(f)) {
      // Guest code below a free-run function, outside a shim, runs without the baton.
      const i = chain.findIndex((x) => freeRun.includes(x));
      if (i >= 0 && !chain.slice(0, i).some((x) => x.startsWith("imports_dispatch_holding"))) free += dt; else held += dt;
    }
  });
  const idle = [...IDLE].reduce((a, f) => a + (self.get(f) || 0), 0);
  const sorted = (m) => [...m].sort((a, b) => b[1] - a[1]);
  const guest = incl.has("recomp_call") || [...self.keys()].some((f) => /^(fn_|body_)/.test(f));
  return { name, total, busy: total - idle, held, free, guest, entry: incl.has("run_entry(X86*)"), self: sorted(self).filter(([f]) => !IDLE.has(f)),
    incl: sorted(incl), waits: sorted(waits), baton: [...incl].find(([f]) => f.includes("wait_baton_locked"))?.[1] || 0,
    guestSelf: [...self].filter(([f]) => /^(fn_|body_)/.test(f)).reduce((a, [, v]) => a + v, 0) };
}

let report = `bench ${opt.label}  ${new Date().toISOString()}\nurl ${gameUrl}\n\nframes ${JSON.stringify(frameStats(rows))}\n`;
const ab = abStats(rows);
if (ab) report += `in-run A/B ${JSON.stringify(ab)}\n`;
if (frameStats(rows).draws < 1300) report += "WARNING: under 1300 draws a frame: probably not the race scene\n";
if (opt.profile) {
  const threads = profiles.map(analyze).sort((a, b) => b.busy - a.busy);
  const game = threads.find((t) => t.entry) || threads.find((t) => t.guest);
  const others = threads.filter((t) => t !== game && t.guest && t.busy > t.total * 0.05);
  const main = threads.find((t) => t.name === "main");
  const pc = (t, v) => `${(100 * v / t.total).toFixed(2).padStart(6)}%`;
  const section = (t, title, n = 25) => {
    let s = `\n## ${title} (${t.name}): busy ${pc(t, t.busy).trim()}`;
    if (t.guest) s += `, baton wait ${pc(t, t.baton).trim()}, guest code ${pc(t, t.guestSelf).trim()}, holding the baton ${pc(t, t.held).trim()}, free run ${pc(t, t.free).trim()}`;
    s += "\n### self\n" + t.self.slice(0, n).map(([f, v]) => `${pc(t, v)}  ${f}`).join("\n");
    s += "\n### inclusive\n" + t.incl.filter(([f]) => !/^(\(root\)|js-to-wasm|wasm-to-js|invoke_|handleMessage|invokeEntryPoint|void\* std::__2::__thread_proxy|run_entry|.*thread_host_main)/.test(f))
      .slice(0, n).map(([f, v]) => `${pc(t, v)}  ${f}`).join("\n");
    if (t.waits.length) s += "\n### waits by caller\n" + t.waits.slice(0, 6).map(([f, v]) => `${pc(t, v)}  ${f}`).join("\n");
    return s + "\n";
  };
  if (game) report += section(game, "game thread", 40);
  for (const t of others) report += section(t, "guest thread");
  if (main) report += section(main, "page main thread", 15);
}
writeFileSync(join(outDir, "report.txt"), report);
console.log(report);
log("results in", outDir);
process.exit(0);
