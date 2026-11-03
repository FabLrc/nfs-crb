# Enquête performances (navigateur)

Journal de travail de la branche `perf/measurement`. Il donne l'état, les mesures avant/après, la méthode de chaque mesure et les pistes restantes, pour reprendre le travail ailleurs. Mis à jour à chaque étape. Les plus récentes sont en bas de « Journal ».

Point de départ : la conversation « pistes d'optimisation » (https://claude.ai/share/85085aed-bd88-42b6-b50b-ebbff98dd01c ; projets comparables : NFSU2 navigateur, Cricket 07, d3d9-webgl) et le commit `2c4c705` de `main`. Ses pistes ont été vérifiées sur le code : la plupart des optimisations de rendu de NFSU2 sont déjà en place (rendu sur un thread séparé, caches de pipelines et de bind groups, textures BC, tables de saut en switch). Le reste est classé dans « Suite proposée ».

## Reprendre le travail (autre poste, nouvel agent)

**État au 3 novembre 2026.** Branche `perf/measurement`, partie de `main` (`2c4c705`) ; `git log main..perf/measurement` liste les commits. Seuls 3 commits modifient le jeu :
- `631e0f7` : deux routines audio sont maintenant traduites au lieu d'être interprétées ;
- `0e368f0` : deux hooks de customisation sont filtrés par site d'appel ;
- `f451be2` : entrées correspondantes dans le changelog.

Les autres sont des outils de mesure et ce journal.

À faire avant de reprendre :
1. **Récupérer la branche.** Elle n'existe que sur le Mac d'origine tant qu'elle n'est pas poussée : `git push -u origin perf/measurement` depuis ce Mac, puis `git fetch && git switch perf/measurement` sur l'autre poste.
2. **Vérification visuelle jamais faite** : en course, avec des jantes ou pneus personnalisés et un carrossage (stance) modifié, les roues doivent s'afficher comme sur `main` (commit `0e368f0`).
3. **Mettre en place la build web locale**, voir ci-dessous.

### Build web et serveur local

La procédure complète est dans `LOCAL-TESTING.md`, à la racine du dépôt (versionné sur cette branche). Elle est écrite pour macOS ; sur Windows, il faut adapter :

| macOS (`LOCAL-TESTING.md`) | Windows |
|---|---|
| `source ~/emsdk/emsdk_env.sh` | `emsdk_env.bat` (cmd) ou `emsdk_env.ps1` (PowerShell) |
| `source/.venv/bin/python` | `source\.venv\Scripts\python.exe` |
| `shasum -a 256` | `certutil -hashfile NFSC.exe SHA256` |
| `~/Library/NFSC-Native-Setup/` (Ghidra, JDK) | Chemins affichés par `tools/fetch_tools.py` |
| `/tmp/nfsc-serve.py` (serveur avec proxy vers `assets.nfscrb.xyz`) | Même script Python, enregistré où on veut |

Ordre : récupérer `NFSC.exe` et les DLL, `setup.py --link-only`, `rebase_pe.py`, `analyze.py` (environ 8 min), puis `tools/build.py --target web --regenerate`. La première build prend environ 13 à 25 min ; une build sans `--regenerate` environ 1 à 2 min.

**Après chaque build**, `build.py` réécrit `build/web-site/`. Il faut alors réappliquer l'étape 4 de `LOCAL-TESTING.md` : streaming distant dans `games.json`, HTTP accepté sur localhost dans `worker.js`. Ce script la refait. Il attend le `games.json` de la release publiée, téléchargé une fois dans `g.json` à côté de lui (voir `LOCAL-TESTING.md` pour l'URL).

```python
# patch_site.py <dossier build/web-site> <g.json de la release>
import json, sys, os
site, release = sys.argv[1], sys.argv[2]
rel = json.load(open(release))[0]
g = json.load(open(os.path.join(site, 'games.json'))); e = g[0]
for k in ('downloadBytes', 'streamAssets', 'streamPreparationScript'):
    e[k] = rel[k]
e['downloadManifest'] = '/remote/local-game/manifest.json'
json.dump(g, open(os.path.join(site, 'games.json'), 'w'), indent=2)
p = os.path.join(site, 'worker.js'); s = open(p).read()
old = 'if (remote && url.protocol !== "https:")'
new = 'if (remote && url.protocol !== "https:" && url.hostname !== "localhost")'
if new not in s:
    assert old in s, "worker.js pattern missing"
    s = s.replace(old, new)
open(p, 'w').write(s)
print("patched")
```

