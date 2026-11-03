# Tester la build web en local avec les fichiers du site

Notes de travail, versionnées sur la branche `perf/measurement`. Écrites pour macOS : `PERF-INVESTIGATION.md` donne les équivalents Windows.

Objectif : construire la version navigateur depuis ce repo et la lancer sur `http://localhost:8000`. Les fichiers du jeu sont streamés depuis `assets.nfscrb.xyz`, comme sur le site, sans installation locale de Carbon.

Testé le 2026-11-03 sur un Mac Apple Silicon avec Chrome 156.

## Pré-requis (une seule fois)

- Emscripten SDK dans `~/emsdk`, activé avec `source ~/emsdk/emsdk_env.sh`.
- Python : le venv du repo, `source/.venv`.
- Ninja et CMake : la build web en a besoin, mais ils ne sont pas installés par défaut :
  ```sh
  cd source && .venv/bin/pip install ninja cmake
  ```
- Ghidra et un JDK, installés par `tools/fetch_tools.py` dans `~/Library/NFSC-Native-Setup/`.

## 1. Récupérer l'exécutable du jeu

L'analyse a besoin de `NFSC.exe` et des deux DLL. Le site les publie dans son manifeste :

```sh
mkdir -p ~/nfsc-game/{CARS,FRONTEND,GLOBAL,SOUND,TRACKS} && cd ~/nfsc-game
B=https://assets.nfscrb.xyz/local-game/files
for f in NFSC.exe msvcr71.dll msvcp71.dll GLOBAL/GlobalMemoryFile.bin; do curl -sf -o "$f" "$B/$f"; done
shasum -a 256 NFSC.exe   # doit valoir baaaaec3...52fd3 (voir source/game.toml)
```

- Les dossiers vides `CARS FRONTEND GLOBAL SOUND TRACKS` servent seulement à passer la vérification de `setup.py`.
- `GLOBAL/GlobalMemoryFile.bin` sert à générer `missing-title-font.h` (`tools/build.py`).
- Le manifeste complet est sur `https://assets.nfscrb.xyz/local-game/manifest.json` (1190 fichiers).

## 2. Préparer et analyser

```sh
cd source
.venv/bin/python tools/setup.py --game-dir "$PWD" --install ~/nfsc-game --link-only   # crée source/original -> ~/nfsc-game
.venv/bin/python tools/rebase_pe.py ~/nfsc-game                                        # crée source/rebased/
.venv/bin/python tools/fetch_tools.py                                                  # affiche les chemins Ghidra/JDK
.venv/bin/python tools/analyze.py \
  --ghidra-home "$HOME/Library/NFSC-Native-Setup/ghidra/ghidra_12.1.3_PUBLIC" \
  --java-home  "$HOME/Library/NFSC-Native-Setup/jdk/jdk-26.0.1.jdk/Contents/Home"     # ~8 min
```

Tout ce qui est produit (`original`, `rebased/`, `analysis/`, `build/`) est ignoré par git.

## 3. Build web

```sh
cd source
source ~/emsdk/emsdk_env.sh
export PATH="$PWD/.venv/bin:$PATH"           # pour ninja/cmake
.venv/bin/python tools/build.py --target web --regenerate   # 1re fois ~13 min ; ensuite sans --regenerate (~1 min)
```

Le site est généré dans `source/build/web-site/`.

## 4. Adapter le site généré au streaming distant

Ces modifications portent sur la sortie de build. Il faut les refaire après chaque build, car `build.py` réécrit le dossier.

**a) `games.json`** : y copier les champs de streaming de la release publiée, en pointant le manifeste vers le proxy local :

```sh
cd source/build/web-site
curl -s -o /tmp/g.json https://nfscrb.xyz/releases/20261102-ui-3399a94c/play/games.json   # adapter le nom de release
python3 - <<'EOF'
import json
rel = json.load(open('/tmp/g.json'))[0]
g = json.load(open('games.json')); e = g[0]
for k in ('downloadBytes', 'streamAssets', 'streamPreparationScript'):
    e[k] = rel[k]
e['downloadManifest'] = '/remote/local-game/manifest.json'
json.dump(g, open('games.json', 'w'), indent=2)
EOF
```

**b) `worker.js`** : autoriser le HTTP sur localhost. Sinon, l'erreur est « Game downloads require HTTPS » :

```sh
python3 - <<'EOF'
p = 'worker.js'; s = open(p).read()
s = s.replace('if (remote && url.protocol !== "https:")',
              'if (remote && url.protocol !== "https:" && url.hostname !== "localhost")')
open(p, 'w').write(s)
EOF
```

## 5. Serveur local + proxy

`assets.nfscrb.xyz` n'envoie pas d'en-têtes CORS, et Cloudflare bloque l'User-Agent de Python (erreur 1010). Le serveur ci-dessous reprend le serveur isolé du kit (en-têtes COOP/COEP) et ajoute deux routes :

- `/remote/*` → `https://assets.nfscrb.xyz/*`, avec transmission du `Range` ;
- `/nfsc/custom-assets/*` → `https://assets.nfscrb.xyz/customization/<hash>/*`. Sur localhost, le player lit `./custom-assets/`, qui n'existe pas dans le repo. Le hash est celui de l'`assetBase` de `source/kit/web/player/index.html`, à vérifier s'il change.

