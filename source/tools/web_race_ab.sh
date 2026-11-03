#!/bin/sh
# Alternating browser race benches of saved builds (tools/web_race_bench.mjs), so slow and fast
# stretches of the machine fall on every build alike.
#
#   tools/web_race_ab.sh <seconds> <dir>:<label> [<dir>:<label> ...] [-- extra bench options]
#
# Each <dir> holds a saved build: CarbonRecomp.wasm, .js, .data and .js.symbols, copied from
# build/web-site/nfsc/ and build/web/recomp/ right after that build. Each run copies its build
# into build/web-site/nfsc/ (the local server's site), runs the bench and prints the summary
# lines; the full logs are in build/bench/<time>-<label>/.
set -e
cd "$(dirname "$0")/.."
mkdir -p build/bench
secs=$1; shift
specs=""
while [ $# -gt 0 ] && [ "$1" != "--" ]; do specs="$specs $1"; shift; done
[ "${1:-}" = "--" ] && shift
for spec in $specs; do
  dir=${spec%%:*}; label=${spec#*:}
  cp "$dir/CarbonRecomp.wasm" "$dir/CarbonRecomp.js" "$dir/CarbonRecomp.data" build/web-site/nfsc/
  bun tools/web_race_bench.mjs --label "$label" --symbols "$dir/CarbonRecomp.js.symbols" --seconds "$secs" "$@" \
    > "build/bench/last-$label.log" 2>&1 || true
  echo "== $label"
  grep "^frames\|^## \|FAILED\|WARNING" "build/bench/last-$label.log" || true
done
