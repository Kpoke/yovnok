/**
 * Deterministic arcade vehicle simulation.
 *
 * This is the heart of the game and the reason we use no physics engine
 * (DESIGN.md §13.2). The same code must run on the client for prediction and on
 * the server as the authority, so it is written to be:
 *
 *   - pure (no DOM, no renderer, no globals)
 *   - fixed-timestep (always call with TICK.dt)
 *   - free of randomness and wall-clock time
 *
 * Model: a kinematic arcade car rather than a full rigid body. The chassis
 * tracks a heading (`yaw`), a velocity, and a ground height sampled under its
 * wheels. Pitch and roll are derived from wheel contact heights for visuals and
 * for ramp launches — when the ground falls away beneath a car climbing a ramp,
 * the upward velocity it accumulated carries it into the air. That's what makes
 * jumps feel right without a suspension solver.
 */

import {
  clamp,
  damp,
  type Vec3,
  vec3,
} from './math';
import { isBlockingAt, SOLIDS, surfaceTopAt, terrainHeightAt, type Solid } from './arena';
import {
  copyComponents,
  createComponents,
  driveFactor,
  engineOutput,
  engineTopSpeed,
  gripFactor,
  resetComponents,
  steerPull,
  type Components,
} from './components';
import {
  DEFAULT_VEHICLE_CLASS,
  RAM,
  VEHICLE,
  VEHICLE_CLASSES,
  type VehicleSpec,
} from './config';

export type VehicleState = {
  /**
   * Which vehicle this is. Carried on the state because collision, ground
   * sampling and the wheel layout are all dimensional, and the two classes have
   * genuinely different sizes.
   */
  spec: VehicleSpec;
  /** Chassis centre, in metres above the ground plane at rest. */
  pos: Vec3;
  /** Linear velocity, m/s. */
  vel: Vec3;
  /** Heading in radians. Forward is -Z at yaw 0; +yaw turns left. */
  yaw: number;
  /** Derived from wheel contact heights, for rendering. */
  pitch: number;
  roll: number;
  /** Ground height sampled last tick, used to derive ramp climb rate. */
  groundY: number;
  onGround: boolean;
  /** Ticks since the last ground contact; > 0 means airborne. */
  airborneTicks: number;
  /** Boost charge, 0..VEHICLE.boost.max. */
  boost: number;
  /** Set for one tick when the car takes a hard impact. Used for feedback. */
  impact: number;
  /** Forward speed in m/s (signed), cached for rendering and HUD. */
  forwardSpeed: number;
  /** Lateral slip speed in m/s, cached to detect and display drifting. */
  slipSpeed: number;
  /**
   * Damageable components. In the SIMULATION and not beside it, unlike `hull`:
   * these change how the car moves, so client prediction has to see them.
   */
  components: Components;
};

export type VehicleInput = {
  /** -1 (reverse) .. 1 (forward). */
  throttle: number;
  /** -1 (left) .. 1 (right). */
  steer: number;
  handbrake: boolean;
  boost: boolean;
};

export const NEUTRAL_INPUT: VehicleInput = {
  throttle: 0,
  steer: 0,
  handbrake: false,
  boost: false,
};

export function createVehicle(
  x = 0,
  y = 2,
  z = 0,
  yaw = 0,
  spec: VehicleSpec = VEHICLE_CLASSES[DEFAULT_VEHICLE_CLASS],
): VehicleState {
  return {
    spec,
    pos: vec3(x, y, z),
    vel: vec3(),
    yaw,
    pitch: 0,
    roll: 0,
    groundY: y,
    onGround: false,
    airborneTicks: 0,
    boost: VEHICLE.boost.start,
    impact: 0,
    forwardSpeed: 0,
    slipSpeed: 0,
    components: createComponents(),
  };
}

export function resetVehicle(s: VehicleState, x: number, y: number, z: number, yaw: number): void {
  s.pos.x = x;
  s.pos.y = y;
  s.pos.z = z;
  s.vel.x = 0;
  s.vel.y = 0;
  s.vel.z = 0;
  s.yaw = yaw;
  s.pitch = 0;
  s.roll = 0;
  s.groundY = y;
  s.onGround = false;
  s.airborneTicks = 0;
  s.boost = VEHICLE.boost.start;
  s.impact = 0;
  s.forwardSpeed = 0;
  s.slipSpeed = 0;
  // A respawn is a fresh car. Components are part of that: it would be a nasty
  // surprise to respawn into a vehicle that still cannot steer.
  resetComponents(s.components);
}

