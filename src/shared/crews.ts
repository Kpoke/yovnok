/**
 * Crews: who rides where, and what each seat can see.
 *
 * In shared code because both sides need it. The client anchors a camera to a
 * seat's `eye` socket and clamps aim to its arc; the server needs the same data
 * to know who is crewing which vehicle, and (from M5) to resolve what a shot can
 * reach.
 *
 * THE ARC IS THE DESIGN. A gunner fires through a window, so their field of fire
 * is a sector rather than 360°. That is what makes the driver's positioning
 * matter: a gunner in the front passenger seat cannot shoot behind the car, so
 * the driver has to present the armed side. It replaces turret traverse
 * (DESIGN.md §3.2) with something you can read off the car at a glance.
 *
 * CONVENTION, and it is not the obvious one. Vehicle forward at yaw `y` is
 * `(-sin y, -cos y)`, so increasing yaw turns LEFT: at yaw +90 the car faces -X.
 * Aim yaw therefore uses the same convention, and **positive aim yaw is to the
 * LEFT**:
 *
 *            0  (forward)
 *            |
 *   +90 -----+----- -90     (+90 = left, ±180 = behind, -90 = right)
 *            |
 *          ±180
 *
 * Getting this backwards mirrors every field of fire onto the wrong side of the
 * car, which is exactly the kind of bug that looks like "the gun doesn't work".
 */

import { VEHICLE_CLASSES, type VehicleClassId } from './config';
import type { WeaponId } from './weapons';

/**
 * Offsets from a seat's mount, shared so geometry and gameplay cannot drift.
 * The mesh builds its sockets from these, and the server fires and hit-tests
 * from the same numbers — an `eye` socket the renderer draws and a head the
 * server shoots at must be the same place.
 */
export const EYE_OFFSET = [0, 0.38, 0.05] as const;
/**
 * Where a leaning gunner's shots leave: the rifle's muzzle, held at the
 * shoulder out of the window (the figure is posed to match), by side.
 */
export const FIRE_PORT_OFFSET = {
  right: [0.95, 0.5, -0.35],
  left: [-0.95, 0.5, -0.35],
} as const;

/**
 * Where a LEANING gunner's head is: out of their window, clear of the body.
 *
 * This is the PERSON — what you see leaning out, and what a shot has to find.
 * Deliberately distinct from `WINDOW_EYE_OFFSET`, which is the camera: an
 * observer that sits further out for clearance from the body. Conflating the
 * two drew occupants floating beside the car, like chairs bolted to the doors.
 *
 * The head has to break the hull line at all. A shot at a crew member is clipped
 * to the distance at which the ray meets the hull, so a head modelled strictly
 * inside the cabin can never be hit from any angle (see `headWorld`).
 */
export const HEAD_OFFSET = {
  right: [0.5, 1.07, 0.15],
  left: [-0.5, 1.07, 0.15],
} as const;

/** A leaning gunner's chest, under the head, in the window opening. */
export const CHEST_OFFSET = {
  right: [0.38, 0.92, 0.07],
  left: [-0.38, 0.92, 0.07],
} as const;

/**
 * The camera-gunner's viewpoint, by side: an observer a little outside the body.
 *
 * A gunner's view is anchored to a specific window on a specific side, so a rear
 * gunner and a front gunner see different worlds — unlike the chase camera,
 * which is a view of the car and therefore identical for every seat.
 *
 * Distinct from `HEAD_OFFSET` (the person) and `eye` (their head inside the
 * cabin). Deliberately a little further out than the bodywork so the near plane
 * cannot clip the car it is looking out of.
 */
export const WINDOW_EYE_OFFSET = {
  right: [0.95, 0.55, 0.15],
  left: [-0.95, 0.55, 0.15],
} as const;

export type SeatId = 'seat.driver' | 'seat.frontRight' | 'seat.rearLeft' | 'seat.rearRight';

/**
 * What a seat can do. `driverGunner` is the one-man brawler: the same person
 * holds the wheel and the trigger (DESIGN.md §2.3), which is why capability is
 * two independent flags rather than one role label.
 */
export type SeatCapability = 'driver' | 'gunner' | 'driverGunner';

