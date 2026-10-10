/**
 * Bot checks (M8).
 *
 * Two halves, same split as `matchtest`:
 *
 *   1. The pure brain in `server/bot.ts`, on a flat arena so the answers are
 *      about steering and firing and not about where the map happens to have
 *      cover. The important one is the STEERING SIGN: positive steer turns
 *      right while increasing yaw turns left, so a bot that forgets the minus
 *      drives away from everything and looks "passive" rather than broken.
 *   2. A real server with `BOTS=fill` and one human, to prove bots occupy seats,
 *      drive, and actually shoot.
 *
 *   npm run bottest
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { VEHICLE_CLASSES } from '../src/shared/config';
import { refreshSolids, SOLIDS, type Solid } from '../src/shared/arena';
import { createVehicle, stepVehicle } from '../src/shared/vehicle';
import { seatById } from '../src/shared/crews';
import { createBotMemory, decideBot, type BotEnemy, type BotSkill } from '../src/server/bot';

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- 1. brain

console.log('\n=== 1. the bot brain ===');

/** Featureless ground so clearance/LOS answers are the bot's, not the map's. */
const FLAT: Solid[] = [
  { kind: 'box', min: { x: -400, y: -2, z: -400 }, max: { x: 400, y: 0, z: 400 }, color: 0 },
];
/** The real arena, kept so the navigation tests can put it back. */
const REAL_ARENA: Solid[] = [...SOLIDS];
SOLIDS.splice(0, SOLIDS.length, ...FLAT);
refreshSolids();

const bot = createVehicle(0, 1, 0, 0, VEHICLE_CLASSES.solo);
const seat = seatById('solo', 'seat.driver')!;
const vehicle = { id: 0, cls: 'solo' as const, state: bot, hull: 1200, history: [] };

// Targets are FAR (past maxRange) for the steering checks, so the orbit bias
// that applies once in range does not show up as steering.
const ahead: BotEnemy[] = [{ id: 1, x: 0, y: 1, z: -200 }];
const left: BotEnemy[] = [{ id: 1, x: -200, y: 1, z: 0 }];
const behind: BotEnemy[] = [{ id: 1, x: 0, y: 1, z: 40 }];

/**
 * Decide at `time`, after having already acquired the target, so the reaction
 * delay has elapsed. A fresh memory fires only after `BOT.reactionSeconds`.
 */
const decide = (
  enemies: BotEnemy[],
  time = 2,
  zone: { x: number; z: number; radius: number } | null = null,
  skill?: BotSkill,
): ReturnType<typeof decideBot> => {
  const memory = createBotMemory();
  const full = zone
    ? { ...zone, shrinking: false, nextShrinkMs: 0, damagePerSecond: 0 }
    : null;
  decideBot({ vehicle, seat, enemies, time: 0, phase: 0, memory, zone: full, skill }); // acquire
  return decideBot({ vehicle, seat, enemies, time, phase: 0, memory, zone: full, skill });
};

{
  const intent = decide(ahead);
  check('a target dead ahead needs no steering', Math.abs(intent.input.steer) < 0.05, `${intent.input.steer.toFixed(2)}`);
  check('and it drives at it', intent.input.throttle > 0, `${intent.input.throttle.toFixed(2)}`);
  // 200 m is past the MG's fire discipline (BOT.mgFireRange): no wasted bursts.
  check('it holds MG fire at 200 m', !intent.fire);
}

// ---- weapons bear on their own arcs (Phase 7) ----
{
  const near = decide([{ id: 1, x: 0, y: 1, z: -100 }]);
  check('it fires the MGs at a target 100 m dead ahead', near.fire);
  check('at a point on the target', !!near.target && Math.abs(near.target.z + 100) < 3, JSON.stringify(near.target));

  // 40° off the nose: outside the MGs' ±20°, inside the roof RPG's ±135°.
  const a = (40 * Math.PI) / 180;
  const off = decide([{ id: 1, x: -Math.sin(a) * 80, y: 1, z: -Math.cos(a) * 80 }]);
  check('it does NOT fire the MGs at a target 40° off the nose', !off.fire);
  check('but the roof RPG, which can bear, does fire', off.fireSecondary === true);

  // A target crossing at 25 m/s: the rocket leads it by its flight time.
  const crossing = decide([{ id: 1, x: 0, y: 1, z: -78, vx: 25, vz: 0 }], 2, null, 'hard');
  const lead = crossing.secondaryTarget?.x ?? 0;
  check('a rocket at a crossing car is led (≈ v × flight time)', lead > 15 && lead < 30, `${lead.toFixed(1)} m`);

  const point = decide([{ id: 1, x: 0, y: 1, z: -8 }]);
  check('no rockets at point-blank (its own splash)', point.fireSecondary !== true);
}

