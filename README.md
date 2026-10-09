# CONVOY

A browser-based post-apocalyptic **crewed vehicular battle royale**. Your car is your team: one player drives, the others man separate gun stations, and everyone outside your chassis is an enemy.

Full design: [`DESIGN.md`](./DESIGN.md).
Working state, open issues and next actions: [`STATE.md`](./STATE.md) — **read that
first if you are picking this up cold.**

## Status

| Milestone | Scope | State |
|---|---|---|
| **M0** | Scaffold, shared deterministic simulation, tunable config | ✅ done |
| **M1** | Driving feel — one car, test arena, arcade physics, chase camera | ✅ done |
| **M2** | Authoritative server, client prediction + smoothed reconciliation | ✅ done |
| **M3** | **Art foundation** — vehicle part graph + one designed symmetric arena | ✅ done |
| **M4** | Crews — seat assignment, driver-only input authority, per-seat cameras, window arcs | ✅ done |
| **M5** | Guns — hitscan + projectiles, reticle aiming, reloads, lag compensation | ✅ done |
| **M6** | Damage — component health, driver protection, hazards, repair crates | ✅ done |
| **M7** | Match modes — duel 2v2/4v4 respawn TDM **and** one-man-team last-car-standing | ✅ done |
| **M8** | Bots — lobby fill (one-man mode) and a drive-and-shoot AI | ✅ done |
| **M9** | Polish — positional audio, HUD/juice, art fidelity | ✅ done |
| **M10** | BR groundwork — spatial partitioning + interest management | ✅ done |
| **M11** | BR mode — 800 m zoned map, 30-car field, wreck salvage, placement board | ✅ done |
| **M12** | Cosmetics — part-swap paint/wheels/roof kits, earnable unlocks, cosmetic-only garage; first authored map pass (mesa, crane, roads) | ✅ done |

Art *fidelity* — materials, lighting, VFX — is M9, now a first pass (image-based
lighting, clearcoat paint, soft shadows, instanced VFX); real authored art is the
remaining gap. M12 is the first *content* on that structure: procedural part
swaps (paint finishes, wheel styles, roof kits) with no art pipeline yet. M3 built the *structure*: a vehicle part graph and a generated
symmetric arena. See `DESIGN.md` §18, and [`STATE.md`](./STATE.md) for what is in
flight and what is parked. The **interactive tutorial** is deferred to M14.

**What works right now:** drivable cars in an 800 m zoned arena with arcade handling, drifting, ramps, boost and a chase camera — running on an **authoritative server**, with client-side prediction so your own car responds instantly, and interpolated remote cars. Crews share one car: a driver who is *not* armed, and gunners who fire out of their own window, each with its own arc of fire. Three weapons (rifle, marksman, launcher) with magazines, reloads, hitscan and gravity-driven projectiles, crew downing and vehicle destruction.

It is a **match now, not a sandbox**: teams spawn on opposite sides of the ring, a match runs lobby → countdown → live → results, kills score, and a one-click rematch is in the HUD. Two modes share all of it:

- **Duel** — two crews, 2v2 (coupe) or 4v4 (SUV), respawn team deathmatch. The driver is unarmed and protected; gunners fire personal weapons from their windows.
- **One-man teams** — every player is their own team in a retrofitted **brawler** whose guns are built into the car. The driver drives and shoots at once (the car is the weapon). One life, **last car standing**. Thirty cars to begin, and a destroyed car leaves
**wreck salvage** — a temporary repair pile where it died, so winning a fight
pays. The 800 m map has zones to fight through and, since M12, real verticality:
a drivable mesa to hold, a scrapyard crane to navigate by, and roads to run.

The same seat model drives both: a seat says whether it `drives` and whether it has a fire `arc`, and whether its weapons are built into the car. A duel driver drives without firing; a duel gunner fires without driving; the brawler does both. That is what keeps a crewed "driver + shooters" future a data change rather than a rewrite.

Damage is **components, not just a health bar**: shots into a wheel take the wheel off and slow the car, a wrecked side drags it into a turn, and a dead engine leaves it limping. A hit on a part damages the part and *not* the hull, so aiming is a decision — strip the tyres to stop the escape, or go for the kill. Damaged cars smoke, broken wheels lock and wobble. A hull is repaired only at a **repair crate**, by holding position beside it for several seconds, which is the most exposed thing a crew can choose to do. Hazard ground costs hull but can never finish you. Open a second browser tab and both players appear in the same arena.

**Guns are not mounted on the car.** A gunner occupies a seat inside and fires a *personal* weapon through the window. That single decision is what makes the crew work: the driver's job is to present the armed side, and the arcs are narrow enough that this is a skill rather than a formality (`DESIGN.md` §3.2, §7).

## Running it

```bash
npm install
npm run dev
```

That starts **two processes** under one command:

| Process | Port | What it is |
|---|---|---|
| game server | `8787` | the authoritative simulation (`ws://localhost:8787/ws`) |
| vite | `5173` | the client, which proxies `/ws` to the game server |

Open **http://localhost:5173**. The page opens a **JOIN LOBBY** menu — joining is
**explicit**, not automatic, so loading the page never drops you into a live
match. Press the button, then click the canvas to capture the mouse.

**To play a duel:** open a second tab (or a second browser) at the same URL. Each tab is a separate player, and the room places them on opposite teams. With a player on each team the lobby counts down and the match starts; one tab alone waits in the lobby, because a duel needs both sides.

**To play the one-man-team mode:**

```bash
MODE=solo npm run dev
```

Every tab is its own team in a retrofitted brawler: **drive with WASD, aim with the mouse, fire with the left button — all at once.** One life, last car standing. **Bots fill the field** (`BOTS=fill` is the default in solo), so one tab is a full match; a human joining the lobby takes a bot's seat.

`SOLO_CARS=16 npm run dev` raises the field; `BOTS=off npm run dev` makes it human-only; `BOTS=4` fills to four cars.

> The game server defaults to **8787, not 8080** — 8080 is very commonly taken (Docker held it on this machine) and the server would otherwise fail to bind. Both ports are configurable: `PORT=9000` for the server, `GAME_SERVER=http://localhost:9000` for the Vite proxy.

