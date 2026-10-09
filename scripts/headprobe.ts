/**
 * Throwaway diagnostic: can a crew member ever be hit?
 *
 * `resolveHitscan` tests a head with `maxDistance` equal to the hull's entry
 * distance, so a head that sits INSIDE the hull can never be reached. This
 * reports whether that is the case, rather than leaving it as a suspicion.
 *
 *   npx tsx scripts/headprobe.ts
 */

import { resolveHitscan, seatPointWorld, type CombatVehicle } from '../src/shared/combat';
import { EYE_OFFSET, HEAD_OFFSET, WINDOW_EYE_OFFSET, seatById, seatsFor } from '../src/shared/crews';
import { VEHICLE_CLASSES } from '../src/shared/config';

const AIR = 300; // above every arena solid

for (const cls of ['coupe', 'suv'] as const) {
  const spec = VEHICLE_CLASSES[cls];
  const state = {
    spec,
    pos: { x: 0, y: AIR, z: 0 },
    vel: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    roll: 0,
  } as unknown as CombatVehicle['state'];
  const target: CombatVehicle = { id: 1, cls, state, hull: 1200, history: [] };

  for (const seat of seatsFor(cls)) {
    if (!seat.arc) continue;
    const member = { id: 99, crew: 1, seat: seat.id, hp: 100, alive: true };

    for (const [label, off] of [
      ['cabin ', EYE_OFFSET],
      ['head  ', HEAD_OFFSET[seat.side]],
      ['camera', WINDOW_EYE_OFFSET[seat.side]],
    ] as const) {
      const head = seatPointWorld(state, seat, off);
      // Fire at the head from directly out to the car's right, level with it.
      const hit = resolveHitscan(
        [target],
        [member],
        -1,
        12,
        head.y,
        head.z,
        -1,
        0,
        0,
        220,
        0,
      );
      const insideHull = Math.abs(head.x) + 0.22 < spec.halfWidth;
      console.log(
        `${cls} ${seat.id.padEnd(16)} ${label} x=${head.x.toFixed(2)} ` +
          `${insideHull ? 'INSIDE hull' : 'outside   '} (hw ${spec.halfWidth}) -> ` +
          `memberHit=${hit.memberHit ?? 'none'}`,
      );
    }
  }
}