export type SeatDef = {
  id: SeatId;
  /** Does this seat hold the wheel? Independent of whether it can fire. */
  drives: boolean;
  /** Which side of the car the occupant sits on. */
  side: 'left' | 'right';
  /** Mount position on the chassis, in vehicle local space. */
  mount: readonly [number, number, number];
  /**
   * Field of fire, or `null` for an unarmed seat. A seat with an arc can fire;
   * whether it can also drive is `drives`.
   */
  arc: readonly [number, number] | null;
  /**
   * Car-mounted weapons this seat works, in slot order (primary first). When
   * present, these ARE the seat's weapons and the occupant's personal loadout is
   * ignored — the car is the weapon (DESIGN.md §2.3). Absent means the occupant
   * fires a personal weapon through a window (DESIGN.md §3.2).
   */
  mounted?: readonly MountedWeapon[];
  /**
   * Muzzle port, in SEAT-local space. Defaults to the side's window aperture, so
   * window gunners need not set it; a car-mounted gun sets a centre-line port.
   */
  firePort?: readonly [number, number, number];
};

type V3 = readonly [number, number, number];

/**
 * A weapon bolted to the car, worked by one trigger.
 *
 * Each `mount` is a physical gun: a `pivot` it traverses about (vehicle-local)
 * and a `muzzle` offset from that pivot when facing straight ahead. A weapon with
 * two mounts (twin guns) fires them in turn. Aim is limited to `yawArc` either
 * side of the car's nose and `pitchArc` up/down — the guns physically turn that
 * far and no further, and the server enforces the same limits.
 */
export type MountedWeapon = {
  weapon: WeaponId;
  /** Left mouse button fires `primary`, right fires `secondary`. */
  trigger: 'primary' | 'secondary';
  mounts: readonly { pivot: V3; muzzle: V3 }[];
  yawArc: readonly [number, number];
  pitchArc: readonly [number, number];
  /** Which part draws it: `gun` (one per mount) or `turret` (a roof station). */
  part: 'gun' | 'turret';
};

/** The loadout a mounted seat implies, in slot order. */
export function mountedLoadout(seat: SeatDef): WeaponId[] {
  return (seat.mounted ?? []).map((m) => m.weapon);
}

/**
 * A mount's muzzle in VEHICLE-local space, with the gun turned `relYaw` about its
 * pivot. Pitch is left out: the guns are short, and moving the muzzle with pitch
 * would shift shots for reasons the player cannot see.
 */
export function mountMuzzleLocal(mount: { pivot: V3; muzzle: V3 }, relYaw: number): [number, number, number] {
  const c = Math.cos(relYaw);
  const s = Math.sin(relYaw);
  // Same yaw convention as the vehicle: +yaw turns left, forward is -Z.
  const [mx, my, mz] = mount.muzzle;
  return [mount.pivot[0] + mx * c + mz * s, mount.pivot[1] + my, mount.pivot[2] - mx * s + mz * c];
}

/** A seat's capability, derived so it cannot disagree with the flags. */
export function seatCapability(seat: SeatDef): SeatCapability {
  if (seat.drives) return seat.arc ? 'driverGunner' : 'driver';
  return 'gunner';
}

const deg = (d: number): number => (d * Math.PI) / 180;

/** One gunner per class in the coupe; three in the SUV. */
/**
 * A window gunner's field of fire: all the way round. Out of their own side
 * they lean out of the window; across the car they climb onto the sill and
 * shoot over the roof (`roofAmount`).
 */
const ALL_ROUND: readonly [number, number] = [-Math.PI, Math.PI];

const COUPE_SEATS: SeatDef[] = [
  // The duo car is the brawler's body, without its guns: seats where its own are.
  { id: 'seat.driver', drives: true, side: 'left', mount: [-0.38, -0.3, 0.2], arc: null },
  {
    id: 'seat.frontRight',
    drives: false,
    side: 'right',
    mount: [0.38, -0.3, 0.2],
    arc: ALL_ROUND,
  },
];

const SUV_SEATS: SeatDef[] = [
  // Seats of the SUV body (scripts/prep/suv.ts): low enough that a seated
  // head clears its roof, at its front and rear doors.
  { id: 'seat.driver', drives: true, side: 'left', mount: [-0.45, -0.52, -0.25], arc: null },
  {
    id: 'seat.frontRight',
    drives: false,
    side: 'right',
    mount: [0.45, -0.52, -0.25],
    arc: ALL_ROUND,
  },
  {
    id: 'seat.rearLeft',
    drives: false,
    side: 'left',
    mount: [-0.45, -0.52, 0.85],
    arc: ALL_ROUND,
  },
  {
    id: 'seat.rearRight',
    drives: false,
    side: 'right',
    mount: [0.45, -0.52, 0.85],
    arc: ALL_ROUND,
  },
];

