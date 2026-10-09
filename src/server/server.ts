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
 * Deployment shape (see `DEPLOY.md`): one process is one ROOM. That is enough
 * for a first release — a solo room holds up to 30 players — and room sharding
 * is a later change to the transport layer, not to the simulation.
 */

import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { WebSocketServer } from 'ws';
import { NET, TICK } from '../shared/config';
import { WS_PATH } from '../shared/protocol';
import { Room } from './room';

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

const room = new Room();
room.start();

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

const wss = new WebSocketServer({
  server,
  path: WS_PATH,
  verifyClient: (info: { origin?: string }) => originAllowed(info.origin),
});

wss.on('connection', (socket) => {
  room.addClient(socket);
});

server.on('error', (error: NodeJS.ErrnoException) => {
  if (error.code === 'EADDRINUSE') {
    console.error(`[convoy] port ${port} is already in use — is another server running?`);
  } else {
    console.error(`[convoy] server error:`, error);
  }
  process.exit(1);
});

server.listen(port, host, () => {
  const where = host === '0.0.0.0' ? 'localhost' : host;
  console.log(`[convoy] listening on ${host}:${port} (http://${where}:${port})`);
  console.log(`[convoy] websocket  ws://${where}:${port}${WS_PATH}`);
  console.log(
    `[convoy] simulate ${TICK.rate}Hz · snapshot ${NET.snapshotRate}Hz · interp delay ${NET.interpDelayMs}ms`,
  );
  void probeDist();
  if (ALLOWED_ORIGINS.length > 0) {
    console.log(`[convoy] origins allowed: ${ALLOWED_ORIGINS.join(', ')}`);
  }
});

/** Say once whether the built client is present; dev serves it from Vite. */
async function probeDist(): Promise<void> {
  try {
    await stat(join(DIST, 'index.html'));
    console.log(`[convoy] serving built client from ${DIST}`);
  } catch {
    console.log(
      '[convoy] no built client in dist/ — API-only. Run `npm run build`, or use `npm run dev` (Vite serves the client).',
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
    const body = JSON.stringify({ ok: true, uptime: Math.round(process.uptime()), ...room.health() });
    res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      'content-length': Buffer.byteLength(body),
    });
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
  const data = await readFile(target);
  // Vite fingerprints everything under /assets, so it can be cached forever;
  // index.html must not be, or a deploy would never be picked up.
  const cacheControl =
    ext === '.html'
      ? 'no-cache'
      : url.startsWith('/assets/')
        ? 'public, max-age=31536000, immutable'
        : 'public, max-age=86400';
  res.writeHead(200, {
    'content-type': MIME[ext] ?? 'application/octet-stream',
    'content-length': data.length,
    'cache-control': cacheControl,
    'x-content-type-options': 'nosniff',
  });
  res.end(req.method === 'HEAD' ? undefined : data);
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
  console.log('\n[convoy] shutting down');
  room.stop();
  // Stop accepting new connections, then let in-flight ones close.
  wss.close();
  server.close(() => process.exit(0));
  // Don't hang forever on a stuck socket or a keep-alive connection.
  setTimeout(() => process.exit(0), 1500).unref();
};

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