/** Copy component health between states (snapshot -> local prediction). */
export function applyComponents(from: Components, to: Components): void {
  copyComponents(from, to);
}

// ------------------------------------------------------------------- helpers

/** Local (x, z) offset rotated into world space by the car's yaw. */
export function localToWorld(s: VehicleState, lx: number, lz: number): { x: number; z: number } {
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  return {
    x: s.pos.x + lx * c + lz * sn,
    z: s.pos.z - lx * sn + lz * c,
  };
}

/** Height of the chassis collision box's underside. */
const carBottom = (s: VehicleState): number => s.pos.y - s.spec.boxHeight / 2;

/**
 * Highest ground surface beneath any of the four wheels. Using the maximum
 * stops a car from sinking into a ramp when only part of it is on the slope.
 */
function groundUnderCar(s: VehicleState): number {
  const maxY = carBottom(s) + VEHICLE.stepUp;
  const hw = s.spec.track / 2;
  const hl = s.spec.wheelbase / 2;
  // front wheels sit at -Z (forward is -Z)
  const offsets: Array<[number, number]> = [
    [-hw, -hl],
    [hw, -hl],
    [-hw, hl],
    [hw, hl],
  ];
  let best = -Infinity;
  for (let i = 0; i < offsets.length; i++) {
    const p = localToWorld(s, offsets[i][0], offsets[i][1]);
    const h = terrainHeightAt(p.x, p.z, maxY);
    if (h > best) best = h;
  }
  return best;
}

/**
 * An oriented 2D box: a car's footprint, in world axes.
 *
 * The car used to be three circles down its centreline, which rounded the
 * corners and — worse — sized the collision to a circle radius rather than the
 * real body, so a car could put a flank through a wall. A box is the shape the
 * car actually is, and the same box serves car-vs-wall and car-vs-car.
 */
export type Obb = {
  cx: number;
  cz: number;
  /** Local +x axis in world space (the car's right). */
  ux: number;
  uz: number;
  /** Local +z axis in world space (the car's back; forward is -z). */
  vx: number;
  vz: number;
  hw: number;
  hl: number;
};

export function carObb(s: VehicleState): Obb {
  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  // `localToWorld` maps local (x, z) to (lx*c + lz*s, -lx*s + lz*c), so the
  // local axes land as follows.
  return { cx: s.pos.x, cz: s.pos.z, ux: c, uz: -sn, vx: sn, vz: c, hw: s.spec.halfWidth, hl: s.spec.halfLength };
}

export function solidObb(solid: Solid): Obb {
  return {
    cx: (solid.min.x + solid.max.x) / 2,
    cz: (solid.min.z + solid.max.z) / 2,
    ux: 1,
    uz: 0,
    vx: 0,
    vz: 1,
    hw: (solid.max.x - solid.min.x) / 2,
    hl: (solid.max.z - solid.min.z) / 2,
  };
}

/**
 * Overlap of two oriented boxes by the separating-axis theorem.
 *
 * Returns the minimum translation vector — the normal points from A to B, and
 * `depth` is how far they interpenetrate. SAT is the right tool here because it
 * handles the corner case exactly (a rotated box poking into a wall corner) that
 * the circle approximation got wrong.
 */
export function obbOverlap(a: Obb, b: Obb): { nx: number; nz: number; depth: number } | null {
  const dx = b.cx - a.cx;
  const dz = b.cz - a.cz;
  const axes: Array<[number, number]> = [
    [a.ux, a.uz],
    [a.vx, a.vz],
    [b.ux, b.uz],
    [b.vx, b.vz],
  ];

  let bestDepth = Infinity;
  let bestX = 0;
  let bestZ = 0;

  for (const [ax, az] of axes) {
    // Projection radius of each box onto this axis.
    const ra = Math.abs(ax * a.ux + az * a.uz) * a.hw + Math.abs(ax * a.vx + az * a.vz) * a.hl;
    const rb = Math.abs(ax * b.ux + az * b.uz) * b.hw + Math.abs(ax * b.vx + az * b.vz) * b.hl;
    const distance = Math.abs(dx * ax + dz * az);
    const overlap = ra + rb - distance;
    if (overlap <= 0) return null; // a separating axis: no collision

    if (overlap < bestDepth) {
      bestDepth = overlap;
      const sign = dx * ax + dz * az < 0 ? -1 : 1;
      bestX = ax * sign;
      bestZ = az * sign;
    }
  }

  return { nx: bestX, nz: bestZ, depth: bestDepth };
}