### Outils de mesure sur Windows

- `web_race_bench.mjs` demande **Bun** (ou Node 22 et plus). Il trouve Chrome à sa place habituelle (`%ProgramFiles%\Google\Chrome\Application\chrome.exe`), sinon il faut passer `--chrome`. Son profil Chrome est `%TEMP%\nfsc-chrome` : le premier lancement télécharge les fichiers du jeu.
- `web_race_ab.sh` est un script `sh` : il faut le lancer depuis Git Bash.
- La variance mesurée ici vient du Mac (cœurs performance et efficacité, App Nap). Il faut la **remesurer sur le PC** : 3 ou 4 exécutions de la même build, en comparant les fps et la part de free run audio. Les processeurs Intel récents (12e génération et plus) ont aussi des cœurs efficacité. Le mode d'alimentation « Performances optimales » et la fenêtre au premier plan limitent le problème.
- Les noms des fonctions wasm viennent de `build/web/recomp/CarbonRecomp.js.symbols`, propre à chaque build. Il faut le garder avec chaque build qu'on compare.

## Environnement de mesure (Mac d'origine)

- Mac Apple Silicon, Chrome 156, build web Release.
- Il faut fermer le jeu pendant les compilations : il prend du CPU.

## Outils (sur la branche)

| Outil | Rôle |
|---|---|
| `source/tools/web_race_bench.mjs` | Lance Chrome sur la build locale. Traverse les menus jusqu'à la première Quick Race (circuit Main Street, Camaro, voiture arrêtée sur la grille), mesure N s, ferme Chrome. Écrit dans `build/bench/<date>-<label>/` : `frames.json`, `profile.json` (profils CPU de la page et des 24 workers), `console.txt`, captures, `report.txt`. Usage : `cd source && bun tools/web_race_bench.mjs --label X --seconds 45 [--env RECOMP_…=…] [--symbols fichier.symbols] [--throttle]`. |
| `source/tools/web_race_ab.sh` | Benchs alternés de builds sauvegardées : `tools/web_race_ab.sh 45 /chemin/buildA:a1 /chemin/buildB:b1 … [-- options du bench]`. Chaque dossier contient `CarbonRecomp.{wasm,js,data,js.symbols}`, copiés juste après la build. Chrome est lancé sans `--enable-unsafe-webgpu` : WebGPU est actif par défaut, et ce drapeau ajoute une barre d'avertissement qui réduit la page. |
| `RECOMP_FRAME_LIMIT=<fps>` (URL) | Remplace le réglage « Frame limit ». `120` laisse de la marge au-dessus de 60. `1000` supprime toute limite, utile **uniquement pour mesurer**. |
| `RECOMP_D3D9_STATS=1` (URL) | Une ligne par frame dans `globalThis.__d3d9Frames` : `[t ms, pump ms (encodage WebGPU, thread principal), attente du thread jeu, defer, draws, phase A/B]`. |
| `RECOMP_AB_PERIOD=10` et `RECOMP_AB_SWITCHES=…` | A/B **dans la même partie** : toutes les 10 s, un interrupteur reprend l'ancien comportement. Le rapport du bench sépare les deux phases. `platform/ab_phase.h` liste les interrupteurs existants. |
| `RECOMP_FREE_RUN=<hex>,<hex>` | Remplace sans recompiler la liste free run de `game.toml`. `0` la désactive. |
| `RECOMP_AUDIO_STATS=1` | Toutes les 5 s, par buffer son : Ko/s écrits et lus, avance sur le curseur, écritures en retard, clics. |
| `RECOMP_IMPORT_RATES=<s>` | Toutes les N s : appels d'imports Windows, D3D9 et D3DX par seconde et par frame, avec les 30 plus fréquents (dans `console.txt` du bench). |

Noms des fonctions wasm : `build/web/recomp/CarbonRecomp.js.symbols`. Cette table est **propre à chaque build**, et une régénération (`--regenerate`) renumérote tout. Pour comparer deux builds, il faut garder les `.symbols` de chacune et les passer avec `--symbols`.

