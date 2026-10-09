# Crewed Vehicular Battle Royale — Design Document

> Working title: **CONVOY** *(placeholder — rename freely)*
> Status: **design complete, ready to build**
> Licence: **proprietary, all rights reserved** *(provisional — see §17)* · Model: **F2P, cosmetic-only shop**

A browser-based 3D post-apocalyptic vehicle shooter. **Your car is your team.** One player drives, the others fire their own weapons out of the windows. Everyone outside your chassis is an enemy. Fight crew-versus-crew in tight duels, or scramble across a wasteland in a battle royale where only one crew drives away.

---

## 1. Vision

A crewed vehicle is the atomic unit of the game. Inside it, two games run at once:

- **The driver's game** — positioning, mobility, tempo. Never fires a shot, yet decides every engagement by choosing range, angle, and escape routes.
- **The gunners' game** — coverage, tracking, target priority. Each seat fires through a different window, so no gunner can cover every angle and the crew has to cover each other.

The game lives in the **coupling** between them. A gunner cannot shoot what the driver never exposes; a driver is wasted if the gunners can't convert position into damage.

**"Your car is your team" also solves multiplayer identity.** There are no teams to colour-code, no allies to confuse with enemies. Everyone outside your vehicle is hostile. Friend-or-foe readability — normally the hardest problem in a team shooter — simply does not exist here.

### Design pillars

1. **One crew, one fate.** Shared vehicle, shared hull. You win or die together — but individual crew can be *downed*, so nobody is fully safe behind the metal.
2. **Positioning is the weapon.** Every gunner fires through a fixed window with a limited arc, so the driver's line of approach decides which of their guns can even see the enemy.
3. **Readable, tactical damage.** Shots break specific things — wheels, engine, guns — so aiming is a decision about *what to disable*, not just "drain the bar."
4. **Fair by construction.** Identical performance for every player. Depth comes from teamwork and skill, never from loadouts.
5. **Scavenge to survive.** Repairs come only from the map, so controlling resources matters as much as landing shots.

---

## 2. Modes

Four modes on a 2×2 grid; **attrition was dropped — battle royale replaces it.**

| | **2-crew** (driver + gunner) | **4-crew** (driver + 3 gunners) |
|---|---|---|
| **Duel** | 2v2 · compact arena | 4v4 · medium arena |
| **Battle Royale** | ~30 cars · 60 players | ~30 cars · 120 players |

One vehicle per crew. Crew sizes never mix in a match — separate playlists — because a 2-crew car facing a 4-crew car brings one gun to three.

### 2.1 Duel modes — 2v2 and 4v4

- **Respawn team deathmatch.** Each crew respawns together after a delay at a team spawn.
- **Kill target:** 25 (tunable, scaled by crew size). **Hard time limit:** ~12 minutes, with the higher score winning on expiry and **sudden death** on a tie.
- **Design note:** with the deliberate slow TTK (§6), the 25-kill target is usually *not* reached inside 12 minutes. The time limit is therefore the normal end condition and the kill target acts as an early-win / mercy condition. This is intentional and should be communicated clearly in the HUD.
- **Arena scale:** compact for 2v2, medium for 4v4 — only ever two vehicles on the field, so both are built for constant contact.

### 2.2 Battle Royale — 2-crew and 4-crew *(phase 2)*

- **One vehicle life. Last crew driving wins.**
- **~30 cars** (60 players at 2-crew, 120 at 4-crew). Tunable upward once interest management is proven.
- **15–20 minute matches**, scored by **placement + kills**. Everyone who isn't first still receives a placement and performance feedback.
- **Closing danger zone.** Damage escalates over time and eventually becomes lethal, forcing convergence.
- **Downed crew respawn back into the car after a delay, provided the car survives.** Losing a gunner is a temporary weakness, not an elimination — the car's survival is everything.
- **Resupply:** repair crates scattered across the map **plus salvage drops from destroyed wrecks**, so hunting other crews is rewarded over hiding.
- **No join-in-progress.** BR lobbies fill before the match begins.

### 2.3 One-man teams — the car is the weapon

The first mode built *against* the vehicle rather than the crew: **one player per
car**, and the car itself is retrofitted with guns. Where a duel gunner carries a
personal weapon through a window (§3.2), a one-man brawler has no windows worth
firing from — the weapons are bolted to the car, and the driver works them.

- **The driver drives and shoots at once.** This is the whole point and the whole
  mode. There is no second seat, so the same player holds the wheel and the
  trigger.
- **Last car standing, one life.** No respawn, and **no clock** — the match ends
  when one car remains, not when a timer runs out. A destroyed car is out and is
  placed by how many were still running when it died.
- **A closing danger zone ends it.** The circle holds and shrinks five times,
  damaging anything outside and able to destroy it, so the last survivors are
  forced together instead of circling a 340 m arena forever. Each new circle
  drifts to a random centre nested inside the last, so the endgame is not a
  script you can memorise (§10.3).
