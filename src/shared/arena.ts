/**
 * The arena.
 *
 * Terrain is described as solids rather than triangles, because the vehicle
 * simulation needs cheap closed-form queries:
 *
 *   - `surfaceTopAt(x, z)`  — the ground height at a point
 *   - `isBlockingAt(...)`   — whether a solid is a wall at that point
 *
 * A solid is either a flat-topped `box` or a `ramp` whose top slopes linearly
 * along one axis.
 *
 * Every map lives in `maps/` (written with `maps/kit.ts`, symmetric by
 * construction). ONE map is active at a time in a process: the queries below
 * read `SOLIDS`, which `useMap` swaps. The client switches when its match's
 * map changes; the server switches before stepping each room (rooms run one
 * after another on one thread, so they never see each other's map).
 */

import { HAZARD } from './config';
import type { Vec3 } from './math';
import { DEFAULT_MAP, type MapId } from './mapIds';
import { MAPS, type ArenaMap } from './maps';
import { terrainTop } from './terrainTop';

export type Solid = {
  kind: 'box' | 'ramp';
  /** Footprint minimum; for ramps `min.y` is the base. */
  min: Vec3;
  /** Footprint maximum; for boxes `max.y` is the top surface. */
  max: Vec3;
  color: number;
  // ---- ramp only ----
  /** Axis the ramp's slope runs along. */
  along?: 'x' | 'z';
  /** Top height at the `min` end of that axis. */
  hStart?: number;
  /** Top height at the `max` end of that axis. */
  hEnd?: number;
  /**
   * Damaging ground (DESIGN.md §10.3). A flag rather than a colour comparison:
   * the palette is presentation, this is gameplay.
   */
  hazard?: boolean;
  /**
   * Ground (M10/M11). Floor rings are tinted per zone and built individually
   * rather than merged into the block batches, because they carry a texture.
   */
  ground?: boolean;
  /**
   * Set dressing drawn INSIDE this box instead of the box itself (client
   * `buildProps`): a line of concrete road barriers, or a nest of barrels,
   * tyres and crates. The collision is still exactly this box.
   */
  prop?: 'barriers' | 'nest';
  /** Ice: drivable ground with little grip (see `gripAt`). */
  ice?: boolean;
};

export { ARENA_HALF, STADIUM_HALF, STADIUM_WALL } from './maps/kit';
export type { ArenaMap } from './maps';
export { MAPS } from './maps';

/** The active map. */
export let MAP: ArenaMap = MAPS[DEFAULT_MAP];
/** The active map's solids: what every query below tests against. */
export let SOLIDS: Solid[] = MAP.solids;
/** The active map's repair crate positions. */
export let REPAIR_CRATES: ReadonlyArray<{ x: number; z: number }> = MAP.crates;

// ------------------------------------------------------------- broadphase

/**
 * A uniform grid over the map: each cell lists the solids within `GRID_MARGIN`
 * of it, in map order. Point queries (ground height, walls near a car, ice,
 * hazards) read one cell instead of every solid — a forest has hundreds — and
 * because the order is the map's, results are identical to a full scan.
 */
const GRID_CELL = 16;
const GRID_MARGIN = 6;
const GRID_HALF = 420;
const GRID_N = Math.ceil((GRID_HALF * 2) / GRID_CELL);
const grids = new WeakMap<ArenaMap, Solid[][]>();
let GRID: Solid[][] = gridFor(MAP);

function gridFor(map: ArenaMap): Solid[][] {
  let grid = grids.get(map);
  if (grid) return grid;
  grid = Array.from({ length: GRID_N * GRID_N }, () => [] as Solid[]);
  const cell = (v: number): number => Math.max(0, Math.min(GRID_N - 1, Math.floor((v + GRID_HALF) / GRID_CELL)));
  for (const s of map.solids) {
    const x0 = cell(s.min.x - GRID_MARGIN);
    const x1 = cell(s.max.x + GRID_MARGIN);
    const z0 = cell(s.min.z - GRID_MARGIN);
    const z1 = cell(s.max.z + GRID_MARGIN);
    for (let ix = x0; ix <= x1; ix++) for (let iz = z0; iz <= z1; iz++) grid[ix * GRID_N + iz].push(s);
  }
  grids.set(map, grid);
  return grid;
}

/**
 * Rebuild the active map's grid after changing `SOLIDS` in place (tests swap
 * in their own test grounds and walls).
 */
