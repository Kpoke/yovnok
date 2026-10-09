/**
 * A fixed, map-independent line of fire for the end-to-end combat test.
 *
 * `combattest` runs against the real server on the real arena, so it used to
 * depend on the SPWNS it happened to be given. Growing the map moved the spawns
 * 148 m apart and put a cover block between two of them, and the test failed for
 * a reason that had nothing to do with combat.
 *
 * So the pair is pinned here instead, and `simcheck` asserts it is still clear.
 * When the arena is retuned (M7 will), simcheck fails with a clear message
 * rather than combattest failing with a mystery.
 */

export type TestPlacement = { x: number; z: number; yaw: number };

/** Facing +x (forward is `(-sin yaw, -cos yaw)`). */
const FACING_POSITIVE_X = -Math.PI / 2;
const FACING_NEGATIVE_X = Math.PI / 2;

export const COMBAT_TEST_CREWS: readonly TestPlacement[] = [
  // Shooter: a front-right gunner, so the target must be inside its arc.
  { x: -150, z: -150, yaw: FACING_POSITIVE_X },
  // Target: 60 m straight ahead of the shooter, in the open, and FACING the
  // shooter. Its orientation matters: a shot at its engine has to arrive at its
  // front, because a part buried behind the whole car is deliberately not
  // reachable (`COMPONENT.hitDepthTolerance`).
  { x: -90, z: -150, yaw: FACING_NEGATIVE_X },
];

/** The `DEV_PLACE` string the server understands. */
export function combatTestPlacement(crews: readonly TestPlacement[] = COMBAT_TEST_CREWS): string {
  return crews.map((c, i) => `${i}:${c.x},${c.z},${c.yaw}`).join('|');
}
