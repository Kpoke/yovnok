/**
 * Where vehicle parts come from.
 *
 * The rig builds parts synchronously every time a car appears, so anything
 * loaded from disk or network has to be warm first. That is what `prepare` is
 * for: enumerate every part that could be needed, load them once, and then
 * `create` is a cheap synchronous clone.
 *
 * Two implementations exist: procedural (this file) and glTF (`gltfPartLibrary`).
 * Swapping them changes no other code — that is the whole point of the seam, and
 * it is what keeps the door open to authored or generated assets.
 */

import { seatsFor } from '../../shared/crews';
import { VEHICLE_CLASSES, type VehicleClassId } from '../../shared/config';
import { ROOFS, WHEELS } from '../../shared/cosmetics';
import {
  buildChassis,
  buildEngine,
  buildRoofKit,
  buildSeat,
  buildTurret,
  buildGun,
  buildWheel,
  type PartBuild,
  type SeatSide,
  type VehicleMaterials,
} from './parts';

export type PartRequest =
  | { kind: 'chassis'; cls: VehicleClassId }
  | { kind: 'engine'; cls: VehicleClassId }
  | { kind: 'wheel'; cls: VehicleClassId; style?: number }
  | { kind: 'seat'; cls: VehicleClassId; side: SeatSide; armed: boolean }
  /** Cosmetic roof attachment (M12). `style` indexes `shared/cosmetics.ROOFS`. */
  | { kind: 'roof'; cls: VehicleClassId; style?: number }
  /** A car-mounted roof weapon station (one per class with such a weapon). */
  | { kind: 'turret'; cls: VehicleClassId }
  /** A single car-mounted gun, e.g. each of the twin bumper guns. */
  | { kind: 'gun'; cls: VehicleClassId };

export interface PartLibrary {
  readonly name: string;
  /** Warm the library up. No-op for procedural parts. */
  prepare(requests: PartRequest[]): Promise<void>;
  create(request: PartRequest, materials: VehicleMaterials): PartBuild;
  dispose(): void;
}

/** Stable key for a request, used for manifest lookup and caching. */
export function partKey(request: PartRequest): string {
  switch (request.kind) {
    case 'seat':
      return `seat.${request.side}${request.armed ? '.armed' : ''}`;
    case 'wheel':
      return `wheel.${request.style ?? 0}`;
    case 'roof':
      return `roof.${request.style ?? 0}`;
    default:
      return request.kind;
  }
}

/**
 * Every part that can ever be requested, for both classes.
 *
 * The seat layouts here mirror `seatLayout` in `buildVehicle`; a mismatch would
 * mean a part silently falls back at runtime, so the validator cross-checks the
 * socket list rather than trusting this by eye.
 */
export function allPartRequests(): PartRequest[] {
  const requests: PartRequest[] = [];
  for (const cls of Object.keys(VEHICLE_CLASSES) as VehicleClassId[]) {
    requests.push({ kind: 'chassis', cls }, { kind: 'engine', cls });
    // Every cosmetic variant is a distinct part, so the asset warm-up can see
    // them all: a player wearing wheel style 3 must not pop in a plain wheel.
    WHEELS.forEach((_, style) => requests.push({ kind: 'wheel', cls, style }));
    ROOFS.forEach((_, style) => requests.push({ kind: 'roof', cls, style }));
    // One request per KIND of mounted weapon part the class carries.
    const kinds = new Set(seatsFor(cls).flatMap((seat) => (seat.mounted ?? []).map((m) => m.part)));
    for (const kind of kinds) requests.push({ kind, cls });
    requests.push(
      { kind: 'seat', cls, side: 'left', armed: false },
      { kind: 'seat', cls, side: 'right', armed: true },
      { kind: 'seat', cls, side: 'left', armed: true },
    );
  }
  return requests;
}

/** Parts built from code. Low-poly and stylised, per DESIGN.md §9. */
export const proceduralPartLibrary: PartLibrary = {
  name: 'procedural',
  prepare: async () => {},
  create(request, materials) {
    const spec = VEHICLE_CLASSES[request.cls];
    switch (request.kind) {
      case 'chassis':
        return buildChassis(spec, materials);
      case 'engine':
        return buildEngine(spec, materials);
      case 'wheel':
        return buildWheel(spec, materials, WHEELS[request.style ?? 0]);
      case 'seat':
        return buildSeat(request.side, request.armed, materials);
      case 'roof':
        return buildRoofKit(spec, ROOFS[request.style ?? 0].kind, materials);
      case 'turret':
        return buildTurret(materials);
      case 'gun':
        return buildGun(materials);
    }
  },
  dispose() {},
};