export function refreshSolids(): void {
  grids.delete(MAP);
  GRID = gridFor(MAP);
}

/** The solids within a few metres of a point, in map order. */
export function solidsNear(x: number, z: number): readonly Solid[] {
  const ix = Math.floor((x + GRID_HALF) / GRID_CELL);
  const iz = Math.floor((z + GRID_HALF) / GRID_CELL);
  if (ix < 0 || iz < 0 || ix >= GRID_N || iz >= GRID_N) return SOLIDS;
  return GRID[ix * GRID_N + iz];
}

/** Make a map the active one (cheap: it swaps references). */
export function useMap(id: MapId): ArenaMap {
  const map = MAPS[id] ?? MAPS[DEFAULT_MAP];
  if (map !== MAP) {
    MAP = map;
    SOLIDS = map.solids;
    REPAIR_CRATES = map.crates;
    GRID = gridFor(map);
  }
  return map;
}

/** Tyre grip at a point on the active map: the map's ground, or ice. */
export function gripAt(x: number, z: number): number {
  const near = solidsNear(x, z);
  for (let i = 0; i < near.length; i++) {
    const s = near[i];
    if (s.ice && x >= s.min.x && x <= s.max.x && z >= s.min.z && z <= s.max.z) return ICE_GRIP;
  }
  return MAP.grip;
}
/** Grip on ice: a car still steers, slowly, and slides a long way. */
const ICE_GRIP = 0.3;

// ------------------------------------------------------------------- spawns

/**
 * Spawn ring. Eight points at 45° intervals, facing the centre.
 *
 * Because the arena itself is 4-fold symmetric and the ring is 8-fold, rotating
 * any spawn by 90° lands on another spawn — so if one is clear, all eight are.
 * An earlier hand-placed set buried two cars inside the side ramps.
 */
/**
 * Spawn radii.
 *
 * Solo spawns on a 180 m ring: the 12-car field plays the inner part of the
 * map (the zone opens just outside it), so fights start within seconds. Duels
 * want an even more COMPACT start and never share a match with solo (separate
 * playlists), so they spawn closer in on the same map.
 */
export const SOLO_SPAWN_RADIUS = 180;
export const DUEL_SPAWN_RADIUS = 140;

/** A spawn point: position and the yaw that faces the arena centre. */
export type Spawn = { x: number; y: number; z: number; yaw: number };

/**
 * `count` spawns spread evenly around a ring of `radius`, all facing the centre.
 *
 * Generated rather than a fixed list because the field size is tunable: a fixed
 * eight cannot seat thirty without stacking cars on top of each other.
 */
export function spawnRing(count: number, radius = DUEL_SPAWN_RADIUS): Spawn[] {
  const n = Math.max(1, Math.floor(count));
  return Array.from({ length: n }, (_, i) => {
    const angle = (i / n) * Math.PI * 2;
    const x = Math.sin(angle) * radius;
    const z = Math.cos(angle) * radius;
    // Forward is (-sin yaw, -cos yaw); aiming it at the origin gives atan2(x, z).
    // Above whatever ground this map has there (a quarry's top bench is high).
    return { x, y: terrainTop(SOLIDS, x, z) + 2, z, yaw: Math.atan2(x, z) };
  });
}

/** The eight-point ring. Exported for the tests that dress the arena. */
export const SPAWNS: ReadonlyArray<Spawn> = spawnRing(8);

/** Default single-player / first spawn. */
export const SPAWN = SPAWNS[0];

/**
 * Team spawn: teams spread evenly around the ring.
 *
 * The naive `SPAWNS[team]` puts two teams 45° apart — close enough to share
 * cover and start a duel with a knife fight — so it is `spawnRing(teamCount)`
 * instead. The ring is 4-fold symmetric, so any evenly-spaced arrangement is
 * equivalent; that is why this is arithmetic rather than authored data.
 */
export function spawnForTeam(
  team: number,
  teamCount: number,
  radius = DUEL_SPAWN_RADIUS,
): Spawn {
  const ring = spawnRing(teamCount, radius);
  const index = ((team % ring.length) + ring.length) % ring.length;
  return ring[index];
}

/**
 * Hazard damage per second at a world point, or 0 on clear ground.
 *
 * Tests the vehicle's centre against the footprint. A graded hazard ("you are
 * half on it") would be nicer and is not worth the ambiguity: you are either in
 * the bad ground or you are not, and the player must be able to tell.
 */
