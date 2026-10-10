/**
 * Bot brain (DESIGN.md §13.9, M8).
 *
 * Server-side only. A bot is not a client: it does not predict, it does not
 * send input, and it has no socket. The room asks this module what a bot wants
 * to do this tick and applies it with the same code path a human's input takes
 * — so a bot can never do something a player could not, and every weapon rule
 * (arc, rate, magazine, reload) still binds it.
 *
 * Kept out of `shared/` on purpose. The shared simulation exists so both sides
 * agree; nothing on the client needs to know how a bot thinks, and putting it
 * there would invite predicting it.
 *
 * The goal is an OPPONENT, not a tactician: drive to a range, keep the car
 * moving and pointed somewhere useful, shoot when the shot is clear. For a
 * one-man brawler the driver IS the gun, so the driving half matters as much as
 * the shooting half — a bot that cannot get around a rock is not an opponent,
 * it is scenery.
 */

import { BOT, REPAIR, VEHICLE } from '../shared/config';
import { raycastSolids } from '../shared/arena';
import { clamp, wrapAngle } from '../shared/math';
import { aimAnglesAt, type CombatVehicle } from '../shared/combat';
import { withinArc, type SeatDef } from '../shared/crews';
import { WEAPONS } from '../shared/weapons';
import type { ZoneState } from '../shared/zone';
import type { VehicleInput, VehicleState } from '../shared/vehicle';

/** A possible target, as the room sees the other crews. */
export type BotEnemy = {
  id: number;
  x: number;
  y: number;
  z: number;
  /** Hull as a fraction of max. Absent means healthy, for older callers/tests. */
  hullFraction?: number;
  /** Ground velocity, m/s, for leading shots. Absent means stationary. */
  vx?: number;
  vz?: number;
};

/**
 * Per-bot state that must persist between ticks.
 *
 * Acquiring a target, reacting to it and firing in bursts are all things a bot
 * cannot decide from one frame alone, so the memory lives on the occupant and is
 * threaded through here. (Contrast the aim itself, which is pure from the
 * current state.)
 */
export type BotMemory = {
  targetId: number | null;
  /** When the current target was acquired, in seconds. */
  acquiredAt: number;
  /** Seconds of fire left in the current burst. */
  burst: number;
  /** Time the current burst pause ends. */
  burstUntil: number;
  /** Last tick's time, so `decideBot` can integrate a delta. */
  lastTime: number;
  /** Seconds spent trying to move while barely moving — how stuck we are. */
  stuckFor: number;
  /** While the clock is before this, the bot is reversing out of trouble. */
  reversingUntil: number;
  /** Which way to swing the nose while reversing. */
  recoverSteer: number;
  /** Absolute world heading of a detour we are committed to, and until when. */
  avoidHeading: number;
  avoidUntil: number;
  /** Smoothed steering, so the wheel is turned rather than snapped. */
  steer: number;
  /** Attack-run phase: pointing in and firing, or breaking away to come round. */
  run: 'attack' | 'extend';
  /** When the current break-away ends at the latest. */
  runUntil: number;
  /** Which side to break to, ±1. */
  extendSide: number;
  /** Not before this time may it fire the RPG again (its own rhythm). */
  rocketReadyAt: number;
};

export function createBotMemory(): BotMemory {
  return {
    targetId: null,
    acquiredAt: 0,
    burst: 0,
    burstUntil: 0,
    lastTime: 0,
    stuckFor: 0,
    reversingUntil: 0,
    recoverSteer: 1,
    avoidHeading: 0,
    avoidUntil: 0,
    steer: 0,
    run: 'attack',
    runUntil: 0,
    extendSide: 1,
    rocketReadyAt: 0,
  };
}

export type BotSenses = {
  /** Our car, as combat sees it (muzzle geometry and aim come from here). */
  vehicle: CombatVehicle;
  seat: SeatDef;
  enemies: BotEnemy[];
  /** Monotonic seconds, for idle wander. */
  time: number;
  /** Stable per-bot offset so two idle bots do not move in lockstep. */
  phase: number;
  /** Cross-tick state, mutated here. */
  memory: BotMemory;
  /** The current safe circle, or null in a mode without a zone. */
  zone: ZoneState | null;
  /** Our hull as a fraction of max, so a hurt bot knows to break off. */
  hullFraction?: number;
  /** Repair points (crates and wreck salvage) worth running to when hurt. */
  repairs?: ReadonlyArray<{ x: number; z: number }>;
  /** Override the room's difficulty for this bot. Tests use it; play does not. */
  skill?: BotSkill;
};

