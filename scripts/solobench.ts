/**
 * Solo-mode benchmark — a tuning diagnostic, not a pass/fail test.
 *
 * "Eight bots resolve a field in under a minute" was an observation from a
 * screenshot, not a measurement. This runs REAL matches (the real room, the real
 * weapons, the real bot brain) with an idle observer, and prints the numbers
 * that tuning actually moves:
 *
 *   - match length (live → last car standing)
 *   - time to the first elimination, and the alive curve
 *   - bot accuracy (hits / shots) and engagement range
 *   - per-car survival
 *
 * The observer is a human who never touches the controls, so it is a sitting
 * duck and dies early — that is fine; the bots fighting each other is the
 * measurement. An observer is needed only because the room will not start a
 * match with no humans at all.
 *
 *   npm run solobench
 *   RUNS=5 CARS=8 npm run solobench
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { MATCH } from '../src/shared/config';

const PORT = Number(process.env.PORT ?? 8599);
const RUNS = Number(process.env.RUNS ?? 2);
const CARS = Number(process.env.CARS ?? MATCH.soloCars);
const MAX_MATCH_MS = Number(process.env.MAX_MATCH_MS ?? 150_000);
const URL = `ws://localhost:${PORT}/ws`;

// Own process group: killing `npx` alone leaves the node server holding the
// port (and this script's event loop) alive. See matchtest's `stop`.
const server = spawn('npx', ['tsx', 'src/server/server.ts'], {
  detached: true,
  env: {
    ...process.env,
    PORT: String(PORT),
    DEV_ASSIGN: '1',
    MODE: 'solo',
    BOTS: 'fill',
    BENCH_STATS: '1',
    SOLO_CARS: String(CARS),
    SOLO_MIN_PLAYERS: '2',
    MATCH_COUNTDOWN_SECONDS: '2',
    // No clock, matching the mode: a match ends by elimination, and the bench's
    // own cap is what stops a stalemate.
    MATCH_TIME_SECONDS: '0',
    MATCH_RESULTS_SECONDS: '10',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  // Chunks do not end on line boundaries: carry the partial last line over, or
  // a long line (the [bench] damage JSON) arrives in two halves and is lost.
  let partial = '';
  stream?.on('data', (buf) => {
    const lines = (partial + String(buf)).split('\n');
    partial = lines.pop() ?? '';
    for (const line of lines) if (line.trim()) serverLog.push(line.trim());
  });
}

type Vehicle = { crew: number; hull: number; dead: boolean; x: number; z: number };
type Shot = { by: number; ox: number; oz: number; ex: number; ez: number; hitCrew: number | null; hitPlayer: number | null };
type Snap = {
  time: number;
  vehicles: Vehicle[];
  shots: Shot[];
  match: { phase: string; alive: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** One match's worth of observations. */
type MatchStats = {
  liveMs: number;
  endMs: number;
  firstKillMs: number;
  shots: number;
  hits: number;
  hitDistances: number[];
  aliveMin: number;
  deadOrder: number[];
};

class Observer {
  latest: Snap | null = null;
  id = -1;
  private constructor(readonly socket: WebSocket) {}
  static connect(): Promise<Observer> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(URL);
      const o = new Observer(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'welcome') {
          o.id = msg.id;
          resolve(o);
        } else if (msg.t === 'snap') {
          o.latest = msg as Snap;
        }
      });
      socket.once('open', () => socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew: 0 })));
      socket.once('error', reject);
    });
  }
  ready(): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify({ t: 'ready' }));
  }
}

const waitFor = async (predicate: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(20);
  }
  return predicate();
};

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)];
}

/** Watch one match from live to results, polling snapshots. */
async function runMatch(o: Observer, index: number): Promise<MatchStats | null> {
  const live = await waitFor(() => o.latest?.match.phase === 'live', 15_000);
  if (!live) {
    console.log(`  match ${index + 1}: never reached live`);
    return null;
  }
  const t0 = Date.now();
  const stats: MatchStats = {
    liveMs: 0,
    endMs: 0,
    firstKillMs: -1,
    shots: 0,
    hits: 0,
    hitDistances: [],
    aliveMin: CARS,
    deadOrder: [],
  };

  const seenDead = new Set<number>();
  // Shots are one-tick events carried by one snapshot. Polling faster than the
  // 30 Hz snapshot rate means the same snapshot is read more than once, so
  // process each snapshot's shots exactly once, keyed by its server time.
  let lastSnapTime = -1;

  while (Date.now() - t0 < MAX_MATCH_MS) {
    const snap = o.latest;
    if (snap) {
      if (snap.match.alive < stats.aliveMin) stats.aliveMin = snap.match.alive;

      if (snap.time !== lastSnapTime) {
        lastSnapTime = snap.time;
        for (const s of snap.shots ?? []) {
          stats.shots++;
          if (s.hitCrew !== null || s.hitPlayer !== null) {
            stats.hits++;
            stats.hitDistances.push(Math.hypot(s.ex - s.ox, s.ez - s.oz));
          }
        }
      }

      for (const v of snap.vehicles) {
        if (v.dead && !seenDead.has(v.crew)) {
          seenDead.add(v.crew);
          const elapsed = Date.now() - t0;
          stats.deadOrder.push(elapsed);
          if (stats.firstKillMs < 0) stats.firstKillMs = elapsed;
        }
      }

      if (snap.match.phase === 'results') {
        stats.endMs = Date.now() - t0;
        stats.liveMs = Date.now() - t0;
        break;
      }
    }
    await sleep(20);
  }

  if (stats.endMs === 0) {
    console.log(`  match ${index + 1}: timed out after ${(MAX_MATCH_MS / 1000).toFixed(0)}s`);
    stats.endMs = MAX_MATCH_MS;
  }
  return stats;
}

