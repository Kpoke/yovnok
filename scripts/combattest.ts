/**
 * Headless combat tests.
 *
 * Every rule about shooting lives on the server and is enforced there: the seat's
 * arc, the weapon's rate and magazine, and what a ray actually hits. This drives
 * that with raw sockets and no browser, so it is deterministic and fast.
 *
 *   npm run combattest
 *
 * The geometry is computed rather than hard-coded: the shooter's muzzle comes
 * from the same shared helper the server uses, and the aim is derived from the
 * authoritative snapshot, so a change to seat mounts or vehicle dimensions does
 * not silently invalidate the test.
 */

import { spawn } from 'node:child_process';
import { WebSocket } from 'ws';
import { COMBAT, VEHICLE_CLASSES } from '../src/shared/config';
import { componentBoxes } from '../src/shared/components';
import { combatTestPlacement } from './testPlacement';
import {
  seatById,
  seatsFor,
  withinArc,
  WINDOW_EYE_OFFSET,
  type SeatId,
} from '../src/shared/crews';
import { WEAPONS } from '../src/shared/weapons';
import { wrapAngle } from '../src/shared/math';
import {
  aimAnglesAt,
  headWorld,
  muzzleWorld,
  resolveAimPoint,
  resolveHitscan,
  rewindVehicle,
  seatPointWorld,
  type CombatVehicle,
} from '../src/shared/combat';
import type { VehicleState } from '../src/shared/vehicle';

/**
 * A minimal CombatVehicle view over a snapshot entry.
 *
 * `muzzleWorld` and `rewindVehicle` only read `state.yaw` and `state.pos`, so a
 * partial state is deliberately sufficient — building a full simulated vehicle
 * here would imply the test is exercising simulation it is not.
 */
const warp = (v: {
  crew: number;
  cls: 'coupe' | 'suv';
  x: number;
  y: number;
  z: number;
  yaw: number;
  hull?: number;
}): CombatVehicle => ({
  id: v.crew,
  cls: v.cls,
  state: { yaw: v.yaw, pos: { x: v.x, y: v.y, z: v.z } } as unknown as VehicleState,
  hull: v.hull ?? 0,
  history: [],
});

const PORT = Number(process.env.PORT ?? 8299);
const URL = `ws://localhost:${PORT}/ws`;