export type BotIntent = {
  input: VehicleInput;
  aimYaw: number;
  aimPitch: number;
  /** Primary trigger (the MGs on the solo car; the window gun on a crewed one). */
  fire: boolean;
  /** Secondary trigger (the roof RPG), for seats that have one. */
  fireSecondary?: boolean;
  /**
   * World points to fire AT, as a human's crosshair would give — the server aims
   * each barrel at it (`aimMountedWeapon`). Includes the bot's lead and its aim
   * error. Absent: fall back to `aimYaw`/`aimPitch`.
   */
  target?: { x: number; y: number; z: number };
  secondaryTarget?: { x: number; y: number; z: number };
};

/**
 * Difficulty profiles.
 *
 * Difficulty is TWO skills, because a bot is both a driver and a gunner:
 *
 *   - MARKSMANSHIP — reaction time, aim wobble, burst pause.
 *   - DRIVING — steering authority and wander, when it dares the handbrake,
 *     how well it holds a fighting distance, and how early it reacts to walls
 *     and the closing zone.
 *
 *   - `rocketGap` — seconds between RPG shots (it reloads in 3.2: hard fires
 *     soon after, easy forgets about it); `lead` — how much of a moving target's
 *     travel it allows for (1 = perfect).
 *
 * It touches nothing else: not weapon damage, not ranges, not top speed. An easy
 * bot is not fighting with a worse gun, it is a worse driver and a worse shot —
 * which is what makes the difficulty honest, since the gun belongs to the car.
 */
const SKILLS = {
  easy: {
    reaction: 0.85,
    wobble: 0.09,
    burstPause: 1.5,
    steerGain: 0.7,
    steerNoise: 0.16,
    handbrakeAt: 1.3,
    standoff: 0.75,
    probe: 0.6,
    zoneReaction: 0.85,
    rocketGap: 14,
    lead: 0.4,
  },
  normal: {
    reaction: BOT.reactionSeconds,
    wobble: BOT.aimWobble,
    burstPause: BOT.burstPause,
    steerGain: 1,
    steerNoise: 0.04,
    handbrakeAt: 0.9,
    standoff: 1,
    probe: 1,
    zoneReaction: 1,
    rocketGap: 10,
    lead: 0.75,
  },
  hard: {
    reaction: 0.2,
    // Was 0.011 when bots could barely point their guns; once they could, it
    // was 69% accuracy — an execution, not a fight.
    wobble: 0.024,
    burstPause: 0.35,
    steerGain: 1.25,
    steerNoise: 0.012,
    handbrakeAt: 0.7,
    standoff: 1.15,
    probe: 1.25,
    zoneReaction: 1.1,
    rocketGap: 8,
    lead: 0.95,
  },
} as const;
export type BotSkill = keyof typeof SKILLS;
export type BotProfile = (typeof SKILLS)[BotSkill];

/**
 * Default difficulty is HARD for now: the bots are the only opponents until
 * humans arrive, and an easy field is not worth playing against. Override with
 * `BOT_SKILL=easy|normal|hard`.
 */
const SKILL = (process.env.BOT_SKILL ?? 'hard') as BotSkill;

/** Direction on the ground plane at a yaw: forward is `(-sin, -cos)`. */
const dirX = (yaw: number): number => -Math.sin(yaw);
const dirZ = (yaw: number): number => -Math.cos(yaw);

/**
 * Clear distance along a ground-plane direction, MEASURED ACROSS THE CAR'S WIDTH.
 *
 * A single centre ray lets a car thread a gap its body cannot fit through, then
 * clip the corner with a flank — a "bot hit the wall for no reason" from the
 * driver's seat. Three rays (left edge, centre, right edge) and the smallest
 * clearance is what the car can actually clear.
 */
