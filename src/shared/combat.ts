/**
 * Combat geometry, shared by both sides.
 *
 * The server uses this to decide what a shot hit — hit detection is never a
 * client claim (DESIGN.md §13.8). The client uses the SAME code to draw its own
 * shot immediately rather than waiting a round trip to find out where it went.
 *
 * That they share it matters: if the client predicted with a different muzzle or
 * a different box, its tracer would disagree with the damage it then took, and
 * players would stop trusting the tracers.
 *
 * Pure geometry and pure damage arithmetic — no tick loop, no sockets, no I/O.
 */

import { COMBAT, COMPONENT, VEHICLE_CLASSES, type VehicleClassId } from './config';
import {
  clampToArc,
  EYE_OFFSET,
  FIRE_PORT_OFFSET,
  HEAD_OFFSET,
  mountMuzzleLocal,
  seatById,
  seatsFor,
  type MountedWeapon,
  type SeatDef,
  type SeatId,
} from './crews';
import { raycastSolids } from './arena';
import { componentBoxes, type ComponentId } from './components';
import { clamp, wrapAngle } from './math';
import type { VehicleState } from './vehicle';

export type Hit = {
  distance: number;
  x: number;
  y: number;
  z: number;
};

/** A crew vehicle as combat sees it. */
export type CombatVehicle = {
  id: number;
  cls: VehicleClassId;
  state: VehicleState;
  hull: number;
  /** Recent transforms for lag compensation, oldest first. */
  history: Array<{ tick: number; x: number; y: number; z: number; yaw: number }>;
};

export type CombatMember = {
  id: number;
  crew: number;
  seat: SeatId;
  hp: number;
  alive: boolean;
};

const vec = (x: number, y: number, z: number) => ({ x, y, z });

/**
 * A seat-relative offset in world space.
 *
 * Rotates by yaw only. Pitch and roll are cosmetic attitude (the chassis leans
 * on ramps), so including them would move the muzzle around for reasons the
 * player cannot see or control.
 */
export function seatPointWorld(
  state: VehicleState,
  seat: SeatDef,
  offset: readonly [number, number, number] | readonly number[],
): { x: number; y: number; z: number } {
  const c = Math.cos(state.yaw);
  const s = Math.sin(state.yaw);
  const lx = seat.mount[0] + offset[0];
  const ly = seat.mount[1] + offset[1];
  const lz = seat.mount[2] + offset[2];
  return {
    x: state.pos.x + lx * c + lz * s,
    y: state.pos.y + ly,
    z: state.pos.z - lx * s + lz * c,
  };
}

/** A vehicle-local point in world space (yaw only, like `seatPointWorld`). */
export function vehiclePointWorld(
  state: VehicleState,
  local: readonly [number, number, number] | readonly number[],
): { x: number; y: number; z: number } {
  const c = Math.cos(state.yaw);
  const s = Math.sin(state.yaw);
  return {
    x: state.pos.x + local[0] * c + local[2] * s,
    y: state.pos.y + local[1],
    z: state.pos.z - local[0] * s + local[2] * c,
  };
}

/**
 * The aim from `from` to `to`, relative to a car facing `carYaw`: yaw off the
 * nose (+ = left, the vehicle convention) and pitch (+ = up, as `handleFire`
 * builds its ray). This is how a crosshair's world point becomes a gun's aim.
 */
export function relativeAim(
  carYaw: number,
  from: { x: number; y: number; z: number },
  to: { x: number; y: number; z: number },
): { yaw: number; pitch: number } {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dz = to.z - from.z;
  // Forward is (-sin yaw, -cos yaw), so a direction's yaw is atan2(-dx, -dz).
  const worldYaw = Math.atan2(-dx, -dz);
  return { yaw: wrapAngle(worldYaw - carYaw), pitch: Math.atan2(dy, Math.hypot(dx, dz)) };
}

/**
 * Aim one barrel of a car-mounted weapon — THE rule, shared by the server
 * (which fires it) and the client (which predicts the tracer), so the two can
 * never disagree about where a gun points.
 *
 * The gun turns about its pivot toward the target (that places the muzzle),
 * then fires from the muzzle toward the target, so twin guns converge on the
 * crosshair. Both turns are clamped to how far the gun physically moves. With
 * no target (a bot), `fallback` angles are used as the aim.
 */
export function aimMountedWeapon(
  state: VehicleState,
  weapon: MountedWeapon,
  barrel: number,
  target: { x: number; y: number; z: number } | null,
  fallback: { yaw: number; pitch: number },
): { muzzle: { x: number; y: number; z: number }; yaw: number; pitch: number } {
  const mount = weapon.mounts[barrel % weapon.mounts.length];
  const pivot = vehiclePointWorld(state, mount.pivot);
  const pivotAim = target ? relativeAim(state.yaw, pivot, target) : fallback;
  const muzzle = vehiclePointWorld(state, mountMuzzleLocal(mount, clampToArc(weapon.yawArc, pivotAim.yaw)));
  const aim = target ? relativeAim(state.yaw, muzzle, target) : pivotAim;
  return {
    muzzle,
    yaw: clampToArc(weapon.yawArc, aim.yaw),
    pitch: clamp(aim.pitch, weapon.pitchArc[0], weapon.pitchArc[1]),
  };
}

