# Enquête performances (navigateur)

Journal de travail de la branche `perf/measurement`. Il donne l'état, les mesures avant/après, la méthode de chaque mesure et les pistes restantes, pour reprendre le travail ailleurs. Mis à jour à chaque étape. Les plus récentes sont en bas de « Journal ».

Point de départ : conversation « pistes d'optimisation » (projets comparables : NFSU2 navigateur, Cricket 07, d3d9-webgl) et le commit `2c4c705` de `main`.

## Environnement de mesure

- Mac Apple Silicon, Chrome 156, build web Release (`source/tools/build.py --target web`).
- Serveur local et streaming des fichiers du jeu depuis `assets.nfscrb.xyz` : voir `LOCAL-TESTING.md`. Ce fichier est **personnel et non versionné** (`.git/info/exclude`), il faut le copier sur l'autre poste. Après chaque build, il faut refaire son étape 4 (`games.json` et `worker.js`) : `build.py` réécrit `build/web-site/`.
- Il faut fermer le jeu pendant les compilations : il prend du CPU.

## Outils (sur la branche)

| Outil | Rôle |
|---|---|
| `source/tools/web_race_bench.mjs` | Lance Chrome sur la build locale. Traverse les menus jusqu'à la première Quick Race (circuit Main Street, Camaro, voiture arrêtée sur la grille), mesure N s, ferme Chrome. Écrit dans `build/bench/<date>-<label>/` : `frames.json`, `profile.json` (profils CPU de la page et des 24 workers), `console.txt`, captures, `report.txt`. Usage : `cd source && bun tools/web_race_bench.mjs --label X --seconds 45 [--env RECOMP_…=…] [--symbols fichier.symbols] [--throttle]`. |
| `RECOMP_FRAME_LIMIT=<fps>` (URL) | Remplace le réglage « Frame limit ». `120` laisse de la marge au-dessus de 60. `1000` supprime toute limite, utile **uniquement pour mesurer**. |
| `RECOMP_D3D9_STATS=1` (URL) | Une ligne par frame dans `globalThis.__d3d9Frames` : `[t ms, pump ms (encodage WebGPU, thread principal), attente du thread jeu, defer, draws, phase A/B]`. |
| `RECOMP_AB_PERIOD=10` et `RECOMP_AB_SWITCHES=…` | A/B **dans la même partie** : toutes les 10 s, un interrupteur reprend l'ancien comportement. Le rapport du bench sépare les deux phases. `platform/ab_phase.h` liste les interrupteurs existants. |
| `RECOMP_FREE_RUN=<hex>,<hex>` | Remplace sans recompiler la liste free run de `game.toml`. `0` la désactive. |
| `RECOMP_AUDIO_STATS=1` | Toutes les 5 s, par buffer son : Ko/s écrits et lus, avance sur le curseur, écritures en retard, clics. |

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

## Pistes restantes

Classées par ordre de rentabilité.

**C. Couche de traduction sur le thread de jeu**, à valider par profil avant/après, et par A/B dans la même partie si c'est activable à l'exécution :
1. Effets D3DX/FX (6,9 %) : `share_parameter`, `bind_constants_impl`, `apply_state`, `shared_setter<Fx_SetMatrix>`, `Fx_CommitChanges`.
2. Dispatch (6,1 %) : `recomp_call` (appels indirects), le surcoût par appel de `imports_dispatch_holding`, `recomp_module_call`.
3. `fe_render_hook` (cumulé 3,8 %) : hook REPLACE sur chaque objet d'interface dessiné (`005b0920`, `mods/core/nfsc/fe_pad.h`).
4. `sched_checkpoint` : une lecture d'horloge (`performance.now()` via JS) par appel d'import, à espacer comme `RECOMP_SCHED_CHECKPOINT_STRIDE`.
5. D3D9 (6 %) : `gpu_draw`, `queue_draw`, `gpu_sync`.

**A. Accélérer l'interpréteur pour les routines audio EA**, gain estimé environ +3 % de fps. Chaque appel paie un mutex, une table et un `memcmp` de toute la routine (vérification de code modifié), puis interprète environ 300 `MOV`. Pistes : cache par cible sans verrou, et `memcmp` remplacé par une génération ou un hash.

**B. Traduire ces routines à l'avance, reconnues par leur contenu**, gain estimé +6–8 %. Il faut normaliser les `call rel32` vers des cibles absolues, puis identifier les routines par hash.

**Clôturées** : `-O2` sur `gpu_backend`, suppression de la limite de fps pour les joueurs, free run de `0089e2e3`.

**Non traitées** (voir la conversation de départ) : `-msimd128`, registres en variables locales et `restrict` dans `translate.py`, analyse globale des flags, création asynchrone des pipelines.