- **Field size is N cars on the shared arena** — sixteen to begin, tunable upward.
- **The car's guns are its kit, not the player's.** Ammo, reload and the fire arc
  belong to the SEAT, so a future crew can arm the driver, a gunner, or both
  without inventing a second weapon system.

**Why this is the same system as the duels, not a detour.** A seat declares what
it can do — `drives`, and an `arc` if it can fire — and a car-mounted loadout if
its guns are built in. The duel layouts are then just two more descriptions of
the same data: a coupe's driver `drives` with no arc, a gunner has an arc and no
wheel. One-man teams are the case where a single seat sets both flags. That is
what leaves the door open for the compositions in §3 without a rewrite: a driver
and a shooter, a driver and three shooters, or an armed driver *and* gunners.

---

## 3. Roles

### 3.1 Driver — pure utility

The driver never fires. Their kit is entirely about *where the car is* and *how it moves*.

| Ability | Function |
|---|---|
| **Boost / Nitro** | Speed burst on a meter fuelled by **momentum (driving fast) and aggression (ram impacts)**. Passive drivers cannot boost — the resource itself pushes you toward the fight. |
| **Handbrake / Drift** | Cuts lateral grip; rotate and slide. The core skill expression. |
| **Ram / Bash** | Impact damage **scaled by relative closing velocity**, capped, and **both vehicles take some**. Split by **angle**: a nose into a flank or tail costs the struck car far more than the striker; head-on damages both equally. Passive — just physics, no button. Rewards committing at speed and punishes head-on trades. |

**The driver is protected.** Armour and cabin mean they **cannot be directly shot out** — they only die when the vehicle dies. This prevents the nightmare case of an intact car with nobody able to drive it. Gunners are the exposed ones.

### 3.2 Gunners — crew seated inside, firing from windows

Gunners ride **inside the vehicle** and fire **their own weapons** out of the windows. **Nothing is mounted on the car** — the weapons belong to the players, and the driver is unarmed (§3.1).

A gunner's field of fire therefore comes from **which window they sit beside**, not from a turret. That is what replaces turret traverse as the reason positioning matters: a gunner in the front passenger seat cannot shoot behind the car, and one in the rear cannot shoot forward, so the **driver has to present the armed side of the vehicle to the threat**. Same pillar, different mechanism — and far more readable, because you can see which windows are occupied.

| Seat | Field of fire |
|---|---|
| Driver | none — unarmed, protected in the cabin |
| Front passenger | forward, and to their side |
| Rear left | rearward and left |
| Rear right | rearward and right |

Riding inside is also the protection trade: a seated gunner is far harder to hit than one standing in the open, but their arcs are much narrower than a turret's. Crew can still be shot out of their seats (§4.2).

> **Carried into M5/M7:** with the driver on the left, the forward-left sector is uncovered unless a rear gunner leans into it. That asymmetry *is* the driver-coupling mechanic working — angle the car to present the armed side — but it needs feeling out once weapons exist, and the coupe (one gunner, one window) is the extreme case.

### 3.3 Vehicle classes

Two vehicles, one per crew size. They never meet in a match — separate playlists (§2) — so they can differ freely in size and shape without any fairness problem.

| Class | Crew | Description |
|---|---|---|
| **Coupe** | 2 — driver + one gunner | A low two-seat coupe. The gunner rides in the passenger seat and fires out of that window, so the car has a single narrow arc and one large blind side. |
| **SUV** | 4 — driver + three gunners | A tall four-seat SUV with two rows of windows. Front passenger, rear-left and rear-right gunners cover three sectors between them. |

Both are **civilian cars**, not armoured military hardware: recognisable modern archetypes with the windows open. Nothing is bolted to the chassis.

### 3.4 Role selection

- Players **choose their seat in the lobby**.
- On respawn they may **re-pick** any seat on their vehicle.
- Fixed enough to build expertise; flexible enough to adapt.

### 3.5 Crew vulnerability

- Each crew member has **personal health**.
- **Gunners can be shot out of their seats** through the windows. In duel modes they respawn after a delay; in BR they are *downed* and return to their seat if the car survives.
- The **driver cannot be shot out** and dies only with the vehicle.

---

## 4. Vehicle & Damage Model

### 4.1 The modular part graph

```
Chassis
├── Hull integrity    ← THE KILL CONDITION
├── Wheels      × N   ← mobility, traction        (damage module + cosmetic point)
├── Engine            ← power, top speed, boost   (damage module + cosmetic point)
└── Seats       × N   ← crew positions; each has a window and a field of fire
```

The graph exists for **damage modules and cosmetic attachment points only** — *not* for stat loadouts. All performance is identical for all players.

### 4.2 Hull kills, components disable

