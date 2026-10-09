/**
 * Repair crates: the eligibility rule (DESIGN.md §4.3).
 *
 * Pure and shared, so the rule that decides whether you are repairing can be
 * tested directly instead of inferred from watching a health bar. The server is
 * the only caller — clients are told the outcome — but keeping it here means it
 * lives next to the numbers it uses.
 */

import { REPAIR } from './config';

export type RepairContext = {
  /** Horizontal distance from the crate, in metres. */
  distance: number;
  /** Speed along the ground, in m/s. */
  speed: number;
};

/**
 * Whether a vehicle is close enough AND still enough to repair.
 *
 * "Hold position" is the load-bearing part. A drive-by that topped you up would
 * remove the entire risk of repairing, and repair is meant to be the most
 * exposed thing a crew can choose to do.
 */
export function canRepair({ distance, speed }: RepairContext): boolean {
  return distance <= REPAIR.radius && Math.abs(speed) <= REPAIR.holdSpeed;
}