/**
 * Where a seat's shots come from.
 *
 * A window gunner fires from their side's aperture; a car-mounted weapon
 * declares its own centre-line port on the seat (`firePort`), because "inside
 * the car" and "out of a window" are different places and the tracer has to
 * start where the player believes the gun is.
 */
export function muzzleWorld(vehicle: CombatVehicle, seat: SeatDef): { x: number; y: number; z: number } {
  const port = seat.firePort ?? FIRE_PORT_OFFSET[seat.side];
  return seatPointWorld(vehicle.state, seat, port);
}

/**
 * Where a crew member's head is, which is what a shot has to find.
 *
 * For a gunner that is their WINDOW, because that is where they are exposed
 * (DESIGN.md §3.5) — leaning out, firing. It is also the only position a shot
 * can physically reach: `resolveHitscan` clips the head test to the distance at
 * which the ray met the hull, so a head modelled at the cabin position is inside
 * a box the ray has already been truncated by, and crew hits become impossible
 * from every direction. That was the case until this was measured.
 *
 * The driver stays on the cabin offset and is skipped outright by role, so they
 * are doubly unreachable: armoured, and with no window to lean from.
 */
export function headWorld(vehicle: CombatVehicle, seat: SeatDef): { x: number; y: number; z: number } {
  const offset = seat.drives ? EYE_OFFSET : HEAD_OFFSET[seat.side];
  return seatPointWorld(vehicle.state, seat, offset);
}

/**
 * Ray against a vehicle's collision box, in its own frame.
 *
 * The box is axis-aligned once the ray is rotated into the vehicle's frame, so a
 * simple slab test works — no need for an oriented-box routine.
 */
/**
 * Ray against an oriented box. Internal: `raycastVehicle` and the component
 * hitboxes are the same problem with different extents, and having one
 * implementation is what stops a wheel's hitbox drifting from a wheel.
 */
function raycastLocalBox(
  state: VehicleState,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  centre: readonly [number, number, number],
  half: readonly [number, number, number],
): { tMin: number; tMax: number } | null {
  const c = Math.cos(-state.yaw);
  const s = Math.sin(-state.yaw);

  // Rotate the box centre into world space first, then work in the vehicle's own
  // frame. Done this way so a caller can pass any number of boxes without
  // repeating the rotation — and so the yaw convention matches `seatPointWorld`.
  const yaw = state.yaw;
  const centreX = centre[0] * Math.cos(yaw) + centre[2] * Math.sin(yaw);
  const centreZ = -centre[0] * Math.sin(yaw) + centre[2] * Math.cos(yaw);

  const rx = ox - state.pos.x - centreX;
  const ry = oy - state.pos.y - centre[1];
  const rz = oz - state.pos.z - centreZ;
  const lox = rx * c + rz * s;
  const loz = -rx * s + rz * c;
  const ldx = dx * c + dz * s;
  const ldz = -dx * s + dz * c;

  const bounds: Array<[number, number, number, number]> = [
    [lox, ldx, -half[0], half[0]],
    [ry, dy, -half[1], half[1]],
    [loz, ldz, -half[2], half[2]],
  ];

  let tMin = 0;
  let tMax = maxDistance;
  for (const [origin, direction, lo, hi] of bounds) {
    if (Math.abs(direction) < 1e-9) {
      if (origin < lo || origin > hi) return null;
      continue;
    }
    let t1 = (lo - origin) / direction;
    let t2 = (hi - origin) / direction;
    if (t1 > t2) [t1, t2] = [t2, t1];
    if (t1 > tMin) tMin = t1;
    if (t2 < tMax) tMax = t2;
    if (tMin > tMax) return null;
  }

  if (tMin < 0 || tMin > maxDistance) return null;
  return { tMin, tMax };
}

export function raycastVehicle(
  vehicle: CombatVehicle,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): (Hit & { exit: number }) | null {
  const spec = VEHICLE_CLASSES[vehicle.cls];
  const box = raycastLocalBox(
    vehicle.state,
    ox,
    oy,
    oz,
    dx,
    dy,
    dz,
    maxDistance,
    [0, 0, 0],
    [spec.halfWidth, spec.boxHeight / 2, spec.halfLength],
  );
  if (!box) return null;
  return {
    distance: box.tMin,
    // Where the ray leaves the car. Component boxes are tested within this
    // span, so a part on the far side of the vehicle is never credited with
    // stopping a round that entered from the other side.
    exit: box.tMax,
    x: ox + dx * box.tMin,
    y: oy + dy * box.tMin,
    z: oz + dz * box.tMin,
  };
}

