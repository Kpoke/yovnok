/**
 * SNOWBOUND BASE — a military airfield under snow, overcast. Runways cross the
 * map for flat-out runs; hangars and fuel tanks block; bunkers have snow banked
 * over them to drive across; frozen ponds have almost no grip.
 */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { CENTRE_PAD, CENTRE_RAMP, ice } from './common';
import { box, boundary, points4, ramp, repeat4, STADIUM_HALF, strip, zoneGround } from './kit';
import type { ArenaMap } from './types';

const WEDGE: Solid[] = [
  CENTRE_RAMP,
  // Runways: 30 m wide, along each spoke.
  strip({ x: 14, y: -4, z: -15 }, { x: STADIUM_HALF, y: 0.05, z: 15 }, PALETTE.road),
  // Hangars.
  box({ x: 60, y: 0, z: 40 }, { x: 96, y: 12, z: 70 }, PALETTE.building),
  box({ x: 140, y: 0, z: 150 }, { x: 176, y: 12, z: 186 }, PALETTE.building),
  // Radar building.
  box({ x: 90, y: 0, z: 178 }, { x: 110, y: 8, z: 194 }, PALETTE.building),
  // Bunkers with snow banked up both sides: drive over them.
  box({ x: 30, y: 0, z: 100 }, { x: 44, y: 2.6, z: 112 }, PALETTE.block),
  ramp({ x: 30, y: 0, z: 88 }, { x: 44, y: 2.6, z: 100 }, 'z', 0, 2.6, PALETTE.ramp),
  ramp({ x: 30, y: 0, z: 112 }, { x: 44, y: 2.6, z: 124 }, 'z', 2.6, 0, PALETTE.ramp),
  box({ x: 190, y: 0, z: 40 }, { x: 204, y: 2.6, z: 54 }, PALETTE.block),
  ramp({ x: 176, y: 0, z: 40 }, { x: 190, y: 2.6, z: 54 }, 'x', 0, 2.6, PALETTE.ramp),
  ramp({ x: 204, y: 0, z: 40 }, { x: 218, y: 2.6, z: 54 }, 'x', 2.6, 0, PALETTE.ramp),
  // Fuel tanks.
  box({ x: 110, y: 0, z: 100 }, { x: 120, y: 6, z: 110 }, PALETTE.landmark),
  box({ x: 124, y: 0, z: 100 }, { x: 134, y: 6, z: 110 }, PALETTE.landmark),
  // Watchtower in each corner.
  box({ x: 210, y: 0, z: 210 }, { x: 213, y: 10, z: 213 }, PALETTE.landmark),
  // Frozen ponds: drivable, nearly no grip.
  ice(strip({ x: 120, y: -4, z: 30 }, { x: 170, y: 0.06, z: 60 }, PALETTE.ice)),
  ice(strip({ x: 20, y: -4, z: 190 }, { x: 56, y: 0.06, z: 226 }, PALETTE.ice)),
];

export const SNOWBASE: ArenaMap = {
  id: 'snowbase',
  name: 'Snowbound Base',
  blurb: 'Overcast · runways, hangars and ice',
  lighting: 'overcastSnow',
  // Packed snow.
  grip: 0.82,
  solids: [...zoneGround(), ...boundary(), CENTRE_PAD, ...repeat4(WEDGE)],
  crates: [...points4(100, 210), { x: 0, z: 0 }],
};