Lire un profil :
- `_do_futex_wait` est une attente (`Atomics.wait`), pas du travail.
- L'attente du « baton », le verrou global des threads invités, se repère à `wait_baton_locked`.
- `fn_XXXXXXXX` et `body_XXXXXXXX` sont du code x86 traduit, à l'adresse indiquée dans `NFSC.exe`.

## ⚠️ Variance entre exécutions : à lire avant toute comparaison

Sur ce Mac, la **même build** donne de 23 à 70 fps d'un lancement à l'autre, sur la même scène. Ce n'est pas un comportement du jeu.

- `RECOMP_AUDIO_STATS` montre que le mixeur écrit toujours 188 Ko/s, soit 48 kHz stéréo 16 bits, exactement la vitesse du curseur. Le travail audio est donc constant.
- Le **temps** pour faire ce travail varie de 1× à 1,7× (part de free run du thread audio : 4–6 % dans les exécutions rapides, 8–10 % dans les lentes).
- Cause la plus probable : macOS place les threads de Chrome sur des cœurs performance ou efficacité, à fréquence variable.

Règles qui en découlent :
1. **Ne jamais comparer les fps de deux lancements différents** pour juger un petit changement.
2. Pour un changement activable à l'exécution : **A/B dans la même partie** (`RECOMP_AB_PERIOD`). Les deux phases tournent sur les mêmes cœurs.
3. Pour un changement de compilation ou d'installation : comparer les **profils CPU**, c'est-à-dire la part des fonctions concernées, qui ne dépend pas de la vitesse des cœurs.
4. La part de free run audio dans `report.txt` indique la vitesse des cœurs du lancement.

Lancer Chrome sans les drapeaux anti-throttling du script (fenêtre masquée ou en arrière-plan) aggrave encore la situation. Mes premières mesures manuelles, autour de 23–25 fps, en ont probablement souffert.

## Diagnostic

Profil de ta course (25 fps, plafond 120), confirmé ensuite sur la grille de départ :

| Thread | Occupé | Remarques |
|---|---|---|
| Jeu principal (pthread exécutant `run_entry`) | 77–79 % | **Attend le baton 21 % du temps** (`sched_checkpoint → guest_yield → wait_baton_locked`) |
| Audio (thread du moteur son EA) | 27–45 % | Garde le baton environ 19 %, et tourne sans lui environ 9 % (free run du mixeur `008afde7`) |
| Page (rendu WebGPU) | 15 % | Pas un goulot |
| GPU | environ 5 ms par frame | Pas un goulot |

Thread de jeu, temps propre, sur la build de référence `entry-1` (grille de départ, 30 s) :

