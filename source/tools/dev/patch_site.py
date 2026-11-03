#!/usr/bin/env python3
"""Adapt build/web-site to remote streaming after each build (LOCAL-TESTING.md, step 4).

    python tools/dev/patch_site.py build/web-site g.json

g.json is the published release's games.json, downloaded once, e.g.
https://nfscrb.xyz/releases/20261102-ui-3399a94c/play/games.json
"""
import json
import os
import sys

site, release = sys.argv[1], sys.argv[2]
rel = json.load(open(release))[0]
g = json.load(open(os.path.join(site, "games.json")))
e = g[0]
for k in ("downloadBytes", "streamAssets", "streamPreparationScript"):
    e[k] = rel[k]
e["downloadManifest"] = "/remote/local-game/manifest.json"
json.dump(g, open(os.path.join(site, "games.json"), "w"), indent=2)
p = os.path.join(site, "worker.js")
s = open(p, encoding="utf-8").read()
old = 'if (remote && url.protocol !== "https:")'
new = 'if (remote && url.protocol !== "https:" && url.hostname !== "localhost")'
if new not in s:
    assert old in s, "worker.js pattern missing"
    s = s.replace(old, new)
open(p, "w", encoding="utf-8", newline="").write(s)
print("patched")