/**
 * The one-man brawler's seat: drives AND fires (DESIGN.md §2.3).
 *
 * The arc is a turret's, not a window's — nearly all round, with a small blind
 * spot directly behind where the car's own body is in the way. A single narrow
 * forward arc would make the driver's positioning irrelevant; a full 360 would
 * make it free. This is the middle that keeps the car a weapon without making
 * the car's heading stop mattering.
 */
/**
 * The brawler's weapons. The parts are the truck's M2 and RPG station, scaled
 * for a coupe in the vehicle manifest; the muzzle offsets here are the measured
 * ones (`scripts/prep/armored.ts`) times those scales, so shots leave where the
 * barrels are drawn.
 */
/** Manifest scales for the brawler's gun and roof station parts. */
export const SOLO_GUN_SCALE = 0.85;
export const SOLO_TURRET_SCALE = 0.62;
const scaled = (v: V3, k: number): V3 => [v[0] * k, v[1] * k, v[2] * k];
/**
 * Twin M2s on the front fenders, right above the headlights — on the bumper
 * itself the receivers would sit inside the bodywork.
 */
const SOLO_MG_PIVOT_L: V3 = [-0.62, 0.07, -1.92];
const SOLO_MG_PIVOT_R: V3 = [0.62, 0.07, -1.92];
export const SOLO_MG_MUZZLE: V3 = scaled([0.021, 0.132, -0.757], SOLO_GUN_SCALE);
/** The roof weapon station, carrying the RPG, toward the back of the roof. */
const SOLO_TURRET_PIVOT: V3 = [0, 0.59, 0.35];
export const SOLO_RPG_MUZZLE: V3 = scaled([0.07, 0.42, -1.38], SOLO_TURRET_SCALE);
/** Driver's seat, front left. */
const SOLO_DRIVER: V3 = [-0.38, -0.3, 0.2];

const SOLO_SEATS: SeatDef[] = [
  {
    id: 'seat.driver',
    drives: true,
    side: 'left',
    mount: SOLO_DRIVER,
    // The seat's overall field of fire is the widest of its weapons — the roof
    // station's, with a real blind spot behind: an enemy on your tail is safe
    // until you turn, so the car's heading still decides who can shoot whom.
    arc: [deg(-135), deg(135)],
    mounted: [
      {
        // Converge on the crosshair, but only ±20° off the nose: you aim the
        // guns mostly by aiming the truck.
        weapon: 'mg',
        trigger: 'primary',
        mounts: [
          { pivot: SOLO_MG_PIVOT_L, muzzle: SOLO_MG_MUZZLE },
          { pivot: SOLO_MG_PIVOT_R, muzzle: SOLO_MG_MUZZLE },
        ],
        yawArc: [deg(-20), deg(20)],
        pitchArc: [deg(-12), deg(20)],
        part: 'gun',
      },
      {
        weapon: 'rocket',
        trigger: 'secondary',
        mounts: [{ pivot: SOLO_TURRET_PIVOT, muzzle: SOLO_RPG_MUZZLE }],
        yawArc: [deg(-135), deg(135)],
        pitchArc: [deg(-15), deg(35)],
        part: 'turret',
      },
    ],
  },
];

export function seatsFor(cls: VehicleClassId): SeatDef[] {
  if (cls === 'solo') return SOLO_SEATS;
  return cls === 'coupe' ? COUPE_SEATS : SUV_SEATS;
}

export function seatById(cls: VehicleClassId, id: string): SeatDef | undefined {
  return seatsFor(cls).find((seat) => seat.id === id);
}

/** Crew capacity, including the driver. */
export function crewSize(cls: VehicleClassId): number {
  return seatsFor(cls).length;
}

/** Whether a yaw falls inside a field of fire. Handles arcs wider than 180°. */
export function withinArc(arc: readonly [number, number], yaw: number): boolean {
  const span = arc[1] - arc[0];
  let offset = (yaw - arc[0]) % (Math.PI * 2);
  if (offset < 0) offset += Math.PI * 2;
  return offset <= span;
}

