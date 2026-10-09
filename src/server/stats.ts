/**
 * Game statistics: what the game records, and the /stats page that shows it.
 *
 * PRIVACY FIRST. Stored: an event kind, a time, a VISITOR ID — a salted hash of
 * the random per-browser token the game already uses for rejoin (so a returning
 * browser can be recognised, but no token, IP address or name is ever kept) —
 * a two-letter country (from Cloudflare's header, when behind it), and a few
 * numbers about the event. Nothing else.
 *
 *   visit    a page connected (the title asked whether a car is held)
 *   join     a player pressed PLAY (input: mouse/gamepad/touch; quality)
 *   rejoin   a player took back a held car
 *   left     a player closed or left a live match
 *   result   a player's finish at the end of a match (placement, kills)
 *   match    a match ended (minutes, players, bots, whether a human won)
 *   load     once a minute: players connected and rooms running
 *
 * Stored in SQLite (Node's built-in node:sqlite) under DATA_DIR, which on the
 * server is a volume that survives deploys. The page needs STATS_PASSWORD
 * (HTTP basic auth, any user name); without it /stats does not exist.
 */

import { createHash, timingSafeEqual } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { IncomingMessage, ServerResponse } from 'node:http';

const DATA_DIR = process.env.DATA_DIR ?? join(process.cwd(), 'data');
const PASSWORD = process.env.STATS_PASSWORD ?? '';
/** Mixed into visitor hashes, so a leaked database cannot be matched to tokens. */
const SALT = process.env.STATS_SALT ?? 'convoy';

type Row = Record<string, number | string | null>;
type Db = {
  exec(sql: string): void;
  prepare(sql: string): { run(...args: unknown[]): unknown; all(...args: unknown[]): Row[] };
};

let db: Db | null = null;
let insert: { run(...args: unknown[]): unknown } | null = null;