| Input | Action |
|---|---|
| `W` / `S` | throttle · brake / reverse |
| `A` / `D` | steer |
| `Space` | handbrake (drift) |
| `Shift` | boost |
| mouse | look around |
| left mouse | fire (hold for automatics) |
| `R` | reload |
| `1` `2` `3` | select weapon slot |
| `M` | mute audio (SFX + music) |

## Running it in production

There is a real deployment shape, and it needs **no code change** — the server
serves the built client and the socket from one origin, so the client's
`${location.host}/ws` just works behind a domain:

```bash
npm run build      # client → dist/  ·  server bundle → dist-server/
MODE=solo ALLOWED_ORIGINS=https://your.domain npm start
```

The server then serves `dist/`, `/ws` and `GET /healthz` on `PORT` (default
8787). `npm start` runs the **pre-bundled** server, so no TypeScript toolchain is
needed at runtime.

The multi-stage `Dockerfile` packages exactly this on a **distroless, non-root**
Node 24 base: the server is bundled to one JS file whose only bare import is
`ws`, and the build **asserts** that — so adding a hidden server dependency fails
the build instead of the container. `DEPLOY.md` is the full plan: DigitalOcean
App Platform vs a Droplet + Caddy, the environment reference, the scaling path
from one room to many, and a first-deploy checklist.

**Nothing is deployed by the project and no deploy happens automatically.** This
section is how you *would* run it when you choose to, and what to watch out for
(`DEV_*` flags off, a session token before any public launch).

## Verifying the simulation

```bash
npm run simcheck
```

The shared simulation is the one part of this project that **must** be correct: the server runs this exact code as the authority, so a bug here is a desync rather than a visual glitch. `simcheck` exercises handling without a browser and asserts the properties that matter — acceleration, top speed, drift, ramp launches, wall collision, boost behaviour, and **bit-identical determinism across runs**.

### Simulating a bad network

localhost is a network that does not exist: 1 ms latency, perfect ordering, zero
loss. The netcode is designed for conditions it never sees there, so it can be
reproduced from the URL:

```
http://localhost:5173/?lag=150&jitter=50&loss=0.05
```

| Param | Meaning |
|---|---|
| `lag` | one-way delay in ms (RTT is roughly 2×) |
| `jitter` | ± random variance per message, in ms |
| `loss` | fraction of messages dropped, 0–1 |

Delivery is held **monotonic** per direction, because WebSocket runs over TCP and
messages genuinely cannot arrive out of order — jitter therefore accumulates as
head-of-line delay, which is what actually happens on a jittery TCP link. `loss`
drops messages outright, which models the UDP transport planned for battle royale
rather than the socket underneath.

While conditioning is active the HUD status reads `in game (simulated network)`
so a bad measurement is never mistaken for a bad build.

#### Reading the network HUD

| Field | Meaning |
|---|---|
| `PING` | round trip |
| `JITTER` | mean change between recent ping samples — the number that actually predicts stutter |
| `LATENCY` | one-way (≈ ping/2): what your input and the server's state each pay |
| `WORLD LAG` | one-way **+ the interpolation delay**. How old the world you are looking at is |

#### Backgrounded tabs

Browsers throttle a background tab's animation frames to roughly 1 Hz, which used
to mean a player who alt-tabbed kept driving at full throttle with nobody
watching, and then saw the world lurch when they returned. Handled in three
places: the client sends a neutral input and re-seeds its interpolation clock on
return, the frame loop refuses to replay a long stall, and — most importantly —
the server applies **neutral input after 500 ms of silence** (`inputTimeoutMs`),
so a client can never leave its car driving unattended.

Separately, `clientTimeoutMs` reclaims the *slot*. A half-open connection never
fires `close`, so without a liveness check a killed browser lingered as a ghost
player — which showed up in the HUD as "2 players" with one client open.

**Liveness is proven at the SOCKET level, not by app messages.** The server sends
a WebSocket `ping` every few seconds, and the browser answers it in its *network*
stack — which keeps working when a tab is throttled or frozen, unlike page JS. So
a player who switches tabs keeps their seat instead of being reaped as dead;
only a socket that genuinely stops answering is dropped. Reaping on app silence
was the bug: a tab switch looked exactly like a dead connection.

### Verifying prediction (headless)

```bash
npm run netheadless                  # 0 ms
LATENCY=80 npm run netheadless       # 160 ms RTT
```

Reproduces the client's reconciliation **with no browser at all** — same shared
simulation, same replay, same correction decay — and reports the worst correction
against one tick of travel. Typical: **0.06 m against a 0.67 m tick, i.e. ~9%**,
and it holds at 160 ms RTT.

This exists because the browser tests are too noisy for tight bounds. Under
software rendering a page can reload under GPU pressure *mid-run*, wiping the
very diagnostics being read — which showed up as a per-reconcile delta of exactly
zero alongside a 6 m correction, a combination that is impossible. Testing each
layer where it can be tested reliably is the fix: the browser test keeps a loose
tripwire (it would still catch the 10–16 m pre-admission bug), and the tight
bound lives here.

### Verifying the netcode

```bash
npm run nettest
```

This is a genuine end-to-end test. It **spawns the server and the client itself**, opens **two independent browsers**, drives both, and checks that each sees the other, that remote cars move via interpolation, and — the important one — that **prediction agrees with the server**.

It covers four scenarios: two clean clients, prediction accuracy while driving, a
**simulated bad network**, and a client that goes silent (raw sockets, no browser)
to prove the server-side silence timeout.

The headline metric is the residual correction after replaying unacknowledged
inputs. Because both sides run the same deterministic simulation it should stay
near zero, and the test bounds it against **one tick of travel** rather than
against time: corrections are measured in metres, and metres-per-tick scales with
speed, so comparing raw error over a run where the cars are accelerating would
report growth that isn't divergence.

| Scenario | Typical residual |
|---|---|
| localhost | ~0.006 m at 23 m/s (one tick = 0.38 m) |
| `lag=150 jitter=50` | ~0.45 m at 21 m/s (one tick = 0.34 m) |

Two traps worth remembering, both of which produced **false netcode failures**
during development:

- **One browser instance per client.** Two pages in one browser means one is a
  background tab, and browsers throttle those to ~1 Hz — which starves the
  simulation loop, so the car barely moves and pings never fire.