| Catégorie | % du thread |
|---|---|
| Code du jeu (x86 traduit) | 48,5 |
| Effets D3DX/FX (`share_parameter`, `bind_constants`, `apply_state`…) | 6,9 |
| Dispatch (`recomp_call`, `imports_dispatch_holding`, `recomp_module_call`) | 6,1 |
| D3D9 (`gpu_draw`, `queue_draw`, `Dev_*`) | 6,0 |
| Hooks de mods (copies de l'état CPU, `run_one`, `copy_chain`) | 4,2 (après la piste C : 1,4) |
| Scheduler et horloge | 2,5 |

La sensibilité est forte : sortir environ 8 % du temps audio du baton fait gagner +11 % de fps (A/B ci-dessous).

## Journal

### 1. `gpu_backend` en `-O2` : rejeté

Méthode : menu principal (environ 520 draws), plafond 60 Hz, 2 × 60 s par build, avec la fenêtre fixée à 1200×736 @2x, puis A/B/A en course arrêtée. Sur le web, `gpu_backend` ne contient que `webgpu_device.cpp` et `gpu_factory.cpp`. Le code exécuté à chaque draw (`d3d9_webgpu.cpp`, `d3d9_host.cpp`) est déjà en `-O2` dans `recomp_app`.

| | pump moyen | fps |
|---|---|---|
| `-O1`, mêmes conditions | 0,795–0,833 ms | 59,1–59,4 |
| `-O2` | 0,813–0,818 ms | 59,4–59,6 |
| Course `-O1` | | 43,3 / 51,6 / 57,3 |
| Course `-O2` | | 56,3 / 56,1 / 53,8 |

Aucun écart au-delà du bruit. **Retiré.**

### 2. Plafond 120 et suppression de la limite

- Le réglage existe déjà : « Frame limit » Original, 40, 60 ou 120. « Original » n'est pas illimité : le jeu garde son propre limiteur à 60 Hz.
- Sans limite (`RECOMP_FRAME_LIMIT=1000`), le comportement est instable : soit 112–129 frames produites par seconde avec un affichage effondré à 25–30 fps, soit 70 produites pour 60 affichées. **À ne pas proposer aux joueurs.** Commit `649510c` (outil de mesure).

### 3. Free run du mixeur audio : A/B de référence

Méthode : `RECOMP_AB_PERIOD=10&RECOMP_AB_SWITCHES=audio`, course arrêtée sur la grille, 120 s. La phase « earlier » coupe tout free run.

| Phase | fps | intervalle p95 |
|---|---|---|
| Sans free run | 39,72 | 44,3 ms |
| Free run du mixeur `008afde7` (actuel) | 44,26 | 33,9 ms |

Soit **+11,4 %**. C'est la preuve que le temps où l'audio garde le baton pèse directement sur les fps.

### 4. Free run étendu à la boucle des callbacks audio `0089e2e3` : rejeté

Méthode : même A/B avec `RECOMP_FREE_RUN=008afde7,0089e2e3`. Gain réduit à **+2,9 %** (33,47 → 34,45 fps) : les appels internes reprennent puis rendent le baton, et ces échanges coûtent plus qu'ils ne rapportent. **Rejeté.**

### 5. Interpréteur sur le thread audio

`interp_call` représente 6,5 % du thread audio, pendant qu'il tient le baton. Un compteur temporaire par adresse, retiré depuis, a identifié deux cas.

- **Deux routines de l'image oubliées par la découverte** : `0089e647` (remise à zéro de 7 dwords, atteinte par pointeur) et, dans msvcr71, `1001159b` (bloc `__finally`, `_unlock(7)`, atteint par le déroulement SEH). Ajoutées aux `entry_points` de `game.toml`, commit `631e0f7`. Gain mineur, non chiffré.
- **L'essentiel : du code chargé sur le tas par le moteur audio EA.** Ce sont des routines par patch de son, de la forme `push esi; mov esi,[esp+8]; call 00897ba8; …; call 00897bb7; mov [esi+X],eax …` : des copies de paramètres. Il y en a une dizaine actives, à environ 1 500 appels par seconde, à des adresses du tas (`0x017c6630`, `0x0202d1a8`…) qui changent à chaque lancement. Elles sont appelées par `0089e2e3`, qui parcourt la liste chaînée en `[0x00bbee10]` (insertion `00898f51`, retrait `00898f6e`). Les `entry_points` ne peuvent pas les couvrir. Les pistes A et B, plus bas, en découlent.

Pour retrouver la mémoire invitée depuis la page : chercher l'en-tête de `NFSC.exe` dans `recompSettingsBlock.memory.buffer`, sachant que l'image est à l'adresse invitée `0x400000`. Ce jour-là, `g_mem` valait `0x05210000`.

### 6. Piste C, premier point : hooks de mods filtrés par site d'appel

Deux callbacks de customisation interceptaient tous les appels d'une fonction très fréquente :
- `cust_stance_camber_ftol` sur `_ftol` (`0087eac0`), alors qu'il n'agit qu'aux appels `007df79b` et `007df7d1` ;
- `cust_tire_wheel3` sur le rendu de modèle `007ae210`, alors qu'il n'agit qu'à `007dfefc`, `007e009d` et `007e029a`.

Ils sont maintenant installés avec `hook_install_at_callsite`, comme `cust_tire_wheel4` l'était déjà. L'appel global reste en repli pour les hôtes plus anciens. Les entrées `_ftol` passent de REPLACE à WRAP : le dispatch est identique, mais une fonction n'accepte qu'un seul REPLACE, quel que soit le site d'appel. Commit `0e368f0`.

Méthode : profil de course, build `entry` (avant) contre `hooks` (après), 30 s sur la grille, deux lancements chacun. Ce sont des parts de fonctions, insensibles à la vitesse des cœurs.

| Thread de jeu | Avant (entry-1 / entry-2) | Après (hooks-1 / hooks-2) |
|---|---|---|
| Mécanique des hooks (temps propre) | 4,77 / 4,02 % | 1,41 / 1,39 % |
| `cust_stance_camber_ftol` (cumulé) | 2,09 / 2,06 % | 0,02 / 0,02 % |
| `cust_tire_wheel3` (cumulé) | 1,26 / 1,35 % | 0,23 / 0,23 % |

Les fps de ces lancements (12 à 70) ne sont pas exploitables, à cause de la variance décrite plus haut. Les hooks s'installent sans échec (`customization: source stance controls … installed`). **Reste à vérifier à l'œil** : jantes et pneus personnalisés, carrossage modifié, en course.

### 7. Volume d'appels d'imports et coût du dispatch

Méthode : `bun tools/web_race_bench.mjs --env RECOMP_IMPORT_RATES=10 --no-profile`, course sur la grille, 40 s. Ce sont des **comptages**, insensibles à la vitesse des cœurs.

Il y a **2,05 millions d'appels par seconde, soit 27 363 par frame**. Les plus fréquents, par frame :

| Import | Appels |
|---|---|
| `SetRenderState` | 5 932 |
| `ID3DXEffect::SetMatrix` | 3 168 |
| `D3DXMatrixMultiply` | 2 871 |
| `ID3DXEffect::SetVector` | 1 733 |
| `ID3DXEffect::CommitChanges` | 1 659 |
| `ID3DXEffect::SetTexture` | 1 463 |
| `DrawIndexedPrimitive` et `SetStreamSource` | 1 433 chacun |
| `D3DXVec4Transform` | 1 358 |
| `SetSamplerState` | 1 319 |
| `SetIndices` | 1 125 |
| `D3DXMatrixTranspose` | 822 |
| `D3DXVec3Transform` | 620 |
| `SetVertexDeclaration` | 606 |

Profil (`hooks-b`, thread de jeu) : les shims eux-mêmes coûtent peu (`Dev_DrawIndexedPrimitive` 5 % en cumulé, `Fx_CommitChanges` 2,6 %, `X_D3DXMatrixMultiply` 0,9 %…). C'est le **dispatch autour** qui pèse : `imports_dispatch_holding` 4,2 % en temps propre, `sched_checkpoint` 1,4 % et sa lecture d'horloge 0,7 %, soit environ 6–7 % du thread, environ 30 ns par appel.

Pistes : rendre ce chemin plus léger (une seule lecture de la table, moins de lectures atomiques de gardes de statiques), et réduire le nombre d'appels (maths D3DX appelées directement plutôt que par l'import). Pas encore fait.

