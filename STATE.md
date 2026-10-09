# STATE — working notes

**Read this first.** This file is the working state of the project: where it is,
what is in flight, what is broken, and what to do next. `README.md` explains the
design of what exists; `DESIGN.md` is the game's design document. This is the one
that goes stale fastest, and the one to update before stopping work.

Last updated: M12 complete — cosmetic-only garage (paint/wheels/roof kits),
earnable unlocks, look relayed over the wire — plus the first authored map pass
(a drivable mesa, a scrapyard crane, a dam, roads). Bot depth
(roam/engage/retreat) landed in M11 and doubled the 30-car match length. Tutorial
deferred to M14.

**2026-10-06 — realistic-slice plan, Phases 0–2 (+ music).** Theme is now a
*televised bloodsport fought in military vehicles*; the MVP is the solo brawler.
- Phase 1: solo field 30 → **12 cars** on a **180 m** spawn ring; zone opens at
  210 m, 4 phases of 20 s hold + 20 s shrink. **Open issue: matches end in ~90 s**
  (solobench, 12 cars, hard *and* normal bots, ~80% accuracy at ~9 m) — weapon
  time-to-kill, not difficulty. Target is 3–4 min; fix with the weapon rework.
- Phase 2: full-screen title card (PLAY / GARAGE / SOUND / CREDITS), a loading
  screen after PLAY that waits for every asset, diagnostics behind **F3 or `**,
  controls card only while not driving, speed+boost merged, hull bar, crew health
  hidden in solo, no gameplay HUD behind the menu.
- Music: synthwave set replaced by six Kevin MacLeod tracks (CC BY 4.0) in two
  playlists — `lobby` and a low `match` bed that rises as the zone closes.
  Credits drawer reads `playlist.json`.
- Test harness note: `matchtest` hung once mid-run (section 3 solo server never
  appeared) and passed on rerun; stray test servers on 8399–8402/8599 can be left
  behind by an interrupted run and block the next one.

**2026-10-06 — Phase 3: asset & licence pipeline.**
- `assets.json` is the licence record for every asset (SPDX ids). `npm run
  licensecheck` (in `check` and `build`) fails on an unlisted/missing file or an
  NC/ND/unknown licence, and generates `ASSETS.md` + `public/credits.json` (the
  CREDITS screen). `--write` regenerates; `--selftest` proves the rejections.
- `npm run assetbuild`: `assets-src/**.glb` → `public/assets/**.glb` with
  dedup/weld, LODs (`lod0/1/2` roots, meshoptimizer), textures ≤2048 → KTX2
  (UASTC+zstd for data maps, ETC1S colour), meshopt geometry. Tested on Khronos
  DamagedHelmet (not committed): 15 452 → 5 407 → 3 289 tris, 18/18 textures
  load as GPU-compressed, LOD switches at 0/30/80 m in the browser.
- Client: `assetLoaders.ts` (meshopt + KTX2 decoders; Basis transcoder copied to
  `public/libs/basis/` by `scripts/vendor.mjs` on predev/prebuild, gitignored);
  `GltfPartLibrary` builds a `THREE.LOD` from `lodN` roots.
- `assetcheck --tier hero`: lod0 budget (chassis 60k, engine 8k, wheel 6k, seat
  4k) plus `HERO_RULES` (≥2 LODs, lod1 ≤50%, last ≤25%, meshopt, KTX2). Fixed:
  quantised (normalized) positions were measured in integer units (62 km helmet).

**2026-10-06 — Phase 4: hero vehicle (solo class = armoured truck).**
- Model: "[Free] Armored Police Vehicle" by Roam_Man (CC BY 4.0) + the roof
  turret from "Oshkosh M-ATV" by 42manako (CC BY 4.0), both via the Sketchfab API
  (`SKETCHFAB_TOKEN` in the gitignored `.env`). Originals in
  `assets-src/vehicles/*/original/`; `scripts/prep/armored.ts` → parts →
  `npm run assetbuild` → `public/assets/vehicles/armored/` → manifest.
- `VEHICLE_CLASSES.solo` resized to the model at 80% (track 1.70, wheelbase 3.14,
  wheel r 0.476, ride height 1.28 — SUV-like handling); solo seat has a
  `turret` position and the muzzle as `firePort`; solo camera 8.2 m back / 3.3 m up.
- Rig: new `turret` part (procedural fallback gun), right wheels mirrored,
  solo engine lowered under the bonnet. Loader: per-file cache, `<class>/<kind>`
  fallback key, `paint` / `baseTint` manifest options.
- Pipeline fixes found on the way: `join()`'s clean-up and `prune()` deleted
  socket nodes (now keep sockets, drop FBX shells); source textures needed a
  vertical flip (FBX vs glTF convention; 99.9% island overlap flipped) — the
  unflipped maps put texture gutters on the paint as bright patches.
- Result: chassis 34k → 12.7k → 8.0k tris (13 primitives, was 82 meshes),
  12/12 KTX2 textures, whole scene 74 draw calls (procedural SUV scene: 141).
- Headless note: SwiftShader runs ~6 fps, so the client produces ~30 input
  ticks/s vs the server's 60 and can trip the 500 ms input timeout; probes must
  run small (640×360). Real hardware is unaffected, but <12 fps machines would
  feel it — revisit in Phase 9.

**2026-10-07 — weapons & aiming rework, title showcase.**
- Solo truck: twin M2s on the front fenders (LMB, `mg`: 16/s alternating
  barrels, ±20° traverse, converge on the crosshair) + roof station with an
  RPG-7 (RMB, `rocket`: projectile, 8 m splash, 3.2 s reload, ±135°). Models:
  "M2 .50cal" (britdawgmasterfunk) and "RPG 7" (javadbayat), CC BY 4.0, prepped in
  `scripts/prep/armored.ts` (`gun.glb`, `turret.glb`).
- `SeatDef.mounted` is now `MountedWeapon[]` (trigger, mounts {pivot, muzzle},
  yaw/pitch arcs, part). Ammo is per slot (`AmmoState.reload[]`), fire messages
  carry `slot` + the crosshair's world `target`. `aimMountedWeapon` and
  `scheduleShot` (shared) are the single rule for server firing and client
  prediction; `npm run weapontest` covers them (18 checks).
- Bugs fixed: (1) the client sent a shot and drew a tracer EVERY FRAME while the
  trigger was held (120/s at 120 fps vs 9 accepted) — now rate-limited locally to
  the server's schedule; (2) shots fired along the camera angles from a muzzle
  metres away (parallax) — now muzzle→crosshair point; (3) projectiles were never
  drawn on the client and rocket impacts made no explosion.
- Feel: `weaponFx.ts` (muzzle flash + light, sparks on cars / dust on misses,
  rocket body + flame + smoke trail), per-weapon audio (.50 crack+thump, RPG
  whoosh), recoil shake, per-weapon reticles (split from the crosshair past a
  gun's limit), dual ammo read-out, kill confirmation, damped solo camera.
- Server fire rate is a jitter-tolerant schedule (`FIRE_JITTER` 0.5): on-time
  shots bunched by the network are no longer rejected; average rate still capped.
- Title screen: orbiting showcase of the player's truck (drag to spin, idle
  rotation, key + rim light, garage paint live).
- Proposed next (user): a 2-door armoured car for solo, the truck for team modes.

**2026-10-07 — solo car is a 2-seater; weapon audio and hit feedback.**
- Solo class = "Brawler": "Armored car (death race)" by jaack (CC BY 4.0), real
  scale (4.9 m, track 1.51, wheelbase 2.74, ride 0.78). `scripts/prep/brawler.ts`
  cuts its modelled hood guns out by geometry island, uses the rear wheel (the
  front meshes carry suspension), and the 4096 px maps (flipped). Twin M2s on the
  front fenders (gun part at 0.85), RPG station on the roof (turret part at 0.62);
  `weapontest` checks the manifest scales match `SOLO_GUN_SCALE`/`SOLO_TURRET_SCALE`.
  The armoured truck and its prep stay for team modes (not mapped in the manifest).
- Shared prep helpers moved to `scripts/prep/lib.ts`.
- Audio: recorded samples in `public/audio/sfx/` (Q009 CC BY-SA 3.0; rubberduck
  CC0; Brian MacIntosh CC0) layered with the synth voices, a compressor on the
  SFX bus and a generated outdoor echo send. Hits we land: metallic clink+thud
  (`hitConfirm`, big clang for rockets). Hits we take: hull clang + thud, red edge
  flash scaled by damage (`Hud.flashHit`), hull-bar flash, bigger direction arrow.
- Title showcase settles the car to the ground in fixed ticks (no hover at low fps).
- Pacing (solobench, 12 bots, 2 matches): mean 170 s (was ~90 s), first kill
  49 s, accuracy 18%. Bots still brawl at point-blank range — tune with bot work.
- Headless note: with the car + guns the VM's software WebGL runs out of memory
  at 1280×720 (KTX2 is expanded to RGBA without GPU compression); probe at 800×450.


**2026-10-07 — Phase 5 (arena) + Phase 6 (floodlit lighting).** The map is now a
televised stadium at night. *Surfaces:* every arena role is a CC0 Poly Haven PBR
set (`client/arenaSurfaces.ts`), world-space box-projected UVs, built as
`materialOnly` KTX2 GLBs; nested ground layers use a ranked polygonOffset (no
z-fighting); dirt/sand/mud are `matte` (they glittered like wet glass under the
key light). *Stadium:* a 4.5 m barrier at `STADIUM_HALF` 235 is real collision
(shared `arena.ts`; far features outside it removed, simcheck updated); stands,
crowd, LED sponsor boards (fictional brands only) and 8 floodlight masts are
visual-only (`client/buildStadium.ts`). *Cover:* every `PALETTE.block` box is
drawn as a container stack that fills its collision box exactly
(`client/buildContainers.ts`, one mesh, painted corrugated_iron; procedural on
purpose — ~200 model containers would be 3M tris). *Lighting*
(`client/lighting.ts`, `LIGHTING` in config): Satara Night HDRI as environment
(CC0, `fetch-polyhaven.ts --hdri`), one shadow-casting floodlight key + three
fills, bloom; QUALITY LOW/MEDIUM/HIGH on the title screen (saved). **Gotcha:** an
Inf/NaN pixel in the half-float target becomes a metres-wide white disc after
bloom — a sanitise/clamp pass runs before bloom; keep it. Not done: checkpoint
props (barriers, sandbags, drums) — optional dressing; real per-mast spot
lights. `npm run check` 383/383.

**2026-10-07 — escalating damage, per-map lighting presets.** *Damage*
(`client/damageFx.ts`, `DAMAGE_FX` in config): stages by damage = 1 − hull
fraction (a shot-out engine counts too) — scuffed 25% (pale wisps), smoking 50%
(grey plume), critical 75% (black smoke, engine-bay flames, sparks), burning 90%
(front+rear fire, embers, flickering firelight), and a wreck that burns ~9 s where
a car died. World-space particles in three shared instanced pools (smoke trails
behind a moving car); 2 fixed firelight PointLights go to the fires nearest the
camera (never add/remove lights at runtime — it recompiles every material). The
body scorches toward soot (`buildVehicle` takes private material copies on first
damage). The old per-car box smoke is gone. **Gotcha:** particle colours are
LINEAR — 0.2 already reads light grey through sRGB output; black smoke is ~0.01.
*Lighting:* `LIGHTING_PRESETS` + `MAP_LIGHTING` — a preset is a map's sky, HDRI,
lights and bloom; `floodlitNight` is now properly dark. A new map's time of day
is a new preset entry. *Test infra:* `matchtest` leaked its servers (killing
`npx` leaves the node child), so the next run hit EADDRINUSE on 8399 — servers
are now spawned `detached` and stopped by process group. `npm run check` 383/383.

**2026-10-07 — frame rate: 120 → ~35 after the lighting pass; fixed.** The bloom
chain (half-float MSAA target + sanitise + bloom mips + output, at retina DPR) was
~4× the frame cost (headless A/B: no-post 10.7 fps vs bloom 1.2), and three fill
lights added more. Now: LOW/MEDIUM draw straight to the canvas with native MSAA
and no post; lamp glow is additive halo sprites (`buildStadium`); one fill light,
one firelight. HIGH (bloom, no MSAA at 2×) is opt-in and auto-steps to MEDIUM if
a live match sits under 50 fps for 4 s. Default is MEDIUM. **Gotcha:** any Sprite
in the arena group needs `raycast = () => {}` — aim/camera rays hit the arena and
a Sprite throws without `raycaster.camera`, every frame. **Gotcha (probes):**
headless fps is meaningless while the dev server + bots share the VM — only
compare configs within one run, and prefer the user's real GPU.

**2026-10-07 — unstable 60–120 fps: draw calls 708 → 285 a frame.** New F3 panel
(`client/perf.ts`): CPU per loop section, GPU via timer query where exposed,
shader compiles, heap drops, the last slow frames; click copies a report. Found:
(1) the solo car's glass had KHR transmission 0.66 — while ANY transmissive
material is on screen three.js re-renders every opaque object for it, i.e.
always; `gltfPartLibrary` now converts transmission to plain alpha. (2) every car
mesh (39 a car) cast shadows: now only each part's big meshes (≥15% of a LOD
level's triangles), none from occupants, none beyond 60 m (`setShadowDetail`).
(3) the solo car's hidden engine (6 meshes) is no longer drawn. **Rule:** never
ship a transmissive material; check `renderer.info.render.calls` after adding any
model.

**2026-10-07 — car contrast at night: real paint + car lights.** Livery used to
MULTIPLY the texture (can only darken → every livery came out arena-brown on the
dark brawler texture). Now `applyPaint` (gltfPartLibrary) is a shader paint layer:
livery colour shaded by the texture's luminance, after `map_fragment`, one shared
program (`customProgramCacheKey`), colour/strength as per-material uniforms;
manifest `paintStrength` 0.85 chassis / 0.6 turret. **Gotcha:** `Material.clone()`
drops `onBeforeCompile` — use `copyPaint` (the scorch clones do). *Lights*
(`client/carLights.ts`): head/tail glows for every car as one Points draw call
(sized in metres), tail brighter when braking (local car), anchors from the chassis
bounds; one SpotLight beam for the local car, created once. Also fixed: the solo
driver drew the window-gunner figure (a box out of the left flank) — window
occupants are now only for non-driving armed seats (`headWorld` agrees: drivers
are hit at the eye, inside).

**2026-10-07 — Phase 7: bots fight like nose-gun cars; weapons rebalanced.**
Measured with `solobench` (12 cars, 3 matches each; `BENCH_STATS=1` now makes the
server tally damage and finishing blows per source, and the bench prints them —
the observer's shot counts are interest-culled samples, not totals).
| | before | after |
|---|---|---|
| match length | 144 s | 136 s |
| first kill | 44 s | 18 s |
| median hit range | **1 m** | 10 m |
| damage MG / rockets / ram / zone | — (MG 9% when first measured) | 33 / 36 / 22 / 9 % |
Causes and fixes: (1) bots ORBITED at a 0.5 rad lead, keeping targets outside the
MGs' ±20° → **attack runs** (`BOT.breakRange/reengageRange/extendSeconds/
attackSpeed`): nose on the target, slow to 0.6× in MG range, break away at
18 m × standoff, come round; passes shrink with the zone and break toward its
centre. (2) firing used the seat's ±135° arc → each weapon fires only inside
ITS arc and range (`mgFireRange`, `rocketMin/MaxRange`); bots fire at world
points like a crosshair (`intent.target`), rockets lead by flight time
(`lead` skill), on their own rhythm (`rocketGap`), replacing the 3%-per-tick
random RPG. (3) **burst was counted in decision ticks** (60/s) against a
16 rounds/s gun → bursts are seconds (`burstSeconds`). (4) **solo occupant
damage**: rocket splash killed drivers inside intact cars, leaving driverless
cars counted alive until the zone finished them — solo now has no separate
occupant damage (the hull is the life). (5) aim error raised (hard 0.024, normal
0.045, easy 0.09) — 69% accuracy was an execution. Weapons: MG 9 → 11 dmg, RPG
240 → 200. Also: bottest/solobench/netheadless spawn servers `detached` and kill
the process group (solobench hung after finishing). `npm run check` 389/389.

**2026-10-07 — HIGH quality stutter on a 136 Hz retina Mac: GPU-bound.** User's
F3 report: cpu 4.9 ms, **gpu 22 ms avg / 37 max** vs a 7.4 ms budget at 3024×1668
(2×). HIGH is now 1.5× (56% of the pixels) with bloom at half resolution
(`HalfResBloomPass` — the composer re-sizes passes to full size on resize, so it
halves in `setSize`). Auto-step-down compares against 75% of the DISPLAY's
refresh (smoothed), not a fixed 50 fps that never fired at 120+ Hz. The F3 panel
counted only the last render pass ("1 calls"): `info.autoReset = false` + reset
per frame. **Confirmed by the user (2026-10-08): HIGH holds 120 fps on the 136 Hz
retina Mac.**

**2026-10-07 — Phase 8: feel of speed.** All client-side, tunable in `FEEL`.
*Camera* (`updateSolo`): FOV +10° at top speed and +7° more while boosting;
acceleration pulls the camera back / braking lets it close (±1.1 m); positional
shake ∝ speed², ×1.8 off-road, ×1.6 boosting (position only — it still looks at
the exact aim point); a landing dip. *Effects* (`client/driveFx.ts`, 3 pools for
all cars): dust behind the rear wheels on dirt (ground from the highest arena
ground piece; matte = dirt), tyre smoke on hard ground when slip > 4 m/s, sparks
on hard impacts (`state.impact`), blue-white boost flame from the pipes (remote
cars: boosting = over 1.03× top speed). *Sound* (`audio.updateEngine`): the
engine runs through gears (`FEEL.sound.gears`) — revs climb in a gear and drop
at the shift; load (throttle/boost) opens the filter and an intake roar; tyre
squeal (hard ground, sliding), gravel crunch (dirt), wind ∝ speed², a whoosh on
boost. **Bug found on the way:** the particle ShaderMaterials wrote LINEAR
colours raw — right on HIGH (OutputPass converts) but far too dark on LOW/MEDIUM,
where dust was invisible and damage smoke/fire differed from what was tuned.
`ParticlePool` and `CarLights` now include `tonemapping_fragment` +
`colorspace_fragment`. **Rule:** every ShaderMaterial that outputs colour needs
those two chunks. **Flake:** combattest §6 (magazine/reload) runs on a real-time clock and
failed once with the VM at load ~2.9 (dev server + probes); passes alone and on
rerun. `npm run check` 389/389.

**2026-10-08 — arena dressing: checkpoints and floodlight beams.** *Checkpoints*
(shared `arena.ts`, authored once in WEDGE so all four spokes get one): two
staggered lines of concrete road barriers make a chicane across each spoke road
at 88–98 m, plus a nest of barrels, tyres and crates beside it. They are REAL
collision boxes tagged `prop: 'barriers' | 'nest'`; `buildArena` skips them and
`client/buildProps.ts` fills each box with instanced Poly Haven CC0 models
(barrier, Barrel_01, old_tyre lying flat, wooden_crate_01 ×1.7) — one draw call
per model part; plain boxes if a model fails, so collision is never invisible.
`fetch-polyhaven.ts --model` fetches props (1K glTF → assets-src/props) and
`assetbuild` has a new `baseRatio` (simplify the whole model first: the barrier
was 61k tris → 2.2k at lod0). *Beams* (`buildStadium` `beams()`): fake volumetric
cones from each lamp bank, additive, fading along the cone and at its
silhouette; merged, one draw call, no lights. simcheck/bottest pass; solobench:
matches end normally (~106 s), no stuck bots. **Bench note:** the last match's
`[bench] damage` line can land after the bench reads the log — expect N−1
tallies. `npm run check` 389/389.

**2026-10-09 — front end: stand-by card, cinematic title, Esc menu, callsigns,
rejoin, touch notice.** User choices: cinematic hero title; broadcast "stand by"
card for the load; rejoin window with a bot driving; local callsigns.
*Stand-by* (`#standby`): covers the first load with real progress (labelled
by kind: vehicles / arena surfaces / set dressing / night sky), fades out after
two drawn frames — nothing pops in. *Title* (`#join`): menu down the left
(PLAY, GARAGE, SETTINGS, CREDITS), panels beside it, 50° lens and a slow
low orbit with the car right of centre (`SHOWROOM_FOV`, `showroom.clock`).
SETTINGS (callsign, sound, quality) is ONE panel that moves between the title
and the Esc menu. *Esc menu* (`#pause`): shows when a live match had the mouse
and lost it (the browser's own Esc releases pointer lock); RESUME re-locks;
CONTROLS lists keys; LEAVE MATCH asks twice, sends `leave` (forfeit) and
reconnects to the title. The car coasts — the match never pauses.
*Callsigns* (`shared/callsign.ts`): one sanitiser for client and server; random
default saved in localStorage; bots get stable generated names; the server
broadcasts a `roster` (crew → name) used by the kill feed, results and spectate
banner. *Rejoin*: hello carries a per-browser `token` (localStorage
`convoy.session`); a human leaving a LIVE SOLO match keeps their car, bot-driven
(`removeClient` turns the record into a bot with `awayUntil`); the title asks
`held?` on connect and every 3 s while held (the car can die), PLAY becomes
REJOIN MATCH with the server's countdown; `resume()` hands the car to the new
connection with `welcome.resumed` and the car's live position.
`REJOIN_SECONDS` env (default 30). Verified end to end by browser probe; **no
automated test yet** — add one to matchtest. *Touch-only devices*: PLAY is
replaced by a "needs a keyboard and mouse" note (pointer: coarse and no fine
pointer). *Fixes:* the canvas sat 38 px down the page (now `position: fixed`);
the F3 overlay was remembered forever in localStorage — now per tab
(sessionStorage); an id clash (`controls`) hid the Esc menu's panel.
Callsign unit checks in cosmeticstest. `npm run check` 389/389 (+8 callsign).

**In-world broadcaster: "YovNok TV"** (the user's name, exact casing; 2026-10-09).
Replaced the placeholder "HAVOC TV" on the stand-by card, the title kicker and
the first LED sponsor board. The other sponsors stay fictional placeholders.

**Garage trimmed to what works (2026-10-09).** WHEELS and ROOF removed from the
garage: wheel styles were spoke counts on the old procedural wheel (the glTF
wheel is one model, rim and tyre on one texture) and roof kits need a `roofRack`
socket the realistic chassis lacks (its roof carries the RPG). The look format
keeps the fields, pinned to 0 (`paintOnly` in main.ts). PAINT FINISHES now apply
to the glTF car (`applyFinish`: roughness scaled from the texture's map,
metalness, clearcoat, sheen) — Matte Black and Chrome were only colours before.
Locked paints show their requirement and progress on the chip, not only in a
tooltip. `npm run check` 397/397.

**Gamepad support + GitHub link (2026-10-09).** `Input.poll(dt, aiming)` once a
frame (W3C standard mapping): left stick steer, RT/LT analogue throttle/brake,
right stick aim (deadzone 0.14, curve, 2.6/1.6 rad/s), RB guns, LB RPG, X
handbrake, B/L3 boost, Y reload, Start = the in-game menu (`padMenu` in
main.ts — a pad player never holds pointer lock), D-pad + A/B navigate menus
(`padNavigate`, real DOM focus, styled like hover). No CLICK TO DRIVE prompt
while a pad is active; `gamepadconnected` shows a controls tip and re-enables
PLAY on touch-only devices. Controls panel lists both. Verified with a FAKE
gamepad in the browser (navigator.getGamepads override): A starts a match, stick
aims, Start/D-pad/A/B drive the menu, trigger reaches the drive step. **Probe
note:** headless frames > 0.25 s skip the fixed-step loop entirely (by design),
so held inputs barely move a car headless — hold scripted buttons until the
poll has SEEN them (`inputs.pad.previous[i]`). GitHub: https://github.com/Kpoke/convoy
— title bottom-left caption (mirrors the drag hint), Credits note, package.json
`repository`/`homepage`. `npm run check` 397/397.
---

## 1. Where we are

| Milestone | Scope | State |
|---|---|---|
| M0 | Scaffold, deterministic sim, tunable config | ✅ done |
| M1 | Driving feel | ✅ done |
| M2 | Authoritative server, prediction + reconciliation | ✅ done |
| M3 | Art foundation: part graph + symmetric arena | ✅ done |
| M4 | Crews: seats, per-seat cameras, window arcs | ✅ done |
| M5 | Guns: hitscan + projectiles, reticle aiming, reloads, lag comp | ✅ done |
| M6 | Damage: component health, driver protection, hazards, repair crates, degradation | ✅ done |
| M7 | Match modes: duel 2v2/4v4 respawn TDM + one-man-team last-car-standing | ✅ done |
| M8 | Bots: lobby fill + a drive-and-shoot AI | ✅ done |
| M9 | Polish: audio, HUD/juice, art fidelity (tutorial → M14) | ✅ done |
| M10 | BR groundwork: spatial partitioning + interest management | ✅ done |
| M11 | BR mode: 800 m zoned map, 30-car field, salvage, scoring | ✅ done |
| **M12** | **Cosmetics: part-swap paint/wheels/roof kits, earnable unlocks, garage** | ✅ done |

## 2. Run it and check it

```bash
npm run dev            # server :8787 + vite :5173, one command
npm run check          # typecheck + every headless test + build — run this after changes
```

**`typecheck` now covers `scripts/` as well as `src/`.** It did not until late in
M6, which is how a genuine syntax error sat in `simcheck.ts` while every
typecheck reported clean. Adding the scripts to `tsconfig.include` immediately
found four real problems, including `netheadless` sending its hello **twice**.
Do not narrow it again.

| Command | What it proves | Expected |
|---|---|---|
| `npm run simcheck` | Shared simulation: handling, determinism, arena, components, hazards, crates, collisions, rams, zone, grid, authored map | **119 pass** |
| `npm run combattest` | Firing rules, hit attribution, crew hits, reticle aiming | **52 pass** |
| `npm run matchtest` | Match rules + real room lifecycle, duel and solo (lobby→…→rematch, zone, salvage, interest, cosmetics) | **101 pass** |
| `npm run bottest` | Bot brain, navigation, depth, target selection + a real `BOTS=fill` match | **35 pass** |
| `npm run cosmeticstest` | Cosmetic catalogue, unlock rules, profile maths + the look-only guarantee | **33 pass** |
| `npm run solobench` | Not a test: runs real solo matches and prints pacing/lethality | prints tables |
| `npm run netheadless` | Prediction fidelity, no browser | worst correction < 0.07 m |
| `npm run nettest` | End-to-end two-client netcode, real browsers | 8 sections pass |
| `npm run assetcheck -- --selftest` | Asset contract validator | passes |
| `npm run scalebench` | Scale ceilings (bandwidth, sim cost, hit detection) | prints tables |
| `node scripts/meshprobe.mjs` | Draw calls and triangles for 1/8/30 cars | prints tables |

Diagnostics that answer "is it actually doing the thing?" rather than "does it
crash" — each one exists because a screenshot could not tell me:

| Script | Answers |
|---|---|
| `scripts/reticleprobe.mjs` | What is under the crosshair, and where is the camera |
| `scripts/seatprobe.mjs` | Are occupant meshes positioned and toggled correctly |
| `scripts/meshprobe.mjs` | Draw calls / triangles / shadow pass, per car count |
| `scripts/damageprobe.mjs` | Does damage actually render (smoke) |
| `scripts/headprobe.ts` | Can a crew member be hit, seat by seat |
| `scripts/scalebench.ts` | Bytes per snapshot, ms per tick, ms per shot |

**Run the one-man-team mode with `MODE=solo npm run dev`.** Sixteen brawlers by
default; `SOLO_CARS=n` changes the field, `SOLO_MIN_PLAYERS=n` the floor.
Duel is `MODE=duel` (the default). The mode is chosen once per room and decides
the team count, the vehicle class and the rules.

**Bots fill a solo lobby by default.** `BOTS=off` disables them, `BOTS=fill` (the
solo default) fills the field, `BOTS=n` fills to n cars. Tests that count cars or
placements exactly set `BOTS=off` (see `matchtest`).

**Dev-only seat assignment.** `DEV_ASSIGN=1 npm run dev` makes `?crew=0&seat=seat.driver`
work. Without it the server assigns the emptiest seat and silently ignores the
request. If a URL seat request appears to be ignored, this is why.

**Do not run two browser probes in parallel** against one dev server. They contend
for the same seat, the loser gets bumped to a gunner, and a gunner cannot drive —
which presents as "the car will not move" and costs an hour.

## 3. M7 progress

### Done

- **The match state machine** (`src/shared/match.ts`). Phases
  `lobby → countdown → live → results`, per-team score, a kill target, a
  regulation clock, sudden death on a tie, and rematch reset. Pure: every
  function takes the server clock as an argument, so the awkward cases are unit
  tested rather than timed.
- **Scoring on a real kill.** `destroyVehicle` is now the single place a crew
  dies, and it credits the killer's team — from a hitscan, a projectile, or its
  splash. Idempotent, because a rocket's direct hit and its splash can both reach
  zero on one tick and only one may score.
- **Delayed crew respawn.** A destroyed crew is `dead` for
  `MATCH.vehicleRespawnSeconds`, not simulated and not drawn, then returns
  **together** at its team spawn in a fresh car. The whole crew is out for that
  moment; that is what gives a kill weight without ending anyone's match.
- **Team spawns** (`spawnForTeam`). Opposing crews now start on opposite sides
  of the ring; the old `SPAWNS[crew]` put them 45° apart.
- **The room is the lobby** — no matchmaking, because a duel is exactly two
  crews. Both teams present opens the countdown; a team emptying out mid-countdown
  drops back to the lobby rather than starting a one-sided game.
- **Phases gate play.** Driving and shooting are accepted only while `live`;
  before and after, cars are frozen and shots are ignored. Rematch votes are
  cleared on every transition out of results, so a stale vote cannot skip a lobby.
- **HUD.** Scoreboard (team scores, highlighted own side), match clock, sudden
  death indicator, countdown, a `DESTROYED … respawning in n` banner, and a
  results screen with outcome, reason, score, vote progress and a **REMATCH**
  button.
- **Two clocks, on purpose.** Interpolation uses `Date.now()`; the match clock
  uses `performance.now()`, because a system clock change must not skip a match.
  Only remaining milliseconds cross the wire.

### One-man-team mode (`MODE=solo`, DESIGN.md §2.3)

Added after the duels, as a re-scope: **one player per car, the car is the
weapon, one life, last car standing.** It is built *on* the duel systems, not
beside them.

- **Seats are capability, not role.** `SeatDef.drives: boolean` plus an `arc` for
  "can fire", replacing `role: 'driver' | 'gunner'`. A duel driver drives without
  an arc; a duel gunner has an arc and no wheel; the brawler's one seat sets
  both. `seatCapability()` derives the label. `headWorld` and the driver-protection
  check in `resolveHitscan` key off `drives`, so the brawler dies with the car.
- **Car-mounted weapons.** A seat may declare `mounted: WeaponId[]` and a
  centre-line `firePort`; when it does, those ARE the seat's weapons and the
  personal loadout is ignored. The client derives the same loadout from shared
  seat data, so nothing is sent. The brawler carries rifle + launcher.
- **A new vehicle class, `solo` ("Brawler")**, with a turret arc (±135°, a real
  blind spot behind) rather than a window's. The spawn ring is generated
  (`spawnRing`), so the field can be any size.
- **N one-man teams.** `TEAM_COUNT` became a room field; `assignSeats` fills the
  first empty team and returns null when the field is full, which the server
  answers with a `reject` message. `spawnForTeam(team, teamCount)` spreads N cars
  around the ring.
- **Last-standing.** `registerElimination` in `shared/match.ts` ends the match at
  one survivor (or a draw at none). No respawn timer in solo: eliminated is
  eliminated until the next match. Placement is recorded as the number of cars
  alive when the car died.
- **The elimination check runs every tick**, not only on a kill, so a disconnect
  that removes a car also ends a match left with one survivor.
- **Solo camera** (`updateSolo`): a forward third-person view aligned to the gun,
  so the car is in the lower frame and the crosshair is the world — the chase
  camera's centre is the car, the window camera hides it. Rigid, not damped.
- **HUD** reads `ALIVE n` and `KILLS k` instead of team scores, and an eliminated
  player sees `ELIMINATED · placed #n · spectating`.

### Bots (M8, DESIGN.md §13.9)

- **A bot is a player with `socket: null`.** The same `Player` record, flagged
  `bot`, occupies a seat, is simulated, appears in snapshots, can be hit, and
  fires through the SAME `handleFire` a human uses. There is no privileged bot
  API, so no weapon rule can be bypassed by one. This was the whole design: the
  alternative — a parallel "bot entity" — duplicates every rule and drifts.
- **Lobby fill** (`BOTS=fill`, the solo default). Bots fill empty teams; a human
  joining takes a bot's seat; bots are never added or removed while `live`
  (§12.4); the rematch quorum counts humans only; and a room with no humans does
  not start a match at all.
- **The brain** (`src/server/bot.ts`) is pure and server-only: nearest enemy,
  drive to a range band, aim with the shared muzzle geometry, fire on a clear
  line, steer around walls with a forward probe plus a left/right comparison.
  Server-only because nothing on the client predicts a bot.
- **`bottest`** (18 checks) proves the steering SIGN on a flat arena — positive
  steer turns right while increasing yaw turns left, so the command is the
  negated error — plus arc/LOS/wall/zone handling, then a real `BOTS=fill` match
  with one human: bots occupy seats, drive, and shoot.
- **Bots are zone-aware.** Past 70% of the safe radius they bend inward, and once
  outside they commit to driving back in (no handbrake, boost when straight)
  while still able to fire. A bot that ignores the zone is a free kill, not an
  opponent. Measured with a compressed zone: **15/16 eliminated in ~49 s**, 55%
  accuracy, ~32 m median range — matches now *end* on the zone, not the cap.
- **Bots navigate.** Four fixes, each measured: width-aware clearance (3 rays per
  heading, so a flank stops clipping corners); a **speed budget** from the clear
  distance (brake before a corner, not on arrival); **smoothed steering** (a wheel
  turned, not slammed); and **committed detours** (hold the detour heading 0.5 s —
  without it the bot turned away, re-saw the target, turned back and ground the
  corner) plus **reverse-out** after 0.7 s of trying to move while stalled.
  Result on the real arena: **407 m across the map at 140 km/h, 0 stalled ticks of
  900, arriving 11 m from a far target**, and a bot nosed into a block goes around
  it and reaches the target behind. `bottest` asserts all of it, so "bots get
  stuck" now fails a test.

### Entry and connection (same pass)

- **Joining is explicit.** The page opens a `JOIN LOBBY` menu; `NetClient.connect`
  only opens the socket, and `join()` is what sends `hello`. Loading the page can
  never drop you into a live match.
- **Liveness is socket-level.** The server sends a WebSocket `ping` every
  `NET.heartbeatMs`; the browser pongs in its network stack, which keeps running
  when a tab is throttled or frozen. `lastSeenAt` is refreshed by pongs as well as
  app messages, so switching tabs no longer gets you reaped (§6). `HEARTBEAT_MS`
  is env-overridable so the reaper is testable in seconds.
- **Field doubled to sixteen**, which needed `spawnRing(count)` — a generated
  ring, because a fixed eight stacks sixteen cars two deep. `spawnRing(8)` is
  exactly the old authored ring, so duels are unchanged.
- **CREW and SEAT are off the status board** until teams and co-op return. The
  debug handle still exposes both, and `nettest` reads them from there now.

### The closing danger zone (DESIGN.md §2.2, §10.3)

The mechanic that makes "no clock" safe: a shrinking safe circle that damages —
and can destroy — anything outside it, so the last survivors are forced together.

- **Pure and seeded** (`shared/zone.ts`). The schedule takes a `rand` function
  rather than calling `Math.random`, so tests pin a plan with a seed. The server
  builds the plan once at the whistle; the client only draws the radius it reads
  from the snapshot.
- **The endgame is not scripted.** Each circle shrinks to `start − end` and is
  offset to a random centre that is nested INSIDE the previous circle (offset
  bounded by `prevRadius − newRadius`), so the shrink can never strand a player
  who was safely inside. Two seeds end two different places — there is a test for
  it, because a fixed centred shrink is a script players memorise.
- **Hold → shrink, five times**: 150 m → 18 m over ~3m45s, damage climbing from
  35 to 185 hull/s. Unlike a hazard, no floor: a zone kill is a kill (crediting
  no one).
- **Solo only.** Duels keep their clock.
- Client: a ground ring, an `OUTSIDE ZONE` readout and a red vignette. Verified
  live — the radius sampled `120 → 70 → 20` with the readout and vignette on.

### Reading the fight: spectating, feed, results

One life means the endgame is watched, so elimination is a spectator mode:

- **Spectating.** On elimination in a live match, the local wreck is hidden and the
  camera follows a surviving car, cycling every 6 s, with free look. The banner
  reads `SPECTATING · car n · you placed #k`. Verified with a browser probe (the
  camera landed on a survivor, banner correct, feed filled).
- **Kill feed.** `destroyVehicle` pushes a `KillEvent { byCrew, victimCrew }`
  (flushed with the snapshot like shots). A zone kill carries `byCrew: null` and
  reads `ZONE eliminated car n`. Two `matchtest` checks cover both a scored kill
  and a credited-to-nobody zone kill.
- **Results** name the winner (`winner car n`) and your placing.
- **Death explosion** (`client/explosions.ts`): flash, fire, rising smoke and a
  ground shock ring at the wreck's last position, with a brief point light. Fires
  once on each alive→dead edge, for the local car and every remote. Cosmetic and
  client-side — the server decides the death.
  **Instanced (M9).** The first version was one `THREE.Sprite` per particle, with
  a material each (sprites carry opacity on the material), and measured **+47
  draw calls per explosion**. Fire and smoke are now two instanced meshes with a
  small billboard shader (expand the quad in view space), so the whole particle
  field — any number of particles, any number of simultaneous bursts — is **+2
  draw calls**. Measured: idle 901 → 903 with one explosion and still 903 with
  six.
- **Difficulty** is `BOT_SKILL=easy|normal|hard`, **defaulting to `hard`** for now
  (bots are the only opponents until humans arrive — an easy field is not worth
  playing against). It scales **two** skills because a bot is a driver AND a
  gunner: marksmanship (reaction, wobble, burst pause) and **driving** (steering
  authority and wander, handbrake threshold, range-band discipline, wall-probe
  distance, zone reaction). Nothing else
  changes — not damage, not weapon range, not top speed. `bottest` asserts the
  driving half: a hard bot steers with more authority, an easy one wanders on a
  straight line, and at 80 m an easy bot charges in while a hard one holds its
  band.

### M9 (started): audio and juice

- **Procedural positional audio** (`client/audio.ts`). No assets: oscillators and
  one noise buffer. Listener rides the camera; remote gunfire/explosions go
  through a panner, our own sounds are centred. Engine note follows speed and
  throttle; the zone gets a tremolo nag. Created on the JOIN click because
  browsers block audio before a gesture; `M` mutes. A global rate limit bounds
  voices in a firefight.
- **Camera shake**: a kick per shot, a thud scaled by damage when *we* are hit,
  and a shove from a nearby explosion that falls off with distance. Decays at
  3.5/s; never triggers on a long-range kill.
- **HUD feedback**: **damage numbers** where your hits land (the impact point
  projected to screen space, bounded to 24 at once), a **damage-direction arrow**
  that points at whoever hit you (angle from the shot event's origin, relative to
  the camera yaw), and a **red edge vignette** that builds as hull runs low. Plus
  the join menu states the mode ("last car standing · the ring closes in").
- **Onboarding**: first-match **tips** once per tab (sessionStorage) — controls on
  the first live tick, a warning when the ring first closes, and one the first
  time you are outside it. Light onboarding. The full interactive tutorial is
  **deferred to M14** (`DESIGN.md` §16/§18): it teaches mechanics that are still
  moving, so writing it now is rework.
- **Art fidelity (first pass)**:
  - **Image-based lighting.** The sky dome is rendered through a `PMREMGenerator`
    into `scene.environment`, so every PBR material gets a sky-tinted ambient and
    metals have something to reflect. Procedural — no HDR asset. This is what made
    the flat grey lighting go away.
  - **Materials.** Car paint is `MeshPhysicalMaterial` with a **clearcoat** (a
    tight highlight over a duller base); tinted glass is a dark *dielectric* with
    a very glossy surface and high `envMapIntensity` — a reflection, not chrome.
  - **Soft shadows** (`PCFSoftShadowMap`).
  - **Gradient sky dome** (`client/sky.ts`), horizon colour = fog colour so there
    is no seam. The dome radius must fit inside the camera far plane or its far
    side clips into a polygon of flat background — found the hard way, hence the
    comment.
  - **Instanced explosion** (above): +2 draw calls, not +47.
  - *Still first-pass:* lighting balance and the arena/vehicle geometry are
    procedural. Real authored art (or deeper material work) is the remaining gap,
    and it is art, not a system.
- **Music** (`client/music.ts`, `public/audio/music/`): two JSON playlists of
  third-party **CC BY 4.0** tracks by Kevin MacLeod (see `CREDITS.md`). `lobby`
  plays in menus, lobby and results; `match` plays low under a live match and
  rises with the closing zone (`setIntensity`). Replaced the synthwave set when
  the theme became a televised bloodsport in military vehicles. Kept separate from `audio.ts` because the music is
  licensed separately from the game — swapping tracks must not touch synthesis
  code.
- **Sound starts OFF and the menu has a `SOUND` button.** A browser will not play
  audio before a gesture, so the only way to hear the *lobby* music used to be to
  leave the lobby. The button is a gesture that starts the playlist while the menu
  is still up; joining carries it in; `M` mutes music + SFX. A start requested
  before the playlist finished fetching is remembered (`wantStart`) and honoured
  on load — otherwise the one gesture the page got was spent and nothing played.
- Verified in a browser: `AudioContext` `none → running` on the join click, no
  exceptions while driving, firing and exploding; the direction arrow rotates
  correctly and the vignette computes to the expected opacity. Audio itself is
  unhearable in a headless probe — the graph is what is checked.
  *Probe gotcha:* a per-frame `element.style.opacity = …` REPLACES the whole
  declaration and clears any `!important` priority, so a probe cannot pin a value
  against the frame loop with `setProperty(..., 'important')` — it has to stub the
  setter.

### M10: spatial partitioning & interest management

The two things DESIGN.md §13.5 says BR needs, and the reason a room stops asking
"what is near this point?" by scanning everything and stops broadcasting the whole
field to every client.

- **`shared/grid.ts`** — a uniform spatial hash. Plain on purpose: it rebuilds
  each snapshot rather than supporting removal (entities move every tick), and
  cell size is the query radius. Shared, but **not** part of the deterministic
  sim: it is an index over state, never a source of it, so the two sides need not
  agree on it.
- **Interest management** in `broadcastSnapshot`: the room builds the grid once,
  then each client is sent only the crews within `NET.interestRadius` (320 m),
  with `interestMargin` (80 m) of hysteresis so a car on the boundary does not
  flicker. Members, projectiles and shots are filtered the same way. The grid can
  later serve hit broadphase and repairs.
- **`null` means "send everything"** for the two cases where filtering is wrong:
  a duel (two cars) and an **eliminated solo player**, who is spectating and needs
  the survivors, not the circle around their wreck.
- **The member list is a view, not a headcount**, so the snapshot carries
  `match.roster` (everyone) alongside `match.players` (humans, the rematch
  quorum). The HUD reads roster for PLAYERS.
- **Measured** (`scalebench` §5), on a 1 km map with 30 cars: a client goes from
  **664 → 46 kbit/s**, 7% of the full snapshot. On the current 340 m arena most
  cars are inside the radius, which is fine — the mechanism is what scales.
- **Tested**: `simcheck` §25 (grid queries, boundaries, negative cells) and
  `matchtest` §5, where two crews pinned ~450 m apart prove a client is *not* sent
  the other car, while `roster` still reports both.

*Pending:* the **larger zoned map**. That is content, and it pairs with M11's arena
retune rather than a code change, so it is deliberately left there.

### M11 (started): the 800 m zoned map, at 30 cars

- **The map grew 340 m → 800 m** (`ARENA_HALF` 170 → 400), which is the point at
  which M10's interest management starts to matter: at 340 m nearly every car was
  inside the radius anyway.
- **Zones are distance from the centre**, authored in one quadrant and rotated
  four times, so they are symmetric by the same argument the rest of the map is:
  centre (objective), dunes (launch ramps, room to run), scrapyard (dense tall
  cover), lakebed (open, a second hazard), rim.
- **Ground is nested rings**, each a few millimetres higher than the one outside
  it, tinted by `PALETTE.zone*`. The step means the innermost ring wins the
  ground query without z-fighting, and 7 mm is invisible to driving. The rings are
  the only textured meshes; everything else is still merged by colour+kind.
- **Two spawn rings**: solo spawns near the rim (360 m) so 30 cars do not start on
  top of each other; duels stay compact (140 m) on the same map. `spawnForTeam`
  and `spawnRing` take a radius.
- **The field doubled to 30** (`MATCH.soloCars`), and the zone scaled with the map
  (start 380 m, 6 phases, ~5.5 min).
- **Fog, camera far plane and the sky dome all moved out together** (fog 300→820,
  far 600→1400, dome 360→900). They are coupled: a dome past the far plane clips
  into a polygon of flat background, and fog that ends inside the arena hides the
  playfield.
- **Wreck salvage** (DESIGN.md §11): a destroyed car leaves a temporary, contested
  resupply at the wreck — less charge than a crate (6 s) and a 40 s life, **capped
  at 16 piles**, so it rewards winning a fight without littering the map. It is
  the same crate system with an `id`, a `salvage` flag and an expiry; the client
  now **syncs crate meshes by id** (add/update/remove) instead of indexing a fixed
  array, and draws salvage in rust rather than green.
- **Placement scoring**: the results banner reads `placed #k/30 · n kills ·
  winner car m`, and a **board** lists everyone's placing and kills, best first,
  with your row highlighted. It rides in the snapshot as `board` and is
  **deliberately NOT interest-filtered** — a scoreboard that only showed nearby
  cars would be wrong, and a few numbers per car is not entity state.
- **Bot depth: roam, engage, retreat.** (M11, item 2 of §8.) The brain now picks
  what to DRIVE at in priority order: **hurt → repair; enemy inside
  `engageRadius` → engage; otherwise → roam**. Roaming patrols around the safe
  centre on a per-bot bearing; `retreatHull` makes a damaged bot run for the
  nearest crate or salvage pile and **hold still** there (repair needs a
  near-stationary car). It fixes the thing a range tweak could not: bots no longer
  beeline the globally nearest enemy they cannot see.
- **Target selection: finish the wounded** (M12). The brain starts from the
  nearest enemy, then prefers a wounded one (hull ≤ `finishHull` 0.5) within
  `finishBias` (1.6×) of the nearest distance — so it commits to a kill instead
  of switching to whoever is closest, which is how a brawl grinds on with
  everyone on 20% hull and nobody dead. It still never becomes a cross-map chase,
  and a wounded *nearest* enemy stays the target. `bottest` pins all four cases.
  Still open: coordinated focus-fire, which needs shared state between bots.
- **30-car pace, measured.** The two changes together took a 30-car match from
  **70.9 s → 157.2 s** (29/30 eliminated, first kill ~26 s). For comparison,
  widening the standoff alone did nothing (71→77 s). *The metric was the clue:*
  median **hit** range is dominated by close passes, so it is a poor proxy for
  engagement distance — the pace was a target-selection problem, and it needed a
  target-selection fix.
- **A one-tick wipe is a draw.** Found while testing the board: last-standing was
  decided *inside* `destroyVehicle`, so the second-to-last car to die was crowned
  the instant `alive` hit 1 — and a zone that killed the whole field on one tick
  produced a spurious winner. Fixed by deciding it once per tick in `stepMatch`
  (the check already existed); `matchtest` asserts `winner === null` for a wipe.
- **Verified**: `simcheck` passes with spawn clearance on the 30-car solo ring at
  its own radius, symmetry sampled across ±380 m, and the moved hazards and
  crates. In a live match: **roster 30, alive 30, 9 cars visible** (interest
  management culling the rest), **370 draw calls**; bots fight down to 15 crates
  (5 static + 10 salvage) with no client errors. A 30-car match resolves:
  **29/30 eliminated in ~50 s** with a compressed zone (`solobench`).
- **Two test servers needed pinning** (`DEV_PLACE`): on a 360 m spawn ring the
  crews those tests inspect are now 300–500 m apart and get interest-culled. That
  is the feature working, not a bug.

*Done since:* bot depth (roam/engage/retreat) and the pace it fixed (§ above),
plus the placement board. M11 is complete.

### M12 (done): cosmetics, cosmetic-only

- **Three part-swap cosmetic families**, all procedural (there is still no art
  pipeline): **paint** (10 liveries across four finishes — gloss, matte, chrome,
  pearl), **wheels** (spoke count and hub colour) and **roof kits**
  (rack / wing / scoop / light bar), the last pinned to the chassis's own
  `roofRack` socket so the two part libraries cannot drift.
- **Look-only by construction.** The simulation never reads a look, and
  `cosmeticstest` asserts a catalogue entry can only carry appearance fields — so
  a future "livery" with a grip bonus would fail the build rather than start a
  balance argument. There is no power to sell and nothing to balance.
- **One integer on the wire.** A look is three small indices (paint, wheels,
  roof) packed by `packLook` into a single number on `VehicleSnapshot`, relayed
  by the server and never interpreted by it. A crew wears its **driver's** look.
- **Earned, not bought.** Defaults are free; the rest need matches, kills or wins.
  Accounts are M13, so progression lives in `localStorage` (`client/profile.ts`)
  and is deliberately client-authoritative — there is nothing worth cheating for.
- **The garage** is a chip picker in the join menu. Locked entries are still
  shown, disabled, with their requirement and progress, because seeing the thing
  you are working toward is the point of an unlock. Bots get deterministic looks,
  so a 30-car grid is varied.
- **Verified**: `cosmeticstest` **33 pass**; `matchtest` proves the server relays
  a player's look into the snapshot; the build is clean with the garage wired in.

### Map authoring (M12 pass)

The 800 m map was procedural *zones* only — cover at ground level. This adds the
first authored content on that shape, still written in the one quadrant and
rotated four times, so it stays 4-fold symmetric by construction (`simcheck`
asserts 0/23409 height samples differ under a quarter turn):

- **Verticality — a mesa.** A flat 4.2 m plateau with a ramp on two sides. It is
  drivable on purpose: high ground a car can reach is a fight over it, not
  scenery. `simcheck` drives the ramp and asserts the car ends up ON the plateau
  (peak y 5.25 = 4.2 + ride height), not stopped at its foot.
- **Landmarks — a scrapyard crane and a lakebed dam.** The crane (16 m mast and
  jib) is the map's navigable silhouette; the dam is a low wall that cuts
  sightlines across open lakebed without walling it off. `simcheck` asserts the
  crane mast blocks a car.
- **Roads.** Ground strips authored *along the axes*, so one segment replicates
  into a square ring road and four cardinal spokes. They are drivable and
  non-blocking — a route and a sense of place — and `simcheck` asserts a road is
  ground, not a wall.
- **Placement is the fiddly part.** The first mesa overlapped the existing tall
  landmark *and* would have dropped its rotated copy onto the combat test's
  pinned line of fire; the second sits in a verified clear pocket. The map is
  symmetric, so a feature is four features, and every test that pins a position
  (`combatTestPlacement`, spawn rings, crates) is a constraint on all of them.
- **One test assertion corrected rather than papered over.** "Rests near ride
  height" assumed ground at y=0; it now measures `rideHeight + terrainHeightAt`,
  which is the real invariant and no longer assumes a flat world.

### Deployment readiness (M12 groundwork)

**No deploy has happened, and none should until there is budget.** The point of
this pass is that deploying is a *config* step, not a code change.

- **One process = one room, on one origin.** `server.ts` serves the built client
  from `dist/` and the socket at `/ws` on the same HTTP server, so the client's
  `${location.host}/ws` needs no host baked in and there is no CORS. Dev still
  uses Vite + the proxy; production serves `dist` itself.
- **Operational surface:** `GET /healthz` (ok + uptime + players/crews/phase, no
  identity or coordinates), `HOST`/`PORT` env, `ALLOWED_ORIGINS` allowlist for the
  WS upgrade (unset = allow all, right for an open playtest), and a graceful
  SIGTERM that drains.
- **The server is bundled at build time** (`vite.server.config.ts` →
  `dist-server/server.mjs`, `npm run build:server`), so the runtime needs no
  TypeScript toolchain. `npm start` runs the bundle; `npm run start:source` runs
  from source for development. The bundle's only bare import is `ws`, and the
  Docker build **asserts** that, so a newly-added server dependency fails the
  build instead of the container.
- **`Dockerfile` is distroless and non-root** (`gcr.io/distroless/nodejs24-debian12:nonroot`,
  Node 24): no shell, no npm, no tsx. It copies the built client, the server
  bundle and *only* `node_modules/ws`, and health-checks via the node binary.
  `.dockerignore` keeps the context small. Verified **locally only**: the image
  builds, runs non-root, `/healthz` reports healthy, and a real WebSocket join in
  solo mode worked — then the container and image were removed. **Nothing was
  pushed, credentialed or provisioned.**
- **The client dir is cwd-relative** (`CLIENT_DIR` override), not relative to the
  source file, because the server runs from `src/` under tsx in dev and from
  `dist-server/` in production; the relative depth differs.
- **`DEPLOY.md`** is the plan: App Platform vs Droplet + Caddy, the env
  reference, the scaling path (more instances → addressable rooms → many rooms
  per process → matchmaking + managed Redis/Postgres), security posture (no auth
  yet; `DEV_*` must be off), and a first-deploy checklist.
- **Capacity:** one solo room is 30 players at ~46 kbit/s per client, so the
  first scale limit is *concurrency (one room per process)*, not CPU.

### Solo tuning (measured, not guessed)

`npm run solobench` runs real 30-car bot matches and prints the numbers tuning
moves: match length, time to first kill, eliminations, accuracy. The first pass
was a **point-blank execution**: first kill at **8 s**, **81%** accuracy. Three
bot-only knobs fixed it without touching weapon damage (so a *human's* TTK is
unchanged, which matters — the slow-TTK design is deliberate):

- `BOT.reactionSeconds` — a moment on a new target before firing.
- `BOT.burstShots` / `burstPause` — fire in bursts, not a laser.
- `BOT.aimWobble` — tracking wobble from two out-of-phase sines, so sustained
  fire misses like a person's.

| | first kill | accuracy | eliminations / 150 s |
|---|---|---|---|
| before | 8 s | 81% | 10 |
| after | **~33 s** | **~74%** | **10–12** |

Also in this pass: the brawler's arc narrowed from ±160° to **±135°** (270° of
coverage) so an enemy on your tail is genuinely safe until you turn the car — at
±160° the blind spot was too small to make heading matter.

**Caveat: none of this has met a human.** The bench measures bot-vs-bot pacing;
whether it *feels* right is a playtest question, and every knob is in `BOT` and
`crews.ts` for exactly that (`STATE §4`).

### Knowingly deferred

Written down so these are decisions rather than omissions:

- **Lobby seat re-pick** (§3.4). Seats are chosen at join and kept across a
  rematch; there is no in-lobby seat swap UI yet. `DEV_ASSIGN=1` still allows
  `?crew=&seat=` for tests and inspection.
- **Arena layout tuning.** §18 says the competitive layout is tuned at M7. The
  *systems* are here; the layout is still the M3 one, sized for play but not
  balanced against final speed, arcs and pickup numbers. Do that once bots exist
  and matches run unattended (M8).
- **No join-in-progress restrictions.** Duels may accept late humans (§12.4), and
  currently they simply fill a free seat; there is no "match in progress" prompt.
- **M6 debt, unchanged:** hazard damage and repair-over-time are tested at the
  query level only; seat components and crusher hazards are not built.

### Then

The bot is an opponent, not a tactician: it closes, faces you and shoots. It
does not lead a moving target, does not use cover, has one difficulty, and only
exists in solo. Turning it into something that plays a *good* match — and into a
seat-filler for duels — is the next body of work (see §4, §8).

## 4. Open / parked

**Gunner view — parked, needs a design pass with the user.** The camera is
anchored to the gunner's window, each seat sees a different world, the shot is
parallax-corrected to the crosshair, and every one of those properties is locked
down by tests. It still does not feel like "peeking out of a car window, as in
Fortnite". Open questions are recorded in `DESIGN.md` §7; the current offsets
(`WINDOW_EYE_OFFSET`, `HEAD_OFFSET`) are **placeholders, not tuned values**.

**Uncovered forward-left sector.** With the driver on the left, nobody covers
forward-left unless a rear gunner leans into it. That asymmetry is the
driver-coupling mechanic working, but it needs feeling out now that modes exist
(`DESIGN.md` §3.2). Duels are where that asymmetry finally gets exercised.

**Coupe's blind side.** One gunner, one window: the extreme case of the above.
The 2v2 playlist lives here, so it is the first place to feel it.

**Arena layout is still the M3 map.** M7 built the flow around it but did not
retune the layout; §18 wants it balanced against real matches. Parked until bots
make an unattended match possible.

**Solo balance is measured but not playtested.** Sixteen cars, a ±135° arc, rifle
+ launcher on the car, `soloMinPlayers` 2. `solobench` pulled bot lethality back
to ~33 s to first kill at ~74% accuracy (§3), but that is a bot-vs-bot number.
What still needs a human: whether ±135° leaves the car's heading meaningful or
just annoying, whether a ~3–4 minute 16-car match is the right length, and
whether the mounted rifle+launcher is the right kit.

**This is last-car-standing, not battle royale.** No salvage, no placement beyond
"how many were alive", no interest management. The **closing zone is in** (§3),
so a no-clock match is guaranteed to end; the rest of BR (loot, wreck salvage, a
zoned map, 30 cars) is still M10/M11 (DESIGN.md §2.2).

**Bots are shallow, on purpose for now.** No target leading (they aim at where the
target *is*), no cover use, no difficulty levels, no bot crews in duels (only solo
fields), and no notion of self-preservation. They are also lethal in a crowd —
eight bots resolve a field in well under a minute — which is a tuning problem, not
a bug. This is the next real body of work.

## 5. Conventions that are easy to get wrong

- **Aim yaw is positive to the LEFT.** Vehicle forward at yaw `y` is
  `(-sin y, -cos y)`, so increasing yaw turns left. Getting this backwards
  mirrors every field of fire and looks like "the gun is broken". There is a
  test asserting the convention itself.
- **Three different seat offsets, three different jobs** (all in `shared/crews.ts`):
  - `EYE_OFFSET` — the head *inside the cabin* (the driver's, and the mesh socket).
  - `HEAD_OFFSET` — where a gunner's head *is*: at the window, **just proud of the
    skin**. This is both what is drawn and what is hit-tested. It must break the
    hull line or the crew member is unhittable (see §6).
  - `WINDOW_EYE_OFFSET` — where the gunner's *camera* is, further out for near-plane
    clearance. Conflating this with `HEAD_OFFSET` drew occupants floating beside
    the car like chairs bolted to the doors.
- **Hull is not simulated state; components are.** Hull never affects motion, so
  it lives beside the sim. Components do, so they live in it. Do not "tidy" these
  together.
- **Anything the client predicts must be deterministic and shared.** Rendering
  effects (smoke) may use anything; simulation may not.
- **Seat arcs are car-relative**, so a gunner's gaze turns with the car.
- **A healthy car must simulate bit-identically to before components existed.**
  Every damage factor is exactly `1` at full health; there is a test for it.
- **One mesh per solid is a trap.** The arena is merged for a reason (§3).
- **A team IS a crew.** Scoring, spawns and the match state are indexed by crew
  id. A duel has two; solo has one car per team and up to `SOLO_CARS`. There is
  still no separate team table, and adding one is only worth it if teams ever
  hold more than one vehicle.
- **A seat's capability is flags, not a role name.** `drives` and an `arc` are
  independent. Do NOT reintroduce `role === 'driver'` as a proxy for "unarmed" —
  it was removed because the one-man brawler is both, and the driver-protection
  rule (correctly) keys off `drives`.
- **A seat with `mounted` guns OWNS its loadout.** The car is the weapon: the
  occupant's personal default is ignored for that seat, and both sides derive the
  same thing from shared seat data. Do not add a second path that sends a loadout
  over the wire.
- **`this.dir` in `CameraRig` is scratch used by `avoidGeometry`.** Build the look
  target BEFORE calling it, or the camera silently looks somewhere else (see §6).
- **A bot is a Player with `socket: null`.** Do not build a parallel bot entity:
  bots must go through `handleFire`/the seat rules like anyone else, and the only
  reason they cannot cheat is that they have no other path.
- **Bots never change a live match's composition** (§12.4). `syncBots` is a no-op
  while `live`; a human displaces a bot only in the lobby.
- **Count HUMANS where a person is implied**: match readiness, the rematch
  quorum, the client timeout reaper. Count everyone (humans + bots) where
  occupancy is implied: `alive`, snapshot members, enemy targeting.
- **Steering sign: positive steer turns RIGHT; increasing yaw turns LEFT.** A bot
  heading correction is therefore the NEGATED error (`-yawError * gain`). There is
  a test for it because getting it backwards reads as "the bot is passive".
- **A car collides as an ORIENTED BOX** (`carObb` / `obbOverlap`), against walls
  and against other cars. Do not go back to circles or a centre point: that is
  what let flanks sit in walls.
- **Car-on-car contact is a PAIR, so it lives in `resolveRams`, not
  `stepVehicle`.** The server runs it after moving every crew; the client does
  not, and is corrected into the result.
- **LOOK PITCH: positive = the player moved the mouse DOWN.** Every camera must
  pitch down for positive input, or the look inverts between seats. The chase
  camera rises to look down; the window and solo cameras look along the aim and
  NEGATE (see §6).
- **Liveness is the socket's job, not the app's.** The server pings; the browser
  pongs; `lastSeenAt` is bumped by the pong. Do not reap on app silence — a
  backgrounded tab is silent but alive, and reaping on that is what disconnected
  anyone who switched tabs.
- **Joining is explicit.** `NetClient.connect` opens a socket; only `join()`
  sends `hello`. Do not send `hello` on open — that turns a page load into a
  match.
- **The zone is built ONCE, at the whistle, from a seeded plan** (`buildZonePlan`).
  Do not call `Math.random` inside `stepZone`, and do not shrink to a circle that
  is not nested inside the last — either would break reproducibility or fairness
  (a player pushed outside safety they were standing in).
- **A zone kill credits no one** (`destroyVehicle(crew, null)`), unlike a ram or
  a shot.
- **Audio is procedural and gesture-gated.** No asset files — synthesise it — and
  `init()` must be called from a click (the JOIN button), or the browser keeps the
  context suspended. Remote sounds go through `route(..., local=false)`; our own
  stay centred.
- **The audio listener is updated from the CAMERA every frame**, not the car, or
  the panning disagrees with what the player is looking at.
- **Shake is small and decaying**; scale it by distance/damage and never fire it
  on something the player did not feel (a kill across the map).
- **The spatial grid indexes state; it must never be a source of state.** It is in
  `shared/` for convenience, not because the client and server must agree on it —
  a rebuild that differs changes performance, never behaviour. Do not let a
  simulation decision read it.
- **Interest management is a per-CLIENT filter on the wire only.** The server
  still simulates and resolves everything (authority is global); a client that
  cannot see a car still gets hit by its bullet, and its own shots still resolve
  against cars it was not sent. Filtering authority by interest would be a cheat
  vector, not an optimisation.
- **`interestFor` returns `null` for "send everything"** — duels and eliminated
  spectators. Keep it that way or spectating loses the field.
- **Bot difficulty must scale DRIVING as well as shooting.** A bot is a driver
  and a gunner at once, so a profile that only changes aim makes a "hard" bot
  that still can't take a corner. Both halves live in the same `SKILLS` profile
  in `server/bot.ts`, and `bottest` asserts the driving half.
- **Obstacle avoidance must COMMIT to a detour.** Re-aiming at the target every
  tick makes a blocked bot oscillate: turn away, see the target, turn back, grind
  the corner. Store the detour heading for ~0.5 s before re-evaluating. This was
  worth 19 m → 32 m of progress in the same 8 s (§3).
- **Lookahead scales with speed.** A fixed probe distance is a quarter-second of
  warning at 40 m/s. `avoidProbe` multiplies by speed, capped at 2.2×.
- **Clearance is measured across the car's WIDTH**, not its centreline. A centre
  ray lets a bot thread a gap its body cannot fit through, then clip the corner.
- **Speed comes from the clear distance, not the target.** Budget `clearance ×
  1.6` as the speed ceiling and let the throttle follow, or the bot arrives at
  every corner too fast to take it.
- **Smooth the steering.** Snapping to full lock twitches the car into walls;
  low-pass the steer input toward its target (`memory.steer`).
- **Match rules are pure and take the clock as an argument** (`shared/match.ts`).
  Do not reach for `Date.now()` inside it; that is what makes sudden death and
  the tie-break unit-testable without waiting.
- **The match clock is monotonic (`performance.now()`); interpolation is not
  (`Date.now()`).** Only remaining-ms crosses the wire, so the two never need to
  agree — but mixing them inside the room would make `remainingMs` nonsense.
- **Combat and driving are gated on `phase === 'live'`.** If a new effect runs
  outside a live match, it must be gated deliberately; the default is frozen.

## 6. Bugs found, and the lesson

These were all invisible to a screenshot. They are recorded so they are not
reintroduced, and because the pattern repeats: **assert the property, not the
picture.**

1. **Aimed shots never landed (M5).** The muzzle sits *inside* the shooter's own
   collision box, so the box test hit its own car at distance zero, truncating the
   ray before it reached anything. Every shot was silently absorbed by the gun
   that fired it. Fix: skip the shooter's crew in the geometry, not just in the
   damage decision.
2. **The crosshair pointed at your own roof (M5).** The chase camera looks *at*
   the car, so screen centre *was* the car. Measured with `reticleprobe`:
   "your own chassis, 8.8 m away". Fix: separate gunner (window) and driver
   (chase) cameras.
3. **Crew members could never be hit (M6).** Heads were tested at the cabin
   position, *inside* the hull box whose entry distance already clips the ray —
   so `memberHit` could not fire from any angle, for any seat, ever. M5's crew
   downing was dead code that no test covered. Fix: test the head at the window,
   and give it a mesh so it is visible.
4. **Occupants floating outside the car (M6).** Drawn at the camera offset.
   Reported by the user. Fix: separate `HEAD_OFFSET` from `WINDOW_EYE_OFFSET`.
5. **`scripts/` was never typechecked (M6).** `tsconfig.include` listed only
   `src`, so a syntax error in `simcheck.ts` and a double-`hello` in
   `netheadless.ts` both survived a green typecheck. Fixed by including
   `scripts`; it found four problems immediately.
6. **Wheels never reaching zero throttle** (M1), **mirrored window arcs** (M4),
   **arena escape gap at the corners** (M3) — see README for these; same class of
   bug, same class of fix.
7. **`combattest` §4 was flaky, not broken (M7).** Its engine-hit assertion fired
   a fixed **six** shots and required one to find the engine. Measured against
   that exact geometry, an aimed shot finds the engine only **~22%** of the time,
   so the check failed roughly one run in four — which reads as a combat
   regression and is not. The accounting check beside it was worse: it asserted
   every accepted shot changed hull or engine, but a round can also be stopped by
   a wheel, and once the engine hits zero further hits clamp. Fix: fire in short
   bursts until the engine is actually hit, and state the diversion property as
   "fewer hull hits than shots that landed" rather than an exact sum. **A check
   whose sample is smaller than its variance is a coin flip wearing a test's
   clothes.**
8. **The solo camera looked backwards (M7).** `updateSolo` computed the aim
   direction into `this.dir`, then called `avoidGeometry` — which uses `this.dir`
   as scratch — and only afterwards built the look target from it. The camera
   pointed away from the car, so the car rendered *behind* the camera and the
   view was empty. Not visible as a crash and easy to hand-wave as "the car is
   just low in frame"; found by measuring where the car actually projects to NDC
   (`carNdc.z > 1` = behind the near plane). Fix: build the look target first.
9. **A rematch restarted a solo match with the wrecks still dead (M7).** The
   rematch vote calls `beginCountdown` directly, so the phase-change hook in
   `stepMatch` — the only place that called `resetForMatch` — never fired.
   Eliminated cars stayed eliminated, `alive` was 1 the instant it went live, and
   the "new" match ended in the same tick. Invisible in a duel, where everyone
   was already alive at the results screen. Fix: a `startCountdown` helper that
   resets the field, used by both the hook and the vote.
10. **Car sides passed through obstacles (M8 fix).** The car collided as three
   circles down its centreline: a circle is sized to the car's WIDTH, so a
   rotated body's corners and flanks were never covered and could sit inside a
   wall. Fix: the car is an oriented box tested against solids with SAT. Note the
   bug was in the shape, not the wall test — every solid had the same problem.
11. **Mouse look inverted in some seats (M8 fix).** The chase camera interpreted
   a positive look pitch as "camera rises, looks down"; the window and solo
   cameras interpreted the same value as "look up". Driving and shooting were
   different cameras, so the pitch direction flipped between them and read as an
   intermittent inversion. Fix: one convention — positive = mouse down, every
   camera pitches down — and the two aim-aligned cameras negate. Verified by
   reading the camera's world direction, not by eye (`carNdc`-style: `d.y` sign).
12. **Switching tabs disconnected you (M8 fix).** The server reaped a client after
   10 s of *app* silence. A backgrounded tab has its timers and rAF throttled or
   frozen, so it went quiet and was reaped — then reported "disconnected" on
   return. Liveness now rides the WebSocket protocol: the server pings, the
   browser pongs in its network stack (which keeps running when the page does
   not), so a quiet-but-alive tab keeps its seat and only a genuinely dead socket
   is dropped. Proved with a raw socket that sends no app messages: it survives,
   while one that stops answering pings is reaped.
13. **The zone alarm beeped forever (M9).** The tremolo LFO was connected
   straight to the alarm gain, which `setZoneAlarm` held at 0. An oscillator
   connected to an AudioParam **adds** to it, so the gain swung between −0.5 and
   +0.5 — audible for half of every cycle no matter the intended "off". It beeped
   from the instant audio started. Fix: put the tremolo UPSTREAM in a gain that
   oscillates around 1, and keep the alarm gain a clean 0/level envelope.
   **Connecting a source to an AudioParam adds, it does not replace — "modulate
   an off gain" is a beeping bug, not silence.** A probe now asserts
   `zoneLevel === 0` while not outside.
14. **The menu music never started (M9).** `Music.start()` bailed if the playlist
   had not finished loading. Browsers grant audio on a gesture, and the only
   gesture was the click that *left* the menu — so by the time the element
   existed, the gesture was spent and nothing ever played. Fix: remember the
   request (`wantStart`) and start on load, and give the menu a `SOUND` button so
   there is a gesture while the menu is still up. **A gesture is a one-shot
   resource: anything asynchronous it unlocks must be queued, not dropped.**
15. **A total wipe crowned a spurious winner (M11).** Last-standing was decided
   inside `destroyVehicle`, mid-loop, so `alive === 1` fired the moment the
   second-to-last car died — regardless of the rest of the tick. A zone that
   killed every car on the same tick left a "winner" who died in the same tick.
   Fix: decide it once per tick in `stepMatch`, after every death has landed, so
   a simultaneous wipe is a draw. **A win condition evaluated mid-loop is a win
   condition that sees a partial world.**
16. **A symmetric map makes one feature four (M12).** The first authored mesa was
    placed over the existing tall landmark — and, because every feature is
    replicated by a quarter turn, its rotated copy would also have dropped onto
    the combat test's pinned line of fire. Fix: check a new feature against *all*
    its consequences at once — its three rotations, both spawn rings, the pinned
    combat pair, the crates. **A spot is clear only if its three rotations are.**

**Test-harness traps that look like game bugs**:
- Two browser probes in parallel on one dev server contend for the same seat; the
  loser becomes a gunner and *cannot drive*, which reads as "the car will not move".
- Fixed `sleep`s around firing: the server rate-limits shots, so a phase that
  reads its result too early misses most hits and they land in the next phase.
  Use `fireAndSettle`/`waitFor` in `combattest`, not sleeps.
- Growing the map moved the spawns 148 m apart with cover between them, which
  broke the combat test's line of fire. `scripts/testPlacement.ts` pins a known
  clear pair, and simcheck asserts it is still clear, so a map change fails fast
  and says why. Adding a feature (M12) is the same class of risk four times over,
  because it replicates: check the rotation against the pinned pair too.

## 7. Architecture in one screen

```
src/shared/    pure, deterministic, no DOM. BOTH sides run this.
  config.ts      every tuning number
  arena.ts       solids as boxes/ramps; 4-fold symmetric by construction
  vehicle.ts     the arcade car model (stepVehicle), box collisions, resolveRams
  components.ts  component health + its effects on motion + hitboxes
  crews.ts       seats (drives/arc/mounted), eye/head/window offsets
  weapons.ts     weapon table
  combat.ts      muzzle geometry, ray tests, damage — shared by both sides
  repair.ts      whether a car may repair at a crate
  match.ts       match state machine: phases, score, clock, last-standing
  zone.ts        the closing danger zone schedule (pure, seeded)
  protocol.ts    wire format
src/server/    the authority. Imports the sim, never renders.
  room.ts        tick loop, input validation, damage, snapshots, lag comp
  bot.ts         AI brain — server-only, never sent or predicted
  server.ts      transport + static hosting + /healthz (no game logic)
src/client/    prediction, rendering, input
  net.ts         prediction, reconciliation, interpolation, aim correction
  camera.ts      three cameras: chase, window (gunner), forward (solo)
  hud.ts         read-outs
  vehicle/       part graph; partLibrary is the glTF seam
scripts/       tests and diagnostics (see §2)
```

## 8. Next actions, in order

1. **Playtest the loop with a human — the biggest open risk.** M11/M12 are
   feature-complete, but every number in them is *measured*, never *felt*: the
   zone (380 m, six phases), the bot skill, the arc, the 30-car field, the ~157 s
   match length, and whether the garage reads as a reward. All knobs (`ZONE`,
   `BOT`, `crews.ts`); `solobench` re-measures after any change.
2. **Deepen the bots, further.** Roaming, engagement range, repair-seeking and
   wounded-finishing target selection are done (§3), and they lengthened the
   30-car match. Left: **cover use** (break line of sight under fire),
   **coordinated focus-fire** (needs shared state between bots, not a per-bot
   rule), and **bot seats in duels** — a gunner the driver cannot supply.
   (Target-leading is a non-issue for the rifle — it is hitscan; it matters only
   if bots ever fire the launcher.)
3. **Author the map, further.** A first pass landed in M12 (§3): verticality (a
   drivable mesa), landmarks (crane, dam) and a road network, still one quadrant
   rotated four times. What remains is *variety and character* — a distinct
   set-piece per zone rather than one per quadrant, roads that connect them, real
   terrain relief — which means deciding how much of the fairness guarantee to
   trade for character. Do not rush it; symmetry is what the tests assert and a
   half-authored map is worse than a clean procedural one.
4. **More cosmetics, and put the earned ones to use.** M12 shipped the system;
   what it lacks is *variety* — more paints, decals on the `decal.*` sockets, a
   second wheel face per class. If cosmetics ever cost money, that is DESIGN.md
   §14 and it needs M13 accounts first.
5. When the crewed compositions return: they are now a **seat-layout change**, not
   a rewrite — an armed driver plus gunners is a new `SeatDef[]` with `drives` and
   `arc` set per seat, and `mounted` guns anywhere. The open design question is
   only whether a crewed car's guns stay personal (window) or become mounted.
6. Optional M6 debt, if it starts to matter: an end-to-end test that repairs a
   car at a crate, and one for hazard damage.
7. Before any paid asset pipeline: add a **mesh/material budget** to
   `ASSET_SPEC.md` and enforce it in `assetcheck`. `scalebench`/`meshprobe` show
   draw calls are the client wall, not polygons, and a badly-authored model is
   the fastest way to lose the frame budget.
8. **Deploy a wider playtest — waits on budget, and on demand.** The code is
   ready (`DEPLOY.md`; one Docker container serves client + socket + `/healthz`).
   This is *provisioning*: pick App Platform (~$5–10/mo) or a Droplet + Caddy
   (~$6/mo), set `MODE=solo` and `ALLOWED_ORIGINS`, and send the URL. Before any
   *public* launch (not a friends list): add a session token to the `hello`
   handshake and per-IP join rate limiting, and keep every `DEV_*` flag off.