Enregistrer le code dans `/tmp/nfsc-serve.py` :

```python
#!/usr/bin/env python3
"""Kit dev server + /remote/* proxied to assets.nfscrb.xyz."""
import functools, http.server, sys, urllib.request, urllib.error
sys.path.insert(0, sys.argv[2])
import web_launcher

UP = "https://assets.nfscrb.xyz/"
CUSTOM = "/remote/customization/5911a37d9f9bc652b3fa457127273970b0d2a5e0e87c7081fb789a2c05439dbc/"
UA = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/156.0.0.0 Safari/537.36"


class H(web_launcher.IsolatedHandler):
    def _proxy(self, head=False):
        req = urllib.request.Request(UP + self.path[len("/remote/"):], method="HEAD" if head else "GET")
        req.add_header("User-Agent", UA)
        if self.headers.get("Range"):
            req.add_header("Range", self.headers["Range"])
        try:
            r = urllib.request.urlopen(req, timeout=60)
        except urllib.error.HTTPError as e:
            r = e
        body = b"" if head else r.read()
        self.send_response(r.status if hasattr(r, "status") else r.code)
        for k in ("Content-Type", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"):
            if r.headers.get(k):
                self.send_header(k, r.headers[k])
        self.send_header("Content-Length", r.headers.get("Content-Length") if head else str(len(body)))
        self.end_headers()
        if not head:
            self.wfile.write(body)

    def _remote(self):
        if self.path.startswith("/nfsc/custom-assets/"):
            self.path = CUSTOM + self.path[len("/nfsc/custom-assets/"):]
        return self.path.startswith("/remote/")

    def do_GET(self):
        if self._remote():
            return self._proxy()
        super().do_GET()

    def do_HEAD(self):
        if self._remote():
            return self._proxy(True)
        super().do_HEAD()


with http.server.ThreadingHTTPServer(("127.0.0.1", 8000), functools.partial(H, directory=sys.argv[1])) as s:
    print("serving on http://localhost:8000/", flush=True)
    s.serve_forever()
```

Lancement :

```sh
cd source
python3 /tmp/nfsc-serve.py "$PWD/build/web-site" "$PWD/kit/tools"
```

Vérification rapide : la première commande doit renvoyer `200`, la seconde `4d56 6864 ... 7670 3630` (`MVhd ... vp60`).

```sh
curl -s -o /dev/null -w "%{http_code}\n" http://127.0.0.1:8000/remote/local-game/manifest.json
curl -s -r 0-15 http://127.0.0.1:8000/remote/local-game/files/MOVIES/ea_bumper_english_ntsc.vp6 | xxd
```

## 6. Jouer

- Ouvrir **`http://localhost:8000/nfsc/`**. Il faut `localhost` et pas `127.0.0.1`, à cause du patch de `worker.js`. La racine `/` est la page de gestion des fichiers.
- Utiliser un profil Chrome dédié pour ne pas toucher au sien. WebGPU et `crossOriginIsolated` doivent être actifs :
  ```sh
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --user-data-dir=/tmp/nfsc-chrome \
    --enable-unsafe-webgpu --autoplay-policy=no-user-gesture-required http://localhost:8000/nfsc/
  ```
- Décocher « Play online » pour éviter le serveur LAN, puis cliquer sur Play.
- Le premier lancement télécharge les 79 assets de customization, puis le jeu démarre en environ 2 min.
- Ne pas utiliser de fenêtre de navigation privée : le quota y est trop bas et on obtient « not enough storage ».

## 7. Diagnostics utiles

- **Logs du serveur.** Chaque `GET /remote/local-game/chunks/<hash>.bin` est un morceau de 8 Mo. Pour savoir à quel fichier il appartient, chercher le hash dans les `pieces` de l'index de stream :
  ```sh
  curl -s -o /tmp/s.json http://127.0.0.1:8000/remote/local-game/$(python3 -c "import json,urllib.request;print(json.load(urllib.request.urlopen('https://assets.nfscrb.xyz/local-game/manifest.json'))['stream'])")
  python3 -c "import json,sys;f=json.load(open('/tmp/s.json'))['files'];h=sys.argv[1];print([p for p,v in f.items() if h in v.get('pieces',[])])" <HASH>
  ```
- **Erreurs du player.** Elles sont ajoutées dans `source/build/browser-runtime-diagnostics.jsonl`.
- **Log complet du jeu.** Le bouton « Download log » de l'écran d'erreur le fournit.
- **Modifier le code et retester :** éditer le code, refaire `tools/build.py --target web` (sans `--regenerate`), refaire l'étape 4, puis recharger la page.

## Nettoyage

```sh
rm -rf ~/nfsc-game /tmp/nfsc-chrome /tmp/nfsc-serve.py
cd source && rm -rf build analysis rebased original
```

Ghidra et le JDK peuvent rester dans `~/Library/NFSC-Native-Setup/` pour une prochaine fois.
