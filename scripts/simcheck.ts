/**
 * Headless simulation checks.
 *
 * The shared simulation is the one part of this project that MUST be correct:
 * the server runs this exact code as the authority, so a bug here is a desync
 * rather than a visual glitch. These run without a browser so handling
 * regressions are caught the moment they're introduced.
 *
 *   npm run simcheck
 *
 * TWO ARENAS. Handling tests (acceleration, drift, boost, attitude) run on a
 * flat proving ground, and arena tests (ramps, walls, spawns, symmetry) run on
 * the real map. This separation is not tidiness — handling tests used to run on
 * the real arena along a "lane that is definitely clear", and when the arena was
 * redesigned that lane ran straight into a new centre ramp and eighteen
 * assertions failed for reasons that had nothing to do with the vehicle.
 */

import {
  HAZARD,
  MATCH,
  PALETTE,
  REPAIR,
  TICK,
  VEHICLE,
  VEHICLE_CLASSES,
  ZONE,
} from '../src/shared/config';
import { canRepair } from '../src/shared/repair';
import { COMBAT_TEST_CREWS } from './testPlacement';
import {
  ARENA_HALF,
  hazardAt,
  isBlockingAt,
  raycastSolids,
  REPAIR_CRATES,
  SOLIDS,
  SOLO_SPAWN_RADIUS,
  SPAWN,
  SPAWNS,
  spawnRing,
  terrainHeightAt,
  type Solid,
  STADIUM_HALF,
  STADIUM_WALL,
} from '../src/shared/arena';
import { wrapAngle } from '../src/shared/math';
import { buildZonePlan, seededRandom, zoneAt, zoneRules } from '../src/shared/zone';
import { SpatialGrid } from '../src/shared/grid';
import { seatsFor, withinArc } from '../src/shared/crews';
import {
  COMPONENT_IDS,
  createComponents,
  driveFactor,
  engineOutput,
  engineTopSpeed,
  gripFactor,
  steerPull,
  type Components,
} from '../src/shared/components';
import {
  carObb,
  createVehicle,
  NEUTRAL_INPUT,
  obbOverlap,
  resolveRams,
  solidObb,
  stepVehicle,
  type VehicleInput,
  type VehicleState,
} from '../src/shared/vehicle';

const DT = TICK.dt;

/**
 * Handling tests run on the SUV — the default class. Per-class behaviour is
 * covered separately in test 19.
 */
const TEST_SPEC = VEHICLE_CLASSES.suv;

let failures = 0;

function check(label: string, condition: boolean, detail = ''): void {
  const mark = condition ? 'PASS' : 'FAIL';
  if (!condition) failures++;
  console.log(`  [${mark}] ${label}${detail ? ` — ${detail}` : ''}`);
}

function input(partial: Partial<VehicleInput> = {}): VehicleInput {
  return { ...NEUTRAL_INPUT, ...partial };
}

function run(state: VehicleState, ticks: number, partial: Partial<VehicleInput>): void {
  const i = input(partial);
  for (let t = 0; t < ticks; t++) stepVehicle(state, i, DT);
}

const kmh = (v: number) => (v * 3.6).toFixed(1);

// ------------------------------------------------------------------ arenas

const REAL_ARENA: Solid[] = [...SOLIDS];

/** Roomy, featureless proving ground so handling never depends on map layout. */
const FLAT_ARENA: Solid[] = [
  { kind: 'box', min: { x: -160, y: -2, z: -160 }, max: { x: 160, y: 0, z: 160 }, color: 0 },
  { kind: 'box', min: { x: -160, y: 0, z: -164 }, max: { x: 160, y: 12, z: -160 }, color: 0 },
  { kind: 'box', min: { x: -160, y: 0, z: 160 }, max: { x: 160, y: 12, z: 164 }, color: 0 },
  { kind: 'box', min: { x: -164, y: 0, z: -160 }, max: { x: -160, y: 12, z: 160 }, color: 0 },
  { kind: 'box', min: { x: 160, y: 0, z: -160 }, max: { x: 164, y: 12, z: 160 }, color: 0 },
];

function useArena(arena: Solid[]): void {
  SOLIDS.splice(0, SOLIDS.length, ...arena);
}

/** Inject a temporary ramp for a test, and remove it afterwards. */
function withTestRamp<T>(
  r: { x0: number; x1: number; z0: number; z1: number; hStart: number; hEnd: number; along: 'x' | 'z' },
  fn: () => T,
): T {
  const solid: Solid = {
    kind: 'ramp',
    min: { x: r.x0, y: 0, z: r.z0 },
    max: { x: r.x1, y: Math.max(r.hStart, r.hEnd), z: r.z1 },
    along: r.along,
    hStart: r.hStart,
    hEnd: r.hEnd,
    color: 0,
  };
  SOLIDS.push(solid);
  try {
    return fn();
  } finally {
    SOLIDS.pop();
  }
}

/** Clear lane on the flat proving ground. */
const LANE_Z = -20;
const LANE_X = -70;
const LANE_YAW = -Math.PI / 2;
const onLane = () => createVehicle(LANE_X, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);

// ================================================================= config

console.log('\n=== 0. configuration sanity ===');
{
  // If rolling resistance can cancel the engine before `maxSpeed`, the car tops
  // out early and the top-speed clamp is dead code. This exact bug shipped once.
  const terminal = VEHICLE.engineForce / VEHICLE.rollingResistance;
  check(
    'engine can out-accelerate rolling resistance past maxSpeed',
    terminal > VEHICLE.maxSpeed * 1.2,
    `terminal ${terminal.toFixed(1)} m/s vs maxSpeed ${VEHICLE.maxSpeed}`,
  );
  const boostTerminal = (VEHICLE.engineForce * VEHICLE.boost.forceMultiplier) / VEHICLE.rollingResistance;
  const boostCap = VEHICLE.maxSpeed * VEHICLE.boost.multiplier;
  check('boosted engine reaches the boosted cap', boostTerminal > boostCap);
}

// ================================================================== arena

useArena(REAL_ARENA);

