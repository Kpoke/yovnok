/**
 * DUSK CANYON — a dry wash at sunset. Tall sandstone mesas break the sight
 * lines, a drivable rock shelf is the high ground, boulders give low cover, the
 * dry riverbed crosses the map, and a tar pit punishes a bad line.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { CENTRE_PAD, CENTRE_RAMP, hazard } from './common';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, strip, zoneGround } from './kit';
import type { ArenaMap } from './types';

const WEDGE: Solid[] = [
  CENTRE_RAMP,
  // The riverbed: a 20 m dry wash along each spoke.
  strip({ x: 14, y: -4, z: -10 }, { x: STADIUM_HALF, y: 0.05, z: 10 }, PALETTE.road),
  // Mesas: tall, sheer, not drivable — the map's sight-line breakers.
  box({ x: 40, y: 0, z: 66 }, { x: 62, y: 16, z: 92 }, PALETTE.rock),
  box({ x: 112, y: 0, z: 26 }, { x: 140, y: 20, z: 52 }, PALETTE.rock),
  box({ x: 124, y: 0, z: 136 }, { x: 152, y: 14, z: 160 }, PALETTE.rock),
  // The gate: two pillars either side of the riverbed.
  box({ x: 146, y: 0, z: 12 }, { x: 154, y: 12, z: 20 }, PALETTE.rock),
  box({ x: 146, y: 0, z: -20 }, { x: 154, y: 12, z: -12 }, PALETTE.rock),
  // The shelf: drivable high ground with a ramp at each end.
  box({ x: 66, y: 0, z: 108 }, { x: 104, y: 6, z: 136 }, PALETTE.plateau),
  ramp({ x: 50, y: 0, z: 112 }, { x: 66, y: 6, z: 132 }, 'x', 0, 6, PALETTE.ramp),
  ramp({ x: 104, y: 0, z: 112 }, { x: 120, y: 6, z: 132 }, 'x', 6, 0, PALETTE.ramp),
  // Boulders: low cover, hides a car's wheels and doors.
  box({ x: 24, y: 0, z: 40 }, { x: 30, y: 2.5, z: 47 }, PALETTE.rock),
  box({ x: 78, y: 0, z: 30 }, { x: 85, y: 2.5, z: 36 }, PALETTE.rock),
  box({ x: 170, y: 0, z: 40 }, { x: 178, y: 2.8, z: 48 }, PALETTE.rock),
  box({ x: 200, y: 0, z: 120 }, { x: 208, y: 2.8, z: 128 }, PALETTE.rock),
  box({ x: 30, y: 0, z: 120 }, { x: 37, y: 2.5, z: 127 }, PALETTE.rock),
  box({ x: 60, y: 0, z: 190 }, { x: 66, y: 2.5, z: 197 }, PALETTE.rock),
  // A launch ramp out of the wash.
  ramp({ x: 196, y: 0, z: 62 }, { x: 212, y: 3.6, z: 78 }, 'x', 0, 3.6, PALETTE.ramp),
  // Tar pit: drivable, and it burns.
  hazard(box({ x: 44, y: 0, z: 140 }, { x: 60, y: 0.06, z: 156 }, PALETTE.hazard)),
];

export const CANYON: ArenaMap = {
  id: 'canyon',
  name: 'Dusk Canyon',
  blurb: 'Sunset · mesas, a dry wash and a rock shelf',
  lighting: 'duskCanyon',
  grip: 0.95,
  solids: [...zoneGround(), ...boundary(), CENTRE_PAD, ...repeat4(WEDGE)],
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
