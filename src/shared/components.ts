/**
 * Component damage (DESIGN.md §4).
 *
 * Hull HP is the KILL condition. Components DISABLE. That difference is the
 * whole point: a car with a dead engine is not a dead car, it is a car that can
 * no longer leave, and that is a decision the shooter gets to make — strip the
 * tyres to stop the escape, kill the engine to finish it.
 *
 * These live in the simulated state rather than beside it, which `hull` does
 * not, for one reason: **they change how the car moves.** A damaged engine has
 * to make the client predict the same sluggish car the server simulates, or
 * prediction diverges and the car feels like it is fighting you. Hull affects
 * nothing about motion, so it stays out of the simulation entirely.
 *
 * The boxes below mirror the renderer's mounts (`buildVehicle`). If they drift
 * apart you get the worst kind of bug: a component that looks hit and isn't.
 */

import { clamp } from './math';
import { COMPONENT, type VehicleSpec } from './config';

export type ComponentId = 'engine' | 'wheel.fl' | 'wheel.fr' | 'wheel.rl' | 'wheel.rr';

export const COMPONENT_IDS: readonly ComponentId[] = [
  'engine',
  'wheel.fl',
  'wheel.fr',
  'wheel.rl',
  'wheel.rr',
];

/** Health of every component, by id. Zero disables it. */
export type Components = Record<ComponentId, number>;

export function createComponents(): Components {
  return {
    engine: COMPONENT.health,
    'wheel.fl': COMPONENT.health,
    'wheel.fr': COMPONENT.health,
    'wheel.rl': COMPONENT.health,
    'wheel.rr': COMPONENT.health,
  };
}

export function resetComponents(c: Components): void {
  for (const id of COMPONENT_IDS) c[id] = COMPONENT.health;
}

export function copyComponents(from: Components, to: Components): void {
  for (const id of COMPONENT_IDS) to[id] = from[id];
}

/** Full health, for comparisons that would otherwise spell out the config. */
export const COMPONENT_MAX = COMPONENT.health;

/** Repair one component, never past full. Returns the new health. */
export function repairComponent(c: Components, id: ComponentId, amount: number): number {
  c[id] = Math.min(COMPONENT.health, c[id] + amount);
  return c[id];
}

/** Apply damage to one component. Returns the new health. */
export function damageComponent(c: Components, id: ComponentId, amount: number): number {
  c[id] = Math.max(0, c[id] - amount);
  return c[id];
}

/** 1 at full health, 0 at disabled. */
export const integrity = (health: number): number => clamp(health / COMPONENT.health, 0, 1);

/** Integrity of one named component of a vehicle, 0..1. */
export const componentIntegrity = (c: Components, id: ComponentId): number => integrity(c[id]);

const lerp = (a: number, b: number, t: number): number => a + (b - a) * t;

/**
 * Engine output multiplier.
 *
 * A disabled engine is not a stopped car — it can still roll, coast and be
 * pushed — but it cannot drive itself and it has lost boost entirely.
 */
export const engineOutput = (health: number): number =>
  lerp(COMPONENT.engineFloor, 1, integrity(health));

/** Top-speed multiplier. Capped harder than raw power, so damage reads as "slower". */
export const engineTopSpeed = (health: number): number =>
  lerp(COMPONENT.engineTopSpeedFloor, 1, integrity(health));

/** Average integrity of the four wheels, 0..1. */
export function wheelIntegrity(c: Components): number {
  return (
    (integrity(c['wheel.fl']) +
      integrity(c['wheel.fr']) +
      integrity(c['wheel.rl']) +
      integrity(c['wheel.rr'])) /
    4
  );
}

/** Traction multiplier. Damaged tyres slide sooner, so drifts become involuntary. */
export const gripFactor = (c: Components): number =>
  lerp(COMPONENT.wheelGripFloor, 1, wheelIntegrity(c));

/** Drive multiplier. With no wheels left there is nothing to put power through. */
export const driveFactor = (c: Components): number =>
  Math.max(COMPONENT.wheelDriveFloor, wheelIntegrity(c));

/**
 * Steer bias in rad/s, from a left/right imbalance.
 *
 * Negative steer input turns right and increasing yaw turns left, so a bias
 * here is a constant yaw rate. It pulls toward the DAMAGED side: a wrecked left
 * tyre drags the car left, which is what makes a crippled car want to fight the
 * driver rather than simply being slow.
 */
export function steerPull(c: Components): number {
  const left = (integrity(c['wheel.fl']) + integrity(c['wheel.rl'])) / 2;
  const right = (integrity(c['wheel.fr']) + integrity(c['wheel.rr'])) / 2;
  return (right - left) * COMPONENT.wheelPullRate;
}

// ------------------------------------------------------------------ hitboxes

export type ComponentBox = {
  id: ComponentId;
  /** Local centre, in vehicle space (yaw applied, attitude not). */
  c: readonly [number, number, number];
  /** Local half-extents. */
  h: readonly [number, number, number];
};

/**
 * Where each component physically is, for hit attribution.
 *
 * Derived from the spec rather than hand-placed per class, so the boxes cannot
 * drift from the wheels the car actually drives on.
 */
export function componentBoxes(spec: VehicleSpec): ComponentBox[] {
  const wheelY = -(spec.rideHeight - spec.wheelRadius);
  const r = spec.wheelRadius;
  // Matches `buildVehicle`: the engine sits under the bonnet, forward of the
  // cabin. The low body shape (coupe and the solo brawler) shares one mount;
  // only the tall SUV sits differently.
  const engineZ = spec.id === 'suv' ? -1.7 : -1.45;
  const engineY = spec.id === 'suv' ? 0.0 : 0.14;

  return [
    { id: 'engine', c: [0, engineY, engineZ], h: [0.5, 0.28, 0.45] },
    { id: 'wheel.fl', c: [-spec.track / 2, wheelY, -spec.wheelbase / 2], h: [r * 0.4, r, r] },
    { id: 'wheel.fr', c: [spec.track / 2, wheelY, -spec.wheelbase / 2], h: [r * 0.4, r, r] },
    { id: 'wheel.rl', c: [-spec.track / 2, wheelY, spec.wheelbase / 2], h: [r * 0.4, r, r] },
    { id: 'wheel.rr', c: [spec.track / 2, wheelY, spec.wheelbase / 2], h: [r * 0.4, r, r] },
  ];
}

export { COMPONENT };