console.log('\n=== 1. settles onto the ground from spawn ===');
{
  const s = createVehicle(SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.yaw);
  run(s, 90, {});
  check('is grounded', s.onGround);
  // Ride height is measured ABOVE THE SURFACE, not above y=0: the ground is
  // zoned rings (and, since M12, roads) a few centimetres proud, so the correct
  // invariant is `rideHeight + ground`, which no longer assumes a flat world.
  const ground = terrainHeightAt(SPAWN.x, SPAWN.z, 100);
  check(
    'rests near ride height above the surface',
    Math.abs(s.pos.y - (TEST_SPEC.rideHeight + ground)) < 0.05,
    `y=${s.pos.y.toFixed(3)} over ${ground.toFixed(3)}`,
  );
}

console.log('\n=== 5. the centre is climbable from any side ===');
{
  // The centre platform is the contested objective, so every approach must
  // actually work. A ramp that is one-way, or unreachable, would decide matches.
  let climbed = 0;
  for (const spawn of [SPAWNS[0], SPAWNS[2], SPAWNS[4], SPAWNS[6]]) {
    const s = createVehicle(spawn.x, spawn.y, spawn.z, spawn.yaw);
    let peak = 0;
    for (let t = 0; t < 600; t++) {
      stepVehicle(s, input({ throttle: 1 }), DT);
      peak = Math.max(peak, s.pos.y);
    }
    if (peak > 3) climbed++;
  }
  check('all four approaches reach the platform', climbed === 4, `${climbed}/4 climbed above 3 m`);
}

console.log('\n=== 6. perimeter wall stops the car ===');
{
  const s = createVehicle(0, TEST_SPEC.rideHeight, -95, 0);
  run(s, 300, { throttle: 1 });
  check('did not pass through the north wall', s.pos.z > -ARENA_HALF - 1, `z=${s.pos.z.toFixed(2)}`);
}

console.log('\n=== 6b. the arena cannot be escaped diagonally ===');
{
  // Corners are the classic escape hatch: if the perimeter walls merely meet
  // edge to edge, a car driving diagonally slips out through the gap.
  for (const [label, yaw] of [
    ['north-east', -Math.PI / 4],
    ['north-west', Math.PI / 4],
    ['south-east', (-3 * Math.PI) / 4],
    ['south-west', (3 * Math.PI) / 4],
  ] as const) {
    const s = createVehicle(0, TEST_SPEC.rideHeight, 0, yaw);
    run(s, 600, { throttle: 1 });
    check(
      `contained in the ${label} corner`,
      Math.abs(s.pos.x) < ARENA_HALF + 1 && Math.abs(s.pos.z) < ARENA_HALF + 1,
      `ended at (${s.pos.x.toFixed(1)}, ${s.pos.z.toFixed(1)})`,
    );
  }
}

console.log('\n=== 17. every spawn point is clear, for every class ===');
{
  // Regression: spawn points used to sit INSIDE the side launch ramps. A car
  // placed there is embedded in solid geometry and cannot drive out — and
  // because server and client agreed about it, it looked like a netcode bug.
  //
  // Both classes are checked because the SUV is wider and longer: a spawn that
  // is clear for the coupe can still bury the SUV in geometry.
  for (const spec of Object.values(VEHICLE_CLASSES)) {
    let blocked = 0;
    let worst = 0;
    for (const spawn of SPAWNS) {
      const s = createVehicle(spawn.x, spawn.y, spawn.z, spawn.yaw, spec);
      run(s, 120, {});
      const drift = Math.hypot(s.pos.x - spawn.x, s.pos.z - spawn.z);
      if (drift >= 2 || !s.onGround) blocked++;
      worst = Math.max(worst, drift);
    }
    check(
      `${spec.label}: all ${SPAWNS.length} spawns clear`,
      blocked === 0,
      `${blocked} blocked, worst drift ${worst.toFixed(2)} m`,
    );
  }

  // The solo field is sixteen cars on a GENERATED ring — a fixed eight would
  // stack them two deep. The wider ring must be as clear as the authored eight.
  for (const spec of Object.values(VEHICLE_CLASSES)) {
    let blocked = 0;
    let worst = 0;
    // The solo ring sits further out than the duel ring, so it must be tested at
    // its own radius, not the default.
    for (const spawn of spawnRing(MATCH.soloCars, SOLO_SPAWN_RADIUS)) {
      const s = createVehicle(spawn.x, spawn.y, spawn.z, spawn.yaw, spec);
      run(s, 120, {});
      const drift = Math.hypot(s.pos.x - spawn.x, s.pos.z - spawn.z);
      if (drift >= 2 || !s.onGround) blocked++;
      worst = Math.max(worst, drift);
    }
    check(
      `${spec.label}: all ${MATCH.soloCars} solo-ring spawns clear`,
      blocked === 0,
      `${blocked} blocked, worst drift ${worst.toFixed(2)} m`,
    );
  }
}

console.log('\n=== 18. the arena is genuinely 4-fold symmetric ===');
{
  // The layout is written once and replicated by rotation, which is only worth
  // anything if the rotation is correct — a ramp whose high end lands on the
  // wrong side is an unfair map, not a cosmetic bug.
  let mismatches = 0;
  let samples = 0;
  // Sample out to the new rim (M11): symmetry must hold across the whole map,
  // not just the middle, or a far zone could be unfair.
  for (let x = -380; x <= 380; x += 5) {
    for (let z = -380; z <= 380; z += 5) {
      const here = terrainHeightAt(x, z, 100);
      const turned = terrainHeightAt(z, -x, 100);
      samples++;
      if (Math.abs(here - turned) > 1e-6) mismatches++;
    }
  }
  check(
    'height field maps onto itself under a quarter turn',
    mismatches === 0,
    `${mismatches}/${samples} samples differed`,
  );

  let spawnMismatches = 0;
  for (const spawn of SPAWNS) {
    const target = { x: spawn.z, z: -spawn.x };
    if (!SPAWNS.some((o) => Math.hypot(o.x - target.x, o.z - target.z) < 1e-6)) spawnMismatches++;
  }
  check('every spawn has a rotational counterpart', spawnMismatches === 0, `${spawnMismatches} without`);
}

// =============================================================== handling

useArena(FLAT_ARENA);