function clearance(state: VehicleState, heading: number, distance: number): number {
  const dx = dirX(heading);
  const dz = dirZ(heading);
  // Right-hand normal, to step across the car's width.
  const rx = Math.cos(heading);
  const rz = -Math.sin(heading);
  const halfWidth = state.spec.halfWidth + 0.2;
  // Start above the car's centre so the FLOOR (a solid with top y = 0) is never
  // the thing we hit; only walls and blocks block.
  const y = state.pos.y + 0.4;

  let best = distance;
  for (const offset of [-halfWidth, 0, halfWidth]) {
    const hit = raycastSolids(
      state.pos.x + rx * offset,
      y,
      state.pos.z + rz * offset,
      dx,
      0,
      dz,
      distance,
    );
    const room = hit ?? distance;
    if (room < best) best = room;
  }
  return best;
}

/**
 * Candidate headings, as offsets from where the car points now.
 *
 * Full sweep to nearly behind: a bot that only looks +/-30 degrees ahead cannot
 * get out of a corner, it just pushes into it. Ordered outward from straight
 * ahead so the search prefers the smallest deviation that is actually clear.
 */
const HEADING_OFFSETS = [0, 0.3, -0.3, 0.65, -0.65, 1.05, -1.05, 1.55, -1.55, 2.2, -2.2, 2.9, -2.9];

/**
 * How far ahead to look. Scales with speed: at 40 m/s a fixed 16 m is a quarter
 * second of warning, which is how a "fast" bot drives into walls.
 */
function avoidProbe(state: VehicleState, profile: BotProfile): number {
  return BOT.probeDistance * profile.probe * clamp(1 + Math.abs(state.forwardSpeed) / 25, 1, 2.2);
}

/**
 * Pick a heading to drive on: as close to `desiredOffset` as possible, but one
 * with room. Returns an offset from the current heading.
 *
 * The common case costs one ray — if straight at the goal is clear, take it. The
 * fan is only swept when it is not, which keeps open-ground driving cheap.
 */
function chooseHeading(state: VehicleState, desiredOffset: number, probe: number): number {
  const threshold = Math.min(probe * 0.6, 18);
  if (clearance(state, state.yaw + desiredOffset, probe) >= threshold) return desiredOffset;

  let best: number | null = null;
  let bestError = Infinity;
  let widest = desiredOffset;
  let widestClear = -1;

  for (const off of HEADING_OFFSETS) {
    const room = clearance(state, state.yaw + off, probe);
    if (room > widestClear) {
      widestClear = room;
      widest = off;
    }
    if (room >= threshold) {
      const error = Math.abs(wrapAngle(off - desiredOffset));
      if (error < bestError) {
        bestError = error;
        best = off;
      }
    }
  }

  // Nothing clear within the probe: take the roomiest direction and let the
  // stuck-recovery handle it if that still fails to move us.
  return best ?? widest;
}

/**
 * Reverse out when the car is trying to move and not moving.
 *
 * Obstacle avoidance gets a bot around most things, but it can still wedge a
 * nose into a corner at speed. Without this it sits there at full throttle
 * forever — the "bot stuck on a rock" everyone has seen. Backing up for a beat
 * and swinging the nose is the recovery a human does without thinking.
 */
function applyStuckRecovery(
  input: VehicleInput,
  memory: BotMemory,
  state: VehicleState,
  time: number,
  dt: number,
): void {
  if (time < memory.reversingUntil) {
    input.throttle = -1;
    input.steer = clamp(memory.recoverSteer, -1, 1);
    input.handbrake = false;
    input.boost = false;
    return;
  }

  const speed = Math.abs(state.forwardSpeed);
  if (speed < 1.5 && input.throttle > 0.2) {
    memory.stuckFor += dt;
    if (memory.stuckFor > 0.7) {
      memory.stuckFor = 0;
      memory.reversingUntil = time + 0.9;
      // Back out toward whichever side has more room.
      const left = clearance(state, state.yaw + 1.2, BOT.probeDistance);
      const right = clearance(state, state.yaw - 1.2, BOT.probeDistance);
      memory.recoverSteer = left >= right ? 1 : -1;
    }
  } else {
    memory.stuckFor = 0;
  }
}

/**
 * Bend a bot's driving back inside the safe circle.
 *
 * A bot that ignores the zone is not an opponent, it is a free kill: it will sit
 * outside taking escalating damage while you watch. This aims the car at a point
 * INSIDE the circle (70% of the radius, not the edge) and, once actually outside,
 * commits to driving in and stops handbraking. Aim and fire are untouched, so a
 * bot can still shoot over its shoulder while it retreats.
 */
