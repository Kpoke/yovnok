/**
 * PINE FOREST — a logging camp in a misty forest. The trees are real
 * obstacles: weave between them or use the tracks. A clearing in the middle
 * (the camp), a rocky outcrop to climb, felled logs as low cover, and a bog.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { CENTRE_PAD, CENTRE_RAMP, hazard } from './common';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, strip, zoneGround } from './kit';
import type { ArenaMap } from './types';

/** Trunk footprint and height (the canopy is scenery). */
const TRUNK = 1.3;
const TRUNK_HEIGHT = 9;

/** The authored features of one quadrant (trees are placed around them). */
const FEATURES: Solid[] = [
  CENTRE_RAMP,
  // Tracks along each spoke, and a ring track.
  strip({ x: 14, y: -4, z: -6 }, { x: STADIUM_HALF, y: 0.05, z: 6 }, PALETTE.road),
  strip({ x: 114, y: -4, z: -120 }, { x: 126, y: 0.045, z: 126 }, PALETTE.road),
  // The camp: a sawmill shed and log stacks.
  box({ x: 20, y: 0, z: 22 }, { x: 34, y: 7, z: 34 }, PALETTE.building),
  box({ x: 40, y: 0, z: 10 }, { x: 52, y: 2.5, z: 15 }, PALETTE.log),
  // The outcrop: drivable rock with a ramp each way.
  box({ x: 60, y: 0, z: 100 }, { x: 90, y: 5, z: 124 }, PALETTE.plateau),
  ramp({ x: 44, y: 0, z: 104 }, { x: 60, y: 5, z: 120 }, 'x', 0, 5, PALETTE.ramp),
  ramp({ x: 90, y: 0, z: 104 }, { x: 106, y: 5, z: 120 }, 'x', 5, 0, PALETTE.ramp),
  // Boulders.
  box({ x: 150, y: 0, z: 40 }, { x: 157, y: 3, z: 47 }, PALETTE.rock),
  box({ x: 40, y: 0, z: 150 }, { x: 47, y: 3, z: 157 }, PALETTE.rock),
  box({ x: 190, y: 0, z: 160 }, { x: 197, y: 3, z: 167 }, PALETTE.rock),
  // Felled logs: low cover.
  box({ x: 70, y: 0, z: 40 }, { x: 82, y: 1.1, z: 41.3 }, PALETTE.log),
  box({ x: 160, y: 0, z: 110 }, { x: 161.3, y: 1.1, z: 122 }, PALETTE.log),
  box({ x: 100, y: 0, z: 200 }, { x: 112, y: 1.1, z: 201.3 }, PALETTE.log),
  box({ x: 205, y: 0, z: 70 }, { x: 206.3, y: 1.1, z: 82 }, PALETTE.log),
  // The bog.
  hazard(box({ x: 140, y: 0, z: 140 }, { x: 160, y: 0.06, z: 160 }, PALETTE.hazard)),
];

/** The 12 solo spawn points (r 180, every 30°): trees keep clear of them. */
const SPAWN_POINTS = Array.from({ length: 12 }, (_, i) => {
  const a = (i / 12) * Math.PI * 2;
  return { x: Math.sin(a) * 180, z: Math.cos(a) * 180 };
});

/**
 * Trees for one quadrant: a seeded scatter, thinner near the middle, kept off
 * the tracks, the spawns, the crates and every feature. Deterministic, so the
 * server and every page grow the same forest.
 */
function trees(): Solid[] {
  let seed = 1234;
  const rand = (): number => (seed = (seed * 16807) % 2147483647) / 2147483647;
  const placed: Array<{ x: number; z: number }> = [];
  const out: Solid[] = [];
  const crates = [...points4(100, 210)];
  const clear = (x: number, z: number): boolean => {
    const r = Math.hypot(x, z);
    if (r < 48) return false; // the camp clearing
    if (Math.abs(x) < 12 || Math.abs(z) < 12) return false; // spoke tracks (all four)
    if (Math.abs(Math.abs(x) - 120) < 11 || Math.abs(Math.abs(z) - 120) < 11) return false; // ring track
    if (Math.max(Math.abs(x), Math.abs(z)) > STADIUM_HALF - 6) return false;
    for (const s of SPAWN_POINTS) if (Math.hypot(x - s.x, z - s.z) < 18) return false;
    for (const c of crates) if (Math.hypot(x - c.x, z - c.z) < 12) return false;
    for (const f of FEATURES) {
      if (f.ground && !f.hazard) continue;
      if (x > f.min.x - 7 && x < f.max.x + 7 && z > f.min.z - 7 && z < f.max.z + 7) return false;
    }
    for (const p of placed) if (Math.hypot(x - p.x, z - p.z) < 10) return false;
    return true;
  };
  for (let attempt = 0; attempt < 4000 && out.length < 60; attempt++) {
    const x = 12 + rand() * (STADIUM_HALF - 12);
    const z = -STADIUM_HALF + 12 + rand() * (2 * STADIUM_HALF - 24);
    // One quadrant only: the wedge x > |z| (its quarter turns fill the rest).
    if (!(x > Math.abs(z))) continue;
    // Denser toward the edge.
    if (rand() > 0.35 + 0.65 * (Math.hypot(x, z) / STADIUM_HALF)) continue;
    if (!clear(x, z) || !clear(z, -x) || !clear(-x, -z) || !clear(-z, x)) continue;
    placed.push({ x, z }, { x: z, z: -x }, { x: -x, z: -z }, { x: -z, z: x });
    out.push(box({ x: x - TRUNK / 2, y: 0, z: z - TRUNK / 2 }, { x: x + TRUNK / 2, y: TRUNK_HEIGHT, z: z + TRUNK / 2 }, PALETTE.trunk));
  }
  return out;
}

export const FOREST: ArenaMap = {
  id: 'forest',
  name: 'Pine Forest',
  blurb: 'Misty morning · trees, tracks and a logging camp',
  lighting: 'mistyForest',
  // Forest floor: needles and soft earth.
  grip: 0.9,
  solids: [...zoneGround(), ...boundary(), CENTRE_PAD, ...repeat4([...FEATURES, ...trees()])],
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