console.log('\n=== 2. acceleration is gradual and controllable ===');
{
  const s = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  let t100 = -1;
  let tTop = -1;
  for (let t = 0; t < 460; t++) {
    stepVehicle(s, input({ throttle: 1 }), DT);
    if (t100 < 0 && s.forwardSpeed >= 100 / 3.6) t100 = t * DT;
    if (tTop < 0 && s.forwardSpeed >= VEHICLE.maxSpeed * 0.99) {
      tTop = t * DT;
      break;
    }
  }
  check('0-100 km/h is neither instant nor sluggish', t100 > 2 && t100 < 6, `${t100.toFixed(2)}s`);
  check('top speed takes real time to build', tTop > t100 + 0.5, `top in ${tTop.toFixed(2)}s`);
  check('never exceeds top speed', s.forwardSpeed <= VEHICLE.maxSpeed + 0.01, kmh(s.forwardSpeed));

  const half = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  const full = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  run(half, 120, { throttle: 0.5 });
  run(full, 120, { throttle: 1 });
  check(
    'half throttle pulls noticeably less than full',
    half.forwardSpeed > 1 && half.forwardSpeed < full.forwardSpeed * 0.75,
    `half ${kmh(half.forwardSpeed)} vs full ${kmh(full.forwardSpeed)} km/h`,
  );
}

console.log('\n=== 3. steering turns the car the right way ===');
{
  const right = onLane();
  const left = onLane();
  run(right, 30, { throttle: 1, steer: 1 });
  run(left, 30, { throttle: 1, steer: -1 });
  check('steer right decreases yaw', right.yaw < LANE_YAW - 0.05);
  check('steer left increases yaw', left.yaw > LANE_YAW + 0.05);
}

console.log('\n=== 4. handbrake breaks lateral grip (drift) ===');
{
  const grip = onLane();
  const drift = onLane();
  run(grip, 300, { throttle: 1 });
  run(drift, 300, { throttle: 1 });
  check('built speed before the turn', grip.forwardSpeed > 25, kmh(grip.forwardSpeed));

  let gripSlip = 0;
  let driftSlip = 0;
  const g = input({ throttle: 0.5, steer: 1 });
  const d = input({ throttle: 0.5, steer: 1, handbrake: true });
  for (let t = 0; t < 45; t++) {
    stepVehicle(grip, g, DT);
    stepVehicle(drift, d, DT);
    gripSlip = Math.max(gripSlip, Math.abs(grip.slipSpeed));
    driftSlip = Math.max(driftSlip, Math.abs(drift.slipSpeed));
  }
  check(
    'handbrake produces markedly more slip',
    driftSlip > gripSlip * 1.5,
    `drift=${driftSlip.toFixed(2)} grip=${gripSlip.toFixed(2)} m/s`,
  );
}

console.log('\n=== 7. boost raises top speed and drains the meter ===');
{
  const normal = onLane();
  const boosted = onLane();
  boosted.boost = VEHICLE.boost.max;
  run(normal, 180, { throttle: 1 });
  run(boosted, 180, { throttle: 1, boost: true });
  check(
    'boosted speed exceeds normal top speed',
    boosted.forwardSpeed > normal.forwardSpeed + 5,
    `boosted ${kmh(boosted.forwardSpeed)} vs normal ${kmh(normal.forwardSpeed)}`,
  );
}

console.log('\n=== 8. determinism: identical inputs, identical result ===');
{
  const a = createVehicle(SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.yaw);
  const b = createVehicle(SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.yaw);
  const script: Partial<VehicleInput>[] = [
    { throttle: 1 },
    { throttle: 1, steer: 1 },
    { throttle: 1, steer: 1, handbrake: true },
    { throttle: -1, steer: -1 },
    { boost: true, throttle: 1, steer: 0.3 },
  ];
  for (let rep = 0; rep < 40; rep++) {
    const frame = script[rep % script.length];
    stepVehicle(a, input(frame), DT);
    stepVehicle(b, input(frame), DT);
  }
  const same = a.pos.x === b.pos.x && a.pos.y === b.pos.y && a.pos.z === b.pos.z && a.yaw === b.yaw;
  check('two runs are bit-identical', same, same ? 'exact match' : 'DIVERGED — prediction will break');
}

console.log('\n=== 9. no NaNs after a long chaotic run ===');
{
  const s = createVehicle(SPAWN.x, SPAWN.y, SPAWN.z, SPAWN.yaw);
  const options: Partial<VehicleInput>[] = [
    { throttle: 1, steer: 0.7 },
    { throttle: 1, steer: -0.7, handbrake: true },
    { throttle: -1, steer: -1 },
    { throttle: 1, steer: 0.2, boost: true },
    { throttle: 0 },
  ];
  for (let rep = 0; rep < 900; rep++) {
    stepVehicle(s, input(options[Math.floor(rep / 37) % options.length]), DT);
  }
  const finite = [s.pos.x, s.pos.y, s.pos.z, s.yaw, s.vel.x, s.vel.y, s.vel.z].every(Number.isFinite);
  check('state stayed finite', finite);
  check('stayed within the proving ground', Math.abs(s.pos.x) < 165 && Math.abs(s.pos.z) < 165);
}

console.log('\n=== 10. ramp launch scales with entry speed ===');
{
  // A short steep ramp so entry speed actually survives to the launch: on a long
  // ramp any car under throttle reaches top speed before the lip and the
  // relationship disappears.
  withTestRamp({ x0: -6, x1: 6, z0: 88, z1: 98, hStart: 4, hEnd: 0, along: 'z' }, () => {
    const launchPeak = (entrySpeed: number) => {
      const s = createVehicle(0, TEST_SPEC.rideHeight, 100, 0);
      s.vel.z = -entrySpeed;
      s.onGround = true;
      s.groundY = 0;
      let peak = 0;
      for (let t = 0; t < 300; t++) {
        stepVehicle(s, input({ throttle: 1 }), DT);
        if (!s.onGround) peak = Math.max(peak, s.pos.y);
      }
      return peak;
    };
    const slow = launchPeak(4);
    const fast = launchPeak(40);
    check('faster entry launches higher', fast > slow + 0.3, `${slow.toFixed(2)} m vs ${fast.toFixed(2)} m`);
  });
}