/**
 * Which component a shot struck, if any.
 *
 * Tested against the component boxes INSIDE the hull, so a shot that grazes the
 * bodywork still only damages the hull — you have to put the round where the
 * part actually is. `hullEntry` and `hullExit` come from the hull test, so a
 * component behind the far side of the car is not credited.
 */
export function componentHit(
  vehicle: CombatVehicle,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  hullEntry: number,
  hullExit: number,
): ComponentId | null {
  const spec = VEHICLE_CLASSES[vehicle.cls];
  let best: { id: ComponentId; at: number } | null = null;

  for (const box of componentBoxes(spec)) {
    const hit = raycastLocalBox(
      vehicle.state,
      ox,
      oy,
      oz,
      dx,
      dy,
      dz,
      hullExit,
      box.c,
      box.h,
    );
    if (!hit) continue;
    // Only parts near the surface the round actually reached. A component buried
    // behind the whole car is not something a bullet arriving from the front
    // should find, even though it is inside the hull box the ray crossed.
    if (hit.tMin > hullEntry + COMPONENT.hitDepthTolerance) continue;
    if (!best || hit.tMin < best.at) best = { id: box.id, at: hit.tMin };
  }

  return best ? best.id : null;
}

/** Ray against a sphere, used for crew heads — small and roughly spherical. */
export function raycastSphere(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  cx: number,
  cy: number,
  cz: number,
  radius: number,
  maxDistance: number,
): number | null {
  const mx = ox - cx;
  const my = oy - cy;
  const mz = oz - cz;
  const b = mx * dx + my * dy + mz * dz;
  const c = mx * mx + my * my + mz * mz - radius * radius;
  if (c > 0 && b > 0) return null;
  const discriminant = b * b - c;
  if (discriminant < 0) return null;
  let t = -b - Math.sqrt(discriminant);
  if (t < 0) t = 0;
  return t <= maxDistance ? t : null;
}

/** Interpolate a vehicle's position back to a past time, from its history. */
export function rewindVehicle(vehicle: CombatVehicle, seconds: number): CombatVehicle {
  const history = vehicle.history;
  if (history.length < 2 || seconds <= 0) return vehicle;

  const tick = history[history.length - 1].tick;
  const target = tick - seconds * 60;
  if (target <= history[0].tick) {
    const oldest = history[0];
    return { ...vehicle, state: { ...vehicle.state, pos: vec(oldest.x, oldest.y, oldest.z), yaw: oldest.yaw } };
  }

  for (let i = history.length - 1; i > 0; i--) {
    const a = history[i - 1];
    const b = history[i];
    if (a.tick <= target && b.tick >= target) {
      const span = b.tick - a.tick || 1;
      const alpha = (target - a.tick) / span;
      return {
        ...vehicle,
        state: {
          ...vehicle.state,
          pos: vec(
            a.x + (b.x - a.x) * alpha,
            a.y + (b.y - a.y) * alpha,
            a.z + (b.z - a.z) * alpha,
          ),
          yaw: a.yaw + (((b.yaw - a.yaw + Math.PI * 3) % (Math.PI * 2)) - Math.PI) * alpha,
        },
      };
    }
  }
  return vehicle;
}

export type ShotResolution = {
  /** Impact point, whether it hit something or simply reached its range. */
  end: { x: number; y: number; z: number };
  /** The crew whose hull was struck, if any. */
  hullHit: number | null;
  /** The member struck, if the ray found a head before the hull. */
  memberHit: number | null;
  /**
   * The component struck, when the shot landed on one rather than plain hull.
   * Component hits damage the part and NOT the hull — that is what makes aiming
   * a decision rather than a formality (DESIGN.md §4.2).
   */
  componentHit: ComponentId | null;
  /** Distance actually travelled. */
  distance: number;
};

/**
 * Resolve a hitscan shot.
 *
 * Vehicles are tested at their REWOUND positions — where the shooter could see
 * them, not where they are now. Without this a player on a high-latency link has
 * to lead every shot, and the game punishes them for their connection rather
 * than their aim. Heads are tested before hulls so a well-placed shot can take a
 * gunner out of their seat.
 */