const server = spawn('npx', ['tsx', 'src/server/server.ts'], {
  env: {
    ...process.env,
    PORT: String(PORT),
    DEV_ASSIGN: '1',
    // Pin a known clear line of fire, so this test measures combat and not the
    // current arena layout (see scripts/testPlacement.ts).
    DEV_PLACE: combatTestPlacement(),
    CLIENT_TIMEOUT_MS: '60000',
    // Combat only exists during a live match. This harness tests the combat
    // rules, not the lobby, so it holds the match live rather than waiting out a
    // countdown (the lobby has its own end-to-end test in matchtest).
    MATCH_FORCE_LIVE: '1',
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
const serverLog: string[] = [];
for (const stream of [server.stdout, server.stderr]) {
  stream?.on('data', (buf) => {
    for (const line of String(buf).split('\n')) if (line.trim()) serverLog.push(line.trim());
  });
}

let failures = 0;
const check = (label: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${label}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

type Snapshot = {
  vehicles: Array<{
    crew: number;
    cls: 'coupe' | 'suv';
    x: number;
    y: number;
    z: number;
    yaw: number;
    hull: number;
    components: Record<string, number>;
  }>;
  members: Array<{ id: number; crew: number; seat: SeatId; rounds: number; reload: number; hp: number; alive: boolean }>;
  shots: Array<{ by: number; ox: number; oy: number; oz: number; ex: number; ey: number; ez: number; hitCrew: number | null }>;
  crates: Array<{ x: number; z: number; ready: boolean }>;
};

/** A raw client: sends hello, tracks the latest snapshot, records shots. */
class Client {
  readonly id: number;
  private socket: WebSocket;
  latest: Snapshot | null = null;
  readonly shotsSeen: Snapshot['shots'] = [];
  seq = 0;
  fireSeq = 0;

  private constructor(socket: WebSocket, id: number) {
    this.socket = socket;
    this.id = id;
  }

  static async connect(crew: number, seat: SeatId): Promise<Client> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(URL);
      let id = -1;
      let c: Client | null = null;
      socket.on('message', (data) => {
        const msg = JSON.parse(String(data));
        if (msg.t === 'welcome') {
          id = msg.id;
          c = new Client(socket, id);
          resolve(c);
          return;
        }
        if (msg.t === 'snap' && c) {
          c.latest = msg;
          for (const shot of msg.shots ?? []) c.shotsSeen.push(shot);
        }
      });
      socket.once('open', () => socket.send(JSON.stringify({ t: 'hello', cls: 'suv', crew, seat })));
      socket.once('error', reject);
    });
  }

  send(payload: unknown): void {
    if (this.socket.readyState === 1) this.socket.send(JSON.stringify(payload));
  }

  close(): void {
    this.socket.close();
  }

  vehicle(): Snapshot['vehicles'][number] | undefined {
    return this.latest?.vehicles.find((v) => v.crew === this.crewOf());
  }

  crewOf(): number {
    return this.latest?.members.find((m) => m.id === this.id)?.crew ?? -1;
  }

  me() {
    return this.latest?.members.find((m) => m.id === this.id);
  }

  /** Aim this seat's muzzle at an arbitrary world point. */
  aimAtPoint(point: { x: number; y: number; z: number }): { yaw: number; pitch: number } | null {
    const mine = this.vehicle();
    if (!mine) return null;
    const seat = seatById(mine.cls, this.me()?.seat ?? 'seat.frontRight');
    if (!seat) return null;

    const muzzle = muzzleWorld(warp(mine), seat);
    const dx = point.x - muzzle.x;
    const dy = point.y - muzzle.y;
    const dz = point.z - muzzle.z;
    const len = Math.hypot(dx, dy, dz) || 1;
    const dirYawWorld = Math.atan2(-dx / len, -dz / len);
    return {
      yaw: wrapAngle(dirYawWorld - mine.yaw),
      pitch: Math.asin(dy / len),
    };
  }

  /** Aim at another crew's hull centre. */
  aimAt(target: Snapshot['vehicles'][number]): { yaw: number; pitch: number } | null {
    return this.aimAtPoint({ x: target.x, y: target.y, z: target.z });
  }

  fire(yaw: number, pitch: number): void {
    this.fireSeq++;
    this.send({ t: 'fire', seq: this.fireSeq, yaw, pitch, rtt: 0 });
  }
}

/**
 * Poll until `predicate` holds, or the deadline passes.
 *
 * Reloads and rate limits are on the server's clock, so tests that guess at
 * timings fail whenever a section above them fires a different number of shots.
 * Waiting for the state you actually want is both simpler and stabler.
 */
const waitFor = async (predicate: () => boolean, ms: number): Promise<boolean> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
};

/**
 * Fire `count` shots and wait until every one has come back.
 *
 * Fixed sleeps are not enough: the server rate-limits each shot, so a phase that
 * reads its result 400 ms later catches only the first hit and the rest land
 * during the NEXT phase. That made section 4 report "the engine is undamaged,
 * and the hull moved by 34" — a test-timing bug that reads exactly like a combat
 * bug.
 */
const fireAndSettle = async (
  client: Client,
  aim: { yaw: number; pitch: number } | null,
  count: number,
): Promise<number> => {
  if (!aim) return 0;
  const before = client.shotsSeen.length;
  for (let i = 0; i < count; i++) {
    client.fire(aim.yaw, aim.pitch);
    await sleep(160);
  }
  const deadline = Date.now() + 3000;
  while (client.shotsSeen.length - before < count && Date.now() < deadline) await sleep(50);
  await sleep(250); // let the last hit's damage land in a snapshot
  return client.shotsSeen.length - before;
};

const waitForSnapshots = async (clients: Client[], ms: number): Promise<number> => {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    if (clients.every((c) => c.latest !== null)) return 0;
    await sleep(100);
  }
  return 1;
};

