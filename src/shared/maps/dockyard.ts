/**
 * RAINY DOCKYARD — a container terminal at night, in the rain. Container
 * stacks make a maze of lanes; warehouses and gantry-crane legs block the
 * long lines; a loading dock is the high ground; an oil spill burns.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { CENTRE_PAD, CENTRE_RAMP, hazard } from './common';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, strip, zoneGround } from './kit';
import type { ArenaMap } from './types';

/** Container heights: one, two and three high. */
const C1 = 2.6;
const C2 = 5.2;
const C3 = 7.8;

const WEDGE: Solid[] = [
  CENTRE_RAMP,
  // Haul lanes along each spoke.
  strip({ x: 14, y: -4, z: -8 }, { x: STADIUM_HALF, y: 0.05, z: 8 }, PALETTE.road),
  // Container rows: lanes between them, steps of height to fight over.
  box({ x: 30, y: 0, z: 30 }, { x: 90, y: C2, z: 35 }, PALETTE.block),
  box({ x: 40, y: 0, z: 54 }, { x: 110, y: C1, z: 59 }, PALETTE.block),
  box({ x: 24, y: 0, z: 78 }, { x: 74, y: C3, z: 83 }, PALETTE.block),
  box({ x: 130, y: 0, z: 20 }, { x: 135, y: C2, z: 70 }, PALETTE.block),
  box({ x: 104, y: 0, z: 100 }, { x: 109, y: C2, z: 140 }, PALETTE.block),
  box({ x: 150, y: 0, z: 196 }, { x: 200, y: C1, z: 201 }, PALETTE.block),
  // Warehouses.
  box({ x: 150, y: 0, z: 120 }, { x: 190, y: 10, z: 150 }, PALETTE.building),
  box({ x: 30, y: 0, z: 160 }, { x: 60, y: 10, z: 196 }, PALETTE.building),
  // A gantry crane's four legs (its girder is overhead, scenery only).
  box({ x: 196, y: 0, z: 40 }, { x: 198.5, y: 6, z: 42.5 }, PALETTE.landmark),
  box({ x: 196, y: 0, z: 70 }, { x: 198.5, y: 6, z: 72.5 }, PALETTE.landmark),
  box({ x: 226, y: 0, z: 40 }, { x: 228.5, y: 6, z: 42.5 }, PALETTE.landmark),
  box({ x: 226, y: 0, z: 70 }, { x: 228.5, y: 6, z: 72.5 }, PALETTE.landmark),
  // The loading dock: a raised quay with a ramp up.
  box({ x: 56, y: 0, z: 190 }, { x: 92, y: 2.2, z: 226 }, PALETTE.plateau),
  ramp({ x: 60, y: 0, z: 176 }, { x: 88, y: 2.2, z: 190 }, 'z', 0, 2.2, PALETTE.ramp),
  // An oil spill: slick, and it burns.
  hazard(box({ x: 112, y: 0, z: 160 }, { x: 126, y: 0.06, z: 174 }, PALETTE.hazard)),
];

export const DOCKYARD: ArenaMap = {
  id: 'dockyard',
  name: 'Rainy Dockyard',
  blurb: 'Night, rain · a maze of container lanes',
  lighting: 'rainyNight',
  // Wet tarmac.
  grip: 0.9,
  solids: [...zoneGround(), ...boundary(), CENTRE_PAD, ...repeat4(WEDGE)],
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