console.log('\n=== 11. lifting off brings the car to a stop ===');
{
  const s = onLane();
  let warm = 0;
  while (warm < 900 && s.forwardSpeed < VEHICLE.maxSpeed * 0.99) {
    stepVehicle(s, input({ throttle: 1 }), DT);
    warm++;
  }
  check('reached top speed before lifting off', s.forwardSpeed > 30, kmh(s.forwardSpeed));

  let ticks = 0;
  for (; ticks < 900; ticks++) {
    stepVehicle(s, input({}), DT);
    if (Math.abs(s.forwardSpeed) < 0.01) break;
  }
  const seconds = ticks * DT;
  check('comes to a complete stop', Math.abs(s.forwardSpeed) < 0.01, `${seconds.toFixed(2)}s`);
  check('neither glides on nor stops unnaturally fast', seconds > 1 && seconds < 6, `${seconds.toFixed(2)}s`);

  // Regression: a "released" analogue throttle never reaches exactly zero —
  // exponential smoothing leaves values like 1e-27, which is NOT zero, so the
  // simulation took the on-the-power branch and engine braking never engaged.
  // The car coasted on rolling resistance alone and appeared never to stop.
  // Real, in-game, and invisible to this suite until it was fed a denormal.
  // Measured over one second, because total stopping time is confounded: rolling
  // resistance alone eventually stops the car too, just far more slowly, so
  // "does it stop" cannot tell the two cases apart. Deceleration can — engine
  // braking sheds roughly 12 m/s in a second at this speed, resistance alone
  // about 3.5.
  const creep = onLane();
  run(creep, 300, { throttle: 1 });
  const creepBefore = creep.forwardSpeed;
  run(creep, 60, { throttle: 1e-27 });
  const shed = creepBefore - creep.forwardSpeed;
  check(
    'a denormal throttle counts as released (engine braking engages)',
    shed > 7,
    `shed ${shed.toFixed(1)} m/s in 1 s (resistance alone would be ~3.5)`,
  );
}

console.log('\n=== 12. the car does not move on its own ===');
{
  const s = onLane();
  run(s, 300, {});
  const drift = Math.hypot(s.pos.x - LANE_X, s.pos.z - LANE_Z);
  check('stays put with no input', drift < 0.01, `moved ${drift.toFixed(4)} m`);
}

console.log('\n=== 13. the handbrake is always felt ===');
{
  check(
    'handbrake is stronger than engine braking',
    VEHICLE.handbrakeBraking > VEHICLE.engineBraking,
    `${VEHICLE.handbrakeBraking} vs ${VEHICLE.engineBraking} m/s²`,
  );

  const plain = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  const braked = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  run(plain, 180, { throttle: 1 });
  run(braked, 180, { throttle: 1 });
  run(plain, 60, { throttle: 1 });
  run(braked, 60, { throttle: 1, handbrake: true });
  check(
    'slows the car even under full throttle',
    braked.forwardSpeed < plain.forwardSpeed - 3,
    `handbrake ${kmh(braked.forwardSpeed)} vs plain ${kmh(plain.forwardSpeed)}`,
  );
}

console.log('\n=== 14. drifting: the car points away from its travel ===');
{
  const s = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  run(s, 300, { throttle: 1 });
  const entry = Math.hypot(s.vel.x, s.vel.z);

  let peakSlip = 0;
  let peakDriftAngle = 0;
  let slideTicks = 0;
  for (let t = 0; t < 120; t++) {
    const steer = t < 42 ? 1 : -0.55; // turn in, then counter-steer
    stepVehicle(s, input({ throttle: 1, steer, handbrake: true }), DT);
    const slip = Math.abs(s.slipSpeed);
    peakSlip = Math.max(peakSlip, slip);
    if (slip > 5) slideTicks++;
    const travelYaw = Math.atan2(-s.vel.x, -s.vel.z);
    peakDriftAngle = Math.max(peakDriftAngle, Math.abs((wrapAngle(travelYaw - s.yaw) * 180) / Math.PI));
  }
  const exit = Math.hypot(s.vel.x, s.vel.z);

  check('breaks traction hard', peakSlip > 10, `peak slip ${peakSlip.toFixed(1)} m/s`);
  check('visibly points away from its travel', peakDriftAngle > 20, `${peakDriftAngle.toFixed(0)}°`);
  check('the slide is sustained', slideTicks * DT > 1, `${(slideTicks * DT).toFixed(2)}s`);
  check('keeps most of its speed', exit > entry * 0.6, `exit ${kmh(exit)} of ${kmh(entry)} km/h`);
}

console.log('\n=== 15. chassis attitude is stable over a ramp launch ===');
{
  // Regression: leaving a ramp used to make the back end flap. Pitch came from
  // the raw front/rear average of ground heights, so the moment the front wheels
  // crossed the lip they sampled the floor several metres below while the rear
  // was still climbing. Measuring the per-tick change captures exactly that.
  withTestRamp({ x0: -8, x1: 8, z0: 40, z1: 70, hStart: 4.5, hEnd: 0, along: 'z' }, () => {
    const s = createVehicle(0, TEST_SPEC.rideHeight, 110, 0);
    run(s, 60, { throttle: 1 });

    let maxPitchStep = 0;
    let maxRollStep = 0;
    let sawAir = false;
    let prevPitch = s.pitch;
    let prevRoll = s.roll;

    for (let t = 0; t < 400; t++) {
      stepVehicle(s, input({ throttle: 1 }), DT);
      if (!s.onGround) sawAir = true;
      maxPitchStep = Math.max(maxPitchStep, Math.abs(s.pitch - prevPitch));
      maxRollStep = Math.max(maxRollStep, Math.abs(s.roll - prevRoll));
      prevPitch = s.pitch;
      prevRoll = s.roll;
    }

    check('the car actually left the ramp', sawAir);
    check('pitch never snaps', (maxPitchStep * 180) / Math.PI < 12, `max ${((maxPitchStep * 180) / Math.PI).toFixed(1)}°/tick`);
    check('roll never snaps', (maxRollStep * 180) / Math.PI < 12, `max ${((maxRollStep * 180) / Math.PI).toFixed(1)}°/tick`);
    check('attitude stays within its clamp', Math.abs(s.pitch) <= VEHICLE.maxAttitude + 1e-6);
  });
}

