/**
 * Where does this stack actually run out?
 *
 * Every claim about "can we do 30 cars" is a guess until something is measured,
 * so this measures the three things that bound scale, using the REAL code:
 *
 *   - REPLICATION: bytes per snapshot per client, as vehicles grow. Bandwidth is
 *     usually the first wall, and JSON is the reason.
 *   - SIMULATION: cost of one tick with N vehicles in the real arena. This is
 *     the part people assume is the problem, and it usually is not.
 *   - HIT DETECTION: cost of resolving shots as the vehicle count grows.
 *
 *   npm run scalebench
 *
 * Numbers are from the machine running it, so treat them as orders of magnitude
 * rather than absolutes — the SHAPE of the curves is the useful part.
 */

import { COMBAT, NET, TICK, VEHICLE_CLASSES } from '../src/shared/config';
import { createVehicle, stepVehicle, NEUTRAL_INPUT, type VehicleState } from '../src/shared/vehicle';
import { createComponents, COMPONENT_IDS } from '../src/shared/components';
import { SPAWNS } from '../src/shared/arena';
import { SpatialGrid } from '../src/shared/grid';
import { resolveHitscan, type CombatVehicle, type CombatMember } from '../src/shared/combat';
import type { VehicleSnapshot, MemberSnapshot, SnapshotMessage } from '../src/shared/protocol';

const DT = TICK.dt;

/** A snapshot with the same shape the server sends, filled with plausible values. */
function makeSnapshot(vehicleCount: number): SnapshotMessage {
  const vehicles: VehicleSnapshot[] = [];
  const members: MemberSnapshot[] = [];

  for (let i = 0; i < vehicleCount; i++) {
    vehicles.push({
      crew: i,
      cls: 'suv',
      x: 123.456 + i,
      y: 1.05,
      z: -234.567 + i,
      vx: 12.345,
      vy: -0.123,
      vz: -23.456,
      yaw: 1.2345,
      pitch: 0.0234,
      roll: -0.0123,
      onGround: true,
      boost: 42.5,
      forwardSpeed: 26.789,
      slipSpeed: -3.456,
      look: i % 64,
      hull: 1140,
      repairing: false,
      components: { engine: 120, 'wheel.fl': 120, 'wheel.fr': 88, 'wheel.rl': 120, 'wheel.rr': 120 },
      driver: i * 4,
      appliedThrottle: 0.987,
      queued: 2,
      dead: false,
      respawnIn: 0,
      placement: null,
    });
    for (let seat = 0; seat < 4; seat++) {
      members.push({
        id: i * 4 + seat,
        crew: i,
        seat: (['seat.driver', 'seat.frontRight', 'seat.rearLeft', 'seat.rearRight'] as const)[seat],
        aimYaw: -1.2345,
        aimPitch: 0.1234,
        hp: 87,
        slot: 0,
        allRounds: [], allReloads: [], rounds: 17,
        reload: 0,
        alive: true,
      });
    }
  }

  return {
    t: 'snap',
    tick: 123456,
    time: 987654.321,
    ackSeq: 4321,
    vehicles,
    members,
    shots: [],
    kills: [],
    board: vehicles.map((v) => ({ crew: v.crew, kills: 0, placement: null })),
    projectiles: [],
    // Crates are replicated too, and they are part of the per-client cost.
    crates: Array.from({ length: 5 }, (_, i) => ({
      id: i,
      x: 70 + i,
      z: 42 - i,
      ready: i !== 0,
      salvage: false,
    })),
    zone: null,
    match: {
      mode: 'duel',
      phase: 'live',
      remainingMs: 640_000,
      scores: [3, 2],
      winner: null,
      reason: null,
      suddenDeath: false,
      alive: vehicleCount,
      ready: 0,
      players: vehicleCount * 4,
      roster: vehicleCount * 4,
    },
  };
}

function makeVehicle(index: number): CombatVehicle {
  const spawn = SPAWNS[index % SPAWNS.length];
  const offset = Math.floor(index / SPAWNS.length) * 6;
  const state = createVehicle(
    spawn.x + offset,
    VEHICLE_CLASSES.suv.rideHeight,
    spawn.z + offset,
    spawn.yaw,
    VEHICLE_CLASSES.suv,
  );
  return { id: index, cls: 'suv', state, hull: COMBAT.maxHull, history: [] };
}

const ms = (fn: () => void): number => {
  const start = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - start) / 1e6;
};

console.log('\n=== 1. replication: snapshot size ===');
console.log('  vehicles  crew  JSON bytes  per-client kbit/s @30Hz  @120 players');
for (const count of [2, 8, 30, 60]) {
  const snap = makeSnapshot(count);
  const bytes = Buffer.byteLength(JSON.stringify(snap));
  const perSecond = bytes * NET.snapshotRate;
  const kbit = (perSecond * 8) / 1000;
  // Every client is sent the full room, which is the whole problem.
  const serverKbit = (kbit * Math.min(120, count * 4)) / 1000;
  console.log(
    `  ${String(count).padStart(8)}  ${String(count * 4).padStart(4)}  ${String(bytes).padStart(10)}  ` +
      `${kbit.toFixed(0).padStart(19)}  ${serverKbit.toFixed(1).padStart(10)} Mbit/s`,
  );
}