{
  // A fresh acquire must NOT fire immediately — that is the reaction delay.
  const memory = createBotMemory();
  const first = decideBot({ vehicle, seat, enemies: ahead, time: 5, phase: 0, memory, zone: null });
  check('a just-acquired target is not fired on instantly', !first.fire);
}

{
  // Target off the LEFT flank: yaw must INCREASE (turn left), which needs a
  // NEGATIVE steer. This is the sign that is easy to get backwards.
  const intent = decide(left);
  check('a target off the left flank steers left', intent.input.steer < -0.2, `steer ${intent.input.steer.toFixed(2)}`);
}

{
  const intent = decide(behind);
  check('a target behind the arc does not fire', !intent.fire);
}

{
  const intent = decide([], 1);
  check('with no target it still drives', intent.input.throttle > 0);
  check('and holds fire', !intent.fire);
}

{
  // A wall straight ahead: both flanks blocked equally, so the avoidance nudge
  // picks a side and the bot does not drive into it.
  const wall: Solid = { kind: 'box', min: { x: -60, y: 0, z: -14 }, max: { x: 60, y: 6, z: -10 }, color: 0 };
  SOLIDS.push(wall);
  refreshSolids();
  const intent = decide(ahead);
  check('a wall ahead turns the bot aside', Math.abs(intent.input.steer) > 0.4, `steer ${intent.input.steer.toFixed(2)}`);
  SOLIDS.pop();
  refreshSolids();
}

{
  // Zone awareness: a bot outside the safe circle must drive back in, not sit
  // there taking escalating damage like a free kill.
  // Faces -z; the centre is 90° to its left, so "turn in" is unambiguous.
  const stray = createVehicle(100, 1, 0, 0, VEHICLE_CLASSES.solo);
  const zone = { x: 0, z: 0, radius: 50, shrinking: false, nextShrinkMs: 0, damagePerSecond: 0 };
  const intent = decideBot({
    vehicle: { id: 0, cls: 'solo' as const, state: stray, hull: 1200, history: [] },
    seat,
    enemies: [],
    time: 1,
    phase: 0,
    memory: createBotMemory(),
    zone,
  });
  check('a bot outside the zone drives back in', intent.input.throttle > 0.9, `throttle ${intent.input.throttle.toFixed(2)}`);
  check('and turns toward the centre', intent.input.steer < -0.5, `steer ${intent.input.steer.toFixed(2)}`);
}

{
  // Inside the zone, play is untouched — a target dead ahead still means no steering.
  const inside = decide(ahead, 2, { x: 0, z: 0, radius: 500 });
  check('a bot well inside the zone is unaffected', Math.abs(inside.input.steer) < 0.05, `steer ${inside.input.steer.toFixed(2)}`);
}

{
  // DRIVING skill is part of difficulty, not just marksmanship.

  // Steering authority: a target ~0.30 rad off the nose, far enough that the
  // orbit bias is off. Sampled where the steering wander is ~0 so this measures
  // authority, not noise.
  const offAxis: BotEnemy[] = [{ id: 1, x: -59.1, y: 1, z: -191.1 }];
  const easyTurn = decide(offAxis, 1.16, null, 'easy');
  const hardTurn = decide(offAxis, 1.16, null, 'hard');
  check(
    'a hard bot steers with more authority',
    Math.abs(hardTurn.input.steer) > Math.abs(easyTurn.input.steer),
    `${hardTurn.input.steer.toFixed(2)} vs ${easyTurn.input.steer.toFixed(2)}`,
  );

  // Wander: same target dead ahead, sampled where the wander is near its peak.
  const easyLine = decide(ahead, 0.582, null, 'easy');
  const hardLine = decide(ahead, 0.582, null, 'hard');
  check(
    'an easy bot wanders on a straight line',
    Math.abs(easyLine.input.steer) > Math.abs(hardLine.input.steer) &&
      Math.abs(easyLine.input.steer) > 0.1,
    `${easyLine.input.steer.toFixed(2)} vs ${hardLine.input.steer.toFixed(2)}`,
  );

  // Attack runs: a hard bot (longer standoff) breaks off its pass further out.
  const passSteer = (skill: BotSkill, distance: number): number => {
    const car = createVehicle(0, 1, 0, 0, VEHICLE_CLASSES.solo);
    car.vel.z = -20; // 20 m/s, forward
    car.forwardSpeed = 20; // the cached value the brain actually reads
    const memory = createBotMemory();
    const enemies: BotEnemy[] = [{ id: 1, x: 0, y: 1, z: -distance }];
    const ctx = {
      vehicle: { id: 0, cls: 'solo' as const, state: car, hull: 1200, history: [] },
      seat,
      enemies,
      phase: 0,
      memory,
      zone: null,
      skill,
    };
    decideBot({ ...ctx, time: 0 });
    return decideBot({ ...ctx, time: 2 }).input.steer;
  };
  // Break range is 18 m × standoff: hard 20.7 m, easy 13.5 m. At 19 m a hard
  // bot is breaking off and an easy one is still pressing in.
  const easyPass = passSteer('easy', 19);
  const hardPass = passSteer('hard', 19);
  check(
    'a hard bot breaks off its pass further out than an easy one',
    Math.abs(hardPass) > 0.5 && Math.abs(easyPass) < 0.2,
    `easy steer ${easyPass.toFixed(2)} vs hard ${hardPass.toFixed(2)}`,
  );
}

