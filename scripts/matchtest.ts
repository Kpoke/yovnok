/**
 * Match flow checks (M7).
 *
 * Two halves, because "the rules are right" and "the room runs the rules" are
 * different claims:
 *
 *   1. The pure state machine in `shared/match.ts`. Fast, deterministic, and
 *      the place to prove the awkward cases — sudden death, a tie at the
 *      whistle, a kill scored in the wrong phase.
 *   2. A real server, two real clients, and short clocks, to prove the room
 *      wires those rules to sockets, score, respawn and the rematch vote.
 *
 * The room half uses the dev kill hook (`devKill`) so it can score without a
 * twenty-second shooting phase. Combat itself is `combattest`.
 *
 *   npm run matchtest
 */

import { spawn, type ChildProcess } from 'node:child_process';
import { WebSocket } from 'ws';
import {
  beginCountdown,
  createMatchState,
  enoughPlayers,
  finishMatch,
  leadingTeams,
  matchRules,
  matchSnapshotOf,
  registerElimination,
  registerKill,
  tickMatch,
  type MatchRules,
  type MatchState,
} from '../src/shared/match';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ------------------------------------------------------------------ 1. rules

console.log('\n=== 1. the match state machine ===');

/** Rules shrunk to seconds so the unit tests read as transitions, not clocks. */
const RULES: MatchRules = matchRules(4, {
  killTarget: 3,
  timeLimitSeconds: 10,
  countdownSeconds: 5,
  resultsSeconds: 10,
  suddenDeathSeconds: 30,
  minPlayersPerTeam: 1,
});

const fresh = (): MatchState => createMatchState(2);

{
  check('an empty lobby does not start', !enoughPlayers([], RULES));
  check('one team alone does not start', !enoughPlayers([1, 0], RULES));
  check('one player per team is enough', enoughPlayers([1, 1], RULES));
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [2, 0]);
  check('a lopsided lobby waits', m.phase === 'lobby');

  tickMatch(m, 100, RULES, [2, 2]);
  check('both teams present opens the countdown', m.phase === 'countdown', `endsAt ${m.endsAt}`);
  check('the countdown is the configured length', m.endsAt === 100 + RULES.countdownSeconds * 1000);
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 100, RULES, [0, 1]);
  check('losing a team mid-countdown drops back to the lobby', m.phase === 'lobby');
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, RULES.countdownSeconds * 1000, RULES, [1, 1]);
  check('the countdown hands over to live', m.phase === 'live');
  check('regulation is the configured length', m.endsAt === 5000 + RULES.timeLimitSeconds * 1000);
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]); // live, ends 15000
  m.scores[1] = 2;
  tickMatch(m, 15000, RULES, [1, 1]);
  check('regulation expiring with a leader ends it', m.phase === 'results');
  check('the leader wins', m.winner === 1, `winner ${m.winner}`);
  check('and the reason is the clock', m.reason === 'time');
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]); // live
  m.scores[0] = 4;
  m.scores[1] = 4;
  tickMatch(m, 15000, RULES, [1, 1]);
  check('a tied regulation opens sudden death', m.suddenDeath && m.phase === 'live');
  check(
    'and extends the clock by the tie-break length',
    m.endsAt === 15000 + RULES.suddenDeathSeconds * 1000,
  );

  tickMatch(m, m.endsAt, RULES, [1, 1]);
  check('sudden death expiring still tied is a draw', m.phase === 'results' && m.winner === null);
  check('and says so as a time result', m.reason === 'time');
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]);
  const ended = registerKill(m, 0, 6000, RULES);
  check('a kill in regulation only scores', !ended && m.scores[0] === 1, `score ${m.scores[0]}`);
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]); // countdown
  const ended = registerKill(m, 0, 1000, RULES);
  check('a kill during the countdown scores nothing', !ended && m.scores[0] === 0);
}