/**
 * Horizontal collision against the arena.
 *
 * Only solids that present a STEP UP at the car's nearest face are walls; the
 * height is sampled at the closest point, which is what lets a ramp be driven up
 * (its surface there is low) while a wall in the same place blocks.
 */
function resolveCollisions(s: VehicleState): void {
  const bottom = carBottom(s);
  const car = carObb(s);

  for (let j = 0; j < SOLIDS.length; j++) {
    const solid = SOLIDS[j];
    const nearX = clamp(car.cx, solid.min.x, solid.max.x);
    const nearZ = clamp(car.cz, solid.min.z, solid.max.z);
    if (!isBlockingAt(solid, nearX, nearZ, bottom, VEHICLE.stepUp)) continue;

    const hit = obbOverlap(car, solidObb(solid));
    if (!hit) continue;

    // The solid cannot move, so the car takes the whole separation. The normal
    // points from the car to the solid, so "away" is the negative direction.
    s.pos.x -= hit.nx * hit.depth;
    s.pos.z -= hit.nz * hit.depth;
    car.cx = s.pos.x;
    car.cz = s.pos.z;

    // Kill the velocity heading into the surface; `impact` is that approach
    // speed, which damage feedback and (for cars) ram damage read.
    const vn = s.vel.x * hit.nx + s.vel.z * hit.nz;
    if (vn > 0) {
      if (vn > 6) s.impact = Math.max(s.impact, vn);
      s.vel.x -= hit.nx * vn;
      s.vel.z -= hit.nz * vn;
    }
  }
}

/** One car-on-car contact worth reporting to the authority. */
export type RamImpact = {
  a: number;
  b: number;
  /** Hull damage each car takes. They are not equal unless it was head-on. */
  dmgA: number;
  dmgB: number;
  closingSpeed: number;
};

/**
 * Resolve car-on-car overlaps and compute ram damage (DESIGN.md §3.1).
 *
 * A separate pass from `stepVehicle` because a collision is a property of a
 * PAIR: no single car can resolve it alone. The server runs this after stepping
 * every crew; the client does not, for the same reason it cannot predict crew
 * hits — it does not know the others' authoritative state. A ram is therefore a
 * server event the local prediction is corrected into, not something the client
 * predicts.
 *
 * Equal masses: separation and impulse split 50/50. Damage does not — it is
 * split by ANGLE, so a nose into a door costs the door far more than the nose.
 */
export function resolveRams(
  cars: ReadonlyArray<{ id: number; state: VehicleState }>,
): RamImpact[] {
  const impacts: RamImpact[] = [];

  for (let i = 0; i < cars.length; i++) {
    for (let j = i + 1; j < cars.length; j++) {
      const sa = cars[i].state;
      const sb = cars[j].state;
      const a = carObb(sa);
      const b = carObb(sb);
      const hit = obbOverlap(a, b);
      if (!hit) continue;

      const half = hit.depth / 2;
      sa.pos.x -= hit.nx * half;
      sa.pos.z -= hit.nz * half;
      sb.pos.x += hit.nx * half;
      sb.pos.z += hit.nz * half;

      // Closing speed along the normal; positive means A is moving into B.
      const rvx = sa.vel.x - sb.vel.x;
      const rvz = sa.vel.z - sb.vel.z;
      const closing = rvx * hit.nx + rvz * hit.nz;

      if (closing > 0) {
        const impulse = closing * (1 - RAM.restitution) * 0.5;
        sa.vel.x -= hit.nx * impulse;
        sa.vel.z -= hit.nz * impulse;
        sb.vel.x += hit.nx * impulse;
        sb.vel.z += hit.nz * impulse;
        sa.impact = Math.max(sa.impact, closing);
        sb.impact = Math.max(sb.impact, closing);
      }

      if (closing < RAM.minClosingSpeed) continue;

      // Angle of attack: +1 means nose-first into the other car, -1 means the
      // other car's nose is in our tail, 0 means a flank.
      const attackA = clamp(-Math.sin(sa.yaw) * hit.nx - Math.cos(sa.yaw) * hit.nz, -1, 1);
      const attackB = clamp(Math.sin(sb.yaw) * hit.nx + Math.cos(sb.yaw) * hit.nz, -1, 1);
      const weightA = RAM.baseShare + (1 - attackA);
      const weightB = RAM.baseShare + (1 - attackB);
      const total = Math.min(RAM.maxDamage, RAM.damagePerSpeed * closing);
      const dmgA = total * (weightA / (weightA + weightB));
      const dmgB = total - dmgA;

      // Aggression fuels the boost meter, so a ram is not purely a cost.
      const gain = RAM.boostPerSpeed * closing * 0.1;
      sa.boost = Math.min(VEHICLE.boost.max, sa.boost + gain);
      sb.boost = Math.min(VEHICLE.boost.max, sb.boost + gain);

      impacts.push({ a: cars[i].id, b: cars[j].id, dmgA, dmgB, closingSpeed: closing });
    }
  }

  return impacts;
}

