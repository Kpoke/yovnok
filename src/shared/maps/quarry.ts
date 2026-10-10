/**
 * INDUSTRIAL QUARRY — an open pit by day. Three levels: the pit floor, a
 * middle bench (where everyone spawns) and the high rim, joined by haul-road
 * ramps. Machinery and spoil heaps on the floor, gravel piles on the bench.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { CENTRE_PAD, CENTRE_RAMP, hazard } from './common';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, strip, zoneGround } from './kit';
import type { ArenaMap } from './types';

/** Bench heights and where each starts (half-extent of its inner edge). */
const BENCH1 = 5;
const BENCH1_FROM = 100;
const BENCH2 = 10;
const BENCH2_FROM = 190;
const S = STADIUM_HALF;

const WEDGE: Solid[] = [
  CENTRE_RAMP,
  // The benches: square rings, one quarter each (the quarter turns tile them).
  box({ x: BENCH1_FROM, y: 0, z: -BENCH1_FROM }, { x: BENCH2_FROM, y: BENCH1, z: BENCH2_FROM }, PALETTE.plateau),
  box({ x: BENCH2_FROM, y: 0, z: -BENCH2_FROM }, { x: S, y: BENCH2, z: S }, PALETTE.plateau),
  // Haul roads up: pit floor → bench (on the spoke), bench → rim (off it).
  ramp({ x: 72, y: 0, z: -7 }, { x: BENCH1_FROM, y: BENCH1, z: 7 }, 'x', 0, BENCH1, PALETTE.ramp),
  ramp({ x: 72, y: 0, z: 60 }, { x: BENCH1_FROM, y: BENCH1, z: 74 }, 'x', 0, BENCH1, PALETTE.ramp),
  ramp({ x: 160, y: BENCH1, z: 50 }, { x: BENCH2_FROM, y: BENCH2, z: 66 }, 'x', BENCH1, BENCH2, PALETTE.ramp),
  // Haul road surface along the spoke on each level.
  strip({ x: 14, y: -4, z: -7 }, { x: 72, y: 0.05, z: 7 }, PALETTE.road),
  strip({ x: BENCH1_FROM, y: BENCH1 - 1, z: -7 }, { x: BENCH2_FROM, y: BENCH1 + 0.05, z: 7 }, PALETTE.road),
  strip({ x: BENCH2_FROM, y: BENCH2 - 1, z: -7 }, { x: S, y: BENCH2 + 0.05, z: 7 }, PALETTE.road),
  // Pit floor: the crusher, spoil heaps, conveyor legs, a sludge pond.
  box({ x: 30, y: 0, z: 40 }, { x: 46, y: 9, z: 56 }, PALETTE.landmark),
  box({ x: 60, y: 0, z: 20 }, { x: 80, y: 6, z: 32 }, PALETTE.rock),
  box({ x: 20, y: 0, z: 70 }, { x: 21.5, y: 8, z: 71.5 }, PALETTE.landmark),
  box({ x: 20, y: 0, z: 88 }, { x: 21.5, y: 8, z: 89.5 }, PALETTE.landmark),
  hazard(box({ x: 50, y: 0, z: 80 }, { x: 70, y: 0.06, z: 96 }, PALETTE.hazard)),
  // On the bench: gravel piles and a parked dump truck.
  box({ x: 120, y: BENCH1, z: 120 }, { x: 136, y: BENCH1 + 4, z: 136 }, PALETTE.rock),
  box({ x: 140, y: BENCH1, z: 20 }, { x: 150, y: BENCH1 + 4.5, z: 28 }, PALETTE.landmark),
  box({ x: 118, y: BENCH1, z: 170 }, { x: 130, y: BENCH1 + 3, z: 182 }, PALETTE.rock),
];

export const QUARRY: ArenaMap = {
  id: 'quarry',
  name: 'Quarry',
  blurb: 'Day · an open pit, three levels of haul roads',
  lighting: 'clearDay',
  grip: 0.95,
  solids: [...zoneGround(), ...boundary(), CENTRE_PAD, ...repeat4(WEDGE)],
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
