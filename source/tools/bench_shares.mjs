#!/usr/bin/env node
// Shares of chosen functions on the game thread, from race benches (tools/web_race_bench.mjs).
// Shares do not depend on how fast this run's cores were, unlike fps (PERF-INVESTIGATION.md).
//
//   node tools/bench_shares.mjs <bench dir>[=<symbols>] ... [--fn <regex> ...]
//
// <bench dir> is build/bench/<time>-<label>/, and <symbols> the CarbonRecomp.js.symbols of the
// build it ran (default: the current build's). Prints one row per run: fps, busy, then the self
// share (percent of the thread's samples) of each --fn regex, and their sum.
import { existsSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const runs = [], fns = [];
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  if (argv[i] === "--fn") fns.push(argv[++i]);
  else runs.push(argv[i]);
}
if (!fns.length)
  fns.push("^imports_dispatch_holding", "^imports_dispatch\\(", "^recomp_shim_call", "^recomp_call$", "^recomp_module_call$",
    "^sched_checkpoint", "^_emscripten_get_now$");

function loadSymbols(path) {
  const sym = new Map();
  if (path && existsSync(path))
    for (const line of readFileSync(path, "utf8").split("\n")) {
      const i = line.indexOf(":");
      if (i > 0) sym.set(+line.slice(0, i), line.slice(i + 1).trim());
    }
  return sym;
}

const IDLE = new Set(["(idle)", "(program)", "(garbage collector)", "_do_futex_wait"]);
const pad = (s, n) => String(s).padStart(n);
console.log(["run".padEnd(34), "fps", "busy", ...fns.map((f) => f.replace(/[\^$]/g, "").slice(0, 18)), "sum"].map((s, i) => i ? pad(s, Math.max(6, String(s).length)) : s).join(" "));
for (const spec of runs) {
  const [dir, symPath] = spec.split("=");
  const sym = loadSymbols(symPath || join(ROOT, "build/web/recomp/CarbonRecomp.js.symbols"));
  const nm = (f) => { const m = /^wasm-function\[(\d+)\]$/.exec(f); return m ? sym.get(+m[1]) || f : f || "(anon)"; };
  const profiles = JSON.parse(readFileSync(join(dir, "profile.json"), "utf8"));
  const report = readFileSync(join(dir, "report.txt"), "utf8");
  const fps = /"fps":([\d.]+)/.exec(report)?.[1];
  const gameName = /## game thread \((\w+)\)/.exec(report)?.[1];
  const { profile } = profiles.find((p) => p.name === gameName);
  const byId = new Map(profile.nodes.map((n) => [n.id, n]));
  const self = new Map();
  let total = 0, idle = 0;
  profile.samples.forEach((id, k) => {
    const dt = profile.timeDeltas[k] || 0;
    const f = nm(byId.get(id).callFrame.functionName);
    total += dt;
    if (IDLE.has(f)) idle += dt;
    self.set(f, (self.get(f) || 0) + dt);
  });
  const share = fns.map((re) => {
    const r = new RegExp(re);
    return [...self].filter(([f]) => r.test(f)).reduce((a, [, v]) => a + v, 0) / total * 100;
  });
  const cols = [fps, (100 * (total - idle) / total).toFixed(1), ...share.map((v) => v.toFixed(2)), share.reduce((a, b) => a + b, 0).toFixed(2)];
  console.log([basename(dir).padEnd(34), ...cols.map((c, i) => pad(c, Math.max(6, fns[i - 2] ? fns[i - 2].replace(/[\^$]/g, "").slice(0, 18).length : 4)))].join(" "));
}
