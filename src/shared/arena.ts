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
 * SYMMETRY IS GENERATED, NOT HAND-AUTHORED. The layout is written once as a
 * single quadrant (`WEDGE`) and replicated by rotating it 90° three times. That
 * matters because "fair by construction" is a design pillar (DESIGN.md §2): a
 * hand-placed map drifts out of symmetry the moment someone nudges one block,
 * and asymmetric cover is exactly the kind of thing that quietly decides
 * matches. `simcheck` asserts the generated field is genuinely 4-fold symmetric.
 *
 * Arena *layout* tuning — sightlines, pickup timings — is deliberately NOT this
 * milestone. M3 gives the arena a designed symmetric *shape*; the competitive
 * layout gets tuned at M7 against real weapons and turret traverse.
 *
 * The M12 pass adds the first **authored content** on that shape — verticality
 * (a drivable mesa), landmarks (a scrapyard crane, a lakebed dam) and roads —
 * still written in the one quadrant, so it stays symmetric by construction.
 */

import { HAZARD, PALETTE } from './config';
import type { Vec3 } from './math';

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
};

const box = (min: Vec3, max: Vec3, color: number): Solid => ({ kind: 'box', min, max, color });

const ramp = (
  min: Vec3,
  max: Vec3,
  along: 'x' | 'z',
  hStart: number,
  hEnd: number,
  color: number,
): Solid => ({ kind: 'ramp', min, max, along, hStart, hEnd, color });

// ---------------------------------------------------------------------- arena

/**
 * Half-extent of the playable floor: 800 m across (M11).
 *
 * Grown from 340 m for battle royale: a field of ~30 cars needs ground that
 * crossing costs time, and enough separation that the field does not start on
 * top of itself. It is where interest management (M10) finally earns its keep —
 * at 340 m almost every car was inside the interest radius anyway.
 *
 * The layout is still FAIR BY CONSTRUCTION: one quadrant, rotated four times.
 * Zone character (cover density, hazards) varies by distance from the centre,
 * which is symmetric by the same argument.
 */
export const ARENA_HALF = 400;

/**
 * The stadium: a concrete barrier ring at this half-extent bounds the playable
 * floor (the televised arena), with the stands outside it. Everything beyond
 * is set dressing; the outer ARENA_HALF walls remain as a backstop.
 */
export const STADIUM_HALF = 235;
/** Barrier height: tall enough that no ramp launch clears it. */
export const STADIUM_WALL = 4.5;

/**
 * Rotate a solid 90° about the arena centre.
 *
 * The mapping is `(x, z) -> (z, -x)`, which is a pure quarter turn. A box stays
 * an axis-aligned box (its width and depth simply swap). A ramp swaps its slope
 * axis — and, when going from `x` to `z`, also swaps which end is high, because
 * the rotation reverses the direction of the z axis.
 */