{
  const m = fresh();
  check('a kill in the lobby scores nothing', !registerKill(m, 0, 0, RULES));
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]);
  registerKill(m, 0, 5001, RULES);
  registerKill(m, 0, 5002, RULES);
  const ended = registerKill(m, 0, 5003, RULES);
  check('reaching the kill target ends the match early', ended && m.phase === 'results');
  check('with the scorer as winner', m.winner === 0);
  check('and the mercy reason', m.reason === 'kill-target');
  check('a kill after the end does not move the board', !registerKill(m, 1, 6000, RULES) && m.scores[1] === 0);
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]);
  m.scores[0] = 2;
  m.scores[1] = 2;
  tickMatch(m, 15000, RULES, [1, 1]); // sudden death
  const ended = registerKill(m, 1, 16000, RULES);
  check('a sudden-death kill ends it immediately', ended && m.phase === 'results');
  check('for the team that scored', m.winner === 1 && m.reason === 'sudden-death');
}

{
  const m = fresh();
  tickMatch(m, 0, RULES, [1, 1]);
  tickMatch(m, 5000, RULES, [1, 1]);
  m.scores[0] = 1;
  finishMatch(m, 0, 'time', 20000, RULES);
  const snap = matchSnapshotOf(m, 12000, 1, 3, 2);
  check('the snapshot reports the phase', snap.phase === 'results');
  check('and the remaining time', snap.remainingMs === 20000 + RULES.resultsSeconds * 1000 - 12000);
  check('and the vote progress', snap.ready === 1 && snap.players === 3);
}

{
  const m = fresh();
  m.scores[0] = 5;
  m.scores[1] = 2;
  beginCountdown(m, 1000, RULES);
  check('a rematch clears the board', m.phase === 'countdown' && m.scores[0] === 0 && m.scores[1] === 0);
  check('and drops the previous winner', m.winner === null && m.reason === null);
}

{
  check('ties are detected', leadingTeams([2, 2]).length === 2);
  check('a clear leader is alone', leadingTeams([3, 1]).length === 1);
}

console.log('\n=== 1b. solo (one-man team) rules ===');

/** Eight one-man teams, a believable countdown, short clocks. */
const SOLO: MatchRules = matchRules(1, {
  timeLimitSeconds: 10,
  countdownSeconds: 5,
  resultsSeconds: 10,
  suddenDeathSeconds: 30,
  minPlayers: 3,
});
const solo = (): MatchState => createMatchState(8, 'solo');
/** A solo match already live, for elimination checks. */
const soloLive = (): MatchState => {
  const state = solo();
  state.phase = 'live';
  return state;
};

{
  check('solo derives its mode from a one-man crew', SOLO.mode === 'solo');
  check('and has no kill target to reach', !Number.isFinite(SOLO.killTarget));
  check('an empty field does not start', !enoughPlayers([0, 0, 0], SOLO));
  check('nor does one car', !enoughPlayers([1, 0, 0], SOLO));
  check('three cars is enough', enoughPlayers([1, 1, 1], SOLO));
  check(
    'the empty teams beyond the field do not block it',
    enoughPlayers([1, 1, 1, 0, 0, 0, 0, 0], SOLO),
  );
}

{
  const m = solo();
  tickMatch(m, 0, SOLO, [1, 1, 1, 0, 0, 0, 0, 0]);
  check('solo runs the same countdown', m.phase === 'countdown');
  tickMatch(m, SOLO.countdownSeconds * 1000, SOLO, [1, 1, 1, 0, 0, 0, 0, 0]);
  check('and the same handover to live', m.phase === 'live');

  // One life: a kill scores but never ends a match on its own.
  const ended = registerKill(m, 0, 100, SOLO);
  check('a kill scores without ending a last-standing match', !ended && m.scores[0] === 1);
}

{
  // Solo has no clock by default: the match ends by elimination, never on time.
  const noLimit = matchRules(1);
  check('solo defaults to no time limit', noLimit.timeLimitSeconds === 0);

  const m = createMatchState(8, 'solo');
  const counts = [1, 1, 1, 0, 0, 0, 0, 0];
  tickMatch(m, 0, noLimit, counts);
  tickMatch(m, noLimit.countdownSeconds * 1000, noLimit, counts);
  check('and goes live with no end time', m.phase === 'live' && m.endsAt === 0);
  tickMatch(m, 10_000_000, noLimit, counts);
  check('and a day later is still going', m.phase === 'live');
}

