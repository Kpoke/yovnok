# Deploying YOVNOK

## The setup

| Part | What | Cost |
|---|---|---|
| Server | DigitalOcean Droplet, **London (`lon1`)**, 1 vCPU / 1 GB, 1,000 GB transfer a month | $6/month |
| Domain | registered through Cloudflare | ~$10/year |
| CDN, HTTPS edge, DNS | Cloudflare, free plan | $0 |
| Image builds and registry | GitHub Actions and GitHub Container Registry (public repository) | $0 |

**Total: about $7/month, with no usage-based charges.** The limit is $10/month.

```
player ──▶ Cloudflare (cache, TLS) ──▶ Droplet: Caddy (TLS) ──▶ game container
                                                  └── Watchtower: pulls new images
GitHub push ──▶ Actions builds the image ──▶ ghcr.io/kpoke/yovnok:latest
```

## Staying within budget

- **Fixed-price plan.** The Droplet's 1,000 GB transfer allowance is the only
  usage that could cost more, and the guards below keep it inside.
- **Cloudflare caches the game's files** at its edge, so most of the ~40 MB a new
  player downloads never leaves the Droplet.
- **Bandwidth guard** (`src/server/bandwidth.ts`). The server meters its own
  outbound traffic for the calendar month. At `BANDWIDTH_BUDGET_GB` (850 GB) it
  admits no new players and shows a "back on the 1st" page; running matches
  finish. Usage is reported on `/healthz`.
- **Billing alert** at $8 in the DigitalOcean account.

## Files

| File | Role |
|---|---|
| `Dockerfile` | Builds the client and server; runs as a distroless, non-root container on port 8787 |
| `.github/workflows/image.yml` | On every push to `main`, builds the `linux/amd64` image and publishes it to `ghcr.io/kpoke/yovnok` |
| `deploy/docker-compose.yml` | On the Droplet: the game, Caddy and Watchtower; a volume for statistics and the bandwidth ledger |
| `deploy/Caddyfile` | HTTPS with a Cloudflare origin certificate, proxying to the game |

The Droplet keeps, outside the repository, a `.env` file (`DOMAIN`,
`STATS_PASSWORD`, `STATS_SALT`) and the origin certificate (`origin.pem`,
`origin.key`).

## Network and security

- **Firewall:** ports 80 and 443 accept only Cloudflare's address ranges; SSH
  (22) is key-only. Nothing reaches the game except through Cloudflare.
- **Cloudflare:** SSL mode *Full (strict)*; a cache rule caches `/assets/*`.
- **In the game server:** an origin allowlist (`ALLOWED_ORIGINS`), 16 KB
  maximum messages, per-IP connection limits, a message-flood cut-off, and a
  callsign filter. The server is authoritative: clients send input, never
  state.
- **No accounts and no personal data.** Statistics use a salted hash of a random
  per-browser id; no IP addresses or names are stored.

## One-time setup

**By the owner**

1. DigitalOcean: create the account, add a payment method, set a **billing
   alert at $8** (Settings → Billing).
2. DigitalOcean API token with **custom scopes** — droplet (create, read,
   update, delete), ssh_key (create, read), firewall (create, read, update),
   monitoring (create, read), actions (read) — 90-day expiry, saved in the
   project's local `.env` as `DIGITALOCEAN_TOKEN`.
3. Register the domain in Cloudflare, and save it in `.env` as `DOMAIN`.
4. Cloudflare API token limited to that zone — Zone: Read, DNS: Edit, Zone
   Settings: Edit, SSL and Certificates: Edit, Cache Rules: Edit — saved as
   `CLOUDFLARE_API_TOKEN`.

The container image is public with the repository, so the server pulls it
without credentials.

**Provisioned from the project** (tokens read from `.env`, never printed)

1. SSH key registered with DigitalOcean (the private key stays on the
   deploying machine, `~/.ssh/yovnok_deploy`).
2. Droplet `yovnok` in `lon1` (Ubuntu 24.04): Docker, a 1 GB swap file,
   automatic security updates, SSH password login off; `/opt/yovnok` holds the
   compose stack and its `.env`.
3. Cloud firewall as above.
4. Cloudflare: DNS record (proxied), origin certificate installed on the
   Droplet, SSL *Full (strict)*, cache rule for `/assets/*`.
5. DigitalOcean uptime check on `https://<domain>/healthz` with an email alert.

## Operating it

| Task | How |
|---|---|
| Deploy | Push to `main`. Actions builds the image; Watchtower installs it within ~5 minutes. Matches in progress end when the container restarts. |
| Roll back | Pin the previous image in `deploy/docker-compose.yml` (`ghcr.io/kpoke/yovnok:<commit sha>`) and run `docker compose up -d` on the Droplet. |
| Health | `https://<domain>/healthz` — rooms, players, bandwidth used this month. |
| Statistics | `https://<domain>/stats` (any user name, `STATS_PASSWORD`). |
| Logs | On the Droplet: `docker compose logs -f game`. |

## Configuration

Environment variables of the game container:

| Variable | Production | Meaning |
|---|---|---|
| `MODE` | `solo` | Game mode |
| `ALLOWED_ORIGINS` | `https://<domain>` | Origins allowed to open game sockets |
| `TRUST_PROXY` | `1` | Take the client address from Cloudflare's header |
| `MAX_ROOMS` | `8` | Simultaneous matches |
| `SOLO_CARS` | `12` | Cars per match (bots fill free seats) |
| `REJOIN_SECONDS` | `30` | How long a dropped player's car is held |
| `BANDWIDTH_BUDGET_GB` | `850` | Monthly outbound limit before new players are turned away |
| `DATA_DIR` | `/data` | Statistics database and bandwidth ledger (a Docker volume) |
| `STATS_PASSWORD`, `STATS_SALT` | secrets | `/stats` password; salt for visitor hashes |
| `MAX_SOCKETS_PER_IP`, `MAX_CONNECTS_PER_MINUTE` | `6`, `30` | Per-IP limits (on by default in production) |
| `PORT`, `HOST` | `8787`, `0.0.0.0` | Listening address |

`DEV_ASSIGN`, `DEV_PLACE`, `MATCH_FORCE_LIVE` and `BENCH_STATS` exist for tests
and must not be set in production.

## Running the production build locally

```bash
npm run build && MODE=solo npm start            # http://localhost:8787
docker build -t yovnok . && docker run --rm -p 8787:8787 -e MODE=solo yovnok
```

## Licensing

The game is GPL-3.0-or-later; a public server must keep its source available
under the same licence (this repository). Third-party assets carry their own
licences, listed in `ASSETS.md` and shown in the game's credits.