function rotate90(s: Solid): Solid {
  const ax = { x: s.min.x, z: s.min.z };
  const bx = { x: s.max.x, z: s.max.z };
  // (x, z) -> (z, -x)
  const a = { x: ax.z, z: -ax.x };
  const b = { x: bx.z, z: -bx.x };

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
function repeat4(features: Solid[]): Solid[] {
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
 * One quadrant of the map. Everything here is replicated by rotation, so this
 * is the only place layout is authored.
 */
const WEDGE: Solid[] = [
  // ---- inner ring: the objective's doorstep -----------------------------
  // Ramp up onto the central platform, from this quadrant's side.
  ramp({ x: -6, y: 0, z: 11 }, { x: 6, y: 3.4, z: 23 }, 'z', 3.4, 0, PALETTE.ramp),
  // Cover close to the pad, so the fight over the centre has something to use.
  box({ x: 30, y: 0, z: 30 }, { x: 44, y: 5, z: 44 }, PALETTE.block),

  // ---- middle ring: room to manoeuvre ----------------------------------
  // Launch ramp, off the cardinal axes so it does not fight the centre ramps.
  ramp({ x: 62, y: 0, z: 16 }, { x: 78, y: 3.6, z: 32 }, 'z', 3.6, 0, PALETTE.ramp),
  // A second, opposite ramp so both approaches to the middle can be launched.
  ramp({ x: 16, y: 0, z: 96 }, { x: 32, y: 3.6, z: 112 }, 'x', 3.6, 0, PALETTE.ramp),
  // Flanking blocks: cover that gives a second angle on the centre approach,
  // sized to break line of sight for a CAR rather than a person.
  box({ x: 54, y: 0, z: 56 }, { x: 68, y: 5.5, z: 70 }, PALETTE.block),
  box({ x: 20, y: 0, z: 74 }, { x: 34, y: 3.4, z: 88 }, PALETTE.block),

  // ---- outer ring: the landmarks ---------------------------------------
  // Tall and unmistakable — the thing you navigate by.
  box({ x: 120, y: 0, z: 120 }, { x: 138, y: 11, z: 138 }, PALETTE.block),
  // Outer cover on both flanks of the quadrant, so the rim is not a race track.
  box({ x: 114, y: 0, z: 40 }, { x: 130, y: 4.5, z: 56 }, PALETTE.block),
  box({ x: 40, y: 0, z: 114 }, { x: 56, y: 4.5, z: 130 }, PALETTE.block),

  // Hazard patch. Flat and drivable, and DAMAGING while you are on it
  // (DESIGN.md §10.3) — which is why it is called out rather than being just
  // another block. Kept clear of the spawn ring.
  // Moved in from (80..100): at the smaller duel spawn radius the old patch
  // overlapped the 8-point spawn ring, which the "no spawn on a hazard" test
  // caught. A hazard under a spawn is a crew damaged on arrival.
  { ...box({ x: 40, y: 0, z: 90 }, { x: 60, y: 0.06, z: 110 }, PALETTE.hazard), hazard: true },

  // ---- the far zones (M11) ---------------------------------------------
  // Everything above sits within ~200 m of the centre. These carry the map out
  // toward the 360 m spawn ring, and their CHARACTER is the zoning: dunes have
  // launch ramps, the scrapyard is dense cover, the lakebed is open with a
  // second hazard. Authored inside one quadrant, so all four are identical.
  // Corners are kept inside ~320 m so the spawn ring stays clear.

  // Dunes: ramps and low cover, room to run.
  ramp({ x: 150, y: 0, z: 60 }, { x: 166, y: 3.6, z: 76 }, 'z', 3.6, 0, PALETTE.ramp),
  box({ x: 190, y: 0, z: 110 }, { x: 214, y: 4, z: 134 }, PALETTE.block),
  box({ x: 130, y: 0, z: 200 }, { x: 154, y: 4, z: 224 }, PALETTE.block),

  // The stadium edge: one block just inside the barrier. (The old scrapyard,
  // lakebed hazard and their outer blocks lay beyond STADIUM_HALF and went
  // with it — see the barrier in SOLIDS.)
  box({ x: 210, y: 0, z: 190 }, { x: 232, y: 5, z: 212 }, PALETTE.block),

  // ---- authored pass (M12): verticality, landmarks, roads ----------------
  // The map so far is cover at ground level. This adds the two things it was
  // missing: somewhere to be TALL, and a route to follow.

  // The mesa: the map's one piece of real high ground. A flat plateau with a
  // ramp on two sides, so taking the top is a position rather than a dead end.
  // Drivable on purpose — high ground a car can reach is a fight over it. It
  // sits in the open pocket between the inner ramps and the dunes, clear of the
  // 140 m duel spawn ring.
  box({ x: 150, y: 0, z: 20 }, { x: 188, y: 4.2, z: 56 }, PALETTE.plateau),
  ramp({ x: 134, y: 0, z: 26 }, { x: 150, y: 4.2, z: 46 }, 'x', 0, 4.2, PALETTE.ramp),
  ramp({ x: 188, y: 0, z: 26 }, { x: 204, y: 4.2, z: 46 }, 'x', 4.2, 0, PALETTE.ramp),


  // Roads. Authored as ground strips ALONG THE AXES, so replicating the
  // quadrant builds a square ring road and four cardinal spokes. They are
  // drivable and non-blocking — a route and a sense of place, not obstacles —
  // and sit 11 mm above the ring so the ground query still prefers them.
  { ...box({ x: 30, y: -4, z: -6 }, { x: 120, y: 0.05, z: 6 }, PALETTE.road), ground: true },

  // A checkpoint on each spoke road (arena dressing): two staggered lines of
  // concrete road barriers make a chicane across the 12 m road — weave through
  // it, or go round on the dirt — and a nest of barrels, tyres and crates sits
  // beside it. Low (0.85 m) cover: it hides a car's wheels, not its hull.
  { ...box({ x: 88, y: 0, z: -6 }, { x: 88.7, y: 0.85, z: -1.4 }, PALETTE.block), prop: 'barriers' },
  { ...box({ x: 97, y: 0, z: 1.4 }, { x: 97.7, y: 0.85, z: 6 }, PALETTE.block), prop: 'barriers' },
  { ...box({ x: 91, y: 0, z: 8.5 }, { x: 95, y: 1.2, z: 11.5 }, PALETTE.block), prop: 'nest' },
  { ...box({ x: 120, y: -4, z: -6 }, { x: STADIUM_HALF, y: 0.05, z: 6 }, PALETTE.road), ground: true },
];

/** A square ground ring, tinted by zone. `half` is its half-extent. */
const groundRing = (half: number, top: number, color: number): Solid => ({
  ...box({ x: -half, y: -4, z: -half }, { x: half, y: top, z: half }, color),
  ground: true,
});

export const SOLIDS: Solid[] = [
  // ---- ground: nested zone rings (M11) ----------------------------------
  // Each ring sits a few MILLIMETRES higher than the one outside it, so the
  // innermost wins the ground query without z-fighting against its neighbour.
  // The steps are far below the car's step height, so driving never notices.
  groundRing(100, 0.04, PALETTE.zoneCentre),
  groundRing(200, 0.033, PALETTE.zoneDunes),
  groundRing(280, 0.026, PALETTE.zoneScrapyard),
  groundRing(340, 0.019, PALETTE.zoneLakebed),
  groundRing(ARENA_HALF + 12, 0.012, PALETTE.zoneRim),

  // ---- perimeter walls --------------------------------------------------
  // These MUST overlap at the corners. Meeting edge to edge left an unblocked
  // diagonal gap at each corner that a car could drive straight through.
  box({ x: -ARENA_HALF - 4, y: 0, z: -ARENA_HALF - 4 }, { x: ARENA_HALF + 4, y: 16, z: -ARENA_HALF }, PALETTE.wall),
  box({ x: -ARENA_HALF - 4, y: 0, z: ARENA_HALF }, { x: ARENA_HALF + 4, y: 16, z: ARENA_HALF + 4 }, PALETTE.wall),
  box({ x: -ARENA_HALF - 4, y: 0, z: -ARENA_HALF - 4 }, { x: -ARENA_HALF, y: 16, z: ARENA_HALF + 4 }, PALETTE.wall),
  box({ x: ARENA_HALF, y: 0, z: -ARENA_HALF - 4 }, { x: ARENA_HALF + 4, y: 16, z: ARENA_HALF + 4 }, PALETTE.wall),

  // ---- the stadium barrier ----------------------------------------------
  // The playable arena is the stadium floor inside this concrete ring; the
  // closing zone starts inside it (ZONE.startRadius 210 m < STADIUM_HALF), and
  // the stands are drawn outside it (client/buildStadium.ts). Overlapping at the
  // corners for the same reason as the perimeter walls.
  box({ x: -STADIUM_HALF - 1.5, y: 0, z: -STADIUM_HALF - 1.5 }, { x: STADIUM_HALF + 1.5, y: STADIUM_WALL, z: -STADIUM_HALF }, PALETTE.wall),
  box({ x: -STADIUM_HALF - 1.5, y: 0, z: STADIUM_HALF }, { x: STADIUM_HALF + 1.5, y: STADIUM_WALL, z: STADIUM_HALF + 1.5 }, PALETTE.wall),
  box({ x: -STADIUM_HALF - 1.5, y: 0, z: -STADIUM_HALF - 1.5 }, { x: -STADIUM_HALF, y: STADIUM_WALL, z: STADIUM_HALF + 1.5 }, PALETTE.wall),
  box({ x: STADIUM_HALF, y: 0, z: -STADIUM_HALF - 1.5 }, { x: STADIUM_HALF + 1.5, y: STADIUM_WALL, z: STADIUM_HALF + 1.5 }, PALETTE.wall),

  // ---- centre: the contested objective ----------------------------------
  // Centred and square, so it is already symmetric without replication.
  box({ x: -11, y: 0, z: -11 }, { x: 11, y: 3.4, z: 11 }, PALETTE.pad),

  // ---- the replicated quadrants -----------------------------------------
  ...repeat4(WEDGE),
];

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
    return { x, y: 2, z, yaw: Math.atan2(x, z) };
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
 * Repair crate positions: one per quadrant, plus one contested at the centre
 * (DESIGN.md §11 — "scattered + contested central").
 *
 * Rotations of a single authored point, like the arena itself, so they cannot
 * be accidentally placed asymmetrically.
 */
export const REPAIR_CRATES: ReadonlyArray<{ x: number; z: number }> = (() => {
  const out: Array<{ x: number; z: number }> = [];
  // Scaled out with the map (M11): ~232 m from the centre, between the dunes and
  // the scrapyard, so a crew has to leave the middle to resupply.
  let point = { x: 100, z: 210 };
  for (let quarter = 0; quarter < 4; quarter++) {
    out.push({ x: point.x, z: point.z });
    point = { x: point.z, z: -point.x };
  }
  out.push({ x: 0, z: 0 });
  return out;
})();

/**
 * Hazard damage per second at a world point, or 0 on clear ground.
 *
 * Tests the vehicle's centre against the footprint. A graded hazard ("you are
 * half on it") would be nicer and is not worth the ambiguity: you are either in
 * the bad ground or you are not, and the player must be able to tell.
 */
export function hazardAt(x: number, z: number): number {
  for (let i = 0; i < SOLIDS.length; i++) {
    const solid = SOLIDS[i];
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
  for (let i = 0; i < SOLIDS.length; i++) {
    const top = surfaceTopAt(SOLIDS[i], x, z);
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
  let nearest: number | null = null;

  for (let i = 0; i < SOLIDS.length; i++) {
    const s = SOLIDS[i];
    let tMin = 0;
    let tMax = maxDistance;
    let hit = true;

    // Slab test, one axis at a time.
    const axes: Array<[number, number, number, number, number]> = [
      [ox, dx, s.min.x, s.max.x, 0],
      [oy, dy, s.min.y, s.max.y, 1],
      [oz, dz, s.min.z, s.max.z, 2],
    ];

    for (const [origin, direction, lo, hi] of axes) {
      if (Math.abs(direction) < 1e-9) {
        if (origin < lo || origin > hi) {
          hit = false;
          break;
        }
        continue;
      }
      let t1 = (lo - origin) / direction;
      let t2 = (hi - origin) / direction;
      if (t1 > t2) [t1, t2] = [t2, t1];
      if (t1 > tMin) tMin = t1;
      if (t2 < tMax) tMax = t2;
      if (tMin > tMax) {
        hit = false;
        break;
      }
    }

    if (hit && tMin >= 0 && (nearest === null || tMin < nearest)) nearest = tMin;
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