- **Every spawn point must be clear of geometry.** Two spawns were buried inside
  the side launch ramps. A car placed there cannot drive out, and because client
  *and* server agreed it wasn't moving, it presented as a netcode bug rather than
  a level-design one. `simcheck` test 17 now asserts every spawn is clear.
- **Raw test sockets must ping.** A test client that says nothing is reaped as a
  dead connection — correct behaviour, but it freezes an observer's view
  mid-test and reports stale state. `openRaw` keeps a real client's ping cadence
  by default; the ghost-client test opts out deliberately.

### Verifying combat

```bash
npm run combattest
```

Spawns the server with dev seat assignment, joins two raw sockets into different
crews, and shoots across the arena. It covers the rules that a player would
otherwise only discover by being cheated: the **rate limit** (ten trigger pulls
in 300 ms produce one shot from a 9/s rifle), **magazine depletion and
auto-reload**, **manual reload**, that a **driver cannot fire** and a **shot
clamped outside the window arc cannot reach its target**, that hits **reduce
hull** by whole multiples of the weapon's damage, that **lag compensation
rewinds** to where the target actually was, and that **reticle-ray aiming** puts
the shot where the crosshair is.

Geometry is computed, not hard-coded: the muzzle comes from the same shared
helper the server uses, and the aim is derived from the authoritative snapshot,
so changing a seat mount or a vehicle's dimensions cannot silently invalidate
the test.

This suite earned its place immediately. It found that **aimed shots never
landed**: the muzzle sits inside the shooter's own collision box, so the
shooter's car was hit at distance zero, truncating the ray before it reached
anything, and every shot was silently absorbed by the gun that fired it. Nothing
about that is visible from a screenshot of a muzzle flash; it was only obvious
once something asserted that a bullet aimed at a car does damage.

### Verifying a match

```bash
npm run matchtest
```

Two halves, because "the rules are right" and "the room runs the rules" are
different claims. The first is the pure state machine in `shared/match.ts` — a
fast, deterministic place to prove the awkward cases: a kill scored in the wrong
phase counts for nothing, a tied regulation opens sudden death, sudden death
expiring still tied is a draw. The second spawns a real server, joins two real
sockets, runs the clock at seconds instead of minutes, and watches the room
actually go lobby → countdown → live → results → rematch — including that input
during the countdown does not move a car, that a destroyed crew scores for its
killer and respawns together, and that the board resets on a rematch while the
crews stay together.

The room half scores through a **dev-only kill hook** (`devKill`, gated behind
the same `DEV_ASSIGN` flag as crew/seat selection) rather than a twenty-second
shooting phase: a test that spends its runtime grinding hull is a test that gets
deleted the first time it is slow. Combat itself is `combattest`.

The match clock is overridable from the environment so tests never wait out
production numbers: `MATCH_COUNTDOWN_SECONDS`, `MATCH_TIME_SECONDS`,
`MATCH_SUDDEN_DEATH_SECONDS`, `MATCH_RESULTS_SECONDS`, `MATCH_RESPAWN_SECONDS`,
`MATCH_KILL_TARGET`, `MATCH_MIN_TEAM_PLAYERS`. `MATCH_FORCE_LIVE=1` pins a room
to live with no clock, which is how the netcode and combat harnesses opt out of
the lobby they are not testing.

### Duel matches

A **team is a crew**: one vehicle per team, and always exactly two teams
(`DESIGN.md` §2). Crew size never mixes, so 2v2 is two coupes and 4v4 is two
SUVs, and `CREW_SIZE` (or the first client, in dev) decides which.

| | |
|---|---|
| **Lobby** | waits until both teams have a player; no bots yet (M8), so one player per side is enough |
| **Countdown** | the field resets and cars are frozen; a team emptying out drops back to the lobby |
| **Live** | driving and shooting; kills score for the killer's team |
| **Results** | outcome, reason, final score, and a rematch vote; the room falls back to the lobby if nobody votes |
| **Rematch** | everyone voting starts the next match with crews and seats kept together |

The **kill target** (15 for a coupe, 25 for an SUV) is an early-win / mercy
condition, not the normal ending: with the deliberate slow TTK the **12-minute
clock** is what usually ends a match, and a tie at the whistle opens **sudden
death** — next kill wins. A destroyed crew waits out a short delay and respawns
**together** at its team spawn; the whole crew is out for that moment, which is
what gives a kill weight without ending anyone's match.

Two clocks, deliberately different. Target interpolation uses the wall clock
(`Date.now()`), because snapshots are stamped for cross-player timing. The match
clock uses the **monotonic** clock (`performance.now()`), because a system time
change must not skip a match forward. Only the *remaining milliseconds* cross the
wire, so the two clocks never need to agree.

### One-man teams — the car is the weapon

`MODE=solo` runs a field of one-man teams (`DESIGN.md` §2.3). Each player is
alone in a **brawler**, a civilian car retrofitted with built-in guns, and drives
and shoots at the same time. **One life: last car standing wins.**

There is **no clock** — the match ends when one car is left, and a **closing
danger zone** guarantees it gets there. (A duel keeps its 12-minute regulation,
because respawn TDM would otherwise never stop.)

### The closing danger zone

A circular safe area that **holds, then shrinks**, five times, from 150 m down to
18 m. Outside it you take hull damage that grows every phase — and unlike a
hazard, the zone **can destroy a car**. That is its job: it forces the last few
survivors together instead of letting them circle an 800 m arena forever.

**The endgame is not scripted.** Each new circle drifts to a random centre that
sits entirely inside the previous one, so you can commit to a position and watch
the final fight move somewhere else. Two matches do not end in the same place.
The schedule is pure and seeded (`shared/zone.ts`): the server builds the plan
once at the whistle, and a seed makes it reproducible for tests.

The server applies the damage and puts the current circle in every snapshot; the
client only draws it (a ground ring) and warns you — an `OUTSIDE ZONE` readout and
a red vignette — when your car is on the wrong side of it.

### Sound

Audio is **entirely procedural** (`client/audio.ts`) — oscillators and one noise
buffer, no asset files — and treated as a gameplay system, not decoration
(`DESIGN.md` §8). The listener rides the camera, so:

