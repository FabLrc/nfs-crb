#!/usr/bin/env node
// Report on a recording of tools/web_race_record.mjs, one row per 30 s chunk:
//   node tools/web_race_record_report.mjs <record dir> [CarbonRecomp.js.symbols] [--top 12]
// Frames: fps, frame interval p50/p95/p99/max, hitches (intervals over 50 ms), draws, the page's
// WebGPU encoding time (pump). Threads: the game thread's busy share, baton wait and guest-code
// share, the sound thread's busy and free-run shares, the page thread's busy share. Then the game
// thread's top host functions (self time) over the chunks that show a race (over 1300 draws).
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const args = process.argv.slice(2);
let top = 12;
const pos = [];
for (let i = 0; i < args.length; i++) args[i] === "--top" ? (top = +args[++i]) : pos.push(args[i]);
const [dir, symPath = join(ROOT, "build/web/recomp/CarbonRecomp.js.symbols")] = pos;

const sym = new Map();
if (existsSync(symPath))
  for (const line of readFileSync(symPath, "utf8").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) sym.set(+line.slice(0, i), line.slice(i + 1).trim());
  }
const nm = (f) => { const m = /^wasm-function\[(\d+)\]$/.exec(f); return m ? sym.get(+m[1]) || f : f || "(anon)"; };
const q = (a, p) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.min(s.length - 1, Math.floor(p * s.length))] : 0; };
const pct = (v, t) => (t ? (100 * v / t).toFixed(1) : "-").padStart(5);
const IDLE = new Set(["(idle)", "(program)", "(garbage collector)", "_do_futex_wait"]);
const freeRun = (() => {
  const url = existsSync(join(dir, "url.txt")) ? readFileSync(join(dir, "url.txt"), "utf8") : "";
  const env = new URL(url.trim() || "http://x/").searchParams.get("RECOMP_FREE_RUN");
  if (env) return env === "0" ? [] : env.split(",").map((a) => `fn_${a.trim().padStart(8, "0").toLowerCase()}`);
  const m = /^free_run\s*=\s*\[([^\]]*)\]/m.exec(readFileSync(join(ROOT, "game.toml"), "utf8"));
  return m ? m[1].split(",").map((a) => `fn_${a.trim().replace(/^0x/, "").padStart(8, "0").toLowerCase()}`).filter((a) => a !== "fn_00000000") : [];
})();

function thread({ name, profile }) {
  const byId = new Map(profile.nodes.map((n) => [n.id, n])), parent = new Map();
  for (const n of profile.nodes) for (const c of n.children || []) parent.set(c, n.id);
  const fname = new Map();
  const nameOf = (id) => { let v = fname.get(id); if (v === undefined) fname.set(id, (v = nm(byId.get(id).callFrame.functionName))); return v; };
  let total = 0, idle = 0, baton = 0, guest = 0, free = 0, entry = false, guestAny = false;
  const self = new Map();
  profile.samples.forEach((id, k) => {
    const dt = (profile.timeDeltas[k] || 0) / 1000;
    total += dt;
    const f = nameOf(id);
    self.set(f, (self.get(f) || 0) + dt);
    if (IDLE.has(f)) idle += dt;
    if (/^(fn_|body_)/.test(f)) { guest += dt; guestAny = true; }
    const chain = [];
    for (let p = id; p !== undefined; p = parent.get(p)) chain.push(nameOf(p));
    if (chain.includes("run_entry(X86*)")) entry = true;
    if (chain.some((x) => x.includes("wait_baton_locked"))) baton += dt;
    if (!IDLE.has(f)) {
      const i = chain.findIndex((x) => freeRun.includes(x));
      if (i >= 0 && !chain.slice(0, i).some((x) => x.startsWith("imports_dispatch_holding"))) free += dt;
    }
  });
  return { name, total, busy: total - idle, baton, guest, free, entry, guestAny, self };
}

const frameChunks = existsSync(join(dir, "frames.jsonl"))
  ? readFileSync(join(dir, "frames.jsonl"), "utf8").trim().split("\n").map((l) => JSON.parse(l)) : [];
const profFiles = readdirSync(dir).filter((f) => /^profile-\d+\.json$/.test(f)).sort();
const raceSelf = new Map();
let raceTotal = 0;
console.log(`recording ${dir}`);
console.log("chunk   at    fps  p50  p95  p99    max hitch draws pump | game: busy baton guest | sound: busy free | page busy");
for (const file of profFiles) {
  const n = +/(\d+)/.exec(file)[1];
  const fc = frameChunks.find((c) => c.chunk === n);
  const rows = fc ? fc.rows : [];
  const dt = rows.slice(1).map((r, i) => r[0] - rows[i][0]);
  const fps = rows.length > 1 ? rows.length / ((rows.at(-1)[0] - rows[0][0]) / 1000) : 0;
  const draws = rows.length ? rows.reduce((a, r) => a + r[4], 0) / rows.length : 0;
  const pump = rows.length ? rows.reduce((a, r) => a + r[1], 0) / rows.length : 0;
  const threads = JSON.parse(readFileSync(join(dir, file), "utf8")).map(thread);
  const game = threads.find((t) => t.entry) || threads.filter((t) => t.guestAny).sort((a, b) => b.busy - a.busy)[0];
  const sound = threads.filter((t) => t !== game && t.guestAny).sort((a, b) => b.free - a.free || b.busy - a.busy)[0];
  const main = threads.find((t) => t.name === "main");
  const f = (v, w = 4, d = 1) => v.toFixed(d).padStart(w);
  console.log(`${String(n).padStart(5)} ${f(fc ? fc.at : 0, 5, 0)} ${f(fps, 6)} ${f(q(dt, .5), 4)} ${f(q(dt, .95), 4)} ${f(q(dt, .99), 4)} ${f(dt.length ? Math.max(...dt) : 0, 6, 0)} ${String(dt.filter((x) => x > 50).length).padStart(5)} ${f(draws, 5, 0)} ${f(pump, 4, 2)} |` +
    ` ${game ? `${pct(game.busy, game.total)} ${pct(game.baton, game.total)} ${pct(game.guest, game.total)}` : "-"} |` +
    ` ${sound ? `${pct(sound.busy, sound.total)} ${pct(sound.free, sound.total)}` : "-"} | ${main ? pct(main.busy, main.total) : "-"}`);
  if (game && draws > 1300) {
    raceTotal += game.total;
    for (const [k, v] of game.self) raceSelf.set(k, (raceSelf.get(k) || 0) + v);
  }
}
if (raceTotal) {
  console.log(`\ngame thread over the race chunks (${(raceTotal / 1000).toFixed(0)} s), self time:`);
  const all = [...raceSelf].filter(([k]) => !IDLE.has(k)).sort((a, b) => b[1] - a[1]);
  const guestShare = all.filter(([k]) => /^(fn_|body_)/.test(k)).reduce((a, [, v]) => a + v, 0);
  console.log(`  guest code (fn_/body_) ${pct(guestShare, raceTotal)}%`);
  for (const [k, v] of all.filter(([k]) => !/^(fn_|body_)/.test(k)).slice(0, top)) console.log(`  ${pct(v, raceTotal)}%  ${k.slice(0, 100)}`);
}