Le return observer `dx_report_failure` est appelé après chaque import, mais il sort tout de suite (bit de signe) : 0,2 %.

### 8. Expérience `restrict` sur le contexte : clôturée, sans gain mesurable

Le code généré garde chaque registre x86 en mémoire (`c->r[n]`), et chaque écriture invitée passe par `memcpy(g_mem + a, …)`. Pour l'analyse d'alias, cette écriture peut modifier `c->r`, `c->eflags_*` et même le pointeur `g_mem`. Après chaque écriture, le compilateur doit donc tout recharger, et il garde toutes les écritures de flags.

Deux contraintes de sûreté :
- `restrict` sur la mémoire invitée **n'est pas sûr** : les fonctions appelées l'écrivent par leur propre pointeur, et LLVM pourrait garder des valeurs en registre au travers d'un appel.
- `restrict` sur `c` est sûr si personne n'accède au contexte autrement que par `c` pendant un appel invité. C'est faux pour `mods/options_menu.cpp` et `mods/game_settings.cpp`, qui passent par `guest_current_context()` (sauvegarde puis restauration de `*c`) dans des hooks. En pratique, ces appels reçoivent `c`, donc le risque est faible, mais il faudrait les corriger avant d'activer `restrict`.

Montage :
- `translate.py` émet `X86 *RECOMP_RESTRICT c` dans les définitions `fn_` et `body_` ;
- `x86.h` définit `RECOMP_RESTRICT` **vide par défaut**, sans aucun changement de code ;
- la variante mesurée recompile `recomp_gen` avec `-DRECOMP_RESTRICT=__restrict`.