console.log('\n=== 2. simulation: cost of one tick ===');
console.log('  vehicles  ms/tick  % of 16.6ms budget  headroom');
for (const count of [2, 8, 30, 60, 120]) {
  const states: VehicleState[] = [];
  for (let i = 0; i < count; i++) {
    const v = makeVehicle(i);
    states.push(v.state);
  }
  const ticks = 600;
  const elapsed = ms(() => {
    for (let t = 0; t < ticks; t++) {
      for (const s of states) stepVehicle(s, NEUTRAL_INPUT, DT);
    }
  });
  const perTick = elapsed / ticks;
  const budget = perTick / (DT * 1000);
  console.log(
    `  ${String(count).padStart(8)}  ${perTick.toFixed(3).padStart(7)}  ${(budget * 100).toFixed(1).padStart(19)}%  ` +
      `${(1 / budget).toFixed(1).padStart(8)}x`,
  );
}

console.log('\n=== 3. hit detection: cost of one shot ===');
console.log('  vehicles  ms/shot  shots per tick budget');
for (const count of [2, 8, 30, 60]) {
  const vehicles: CombatVehicle[] = [];
  const members: CombatMember[] = [];
  for (let i = 0; i < count; i++) {
    const v = makeVehicle(i);
    vehicles.push(v);
    // Rewind history, as the server keeps it.
    for (let h = 0; h < COMBAT.historyTicks; h++) {
      v.history.push({ tick: h, x: v.state.pos.x - h * 0.3, y: v.state.pos.y, z: v.state.pos.z, yaw: 0 });
    }
    for (let s = 0; s < 4; s++) {
      members.push({
        id: i * 4 + s,
        crew: i,
        seat: (['seat.driver', 'seat.frontRight', 'seat.rearLeft', 'seat.rearRight'] as const)[s],
        hp: 100,
        alive: true,
      });
    }
  }
  const shots = 400;
  const elapsed = ms(() => {
    for (let i = 0; i < shots; i++) {
      resolveHitscan(vehicles, members, -1, 0, 2, 0, 0.1, 0, -0.99, 220, 0.1);
    }
  });
  const perShot = elapsed / shots;
  console.log(
    `  ${String(count).padStart(8)}  ${perShot.toFixed(4).padStart(7)}  ${(DT * 1000 / perShot).toFixed(0).padStart(20)}`,
  );
}

console.log('\n=== 4. components in the snapshot ===');
{
  const withParts = Buffer.byteLength(JSON.stringify(makeSnapshot(8)));
  const partsOnly = Buffer.byteLength(
    JSON.stringify(createComponents()) +
      JSON.stringify(Object.fromEntries(COMPONENT_IDS.map((id) => [id, 120]))),
  );
  console.log(`  8-vehicle snapshot: ${withParts} bytes; component block alone ~${partsOnly} bytes/vehicle`);
  console.log(`  components cost roughly ${((partsOnly * 8 * NET.snapshotRate * 8) / 1000).toFixed(0)} kbit/s per client for 8 crews`);
}

console.log('\n=== 5. interest management: bytes a client actually receives ===');
{
  // The current 340 m arena keeps almost everything inside the interest radius,
  // so this models the map M10 exists FOR: ~1 km across, 30 cars.
  const COORD = 500; // half-extent, metres
  const cars = 30;
  const positions = Array.from({ length: cars }, (_, i) => ({
    x: -COORD + ((i * 137.5) % (COORD * 2)),
    z: -COORD + ((i * 311.7) % (COORD * 2)),
  }));
  const grid = new SpatialGrid<number>(NET.interestRadius);
  positions.forEach((p, i) => grid.insert(p.x, p.z, i));

  const snapFor = (ids: number[]): string =>
    JSON.stringify({
      vehicles: ids.map((i) => ({
        crew: i,
        cls: 'suv',
        x: positions[i].x,
        y: 1,
        z: positions[i].z,
        yaw: 0,
        hull: 1200,
        dead: false,
      })),
    });

  const full = snapFor(positions.map((_, i) => i));
  const visible = grid.queryRadius(positions[0].x, positions[0].z, NET.interestRadius);
  const filtered = snapFor(visible);
  const kbit = (bytes: number): number => (bytes * NET.snapshotRate * 8) / 1000;

  console.log(`  ${cars} cars over a ${COORD * 2} m map`);
  console.log(`  full snapshot        ${Buffer.byteLength(full)} bytes (${cars} cars)`);
  console.log(
    `  interest (${NET.interestRadius} m)    ${Buffer.byteLength(filtered)} bytes (${visible.length} cars) — ` +
      `${((Buffer.byteLength(filtered) / Buffer.byteLength(full)) * 100).toFixed(0)}%`,
  );
  console.log(
    `  per client @30Hz     ${kbit(Buffer.byteLength(full)).toFixed(0)} → ${kbit(Buffer.byteLength(filtered)).toFixed(0)} kbit/s`,
  );
}