{
  const m = soloLive();
  check('three cars left is not the end', !registerElimination(m, 3, null, 0, SOLO));
  check('one car left wins', registerElimination(m, 1, 4, 0, SOLO) && m.phase === 'results');
  check('for the survivor', m.winner === 4 && m.reason === 'last-standing');
}

{
  const m = soloLive();
  check('nobody left is a draw', registerElimination(m, 0, null, 0, SOLO) && m.winner === null);
  check('still reported as a last-standing result', m.reason === 'last-standing');
}

{
  const m = soloLive();
  registerElimination(m, 2, null, 0, SOLO);
  check('elimination does nothing while two cars remain', m.phase === 'live');
}

{
  // The duel rules must NOT end on an elimination, or a 2v2 would stop the first
  // time anyone died.
  const m = createMatchState(2, 'duel');
  m.phase = 'live';
  check('an elimination means nothing in a duel', !registerElimination(m, 1, 0, 0, RULES));
}

// -------------------------------------------------------------- 2. the room

const PORT = Number(process.env.PORT ?? 8399);
const URL = `ws://localhost:${PORT}/ws`;

/**
 * Stop a spawned server. Killing the `npx` wrapper alone leaves the actual node
 * server running on its port, and the NEXT run then fails with EADDRINUSE — so
 * kill the whole process group (they are spawned `detached`).
 */
function stop(child: ChildProcess | undefined | null): void {
  if (!child?.pid) return;
  try {
    process.kill(-child.pid, 'SIGTERM');
  } catch {
    child.kill('SIGTERM');
  }
}

const server = spawn('npx', ['tsx', 'src/server/server.ts'], {
  // Own process group, so `stop` takes down npx AND the node server under it.
  detached: true,
  env: {
    ...process.env,
    PORT: String(PORT),
    DEV_ASSIGN: '1',
    // Short clocks so the whole lifecycle runs in seconds.
    MATCH_COUNTDOWN_SECONDS: '1',
    MATCH_TIME_SECONDS: '3',
    MATCH_SUDDEN_DEATH_SECONDS: '2',
    MATCH_RESULTS_SECONDS: '3',
    MATCH_RESPAWN_SECONDS: '1',
    MATCH_KILL_TARGET: '5',
    MATCH_MIN_TEAM_PLAYERS: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', (buf) => {
    for (const line of String(buf).split('\n')) if (line.trim()) serverLog.push(line.trim());
  });
}

type VehicleRow = {
  crew: number;
  cls: string;
  dead: boolean;
  respawnIn: number;
  placement: number | null;
  look: number;
  x: number;
  z: number;
};
type Snap = {
  vehicles: VehicleRow[];
  members: Array<{ id: number; crew: number; seat: string }>;
  shots: Array<{ by: number }>;
  kills: Array<{ byCrew: number | null; victimCrew: number }>;
  crates: Array<{ id: number; x: number; z: number; ready: boolean; salvage: boolean }>;
  zone: { x: number; z: number; radius: number } | null;
  match: {
    mode: string;
    phase: string;
    remainingMs: number;
    scores: number[];
    winner: number | null;
    reason: string | null;
    suddenDeath: boolean;
    alive: number;
    ready: number;
    players: number;
    roster: number;
  };
};

class Client {
  readonly socket: WebSocket;
  id = -1;
  latest: Snap | null = null;
  /** Every shot seen, so a test can prove the zone, not combat, did the work. */
  shots = 0;
  /** Every kill-feed entry seen. */
  readonly kills: Array<{ byCrew: number | null; victimCrew: number }> = [];
  private seq = 0;

  private constructor(socket: WebSocket) {
    this.socket = socket;
  }

  static connect(url: string, crew: number, seat: string, look?: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url);
      const client = new Client(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'welcome') {
          client.id = msg.id;
          resolve(client);
        } else if (msg.t === 'snap') {
          client.latest = msg as Snap;
          client.shots += msg.shots?.length ?? 0;
          for (const kill of msg.kills ?? []) client.kills.push(kill);
        }
      });
      socket.once('open', () =>
        socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew, seat, look })),
      );
      socket.once('error', reject);
    });
  }

  send(payload: unknown): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  drive(throttle: number): void {
    this.seq++;
    this.send({
      t: 'input',
      cmds: [{ seq: this.seq, throttle, steer: 0, handbrake: false, boost: false }],
    });
  }

  vehicle(crew: number): VehicleRow | undefined {
    return this.latest?.vehicles.find((v) => v.crew === crew);
  }

  get phase(): string {
    return this.latest?.match.phase ?? 'none';
  }
}