function applyZoneSafety(
  input: VehicleInput,
  state: VehicleState,
  zone: ZoneState | null,
  profile: BotProfile,
  memory: BotMemory,
  time: number,
): void {
  if (!zone) return;
  // Backing out of a corner comes first: forcing the throttle here used to
  // pin a wedged car against a rock until the zone killed it.
  if (time < memory.reversingUntil) return;

  const distance = Math.hypot(state.pos.x - zone.x, state.pos.z - zone.z);
  // A worse driver reacts later: `zoneReaction` below 1 nudges only once the
  // car is closer to the edge.
  const safeInner = zone.radius * BOT.zoneSafetyFraction * profile.zoneReaction;
  if (distance <= safeInner) return;

  const yawToCentre = Math.atan2(-(zone.x - state.pos.x), -(zone.z - state.pos.z));
  let error = wrapAngle(yawToCentre - state.yaw);
  // The way in may be through a mesa or a hangar: go round, not into it.
  const probe = BOT.probeDistance;
  if (clearance(state, state.yaw + error, probe) < Math.min(probe * 0.6, 18)) error = chooseHeading(state, error, probe);
  const inward = clamp(-error * BOT.steerGain * profile.steerGain, -1, 1);
  const span = Math.max(1, zone.radius - safeInner);
  const urgency = clamp((distance - safeInner) / span, 0, 1);

  const blend = BOT.zonePull + (1 - BOT.zonePull) * urgency;
  input.steer = clamp(input.steer + (inward - input.steer) * blend, -1, 1);

  if (distance > zone.radius) {
    // Outside: getting back in beats any manoeuvre.
    input.throttle = Math.max(input.throttle, 1);
    input.handbrake = false;
    if (Math.abs(error) < 0.3) input.boost = true;
  }
}