/**
 * Clamp a yaw into a field of fire, returning the nearest edge when outside.
 *
 * Used to stop a gunner aiming through the car body. Deliberately clamped rather
 * than blocked: dragging the view against a limit reads as a window frame,
 * whereas a hard stop reads as a bug.
 */
export function clampToArc(arc: readonly [number, number], yaw: number): number {
  const span = arc[1] - arc[0];
  let offset = (yaw - arc[0]) % (Math.PI * 2);
  if (offset < 0) offset += Math.PI * 2;

  if (offset <= span) return yaw;

  const pastEnd = offset - span;
  const beforeStart = Math.PI * 2 - offset;
  return pastEnd < beforeStart ? arc[1] : arc[0];
}

// ------------------------------------------------------------- gunner posture

/** Aim yaw (car-relative, + = left) a gunner's window faces: their side. */
const outward = (seat: SeatDef): number => (seat.side === 'right' ? -Math.PI / 2 : Math.PI / 2);

/**
 * How far a window gunner is up on the sill shooting over the roof: 0 leaning
 * out of the window (aiming out of their own side, within ~100° of it), 1 up
 * over the roof (aiming across the car), blended between 100° and 125°.
 */
export function roofAmount(seat: SeatDef, aimYaw: number): number {
  let d = Math.abs(aimYaw - outward(seat)) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  const t = (d - (100 * Math.PI) / 180) / ((25 * Math.PI) / 180);
  const x = t < 0 ? 0 : t > 1 ? 1 : t;
  return x * x * (3 - 2 * x);
}

/**
 * Up over the roof or at the window, with hysteresis: a gunner climbs up once
 * the aim is well across the car (120° off their own side) and comes back
 * down only once it is clearly back (95°). Deciding by the aim alone, an aim
 * near the line flipped them up and down several times a second — reading as
 * ducking in and out of the car. The server keeps this per gunner and sends it.
 */
export function nextRoof(seat: SeatDef, aimYaw: number, wasRoof: boolean): boolean {
  let d = Math.abs(aimYaw - outward(seat)) % (Math.PI * 2);
  if (d > Math.PI) d = Math.PI * 2 - d;
  return d > ((wasRoof ? 95 : 120) * Math.PI) / 180;
}

/** Once up or down, a gunner stays at least this long (ms) before moving again. */
export const ROOF_DWELL_MS = 1000;

/** `nextRoof` with the dwell: `state` is the gunner's posture and when it last changed (ms). */
export function stepRoof(state: { roof: boolean; at: number }, seat: SeatDef, aimYaw: number, out: boolean, now: number): boolean {
  const want = out && nextRoof(seat, aimYaw, state.roof);
  // Ducking back in is immediate; only climbing up or down waits out the dwell.
  if (want !== state.roof && (!out || now - state.at >= ROOF_DWELL_MS)) {
    state.roof = want;
    state.at = now;
  }
  return state.roof;
}

export type GunnerPart = 'head' | 'chest' | 'waist' | 'muzzle';

/**
 * The window opening of each car a gunner rides in, car-local, measured from
 * the bodies (scripts/prep): the door's top edge (`belt`), the side of the
 * cabin there (`side`, |x|) and the roof.
 */
type Cabin = { belt: number; side: number; roof: number; hatch?: { x: number; z: number } };
export const CABIN: Partial<Record<VehicleClassId, Cabin>> = {
  // The duo car's side windows are armoured louvres: its gunner stands up
  // through a roof hatch instead (|x|, z of its centre; the mesh draws it).
  coupe: { belt: 0.2, side: 0.72, roof: 0.71, hatch: { x: 0.24, z: 0.3 } },
  suv: { belt: 0.2, side: 0.86, roof: 0.82 },
};
const DEFAULT_CABIN: Cabin = { belt: 0.2, side: 0.8, roof: 0.75 };

/**
 * A window gunner's body for an aim, car-local: where their hips are and which
 * way their spine runs. ONE description for the drawn figure (vehicle/figures.ts
 * poses its skeleton along it) and for what a shot has to find (`gunnerPoint`).
 *
 * At the window they sit in the opening on the door's edge, upright and
 * leaning a little out, the chest and head clear of the car — the way the
 * people in Fortnite's cars ride. Aiming across the car they sit up on the
 * frame, turned to face over the roof, leaning in over it.
 */
