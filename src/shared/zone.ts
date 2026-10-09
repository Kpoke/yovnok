/**
 * The closing danger zone (DESIGN.md §2.2, §10.3).
 *
 * The reason a last-car-standing match can be trusted to END, and the reason it
 * does not end the SAME WAY every time. Each phase shrinks the circle to a new,
 * randomly-offset centre that sits entirely inside the previous one, so players
 * can commit to a plan only to watch the final fight move — the endgame is not a
 * script you can memorise.
 *
 * Pure, and takes a `rand` function rather than calling `Math.random` itself, so
 * a test can seed it and get an exactly reproducible plan. The server builds the
 * plan once when the match goes live and applies the damage; the client only
 * reads the current circle from the snapshot to draw it.
 */

import { ZONE } from './config';

export type ZoneRules = {
  centreX: number;
  centreZ: number;
  startRadius: number;
  endRadius: number;
  phases: number;
  holdSeconds: number;
  shrinkSeconds: number;
  damagePerSecond: number;
  damagePerPhase: number;
};

export function zoneRules(overrides: Partial<ZoneRules> = {}): ZoneRules {
  return { ...ZONE, ...overrides };
}

/** One safe circle. */
export type ZoneCircle = { x: number; z: number; radius: number };

/** The whole schedule for a match, decided once at the whistle. */
export type ZonePlan = {
  holdSeconds: number;
  shrinkSeconds: number;
  damagePerSecond: number;
  damagePerPhase: number;
  /** `circles[0]` is the opening circle, `circles[phases]` the final one. */
  circles: ZoneCircle[];
};

export type Rand = () => number;

/** Deterministic PRNG (mulberry32) so tests can pin a plan with a seed. */
export function seededRandom(seed: number): Rand {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export type ZoneState = {
  /** Centre of the current safe circle, world metres. */
  x: number;
  z: number;
  /** Current safe radius, metres. */
  radius: number;
  /** True while the boundary is actively closing. */
  shrinking: boolean;
  /** Milliseconds until the next shrink starts; 0 once every phase is done. */
  nextShrinkMs: number;
  /** Hull damage per second suffered outside the circle, right now. */
  damagePerSecond: number;
};

/**
 * Build the circle sequence. Radii follow the rule curve; each centre is offset
 * from the last by a random amount small enough that the new circle is nested
 * inside it (`prevRadius - newRadius`), which is what keeps the shrink fair —
 * you are never pushed outside the previous safe area.
 */
export function buildZonePlan(r: ZoneRules, rand: Rand = Math.random): ZonePlan {
  const circles: ZoneCircle[] = [{ x: r.centreX, z: r.centreZ, radius: r.startRadius }];

  for (let phase = 1; phase <= r.phases; phase++) {
    const prev = circles[phase - 1];
    const radius = r.startRadius + (r.endRadius - r.startRadius) * (phase / r.phases);
    const maxOffset = Math.max(0, prev.radius - radius);
    const angle = rand() * Math.PI * 2;
    // 0.85 leaves a margin so the new circle is comfortably inside the old one.
    const distance = rand() * maxOffset * 0.85;
    circles.push({
      x: prev.x + Math.cos(angle) * distance,
      z: prev.z + Math.sin(angle) * distance,
      radius,
    });
  }

  return {
    holdSeconds: r.holdSeconds,
    shrinkSeconds: r.shrinkSeconds,
    damagePerSecond: r.damagePerSecond,
    damagePerPhase: r.damagePerPhase,
    circles,
  };
}

/** Whether a world point is outside the current safe circle. */
export function outsideZone(state: ZoneState, x: number, z: number): boolean {
  return Math.hypot(x - state.x, z - state.z) > state.radius;
}

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export function zoneAt(elapsedSeconds: number, plan: ZonePlan): ZoneState {
  const t = Math.max(0, elapsedSeconds);
  const cycle = plan.holdSeconds + plan.shrinkSeconds;
  const last = plan.circles.length - 1;
  const phase = Math.min(last, Math.floor(t / cycle));
  const within = t - phase * cycle;
  const damagePerSecond = plan.damagePerSecond + plan.damagePerPhase * phase;

  const from = plan.circles[phase];
  const to = plan.circles[Math.min(last, phase + 1)];

  if (phase >= last) {
    return { x: from.x, z: from.z, radius: from.radius, shrinking: false, nextShrinkMs: 0, damagePerSecond };
  }
  if (within < plan.holdSeconds) {
    return {
      x: from.x,
      z: from.z,
      radius: from.radius,
      shrinking: false,
      nextShrinkMs: (plan.holdSeconds - within) * 1000,
      damagePerSecond,
    };
  }

  const k = (within - plan.holdSeconds) / plan.shrinkSeconds;
  return {
    x: lerp(from.x, to.x, k),
    z: lerp(from.z, to.z, k),
    radius: lerp(from.radius, to.radius, k),
    shrinking: true,
    nextShrinkMs: 0,
    damagePerSecond,
  };
}