export function resolveHitscan(
  vehicles: CombatVehicle[],
  members: CombatMember[],
  shooterCrew: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
  rewindSeconds: number,
): ShotResolution {
  let best = maxDistance;
  let hullHit: number | null = null;
  let memberHit: number | null = null;
  let component: ComponentId | null = null;

  // Arena first: it is the cheapest test and bounds everything else.
  const arena = raycastSolids(ox, oy, oz, dx, dy, dz, maxDistance);
  if (arena !== null) best = arena;

  for (const original of vehicles) {
    // Skip our own car ENTIRELY, not just at the damage step. The muzzle sits
    // inside it — a gunner fires from a window aperture — so a box test finds a
    // hit at distance zero and truncates `best`, silently blocking every shot
    // the shooter ever takes.
    if (original.id === shooterCrew) continue;

    const vehicle = rewindVehicle(original, rewindSeconds);
    const hit = raycastVehicle(vehicle, ox, oy, oz, dx, dy, dz, best);
    if (!hit) continue;

    // A nearer hull than anything so far: whoever is in it takes the hit.
    best = hit.distance;
    hullHit = vehicle.id;
    memberHit = null;
    component = componentHit(vehicle, ox, oy, oz, dx, dy, dz, hit.distance, hit.exit) ?? null;

    // Crew heads are small, so this only fires on a genuinely good shot — and
    // only for the crew whose hull the ray would have struck anyway.
    const seatList = seatsFor(vehicle.cls);
    for (const member of members) {
      if (member.crew !== vehicle.id || !member.alive) continue;
      const seat = seatList.find((s) => s.id === member.seat);
      if (!seat) continue;
      // The driver is protected (DESIGN.md §3.5) — armoured, in the cabin, and
      // never exposed through a window, because they have no window to fire from.
      // They die with the vehicle and in no other way. This covers the solo
      // brawler too: the car is the team, so the car dying IS the driver dying.
      if (seat.drives) continue;
      const head = headWorld(vehicle, seat);
      const t = raycastSphere(
        ox,
        oy,
        oz,
        dx,
        dy,
        dz,
        head.x,
        head.y,
        head.z,
        COMBAT.headRadius,
        best,
      );
      if (t !== null && (memberHit === null || t < best - 1e-6)) {
        memberHit = member.id;
      }
    }
  }

  return {
    end: { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best },
    hullHit,
    memberHit,
    componentHit: component,
    distance: best,
  };
}

/**
 * Where the reticle ray meets the world.
 *
 * This is the first half of reticle-ray aiming (DESIGN.md §7). The crosshair
 * defines a ray from the CAMERA; the shot is then aimed from the muzzle at
 * whatever that ray found. That is what lets a weapon sitting in a window agree
 * with a crosshair drawn in the middle of the screen, a metre away from it.
 *
 * The shooter's own car is skipped. The camera rides directly behind its own
 * vehicle, so without this the ray reports the player's own chassis as the thing
 * under the crosshair, and every corrected shot is dutifully aimed at it.
 */
export function resolveAimPoint(
  vehicles: CombatVehicle[],
  shooterCrew: number,
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): { x: number; y: number; z: number } {
  let best = maxDistance;

  const arena = raycastSolids(ox, oy, oz, dx, dy, dz, maxDistance);
  if (arena !== null) best = arena;

  for (const vehicle of vehicles) {
    if (vehicle.id === shooterCrew) continue;
    const hit = raycastVehicle(vehicle, ox, oy, oz, dx, dy, dz, best);
    if (hit) best = hit.distance;
  }

  return { x: ox + dx * best, y: oy + dy * best, z: oz + dz * best };
}

/**
 * The vehicle-relative aim that points the muzzle at a world point.
 *
 * This is the second half of the correction: the crosshair found a point in the
 * world, and this is the angle from the window that actually reaches it. The
 * result is relative to the vehicle because that is what the seat's arc is
 * expressed in, and the arc is what stops a gunner firing through their own
 * chassis.
 */
export function aimAnglesAt(
  vehicle: CombatVehicle,
  seat: SeatDef,
  point: { x: number; y: number; z: number },
): { yaw: number; pitch: number } | null {
  const muzzle = muzzleWorld(vehicle, seat);
  const dx = point.x - muzzle.x;
  const dy = point.y - muzzle.y;
  const dz = point.z - muzzle.z;
  const length = Math.hypot(dx, dy, dz);
  if (length < 1e-4) return null;

  const worldYaw = Math.atan2(-dx / length, -dz / length);
  return {
    yaw: wrapAngle(worldYaw - vehicle.state.yaw),
    pitch: Math.asin(clamp(dy / length, -1, 1)),
  };
}

/** Apply damage to a crew's hull, clamped at zero. Returns the new value. */
export function damageHull(vehicle: CombatVehicle, amount: number): number {
  vehicle.hull = Math.max(0, vehicle.hull - amount);
  return vehicle.hull;
}

/** Apply damage to a crew member. Returns their new health. */
export function damageMember(member: CombatMember, amount: number): number {
  member.hp = Math.max(0, member.hp - amount);
  if (member.hp <= 0) member.alive = false;
  return member.hp;
}

export function isVehicleDead(vehicle: CombatVehicle): boolean {
  return vehicle.hull <= 0;
}

export { COMBAT };