console.log('\n=== 16. an empty boost meter gives nothing ===');
{
  // Regression: holding boost on a nearly-empty meter alternated drain/hold and
  // momentum-gain, firing boost on every other tick forever. The meter read
  // empty while the car kept accelerating past its normal top speed.
  const normal = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  const drained = createVehicle(-100, TEST_SPEC.rideHeight, LANE_Z, LANE_YAW);
  run(normal, 120, { throttle: 1 });
  run(drained, 120, { throttle: 1 });

  drained.boost = 0.4;
  run(normal, 180, { throttle: 1 });
  run(drained, 180, { throttle: 1, boost: true });

  check('holding boost on an empty meter does not regrow it', drained.boost < 0.05, `meter=${drained.boost.toFixed(3)}`);
  check('and stays within its normal top speed', drained.forwardSpeed < VEHICLE.maxSpeed + 1, kmh(drained.forwardSpeed));
  check(
    'matching a plain run exactly',
    Math.abs(drained.forwardSpeed - normal.forwardSpeed) < 2,
    `drained ${kmh(drained.forwardSpeed)} vs normal ${kmh(normal.forwardSpeed)}`,
  );

  run(drained, 120, { throttle: 1 });
  check('releasing boost lets it refill', drained.boost > 1, `meter=${drained.boost.toFixed(2)}`);
}

console.log('\n=== 19. the two vehicle classes are genuinely different ===');
{
  const { coupe, suv } = VEHICLE_CLASSES;

  check(
    'the classes differ in size',
    coupe.halfLength !== suv.halfLength && coupe.boxHeight !== suv.boxHeight,
    `coupe ${coupe.halfLength}×${coupe.boxHeight} · suv ${suv.halfLength}×${suv.boxHeight}`,
  );
  check(
    'the SUV is the larger vehicle',
    suv.halfLength > coupe.halfLength &&
      suv.halfWidth >= coupe.halfWidth &&
      suv.boxHeight > coupe.boxHeight &&
      suv.rideHeight > coupe.rideHeight,
  );
  check(
    'the SUV is not merely scaled up in every axis',
    coupe.wheelbase / coupe.halfLength !== suv.wheelbase / suv.halfLength,
    'wheelbase-to-length ratio differs, so they are distinct layouts',
  );

  // Each class must settle on ITS OWN ride height. A shared ride height would
  // leave one of them sunk into the ground or hovering above it.
  for (const spec of [coupe, suv]) {
    const s = createVehicle(LANE_X, 5, LANE_Z, LANE_YAW, spec);
    run(s, 200, {});
    check(
      `${spec.label} settles at its own ride height`,
      s.onGround && Math.abs(s.pos.y - spec.rideHeight) < 0.05,
      `y=${s.pos.y.toFixed(3)}, expected ${spec.rideHeight}`,
    );
  }
}

console.log('\n=== 20. window arcs cover the seat they belong to ===');
{
  // Regression: aim yaw is LEFT-positive (see crews.ts), and the arcs were
  // originally written as if it were right-positive — so every gunner's field of
  // fire was mirrored onto the wrong side of the car. A front-right gunner could
  // not shoot to the right, which presents as "the gun is broken".
  const RIGHT = -Math.PI / 2;
  const LEFT = Math.PI / 2;

  let wrongSide = 0;
  let uncovered = 0;
  for (const cls of ['coupe', 'suv'] as const) {
    for (const seat of seatsFor(cls)) {
      if (!seat.arc) {
        if (!seat.drives) uncovered++;
        continue;
      }
      const outward = seat.side === 'right' ? RIGHT : LEFT;
      if (!withinArc(seat.arc, outward)) {
        wrongSide++;
        console.log(`      ${cls} ${seat.id} (${seat.side} side) does not cover its own side`);
      }
    }
  }

  check('every armed seat covers its own side of the car', wrongSide === 0, `${wrongSide} mirrored`);
  check('only the driver is unarmed', uncovered === 0, `${uncovered} armed seats without an arc`);

  // And a bare assertion of the convention itself, so a future refactor of the
  // yaw maths cannot silently invert it again.
  const forwardYaw = 0;
  const eastOfCar = { dx: 10, dz: 0 };
  const aimAtEast = Math.atan2(-eastOfCar.dx, -eastOfCar.dz) - forwardYaw;
  check(
    'a target to the car\'s right needs a NEGATIVE aim yaw',
    aimAtEast < 0,
    `aim yaw to the right is ${((aimAtEast * 180) / Math.PI).toFixed(0)}°`,
  );
}

console.log("\n=== 24. the combat test's line of fire is clear ===");
{
  useArena(REAL_ARENA);

  // combattest runs end-to-end against the real map. If the arena changes under
  // it, this fails FIRST and says why — instead of that test failing with what
  // looks like a combat bug. See scripts/testPlacement.ts.
  let blocked = 0;
  for (const crew of COMBAT_TEST_CREWS) {
    const ground = terrainHeightAt(crew.x, crew.z, 40);
    if (!Number.isFinite(ground)) {
      blocked++;
      continue;
    }
    for (const solid of SOLIDS) {
      if (isBlockingAt(solid, crew.x, crew.z, ground, VEHICLE.stepUp)) blocked++;
    }
  }
  check('both combat-test crews sit on clear ground', blocked === 0, `${blocked} blocked`);

  const a = COMBAT_TEST_CREWS[0];
  const b = COMBAT_TEST_CREWS[1];
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  const ux = dx / length;
  const uz = dz / length;
  // Two heights, because the muzzle and the hull centre are not the same one.
  const obstructed =
    raycastSolids(a.x, 1.1, a.z, ux, 0, uz, length) !== null ||
    raycastSolids(a.x, 1.5, a.z, ux, 0, uz, length) !== null;
  check(
    'the line of fire between them is unobstructed',
    !obstructed,
    `${length.toFixed(0)} m`,
  );
  check('and they are far enough apart to be meaningful', length > 40, `${length.toFixed(0)} m`);
}

