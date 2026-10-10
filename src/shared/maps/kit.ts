/**
 * The toolkit every map is written with: solids, the quarter-turn that makes a
 * layout symmetric, ground rings and the boundary.
 *
 * SYMMETRY IS GENERATED, NOT HAND-AUTHORED. Each map writes ONE quadrant and
 * `repeat4` replicates it by rotating 90° three times, so every map is fair by
 * construction (cover, ramps and hazards are identical from every spawn).
 * `simcheck` asserts the generated fields are genuinely 4-fold symmetric.
 */

import type { Vec3 } from '../math';
import type { Solid } from '../arena';
import { PALETTE } from '../config';

/** Half-extent of the whole world floor (the playable square sits inside). */
export const ARENA_HALF = 400;

/**
 * The playable square: a boundary at this half-extent bounds every map (a
 * stadium barrier, canyon walls, a harbour wall, a perimeter fence…), with the
 * scenery outside it. Same size on every map, so the closing zone, the spawn
 * ring and the match pacing are the same everywhere.
 */
export const STADIUM_HALF = 235;
/** Boundary height: tall enough that no ramp launch clears it. */
export const STADIUM_WALL = 4.5;

export const box = (min: Vec3, max: Vec3, color: number): Solid => ({ kind: 'box', min, max, color });

export const ramp = (
  min: Vec3,
  max: Vec3,
  along: 'x' | 'z',
  hStart: number,
  hEnd: number,
  color: number,
): Solid => ({ kind: 'ramp', min, max, along, hStart, hEnd, color });

/** A ground strip (drivable, never blocking): roads, riverbeds, runways. */
export const strip = (min: Vec3, max: Vec3, color: number): Solid => ({ ...box(min, max, color), ground: true });

/**
 * Rotate a solid 90° about the arena centre.
 *
 * The mapping is `(x, z) -> (z, -x)`, which is a pure quarter turn. A box stays
 * an axis-aligned box (its width and depth simply swap). A ramp swaps its slope
 * axis — and, when going from `x` to `z`, also swaps which end is high, because
 * the rotation reverses the direction of the z axis.
 */
export function rotate90(s: Solid): Solid {
  const a = { x: s.min.z, z: -s.min.x };
  const b = { x: s.max.z, z: -s.max.x };
  const min: Vec3 = { x: Math.min(a.x, b.x), y: s.min.y, z: Math.min(a.z, b.z) };
  const max: Vec3 = { x: Math.max(a.x, b.x), y: s.max.y, z: Math.max(a.z, b.z) };
  if (s.kind === 'box') return { ...s, min, max };
  // x -> z reverses the slope direction, so the ends swap. z -> x does not.
  const becameZ = s.along === 'x';
  return {
    ...s,
    min,
    max,
    along: becameZ ? 'z' : 'x',
    hStart: becameZ ? s.hEnd : s.hStart,
    hEnd: becameZ ? s.hStart : s.hEnd,
  };
}

/** A feature and its three rotational copies. */
export function repeat4(features: Solid[]): Solid[] {
  const out: Solid[] = [];
  for (const feature of features) {
    let current = feature;
    for (let quarter = 0; quarter < 4; quarter++) {
      out.push(current);
      current = rotate90(current);
    }
  }
  return out;
}

/**
 * A square ground ring, tinted by zone. `half` is its half-extent. Rings are
 * nested, each a few MILLIMETRES higher than the one outside it, so the
 * innermost wins the ground query; the steps are far below a car's step height.
 */
export const groundRing = (half: number, top: number, color: number): Solid => ({
  ...box({ x: -half, y: -4, z: -half }, { x: half, y: top, z: half }, color),
  ground: true,
});

/** The five zone rings every map's floor is made of (its look is per map). */
export function zoneGround(): Solid[] {
  return [
    groundRing(100, 0.04, PALETTE.zoneCentre),
    groundRing(200, 0.033, PALETTE.zoneDunes),
    groundRing(280, 0.026, PALETTE.zoneScrapyard),
    groundRing(340, 0.019, PALETTE.zoneLakebed),
    groundRing(ARENA_HALF + 12, 0.012, PALETTE.zoneRim),
  ];
}

/**
 * The world's outer walls and the playable boundary. Both MUST overlap at the
 * corners: meeting edge to edge left an unblocked diagonal gap at each corner
 * that a car could drive straight through.
 */
export function boundary(): Solid[] {
  const A = ARENA_HALF;
  const S = STADIUM_HALF;
  const W = STADIUM_WALL;
  return [
    box({ x: -A - 4, y: 0, z: -A - 4 }, { x: A + 4, y: 16, z: -A }, PALETTE.wall),
    box({ x: -A - 4, y: 0, z: A }, { x: A + 4, y: 16, z: A + 4 }, PALETTE.wall),
    box({ x: -A - 4, y: 0, z: -A - 4 }, { x: -A, y: 16, z: A + 4 }, PALETTE.wall),
    box({ x: A, y: 0, z: -A - 4 }, { x: A + 4, y: 16, z: A + 4 }, PALETTE.wall),
    box({ x: -S - 1.5, y: 0, z: -S - 1.5 }, { x: S + 1.5, y: W, z: -S }, PALETTE.wall),
    box({ x: -S - 1.5, y: 0, z: S }, { x: S + 1.5, y: W, z: S + 1.5 }, PALETTE.wall),
    box({ x: -S - 1.5, y: 0, z: -S - 1.5 }, { x: -S, y: W, z: S + 1.5 }, PALETTE.wall),
    box({ x: S, y: 0, z: -S - 1.5 }, { x: S + 1.5, y: W, z: S + 1.5 }, PALETTE.wall),
  ];
}

/** A point and its three quarter-turns: crates and other markers. */
export function points4(x: number, z: number): Array<{ x: number; z: number }> {
  const out: Array<{ x: number; z: number }> = [];
  let p = { x, z };
  for (let q = 0; q < 4; q++) {
    out.push(p);
    p = { x: p.z, z: -p.x };
  }
  return out;
}
