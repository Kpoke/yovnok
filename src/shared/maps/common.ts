/** Pieces several maps share. */

import type { Solid } from '../arena';
import { PALETTE } from '../config';
import { box, ramp } from './kit';

/**
 * The contested centre: a square platform with a ramp up from each side
 * (the ramp is written once; `repeat4` makes the other three).
 */
export const CENTRE_PAD: Solid = box({ x: -11, y: 0, z: -11 }, { x: 11, y: 3.4, z: 11 }, PALETTE.pad);
export const CENTRE_RAMP: Solid = ramp({ x: -6, y: 0, z: 11 }, { x: 6, y: 3.4, z: 23 }, 'z', 3.4, 0, PALETTE.ramp);

/** Mark a solid as damaging ground. */
export const hazard = (s: Solid): Solid => ({ ...s, hazard: true });
/** Mark a ground strip as ice. */
export const ice = (s: Solid): Solid => ({ ...s, ice: true });