console.log('\n=== 23. repair crates ===');
{
  useArena(REAL_ARENA);

  check('there are crates to fight over', REPAIR_CRATES.length === 5, `${REPAIR_CRATES.length}`);

  // A crate buried in geometry is unreachable, which makes it worse than absent:
  // players will drive at it and bounce off.
  let buried = 0;
  for (const crate of REPAIR_CRATES) {
    const ground = terrainHeightAt(crate.x, crate.z, 40);
    if (!Number.isFinite(ground)) {
      buried++;
      continue;
    }
    for (const solid of SOLIDS) {
      if (isBlockingAt(solid, crate.x, crate.z, ground, VEHICLE.stepUp)) buried++;
    }
  }
  check('no crate is buried in geometry', buried === 0, `${buried} blocked`);

  const onHazard = REPAIR_CRATES.filter((c) => hazardAt(c.x, c.z) > 0).length;
  check('no crate sits on damaging ground', onHazard === 0, `${onHazard} on hazard`);

  const nearSpawn = REPAIR_CRATES.filter((c) =>
    SPAWNS.some((spawn) => Math.hypot(spawn.x - c.x, spawn.z - c.z) < 25),
  ).length;
  check('no crate sits on a spawn', nearSpawn === 0, `${nearSpawn} too close`);

  // Four scattered crates 4-fold symmetric, plus the contested centre. An
  // asymmetric crate decides matches before anyone drives.
  const scattered = REPAIR_CRATES.filter((c) => Math.hypot(c.x, c.z) > 1);
  const radii = scattered.map((c) => Math.hypot(c.x, c.z));
  const spread = Math.max(...radii) - Math.min(...radii);
  check(
    'the scattered crates are symmetric about the centre',
    spread < 0.01 && scattered.length === 4,
    `${scattered.length} at radius ${radii[0].toFixed(1)} m ±${spread.toFixed(3)}`,
  );

  // ---- the eligibility rule ----
  check('a still car at the crate repairs', canRepair({ distance: 2, speed: 0 }));
  check('a car at the very edge repairs', canRepair({ distance: REPAIR.radius, speed: 0.5 }));
  check('a car just outside does not', !canRepair({ distance: REPAIR.radius + 0.1, speed: 0 }));
  check(
    'driving past does not repair',
    !canRepair({ distance: 2, speed: REPAIR.holdSpeed + 1 }),
    `hold speed is ${REPAIR.holdSpeed} m/s`,
  );
  check('reversing past does not repair', !canRepair({ distance: 2, speed: -(REPAIR.holdSpeed + 1) }));
  check(
    'repairing takes real time',
    REPAIR.capacitySeconds >= 4 && REPAIR.hullPerSecond * REPAIR.capacitySeconds > 0,
    `${REPAIR.capacitySeconds}s of charge heals ${(REPAIR.hullPerSecond * REPAIR.capacitySeconds).toFixed(0)} hull`,
  );
}

console.log('\n=== 22. hazard patches are damaging ground ===');
{
  useArena(REAL_ARENA);

  // The hazard is authored in one quadrant and replicated, so all four copies
  // must be equally dangerous — an asymmetric hazard would decide matches.
  // The middle-ring hazard patch, sampled across its four rotational copies.
  // (The lakebed hazard lay outside the stadium barrier and was removed.)
  const spots = [
    { x: 50, z: 100, label: 'quadrant +x +z' },
    { x: 100, z: -50, label: 'quadrant +x -z' },
    { x: -50, z: -100, label: 'quadrant -x -z' },
    { x: -100, z: 50, label: 'quadrant -x +z' },
  ];
  let damaging = 0;
  for (const spot of spots) {
    if (hazardAt(spot.x, spot.z) > 0) damaging++;
  }
  check('every rotational copy of the hazard is damaging', damaging === 4, `${damaging}/4`);

  check(
    'clear ground is not',
    hazardAt(0, 0) === 0 && hazardAt(SPAWNS[0].x, SPAWNS[0].z) === 0,
    'centre and spawn ring are safe',
  );
  check(
    'the damage is gradual, not a kill',
    hazardAt(50, 100) > 0 && hazardAt(50, 100) < 1000,
    `${hazardAt(50, 100)} hull/s`,
  );
  check(
    'and hazards alone cannot finish a vehicle',
    HAZARD.hullFloor > 0,
    `floor is ${(HAZARD.hullFloor * 100).toFixed(0)}% hull`,
  );

  // No spawn may sit on hazard ground, or a crew would be damaged on arrival.
  const onHazard = SPAWNS.filter((spawn) => hazardAt(spawn.x, spawn.z) > 0).length;
  check('no spawn sits on a hazard', onHazard === 0, `${onHazard} spawns affected`);
}

console.log('\n=== 21. component damage degrades the car ===');
{
  useArena(FLAT_ARENA);

  // Full health must be EXACTLY neutral, or this feature just silently retuned
  // every handling number in the game.
  const full = createComponents();
  check(
    'full health is exactly neutral for motion',
    engineOutput(full.engine) === 1 &&
      engineTopSpeed(full.engine) === 1 &&
      gripFactor(full) === 1 &&
      driveFactor(full) === 1 &&
      steerPull(full) === 0,
    'every factor is exactly 1',
  );

  const drive = (damage: (c: Components) => void, ticks = 240): VehicleState => {
    const s = onLane();
    damage(s.components);
    run(s, ticks, { throttle: 1 });
    return s;
  };
  const distance = (s: VehicleState) => Math.hypot(s.pos.x - LANE_X, s.pos.z - LANE_Z);

  const healthy = drive(() => {});
  const deadEngine = drive((c) => {
    c.engine = 0;
  });
  const noWheels = drive((c) => {
    for (const id of COMPONENT_IDS) if (id !== 'engine') c[id] = 0;
  });

  check(
    'a healthy car covers real ground',
    distance(healthy) > 60,
    `${distance(healthy).toFixed(0)} m at ${kmh(healthy.forwardSpeed)} km/h`,
  );
  check(
    'a dead engine leaves the car limping, not stopped',
    deadEngine.forwardSpeed < healthy.forwardSpeed * 0.6 && deadEngine.forwardSpeed > 2,
    `${kmh(deadEngine.forwardSpeed)} km/h vs ${kmh(healthy.forwardSpeed)} healthy`,
  );
  check(
    'destroyed wheels immobilise the car',
    distance(noWheels) < 2,
    `moved ${distance(noWheels).toFixed(2)} m with the throttle pinned`,
  );

  // A wrecked side drags the car toward it — the damage you can feel.
  const hurt = (ids: Array<'wheel.fl' | 'wheel.fr' | 'wheel.rl' | 'wheel.rr'>) => {
    const s = onLane();
    for (const id of ids) s.components[id] = 0;
    run(s, 180, { throttle: 1 });
    return wrapAngle(s.yaw - LANE_YAW);
  };

  const leftPull = hurt(['wheel.fl', 'wheel.rl']);
  const rightPull = hurt(['wheel.fr', 'wheel.rr']);

  check('wrecked left tyres drag the car left', leftPull > 0.25, `yaw +${leftPull.toFixed(2)} rad`);
  check('wrecked right tyres drag it right', rightPull < -0.25, `yaw ${rightPull.toFixed(2)} rad`);
  check(
    'and an undamaged car tracks straight',
    Math.abs(wrapAngle(healthy.yaw - LANE_YAW)) < 0.05,
    `${wrapAngle(healthy.yaw - LANE_YAW).toFixed(3)} rad over 240 ticks`,
  );
}

