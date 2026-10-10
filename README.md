# YOVNOK

**Armed cars, six arenas, a live broadcast — twelve cars, one survivor.**

YOVNOK is a vehicle-combat battle royale that runs in the browser, on a computer
or a phone. You drive and shoot at the same time: twin machine guns in the
headlights, an RPG on a roof turret, a closing ring of danger, and eleven other
cars that want you gone. Every match is broadcast live.

**Play now: [play.yovnok.com](https://play.yovnok.com)**

![The YOVNOK title screen: an armoured orange muscle car under stadium floodlights](docs/title.png)

It is free software (GPL-3.0-or-later) and every third-party asset in it is
free to share — see [Assets and licences](#assets-and-licences).

---

## Playing

A browser with WebGL 2 (current Chrome, Edge, Firefox or Safari), played with a
**keyboard and mouse**, a **gamepad**, or **touch** on a phone or tablet (held
sideways; add it to the home screen for full screen).

Press **PLAY**, then:

- **VS BOTS** — a public match. Bots fill whatever seats players do not, so a
  match starts at once; other players arriving together join the same match.
- **PRIVATE ROOM** — create a room and send friends its five-letter code or
  invite link. 2–12 players, no bots; the host picks the map and starts.

When the server is at capacity, PLAY shows a waiting card and goes in as soon as
a seat frees up.

| | Keyboard + mouse | Gamepad | Touch |
|---|---|---|---|
| Throttle · brake / reverse | `W` · `S` | `RT` · `LT` | left thumb: stick up · down |
| Steer | `A` / `D` | left stick | left thumb: stick sideways |
| Aim | mouse | right stick | right thumb: drag (with aim assist) |
| Twin machine guns | left click | `RB` | `MG` (slide to aim) |
| Roof RPG | right click | `LB` | `RPG` |
| Handbrake | `Space` | `X` | `DRIFT` |
| Boost | `Shift` | `B` or `L3` | `BOOST` |
| Reload | `R` | `Y` | `↻` |
| Menu | `Esc` | `Start` (D-pad + `A`/`B` to choose) | `☰` |
| Performance overlay | `F3` or `` ` `` | — | — |

**The arenas** (public matches rotate between them after every match):

| Arena | |
|---|---|
| The Stadium | floodlit night; container cover, a mesa, a two-deck crowd that cheers the kills |
| Dusk Canyon | sunset; sandstone mesas, a dry wash, a rock shelf, a tar pit |
| Rainy Dockyard | night and rain; a maze of container lanes, warehouses, gantry cranes |
| Snowbound Base | overcast; runways, hangars, banked bunkers, frozen ponds with no grip |
| Quarry | clear day; an open pit on three levels joined by haul roads |
| Pine Forest | misty morning; trees to weave through, tracks, a logging camp, a bog |

**In a match**
- The guns swing ±20° off the nose — aim them mostly by aiming the car. The
  roof RPG turns much further and hits hard, but reloads slowly.
- The ring closes in stages. Outside it, you burn.
- Damage shows: smoke, then black smoke and flames, then a car on fire.
  Repair crates and wreck salvage patch you up if you sit still on them.
- Close or reload the tab mid-match and a bot keeps your car going for 30
  seconds — come back in time and **REJOIN** puts you back behind the wheel.

**Your callsign and paint** live in your browser: pick a callsign under
Settings, and unlock paints in the Garage by playing (matches, kills, wins).
There are no accounts yet.

---

## Running it locally

Requires **Node.js 24** (or newer) and npm.

```bash
npm install
MODE=solo npm run dev
```

Then open **http://localhost:5173**. That starts two processes:

| Process | Port | |
|---|---|---|
| game server | `8787` | the authoritative simulation and WebSocket (`/ws`) |
| Vite | `5173` | the client, proxying `/ws` to the game server |

Useful switches (environment variables for the server):

| Variable | Default | |
|---|---|---|
| `MODE` | `duel` | `solo` is the game as released (one-car teams, bots, the ring) |
| `BOTS` | `fill` in solo | `off`, or a number to fill the field to |
| `SOLO_CARS` | `12` | cars per solo match |
| `MAX_ROOMS` | `3` | simultaneous matches in one process, public and private |
| `MAX_PLAYERS` | `16` | players at once; past it, PLAY waits for a seat |
| `REJOIN_SECONDS` | `30` | how long a dropped player's car is held |
| `ALLOWED_ORIGINS` | *(any)* | comma-separated origins allowed to open sockets |
| `TRUST_PROXY` | off | `1` behind a reverse proxy (client IP from `X-Forwarded-For`) |

To try a bad connection, add `?lag=120&jitter=40&loss=0.05` to the page URL.

**Production build:** `npm run build && npm start` serves the built client and
the socket from one process on port 8787. Or with the container:
`docker build -t yovnok . && docker run -p 8787:8787 -e MODE=solo yovnok`.

---

## Tests

```bash
npm run check
```

runs the whole suite — about 400 checks — and the production build:

| | What it guards |
|---|---|
| `typecheck` | TypeScript, strict |
| `licensecheck` | every asset listed, credited and under an allowed licence |
| `assetcheck` | built models against their size and LOD budget |
| `simcheck` | driving physics, collision, and every map's invariants (spawns, symmetry, crates, reachability) |
| `combattest`, `weapontest` | hit detection, damage, weapons and their mounts |
| `matchtest` | the match lifecycle end to end against a real server |
| `bottest` | bot driving, aiming and weapon discipline |
| `cosmeticstest` | paints and unlocks are look-only; callsign rules |
| `roomstest` | several matches at once, rejoin, private rooms, the player limit, and abuse cannot crash the server |
| `netheadless` | client prediction and reconciliation over a real socket |

Diagnostics that are not pass/fail: `npm run solobench` plays real bot matches
and reports match length, accuracy and damage by weapon (`DEV_MAP=<map id>` picks
the arena); `scalebench` and
`driftbench` measure load and handling.

---

## How it is built

- **Client:** TypeScript and [three.js](https://threejs.org) (WebGL 2), built
  with Vite. Models are glTF with meshopt geometry and KTX2 textures.
- **Server:** Node.js and [`ws`](https://github.com/websockets/ws). The server is
  authoritative: it simulates every car at 60 Hz; clients predict their own car
  and reconcile, and draw everyone else slightly in the past, interpolated.
- **Shared:** the simulation, arena, weapons and rules are one codebase used by
  both sides (`src/shared`), so client and server cannot disagree.

```
src/
  shared/   simulation, arena, weapons, match rules, protocol
  server/   rooms (matches), bots, the HTTP + WebSocket server
  client/   rendering, input, camera, audio, HUD and menus
scripts/    tests, benchmarks, and the asset pipeline
assets-src/ source models and textures, with their prep scripts
public/     built assets served to the browser
```

More depth: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) (how the server,
client, rooms, netcode and statistics work), [ASSET_SPEC.md](ASSET_SPEC.md)
(the asset pipeline) and [DEPLOY.md](DEPLOY.md) (hosting and operations).

---

## Assets and licences

The code is **GPL-3.0-or-later** — see [LICENSE](LICENSE).

Third-party assets are used only under **CC0**, **CC-BY** or **CC-BY-SA**
(never non-commercial or no-derivatives), each credited with its author,
source and licence in [ASSETS.md](ASSETS.md) and in the game's **Credits**
screen. `npm run licensecheck` fails the build if anything is unlisted,
uncredited or under another licence. Models come from Poly Haven (CC0) and
Sketchfab (CC-BY); music from Kevin MacLeod (CC-BY); sound effects from
OpenGameArt (CC0 / CC-BY-SA).

Sponsor names in the arena are fictional.

---

## Contributing

Issues and pull requests are welcome.

- Run `npm run check` before opening a pull request.
- Commit messages follow [Conventional Commits](https://www.conventionalcommits.org):
  `feat(bots): lead moving targets`, `fix: …`, `docs: …`, `chore: …`. A
  `commit-msg` hook (installed by `npm install`) and a GitHub check enforce it.
- New assets must be added to `assets.json` with their licence, or the build
  refuses them.