try {
  await sleep(1400);

  console.log('\n=== 1. lag compensation rewinds correctly ===');
  {
    // Pure unit checks on the rewind helper: a shot must be resolved against
    // where the target WAS, or high-latency players have to lead every shot.
    const vehicle: CombatVehicle = {
      id: 0,
      cls: 'suv',
      state: warp({ crew: 0, x: 0, y: 1, z: 0, yaw: 0, cls: 'suv' }).state,
      hull: COMBAT.maxHull,
      history: [
        { tick: 100, x: 0, y: 1, z: 0, yaw: 0 },
        { tick: 130, x: 30, y: 1, z: 0, yaw: 0 },
        { tick: 160, x: 60, y: 1, z: 0, yaw: 0 },
      ],
    };
    // The newest history entry is tick 160; 0.5 s back is tick 130.
    const rewound = rewindVehicle(vehicle, 0.5);
    check(
      'rewinds to the position 0.5 s ago',
      Math.abs(rewound.state.pos.x - 30) < 0.01,
      `x=${rewound.state.pos.x.toFixed(2)} (expected 30)`,
    );
    check(
      'rewinding zero seconds changes nothing',
      rewindVehicle(vehicle, 0).state.pos.x === vehicle.state.pos.x,
    );
    const clamped = rewindVehicle(vehicle, 5);
    check(
      'rewinding past the buffer clamps to its oldest entry',
      Math.abs(clamped.state.pos.x - 0) < 0.01,
      `x=${clamped.state.pos.x.toFixed(2)}`,
    );
  }

  console.log('\n=== 1b. reticle-ray aiming and the window camera ===');
  {
    // The gunner's camera is anchored to their WINDOW, not to the car (a camera
    // anchored to the car is the driver's chase camera and looks identical from
    // every seat). Two things must hold, and neither is visible in a screenshot:
    // the anchor has to sit outside the body, or the crosshair ray begins inside
    // the player's own car; and the shot has to be aimed from the muzzle at what
    // the crosshair is over, because the camera and the muzzle are not in the
    // same place.
    console.log('  -- window anchors --');
    for (const cls of ['coupe', 'suv'] as const) {
      const spec = VEHICLE_CLASSES[cls];
      const rest = warp({ crew: 0, cls, x: 0, y: 0, z: 0, yaw: 0 }).state;
      for (const seat of seatsFor(cls)) {
        if (!seat.arc) continue; // the driver has no window camera
        const anchor = seatPointWorld(rest, seat, WINDOW_EYE_OFFSET[seat.side]);
        check(
          `${cls} ${seat.id}: the camera clears the bodywork`,
          Math.abs(anchor.x) > spec.halfWidth,
          `|x| ${Math.abs(anchor.x).toFixed(2)} vs half-width ${spec.halfWidth}`,
        );
        check(
          `${cls} ${seat.id}: the camera is below the roof`,
          anchor.y < spec.boxHeight / 2,
          `y ${anchor.y.toFixed(2)} vs roof ${(spec.boxHeight / 2).toFixed(2)}`,
        );
      }
    }

    // The whole scene is lifted 200 m, above the tallest arena solid (a 16 m
    // wall). Otherwise the crosshair ray hits a ramp on its way to the target and
    // the test measures level geometry instead of the correction.
    console.log('  -- aiming --');
    const AIR = 200;
    const mk = (id: number, x: number, z: number) => ({
      id,
      cls: 'suv' as const,
      state: warp({ crew: id, cls: 'suv', x, y: AIR, z, yaw: 0 }).state,
      hull: COMBAT.maxHull,
      history: [],
    });
    const shooter = mk(0, 0, 0);
    const target = mk(1, 6, -40);
    const seat = seatById('suv', 'seat.frontRight')!;
    const muzzle = muzzleWorld(shooter, seat);

    // The camera, from the same shared data the renderer uses.
    const cam = seatPointWorld(shooter.state, seat, WINDOW_EYE_OFFSET[seat.side]);
    check(
      'the camera and the muzzle are genuinely apart',
      Math.hypot(cam.x - muzzle.x, cam.y - muzzle.y, cam.z - muzzle.z) > 0.2,
      `${Math.hypot(cam.x - muzzle.x, cam.y - muzzle.y, cam.z - muzzle.z).toFixed(2)} m apart`,
    );

    const aimAt = { x: 6, y: AIR, z: -40 }; // the crosshair rests on the target
    const dist = Math.hypot(aimAt.x - cam.x, aimAt.y - cam.y, aimAt.z - cam.z);
    const dir = {
      x: (aimAt.x - cam.x) / dist,
      y: (aimAt.y - cam.y) / dist,
      z: (aimAt.z - cam.z) / dist,
    };

    // Skipping our own car is not a nicety: the camera sits outside the flank, so
    // any aim back across the car passes straight through it.
    const acrossLen = Math.hypot(cam.x, cam.y - AIR, cam.z);
    const across = [cam.x, cam.y, cam.z, -cam.x / acrossLen, (AIR - cam.y) / acrossLen, -cam.z / acrossLen] as const;
    const unskipped = resolveAimPoint([shooter, target], -1, ...across, 220);
    check(
      'an aim across our own car hits our own car when it is not skipped',
      Math.hypot(unskipped.x - shooter.state.pos.x, unskipped.z - shooter.state.pos.z) < 3,
      `${Math.hypot(unskipped.x, unskipped.z).toFixed(2)} m from our own centre`,
    );
    const skipped = resolveAimPoint([shooter, target], 0, ...across, 220);
    check(
      'and passes straight through it once skipped',
      Math.hypot(skipped.x - shooter.state.pos.x, skipped.z - shooter.state.pos.z) > 30,
      `${Math.hypot(skipped.x, skipped.z).toFixed(1)} m from our own centre`,
    );

    // Step one: what is under the crosshair?
    const point = resolveAimPoint([shooter, target], 0, cam.x, cam.y, cam.z, ...([dir.x, dir.y, dir.z] as const), 220);
    check(
      'the crosshair ray reaches the target',
      Math.abs(point.x - 6) < 1.1 && Math.abs(point.z + 40) < 2.5,
      `(${point.x.toFixed(2)}, ${point.y.toFixed(2)}, ${point.z.toFixed(2)})`,
    );

    // Step two: point the window's muzzle at that point.
    const angles = aimAnglesAt(shooter, seat, point);
    check('the corrected aim is computable', angles !== null);
    if (angles) {
      check(
        'the corrected aim is inside the window arc',
        withinArc(seat.arc!, angles.yaw),
        `yaw ${angles.yaw.toFixed(3)} rad, arc ${seat.arc![0].toFixed(2)}..${seat.arc![1].toFixed(2)}`,
      );

      const yaw = shooter.state.yaw + angles.yaw;
      const cosPitch = Math.cos(angles.pitch);
      const corrected = resolveHitscan(
        [shooter, target],
        [],
        0,
        muzzle.x,
        muzzle.y,
        muzzle.z,
        -Math.sin(yaw) * cosPitch,
        Math.sin(angles.pitch),
        -Math.cos(yaw) * cosPitch,
        220,
        0,
      );
      const miss = Math.hypot(
        corrected.end.x - point.x,
        corrected.end.y - point.y,
        corrected.end.z - point.z,
      );
      check(
        'a corrected shot lands exactly where the crosshair was',
        corrected.hullHit === 1 && miss < 0.15,
        `hit crew ${corrected.hullHit}, ${miss.toFixed(3)} m from the crosshair`,
      );

      // The contrast, and the reason the correction exists: fired straight down
      // the camera's direction from the muzzle, the same crosshair is off by the
      // distance between the camera and the gun — about half a metre, which is a
      // quarter of a car's width.
      const naive = resolveHitscan(
        [shooter, target],
        [],
        0,
        muzzle.x,
        muzzle.y,
        muzzle.z,
        dir.x,
        dir.y,
        dir.z,
        220,
        0,
      );
      const naiveMiss = Math.hypot(
        naive.end.x - point.x,
        naive.end.y - point.y,
        naive.end.z - point.z,
      );
      check(
        'without the correction the same crosshair is off by the camera offset',
        naiveMiss > 0.3,
        `${naiveMiss.toFixed(2)} m off`,
      );
    }
  }

  console.log('\n=== 1c. shots hit components, and crew can be shot out ===');
  {
    // All in clear air, so the arena cannot be what the ray finds.
    const AIR = 200;
    const spec = VEHICLE_CLASSES.suv;
    const target = {
      id: 1,
      cls: 'suv' as const,
      state: warp({ crew: 1, cls: 'suv', x: 0, y: AIR, z: 0, yaw: 0 }).state,
      hull: COMBAT.maxHull,
      history: [],
    };
    const shoot = (ox: number, oy: number, oz: number, dx: number, dy: number, dz: number) =>
      resolveHitscan([target], [], -1, ox, oy, oz, dx, dy, dz, 220, 0);

    // A tyre, from the side. The wheel stands slightly proud of the bodywork, so
    // the tyre — not the hull — is what stops the round.
    const wheelY = AIR - (spec.rideHeight - spec.wheelRadius);
    const tyre = shoot(12, wheelY, -spec.wheelbase / 2, -1, 0, 0);
    check(
      'a shot into the front-right tyre damages that tyre',
      tyre.componentHit === 'wheel.fr',
      `componentHit=${tyre.componentHit}`,
    );
    check('and still counts as a hit on the car', tyre.hullHit === 1);

    // The engine, from the front — and NOT from behind, because a part buried
    // behind the whole car is not something an arriving round should find.
    const nose = shoot(0, AIR, -12, 0, 0, 1);
    check('a shot into the nose finds the engine', nose.componentHit === 'engine', `${nose.componentHit}`);
    const tail = shoot(0, AIR, 12, 0, 0, -1);
    check(
      'the same shot from behind does not reach the engine',
      tail.componentHit === null,
      `componentHit=${tail.componentHit}`,
    );

    const flank = shoot(12, AIR + 0.5, 0.6, -1, 0, 0);
    check(
      'a shot into plain bodywork is a hull hit',
      flank.componentHit === null && flank.hullHit === 1,
      `componentHit=${flank.componentHit}`,
    );

    // ---- crew ----
    // The driver is protected (DESIGN.md §3.5): armoured, in the cabin, with no
    // window to lean from. A gunner is the exposed one.
    const members = [
      { id: 10, crew: 1, seat: 'seat.driver' as const, hp: 100, alive: true },
      { id: 11, crew: 1, seat: 'seat.frontRight' as const, hp: 100, alive: true },
    ];
    const gunnerHead = headWorld(target, seatById('suv', 'seat.frontRight')!);
    const atGunner = resolveHitscan(
      [target],
      members,
      -1,
      12,
      gunnerHead.y,
      gunnerHead.z,
      -1,
      0,
      0,
      220,
      0,
    );
    check(
      'a gunner can be shot out of their window',
      atGunner.memberHit === 11,
      `memberHit=${atGunner.memberHit}`,
    );

    const driverHead = headWorld(target, seatById('suv', 'seat.driver')!);
    const atDriver = resolveHitscan(
      [target],
      members,
      -1,
      -12,
      driverHead.y,
      driverHead.z,
      1,
      0,
      0,
      220,
      0,
    );
    check(
      'the driver cannot be shot out',
      atDriver.memberHit !== 10,
      `memberHit=${atDriver.memberHit}`,
    );
    check(
      'but shooting the driver still damages the car',
      atDriver.hullHit === 1,
      `hullHit=${atDriver.hullHit}`,
    );
  }

  const shooter = await Client.connect(0, 'seat.frontRight');
  const target = await Client.connect(1, 'seat.driver');
  await waitForSnapshots([shooter, target], 8000);
  await sleep(600);

  console.log('\n=== 2. only an armed seat can fire ===');
  {
    check(
      'the shooter starts with a full magazine',
      shooter.me()?.rounds === WEAPONS.rifle.magazine,
      `${shooter.me()?.rounds} rounds`,
    );
    // The target client sits in the driver's seat and must be unable to fire even
    // if it tries — the seat decides, not the client.
    const before = target.shotsSeen.length;
    for (let i = 0; i < 5; i++) target.fire(0, 0);
    await sleep(500);
    check(
      'a driver cannot fire',
      target.shotsSeen.length === before,
      `${target.shotsSeen.length - before} shots produced by a driver`,
    );
    check(
      'the driver has no weapon arc',
      seatById('suv', 'seat.driver')?.arc === null,
    );
  }

  console.log('\n=== 3. a gunner fires, and the rate is capped ===');
  {
    const enemy = target.vehicle();
    const aim = enemy ? shooter.aimAt(enemy) : null;
    check('the shooter can compute an aim at the enemy', aim !== null);

    if (aim) {
      // Ten trigger pulls in one burst. The rifle is 9/s, so a burst this tight
      // may produce at most a couple of shots — rate limiting is the server's.
      const before = shooter.shotsSeen.length;
      for (let i = 0; i < 10; i++) shooter.fire(aim.yaw, aim.pitch);
      await sleep(300);
      const produced = shooter.shotsSeen.length - before;
      check('the gunner can fire', produced >= 1, `${produced} shots`);
      check(
        'the rate is capped by the server',
        produced <= 4,
        `${produced} shots from 10 requests in 300 ms (rifle is ${WEAPONS.rifle.rate}/s)`,
      );
    }
  }

  console.log('\n=== 4. hits damage what they land on ===');
  {
    // Aimed at the UPPER hull, deliberately clear of the component boxes: this
    // is the plain "shot into the bodywork" path.
    //
    // Spread is random and this aim sits near the roofline, so a handful of
    // shots can all pass over the car — which is a spread property, not a
    // combat bug. Fire short bursts until the hull moves, then measure.
    const before = target.vehicle()?.hull ?? 0;
    const enemy = target.vehicle();
    const aim = enemy ? shooter.aimAtPoint({ x: enemy.x, y: enemy.y + 0.75, z: enemy.z }) : null;
    const firstBurst = await fireAndSettle(shooter, aim, 4);
    for (let round = 0; round < 3 && (target.vehicle()?.hull ?? before) >= before; round++) {
      await fireAndSettle(shooter, aim, 4);
    }
    const after = target.vehicle()?.hull ?? 0;
    check('the shots the server accepted are the shots we counted', firstBurst === 4, `${firstBurst}/4`);
    check('aimed shots into the bodywork reduce hull', after < before, `hull ${before} → ${after}`);
    check(
      'hull damage is whole multiples of the weapon damage',
      (before - after) % WEAPONS.rifle.damage === 0,
      `${before - after} damage (rifle does ${WEAPONS.rifle.damage})`,
    );

    // Now the engine, from the front. This is the decision §4.2 is built on:
    // a part hit disables the PART and costs you the hull damage.
    const fresh = target.vehicle();
    if (fresh) {
      const spec = VEHICLE_CLASSES[fresh.cls];
      const box = componentBoxes(spec).find((b) => b.id === 'engine')!;
      // Local -> world, yaw only, matching `seatPointWorld`.
      const c = Math.cos(fresh.yaw);
      const sn = Math.sin(fresh.yaw);
      const engineWorld = {
        x: fresh.x + box.c[0] * c + box.c[2] * sn,
        y: fresh.y + box.c[1],
        z: fresh.z - box.c[0] * sn + box.c[2] * c,
      };
      const hullBefore = fresh.hull;
      const engineBefore = fresh.components.engine;
      const damage = WEAPONS.rifle.damage;

      // The engine box is small next to the spread cone: measured against this
      // exact geometry, an aimed shot finds it only ~22% of the time. A fixed
      // six-shot sample therefore failed about once in four runs — a flaky test
      // that looked like a combat bug. Fire in short bursts until it lands.
      let landed = 0;
      for (let round = 0; round < 3; round++) {
        landed += await fireAndSettle(shooter, shooter.aimAtPoint(engineWorld), 10);
        const cur = target.vehicle();
        if (cur && cur.components.engine < engineBefore) break;
      }
      const now = target.vehicle()!;

      const engineHits = (engineBefore - now.components.engine) / damage;
      const hullHits = (hullBefore - now.hull) / damage;

      check(
        'aiming at the engine damages the engine',
        engineHits >= 1,
        `${engineHits} engine hits from ${landed} shots`,
      );
      // A part hit is diverted from the hull entirely (§4.2). Stated as "fewer
      // hull hits than shots that landed" rather than an exact sum, because a
      // wheel can also stop a round and once the engine reaches zero further
      // engine hits clamp — neither of which is a combat bug.
      check(
        'and at least one shot was diverted from the hull',
        hullHits < landed,
        `${hullHits} hull of ${landed} landed → ${landed - hullHits} diverted`,
      );
    }
  }

  console.log('\n=== 5. hitting the hull from outside the arc does nothing ===');
  {
    const before = target.vehicle()?.hull ?? 0;
    const enemy = target.vehicle();
    const aim = enemy ? shooter.aimAt(enemy) : null;
    if (aim) {
      // Aim hard the other way: the server clamps to the window, so the shot
      // must leave the barrel pointing somewhere it cannot hit.
      for (let i = 0; i < 4; i++) {
        shooter.fire(aim.yaw + Math.PI, aim.pitch);
        await sleep(140);
      }
    }
    await sleep(400);
    const after = target.vehicle()?.hull ?? 0;
    check(
      'a clamped shot cannot reach the target',
      Math.abs(after - before) < 0.001,
      `hull ${before} → ${after}`,
    );
  }

  console.log('\n=== 6. magazine depletes, reload restores ===');
  {
    const magazine = WEAPONS.rifle.magazine;

    // Start from a full magazine rather than assuming what earlier sections
    // spent: a magazine test that depends on firing history breaks the moment
    // somebody adds a section above it.
    shooter.send({ t: 'reload' });
    const full = await waitFor(() => shooter.me()?.rounds === magazine, 8000);
    check('a reload brings the magazine to full', full, `${shooter.me()?.rounds} rounds`);

    const enemy = target.vehicle();
    const aim = enemy ? shooter.aimAt(enemy) : null;
    const landed = await fireAndSettle(shooter, aim, magazine);
    check('every round in the magazine was fired', landed === magazine, `${landed}/${magazine}`);

    const emptied = shooter.me();
    check(
      'the magazine empties',
      emptied?.rounds === 0,
      `rounds=${emptied?.rounds}`,
    );
    check(
      'and an auto-reload begins without being asked',
      (emptied?.reload ?? 0) > 0,
      `reload=${emptied?.reload?.toFixed(2)}s`,
    );

    const restored = await waitFor(() => shooter.me()?.rounds === magazine, 8000);
    check('the magazine is restored after reloading', restored, `rounds=${shooter.me()?.rounds}`);
  }

  console.log('\n=== 7. manual reload ===');
  {
    const magazine = WEAPONS.rifle.magazine;
    const enemy = target.vehicle();
    const aim = enemy ? shooter.aimAt(enemy) : null;

    // Spend a few rounds so the magazine is genuinely partial.
    await fireAndSettle(shooter, aim, 3);
    const partial = shooter.me();
    check(
      'the magazine is partly spent before we reload',
      (partial?.rounds ?? magazine) < magazine,
      `${partial?.rounds}/${magazine}`,
    );

    shooter.send({ t: 'reload' });
    await waitFor(() => (shooter.me()?.reload ?? 0) > 0, 2000);
    const during = shooter.me();
    check('a manual reload starts', (during?.reload ?? 0) > 0, `reload=${during?.reload?.toFixed(2)}s`);

    const restored = await waitFor(() => shooter.me()?.rounds === magazine, 8000);
    check('manual reload restores the magazine', restored, `${shooter.me()?.rounds}/${magazine}`);
  }

  console.log('\n=== 8. crews are separate entities ===');
  {
    const sq = seatsFor('suv').length;
    check('the SUV seats four', sq === 4, `${sq} seats`);
    check('the coupe seats two', seatsFor('coupe').length === 2);
    check(
      'the two crews are distinct vehicles',
      shooter.crewOf() !== target.crewOf(),
      `crews ${shooter.crewOf()} and ${target.crewOf()}`,
    );
    check(
      'both vehicles exist',
      shooter.latest?.vehicles.length === 2,
      `${shooter.latest?.vehicles.length} vehicles`,
    );
    // Repair crates come from the shared arena, so the server must be sending
    // them — otherwise the most important map resource is invisible.
    const crates = shooter.latest?.crates ?? [];
    check(
      'repair crates are replicated and start ready',
      crates.length > 0 && crates.every((c) => c.ready),
      `${crates.length} crates`,
    );
  }

  shooter.close();
  target.close();
} catch (error) {
  console.error(`\n${(error as Error).message}`);
  console.error(serverLog.slice(-15).join('\n'));
  failures++;
} finally {
  server.kill('SIGTERM');
}

console.log(failures === 0 ? '\n✓ all combat checks passed\n' : `\n✗ ${failures} check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