export function gunnerBody(
  cls: VehicleClassId,
  seat: SeatDef,
  aimYaw: number,
  roof: number = roofAmount(seat, aimYaw),
): { hips: [number, number, number]; spine: [number, number, number]; roof: number } {
  const c = CABIN[cls] ?? DEFAULT_CABIN;
  const s = seat.side === 'right' ? 1 : -1;
  if (c.hatch) {
    // Stood up in the hatch: upright, chest and head clear of the roof,
    // leaning into the gun whichever way it points. No window, no climbing.
    const v = [-Math.sin(aimYaw) * 0.2, 1, -Math.cos(aimYaw) * 0.2];
    const n = Math.hypot(v[0], v[1], v[2]);
    return { hips: [s * c.hatch.x, c.roof - 0.26, c.hatch.z], spine: [v[0] / n, v[1] / n, v[2] / n], roof: 0 };
  }
  const z = seat.mount[2] + 0.05;
  // Sat up on the door frame, the whole torso above the roofline (legs inside),
  // so they read from every side, from behind most of all; over the roof, a
  // little further in, leaning across it.
  const window = [s * c.side, c.roof - 0.18, z];
  const over = [s * (c.side - 0.06), c.roof - 0.12, z];
  const hips = [0, 1, 2].map((k) => window[k] + (over[k] - window[k]) * roof) as [number, number, number];
  // Leaning a little out at the window, in over the roof up there, and into
  // the gun either way (a shooter's weight goes forward onto it).
  const out = s * (0.25 - 0.6 * roof);
  const v = [out - Math.sin(aimYaw) * 0.18, 1, -Math.cos(aimYaw) * 0.18];
  const n = Math.hypot(v[0], v[1], v[2]);
  return { hips, spine: [v[0] / n, v[1] / n, v[2] / n], roof };
}

/**
 * The crew are drawn this much larger than life (1.8 m models at ~2.07 m), and
 * their guns larger again: at true scale on a full-size car they read as small,
 * dark smudges from the chase camera.
 */
export const FIGURE_SCALE = 1.15;
export const HAND_GUN_SCALE = 1.25;

/**
 * Points along a gunner's body, from the hips (joints measured from the 1.8 m
 * models, times FIGURE_SCALE): the spine starts 0.1 m above the hips and runs
 * along `spine`; the chest is 0.22 m up it, the head 0.6 m, and the shooting
 * shoulder — where the butt sits — 0.3 m up and 0.13 m to the right of the aim
 * (the chest squares to the gun).
 */
const BODY = {
  base: 0.1 * FIGURE_SCALE,
  chest: 0.22 * FIGURE_SCALE,
  head: 0.6 * FIGURE_SCALE,
  shoulder: 0.3 * FIGURE_SCALE,
  shoulderOut: 0.13 * FIGURE_SCALE,
} as const;

/**
 * A window gunner's body (what a shot has to find) and muzzle, car-local, for
 * their aim: out of the window, or up on the sill over the roof, blended.
 */
export function gunnerPoint(
  cls: VehicleClassId,
  seat: SeatDef,
  aimYaw: number,
  aimPitch: number,
  part: GunnerPart,
  /** Over the roof (1) or at the window (0); by default, from the aim alone. */
  roof?: number,
): [number, number, number] | null {
  const { hips, spine } = gunnerBody(cls, seat, aimYaw, roof);
  const up = (d: number): [number, number, number] => [hips[0] + spine[0] * d, hips[1] + BODY.base + spine[1] * d, hips[2] + spine[2] * d];
  if (part === 'head') return up(BODY.head);
  if (part === 'chest') return up(BODY.chest);
  if (part === 'waist') return up(0);
  // The muzzle: a gun's length along the aim from the shooting shoulder.
  const c = Math.cos(aimPitch);
  const shoulder = up(BODY.shoulder);
  const length = 0.82 * HAND_GUN_SCALE;
  return [
    shoulder[0] + Math.cos(aimYaw) * BODY.shoulderOut - Math.sin(aimYaw) * c * length,
    shoulder[1] + Math.sin(aimPitch) * length,
    shoulder[2] - Math.sin(aimYaw) * BODY.shoulderOut - Math.cos(aimYaw) * c * length,
  ];
}