La variante avec `restrict` est **1,16 Mo plus petite** (119,18 → 118,02 Mo de wasm, –1 %) : beaucoup de rechargements disparaissent bien.

Mesure : `source/tools/web_race_ab.sh` lance alternativement les deux builds, 45 s de course arrêtée sur la grille chacune. 9 exécutions sans `restrict` et 8 avec. Les 9 premières ont été faites avec App Nap actif, les 8 suivantes sans.

| Build | fps par exécution | Médiane |
|---|---|---|
| sans `restrict` | 25,7 / 26,0 / 27,0 / 25,2 / 38,4 / 15,2 / 34,2 / 29,6 / 43,5 | **27,0** |
| avec `restrict` | 39,2 / 22,4 / 28,3 / 26,9 / 29,5 / 26,8 / 26,6 / 34,6 | **27,6** |

Aucune différence ne ressort d'un bruit de ±50 %. Vu le risque (cas `guest_current_context()`) et l'absence de gain prouvé, **retiré** : `translate.py`, `x86.h` et `Translate.cmake` sont revenus à l'état d'origine, et rien n'est commité.

Leçon : **sur ce Mac, les fps du navigateur ne permettent pas de juger un changement global de génération de code inférieur à environ 10 %.** Pour travailler au niveau du traducteur (registres locaux, flags, x87), il faut d'abord un banc déterministe : le harnais natif du kit (`pop_smoke` avec horloge figée, `kit/tools/recomp/performance_run.py`) et un scénario Carbon, qui n'existe pas encore (`smoke/` absent).

### 9. App Nap et fenêtre en arrière-plan

Les fenêtres du bench passaient en arrière-plan pendant que tu lisais autre chose. macOS (App Nap, priorité des threads) ralentit alors Chrome, ce que ses propres drapeaux anti-throttling ne couvrent pas. App Nap est désactivé pour Chrome sur ce poste depuis la série nr-a…rs-d :

```sh
defaults write com.google.Chrome NSAppSleepDisabled -bool YES   # retour : defaults delete com.google.Chrome NSAppSleepDisabled
```

La variance reste aussi forte sans App Nap (15 à 43 fps sur la même build). Une cause encore non identifiée subsiste : priorité des threads d'une app en arrière-plan, température, ou scène (le nombre de draws varie de 1 740 à 1 990 avec la caméra d'attente). Pendant un bench, mieux vaut garder la fenêtre au premier plan.

## Suite proposée

Dans cet ordre. Chaque étape doit se mesurer avec une méthode **insensible à la vitesse des cœurs** : part des fonctions dans le profil (le rapport du bench donne self et inclusif), comptages (`RECOMP_IMPORT_RATES`), ou A/B dans la même partie (`RECOMP_AB_PERIOD`). Il faut noter dans ce journal les mesures avant et après, la commande utilisée et la build comparée.

### Étape 0 : sur le nouveau poste

- Build de `perf/measurement`, puis 3 ou 4 benchs de la même build pour connaître la variance du poste.
- Vérification visuelle des roues personnalisées (point 2 de « Reprendre le travail »).

### Étape 1 : alléger le dispatch des imports

Gain attendu : 2 à 4 % du thread de jeu.

Constat (point 7 du journal) : 2 millions d'appels par seconde, environ 30 ns de surcoût chacun hors shim. `imports_dispatch_holding` pèse 4,2 % en temps propre, `sched_checkpoint` 1,4 %.

Fichiers : `source/kit/runtime/imports.cpp` (`imports_dispatch_holding`) et `kernel32.cpp` (`sched_checkpoint`).