{
  // ---- bot depth (M11): roam, engage, repair ----
  const run = (
    x: number,
    z: number,
    yaw: number,
    senses: Partial<Parameters<typeof decideBot>[0]>,
  ): ReturnType<typeof decideBot> =>
    decideBot({
      vehicle: { id: 0, cls: 'solo' as const, state: createVehicle(x, 1, z, yaw, VEHICLE_CLASSES.solo), hull: 1200, history: [] },
      seat,
      enemies: [],
      time: 2,
      phase: 0,
      memory: createBotMemory(),
      zone: null,
      ...senses,
    });

  // Nobody within engage range: patrol, rather than beelining a distant enemy.
  const roamer = run(300, 0, 0, { enemies: [{ id: 1, x: 0, y: 1, z: -500 }] });
  check(
    'a bot with no one near patrols instead of beelining',
    roamer.input.steer < -0.5 && roamer.input.throttle > 0.2,
    `steer ${roamer.input.steer.toFixed(2)} throttle ${roamer.input.throttle.toFixed(2)}`,
  );

  // Someone near: drive at them.
  const engaged = run(0, 0, 0, { enemies: [{ id: 1, x: 0, y: 1, z: -200 }] });
  check(
    'a bot with someone nearby engages',
    engaged.input.throttle > 0.2 && Math.abs(engaged.input.steer) < 0.2,
    `steer ${engaged.input.steer.toFixed(2)}`,
  );

  // Hurt: run for repair.
  const hurt = run(0, 0, 0, { hullFraction: 0.2, repairs: [{ x: -60, z: 0 }] });
  check(
    'a hurt bot heads for repair',
    hurt.input.steer < -0.5 && hurt.input.throttle > 0.2,
    `steer ${hurt.input.steer.toFixed(2)}`,
  );

  // At the repair point: hold still (repair needs a near-stationary car).
  const arrived = run(-5, 0, 0, { hullFraction: 0.2, repairs: [{ x: -6, z: 0 }] });
  check(
    'and holds still once there',
    arrived.input.handbrake && arrived.input.throttle <= 0,
    `throttle ${arrived.input.throttle} brake ${arrived.input.handbrake}`,
  );

  // ---- target selection: finish the wounded ----------------------------
  // Nearest healthy enemy dead ahead at 110 m; a wounded one on the left at
  // 150 m (inside the 1.6x finish window). The bot should turn for the wounded
  // car. All distances are outside the fire-range band (hard maxRange ~103 m),
  // so no orbit is mixed in — this is a pure target choice.
  const finish = run(0, 0, 0, {
    enemies: [
      { id: 1, x: 0, y: 1, z: -110 },
      { id: 2, x: -150, y: 1, z: 0, hullFraction: 0.2 },
    ],
  });
  check(
    'a bot turns for a wounded enemy even when a healthy one is nearer',
    finish.input.steer < -0.5,
    `steer ${finish.input.steer.toFixed(2)}`,
  );

  const bothHealthy = run(0, 0, 0, {
    enemies: [
      { id: 1, x: 0, y: 1, z: -110 },
      { id: 2, x: -150, y: 1, z: 0 },
    ],
  });
  check(
    'but ignores a healthy enemy merely because it is inside the window',
    Math.abs(bothHealthy.input.steer) < 0.2,
    `steer ${bothHealthy.input.steer.toFixed(2)}`,
  );

  const beyondWindow = run(0, 0, 0, {
    enemies: [
      { id: 1, x: 0, y: 1, z: -110 },
      { id: 2, x: -220, y: 1, z: 0, hullFraction: 0.1 },
    ],
  });
  check(
    'and does not chase a wounded enemy past the bias window',
    Math.abs(beyondWindow.input.steer) < 0.2,
    `steer ${beyondWindow.input.steer.toFixed(2)}`,
  );

  const nearestWounded = run(0, 0, 0, {
    enemies: [
      { id: 1, x: 0, y: 1, z: -110, hullFraction: 0.3 },
      { id: 2, x: -150, y: 1, z: 0 },
    ],
  });
  check(
    'the nearest stays the target when it is already wounded',
    Math.abs(nearestWounded.input.steer) < 0.2,
    `steer ${nearestWounded.input.steer.toFixed(2)}`,
  );
}

