# How YOVNOK works

## Overview

One Node.js process serves everything on one origin: the built client, the
game's WebSocket at `/ws`, `/healthz`, and `/stats`. The browser runs the
renderer, input and audio; the server runs the game.

```
browser ── HTTPS (via the CDN) ──▶ static files, /config.json
        ── WSS /ws (direct) ─────▶ RoomManager ─▶ Room (one match) × up to MAX_ROOMS
```

On load the page fetches `/config.json`, which names the socket address
(`PUBLIC_WS_URL`; the page's own origin when unset).

The simulation, arena, weapons and match rules live in `src/shared/` and are
compiled into both sides, so the client and the server run identical code.

## Server

**Rooms** (`src/server/rooms.ts`, `room.ts`). A room is one match: up to
`SOLO_CARS` cars, bots filling the seats players do not. A new connection is
held by the `RoomManager` until the player presses PLAY (`hello`), then placed:

1. back into the room still holding their car, if they left it moments ago;
2. otherwise into a room that is in its lobby or countdown and has a seat —
   the one closest to starting;
3. otherwise into a new room (up to `MAX_ROOMS`).

Idle extra rooms close; there is always one.

**Simulation.** Each room steps at 60 Hz and sends snapshots at 30 Hz. The
server is authoritative: it applies every player's inputs, resolves every shot
(hitscan with lag compensation; projectiles simulated in flight), applies
damage, runs the closing ring and decides the match.

**Bots** (`bot.ts`) are occupants without a socket. Each tick the bot brain
produces the same input and fire requests a player would, so every rule (arcs,
rates, magazines) binds them too. They make attack runs at a target, fire each
weapon only when it can bear, lead moving targets with the RPG, retreat to
repair when hurt and stay inside the ring.

**Rejoin.** When a player's socket closes during a live match, their car stays
in the match under the bot brain for `REJOIN_SECONDS`. The page asks the server
(`held?`) whether a car is being held for its browser token; if so PLAY becomes
REJOIN, and `hello` with that token hands the car back.

**Protection** (`server.ts`): 16 KB maximum message size; per-IP socket and
connection-rate limits; a per-socket message-rate cut-off; an origin
allowlist; and an error handler on every socket from its first moment.

**Operations.** `bandwidth.ts` meters the server's outbound traffic for the
month and, at `BANDWIDTH_BUDGET_GB`, stops admitting new players and serves a
"back soon" page. `stats.ts` records anonymous events to SQLite and serves the
password-protected `/stats` page (see [Statistics](#statistics)).

## Client

**Networking** (`src/client/net.ts`). The client predicts its own car by
running the shared simulation on its inputs, then reconciles with the server's
snapshots: it rewinds to the acknowledged state and replays unacknowledged
inputs, smoothing any remaining error away. Other cars are drawn 100 ms in the
past, interpolated between snapshots.

**Rendering** (three.js, WebGL 2): the floodlit stadium (`buildArena`,
`buildStadium`, `buildContainers`, `buildProps`), PBR materials with KTX2
textures, a night HDRI environment, shadows from the floodlight key, and three
quality presets (`lighting.ts`: Low and Medium draw directly; High adds bloom).
Effects are instanced particle pools (`damageFx`, `driveFx`, `explosions`,
`weaponFx`) and one batched draw for every car's lights (`carLights`).

**Vehicles** (`src/client/vehicle/`) are assembled from named parts — chassis,
wheels, turret, guns — loaded through a manifest
(`public/assets/vehicles/manifest.json`), with level-of-detail switching, a
livery paint layer and paint finishes, and scorching as the car takes damage.

**Input** (`input.ts`): keyboard and mouse, and the standard-mapping gamepad,
both producing the same actions. **Audio** (`audio.ts`, `music.ts`): sampled
weapons and impacts with positional audio and reverb; a synthesised engine with
gears, tyre, gravel and wind layers.

**Interface** (`index.html`, `hud.ts`): the stand-by card while assets load, the
title with the car showcase, garage (paint), settings (callsign, sound,
quality), credits, the in-game menu (Esc / Start) and the match HUD. The
F3 overlay shows frame timing and network ping, jitter and latency.

## Statistics

Recorded by the server, viewable at `/stats` with `STATS_PASSWORD`:

| Event | When | Data |
|---|---|---|
| `visit` | a page connects | country |
| `join` | PLAY | input (mouse / gamepad / touch), quality preset |
| `rejoin` / `left` | a held car is taken back / a player leaves mid-match | |
| `result` | a match ends, per player | placement, kills |
| `match` | a match ends | minutes, players, bots, whether a player won |
| `load` | every minute | players online, rooms |

Players are identified only by a salted hash of the game's random per-browser
id. No IP addresses, names or accounts are stored. Country comes from
Cloudflare's header.

## Assets

Source models live in `assets-src/`; `npm run assetbuild` produces the
game-ready files in `public/assets/` (LODs, meshopt geometry, KTX2 textures).
Every file is listed with its licence in `assets.json`, from which `ASSETS.md`
and the in-game credits are generated; the build fails on anything unlisted or
under a disallowed licence. See [ASSET_SPEC.md](../ASSET_SPEC.md).

## Tests

`npm run check` runs every suite (listed in the [README](../README.md#tests))
and the production build.