- **Hull HP kills.** At zero, the vehicle is destroyed: the whole crew is eliminated (BR) or waits to respawn (duel).
**As built (M6).** Hull, engine and four wheels. Component health lives *in* the
simulation rather than beside hull — see the note in `src/shared/components.ts`
— because it changes how the car moves and the client must predict with it.

A hit that lands on a part damages that part and **not** the hull. Parts are only
reachable near the surface the round actually arrived at
(`COMPONENT.hitDepthTolerance`), so a round through the radiator cannot take out
a wheel on the far side. In practice the spread of a weapon makes part-shooting
a *close-range* skill: the rifle scatters ±0.014 rad, which is ±0.8 m at 57 m and
far more than an engine's half-metre width.

**Components disable** at zero health:
  - **Wheels** → reduced traction, steering pull, eventual immobilisation.
  - **Engine** → lost power and boost, reduced top speed.
  - **Seats** → the crew member in them is exposed through that window.
- Aiming therefore becomes a *decision*: strip the tyres to stop the escape, break the cannon to remove the threat, kill the engine to finish it.

### 4.3 Repair — pickups only

- **There is no passive regeneration.** Damaged components stay damaged until repaired.
- **Repair crates** restore hull and components **gradually over a few seconds while the vehicle holds position near them** — committing you to a vulnerable, stationary window that enemies can punish.
  - **As built:** five crates — four symmetric, one contested at the centre. The
    crate is *finite* (8 seconds of repair) and returns after 45 seconds, so the
    resource itself is worth holding rather than being a bottomless corner to
    camp. "Holding position" is a hard requirement (`shared/repair.ts`): a
    drive-by that topped you up would delete the risk entirely.
- This makes repair crates **the most important map resource in the game**, exactly as intended by the "scavenge to survive" pillar.
- **BR additionally** lets destroyed wrecks drop their remaining repair resources as **salvage**, rewarding aggression.

---

## 5. Weapons

Weapons are **carried by the players**, not mounted on the vehicles (§3.2). The driver is unarmed, and nothing is bolted to the chassis.

**Mixed hitscan + projectile sandbox**, as personal arms:

| Type | Examples | Behaviour |
|---|---|---|
| **Hitscan** | Rifles, machine guns | Instant hit, lag-compensated server-side |
| **Projectile** | Grenade launchers, rockets, thrown charges | Real simulated travel — dodgeable and leadable |

What matters for the shape of the game is that **gunnery from a moving vehicle, through a narrow window arc, is the core skill** — and that the driver's job is to create those shots. The exact roster is tuned at M5.

### 5.1 The roster as built

Three weapons, chosen to cover the three decisions a gunner actually makes: *sustain*, *reach*, and *area*. A player spawns with the first two and can switch at any time (`1`/`2`).

| Weapon | Delivery | Damage | Rate | Mag | Reload | Spread | Notes |
|---|---|---|---|---|---|---|---|
| **Rifle** | hitscan | 17 | 9/s | 30 | 2.2 s | wide | The default. Automatic, forgiving, and the main way damage is applied. |
| **Marksman** | hitscan | 52 | 1.3/s | 6 | 3.0 s | tight | Punishes standing still; nearly useless from a drifting car without a patient driver. |
| **Launcher** | projectile | 85 | 0.8/s | 1 | 3.4 s | — | 48 m/s, 6 m splash. Dodgeable on purpose — a projectile you cannot see coming is not a decision. |

The numbers are deliberately **slow**, matching §6: a rifle is 17 damage against a 1200-point hull, so killing by gunfire alone is a sustained effort of many seconds, during which the target can disengage or be repaired. That is the point.

**Weapons are data, in one file** (`src/shared/weapons.ts`), and both sides read the same table. The client predicts with those numbers and the server validates against them; a fire rate the client believes is 8/s and the server believes is 6/s is a player who feels cheated every time they pull the trigger.

**Ammunition:** **infinite reserve with magazine reloads.** You never truly run dry, but reloading is a real vulnerability window the driver must play around. Keeps pickup design focused on repair and power.

No functional weapon upgrades exist, ever — this preserves pillar 4.

---

## 6. Combat Feel

- **Slow TTK.** A full-hull car under a single MG takes sustained fire to destroy; the cannon kills in several well-placed hits; two gunners working together kill far faster. Engagements last long enough for positioning, disengaging, and repairs to matter.
- **Fast arcade driving.** Roughly **110–150 km/h**, snappy acceleration, strong drift, generous air time on ramps. Drifting is the central driving skill.
- **Exact numbers are tuning data, not design** — see §14.

---

## 7. Aiming & Camera