const waitFor = async (predicate: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(25);
  }
  return predicate();
};

/** The solo room, spawned later on its own port so both modes can be tested. */
let soloServer: ReturnType<typeof spawn> | null = null;
const soloLog: string[] = [];
/** A room with a fast, tiny zone, to prove the zone can end a match alone. */
let zoneServer: ReturnType<typeof spawn> | null = null;
const zoneLog: string[] = [];
/** A room with two crews pinned far apart, to prove interest management. */
let interestServer: ReturnType<typeof spawn> | null = null;
const interestLog: string[] = [];

try {
  await sleep(1400);

  console.log('\n=== 2. the room runs the lifecycle ===');

  const LOOK = 3 | (1 << 8) | (2 << 12);
  const a = await Client.connect(URL, 0, 'seat.driver', LOOK);
  await waitFor(() => a.latest !== null, 4000);
  // One client cannot start a duel — the lobby must wait for the other team.
  check('a lone player waits in the lobby', a.phase === 'lobby', `phase ${a.phase}`);
  // Cosmetics ride the wire (M12): the server relays the look it was given,
  // without ever reading it — the crew wears its driver's paint.
  const ownLook = a.vehicle(0)?.look;
  check('the server relays a player’s cosmetic look', ownLook === LOOK, `look ${ownLook}`);

  const b = await Client.connect(URL, 1, 'seat.driver');
  await waitFor(() => b.latest !== null, 4000);

  const sawCountdown = await waitFor(() => a.phase === 'countdown' || a.phase === 'live', 3000);
  check('a second team opens the countdown', sawCountdown, `phase ${a.phase}`);

  // Input during the countdown must not move the car.
  if (a.phase === 'countdown') {
    const before = a.vehicle(0);
    for (let i = 0; i < 12; i++) {
      a.drive(1);
      await sleep(20);
    }
    await sleep(120);
    const after = a.vehicle(0);
    const moved = before && after ? Math.hypot(after.x - before.x, after.z - before.z) : 99;
    check('the car is frozen during the countdown', moved < 0.5, `moved ${moved.toFixed(2)} m`);
  } else {
    check('the car is frozen during the countdown', false, `missed the countdown (phase ${a.phase})`);
  }

  const wentLive = await waitFor(() => a.phase === 'live', 3000);
  check('the countdown hands over to live', wentLive, `phase ${a.phase}`);

  // Score a kill through the dev hook, then watch the crew respawn together.
  a.send({ t: 'devKill', victim: 1, by: 0 });
  const scored = await waitFor(() => (a.latest?.match.scores[0] ?? 0) === 1, 2000);
  check('a destroyed vehicle scores for its killer', scored, `scores ${a.latest?.match.scores}`);
  check('and the victim is dead', a.vehicle(1)?.dead === true);
  check(
    'with a respawn countdown running',
    (a.vehicle(1)?.respawnIn ?? 0) > 0,
    `${a.vehicle(1)?.respawnIn?.toFixed(2)}s`,
  );

  const cameBack = await waitFor(() => a.vehicle(1)?.dead === false, 3000);
  check('the crew respawns together after the delay', cameBack);
  check('and the score stands', a.latest?.match.scores[0] === 1, `scores ${a.latest?.match.scores}`);

  const reachedResults = await waitFor(() => a.phase === 'results', 6000);
  check('regulation expiring ends the match', reachedResults, `phase ${a.phase}`);
  check('with the higher score winning', a.latest?.match.winner === 0, `winner ${a.latest?.match.winner}`);
  check('and the time reason', a.latest?.match.reason === 'time');

  // Rematch: everyone votes, crews stay together, the board resets.
  a.send({ t: 'ready' });
  await sleep(120);
  check('one vote is not enough', a.phase === 'results', `phase ${a.phase}`);
  b.send({ t: 'ready' });
  const restarted = await waitFor(() => a.phase === 'countdown' || a.phase === 'live', 2000);
  check('everyone voting starts the next match', restarted, `phase ${a.phase}`);
  const liveAgain = await waitFor(() => a.phase === 'live', 3000);
  check('the rematch reaches live', liveAgain, `phase ${a.phase}`);
  check('the board was reset', (a.latest?.match.scores[0] ?? -1) === 0 && a.latest?.match.scores[1] === 0);
  const stillCrew0 = a.latest?.members.find((m) => m.id === a.id)?.crew === 0;
  check('and crews were kept together', stillCrew0);

  a.socket.close();
  b.socket.close();

  // ------------------------------------------------ 3. solo: one life, last car
  console.log('\n=== 3. the room runs a solo match ===');

  const SOLO_PORT = PORT + 1;
  const SOLO_URL = `ws://localhost:${SOLO_PORT}/ws`;
  soloServer = spawn('npx', ['tsx', 'src/server/server.ts'], {
  // Own process group, so `stop` takes down npx AND the node server under it.
  detached: true,
    env: {
      ...process.env,
      PORT: String(SOLO_PORT),
      DEV_ASSIGN: '1',
      MODE: 'solo',
      SOLO_CARS: '4',
      SOLO_MIN_PLAYERS: '2',
      // This section counts cars and placements exactly, so it runs human-only.
      // Bot fill has its own test (`bottest`).
      BOTS: 'off',
      // Pinned CLOSE together: interest management (M10) culls distant crews, and
      // this section inspects all three cars directly. Spawn-ring spacing would
      // put crew 2 296 m from crew 0 — past the interest radius, deliberately.
      DEV_PLACE: '0:0,0,0|1:80,0,0|2:0,80,0',
      MATCH_COUNTDOWN_SECONDS: '1',
      MATCH_TIME_SECONDS: '30',
      MATCH_RESULTS_SECONDS: '8',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [soloServer.stdout, soloServer.stderr]) {
    stream?.on('data', (buf) => {
      for (const line of String(buf).split('\n')) if (line.trim()) soloLog.push(line.trim());
    });
  }
  await sleep(1400);

  const s1 = await Client.connect(SOLO_URL, 0, 'seat.driver');
  await waitFor(() => s1.latest !== null, 4000);
  check('a solo field uses the one-man car', s1.vehicle(0)?.cls === 'solo', `cls ${s1.vehicle(0)?.cls}`);
  check('and reports solo mode', s1.latest?.match.mode === 'solo', `mode ${s1.latest?.match.mode}`);
  check('a lone car waits in the lobby', s1.phase === 'lobby', `phase ${s1.phase}`);

  const s2 = await Client.connect(SOLO_URL, 1, 'seat.driver');
  const s3 = await Client.connect(SOLO_URL, 2, 'seat.driver');
  await waitFor(() => s2.latest !== null && s3.latest !== null, 4000);

  const soloLive = await waitFor(() => s1.phase === 'live', 5000);
  check('a solo match reaches live', soloLive, `phase ${s1.phase}`);
  check('with three cars alive', s1.latest?.match.alive === 3, `alive ${s1.latest?.match.alive}`);

  // One life: a kill takes a car out for the rest of the match.
  s1.send({ t: 'devKill', victim: 2, by: 0 });
  const firstOut = await waitFor(() => s1.vehicle(2)?.dead === true, 2000);
  check('a destroyed car is out', firstOut);
  check('and scores for its killer', s1.latest?.match.scores[0] === 1, `scores ${s1.latest?.match.scores}`);
  check(
    'its placing is recorded',
    s1.vehicle(2)?.placement === 3,
    `placement ${s1.vehicle(2)?.placement}`,
  );
  check('there is no respawn timer — one life', (s1.vehicle(2)?.respawnIn ?? -1) === 0);
  check(
    'and the kill feed reports it',
    s1.kills.some((k) => k.byCrew === 0 && k.victimCrew === 2),
    `${s1.kills.length} feed entries`,
  );
  // Wreck salvage (DESIGN.md §11): the wreck leaves a temporary resupply.
  const salvage = (s1.latest?.crates ?? []).filter((c) => c.salvage);
  check(
    'and the wreck leaves salvage',
    salvage.some((c) => Math.hypot(c.x - 0, c.z - 80) < 6),
    `${salvage.length} salvage piles`,
  );
  check('the field shrinks', s1.latest?.match.alive === 2, `alive ${s1.latest?.match.alive}`);

  s1.send({ t: 'devKill', victim: 1, by: 0 });
  const ended = await waitFor(() => s1.phase === 'results', 2000);
  check('the last car standing ends the match', ended, `phase ${s1.phase}`);
  check('for the survivor', s1.latest?.match.winner === 0, `winner ${s1.latest?.match.winner}`);
  check('and says why', s1.latest?.match.reason === 'last-standing');
  check(
    'the runner-up placed second',
    s1.vehicle(1)?.placement === 2,
    `placement ${s1.vehicle(1)?.placement}`,
  );

  // A rematch brings every car back.
  s1.send({ t: 'ready' });
  s2.send({ t: 'ready' });
  s3.send({ t: 'ready' });
  const soloAgain = await waitFor(() => s1.phase === 'live', 5000);
  check('a solo rematch reaches live', soloAgain, `phase ${s1.phase}`);
  check('the board is cleared', (s1.latest?.match.scores[0] ?? -1) === 0);
  check('and the field is whole again', s1.latest?.match.alive === 3, `alive ${s1.latest?.match.alive}`);

  s1.socket.close();
  s2.socket.close();
  s3.socket.close();

  // ------------------------------------------------ 4. the zone ends a match
  console.log('\n=== 4. the closing zone can end a match on its own ===');

  const ZONE_PORT = PORT + 2;
  const ZONE_URL = `ws://localhost:${ZONE_PORT}/ws`;
  zoneServer = spawn('npx', ['tsx', 'src/server/server.ts'], {
  // Own process group, so `stop` takes down npx AND the node server under it.
  detached: true,
    env: {
      ...process.env,
      PORT: String(ZONE_PORT),
      DEV_ASSIGN: '1',
      MODE: 'solo',
      BOTS: 'off',
      SOLO_CARS: '4',
      SOLO_MIN_PLAYERS: '2',
      MATCH_COUNTDOWN_SECONDS: '1',
      MATCH_TIME_SECONDS: '0',
      MATCH_RESULTS_SECONDS: '8',
      // Pinned close (and outside the tiny zone) so interest management does not
      // cull one of them: the solo spawn ring is 360 m out and these two would
      // otherwise be ~360 m apart.
      DEV_PLACE: '0:-20,0,0|1:20,0,0',
      // A tiny circle at the centre: the spawn ring is outside it, so both cars
      // are in the danger from the first live tick and are destroyed with no
      // combat at all.
      ZONE_PHASES: '1',
      ZONE_HOLD_SECONDS: '0',
      ZONE_SHRINK_SECONDS: '1',
      ZONE_START_RADIUS: '15',
      ZONE_END_RADIUS: '8',
      ZONE_DPS: '1500',
      ZONE_DPS_PER_PHASE: '0',
      ZONE_SEED: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [zoneServer.stdout, zoneServer.stderr]) {
    stream?.on('data', (buf) => {
      for (const line of String(buf).split('\n')) if (line.trim()) zoneLog.push(line.trim());
    });
  }
  await sleep(1400);

  const z1 = await Client.connect(ZONE_URL, 0, 'seat.driver');
  const z2 = await Client.connect(ZONE_URL, 1, 'seat.driver');
  await waitFor(() => z1.latest !== null && z2.latest !== null, 4000);

  const zoneLive = await waitFor(() => z1.phase === 'live', 5000);
  check('the zone match reaches live', zoneLive, `phase ${z1.phase}`);
  check('and carries a zone', z1.latest?.zone != null, `radius ${z1.latest?.zone?.radius?.toFixed(1)}`);

  const zoneEnded = await waitFor(() => z1.phase === 'results', 8000);
  check('the zone alone ends the match', zoneEnded, `phase ${z1.phase}`);
  check('with no shots fired', z1.shots === 0, `${z1.shots} shots`);
  check(
    'and the zone kill credits no one in the feed',
    z1.kills.length > 0 && z1.kills.every((k) => k.byCrew === null),
    `${z1.kills.length} feed entries, authors ${JSON.stringify(z1.kills.map((k) => k.byCrew))}`,
  );
  check('and a last-standing result', z1.latest?.match.reason === 'last-standing');
  // Both cars die on the same tick to the same damage. That must be a DRAW: the
  // last-standing check used to fire mid-loop, crowning whoever happened to be
  // processed last as the winner of a field that was entirely dead.
  check(
    'a wipe on one tick is a draw, not a spurious winner',
    z1.latest?.match.winner === null,
    `winner ${z1.latest?.match.winner}`,
  );
  check(
    'the cars died without a fight',
    z1.vehicle(0)?.dead === true && z1.vehicle(1)?.dead === true,
  );

  z1.socket.close();
  z2.socket.close();

  // -------------------------------------------- 5. interest management (M10)
  console.log('\n=== 5. a client is only told about what is near it ===');

  const INTEREST_PORT = PORT + 3;
  const INTEREST_URL = `ws://localhost:${INTEREST_PORT}/ws`;
  interestServer = spawn('npx', ['tsx', 'src/server/server.ts'], {
  // Own process group, so `stop` takes down npx AND the node server under it.
  detached: true,
    env: {
      ...process.env,
      PORT: String(INTEREST_PORT),
      DEV_ASSIGN: '1',
      MODE: 'solo',
      BOTS: 'off',
      SOLO_CARS: '2',
      SOLO_MIN_PLAYERS: '2',
      MATCH_COUNTDOWN_SECONDS: '1',
      MATCH_TIME_SECONDS: '0',
      // Two crews at opposite corners — ~450 m apart, past the 320 m interest
      // radius, so the server must NOT send each client the other's car.
      DEV_PLACE: '0:-160,-160,0|1:160,160,0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  for (const stream of [interestServer.stdout, interestServer.stderr]) {
    stream?.on('data', (buf) => {
      for (const line of String(buf).split('\n')) if (line.trim()) interestLog.push(line.trim());
    });
  }
  await sleep(1400);

  const i1 = await Client.connect(INTEREST_URL, 0, 'seat.driver');
  const i2 = await Client.connect(INTEREST_URL, 1, 'seat.driver');
  await waitFor(() => i1.latest !== null && i2.latest !== null, 4000);
  const interestLive = await waitFor(() => i1.phase === 'live', 5000);
  check('the far-apart match reaches live', interestLive, `phase ${i1.phase}`);
  await sleep(300); // a snapshot or two

  const aVehicles = (i1.latest?.vehicles ?? []).map((v) => v.crew);
  const aMembers = i1.latest?.members ?? [];
  check('a client sees its own car', aVehicles.includes(0), `sees [${aVehicles.join(',')}]`);
  check(
    'and is NOT sent a crew ~450 m away',
    !aVehicles.includes(1),
    `sees [${aVehicles.join(',')}] — interest radius is 320 m`,
  );
  check('nor that crew’s member', !aMembers.some((m) => m.crew === 1), `${aMembers.length} members`);
  check(
    'but the roster still reports the whole match',
    i1.latest?.match.roster === 2,
    `roster ${i1.latest?.match.roster}`,
  );

  i1.socket.close();
  i2.socket.close();
} catch (error) {
  failures++;
  console.log(`\n  [FAIL] matchtest threw: ${String(error)}`);
  for (const line of serverLog.slice(-25)) console.log(`    server: ${line}`);
  for (const line of soloLog.slice(-25)) console.log(`    solo: ${line}`);
  for (const line of zoneLog.slice(-25)) console.log(`    zone: ${line}`);
  for (const line of interestLog.slice(-25)) console.log(`    interest: ${line}`);
} finally {
  for (const child of [server, soloServer, zoneServer, interestServer]) stop(child);
}

console.log(failures === 0 ? '\n✓ all match checks passed\n' : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
