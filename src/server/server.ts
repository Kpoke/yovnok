/**
 * Server entry point — transport and static hosting.
 *
 * Everything about the game lives in `Room`. This file owns the HTTP server,
 * the WebSocket upgrade, and (in production) serving the built client from the
 * SAME origin, which is what makes deployment a config step rather than a code
 * change:
 *
 *   - The client already talks to `${location.host}${WS_PATH}`, so serving the
 *     game and the socket from one port means no CORS, no mixed content over
 *     https, and no host baked into the bundle.
 *   - In development Vite serves the client and proxies `/ws` here (see
 *     `vite.config.ts`); in production this file serves `dist/` itself. Same
 *     single-origin shape either way.
 *
 * Deployment shape (see `DEPLOY.md`): one process runs several ROOMS — one
 * match each, opened as players arrive (`rooms.ts`, capped by MAX_ROOMS).
 * Spreading rooms across machines is a later change to the transport layer
 * (route a player to the machine hosting their room), not to the simulation.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { stat } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { NET, TICK } from '../shared/config';
import { WS_PATH } from '../shared/protocol';
import { RoomManager } from './rooms';
import { bandwidth } from './bandwidth';
import { countryOf, openStats, record, serveStats } from './stats';

/**
 * Default port. Deliberately not 8080 for LOCAL runs — that is a very common
 * default and was already taken by Docker on the development machine, which made
 * the server fail to bind with a confusing error. Hosting platforms set `PORT`
 * (DigitalOcean App Platform sets 8080), which overrides this.
 */
const port = Number(process.env.PORT ?? 8787);
/** Bind all interfaces by default so a container or droplet is reachable. */
const host = process.env.HOST ?? '0.0.0.0';

/**
 * Where the built client lives. Defaults to `dist/` under the working directory
 * (the app root, which is where the container starts), NOT relative to this
 * file — because this file runs from source under `tsx` in dev but from a
 * bundled `dist-server/server.mjs` in production, and the relative depth differs.
 * `CLIENT_DIR` overrides it for an unusual layout.
 */
const DIST = resolve(process.env.CLIENT_DIR ?? resolve(process.cwd(), 'dist'));

// One match per room, as many rooms as there are groups of players (rooms.ts).
const rooms = new RoomManager();
// Anonymous statistics (stats.ts), and once a minute how busy the server is.
void openStats();
setInterval(() => {
  const h = rooms.health();
  if (h.players > 0 || h.waiting > 0) record('load', null, null, { players: h.players, rooms: h.rooms, waiting: h.waiting });
}, 60_000).unref();

/**
 * Origin allowlist for the WebSocket upgrade. Empty (the default) accepts any
 * origin, which is what development and an open playtest want. Set
 * `ALLOWED_ORIGINS=https://game.example.com,https://staging.example.com` once a
 * real domain exists, so another site cannot open sockets to the server on a
 * visitor's behalf.
 */
const ALLOWED_ORIGINS = (process.env.ALLOWED_ORIGINS ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

function originAllowed(origin: string | undefined): boolean {
  if (ALLOWED_ORIGINS.length === 0) return true;
  if (!origin) return false; // a browser always sends Origin on a WS handshake
  return ALLOWED_ORIGINS.includes(origin);
}

const server = createServer((req, res) => {
  void handleRequest(req, res);
});

// ---- abuse limits (a public server; DEPLOY.md "Before going public") ----
//
// Generous for a real player, cheap to enforce, and enough to stop one machine
// from filling the server with sockets or flooding a room with messages.
/** Largest WebSocket message accepted. Real game messages are a few hundred bytes. */
const MAX_MESSAGE_BYTES = 16 * 1024;
// Per-IP limits default ON in production (the Docker image sets NODE_ENV) and
// off in development, where tests and benches open dozens of local sockets.
const PRODUCTION = process.env.NODE_ENV === 'production';
/** Open sockets per client IP (a household or a few tabs, not a botnet). */
const MAX_SOCKETS_PER_IP = Number(process.env.MAX_SOCKETS_PER_IP ?? (PRODUCTION ? 6 : 10_000));
/** New sockets per client IP per minute. */
const MAX_CONNECTS_PER_MINUTE = Number(process.env.MAX_CONNECTS_PER_MINUTE ?? (PRODUCTION ? 30 : 100_000));
/** Messages per second per socket before it is cut off (a client sends < 100). */
const MAX_MESSAGES_PER_SECOND = 240;
/**
 * Behind a proxy (App Platform, Caddy) every socket comes from the proxy's
 * address; the client's is in X-Forwarded-For. Only trusted when told, or any
 * client could claim to be anyone and walk round the per-IP limits.
 */
const TRUST_PROXY = process.env.TRUST_PROXY === '1';

function clientIp(req: IncomingMessage): string {
  if (TRUST_PROXY) {
    // Behind Cloudflare (the firewall only lets Cloudflare reach the server),
    // the client's address is in CF-Connecting-IP.
    const cf = req.headers['cf-connecting-ip'];
    if (typeof cf === 'string' && cf) return cf;
    const forwarded = String(req.headers['x-forwarded-for'] ?? '').split(',')[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

const socketsByIp = new Map<string, number>();
const connectsByIp = new Map<string, number[]>();

function admitConnection(ip: string): boolean {
  const now = Date.now();
  const recent = (connectsByIp.get(ip) ?? []).filter((t) => now - t < 60_000);
  if (recent.length >= MAX_CONNECTS_PER_MINUTE) return false;
  if ((socketsByIp.get(ip) ?? 0) >= MAX_SOCKETS_PER_IP) return false;
  recent.push(now);
  connectsByIp.set(ip, recent);
  return true;
}
// Forget quiet IPs, so the maps do not grow without bound.
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of connectsByIp) {
    const recent = times.filter((t) => now - t < 60_000);
    if (recent.length === 0) connectsByIp.delete(ip);
    else connectsByIp.set(ip, recent);
  }
}, 60_000).unref();

const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  maxPayload: MAX_MESSAGE_BYTES,
  verifyClient: (info: { origin?: string; req: IncomingMessage }, done: (ok: boolean, code?: number) => void) => {
    if (!originAllowed(info.origin)) return done(false, 403);
    // Over the month's bandwidth budget: no new players (bandwidth.ts).
    if (bandwidth.over) return done(false, 503);
    const ip = clientIp(info.req);
    if (!admitConnection(ip)) {
      console.log(`[yovnok] refused a connection: per-IP limit (${ip})`);
      return done(false, 429);
    }
    done(true);
  },
});