export function decideBot(s: BotSenses): BotIntent {
  const { vehicle, seat, enemies, time, phase, memory, zone } = s;
  const profile = SKILLS[s.skill ?? SKILL] ?? SKILLS.normal;
  const state = vehicle.state;
  const hullFraction = s.hullFraction ?? 1;
  const repairs = s.repairs ?? [];

  // Target selection: start from the nearest, then prefer a target we can
  // actually FINISH. A wounded car a little further out is worth more than the
  // nearest healthy one, because leaving it alive is how a brawl never ends.
  let nearest: BotEnemy | null = null;
  let nearestDistance = Infinity;
  for (const enemy of enemies) {
    const d = Math.hypot(enemy.x - state.pos.x, enemy.z - state.pos.z);
    if (d < nearestDistance) {
      nearestDistance = d;
      nearest = enemy;
    }
  }
  let target = nearest;
  let bestDistance = nearestDistance;
  if (nearest !== null) {
    const window = nearestDistance * BOT.finishBias;
    for (const enemy of enemies) {
      if (enemy === nearest) continue;
      if ((enemy.hullFraction ?? 1) > BOT.finishHull) continue;
      const d = Math.hypot(enemy.x - state.pos.x, enemy.z - state.pos.z);
      // Closest wounded enemy inside the window, so finishing a kill never
      // becomes a cross-map chase. The FIRST wounded candidate may be farther
      // than the nearest enemy — that is the whole point of the rule.
      if (d <= window && (target === nearest || d < bestDistance)) {
        target = enemy;
        bestDistance = d;
      }
    }
  }

  const input: VehicleInput = { throttle: 0, steer: 0, handbrake: false, boost: false };
  let aimYaw = 0;
  let aimPitch = 0;
  let fire = false;

  const steerGain = BOT.steerGain * profile.steerGain;
  const wander = Math.sin(time * 2.7 + phase * 1.9) * profile.steerNoise;
  const probe = avoidProbe(state, profile);
  // Seconds since the last decision, so "stuck" is time and not ticks.
  const dt = clamp(time - memory.lastTime || 1 / 60, 1 / 120, 0.1);
  memory.lastTime = time;

  // ---- what are we driving toward? --------------------------------------
  // Three cases, in priority order:
  //   hurt   → find repair (crate or wreck salvage) and hold there
  //   engage → an enemy is close enough to drive at
  //   roam   → patrol around the safe centre on our own bearing
  //
  // Roaming is what stops a 30-car field converging into one brawl: a bot with
  // nobody near patrols instead of beelining the globally nearest enemy it
  // cannot see. That, and breaking off when hurt, is what lengthens a match.
  let driveX: number;
  let driveZ: number;
  let engaging = false;
  let repairing = false;

  const hurt = hullFraction < BOT.retreatHull && repairs.length > 0;
  if (hurt) {
    let best: { x: number; z: number } | null = null;
    let bestD = Infinity;
    for (const spot of repairs) {
      const d = Math.hypot(spot.x - state.pos.x, spot.z - state.pos.z);
      if (d < bestD) {
        bestD = d;
        best = spot;
      }
    }
    driveX = best ? best.x : (zone?.x ?? 0);
    driveZ = best ? best.z : (zone?.z ?? 0);
    // Close enough to repair: the rule needs a near-stationary car.
    repairing = bestD < REPAIR.radius * 0.8;
  } else if (target && bestDistance <= BOT.engageRadius) {
    driveX = target.x;
    driveZ = target.z;
    engaging = true;
  } else {
    driveX = (zone?.x ?? 0) + Math.sin(phase) * BOT.roamRadius;
    driveZ = (zone?.z ?? 0) + Math.cos(phase) * BOT.roamRadius;
  }

  // Parked at a repair point: hold still and do not shoot, so the bot is not
  // half-committing to two things at once.
  if (repairing) {
    memory.targetId = null;
    memory.stuckFor = 0;
    input.throttle = -0.2;
    input.handbrake = true;
    applyZoneSafety(input, state, zone, profile, memory, time);
    return { input, aimYaw, aimPitch, fire };
  }

  const dx = driveX - state.pos.x;
  const dz = driveZ - state.pos.z;
  const distance = Math.hypot(dx, dz) || 1e-3;
  const desiredYaw = Math.atan2(-dx, -dz);
  const yawError = wrapAngle(desiredYaw - state.yaw);
  const maxRange = BOT.maxRange * profile.standoff;

  // ATTACK RUNS (see BOT.breakRange). The guns point where the car points, so
  // while attacking the bot drives its nose straight at the target (slightly
  // led), firing; inside `breakRange` it breaks away at ~105° off the line to
  // one side, opens the distance, and turns back in for another pass.
  const breakRange = BOT.breakRange * profile.standoff;
  // Late in a match the safe circle is smaller than a pass: a 60 m break-away
  // in a 25 m circle is a drive out of the zone (measured: the zone made half
  // of all finishing blows). Passes shrink with the circle.
  const reengageRange = Math.max(
    breakRange + 8,
    Math.min(BOT.reengageRange * profile.standoff, zone ? zone.radius * 0.9 : Infinity),
  );
  let desiredOffset = yawError;
  if (engaging && target) {
    if (memory.run === 'attack' && distance < breakRange) {
      memory.run = 'extend';
      memory.runUntil = time + BOT.extendSeconds;
      // Break toward the zone centre when out past half the circle; otherwise
      // to the side with more room, so a pass does not end in a wall.
      const toCentre = zone ? Math.hypot(zone.x - state.pos.x, zone.z - state.pos.z) : 0;
      if (zone && toCentre > zone.radius * 0.5) {
        const centreYaw = Math.atan2(-(zone.x - state.pos.x), -(zone.z - state.pos.z));
        const leftYaw = state.yaw + yawError + BOT.extendAngle;
        const rightYaw = state.yaw + yawError - BOT.extendAngle;
        memory.extendSide =
          Math.abs(wrapAngle(leftYaw - centreYaw)) <= Math.abs(wrapAngle(rightYaw - centreYaw)) ? 1 : -1;
      } else {
        const left = clearance(state, state.yaw + 1.2, BOT.probeDistance);
        const right = clearance(state, state.yaw - 1.2, BOT.probeDistance);
        memory.extendSide = left >= right ? 1 : -1;
      }
    } else if (memory.run === 'extend' && (distance > reengageRange || time > memory.runUntil)) {
      memory.run = 'attack';
    }
    if (memory.run === 'extend') {
      desiredOffset = wrapAngle(yawError + memory.extendSide * BOT.extendAngle);
    } else {
      // Point at the car, a touch ahead of it. NOT at an interception point a
      // second out: the guns are hitscan and only swing ±20°, so leading a fast
      // crossing car by a second put the car itself outside the guns' arc.
      const t = Math.min(0.35, distance / 120);
      const lx = target.x + (target.vx ?? 0) * t - state.pos.x;
      const lz = target.z + (target.vz ?? 0) * t - state.pos.z;
      desiredOffset = wrapAngle(Math.atan2(-lx, -lz) - state.yaw);
    }
  } else {
    memory.run = 'attack';
  }

  // Steering. Positive steer turns RIGHT and increasing yaw turns left, so the
  // command is the NEGATED error — get this backwards and the bot drives away
  // from everything.
  //
  // When the way to the target is blocked, COMMIT to a detour heading for half a
  // second rather than re-aiming at the target every tick. Without the
  // commitment the bot turns away from a block, sees the target again, turns
  // back, and grinds against the corner — the dither that reads as "stuck".
  const threshold = Math.min(probe * 0.6, 18);
  const directClear = clearance(state, state.yaw + desiredOffset, probe) >= threshold;
  if (!directClear && time >= memory.avoidUntil) {
    memory.avoidHeading = state.yaw + chooseHeading(state, desiredOffset, probe);
    memory.avoidUntil = time + 0.5;
  }
  const heading =
    time < memory.avoidUntil ? wrapAngle(memory.avoidHeading - state.yaw) : desiredOffset;

  // Smooth the wheel rather than snapping it to full lock: slammed steering is
  // what makes a car twitch into a wall instead of sweeping around it.
  const targetSteer = clamp(-heading * steerGain + wander, -1, 1);
  const smoothing = clamp(dt * 9, 0, 1);
  memory.steer += (targetSteer - memory.steer) * smoothing;
  input.steer = clamp(memory.steer, -1, 1);

  // SPEED IS A FUNCTION OF ROOM, not of the target. A bot that brakes only when
  // it is already too close arrives at every corner too fast to take; budgeting
  // the speed the clear distance allows is what makes the cornering look easy.
  const clearAhead = clearance(state, state.yaw + heading, probe);
  let desiredSpeed = Math.min(VEHICLE.maxSpeed, clearAhead * 1.6);
  if (engaging) {
    // Passes are made at speed. Inside the fight a little under flat out, so the
    // nose (and the guns) can be held on the target; breaking away, flat out.
    if (memory.run === 'extend' || distance > BOT.mgFireRange) desiredSpeed = Math.min(desiredSpeed * 1.2, VEHICLE.maxSpeed);
    else desiredSpeed = Math.min(desiredSpeed, VEHICLE.maxSpeed * BOT.attackSpeed);
  } else if (distance < 30) {
    // Roaming: ease off at the patrol point rather than overshooting it.
    desiredSpeed = Math.min(desiredSpeed, 6);
  }

  const speed = Math.abs(state.forwardSpeed);
  if (speed < desiredSpeed - 1.5) {
    input.throttle = 1;
    input.boost =
      (Math.abs(desiredOffset) < 0.25 || memory.run === 'extend') && state.boost > BOT.boostAbove && clearAhead > 20;
  } else if (speed > desiredSpeed + 1.5) {
    input.throttle = -0.6;
  } else {
    input.throttle = 0.5;
  }

  // A hard change of heading at speed is what a drift is for. A worse driver
  // only dares it in a very sharp turn.
  input.handbrake = Math.abs(heading) > profile.handbrakeAt && speed > 14;

  applyStuckRecovery(input, memory, state, time, dt);

  // React to a target change: a bot that snaps onto a new enemy and fires the
  // same tick is a machine, not an opponent.
  if (!target) {
    memory.targetId = null;
  } else if (target.id !== memory.targetId) {
    memory.targetId = target.id;
    memory.acquiredAt = time;
  }
  const reacting = target !== null && time - memory.acquiredAt < profile.reaction;

  // Burst rhythm: fire a clip, pause, repeat. Reset when a pause has elapsed.
  if (memory.burst <= 0 && time >= memory.burstUntil) memory.burst = BOT.burstSeconds;
  const burstReady = memory.burst > 0 && time >= memory.burstUntil;

  // Aim error: a little tracking wobble summed from two out-of-phase sines, so
  // sustained fire misses the way a human's does. Applied to the AIM POINT, as
  // an angle off the line of sight, so it costs more at range — like a person.
  const wobbleYaw =
    (Math.sin(time * 5.1 + phase * 1.7) + Math.sin(time * 8.7 + phase * 0.9)) * profile.wobble;
  const wobblePitch = Math.sin(time * 6.3 + phase * 2.1) * profile.wobble * 0.7;

  let fireSecondary = false;
  let aimTarget: { x: number; y: number; z: number } | undefined;
  let rocketTarget: { x: number; y: number; z: number } | undefined;

  if (target) {
    // Where to point, given a lead time: the target's position then, plus the
    // aim error, as a point in the world.
    const pointAt = (leadSeconds: number): { x: number; y: number; z: number } => {
      const t = leadSeconds * profile.lead;
      const px = target.x + (target.vx ?? 0) * t;
      const pz = target.z + (target.vz ?? 0) * t;
      const ox = px - state.pos.x;
      const oz = pz - state.pos.z;
      const range = Math.hypot(ox, oz) || 1;
      // Rotate the line of sight by the wobble (about Y), lift it by the pitch.
      const c = Math.cos(wobbleYaw);
      const sn = Math.sin(wobbleYaw);
      return {
        x: state.pos.x + ox * c - oz * sn,
        y: target.y + 0.5 + range * wobblePitch,
        z: state.pos.z + ox * sn + oz * c,
      };
    };
    const lineClear = (p: { x: number; y: number; z: number }): boolean => {
      const muzzleY = state.pos.y + 0.5;
      const len = Math.hypot(p.x - state.pos.x, p.y - muzzleY, p.z - state.pos.z) || 1;
      return (
        raycastSolids(
          state.pos.x,
          muzzleY,
          state.pos.z,
          (p.x - state.pos.x) / len,
          (p.y - muzzleY) / len,
          (p.z - state.pos.z) / len,
          len - 1.5,
        ) === null
      );
    };

    aimTarget = pointAt(BOT.mgLead);
    const angles = aimAnglesAt(vehicle, seat, aimTarget);
    if (angles) {
      aimYaw = angles.yaw;
      aimPitch = clamp(angles.pitch, -1.2, 1.2);
    }

    // Each weapon fires only when IT can bear: the MGs inside their own narrow
    // arc, the roof RPG inside its wide one. The seat's arc is the union of all
    // its weapons and says nothing about whether the guns can point there.
    const primary = seat.mounted?.find((w) => w.trigger === 'primary');
    const secondary = seat.mounted?.find((w) => w.trigger === 'secondary');
    const primaryArc = primary?.yawArc ?? seat.arc;
    const primaryRange = primary ? BOT.mgFireRange : BOT.maxFireRange;
    const canSee = !reacting && bestDistance < BOT.maxFireRange;

    if (angles && canSee && burstReady && primaryArc && withinArc(primaryArc, aimYaw) && bestDistance < primaryRange) {
      fire = lineClear(aimTarget);
    }

    if (canSee && secondary && time >= memory.rocketReadyAt) {
      const speed = Math.max(1, WEAPONS[secondary.weapon].speed);
      if (bestDistance > BOT.rocketMinRange && bestDistance < BOT.rocketMaxRange) {
        // Lead by the rocket's flight time — at 78 m/s a car at 30 m/s moves
        // most of its own length every 0.1 s, and a rocket that does not lead
        // only ever hits a parked car.
        rocketTarget = pointAt(bestDistance / speed);
        rocketTarget.y = target.y + 0.2; // splash: aim low, at the car's base
        const rocketAngles = aimAnglesAt(vehicle, seat, rocketTarget);
        if (rocketAngles && withinArc(secondary.yawArc, rocketAngles.yaw) && lineClear(rocketTarget)) {
          fireSecondary = true;
          memory.rocketReadyAt = time + profile.rocketGap;
        }
      }
    }
  }

  if (fire) {
    memory.burst -= dt;
    if (memory.burst <= 0) memory.burstUntil = time + profile.burstPause;
  }

  applyZoneSafety(input, state, zone, profile, memory, time);
  return { input, aimYaw, aimPitch, fire, fireSecondary, target: aimTarget, secondaryTarget: rocketTarget };
}