- **Gunfire is positional.** Yours is centred and loud; everyone else's is placed
  in the world, so you can tell where a shot came from. A global rate limit stops
  a 16-car brawl from stacking thirty voices.
- **The engine note is a read-out** — pitch and volume follow your speed and
  throttle, so "am I actually moving?" has an answer you can hear.
- **Explosions and impacts** have weight: a filtered noise burst plus a dropping
  sub, placed in the world, with a thud when *your* hull drops and a blip on a
  confirmed hit.
- **The closing zone nags** with a tremolo tone while you are outside it.

Browsers will not start audio before a gesture, so the graph is created on the
**JOIN LOBBY** click. `M` mutes. Nothing is heard in a headless probe, but the
graph is checked to start (`state: running`) and to run without throwing while
driving, firing and exploding.

**Camera shake** goes with it: a kick per shot, a thud when you take a hit, and a
shove from a nearby explosion that falls off with distance. Small, decaying, and
never on a long-range kill.

### Music

The lobby has a **playlist** (`public/audio/music/playlist.json`) that loops
tracks in order and **ducks to silence while a match is live** — it is lobby
music, not a soundtrack to the firefight.

Sound starts **off**, because a browser will not play anything before a gesture,
so the menu carries a **SOUND** button: click it and the playlist starts *while
you are still on the join screen*. Joining carries the music into the lobby, and
`M` mutes music and effects together.

The tracks are **third-party** (Kevin MacLeod, **CC BY 4.0**), and separate from
the game's GPL-3 licence — two playlists, a lobby set and a quiet in-match bed
that rises as the zone closes. They are played unmodified, with attribution in
[`ASSETS.md`](./ASSETS.md) and on the title screen's **CREDITS**, both generated
from `assets.json` by `npm run licensecheck`. That check rejects **NC** and **ND**
licences and any asset without a licence record.

### Damage feedback

- **A damage number** pops where each of your hits lands (projected from the
  impact point), so you can see *how much*, next to the hitmarker that says you
  connected at all.
- **A direction arrow** swings around the crosshair to point at whoever just hit
  your car, relative to where you are looking.
- **A red edge** builds as your hull runs low, so "I am nearly dead" is felt
  rather than read off a number.
- Plus the hitmarker on a confirmed hit, the **kill feed**, and the **camera
  shake** described above.

**First-match tips** (once per tab) walk you in: the controls when the match goes
live, a warning when the ring first closes, and one the first time you are
outside it. The fuller interactive tutorial is **deferred to M14** (`DESIGN.md`
§16/§18) — it teaches systems that are still moving, so it is written once they
settle.

### Results and the placement board

A match is scored by **placement and kills**. When it ends, the banner names the
outcome and your placing (`placed #k/30 · n kills · winner car m`), and a board
lists everyone's placing and kills, best first, with your row highlighted. The
board is sent whole — it is a few numbers per car, and a scoreboard that only
showed the cars near you would be wrong.

A **one-tick wipe is a draw**: if the zone kills the whole field at once, nobody
wins. (It used to crown whoever was processed last as the field died.)

### Being eliminated, and reading the fight

A destroyed car **explodes**: a flash, a burst of fire, a rising smoke column and
a ground shock ring at the wreck's last position, with a brief light. The car used
to simply vanish, which reads as a bug rather than a kill. The effect is cosmetic
and client-side — the server decides the death, the client just shows it — and it
fires once on each alive→dead edge, for your car and every remote you can see.

It is **instanced**: fire and smoke are two meshes driven by a small billboard
shader, so the whole particle field — any number of particles, any number of
simultaneous deaths — is **two draw calls**. The first version used one sprite
per particle and cost ~47.

One life means you spend the endgame watching, so elimination is a **spectator
mode**, not a dead end: your wreck is hidden, the camera follows a surviving car
(cycling every few seconds), and the banner reads `SPECTATING · car n · you placed
#k`. A **kill feed** lists destructions — `car 3 eliminated car 5`, and `ZONE
eliminated car 2` for a kill nothing scored. The results screen names the winner
and your placing.

Mechanically it is the *same* systems as a duel, which is what makes it cheap and
leaves the crewed future open:

- **A seat declares capability, not a role.** `drives` and an `arc` are
  independent flags. A duel driver drives without an arc; a duel gunner has an
  arc and no wheel; the brawler's single seat sets both. `seatCapability()` names
  the result, so nothing has to special-case "driver" as "unarmed".
- **A seat may carry its own weapons.** A seat with `mounted` guns defines the
  occupant's loadout (the brawler: rifle and launcher, on the car); a seat
  without them falls back to the personal window weapon. The client derives the
  same loadout from the shared seat data, so the two sides cannot disagree.
- **The driver stays protected.** The "cannot be shot out" rule keys off `drives`
  now, so the brawler dies with the car — the car **is** the team.

The camera is the one genuinely new piece. A chase camera looks **at** the car,
so its screen centre is the car — useless for aiming (the reason gunners got a
window camera). A window camera hides the car you are driving. The solo camera is
a third thing: it sits behind and above and looks **forward** along the gun, so
the car sits in the lower frame and the crosshair is the world. It is rigid, not
damped, because a lagging crosshair is a crosshair that lies.

Elimination is checked every tick rather than only on a kill, so a player
disconnecting and taking their car with them also ends a match that leaves one
survivor. Placements are recorded as "how many cars were still running when this
one died", so the first car out of eight places eighth.

### Bots

Bots are **occupants, not clients**. A bot is the same record a human player
uses, with `socket: null` — it holds a seat, is simulated, appears in snapshots,
can be hit, and fires through the exact same code path a human's shot takes. That
single decision is why a bot cannot do anything a player could not: it has no
privileged API, so every weapon rule (arc, rate, magazine, reload) still binds
it. A bot is a player with a different source of intent.

**Lobby fill** is the first job (`DESIGN.md` §12.4). Bots fill empty teams in the
lobby; a human joining takes a bot's seat rather than being turned away; bots are
never added to or removed from a **live** match, so no AI decides a live result;
and the rematch quorum counts humans only, or a bot-filled field could never
rematch. A room with no humans does not start a match at all — an idle server
waits instead of playing to an empty house.