Idées :
- lire une seule fois l'entrée de `tramps()`. Chaque appel à `tramps()` passe par la garde d'une statique locale, une lecture atomique en wasm avec pthreads, et la fonction l'appelle 5 à 6 fois. Attention : un shim peut agrandir le vecteur, donc il faut relire après `fn(c)` ;
- ne tester `recomp_ab::old(IMPORTS)` que si `RECOMP_AB_PERIOD` est défini ;
- regrouper `atomic`, `fn`, `argc` et `calls` dans une table compacte, à part des `std::string` ;
- dans `sched_checkpoint`, éviter les lectures atomiques séquentielles (en wasm, toutes les opérations atomiques le sont) sur le chemin qui retourne 63 fois sur 64.

Mesure : part de `imports_dispatch_holding` et de `sched_checkpoint` dans le profil du thread de jeu, avant et après. On peut ajouter un interrupteur `RECOMP_AB_SWITCHES` pour un A/B dans la même partie.

### Étape 2 : banc natif déterministe

C'est le prérequis du plus gros levier : le code du jeu fait 57 % du thread de jeu.

Le navigateur ne permet pas de juger un changement de génération de code de moins d'environ 10 % (point 8). Le kit a le harnais : `pop_smoke`, `RECOMP_PIN_CLOCK`, `kit/tools/recomp/performance_run.py`. Il manque un scénario Carbon : un dossier `source/smoke/` avec un script qui va jusqu'en course, dans le format de `kit/host/script.h` (touches, attentes, `expect`). Il faut une build native (`tools/build.py` sans `--target web`).

Objectif : un temps CPU reproductible à ±2 % sur une séquence fixe.

### Étape 3 : chantiers du traducteur

Uniquement avec le banc de l'étape 2, et dans `source/kit/tools/recomp/translate.py`.
- **Registres x86 en variables locales** plutôt que `c->r[n]`. Il faut les écrire dans `c` avant chaque appel, retour ou import, et les relire après. Cricket 07 annonce environ +30 %.
- **Analyse globale des flags** : aujourd'hui, tous les flags sont écrits avant chaque saut ou appel. L'outil `--check-flags` sert à estimer le gain.
- **x87** : chaque empilement écrit `st`, `st_bits`, `st_exact` et le tag.
- `restrict` a déjà été essayé (point 8) : aucun gain mesurable dans le navigateur, et risqué. À remesurer éventuellement sur le banc natif.

### Étape 4 : interpréteur et routines audio EA sur le tas

Gain attendu : environ +3 à +8 % de fps, d'après la sensibilité mesurée au point 3. Ces routines tournent pendant que le thread audio garde le baton (point 5).
- **A**, la version simple : dans `interp_call` (`source/kit/runtime/interp.cpp`), retrouver la routine sans mutex ni table, et remplacer le `memcmp` de toute la routine à chaque appel par une génération ou un hash. Mesure : A/B dans la même partie avec un nouvel interrupteur.
- **B**, la version ambitieuse : traduire ces routines à l'avance, reconnues par leur contenu. Il faut normaliser les `call rel32` vers des cibles absolues, puis faire correspondre par hash.

### Autres pistes, par coût sur le thread de jeu

- Effets D3DX/FX (6,9 %) : `share_parameter`, `bind_constants_impl`, `apply_state`, `shared_setter<Fx_SetMatrix>`, `Fx_CommitChanges`. Il y a 3 168 `SetMatrix` et 1 659 `CommitChanges` par frame.
- D3D9 (6 %) : `gpu_draw`, `queue_draw`, `gpu_sync`. Il y a 5 932 `SetRenderState` par frame : vérifier que les états redondants sont filtrés le plus tôt possible.
- Maths D3DX passées par l'import (`D3DXMatrixMultiply` 2 871 par frame, `D3DXVec4Transform` 1 358, `D3DXMatrixTranspose` 822) : les appeler directement, sans dispatch d'import, enlèverait environ 5 000 appels par frame.
- `fe_render_hook` (3,8 % en cumulé) : hook REPLACE sur chaque objet d'interface dessiné (`005b0920`, `source/mods/core/nfsc/fe_pad.h`).
- Non traités (voir la conversation de départ) : `-msimd128`, création asynchrone des pipelines WebGPU (saccades à la première apparition d'un effet).

### Clôturées, à ne pas refaire

`-O2` sur `gpu_backend` (point 1), suppression de la limite de fps pour les joueurs (point 2), free run de `0089e2e3` (point 4), `restrict` sur le contexte dans le navigateur (point 8).