/**
 * Derive the visual chassis attitude (pitch/roll).
 *
 * Purely cosmetic — no physics reads these — but the naive version produced a
 * violent flick as the car left a ramp. It took the raw front/rear average of
 * ground heights, so the instant the front wheels crossed the lip they sampled
 * the floor several metres below while the rear wheels were still climbing,
 * snapping the pitch to about -63°. A tick later, fully airborne, every wheel
 * sampled that same floor and it snapped back to 0°. Hence the back end
 * flapping up and down.
 *
 * Three guards fix it:
 *   - a wheel only counts as touching if it is near the highest contact, so one
 *     hanging over a drop is ignored rather than dragging the nose down
 *   - the angle is clamped to a plausible range
 *   - it is damped, so no single frame can flip the car
 *
 * Airborne, the nose follows the flight path instead, which is what a jump
 * should look like.
 */
function updateAttitude(s: VehicleState, dt: number): void {
  const maxY = carBottom(s) + VEHICLE.stepUp;
  const hw = s.spec.track / 2;
  const hl = s.spec.wheelbase / 2;

  const hFL = sampleWheel(s, -hw, -hl, maxY);
  const hFR = sampleWheel(s, hw, -hl, maxY);
  const hRL = sampleWheel(s, -hw, hl, maxY);
  const hRR = sampleWheel(s, hw, hl, maxY);

  // Default to holding the current attitude; a target is only produced when
  // there is real information to derive it from.
  let targetPitch = s.pitch;
  let targetRoll = s.roll;

  if (s.onGround) {
    const highest = Math.max(hFL, hFR, hRL, hRR);
    const touching = (h: number) => highest - h <= VEHICLE.wheelContactTolerance;

    // Only re-derive an axis when BOTH ends of it are on something. Crossing a
    // ramp lip leaves the front axle unsupported while the rear is still
    // climbing, and there is no meaningful slope to measure in that moment.
    if (touching(hFL) && touching(hFR) && touching(hRL) && touching(hRR)) {
      const front = (hFL + hFR) / 2;
      const rear = (hRL + hRR) / 2;
      targetPitch = clamp(
        Math.atan2(front - rear, s.spec.wheelbase),
        -VEHICLE.maxAttitude,
        VEHICLE.maxAttitude,
      );
    }
    if (touching(hFL) && touching(hFR) && touching(hRL) && touching(hRR)) {
      const left = (hFL + hRL) / 2;
      const right = (hFR + hRR) / 2;
      targetRoll = clamp(
        Math.atan2(right - left, s.spec.track),
        -VEHICLE.maxAttitude,
        VEHICLE.maxAttitude,
      );
    }
  } else {
    // Airborne: point the nose along the flight path — up while rising, down
    // while falling. Positive pitch is nose-up.
    const horizontal = Math.hypot(s.vel.x, s.vel.z);
    targetPitch = clamp(
      Math.atan2(s.vel.y, Math.max(horizontal, 1)),
      -VEHICLE.maxAttitude,
      VEHICLE.maxAttitude,
    );
  }

  s.pitch = damp(s.pitch, targetPitch, VEHICLE.attitudeRate, dt);
  s.roll = damp(s.roll, targetRoll, VEHICLE.attitudeRate, dt);

  if (!Number.isFinite(s.pitch)) s.pitch = 0;
  if (!Number.isFinite(s.roll)) s.roll = 0;
}

function sampleWheel(s: VehicleState, lx: number, lz: number, maxY: number): number {
  const p = localToWorld(s, lx, lz);
  const h = terrainHeightAt(p.x, p.z, maxY);
  return Number.isFinite(h) ? h : 0;
}

// ------------------------------------------------------------------ the step