console.log('\n=== 23. the car collides as a box, and cars ram (DESIGN.md §3.1) ===');
{
  useArena(FLAT_ARENA);

  // A car used to be three circles down its centreline, which rounded the
  // corners and sized the body to a circle — so a flank could sit inside a wall.
  // A rotated box overlapping a wall must be pushed fully clear.
  const wall: Solid = { kind: 'box', min: { x: 1.1, y: 0, z: -5 }, max: { x: 3, y: 6, z: 5 }, color: 0 };
  SOLIDS.push(wall);
  const wedged = createVehicle(0, 2, 0, Math.PI / 4, TEST_SPEC);
  stepVehicle(wedged, NEUTRAL_INPUT, DT);
  const wedgedLeft = obbOverlap(carObb(wedged), solidObb(wall));
  check(
    'a rotated car is pushed out of a wall, sides included',
    wedgedLeft === null || wedgedLeft.depth < 1e-3,
    `residual ${wedgedLeft ? wedgedLeft.depth.toFixed(4) : 0}`,
  );
  SOLIDS.pop();

  /** Two cars along z, with given yaws, velocities and separation. */
  const ram = (yawB: number, velA: number, velB: number, zB = -3.5) => {
    const a = createVehicle(0, 1, 0, 0, TEST_SPEC); // faces -z
    const b = createVehicle(0, 1, zB, yawB, TEST_SPEC);
    a.vel.z = velA;
    b.vel.z = velB;
    const hits = resolveRams([{ id: 0, state: a }, { id: 1, state: b }]);
    return { hits, a, b };
  };

  // Head-on: A faces -z, B faces +z, both driving into each other.
  const head = ram(Math.PI, -12, 12);
  check('a head-on ram is detected', head.hits.length === 1);
  const h = head.hits[0];
  check(
    'a head-on ram damages both cars equally',
    !!h && Math.abs(h.dmgA - h.dmgB) < 0.5,
    h ? `${h.dmgA.toFixed(1)} vs ${h.dmgB.toFixed(1)}` : 'none',
  );

  // A's nose into B's flank: B faces +x, so it presents its side. B is only
  // 2 m deep along z in this pose, so it must sit closer than the nose-to-tail
  // pair for the boxes to meet.
  const flank = ram(-Math.PI / 2, -12, 0, -2.6);
  check('a nose into a flank is detected', flank.hits.length === 1);
  const f = flank.hits[0];
  check(
    'the flanked car takes far more',
    !!f && f.dmgB > f.dmgA * 2,
    f ? `${f.dmgB.toFixed(1)} vs ${f.dmgA.toFixed(1)}` : 'none',
  );
  check('but the rammer still takes some', !!f && f.dmgA > 0);

  // A's nose into B's tail: B faces the same way, so A rear-ends it.
  const tail = ram(0, -14, -4);
  const t = tail.hits[0];
  check(
    'rear-ending costs the car in front more',
    !!t && t.dmgB > t.dmgA * 2,
    t ? `${t.dmgB.toFixed(1)} vs ${t.dmgA.toFixed(1)}` : 'none',
  );

  // Separation: two overlapping parked cars must no longer overlap.
  const p = createVehicle(0, 1, 0, 0, TEST_SPEC);
  const q = createVehicle(0, 1, -3, 0, TEST_SPEC);
  resolveRams([{ id: 0, state: p }, { id: 1, state: q }]);
  const left = obbOverlap(carObb(p), carObb(q));
  check(
    'overlapping cars are pushed apart',
    left === null || left.depth < 1e-3,
    `residual ${left ? left.depth.toFixed(4) : 0}`,
  );

  // A gentle touch must not score damage.
  const nudge = ram(0, -2, -2);
  check('a gentle nudge does no damage', nudge.hits.length === 0);
}

console.log('\n=== 24. the closing danger zone (DESIGN.md §2.2) ===');
{
  const rules = zoneRules({
    startRadius: 150,
    endRadius: 18,
    phases: 5,
    holdSeconds: 5,
    shrinkSeconds: 4,
    damagePerSecond: 20,
    damagePerPhase: 10,
  });
  const plan = buildZonePlan(rules, seededRandom(7));

  check(
    'the plan has one circle per phase, plus the opening',
    plan.circles.length === rules.phases + 1,
    `${plan.circles.length} circles`,
  );

  let shrinking = true;
  let nested = true;
  for (let i = 1; i < plan.circles.length; i++) {
    const prev = plan.circles[i - 1];
    const cur = plan.circles[i];
    if (cur.radius >= prev.radius) shrinking = false;
    // A new circle must sit entirely inside the old one, or the shrink could
    // strand a player outside safety they were legitimately standing in.
    if (Math.hypot(cur.x - prev.x, cur.z - prev.z) + cur.radius > prev.radius + 1e-6) nested = false;
  }
  check('every phase shrinks the radius', shrinking);
  check('and each circle sits inside the last', nested);
  check(
    'the final radius is the configured end',
    Math.abs(plan.circles[plan.circles.length - 1].radius - rules.endRadius) < 1e-9,
  );

  const final = plan.circles[plan.circles.length - 1];
  const moved = Math.hypot(final.x, final.z);
  check('the final circle is NOT the arena centre', moved > 1, `${moved.toFixed(1)} m off centre`);

  const other = buildZonePlan(rules, seededRandom(99));
  const otherFinal = other.circles[other.circles.length - 1];
  const apart = Math.hypot(otherFinal.x - final.x, otherFinal.z - final.z);
  check(
    'a different seed ends the match somewhere else',
    apart > 1,
    `${apart.toFixed(1)} m apart — the endgame is not scripted`,
  );

  const again = buildZonePlan(rules, seededRandom(7));
  const againFinal = again.circles[again.circles.length - 1];
  check(
    'the same seed reproduces the plan',
    againFinal.x === final.x && againFinal.z === final.z,
    'so a test can pin an ending',
  );
}