wss.on('connection', (socket, req) => {
  // FIRST, before anything else: a socket error (an oversized or malformed
  // frame) is an 'error' event, and an unhandled one CRASHES THE PROCESS — every
  // match on the server — from a single bad message. Rooms add their own
  // handler on join; this covers the title screen and everything else.
  socket.on('error', () => socket.terminate());
  const ip = clientIp(req);
  socketsByIp.set(ip, (socketsByIp.get(ip) ?? 0) + 1);
  socket.on('close', () => {
    const n = (socketsByIp.get(ip) ?? 1) - 1;
    if (n <= 0) socketsByIp.delete(ip);
    else socketsByIp.set(ip, n);
  });
  // Flood guard: count messages per second; a client far beyond what the game
  // sends is closed. Runs alongside the room's own handler.
  let windowStart = Date.now();
  let count = 0;
  socket.on('message', () => {
    const now = Date.now();
    if (now - windowStart > 1000) {
      windowStart = now;
      count = 0;
    }
    if (++count > MAX_MESSAGES_PER_SECOND) {
      console.log(`[yovnok] closed a socket: message flood (${ip})`);
      socket.terminate();
    }
  });
  rooms.accept(socket, TRUST_PROXY ? countryOf(req) : null);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[yovnok] port ${port} is already in use — is another server running?`);
  } else {
    console.error(`[yovnok] server error:`, error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const where = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`[yovnok] listening on ${host}:${port} (http://${where}:${port})`);
  console.log(`[yovnok] websocket  ws://${where}:${port}${WS_PATH}`);
  console.log(
    `[yovnok] simulate ${TICK.rate}Hz · snapshot ${NET.snapshotRate}Hz · interp delay ${NET.interpDelayMs}ms`,
  );
  void probeDist();
  if (ALLOWED_ORIGINS.length > 0) {
    console.log(`[yovnok] origins allowed: ${ALLOWED_ORIGINS.join(', ')}`);
  }
});

/** Say once whether the built client is present; dev serves it from Vite. */
async function probeDist(): Promise<void> {
  try {
    await stat(join(DIST, 'index.html'));
    console.log(`[yovnok] serving built client from ${DIST}`);
  } catch {
    console.log(
      '[yovnok] no built client in dist/ — API-only. Run `npm run build`, or use `npm run dev` (Vite serves the client).',
    );
  }
}

// ------------------------------------------------------------------ static

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.glb': 'model/gltf-binary',
  '.gltf': 'model/gltf+json',
  '.wasm': 'application/wasm',
  '.webmanifest': 'application/manifest+json',
};

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = req.url ?? '/';

  // Health check for the platform's load balancer and for `HEALTHCHECK` in the
  // Dockerfile. Answers 200 whenever the process is up; room stats are diagnostics.
  if (url === '/healthz' || url.startsWith('/healthz?')) {
    const body = JSON.stringify({
      ok: true,
      uptime: Math.round(process.uptime()),
      ...rooms.health(),
      bandwidth: bandwidth.status(),
    });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (serveStats(req, res)) return;

  // Where the page should open the game socket. The page and its files go
  // through Cloudflare (cached at its edge); the live game connection can go
  // STRAIGHT to the server (PUBLIC_WS_URL), because Cloudflare's free-plan
  // route doubled its round trip (Nigeria → London: ~130 ms direct, ~260 ms
  // via Cloudflare). This request comes through Cloudflare, so it is also
  // where a visit is counted, with Cloudflare's country.
  if (url === '/config.json' || url.startsWith('/config.json?')) {
    const token = new URL(url, 'http://x').searchParams.get('t');
    record('visit', token && token.length >= 8 && token.length <= 64 ? token : null, TRUST_PROXY ? countryOf(req) : null);
    const body = JSON.stringify({ wsUrl: process.env.PUBLIC_WS_URL || null });
    res.writeHead(200, { 'content-type': 'application/json', 'cache-control': 'no-store' });
    res.end(req.method === 'HEAD' ? undefined : body);
    return;
  }

  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { allow: 'GET, HEAD' });
    res.end('method not allowed');
    return;
  }

  const filePath = safeJoin(DIST, url);
  if (!filePath) {
    res.writeHead(400);
    res.end('bad path');
    return;
  }

  let target = filePath;
  let info = await statOrNull(target);
  if (info?.isDirectory()) {
    target = join(target, 'index.html');
    info = await statOrNull(target);
  }
  // SPA fallback: an unknown path with no file extension is a client route, so
  // serve index.html and let the client decide. A missing asset stays a 404.
  if (!info && !extname(url)) {
    target = join(DIST, 'index.html');
    info = await statOrNull(target);
  }
  if (!info) {
    res.writeHead(404, { 'content-type': 'text/plain; charset=utf-8' });
    res.end('not found');
    return;
  }

  const ext = extname(target).toLowerCase();
  // Over the month's bandwidth budget: new visitors get a short page instead of
  // the game (tens of MB). Players already in a match are unaffected.
  if (bandwidth.over && ext === '.html') {
    const page = OVER_CAPACITY_PAGE;
    res.writeHead(503, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'retry-after': '86400' });
    res.end(req.method === 'HEAD' ? undefined : page);
    return;
  }
  // Cache policy. Only FINGERPRINTED files (Vite's `name-[hash].js`) may be
  // cached forever: their URL changes when their content does. The game's
  // models and textures share the /assets prefix but keep their names across
  // rebuilds — "immutable" on those meant a rebuilt asset never reached a
  // returning player. They get a short life plus an ETag, so a check costs a
  // 304 and a few bytes, and a CDN in front may keep serving them meanwhile.
  // index.html must always be checked, or a deploy would never be picked up.
  const fingerprinted = /-[A-Za-z0-9_-]{8,}\.(js|css|wasm)$/.test(target);
  const cacheControl =
    ext === '.html'
      ? 'no-cache'
      : fingerprinted
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=3600, stale-while-revalidate=604800';
  const size = Number(info.size);
  const etag = `"${size.toString(36)}-${Math.floor(Number(info.mtimeMs)).toString(36)}"`;
  const headers = {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'cache-control': cacheControl,
    etag,
    'last-modified': info.mtime.toUTCString(),
    'x-content-type-options': 'nosniff',
  };
  if (req.headers['if-none-match'] === etag) {
    res.writeHead(304, headers);
    res.end();
    return;
  }
  res.writeHead(200, { ...headers, 'content-length': size });
  if (req.method === 'HEAD') {
    res.end();
    return;
  }
  // Streamed, not read whole: several players loading 10 MB files at once
  // would otherwise all sit in memory on a 1 GB server.
  createReadStream(target).on('error', () => res.destroy()).pipe(res);
}