export function stepVehicle(s: VehicleState, input: VehicleInput, dt: number): void {
  s.impact = 0;

  const c = Math.cos(s.yaw);
  const sn = Math.sin(s.yaw);
  // Forward is -Z at yaw 0.
  const fx = -sn;
  const fz = -c;
  const rx = c;
  const rz = -sn;

  let forward = s.vel.x * fx + s.vel.z * fz;
  let lateral = s.vel.x * rx + s.vel.z * rz;

  // Treat a denormal throttle as released. Analogue inputs never reach exactly
  // zero, and a 1e-27 throttle takes the "driver is on the power" branch while
  // delivering no force — silently disabling engine braking.
  const throttle =
    Math.abs(input.throttle) < VEHICLE.throttleDeadzone ? 0 : input.throttle;

  const boosting = input.boost && s.boost > 0 && s.onGround && throttle > 0;

  // ---- component damage --------------------------------------------------
  // Each of these is exactly 1 for an undamaged car, so a healthy vehicle
  // simulates bit-identically to before this existed.
  const engine = engineOutput(s.components.engine);
  const topSpeedFactor = engineTopSpeed(s.components.engine);
  const traction = gripFactor(s.components);
  const drive = driveFactor(s.components);

  if (s.onGround) {
    // ---- throttle, braking, resistance -----------------------------------
    const topSpeed =
      (boosting ? VEHICLE.maxSpeed * VEHICLE.boost.multiplier : VEHICLE.maxSpeed) *
      topSpeedFactor;

    if (input.handbrake) {
      // Handbrake, handled BEFORE the throttle branch on purpose.
      //
      // Previously the handbrake's braking sat in the else-branch of the
      // throttle check, so with throttle held it never applied at all, and
      // driving in a straight line produces no lateral velocity for the grip
      // change to bite on. Pulling it under power therefore did nothing
      // whatsoever. Now it always brakes, and only a fraction of engine drive
      // reaches the ground because the rear wheels are locked.
      // Braking falls off with speed. At speed the handbrake is mostly a
      // traction-breaker: it keeps enough momentum for the slide to develop and
      // be held. As the car slows, full strength returns so it still stops.
      const speedRatio = Math.min(1, Math.abs(forward) / VEHICLE.maxSpeed);
      const brakingStrength =
        VEHICLE.handbrakeBraking * (1 - VEHICLE.handbrakeBrakingFalloff * speedRatio);

      if (throttle !== 0 && forward < topSpeed) {
        const sign = throttle > 0 ? 1 : -1;
        const magnitude = Math.min(1, Math.abs(throttle));
        forward +=
          sign *
          VEHICLE.engineForce *
          VEHICLE.handbrakeDriveFactor *
          engine *
          drive *
          magnitude *
          dt;
      }

      const braking = brakingStrength * dt;
      if (forward > 0) forward = Math.max(0, forward - braking);
      else if (forward < 0) forward = Math.min(0, forward + braking);
    } else if (throttle !== 0) {
      const dir = throttle > 0 ? 1 : -1;
      // How hard the driver is asking, 0..1. This used to be discarded — only
      // the sign was read, so half throttle pulled exactly as hard as full and
      // partial input was impossible.
      const magnitude = Math.min(1, Math.abs(throttle));

      if (forward * dir < 0) {
        // Throttle opposes motion → braking.
        forward += dir * VEHICLE.brakeForce * magnitude * dt;
      } else if (dir > 0) {
        // The engine only pushes while BELOW the current cap, and clamps the
        // acceleration it just applied.
        //
        // It deliberately does not clamp when already above the cap: ending a
        // boost leaves the car faster than its normal top speed, and a hard
        // clamp there would slam the brakes on the instant boost ran out.
        // Instead no force is applied and rolling resistance bleeds the excess
        // away over about a second.
        if (forward < topSpeed) {
          const force =
            (boosting
              ? VEHICLE.engineForce * VEHICLE.boost.forceMultiplier
              : VEHICLE.engineForce) *
            engine *
            drive;
          forward = Math.min(topSpeed, forward + force * magnitude * dt);
        }
      } else if (forward > -VEHICLE.maxReverseSpeed) {
        forward = Math.max(
          -VEHICLE.maxReverseSpeed,
          forward - VEHICLE.reverseForce * engine * drive * magnitude * dt,
        );
      }
    } else {
      // Engine braking. With no drive or reverse input the car decelerates to a
      // stop rather than coasting on. This is what makes "the car only moves
      // while you are telling it to" true — rolling resistance alone left it
      // gliding for ten seconds after a lift-off.
      const braking = VEHICLE.engineBraking;
      if (forward > 0) forward = Math.max(0, forward - braking * dt);
      else if (forward < 0) forward = Math.min(0, forward + braking * dt);
    }

    forward -= forward * VEHICLE.rollingResistance * dt;

    if (throttle === 0 && Math.abs(forward) < 0.05) forward = 0;

    // ---- lateral grip -----------------------------------------------------
    // Killing lateral velocity is what makes the car stick; the handbrake
    // deliberately reduces the rate so the back steps out into a drift.
    const grip =
      (input.handbrake ? VEHICLE.lateralGripHandbrake : VEHICLE.lateralGrip) * traction;
    lateral *= Math.exp(-grip * dt);

    // ---- steering ---------------------------------------------------------
    const speed = Math.abs(forward);
    const authority = clamp(1 - speed * VEHICLE.steerSpeedFalloff, VEHICLE.minSteerFactor, 1);
    const engage = clamp(speed / VEHICLE.steerEngageSpeed, 0, 1);
    const reversing = forward >= 0 ? 1 : -1;
    // Handbraking grants extra steering authority so pulling it rotates the car
    // sharply enough to actually point it away from its direction of travel.
    const steerBonus = input.handbrake ? VEHICLE.handbrakeSteerBonus : 1;
    // Positive steer is right; increasing yaw turns left, hence the minus.
    s.yaw -= input.steer * VEHICLE.steerRate * authority * engage * reversing * steerBonus * dt;
    // Damaged tyres drag the car toward the side that is hurt.
    s.yaw += steerPull(s.components) * dt;
  } else {
    // Airborne: keep momentum, minimal authority.
    const speed = Math.hypot(forward, lateral);
    forward -= forward * VEHICLE.drag * speed * dt;
    lateral -= lateral * VEHICLE.drag * speed * dt;
    s.yaw -= input.steer * VEHICLE.steerRate * VEHICLE.airSteerFactor * dt;
  }

  // Recompose the horizontal velocity from the forward/lateral decomposition.
  s.vel.x = fx * forward + rx * lateral;
  s.vel.z = fz * forward + rz * lateral;

  // ---- gravity and integration -------------------------------------------
  s.vel.y += VEHICLE.gravity * dt;

  s.pos.x += s.vel.x * dt;
  s.pos.z += s.vel.z * dt;
  resolveCollisions(s);

  s.pos.y += s.vel.y * dt;

  // ---- ground contact -----------------------------------------------------
  const previousGroundY = s.groundY;
  const gy = groundUnderCar(s);
  const restY = gy + s.spec.rideHeight;

  if (Number.isFinite(gy) && s.pos.y <= restY + VEHICLE.groundStick) {
    // Climb rate is how fast the ground is rising beneath the car. Applying it
    // as vertical velocity is what launches the car off a ramp lip: while the
    // ground climbs, velocity points up; when it falls away, gravity takes over
    // but the upward velocity remains.
    const climb = clamp((gy - previousGroundY) / dt, -VEHICLE.maxClimbRate, VEHICLE.maxClimbRate);

    s.pos.y = restY;
    s.vel.y = climb;
    s.onGround = true;
    s.airborneTicks = 0;
    s.groundY = gy;
  } else {
    s.onGround = false;
    s.airborneTicks++;
    if (Number.isFinite(gy)) s.groundY = gy;
  }

  // ---- boost economy ------------------------------------------------------
  if (boosting) {
    s.boost = Math.max(0, s.boost - VEHICLE.boost.drainPerSecond * dt);
  } else if (s.onGround && !input.boost) {
    // The `!input.boost` guard matters: without it, holding the boost button on
    // an almost-empty meter alternated between "boosting" (drain to zero) and
    // "not boosting" (momentum gain refills a sliver), which fired the boost
    // force on roughly every other tick, indefinitely. The meter read empty
    // while the car kept accelerating past its normal top speed.
    //
    // Holding boost with an empty meter simply does nothing until it is
    // released — you cannot regenerate while asking for boost.
    const speed = Math.abs(forward);
    if (speed > VEHICLE.boost.minSpeedForGain) {
      const fraction = clamp(speed / VEHICLE.maxSpeed, 0, 1);
      s.boost = Math.min(
        VEHICLE.boost.max,
        s.boost + VEHICLE.boost.gainPerSecondAtFullSpeed * fraction * dt,
      );
    }
  }

  // ---- cached read-outs for the HUD --------------------------------------
  s.forwardSpeed = forward;
  s.slipSpeed = lateral;

  updateAttitude(s, dt);
}