The **brain** (`src/server/bot.ts`) first chooses what to **drive at**, in
priority order: **hurt → run for repair; an enemy inside `engageRadius` →
engage; otherwise → roam.** That last case is what keeps a 30-car field from
collapsing into one brawl — a bot with nobody near patrols around the safe centre
on its own bearing instead of beelining the globally nearest enemy it cannot even
see. A damaged bot (below `retreatHull`) breaks off to the nearest crate or wreck
salvage and **holds still** there, because repair needs a near-stationary car.

Once it has a drive goal it aims with the same muzzle geometry the player uses and
fires when the line is clear, steering around walls with a short forward probe
plus a left/right comparison when blocked. The one non-obvious rule is the
steering sign — positive steer turns *right* while increasing yaw turns *left* —
so the command is the negated heading error. Get it wrong and the bot drives away
from everything, which reads as "passive" rather than broken.

```bash
npm run bottest
```

Covers the brain on a flat arena (so the answers are about steering and firing,
not the map's cover) and a real `BOTS=fill` match with one human, proving bots
occupy seats, drive, and shoot.

Bots **miss like people**: a short reaction delay on a new target, burst fire
rather than a laser, and a tracking wobble summed from two out-of-phase sines.
Those are bot-only knobs — weapon damage is untouched, so a *human's* time-to-kill
is unchanged. Narrowing the brawler's arc to ±135° is documented with the mode.

Bots **drive**, not just aim. Four things make that work, and each fixed a real
failure:

- **Steering picks a heading with room** — one whisker ray if straight at the goal
  is clear, a 13-ray fan if it is not — with the lookahead scaling with speed (a
  fixed 16 m is a quarter-second of warning at 40 m/s). The rays measure the car's
  **width**, not its centreline, so it stops clipping corners with a flank.
- **Speed is a function of room, not of the target.** The clear distance sets a
  speed budget and the throttle follows it, so a bot brakes *before* a corner
  instead of arriving too fast — then **orbits** in range rather than parking
  nose-to-nose, drifting when the heading change is sharp.
- **Steering is smoothed**, so the wheel is turned rather than slammed to full
  lock.
- **Detours are committed.** When blocked, the bot holds the detour heading for
  half a second instead of re-aiming at the target every tick (which made it turn
  away, re-see the target, turn back and grind the corner), and **reverses out**
  if it still is not moving.

`bottest` drives one through the real arena's cover to a waypoint, checks it
never wedges for more than a second (the "is it stuck" number, as opposed to brief
braking at the goal), and noses another into a block to prove it goes around and
reaches the target behind it.

Bots are also **zone-aware**: near the edge of the safe circle they bend back
toward the centre, and once outside they commit to driving in (and stop
handbraking) while still able to shoot over their shoulder. A bot that ignores
the zone is not an opponent, it is a free kill that dies to the timer while you
watch.

Difficulty is a profile — `BOT_SKILL=easy|normal|hard`, **defaulting to hard**
while bots are the only opponents — that scales **two** skills, because a bot is
both a driver and a gunner:

- **Marksmanship** — reaction time, aim wobble, burst pause.
- **Driving** — steering authority and wander, how readily it dares the
  handbrake, how well it holds a fighting distance, and how early it reacts to
  walls and the closing zone.

It touches **nothing** else: not damage, not weapon range, not top speed. A hard
bot is not using a better gun — it drives and shoots better with the same car.

```bash
npm run solobench
```

A tuning diagnostic (not a test): it runs real bot matches with an idle observer
and prints match length, time to first kill, eliminations and accuracy. It is how
"the field feels like a brawl, not a battle royale" was turned into a number:
roaming and repair-seeking took a 30-car match from **70.9 s to 157.2 s**, after a
standoff-range tweak had done nothing (71→77 s).

Target selection **finishes the wounded**: a bot starts from the nearest enemy
but prefers a damaged one within a short window, so it commits to a kill instead
of switching to whoever is closest. Cover use, coordinated focus-fire and bot
crews in duels are **not** done — see `STATE.md` §8.

### Damage, and what it does to the car

Hull HP is the **kill** condition. Components **disable**. The difference is the
whole design (`DESIGN.md` §4): a car with a dead engine is not a dead car, it is
a car that can no longer leave, and choosing between those outcomes is the
decision a shooter gets to make.

| Part | When it dies |
|---|---|
| **Hull** | the vehicle is destroyed, crew included |
| **Engine** | no boost, a fifth of the power, 40% of the top speed — it limps |
| **A wheel** | loses traction and drive; a wrecked *side* drags the car toward it |

A shot that lands on a part damages **the part and not the hull**. That is what
makes aiming a real trade rather than a formality: shooting a tyre costs you the
kill, so you do it to stop an escape, not because it is free.

Components live **inside** the simulation (`VehicleState.components`) while hull
lives beside it. That is deliberate, not untidy: components change how the car
*moves*, so the client has to predict with them or a damaged car is predicted as
a healthy one and every reconcile fights it. Hull affects nothing about motion,
so the simulation never sees it.

### Ramming each other

Cars are **oriented boxes** in the simulation, not points. Two consequences that
were bugs until this was true:

- **A flank cannot sit inside a wall.** The car used to be three circles down its
  centreline, which rounded the corners and sized the body to a circle — a car
  could put its side through cover. Walls now use the same box (via the
  separating-axis theorem) as everything else, so the shape that collides is the
  shape you can see.
- **Cars hit each other.** A car-on-car contact is a property of a *pair*, so it
  cannot live in the single-car step: the server resolves all pairs after moving
  every crew. Contact separates them and the ram damage is split by **angle**, not
  evenly — a nose into a door costs the door far more than the nose, while a
  head-on trade is symmetric. Both cars always take *some*, and ramming feeds the
  boost meter (`DESIGN.md` §3.1).

Like crew hits, a ram is **server-authoritative and not predicted**: it depends on
both cars' state, which a client does not know. The local car is corrected into
the result rather than predicting it. `simcheck` asserts the box has no residual
penetration and that head-on / flank / rear-end splits come out the right way.

**Recovery is a crate, and only a crate.** There is no passive regeneration
(`DESIGN.md` §4.3). A repair crate heals hull and components over several seconds
*while the vehicle holds position* inside a small radius — so repairing is the
most exposed thing a crew can choose to do, and the crate itself is finite and
worth fighting over. Hazard ground costs hull over time instead, but can never
finish a vehicle: one driver's mistake must not wipe a four-person crew.

### Aiming & the two cameras

A gunner gets a **window camera**, not a chase camera. They are not variations on
a theme — they answer different questions:

| | Chase camera (driver) | Window camera (gunner) |
|---|---|---|
| It is a view | **of** the car | **from** the car |
| Anchored to | the car's centre | that gunner's own window |
| The camera looks | at the car | along your aim |
| The centre of the screen is | your car | what you are shooting at |

Anchoring a gunner's view to the *car* is wrong for two reasons. A crosshair
drawn on the centre of the screen then sits on your own roof — measurable, not a
matter of taste: `node scripts/reticleprobe.mjs` reports what is under the
crosshair, and it used to answer *your own chassis, 8.8 m away*. And every seat
shares one perspective, so a four-crew SUV would be three gunners looking at the
same picture and only the arc would differ.

So a gunner's camera is anchored to a point at their window, just outside the
bodywork (`WINDOW_EYE_OFFSET`), rotating with the car. The car holds still in the
frame and only the gaze moves — which is what leaning out of a window means, and
what makes a front-right gunner and a rear-left gunner genuinely different
players. It is rigid rather than smoothed: a head in a window moves with the car,
and smoothing would slide the camera off its own window in every corner.

The shot is then **parallax-corrected** (`DESIGN.md` §7). The crosshair defines a
ray from the camera; the weapon is in a window 0.6 m away from it. The client
resolves that ray against the world and points the muzzle at whatever it found.
Firing straight down the camera's direction instead is off by **0.57 m** — a
quarter of a car's width — at *every* range, because the two rays are parallel
rather than converging. The corrected shot lands within 0.15 m of the crosshair.

The correction is clamped to the window's arc last. Near the edge of the arc the
crosshair points somewhere the weapon cannot physically reach, and the arc wins —
the car body is supposed to block that shot.

**Look pitch is one convention across all three cameras.** Positive input means
the player moved the mouse *down*, and every camera pitches down. The chase
camera achieves that by rising to look down at the car; the window and solo
cameras look *along* the aim and so negate the pitch. A mismatch here is
invisible in the chase camera and inverted in the others — which is exactly how
it went unnoticed until driving and gunning became the same seat.

### Seeing it render

```bash
npm run shot                                             # one frame, idle
OUT=shots/drive.png KEYS=w DRIVE_MS=3500 npm run shot    # drive, then capture
OUT=shots/drift.png KEYS=w,a,Space DRIVE_MS=2600 npm run shot
```

Runs headless Chromium (via Playwright), captures a screenshot, and dumps console
output plus the live HUD values. WebGL comes from SwiftShader — headless Chrome
has no GPU — so it is slower than a real machine but fully functional.

This is how rendering gets verified without a desktop browser attached: it is
what caught the scene rendering almost entirely black, a palette that made ramps
glow white, and a removed three.js shadow-map constant.

## Architecture

```
src/shared/     ← pure simulation. No DOM, no renderer, no clock, no randomness.
  config.ts       every tuning number, in one place
  math.ts         vector maths
  arena.ts        solids as boxes and ramps; closed-form surface queries
  vehicle.ts      the arcade car model
  components.ts   component health, and how damage degrades the car
  crews.ts        seats, window arcs, eye/firePort/window mount points
  weapons.ts      weapon definitions, magazines, fire intervals
  combat.ts       muzzle geometry, ray tests, damage — shared by BOTH sides
  repair.ts       whether a car may repair at a crate
  match.ts        the match state machine: phases, score, clock, last-standing
  zone.ts         the closing danger zone schedule (pure, seeded)
  grid.ts         uniform spatial hash — an index over state, not simulation
  cosmetics.ts    paint/wheel/roof catalogues, unlock rules, look packing
  protocol.ts     the wire format between client and server
  assetSpec.ts    the asset contract (budgets, sockets, naming)
src/server/     ← the authority. Imports the simulation, never renders.
  server.ts       transport + static hosting + /healthz; no game logic
  room.ts         players, the fixed-tick loop, input validation, snapshots
  bot.ts          the AI brain — server-only, never sent or predicted
src/client/     ← prediction, rendering and input
  main.ts         entry point and fixed-timestep loop
  net.ts          prediction, reconciliation, remote interpolation
  netCondition.ts simulated latency / jitter / loss
  buildArena.ts   arena data → meshes
  buildZone.ts    the danger-zone ring
  camera.ts       the two cameras: chase (driver), window (gunner)
  input.ts        keyboard/mouse → abstract actions
  hud.ts          HUD bindings
  garage.ts       the cosmetics picker in the join menu
  profile.ts      local progression + chosen look (localStorage; accounts are M13)
  skidMarks.ts    drift feedback
  tracers.ts      shot tracers
  explosions.ts   death FX — instanced, billboarded flash/fire/smoke + shock ring
  sky.ts          gradient sky dome
  audio.ts        procedural positional audio — no asset files
  vehicle/
    buildVehicle.ts  assembles the part graph and drives its animation
    parts.ts         geometry for each individual part
    partLibrary.ts   the asset seam — procedural now, glTF later
    gltfPartLibrary.ts
    loft.ts          lofted body shells
scripts/
  simcheck.ts     headless simulation tests (119 assertions)
  combattest.ts   headless combat tests (52 assertions)
  matchtest.ts    match rules + end-to-end lifecycle, duel and solo (101 assertions)
  bottest.ts      bot brain, navigation, depth, target selection + a real bot match (35 assertions)
  cosmeticstest.ts cosmetics catalogue, unlocks, profile + the look-only guarantee (33 assertions)
  solobench.ts    tuning diagnostic: real matches, pacing + lethality
  nettest.mjs     end-to-end two-client netcode test
  netheadless.ts  headless prediction/reconciliation harness
  assetcheck.ts   asset-contract validator
  driftbench.ts   drift tuning benchmark
  reticleprobe.mjs what is under the crosshair
  shot.mjs        headless screenshot capture
```

**`combat.ts` lives in `shared/` on purpose.** The server uses it to decide what a
shot hit — hit detection is never a client claim. The client uses the *same code*
to draw its own shot immediately instead of waiting a round trip. If they used
different geometry, your tracer would disagree with the damage you then took, and
you would stop believing the tracers.

### The vehicle is a part graph, and the parts are named after the sim

Every part id mirrors a module in the simulation, so the thing you damage is the
thing you can see:

| Part id | Simulation module |
|---|---|
| `chassis` | hull integrity — the kill condition |
| `engine` | power and boost |
| `wheel.fl` · `wheel.fr` · `wheel.rl` · `wheel.rr` | mobility and traction |
| `seat.driver` · `seat.frontRight` · `seat.rearLeft` · `seat.rearRight` | crew positions |

That correspondence is why M3 exists *before* crews and damage rather than as a
polish pass at the end: M4 hangs per-seat cameras off these, M6 tints and
cripples individual parts, and M12 swaps any of them for a cosmetic variant.

Each part also carries named **sockets** — `eye` (the per-seat camera anchor),
`firePort` (the window a gunner shoots through), `decal.left`, `rim`, and so on.
Sockets are the attachment surface for both gameplay and cosmetics.

### Cosmetics are look-only, and a test proves it (M12)

Paint, wheels and roof kits are chosen in the **garage** in the join menu, stored
per browser, and relayed by the server so every car looks the same to everyone.
They are **purely visual**: the simulation never reads a look, so nothing in the
garage can change handling, damage or speed. That is not a promise, it is a test —
`cosmeticstest` asserts a catalogue entry can only contain appearance fields, so a
future "livery" that quietly carried a grip bonus would fail the build rather than
start a balance argument.

A look is three small indices — paint, wheels, roof — packed into **one integer**
on the wire (`packLook`). The three catalogues live in `shared/cosmetics.ts`,
which both sides read; the server only relays the number, it never interprets it.
Bots wear their own deterministic paint, so a 30-car grid is varied.

Unlocks are **earned by playing**, not bought: a few are free, the rest need
matches, kills or wins (Mat, Pearl and Chrome paints; Gold wheels; a light bar).
With accounts still at M13, progression lives in `localStorage` and is
deliberately client-authoritative — there is nothing worth cheating for.

### Nothing is bolted to the car

Gunners ride **inside** and fire **their own weapons** out of the windows. The
vehicles carry no weapons at all, and the driver is unarmed.

A gunner's field of fire therefore comes from **which window they sit beside**,
not from a turret's traverse rate. That is what makes the driver's positioning
matter: a gunner in the front passenger seat cannot shoot behind the car, so the
driver has to present the armed side to the threat. It is the same design pillar
as turret traverse, but visible — you can see which windows are occupied.

### Two vehicle classes

| Class | Crew | Shape |
|---|---|---|
| **Coupe** | 2 — driver + one gunner | Low two-seat coupe. One narrow arc, one large blind side. |
| **SUV** | 4 — driver + three gunners | Tall four-seat SUV, two rows of windows, three covered sectors. |
| **Brawler** | 1 — driver *and* gunner | Low retrofitted car with built-in guns. One person does both. |

They never meet in a match (separate playlists), so they differ freely in size:
dimensions live per-class in `VEHICLE_CLASSES`, and collision, ground sampling
and the wheel layout all read them. A single shared collider would leave the SUV
hit-tested as a coupe, which players notice immediately in a shooter.

Try it with `?car=coupe`.

### The arena is symmetric by construction

The layout is authored **once as a single quadrant** and replicated by rotating
it 90° three times. Hand-placed maps drift out of symmetry the moment someone
nudges one block, and asymmetric cover is exactly the kind of thing that quietly
decides matches — "fair by construction" is a design pillar, not a preference.
`simcheck` samples the generated height field and asserts it maps onto itself
under a quarter turn (currently 0 of 3364 samples differ), and that every spawn
has a rotational counterpart.

### How the netcode works

The server simulates at a fixed 60 Hz and broadcasts snapshots at 30 Hz. Clients send **input, never state** — a client cannot tell the server where it is, which is both the anti-cheat posture and what keeps prediction honest.

The client simulates its own car immediately (**prediction**), tagging each input with a sequence number. When a snapshot arrives it snaps to the server's state and **replays every input the server hasn't acknowledged yet**, then — instead of teleporting to the result — accumulates the difference and lets it decay over ~150 ms. Vehicles are large and the camera is bolted to one, so snapping looks broken even when the correction is exactly right.

Remote cars are drawn ~100 ms in the past from a snapshot buffer, so there is always a previous and next sample to interpolate between and packet jitter never shows. The interpolation clock runs on real time and is never allowed to fall more than that delay behind the newest snapshot, which avoids needing to synchronise clocks at all.

**This only works because both sides run identical code.** That is why the simulation has no physics engine, no randomness and no wall-clock time, and why `simcheck` asserts bit-identical determinism.

### Scaling to battle royale

Two things stop a room scaling past a handful of cars, and both are in (`DESIGN.md`
§13.5):

- **Spatial partitioning** — `shared/grid.ts`, a uniform spatial hash. The first
  thing that stops scaling is asking "what is near this point?" by scanning
  everything. It is a plain index over state, deliberately **not** part of the
  simulation: it may differ between client and server without changing behaviour.
- **Interest management** — a client is only sent the crews within
  `NET.interestRadius` (320 m), with a hysteresis margin so a car on the boundary
  does not flicker. On a 1 km map with 30 cars that is **664 → 46 kbit/s per
  client** (7% of the full snapshot; `npm run scalebench` §5).

Interest management is a filter on the **wire**, never on authority: the server
still simulates and resolves everything, so a car you cannot see can still shoot
you, and your shots resolve against cars you were not sent. Filtering authority by
interest would be a cheat vector, not an optimisation. It switches off entirely
(`null` = send everything) for a duel, and for an eliminated player who is
spectating.

### Two decisions worth knowing

**No physics engine.** Client-side prediction requires the client and server to run *identical* movement code, and third-party physics engines introduce divergence. The simulation is therefore plain deterministic TypeScript, stepped at a fixed 1/60 s. Both sides run V8, so float maths reproduces exactly — which is why `simcheck` can assert bit-identical runs.

**Fixed timestep from day one.** The simulation is decoupled from the frame rate in the very first commit, because determinism cannot be retrofitted later.

### Vehicle model

A kinematic arcade car rather than a rigid body: the chassis tracks a heading and a velocity, and samples ground height under its wheels. Pitch and roll are derived from wheel contact heights, and **ramp launches fall out of that for free** — while the terrain climbs beneath the car its vertical velocity points up, so when the ground falls away at the lip, the car flies. No suspension solver required.

## Tuning

Every number that affects feel lives in `src/shared/config.ts`. The handling is a first pass written without a human at the wheel — **expect to change all of it** after driving.

Two behaviours worth knowing about, both from playtest feedback:

- **The car only moves while you drive it.** `engineBraking` decelerates the car to a stop whenever no throttle or reverse is held — without it the car glided for ~10 seconds after lifting off. At full speed it takes roughly 3.5 s to halt.
- **Acceleration is deliberately gradual.** 0–100 km/h in ~3.6 s, top speed in ~5.8 s. An earlier tuning used `engineForce: 31` (3.2 g), which hit 100 km/h in about a second and made the throttle feel like an on/off switch.
- **Throttle is analogue.** `input.throttle` is scaled by magnitude, not just sign — so partial throttle pulls proportionally less, and a keyboard's ramped input is what the driver actually feels.
- **The handbrake always brakes, and breaks traction.** It is handled *before* the throttle branch in `stepVehicle`, because an earlier version put its braking inside the `else` of the throttle check — meaning with throttle held it never ran, and driving straight produces no lateral velocity for the grip loss to act on either. Pulling it under power did nothing at all. It now brakes regardless, kills most engine drive (`handbrakeDriveFactor`, the rear wheels are locked), and cuts lateral grip for the slide.
- **Slides leave skid marks** (`skidMarks.ts`), so the handbrake has visual feedback rather than only numbers the driver can't see.
- **Boost cannot be trickled.** Holding boost on a nearly-empty meter used to alternate between draining to zero and gaining a sliver back from momentum, firing the boost force on roughly every other tick *forever*. The meter read empty while the car kept climbing well past its normal top speed. Regeneration is now blocked whenever the boost input is held, so an empty meter simply does nothing until released.
- **Chassis pitch/roll are guarded** (`updateAttitude`). Deriving them from raw front/rear ground heights made the back end flap violently off a ramp: the instant the front wheels crossed the lip they sampled the floor several metres below while the rear was still climbing, snapping pitch to about -63° and then back to 0° once airborne. Wheels now only count as touching if they are near the highest contact, the angle is clamped (`maxAttitude`) and damped (`attitudeRate`), and airborne the nose follows the flight path.

### Drifting

Three things have to be right at once, and getting any one of them wrong makes drifting feel broken:

1. **Braking must fall off with speed** (`handbrakeBrakingFalloff`). A constant braking force scrubs a slide to nothing in about a second. Fading it out at speed lets the slide carry momentum, while full strength returns as the car slows so the handbrake still stops you.
2. **Lateral grip is where a drift's energy goes** (`lateralGripHandbrake`). It is the main lever on how much speed a drift costs — too high and the slide feels like braking.
3. **The camera must not rotate with the car** (`camera.ts`). Following the car's heading alone keeps it pinned to the centre of the screen no matter how sideways it goes. The camera blends towards the direction of *travel* as the slip angle grows, which is what makes the car visibly point away from where it is going.

Run `npm run driftbench` to print the shape of a drift — speed, lateral slip and slip angle over time. It compares a full-lock donut against a realistic turn-in-then-counter-steer, which retain very different amounts of speed:

| Input | Speed retained | Peak slip angle |
|---|---|---|
| Full lock (donut) | ~39% | ~90° |
| Turn in, then counter-steer | ~72% | ~38° |
| Held partial steer | ~59% | ~50° |

Note that a full-lock donut scrubbing most of its speed is *correct*, not a bug — that is a different manoeuvre from a cornering drift.

### Invariants `simcheck` guards

- `engineForce / rollingResistance` must exceed `maxSpeed`, or the car tops out below its stated limit and the speed clamp becomes dead code. (An early version of the config got this wrong and capped the car at 81 km/h.)
- 0–100 km/h must take between 2 s and 6 s, so a future retune cannot quietly make the car uncontrollable again.
- Partial throttle must pull proportionally less than full throttle.
- The handbrake must be stronger than engine braking, must slow the car *even under full throttle*, and must still break traction into a slide.
- A drift must reach a meaningful slip angle (>20°), sustain for over a second, and keep most of its speed — measured with realistic turn-in-then-counter-steer input, not a full-lock donut.
- Holding no input must not move the car, and lifting off must bring it to a stop — by braking, not by crashing into a wall.
- The perimeter walls must overlap at the corners, or a car driving diagonally escapes the arena. (It did.)
- Chassis pitch/roll must never move more than a few degrees in a single tick, including across a ramp lip, and must stay inside their clamp.
- An empty boost meter must give no benefit at all: holding boost must not regrow the meter, and the car must stay within its normal top speed.

One invariant to preserve: `engineForce / rollingResistance` must exceed `maxSpeed`, or the car tops out below its stated limit and the speed clamp becomes dead code. `simcheck` asserts this (test 0) because an early version of the config got it wrong.

## Licence

**Copyright (C) 2026 the CONVOY authors.**

This program is free software: you can redistribute it and/or modify it under the
terms of the **GNU General Public License as published by the Free Software
Foundation, either version 3 of the License, or (at your option) any later
version.**

This program is distributed in the hope that it will be useful, but WITHOUT ANY
WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A
PARTICULAR PURPOSE. See the GNU General Public License for more details.

You should have received a copy of the GNU General Public License along with this
program. If not, see <https://www.gnu.org/licenses/>. The full text is in
[`LICENSE`](./LICENSE).

**Bundled third-party music** under `public/audio/music/` is licensed separately
(Kevin MacLeod, CC BY 4.0); see [`ASSETS.md`](./ASSETS.md).
It is not covered by the GPL above.

Contributions are accepted on the same terms (inbound = outbound).