// Real arena for the driving tests: open ground tells us nothing about
// navigation, which is the whole point.
SOLIDS.splice(0, SOLIDS.length, ...REAL_ARENA);
refreshSolids();
{
  const drive = (
    x: number,
    z: number,
    yaw: number,
    tx: number,
    tz: number,
    ticks: number,
    skill: BotSkill,
  ) => {
    const car = createVehicle(x, 2, z, yaw, VEHICLE_CLASSES.solo);
    const memory = createBotMemory();
    const enemies: BotEnemy[] = [{ id: 1, x: tx, y: 2, z: tz }];
    let topSpeed = 0;
    let stalled = 0;
    /** Longest unbroken run of near-zero speed. The "is it wedged" number. */
    let stallRun = 0;
    let longestStall = 0;
    /** Closest it got to the target: with attack runs it passes, then breaks away. */
    let closest = Infinity;
    for (let i = 0; i < ticks; i++) {
      const intent = decideBot({
        vehicle: { id: 0, cls: 'solo' as const, state: car, hull: 1200, history: [] },
        seat,
        enemies,
        time: i / 60,
        phase: 1.1,
        memory,
        zone: null,
        skill,
      });
      stepVehicle(car, intent.input, 1 / 60);
      topSpeed = Math.max(topSpeed, Math.abs(car.forwardSpeed));
      closest = Math.min(closest, Math.hypot(car.pos.x - tx, car.pos.z - tz));
      // Count a stall only after the run-up, so the standing start is not one.
      if (i > 60 && Math.abs(car.forwardSpeed) < 1.5) {
        stalled++;
        stallRun++;
        if (stallRun > longestStall) longestStall = stallRun;
      } else {
        stallRun = 0;
      }
    }
    return { car, topSpeed, stalled, longestStall, ticks, closest };
  };

  // Drive through cover to a waypoint. The waypoint must be INSIDE the bot's
  // engage radius (260 m): beyond it a bot deliberately roams rather than
  // beelining a distant enemy it cannot see (M11 bot depth), so a far target is
  // no longer a "drive to it" test.
  const cross = drive(-140, -140, -2.356, -20, -20, 900, 'hard');
  const travelled = Math.hypot(cross.car.pos.x + 140, cross.car.pos.z + 140);
  const toTarget = Math.hypot(cross.car.pos.x + 20, cross.car.pos.z + 20);
  check(
    'a hard bot crosses cover without getting stuck',
    travelled > 100,
    `${travelled.toFixed(0)} m in 15 s`,
  );
  check('and does it at speed', cross.topSpeed > 18, `${(cross.topSpeed * 3.6).toFixed(0)} km/h`);
  // It reaches the target and makes its pass — then breaks away by design, so
  // the test is the closest approach, not where it happens to be at 15 s.
  check('and reaches the target through it', cross.closest < 30, `closest ${cross.closest.toFixed(0)} m (now ${toTarget.toFixed(0)} m)`);
  // "Not stuck" is about how long it is stuck, not how many ticks in total: a bot
  // that reaches its waypoint brakes and holds there, which is correct. A wedged
  // bot stalls for SECONDS; this bounds the longest unbroken stall at 1.5 s.
  check(
    'and is never wedged for long',
    cross.longestStall < 90,
    `longest stall ${cross.longestStall} ticks (${(cross.longestStall / 60).toFixed(1)} s)`,
  );

  // Wedge: nose 10 m from the face of a tall block, with the target beyond it.
  // The block is 18 m wide, so the only way on is around, and a stuck bot would
  // sit at the face making no progress.
  const wedge = drive(129, 110, Math.PI, 129, 160, 480, 'hard');
  const escaped = Math.hypot(wedge.car.pos.x - 129, wedge.car.pos.z - 110);
  check(
    'a bot meeting a block finds a way around it',
    escaped > 20,
    `moved ${escaped.toFixed(1)} m in 8 s`,
  );
  check(
    'and gets past the block rather than hovering at its face',
    wedge.car.pos.z > 130,
    `ended at z ${wedge.car.pos.z.toFixed(0)} (block face is 120)`,
  );
}
SOLIDS.splice(0, SOLIDS.length, ...FLAT);
refreshSolids();