- **All roles third-person.**
- **Driver:** chase camera behind the vehicle, collision-aware (never clips through geometry).
- **Gunners:** orbit camera around the car giving **free 360° aim**, with **reticle-ray aiming**:
  - The crosshair defines a ray from the camera.
  - The shot travels from the **gunner's weapon in the window** to the world point the crosshair is over (**parallax-corrected**).
  - Result: familiar third-person-shooter feel, but shots visibly originate from the window the gunner is leaning out of — and the car body blocks anything the arc cannot reach.

**As built.** A gunner gets a *window* camera and a driver gets a *chase* camera. They are not variations on a theme: a chase camera is a view **of** the car, anchored to its centre, and a window camera is a view **from** the car, anchored to one particular window on one particular side.

Anchoring a gunner's view to the car is wrong twice over. A crosshair drawn on the centre of the screen then sits on the player's own roof — with a chase camera the centre of the screen *is* the car. And every seat shares one perspective, so a four-crew SUV would be three gunners looking at the same picture, differing only in where their arc happens to point.

The gunner's camera therefore sits at their window, just outside the bodywork (`WINDOW_EYE_OFFSET`), rigidly attached to the car — a head in a window moves with the car. Attitude (ramp pitch and roll) is deliberately ignored, matching the simulation, which treats it as cosmetic: the anchor sits within half a metre of the car's pitch and roll axes, so a 15° ramp moves it about 6 cm.

The shot is then parallax-corrected. The camera and the muzzle are ~0.6 m apart, so firing straight down the camera's direction from the window is off by that distance at *every* range — the two rays are parallel, not converging. The client resolves the crosshair ray against the arena and other vehicles (skipping its own car, which the ray often crosses when aiming back across it) and aims the window's muzzle at the point it found, landing within 0.15 m of the crosshair. The result is clamped to the window's arc last, so near the edge of the arc the arc wins and the shot is blocked exactly as described above.

> **UNRESOLVED — needs a design pass with the user.** Everything above is *correct* and the geometry is locked down by tests, but the result does not yet feel like the target: "peeking out of a car window, as in Fortnite". Noted for a dedicated session rather than more incremental tuning. Open questions to settle then:
> - Is the camera *inside* the cabin looking through the window aperture (the frame visible around your view), or outside the skin looking along the flank, which is what it does now? The former needs real window openings and cabin interior geometry — the part graph has the sockets but the body is currently a closed loft with no apertures.
> - How much of the car should be in shot? Currently the flank fills the lower-left at close range.
> - Should the view be first-person-from-the-seat rather than third-person at all?
> - What does the *driver* see by comparison — the contrast between the two roles is part of what makes the crew read.
> Treat the current offsets as a placeholder, not as tuned values.

---

## 8. Readability & Feedback