/** Open (or create) the database. Statistics are optional: failures only log. */
export async function openStats(): Promise<void> {
  try {
    const { DatabaseSync } = (await import('node:sqlite')) as unknown as {
      DatabaseSync: new (path: string) => Db;
    };
    mkdirSync(DATA_DIR, { recursive: true });
    db = new DatabaseSync(join(DATA_DIR, 'stats.db'));
    db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS events (
        ts INTEGER NOT NULL,
        day TEXT NOT NULL,
        kind TEXT NOT NULL,
        visitor TEXT,
        country TEXT,
        data TEXT
      );
      CREATE INDEX IF NOT EXISTS events_day_kind ON events (day, kind);
    `);
    insert = db.prepare('INSERT INTO events (ts, day, kind, visitor, country, data) VALUES (?, ?, ?, ?, ?, ?)');
    console.log(`[stats] recording to ${join(DATA_DIR, 'stats.db')}${PASSWORD ? '' : ' (no STATS_PASSWORD: /stats is off)'}`);
  } catch (error) {
    db = null;
    console.warn('[stats] statistics are off:', (error as Error).message);
  }
}

/** The stored visitor id for a browser token: salted, hashed, shortened. */
export function visitorId(token: string | null | undefined): string | null {
  if (!token) return null;
  return createHash('sha256').update(`${SALT}:${token}`).digest('hex').slice(0, 16);
}

export function record(kind: string, token: string | null, country: string | null, data: Record<string, unknown> = {}): void {
  if (!insert) return;
  const now = new Date();
  try {
    insert.run(now.getTime(), now.toISOString().slice(0, 10), kind, visitorId(token), country, JSON.stringify(data));
  } catch {
    // Never let statistics break the game.
  }
}

/** Two-letter country from Cloudflare, when the request came through it. */
export function countryOf(req: IncomingMessage): string | null {
  const c = req.headers['cf-ipcountry'];
  return typeof c === 'string' && /^[A-Z]{2}$/.test(c) && c !== 'XX' ? c : null;
}

// ---------------------------------------------------------------- the page

function authorised(req: IncomingMessage): boolean {
  const header = req.headers.authorization ?? '';
  if (!header.startsWith('Basic ')) return false;
  const given = Buffer.from(header.slice(6), 'base64').toString('utf8').split(':').slice(1).join(':');
  const a = Buffer.from(given);
  const b = Buffer.from(PASSWORD);
  return a.length === b.length && timingSafeEqual(a, b);
}

const esc = (v: unknown): string =>
  String(v ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);

function table(title: string, head: string[], rows: unknown[][]): string {
  return `<h2>${esc(title)}</h2><table><tr>${head.map((h) => `<th>${esc(h)}</th>`).join('')}</tr>${rows
    .map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join('')}</tr>`)
    .join('')}</table>`;
}

/** Serve /stats. Returns true when it handled the request. */
export function serveStats(req: IncomingMessage, res: ServerResponse): boolean {
  const path = (req.url ?? '').split('?')[0];
  if (path !== '/stats') return false;
  if (!PASSWORD || !db) {
    res.writeHead(404, { 'content-type': 'text/plain' });
    res.end('not found');
    return true;
  }
  if (!authorised(req)) {
    res.writeHead(401, { 'www-authenticate': 'Basic realm="YOVNOK stats"', 'content-type': 'text/plain' });
    res.end('password required');
    return true;
  }

  const since = new Date(Date.now() - 30 * 86400_000).toISOString().slice(0, 10);
  const q = (sql: string, ...args: unknown[]): Row[] => db!.prepare(sql).all(...args);

  const daily = q(
    `SELECT day,
       COUNT(DISTINCT CASE WHEN kind = 'visit' THEN visitor END) AS visitors,
       COUNT(DISTINCT CASE WHEN kind = 'join' THEN visitor END) AS players,
       SUM(kind = 'join') AS plays,
       SUM(kind = 'match') AS matches,
       ROUND(AVG(CASE WHEN kind = 'match' THEN json_extract(data, '$.minutes') END), 1) AS avg_match_min,
       MAX(CASE WHEN kind = 'load' THEN json_extract(data, '$.players') END) AS peak_players,
       SUM(kind = 'rejoin') AS rejoins,
       SUM(kind = 'left') AS left_mid_match
     FROM events WHERE day >= ? GROUP BY day ORDER BY day DESC`,
    since,
  );
  const returning = q(
    `SELECT COUNT(DISTINCT visitor) AS n FROM events e
     WHERE kind = 'visit' AND day >= ? AND visitor IS NOT NULL
       AND EXISTS (SELECT 1 FROM events o WHERE o.visitor = e.visitor AND o.day < e.day)`,
    since,
  )[0]?.n;
  const totalVisitors = q(`SELECT COUNT(DISTINCT visitor) AS n FROM events WHERE kind = 'visit' AND day >= ?`, since)[0]?.n;
  const countries = q(
    `SELECT COALESCE(country, '—') AS country, COUNT(DISTINCT visitor) AS visitors
     FROM events WHERE kind = 'visit' AND day >= ? GROUP BY country ORDER BY visitors DESC LIMIT 15`,
    since,
  );
  const inputs = q(
    `SELECT json_extract(data, '$.input') AS input, COUNT(*) AS plays
     FROM events WHERE kind = 'join' AND day >= ? GROUP BY input ORDER BY plays DESC`,
    since,
  );
  const results = q(
    `SELECT COUNT(*) AS finishes, SUM(json_extract(data, '$.placement') = 1) AS wins,
       ROUND(AVG(json_extract(data, '$.placement')), 1) AS avg_place,
       ROUND(AVG(json_extract(data, '$.kills')), 2) AS avg_kills
     FROM events WHERE kind = 'result' AND day >= ?`,
    since,
  )[0];

  const body = `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>YOVNOK stats</title><style>
body{font:13px ui-monospace,Menlo,monospace;background:#0a0b0e;color:#e8edf2;margin:24px;max-width:1000px}
h1{letter-spacing:4px}h2{margin-top:28px;font-size:13px;letter-spacing:3px;color:#ff8a3d}
table{border-collapse:collapse;width:100%}th,td{padding:5px 10px;border-bottom:1px solid #222;text-align:right}
th:first-child,td:first-child{text-align:left}th{opacity:.6;font-weight:400}.note{opacity:.55;margin-top:24px;line-height:1.6}
</style></head><body><h1>YOVNOK · STATS</h1>
<p>Last 30 days · ${esc(totalVisitors ?? 0)} visitors, ${esc(returning ?? 0)} of them returning ·
${esc(results?.finishes ?? 0)} finishes by players, ${esc(results?.wins ?? 0)} won · average place ${esc(results?.avg_place ?? '—')} · average kills ${esc(results?.avg_kills ?? '—')}</p>
${table('BY DAY', ['day', 'visitors', 'players', 'plays', 'matches', 'avg match (min)', 'peak online', 'rejoins', 'left mid-match'], daily.map((r) => [r.day, r.visitors, r.players, r.plays, r.matches, r.avg_match_min ?? '—', r.peak_players ?? '—', r.rejoins, r.left_mid_match]))}
${table('COUNTRIES (visitors)', ['country', 'visitors'], countries.map((r) => [r.country, r.visitors]))}
${table('INPUT (plays)', ['input', 'plays'], inputs.map((r) => [r.input ?? 'unknown', r.plays]))}
<p class="note">Visitors are counted by a salted hash of the game's random per-browser id: no IP addresses, names or
accounts are stored. Country comes from Cloudflare. A visitor who clears their browser data counts as new.</p>
</body></html>`;
  res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store', 'x-robots-tag': 'noindex' });
  res.end(body);
  return true;
}