// Restore the real arena for anything after (none, but be tidy).
SOLIDS.splice(0, SOLIDS.length, ...FLAT);
refreshSolids();

// ---------------------------------------------------------------------- 2. room

const PORT = Number(process.env.PORT ?? 8499);
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
    SOLO_CARS: '4',
    SOLO_MIN_PLAYERS: '2',
    // Pinned close: the solo spawn ring is 360 m out, and interest management
    // would cull the bots from the observer entirely.
    DEV_PLACE: '0:-60,0,0|1:60,0,0|2:0,60,0|3:0,-60,0',
    MATCH_COUNTDOWN_SECONDS: '1',
    MATCH_TIME_SECONDS: '40',
    MATCH_RESULTS_SECONDS: '6',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', (buf) => {
    for (const line of String(buf).split('\n')) if (line.trim()) serverLog.push(line.trim());
  });
}

type Snap = {
  vehicles: Array<{ crew: number; dead: boolean; x: number; z: number }>;
  members: Array<{ id: number; crew: number; seat: string }>;
  shots: Array<{ by: number }>;
  match: { phase: string; alive: number; players: number; roster: number };
};

class Client {
  id = -1;
  latest: Snap | null = null;
  /** Shots are one-tick events, so accumulate them across snapshots. */
  readonly shooters = new Set<number>();
  private constructor(readonly socket: WebSocket) {}
  static connect(crew: number): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(URL);
      const client = new Client(socket);
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'welcome') {
          client.id = msg.id;
          resolve(client);
        } else if (msg.t === 'snap') {
          client.latest = msg as Snap;
          for (const shot of msg.shots ?? []) client.shooters.add(shot.by);
        }
      });
      socket.once('open', () => socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew })));
      socket.once('error', reject);
    });
  }
  get phase(): string {
    return this.latest?.match.phase ?? 'none';
  }
  vehicle(crew: number) {
    return this.latest?.vehicles.find((v) => v.crew === crew);
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

try {
  await sleep(1400);
  console.log('\n=== 2. bots fill the field and fight ===');

  const human = await Client.connect(0);
  await waitFor(() => human.latest !== null, 4000);
  check('the lobby reports one human', human.latest?.match.players === 1, `players ${human.latest?.match.players}`);

  // Bots fill the field to four. The ROSTER is the count of the whole match;
  // the visible vehicle list is only what is near us, because interest
  // management (M10) culls distant cars on purpose.
  const filled = await waitFor(() => (human.latest?.match.roster ?? 0) === 4, 4000);
  check('bots fill the field to four cars', filled, `roster ${human.latest?.match.roster}`);

  const wentLive = await waitFor(() => human.phase === 'live', 5000);
  check('the match starts with one human plus bots', wentLive, `phase ${human.phase}`);
  check('four cars are alive', human.latest?.match.alive === 4, `alive ${human.latest?.match.alive}`);

  // Bots drive: watch the nearest visible bot move.
  const humanCrew = await (async () => {
    // The client's own crew, from the debug-free angle: the first member is us.
    return human.latest?.members.find((m) => m.id === human.id)?.crew ?? 0;
  })();
  const botCrew = (human.latest?.vehicles ?? [])
    .map((v) => v.crew)
    .find((crew) => crew !== humanCrew);
  const first = botCrew === undefined ? undefined : human.vehicle(botCrew);
  const before = first ? { x: first.x, z: first.z } : null;
  const moved = await waitFor(() => {
    if (botCrew === undefined) return false;
    const now = human.vehicle(botCrew);
    return !!now && !!before && Math.hypot(now.x - before.x, now.z - before.z) > 5;
  }, 4000);
  check('a bot drives its car', moved, botCrew === undefined ? 'no bot visible' : `crew ${botCrew}`);

  // Bots shoot: a shot whose author is not the human.
  const fired = await waitFor(() => [...human.shooters].some((by) => by !== human.id), 8000);
  const bots = [...human.shooters].filter((by) => by !== human.id);
  check('a bot fires', fired, `shooters ${[...human.shooters].join(',')} (bots ${bots.length})`);

  human.socket.close();
} catch (error) {
  failures++;
  console.log(`\n  [FAIL] bottest threw: ${String(error)}`);
  for (const line of serverLog.slice(-25)) console.log(`    server: ${line}`);
} finally {
  try {
    process.kill(-server.pid!, 'SIGTERM');
  } catch {
    server.kill('SIGTERM');
  }
}

console.log(failures === 0 ? '\n✓ all bot checks passed\n' : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
