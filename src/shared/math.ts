/**
 * Minimal vector maths for the shared simulation.
 *
 * Objects rather than arrays: readability matters more here than allocation
 * avoidance, and the simulation runs at only 60 Hz with a handful of entities.
 */

export type Vec3 = { x: number; y: number; z: number };

export const vec3 = (x = 0, y = 0, z = 0): Vec3 => ({ x, y, z });

export const copy = (out: Vec3, v: Vec3): Vec3 => {
  out.x = v.x;
  out.y = v.y;
  out.z = v.z;
  return out;
};

export const clone = (v: Vec3): Vec3 => ({ x: v.x, y: v.y, z: v.z });

export const add = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x + b.x, y: a.y + b.y, z: a.z + b.z });

export const sub = (a: Vec3, b: Vec3): Vec3 => ({ x: a.x - b.x, y: a.y - b.y, z: a.z - b.z });

export const scale = (a: Vec3, s: number): Vec3 => ({ x: a.x * s, y: a.y * s, z: a.z * s });

/** a + b * s — the workhorse for integration. */
export const addScaled = (a: Vec3, b: Vec3, s: number): Vec3 => ({
  x: a.x + b.x * s,
  y: a.y + b.y * s,
  z: a.z + b.z * s,
});

export const dot = (a: Vec3, b: Vec3): number => a.x * b.x + a.y * b.y + a.z * b.z;

export const lengthSq = (a: Vec3): number => a.x * a.x + a.y * a.y + a.z * a.z;

export const length = (a: Vec3): number => Math.sqrt(lengthSq(a));

export const distance = (a: Vec3, b: Vec3): number => length(sub(a, b));

export const normalize = (a: Vec3): Vec3 => {
  const len = length(a);
  return len > 1e-9 ? scale(a, 1 / len) : vec3();
};

// -------------------------------------------------------------------- scalars

export const clamp = (v: number, min: number, max: number): number =>
  v < min ? min : v > max ? max : v;

export const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

export const sign = (v: number): number => (v > 0 ? 1 : v < 0 ? -1 : 0);

export const moveTowards = (current: number, target: number, maxDelta: number): number => {
  const d = target - current;
  if (Math.abs(d) <= maxDelta) return target;
  return current + sign(d) * maxDelta;
};

/**
 * Frame-rate independent exponential smoothing.
 * `rate` is roughly "how many e-folds per second" — higher is snappier.
 */
export const damp = (current: number, target: number, rate: number, dt: number): number =>
  lerp(current, target, 1 - Math.exp(-rate * dt));

/** Wrap an angle into (-π, π]. */
export const wrapAngle = (a: number): number => {
  let x = (a + Math.PI) % (Math.PI * 2);
  if (x < 0) x += Math.PI * 2;
  return x - Math.PI;
};