/** Resolve a URL path inside `root`, refusing anything that escapes it. */
function safeJoin(root: string, urlPath: string): string | null {
  let decoded: string;
  try {
    decoded = decodeURIComponent(urlPath.split('?')[0].split('#')[0]);
  } catch {
    return null; // malformed escape
  }
  const full = resolve(root, '.' + normalize(decoded));
  if (full !== root && !full.startsWith(root + sep)) return null;
  return full;
}

async function statOrNull(path: string): Promise<Awaited<ReturnType<typeof stat>> | null> {
  try {
    return await stat(path);
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------ shutdown

let closing = false;
const shutdown = (): void => {
  if (closing) return;
  closing = true;
  console.log('\n[yovnok] shutting down');
  rooms.stop();
  // Stop accepting new connections, then let in-flight ones close.
  wss.close();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket or a keep-alive connection.
  setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

/** Shown instead of the game when the month's bandwidth budget is spent. */
const OVER_CAPACITY_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1"><title>YOVNOK — back soon</title>
<style>body{margin:0;min-height:100vh;display:grid;place-items:center;background:#050608;color:#e8edf2;
font:14px ui-monospace,Menlo,monospace;text-align:center;padding:24px}h1{letter-spacing:.3em;font-size:22px}
p{opacity:.65;line-height:1.7;max-width:420px}</style></head><body><div><h1>PLEASE STAND BY</h1>
<p>So many people played YOVNOK this month that the broadcast has reached its limit.
It will be back on the 1st — thank you for watching.</p></div></body></html>`;