Because **every vehicle outside your own is an enemy**, no team colour scheme is needed. Your car is always identifiable (you're inside it); everything else is a target in both duel and BR.

**Damage communication:**
- HUD strip showing **hull, boost fuel, and component status**.
- **A destroyed car explodes** — flash, fire, smoke and a ground shock ring. The
  end of a vehicle is the biggest thing that happens in the match and must be
  impossible to miss.
- **Visual degradation:** smoke at low hull, sparks and wobble from broken wheels, a visibly jammed or hanging gun, engine sputter.
- **Damage numbers** where a hit lands, a **directional hit indicator** for incoming damage, and a **low-hull vignette** — all built.
- **Positional 3D audio** treated as a gameplay system: you hear enemy engines approaching from behind, locate gunfire by direction, and can distinguish a broken engine from a healthy one. Built **procedurally** — oscillators and one noise buffer, no asset files — so pitch, burst length and falloff are tuning numbers rather than audio edits.
- **Camera shake** on impacts and nearby explosions, scaled by distance and damage, so the size of a hit is felt and not only seen.
- **Music** — two small third-party playlists (CC BY, see §17): broadcast-style intro music in the lobby, and a low match bed that rises as the zone closes, so the endgame plays like the show's climax. Engines and guns still carry the fight.

---

## 9. Vehicles & Customisation

- **One balanced chassis per crew size** (2-seat and 4-seat). Performance identical for everyone.
- **Cosmetic customisation only** — Fortnite-style paint, decals, body kits, wheels. Purchasable in a **cosmetic-only shop**, but **never affecting play**. Non-purchasers can always earn cosmetics in-game.
- The modular part graph (§4.1) is the foundation for cosmetic swaps *and* damage modules. It is deliberately **not** a stat-loadout system.

**Built (M12).** Paint (ten liveries across four finishes — gloss, matte, chrome,
pearl), wheels (spoke count and hub colour) and roof kits (rack / wing / scoop /
light bar), chosen in the join-menu **garage** and stored per browser. Unlocks are
**earned only** for now — there is no shop until accounts (M13), which is the
honest order: earning is the part that must exist either way.

Two properties are structural rather than promised. A look is three small indices
packed into **one integer** on the wire, so it costs a number per car per tick and
the server only relays it. And `cosmeticstest` asserts a catalogue entry may carry
appearance fields **and nothing else**, so a "livery" with a hidden grip bonus
fails the build instead of becoming a balance argument. Decals on the `decal.*`
sockets and more body kits are content, not system, work.

---

## 10. Maps

### 10.1 Duel arenas
- **One compact arena (2v2)** and **one medium arena (4v4)**, both **rotationally symmetric** for fairness.
- Built specifically for two vehicles: open circulation lanes, jump ramps, car-sized cover blocks and pillars, a central contested pickup, and a hazard.

### 10.2 BR map *(phase 2)*
- **One large hand-crafted wasteland map with distinct zones** — ruins, dunes, a dried lakebed, a scrapyard — connected by roads and ramps, plus the closing danger zone.
- One map done properly beats several done hastily.

**Started (M11, extended M12).** The arena is now **800 m across** with zones by distance from the centre — dunes, scrapyard, lakebed, rim — authored in one quadrant and rotated four times, so they are symmetric by construction rather than by inspection. Ground is nested, tinted rings so the zones read on the ground.

The M12 pass adds the first *authored* content: **verticality** (a drivable 4.2 m mesa with ramps, so high ground is a position to take), **landmarks** (a 16 m scrapyard crane; a low lakebed dam that cuts sightlines across open ground) and **roads** (axis-aligned ground strips that replicate into a ring road and four spokes — wayfinding, not obstacles). Still one quadrant, so still symmetric. What remains is true hand-crafted *variety*: distinct set-pieces per zone rather than one per quadrant, roads that connect them, and terrain relief. That work trades the fairness guarantee for character and is deliberately not rushed to keep symmetry.

### 10.3 Hazards
- **Damaging but not instantly lethal.** A pit costs hull and pulls you out of the fight; a crusher disables components. They are **positional threats, not gotchas** — important in a crew game where one driver's mistake should not instantly kill three teammates.
- The BR **danger zone is the exception**: it escalates over time and eventually becomes lethal to force endings. It also **moves**: each new circle sits inside the last but is offset to a random centre, so no two matches end in the same place and the endgame cannot be pre-scripted.

---

## 11. Pickups

| Pickup | Effect | Placement |
|---|---|---|
| **Repair crate** | Gradual hull + component repair while holding position | Scattered + contested central |
| **Central power pickup** | Strong temporary advantage (armour plating or weapon overcharge) | One, contested, duel arenas |
| **Wreck salvage** | Repair resources dropped by destroyed vehicles | BR only |

Spawn timing is a map-control resource in the arena-shooter tradition.

**Built (M11):** **wreck salvage.** A destroyed car leaves a temporary repair pile
where it died — less charge than a crate and a short life, capped so a mass wipe
cannot litter the map. It is the same crate system with an expiry, drawn in rust
rather than green. The other two rows remain design.

---

## 12. Match Flow & Social

### 12.1 The loop
**Lobby** (pick vehicle + seats; bots fill empty ones) → **countdown** → **match** → **results with full stats** → **one-click rematch** keeping crews together, or return to lobby. The rematch button is what keeps a group playing for hours.

### 12.2 Crew formation
- **Party system:** create a crew, invite friends via code or link, queue together.
- Quick match fills any empty seat.

### 12.3 Disconnects
- **The seat stays empty** — no bot takes over mid-match (no AI should decide a live competitive result).
- **The human may reconnect and reclaim their seat.**

### 12.4 Mid-match bots
- **Never.** Bots exist in the lobby, in practice, and before a match starts. Live matches are humans only.
- **Duel modes** may accept **join-in-progress humans** to fill vacated seats.

### 12.5 Communication
- **Contextual ping system** (mark enemy, request repair, call focus target) **+ text chat**.
- **External voice** (Discord) for v1, with the audio layer designed so **built-in WebRTC crew voice** can drop in later. Crews are only 2–4 players, so mesh WebRTC needs no SFU.

### 12.6 Accounts
- **Anonymous sessions for v1.** No login. The data layer is designed so accounts, stats, and unlocks can be added later without a rewrite.

---

## 13. Technical Design

### 13.1 Stack

| Layer | Choice | Reason |
|---|---|---|
| Language | **TypeScript** | One language across client and server; shared types and shared simulation |
| Client build | **Vite** | Fast HMR, modern bundling |
| Server | **Node + `ws`** | Full control over the authoritative game loop |
| Rendering | **Three.js** | Best-in-class browser 3D |
| Physics | **None (custom)** | See 13.2 |
| Transport | WebSocket | Browser-native, sufficient for this tick model |

### 13.2 Why no physics engine
Client-side prediction requires client and server to run **identical** movement code. A third-party physics engine introduces divergence (WASM builds, solver differences, non-determinism). Instead we write a **shared, deterministic, fixed-timestep simulation in plain TypeScript**. Both sides run V8, so IEEE-754 float math is reproducible — giving near-perfect prediction parity. This is only viable because we own the simulation.

### 13.3 Vehicle physics
**Raycast-based arcade car model:** each wheel casts a ray to the ground producing suspension force; engine force applies along driven wheels; steering rotates wheel direction; **lateral grip** resists sliding and the **handbrake cuts lateral grip** to drift. Deterministic, cheap, and it makes drifting feel great without a physics engine.

### 13.4 Netcode
1. **Server-authoritative at a fixed 60 Hz tick.**
2. **Shared simulation code** across client and server.
3. **Client-side prediction** for the local vehicle — zero input lag for the driver.
4. **Smoothed reconciliation** — replay unacknowledged inputs, then **decay** pose error over ~150 ms rather than snapping. Vehicles are large and visible; snapping looks broken.
5. **Lag compensation for hitscan** — rewind enemy vehicles to where the gunner saw them (≈ RTT/2 back).
6. **Server-simulated projectiles**, with local prediction for your own shots and interpolation for everyone else's.
7. **Entity interpolation** for remote vehicles between snapshots (~100 ms buffer).

### 13.5 Scaling to battle royale *(phase 2)*
The duel game runs 8 players in one room. BR at 30 cars / 60–120 players requires additional architecture:
- **Spatial partitioning** on the server (grid/octree).
- **Interest management** — only sync entities near the client; never broadcast 120 vehicles at 60 Hz.
- Potentially **server meshing** across processes.
This is deliberately staged as phase 2 so the core game is proven first.

**Built (M10).** A uniform spatial hash (`shared/grid.ts`) and per-client interest
management: a client receives only the crews within a radius (320 m, plus a
hysteresis margin), and the same filter covers members, projectiles and shots. It
is a wire filter, never an authority filter. Measured on a 1 km map with 30 cars:
**664 → 46 kbit/s per client**. The large zoned map is still to come.

**Measured ceilings.** `npm run scalebench` and `node scripts/meshprobe.mjs` measure these walls with the real code instead of asserting them. One machine, eight-crew snapshots, procedural parts:

| Entities | Snapshot JSON | Per client @30 Hz | Server egress @120 players | Sim ms/tick |
|---|---|---|---|---|
| 2 cars / 8 crew | 1.8 KB | 444 kbit/s | 3.6 Mbit/s | 0.011 |
| 8 / 32 | 7.1 KB | 1.7 Mbit/s | 55 Mbit/s | 0.026 |
| 30 / 120 | 26.7 KB | 6.4 Mbit/s | 770 Mbit/s | 0.070 |
| 60 / 240 | 53.6 KB | 12.9 Mbit/s | 1543 Mbit/s | 0.143 |

Two results that reorder the phase-2 plan:

- **The simulation is not the bottleneck.** 120 vehicles costs 0.24 ms of a 16.6 ms tick — 70× headroom. Simulating 30 cars is free, and hit detection with rewind history is ~0.01 ms per shot. No physics engine also means no engine to buy performance back from later.
- **Replication is.** JSON at 30 cars is **6.4 Mbit/s per client** and 770 Mbit/s of egress. Binary encoding (quantised floats), delta compression against an acked baseline, and interest management are mandatory, and they compound — roughly 6.4 → 0.3 → 0.05 Mbit/s. The netcode *shape* (authoritative 60 Hz, prediction, interpolation, lag compensation) is already right; only the encoding and the fan-out are wrong.

**Rendering.** One procedural car is 71 meshes / 11 materials, ~10 k triangles. Thirty cars in view is ~3.9 k draw calls, of which **~1.7 k is the shadow pass**. Triangles sit ~30× under budget, so:

- **Draw calls are the client wall, not polygons.** A well-authored high-detail car (one body, four wheels, glass, interior ≈ 8 meshes and 4 materials at 80 k triangles) is *cheaper per car in draw calls* than the current procedural one, and thirty of them is ~2.4 M triangles — comfortable on a mid-range GPU.
- **The real risk is badly-authored assets.** An AI-generated model that arrives as hundreds of separate objects turns 30 cars into ~6 k draw calls and kills the frame. `ASSET_SPEC.md` budgets triangles; it needs a **mesh/material budget** too, and `assetcheck` should enforce it.
- **The part graph is already an instancing plan.** One `InstancedMesh` per part id across every car collapses ~4 k calls toward ~71 — the single largest available win, and it needs no architectural change, only that parts stay separate objects. Per-instance colour covers cosmetic tinting.
- **Texture memory and download size become the new ceilings, not polygons.** Thirty unique PBR cars at 2 K is roughly 600 MB of VRAM and as much again to download. This is precisely why cosmetics are *part swaps on a shared base* — the seam M3 built for other reasons turns out to be the streaming strategy.

### 13.6 Content pipeline & modding
**Partially data-driven:** **arenas and game modes are declarative data files** loaded at runtime (JSON), making them trivially tunable. **Vehicles and weapons stay in code.** Whether community content is *supported* depends on the licence (§17) — the data-driven structure keeps that option open either way, which is the reason to build it this way regardless.

### 13.7 Hosting & matchmaking
- **Dedicated Node server** hosting multiple isolated rooms in one process; scale horizontally (more processes, then regions) when needed.
- Players join by **room code** or **quick match**.

### 13.8 Anti-cheat
**Server authority plus pragmatic input validation:** rate-limit inputs, reject impossible movement, validate shot origins and fire rates, keep all hit detection server-side. **No client-side anti-cheat, and no obfuscation.** With a closed licence obfuscation becomes *possible*, but it remains weak value: the client is not the authority, so cheating requires the server to accept a lie it should be validating against anyway. Server authority plus validation is the real defence, and it is worth more than obfuscation ever was.

### 13.9 Bots — first-class
The game needs 4–8 humans to function, so bots are essential for testing, lobby fill, and letting one player experience the full loop.
- **Driver bots** — navigate, engage, disengage, use boost, seek repairs.
- **Gunner bots** — lead targets, prioritise components, and respect their window's arc.
- **Server-side**, so they participate in the authoritative sim identically to humans.
- **Never in a live match** (§12.4).

### 13.10 Performance target
**60 fps on a mid-range laptop** across desktop Chrome / Firefox / Safari / Edge. Low-poly art, instanced geometry, strict draw-call budget. Duel rooms: 8 players. BR: 60–120 players (phase 2).

---

## 14. Tuning Data (not design — starts as config, ends as playtest)

M0 should establish these as a single tunable config module:
- Hull HP, component HP (wheels / engine), crew HP.
- Per-weapon damage, rate of fire, magazine size, reload time, range.
- Per-seat window arcs — how far a gunner can traverse before the car body blocks the shot.
- TTK targets consistent with **slow TTK** (§6).
- Boost capacity, gain rates from momentum and ram, boost multiplier.
- Respawn delay; BR downed-crew return delay.
- Kill target, match time limit, sudden-death rules.
- Repair rate, repair crate count and respawn timing.
- Danger-zone damage curve and closure timings (BR).
- Default wheel count (4) and vehicle dimensions.

---

## 15. Accessibility

Designed in early, at a solid baseline:
- **Remappable controls**; mouse sensitivity and FOV options.
- **Colourblind-safe by construction** — no information is conveyed by colour alone (§8).
- **Reduced camera shake** option.
- **Visual indicators and captions for audio cues**, so deaf and hard-of-hearing players receive the same information the positional audio provides.
- **Input abstraction layer** built for actions, not raw keys, so **gamepad support** can be added cleanly later.

---

## 16. Onboarding

A **short interactive tutorial** (drive, shoot, repair) followed by a **bot-filled practice match**. The game has real mechanical depth — drifting, covering your crew's blind sides, component targeting, repairs under fire — and players need a safe place to learn it.

**Deferred to M14, on purpose.** The tutorial is written last because it teaches mechanics that are still moving; building it now means rewriting it every time a number or a rule changes. Until then, first-match **tips** walk a new player in (controls, the ring closing, the first time they are outside it), shown once per tab. That is not the tutorial — it is the floor until there is one.

---

## 17. Business & Licensing

- **Open source under the GNU General Public License, version 3 or later** (`LICENSE`, `GPL-3.0-or-later`). Anyone may use, study, modify and redistribute the client and the server, on the condition that derivative works carry the same licence.
- **Free to play with a cosmetic-only shop.** All gameplay is identical for everyone; cosmetics are earnable in-game. Under GPL-3 a fork can run a server with everything unlocked — the shop is therefore an honest convenience, not a lock, and that is an accepted consequence of going open rather than a hole in the plan. *(Started: M12 ships the cosmetics and their earnable unlocks; the shop itself waits on accounts, M13.)*
- **Modding and community servers are a default again.** The licence permits them, and the content pipeline (§13.6) is the intended path.
- **Third-party assets still need care.** GPL-3 does not make an incompatible asset compatible: prefer CC0 (`Kenney`, `Quaternius`) or explicitly GPL-compatible terms, and check the redistribution terms of anything else — including AI-generated assets, whose free tiers often exclude them.
- **Contributions** are accepted inbound = outbound (contributions are licensed under the same GPL-3.0-or-later).
- **Bundled music is separate.** The music is third-party **CC BY 4.0** (Kevin MacLeod), not GPL, and carries its own attribution (`ASSETS.md`, generated from `assets.json`). Keep the two licences physically apart: assets live in `public/` and `assets-src/`, the game in `src/`. `npm run licensecheck` admits only CC0, CC BY, CC BY-SA, OFL, MIT and Apache-2.0 assets, and rejects NC and ND.

---

## 18. Milestones

| # | Milestone | Contents |
|---|---|---|
| M0 | Scaffold | Project structure, shared types, fixed-timestep sim skeleton, tunable config module |
| M1 | Driving feel | One car, one test arena, arcade physics, chase camera — **must feel good before anything else** |
| M2 | Netcode | Authoritative server, prediction + smoothed reconciliation, two clients in sync |
| M3 | **Art foundation** | **Vehicle as a modular part graph + one designed symmetric arena** (see below) |
| M4 | Crews | Multi-seat interiors, lobby seat selection, per-seat cameras, window arcs |
| M5 | Guns | Personal weapons, hitscan + projectiles, reticle-ray aiming, magazine reloads, lag compensation |
| M6 | Damage | Hull + component health, crew downing, driver protection, repair crates, visual degradation |
| M7 | Match modes | Duel 2v2/4v4 respawn TDM (clock + kill target) **and** one-man-team last-car-standing (§2.3, no clock, closing zone); scoring, lobby, results, rematch |
| M8 | Bots | Driver + gunner AI, lobby fill, practice |
| M9 | Polish | Positional audio, HUD, juice, art **fidelity** |
| M10 | BR groundwork | Interest management, spatial partitioning, large zoned map *(phase 2)* |
| M11 | BR mode | One life, danger zone, salvage, placement scoring, scale to ~30 cars |
| M12 | Cosmetics | Part-swap cosmetics, shop, earnable cosmetics |
| M13 | Accounts | Persistent stats, progression, match history *(later)* |
| M14 | **Onboarding** | The **interactive tutorial** (drive, shoot, repair) + a bot-filled practice match — **deferred here deliberately** (§16) |

**v1 vertical slice = M0 → M9:** 2v2 and 4v4 duels, one arena each, the complete driving/gunnery/damage/repair loop, bots, lobby, ping system, room codes + quick match.

**Tutorial timing.** The interactive tutorial is **not** in the vertical slice: the systems it teaches (repair, component targeting, crew blind sides) are still moving, and a tutorial written against a moving target is rework. It sits at M14, after the modes and the art have settled, with first-match **tips** (§16) covering the gap.

### M3 in detail — and why art is not one milestone

Visual work is deliberately split, because "upgrade the art" bundles two unrelated things:

- **Art *foundation* (M3, early, structural).** The vehicle mesh is refactored into a **part graph whose names mirror the simulation's modules** — `chassis`, `wheel.*`, `engine`, `seat.driver`, `seat.frontRight`, `seat.rearLeft`, `seat.rearRight`. Each part gets a real mount point and named sockets (`eye` for per-seat cameras, `firePort` for weapon origins, `decal.*` for cosmetics), and the arena becomes a designed symmetric layout. This is a *dependency*, not decoration: M4 needs seats and camera anchors to exist, M5 needs real weapon origins at the windows, M6 needs wheels/engine as separate sub-meshes so they can degrade independently, and M12 swaps parts that must first be separate objects. Leaving this to the end would mean rebuilding M4–M6 and then doing it all again.
- **Art *fidelity* (M9, late).** Materials, lighting, VFX, decals, detail. This genuinely is polish, and belongs at the end.

**Arena *layout* is not art at all.** M3 gives the arena a designed, symmetric *shape*; the real competitive layouts are tuned at **M7 (duel modes)** against finalised speed, window arcs, and pickup numbers. Because arenas are data files (§13.6), new maps are cheap content once the systems exist rather than engine work.

**Arenas and authored meshes.** Vehicles and arenas are *not* the same problem. A vehicle is self-contained, so a mesh can replace the geometry outright. The arena is read by the simulation: collision and ground height come from `SOLIDS` via closed-form queries, which is what keeps prediction cheap and deterministic.

So arenas would eventually be a **visual mesh plus separate collision solids** — the standard split, and the same one props would use. Authored `.glb` for the look, solids for the physics, with the collision either authored alongside or derived from named volumes in the file. True mesh collision (BVH over triangles) is possible, but it is heavier per query and adds a large surface where client and server could disagree, so it is not worth it unless a map genuinely needs non-box geometry to be driveable.

---

## 19. Explicitly Out of Scope for v1

**Out:** battle royale, built-in voice chat, accounts, progression, the cosmetic shop, skill-based matchmaking, observer/broadcast mode, additional arenas beyond the duel pair, functional customisation, mobile/touch, localisation, mixed crew-size playlists.

**In:** 2v2 and 4v4 duel modes, the full core loop, bots, the tutorial, the lobby, the ping system, room codes + quick match, and the accessibility baseline.

Shipping a tight, excellent game beats shipping a broad, mediocre one. Everything out of v1 has a milestone where it lands.