{
  const rules = zoneRules({
    startRadius: 100,
    endRadius: 20,
    phases: 2,
    holdSeconds: 4,
    shrinkSeconds: 2,
    damagePerSecond: 30,
    damagePerPhase: 40,
  });
  const plan = buildZonePlan(rules, seededRandom(3));

  const at0 = zoneAt(0, plan);
  check('the zone opens at the start radius', Math.abs(at0.radius - rules.startRadius) < 1e-9);
  check('and holds before the first shrink', !at0.shrinking && at0.nextShrinkMs > 0, `${Math.round(at0.nextShrinkMs)} ms`);

  const mid = zoneAt(rules.holdSeconds + rules.shrinkSeconds / 2, plan);
  check(
    'mid-shrink the radius is between the two circles',
    mid.radius < plan.circles[0].radius && mid.radius > plan.circles[1].radius,
  );
  check('and the boundary is moving', mid.shrinking);

  const done = zoneAt(1000, plan);
  check('after every phase the radius is the end radius', Math.abs(done.radius - rules.endRadius) < 1e-9);
  check('with no further shrink', !done.shrinking && done.nextShrinkMs === 0);
  check(
    'and the damage escalates phase by phase',
    done.damagePerSecond > at0.damagePerSecond,
    `${at0.damagePerSecond} → ${done.damagePerSecond} hull/s`,
  );
}

console.log('\n=== 25. the spatial grid (DESIGN.md §13.5) ===');
{
  const grid = new SpatialGrid<number>(32);
  grid.insert(0, 0, 1);
  grid.insert(10, 10, 2);
  grid.insert(300, 0, 3);

  check('a radius query finds what is near', grid.queryRadius(0, 0, 40).sort((a, b) => a - b).join(',') === '1,2');
  check('and nothing that is far', !grid.queryRadius(0, 0, 40).includes(3));
  check('a wide query finds everything', grid.queryRadius(0, 0, 400).includes(3));

  grid.clear();
  check('clear empties it', grid.queryRadius(0, 0, 400).length === 0);

  grid.insert(50, 0, 9);
  check('a point exactly on the radius is included', grid.queryRadius(0, 0, 50).includes(9));

  // Negative cells must work: the arena is centred on the origin.
  grid.clear();
  grid.insert(-120, -120, 7);
  check('negative coordinates index correctly', grid.queryRadius(-120, -120, 5).includes(7));
  check('and do not leak into the wrong cell', grid.queryRadius(120, 120, 5).length === 0);
}

console.log('\n=== 26. authored map: verticality, landmarks, roads (M12) ===');
{
  useArena(REAL_ARENA);

  // Verticality: the mesa is drivable high ground. Drive the ramp from the
  // centre side and the car must end up ON the plateau, not stopped at its
  // foot — a ramp you cannot climb is scenery, not a position.
  const mesa = createVehicle(112, 2, 36, -Math.PI / 2);
  let peak = 0;
  for (let t = 0; t < 900; t++) {
    stepVehicle(mesa, input({ throttle: 1 }), DT);
    peak = Math.max(peak, mesa.pos.y);
  }
  check(
    'the mesa ramp reaches the plateau',
    peak > TEST_SPEC.rideHeight + 3.5,
    `peak y ${peak.toFixed(2)}`,
  );

  // The stadium barrier bounds the playable floor: solid, on all four sides,
  // and far enough out that the closing zone starts inside it.
  const barrier = SOLIDS.filter(
    (s) =>
      s.kind === 'box' &&
      s.max.y === STADIUM_WALL &&
      Math.max(s.max.x - s.min.x, s.max.z - s.min.z) >= STADIUM_HALF * 2,
  );
  check('the stadium barrier has four sides', barrier.length === 4, `${barrier.length}`);
  const sides = [
    [STADIUM_HALF + 0.75, 0],
    [-STADIUM_HALF - 0.75, 0],
    [0, STADIUM_HALF + 0.75],
    [0, -STADIUM_HALF - 0.75],
  ];
  check(
    'and each side blocks a car on the ground',
    sides.every(([x, z]) => barrier.some((b) => isBlockingAt(b, x, z, TEST_SPEC.rideHeight, VEHICLE.stepUp))),
  );
  check('the zone opens inside the barrier', ZONE.startRadius < STADIUM_HALF, `${ZONE.startRadius} < ${STADIUM_HALF}`);
  {
    // Drive flat out at the east barrier from the middle: the car must stop at it.
    const runner = createVehicle(150, 2, 0, -Math.PI / 2);
    for (let t = 0; t < 600; t++) stepVehicle(runner, input({ throttle: 1 }), DT);
    check('a car driven at the barrier stops at it', runner.pos.x < STADIUM_HALF, `x=${runner.pos.x.toFixed(1)}`);
  }

  // Roads are ground, not obstacles: a car stands on one without being stopped,
  // and the step is far under its step height.
  const road = SOLIDS.find((s) => s.ground === true && s.color === PALETTE.road);
  check('roads exist as ground', road !== undefined);
  check(
    'and a road is drivable, not a wall',
    road ? !isBlockingAt(road, 200, 0, TEST_SPEC.rideHeight, VEHICLE.stepUp) : false,
  );
}

console.log(
  failures === 0 ? '\n✓ all simulation checks passed\n' : `\n✗ ${failures} check(s) failed\n`,
);
process.exit(failures === 0 ? 0 : 1);