try {
  await sleep(1400);
  console.log(`\n=== solo bench: ${CARS} cars, ${RUNS} match(es) ===`);
  const observer = await Observer.connect();
  await waitFor(() => observer.latest !== null, 5000);

  const all: MatchStats[] = [];
  for (let i = 0; i < RUNS; i++) {
    const stats = await runMatch(observer, i);
    if (!stats) continue;
    all.push(stats);
    const acc = stats.shots ? ((stats.hits / stats.shots) * 100).toFixed(0) : '—';
    console.log(
      `  match ${i + 1}: length ${(stats.endMs / 1000).toFixed(1)}s · ` +
        `first kill ${(stats.firstKillMs / 1000).toFixed(1)}s · ` +
        `shots ${stats.shots} · hits ${stats.hits} (${acc}%) · ` +
        `median hit range ${median(stats.hitDistances).toFixed(0)}m`,
    );
    // A match that hit the cap is still running; starting the next run now would
    // measure a match already in progress. Only rematch after a real ending.
    if (stats.endMs >= MAX_MATCH_MS) {
      console.log('  (match did not end within the cap — not rematching)');
      break;
    }
    if (i < RUNS - 1) {
      observer.ready();
      const back = await waitFor(() => observer.latest?.match.phase === 'live', 20_000);
      if (!back) {
        console.log('  (no rematch; stopping)');
        break;
      }
    }
  }

  if (all.length > 0) {
    const avg = (f: (s: MatchStats) => number) => all.reduce((a, s) => a + f(s), 0) / all.length;
    console.log('\n--- aggregate ---');
    console.log(`  matches                 ${all.length}`);
    console.log(`  mean length             ${(avg((s) => s.endMs) / 1000).toFixed(1)}s`);
    console.log(`  mean time to first kill ${(avg((s) => s.firstKillMs) / 1000).toFixed(1)}s`);
    console.log(`  mean eliminations/match ${avg((s) => s.deadOrder.length).toFixed(1)} of ${CARS}`);
    console.log(`  mean accuracy           ${((avg((s) => s.hits) / Math.max(1, avg((s) => s.shots))) * 100).toFixed(0)}%`);
    console.log(`  mean hit range          ${median(all.flatMap((s) => s.hitDistances)).toFixed(0)}m`);
  }

  // What did the killing: the server's own per-source damage (all hits, not the
  // observer's interest-culled sample of shots).
  const totals: Record<string, { damage: number; kills: number }> = {};
  for (const line of serverLog) {
    const m = /\[bench\] damage (.*)$/.exec(line);
    if (!m) continue;
    for (const [source, v] of Object.entries(JSON.parse(m[1]) as typeof totals)) {
      const t = (totals[source] ??= { damage: 0, kills: 0 });
      t.damage += v.damage;
      t.kills += v.kills;
    }
  }
  const zoneKills = serverLog.filter((l) => l.includes('[bench] zone-kill'));
  if (zoneKills.length > 0) {
    console.log('\n--- zone kills ---');
    for (const line of zoneKills) console.log(`  ${line.slice(line.indexOf('zone-kill'))}`);
  }
  const tallies = serverLog.filter((l) => l.includes('[bench] damage')).length;
  console.log(`\n  (${tallies} per-match damage tallies from the server)`);
  const allDamage = Object.values(totals).reduce((a, t) => a + t.damage, 0) || 1;
  if (Object.keys(totals).length > 0) {
    console.log('\n--- damage by source (all matches) ---');
    for (const [source, t] of Object.entries(totals).sort((a, b) => b[1].damage - a[1].damage)) {
      console.log(`  ${source.padEnd(14)} ${((t.damage / allDamage) * 100).toFixed(0).padStart(3)}% of damage · ${t.kills} finishing blows`);
    }
  }

  observer.socket.close();
} catch (error) {
  console.log(`\n  bench threw: ${String(error)}`);
  for (const line of serverLog.slice(-25)) console.log(`    server: ${line}`);
} finally {
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}
