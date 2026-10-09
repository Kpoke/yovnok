# Deploying CONVOY

This is the plan for running the game on a real host (DigitalOcean), written
down now so the code stays deployment-shaped even while there is no budget yet.
Nothing here has to be done until you are ready; the important part is that the
**code needs no changes to deploy** — only configuration.

> Status: the app builds and runs as a single **distroless, non-root** container
> that serves the client and the WebSocket on one origin. That image has been
> built and run **locally only**; the DigitalOcean steps below are untested
> against a live account, and no deploy has been performed. Treat costs and UI
> labels as approximate.

---

## The shape of the thing

The whole game is **one Node process**. It:

- serves the built client from `dist/`,
- serves the authoritative WebSocket at `/ws`,
- exposes `GET /healthz`,
- runs one **room** = one match at a time.

That single-origin design is deliberate (see `src/server/server.ts`): the client
talks to `${location.host}/ws`, so hosting the client and the socket together
means no CORS, no mixed-content problem over HTTPS, and no host baked into the
bundle.

**Capacity of one instance:** a solo room seats **30 players** in one match, plus
30 bots filling the rest. A 30-car solo match costs ~46 kbit/s per client and a
few percent of one core (measured — `STATE.md` §3, `scalebench`). So one small
instance comfortably holds a first playtest of a few dozen people, provided they
are happy to be in the same match. It is **concurrency**, not CPU, that the first
scaling step has to solve (see [Scaling](#scaling--rooms)).

---

## Option A — DigitalOcean App Platform (recommended first)

You connect a Git repo, DO builds the Dockerfile and runs it, terminates TLS, and
gives you a `https://…ondigitalocean.app` URL. HTTPS matters: a page served over
HTTPS cannot open an insecure `ws://` socket, and App Platform gives you `wss://`
for free.

- **Why:** least ops. No server to patch, auto-deploy on push, health checks and
  logs in the dashboard, TLS and a domain handled for you.
- **Cost:** the smallest instance is roughly **$5–10/month**; bandwidth is
  included to a generous cap on App Platform. Confirm current pricing.
- **Config:** create an app from the repo, choose **Dockerfile** as the build
  method, set the HTTP port to **8787** (or set `PORT`), health check path
  `/healthz`.
- **Watch out:** App Platform may **sleep** or scale to zero on cheap tiers. A
  sleeping game server drops its room. If that is offered, turn it off — an
  authoritative game server must stay up.

## Option B — Droplet + Caddy (cheapest, most control)

A **$6/month** 1 GB Droplet (or $12 for 2 GB) running Docker, with **Caddy**
in front for automatic TLS.

```
# on the droplet, once
apt-get install -y docker.io
# a 10-line Caddyfile reverse-proxying game.example.com -> 127.0.0.1:8787
# (Caddy handles certificates automatically)
```

```bash
docker build -t convoy .
docker run -d --restart=unless-stopped --name convoy \
  -p 127.0.0.1:8787:8787 \
  -e PORT=8787 -e HOST=0.0.0.0 \
  convoy
```

Caddy must pass WebSocket upgrades (it does by default for `reverse_proxy`). Bind
the container to `127.0.0.1` only and let Caddy own the public ports.

- **Why:** cheapest, and a normal Linux box is easier to debug than a platform.
- **Trade-off:** you patch the OS, rotate the TLS renewal yourself (Caddy mostly
  does), and there is no auto-deploy.

**Either way**, the only ports that matter are `8787` (HTTP + WS) and the
platform's HTTPS. Do not expose `8787` publicly on a Droplet without Caddy in
front — the origin allowlist is not a substitute for TLS.

---

## The container (distroless)

The runtime image is **`gcr.io/distroless/nodejs24-debian12:nonroot`**: Node 24,
no shell, no package manager, running as a non-root user. That is only possible
because the server is **bundled to one JS file** at build time:

```
build stage (node:24-slim)          runtime stage (distroless, non-root)
  npm ci                              COPY dist/          the built client
  npm run build                       COPY dist-server/   the bundled server
    ├─ tsc --noEmit                   COPY node_modules/ws  ← the ONLY bare dep
    ├─ vite build        → dist/      CMD node dist-server/server.mjs
    └─ vite build --ssr  → dist-server/
  npm ci --omit=dev → lift `ws`
  assert: bundle imports only node:* + ws
```

The **assertion in the build** is the important part: if someone adds a server
dependency and forgets to copy it into the image, the build fails immediately
rather than the container failing to start. `ws` is the only thing copied because
it is the only thing the bundle does not inline (it conditionally requires
optional native addons).

To test the image locally — this builds and runs on your machine and touches
nothing remote:

```bash
docker build -t convoy .
docker run --rm -p 8787:8787 -e MODE=solo convoy
curl localhost:8787/healthz
```

---

## Configuration reference

Everything is environment variables; nothing is baked into the build.

| Variable | Default | Meaning |
|---|---|---|
| `PORT` | `8787` | HTTP + WebSocket port. Hosting platforms set this (App Platform uses `8080`). |
| `HOST` | `0.0.0.0` | Bind address. Keep `0.0.0.0` in a container. |
| `ALLOWED_ORIGINS` | *(unset = allow all)* | Comma-separated origins allowed to open a socket, e.g. `https://game.example.com`. Set this once you have a domain. |
| `MODE` | `duel` | `solo` for one-man-team battle royale, `duel` for 2-crew TDM. **A solo server and a duel server are separate deployments** for now. |
| `SOLO_CARS` | 30 | Field size in solo. |
| `BOT_SKILL` | `hard` | Bot difficulty (`easy`/`normal`/`hard`). |
| `DEV_ASSIGN`, `DEV_PLACE`, `MATCH_FORCE_LIVE`, `HEARTBEAT_MS`, `CLIENT_TIMEOUT_MS` | — | **Dev and test only.** Leave unset in production; `DEV_ASSIGN` in particular lets a client choose its own crew and issue test kills. |

A production run therefore looks like:

```bash
npm run build                                   # client → dist/, server → dist-server/
MODE=solo ALLOWED_ORIGINS=https://game.example.com PORT=8080 npm start
```

`npm start` runs the **pre-bundled** server (`node dist-server/server.mjs`). The
server is bundled at build time into one plain-JavaScript file whose only bare
import is `ws`, which is what lets the runtime be distroless (no `tsx`, no npm).
To run the server straight from TypeScript during development, use
`npm run start:source` — the tests spawn that path directly.

---

## Scaling & rooms

The current limit is **one match per process**. A solo room already takes 30
players, so a first send can be one instance. When demand grows, in order of
effort:

1. **Run more instances, one room each.** Stateless except for the live room, so
   this is horizontal already — you just need clients pointed at different
   instances.
2. **Make the room addressable.** Give each instance a room id and put a match
   finder in front that redirects a client to a room URL (`?room=…` on a host, or
   a subdomain per room). The client already reads config from the URL, so this
   is mostly routing.
3. **Many rooms per process.** `Room` is transport-agnostic by design (`room.ts`
   is ignorant of sockets; `server.ts` is transport-only). A router over a
   `Map<roomId, Room>` in one process is the next step; it does not touch the
   simulation.
4. **A matchmaking service + shared state.** Only needed when you want parties,
   queues and cross-instance presence. That is when DO **Managed Redis** and
   **Managed Postgres** earn their place.

**Netcode assumptions to preserve while scaling:** the simulation is
authoritative and deterministic (`src/shared/`), a client predicts only its own
crew's car, and interest management is a wire filter, not an authority filter. A
room is a closed world — do not try to spread one match across processes without
changing those rules.

---

## Updating, and rolling back

- **App Platform:** push to the tracked branch; it builds and deploys. Keep the
  previous deployment; DO can roll back to it.
- **Droplet:** `docker build` a new tag, stop the old container, start the new
  one. Because the game is stateless between matches, a restart is safe — no
  database to migrate yet.

A deploy interrupts live matches. At this stage that is fine; later, drain a room
(announce to the lobby and let the match end) before replacing it.

---

## Data, accounts and the shop (M13 and later)

There is **no database** today: progression is per-browser (`localStorage`,
`client/profile.ts`). When M13 lands:

- **Accounts + progression + match history →** DO Managed PostgreSQL (start at
  the smallest tier, ~$15/month).
- **Sessions, room presence, queues →** DO Managed Redis (small tier) once
  scaling step 3+ is real.
- The **cosmetic-only** rule is enforced structurally (`cosmeticstest`), so the
  shop stays honest: nothing purchasable can affect play.

## Security posture

- **No authentication yet.** Anyone with the URL can join. That is fine for a
  closed playtest; before a public launch, the `hello` handshake needs a
  session token, and joins should be rate-limited per IP.
- **`ALLOWED_ORIGINS`** stops another website from opening sockets to your server
  on a visitor's behalf. Set it once you have a domain.
- **The server is authoritative.** Clients send input and aim, never state, so the
  usual movement/teleport cheats are structurally out. See `DESIGN.md` §13.8.
- **`DEV_*` flags must be off in production** — with `DEV_ASSIGN=1` a client can
  choose its crew and fire `devKill`.

## Licensing

The game is **GPL-3.0-or-later**. Running it as a public service is fine, and so
is charging for hosting, but the source must stay available under the same
licence. Bundled music is **CC BY 4.0** (Kevin MacLeod) and lives, with its attribution,
under `public/audio/music/` — keep the two licences physically apart, as
`DESIGN.md` §17 says.

---

## First-deploy checklist

Use this when the budget appears.

- [ ] `npm run check` is green locally.
- [ ] `npm run build` produces `dist/` **and** `dist-server/`, and `npm start`
      serves them (visit `http://localhost:8787` and play a solo match — it should
      feel identical to `npm run dev`).
- [ ] `docker build -t convoy .` succeeds and the container serves the game
      (`docker run --rm -p 8787:8787 -e MODE=solo convoy`). This is local; nothing
      is pushed.
- [ ] `curl localhost:8787/healthz` returns `{"ok":true,…}`, and
      `docker inspect` reports the healthcheck `healthy`.
- [ ] Decide the mode for this deployment (`MODE=solo`).
- [ ] Create the host (App Platform app or Droplet + Caddy) and set the env vars
      above, with `PORT` matching the platform.
- [ ] Point a domain at it; set `ALLOWED_ORIGINS=https://that.domain`.
- [ ] Open the URL on a phone on mobile data and play one match; confirm the
      socket connects (`wss://`) and a second person can join the same room.
- [ ] Watch `/healthz` (`players`, `crews`, `phase`) while two people play.
- [ ] Note the monthly cost and the region; pick the region closest to the group
      you are inviting.