export function hazardAt(x: number, z: number): number {
  const near = solidsNear(x, z);
  for (let i = 0; i < near.length; i++) {
    const solid = near[i];
    if (!solid.hazard) continue;
    if (x >= solid.min.x && x <= solid.max.x && z >= solid.min.z && z <= solid.max.z) {
      return HAZARD.hullPerSecond;
    }
  }
  return 0;
}

// ------------------------------------------------------------------- queries

/** Top surface height of a solid at a point, or `null` if outside its footprint. */
export function surfaceTopAt(s: Solid, x: number, z: number): number | null {
  if (x < s.min.x || x > s.max.x || z < s.min.z || z > s.max.z) return null;

  if (s.kind === 'box') return s.max.y;

  const along = s.along!;
  const hStart = s.hStart!;
  const hEnd = s.hEnd!;
  const span = along === 'x' ? s.max.x - s.min.x : s.max.z - s.min.z;
  if (span <= 1e-6) return hStart;
  const t = along === 'x' ? (x - s.min.x) / span : (z - s.min.z) / span;
  return hStart + (hEnd - hStart) * t;
}

/**
 * The highest surface at or below `maxY` under a point. Returns `-Infinity` if
 * there is nothing there at all (a bottomless pit — this arena has none).
 */
export function terrainHeightAt(x: number, z: number, maxY: number): number {
  let best = -Infinity;
  const near = solidsNear(x, z);
  for (let i = 0; i < near.length; i++) {
    const top = surfaceTopAt(near[i], x, z);
    if (top === null) continue;
    if (top <= maxY + 1e-4 && top > best) best = top;
  }
  return best;
}

/**
 * Ray against the arena, returning the nearest entry distance or `null`.
 *
 * Solids are treated as their bounding boxes. Ramps are wedges and this is
 * therefore slightly generous at the underside of one — a shot can clip the air
 * just beneath a ramp lip and register a hit. That is a deliberate trade: an
 * exact wedge intersection is more code on the hot path of every hitscan, for a
 * discrepancy nobody will notice, since the visual is a solid ramp.
 *
 * Direction must be normalised.
 */
export function raycastSolids(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  maxDistance: number,
): number | null {
  // The ray's own bounding box: most solids are rejected by four comparisons.
  const ex = ox + dx * maxDistance;
  const ez = oz + dz * maxDistance;
  const rx0 = Math.min(ox, ex);
  const rx1 = Math.max(ox, ex);
  const rz0 = Math.min(oz, ez);
  const rz1 = Math.max(oz, ez);
  // Reciprocals once per ray; a zero component is handled by the slab test.
  const ix = Math.abs(dx) < 1e-9 ? 0 : 1 / dx;
  const iy = Math.abs(dy) < 1e-9 ? 0 : 1 / dy;
  const iz = Math.abs(dz) < 1e-9 ? 0 : 1 / dz;

  let nearest: number | null = null;
  let limit = maxDistance;
  for (let i = 0; i < SOLIDS.length; i++) {
    const s = SOLIDS[i];
    if (s.max.x < rx0 || s.min.x > rx1 || s.max.z < rz0 || s.min.z > rz1) continue;
    let tMin = 0;
    let tMax = limit;
    // Slab test, one axis at a time, without allocating.
    if (ix === 0) {
      if (ox < s.min.x || ox > s.max.x) continue;
    } else {
      let t1 = (s.min.x - ox) * ix;
      let t2 = (s.max.x - ox) * ix;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }
    if (iy === 0) {
      if (oy < s.min.y || oy > s.max.y) continue;
    } else {
      let t1 = (s.min.y - oy) * iy;
      let t2 = (s.max.y - oy) * iy;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }
    if (iz === 0) {
      if (oz < s.min.z || oz > s.max.z) continue;
    } else {
      let t1 = (s.min.z - oz) * iz;
      let t2 = (s.max.z - oz) * iz;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) continue;
    }
    if (tMin >= 0 && (nearest === null || tMin < nearest)) {
      nearest = tMin;
      limit = tMin;
    }
  }

  return nearest;
}

/**
 * Whether a solid acts as a wall at a point: it does if its surface is more than
 * a step above the given height, meaning it can't simply be driven over.
 */
export function isBlockingAt(s: Solid, x: number, z: number, fromY: number, stepUp: number): boolean {
  const top = surfaceTopAt(s, x, z);
  if (top === null) return false;
  return top > fromY + stepUp;
}
