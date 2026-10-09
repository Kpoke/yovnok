/**
 * Car-mounted weapons: the shared aiming and fire-rate rules.
 *
 *   npm run weapontest
 *
 * Pure checks on `aimMountedWeapon` and `scheduleShot`, which the server fires
 * with and the client predicts with — so a regression here would make tracers
 * lie or shots go somewhere other than the crosshair.
 */

import { aimMountedWeapon, relativeAim } from '../src/shared/combat';
import { VEHICLE_CLASSES } from '../src/shared/config';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  mountMuzzleLocal,
  seatsFor,
  SOLO_GUN_SCALE,
  SOLO_TURRET_SCALE,
  type MountedWeapon,
} from '../src/shared/crews';
import { createVehicle } from '../src/shared/vehicle';
import { scheduleShot } from '../src/shared/weapons';

let failures = 0;
const check = (name: string, ok: boolean, detail = ''): void => {
  console.log(`  [${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failures++;
};
const deg = (r: number): string => `${((r * 180) / Math.PI).toFixed(1)}°`;

const seat = seatsFor('solo').find((s) => s.mounted);
const mounted = seat?.mounted ?? [];
const mg = mounted.find((m) => m.trigger === 'primary') as MountedWeapon;
const rpg = mounted.find((m) => m.trigger === 'secondary') as MountedWeapon;

console.log('\n=== 1. the solo car carries two triggers ===');
check('primary is the twin machine gun', mg?.weapon === 'mg' && mg.mounts.length === 2);
check('secondary is the RPG', rpg?.weapon === 'rocket' && rpg.mounts.length === 1);

// A truck at the origin facing -Z (yaw 0).
const car = createVehicle(0, VEHICLE_CLASSES.solo.rideHeight, 0, 0, VEHICLE_CLASSES.solo);

console.log('\n=== 2. geometry conventions ===');
const ahead = relativeAim(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 0, z: -10 });
check('a point dead ahead is yaw 0, pitch 0', Math.abs(ahead.yaw) < 1e-9 && Math.abs(ahead.pitch) < 1e-9);
const left = relativeAim(0, { x: 0, y: 0, z: 0 }, { x: -10, y: 0, z: 0 });
check('a point to the left is +90° (vehicle convention)', Math.abs(left.yaw - Math.PI / 2) < 1e-9, deg(left.yaw));
const up = relativeAim(0, { x: 0, y: 0, z: 0 }, { x: 0, y: 10, z: -10 });
check('a point above is +pitch', Math.abs(up.pitch - Math.PI / 4) < 1e-9, deg(up.pitch));
const turned = mountMuzzleLocal({ pivot: [0, 0, 0], muzzle: [0, 0, -1] }, Math.PI / 2);
check('a gun turned +90° points its muzzle left (-X)', Math.abs(turned[0] + 1) < 1e-9 && Math.abs(turned[2]) < 1e-9);

console.log('\n=== 3. twin guns converge on the crosshair ===');
const target = { x: 3, y: 1.2, z: -40 };
for (let barrel = 0; barrel < 2; barrel++) {
  const shot = aimMountedWeapon(car, mg, barrel, target, { yaw: 0, pitch: 0 });
  // Follow the shot ray to the target's distance and measure the miss.
  const dist = Math.hypot(target.x - shot.muzzle.x, target.y - shot.muzzle.y, target.z - shot.muzzle.z);
  const yaw = car.yaw + shot.yaw;
  const end = {
    x: shot.muzzle.x - Math.sin(yaw) * Math.cos(shot.pitch) * dist,
    y: shot.muzzle.y + Math.sin(shot.pitch) * dist,
    z: shot.muzzle.z - Math.cos(yaw) * Math.cos(shot.pitch) * dist,
  };
  const miss = Math.hypot(end.x - target.x, end.y - target.y, end.z - target.z);
  check(`barrel ${barrel} (${barrel === 0 ? 'left' : 'right'}) lands on the target`, miss < 0.05, `miss ${miss.toFixed(3)} m`);
}
const l = aimMountedWeapon(car, mg, 0, target, { yaw: 0, pitch: 0 }).muzzle;
const r = aimMountedWeapon(car, mg, 1, target, { yaw: 0, pitch: 0 }).muzzle;
check('the two barrels fire from opposite fenders', l.x < -0.5 && r.x > 0.5, `x ${l.x.toFixed(2)} / ${r.x.toFixed(2)}`);

console.log('\n=== 4. each gun turns only as far as it physically can ===');
const side = { x: -40, y: 1, z: 0 }; // 90° to the left
const mgSide = aimMountedWeapon(car, mg, 0, side, { yaw: 0, pitch: 0 });
check('the machine guns stop at their ±20° limit', Math.abs(mgSide.yaw - mg.yawArc[1]) < 1e-6, deg(mgSide.yaw));
const rpgSide = aimMountedWeapon(car, rpg, 0, side, { yaw: 0, pitch: 0 });
check('the roof RPG reaches a target 90° to the side', Math.abs(rpgSide.yaw - Math.PI / 2) < 0.05, deg(rpgSide.yaw));
const behind = aimMountedWeapon(car, rpg, 0, { x: 0, y: 1, z: 40 }, { yaw: 0, pitch: 0 });
check('the RPG has a blind spot directly behind', Math.abs(Math.abs(behind.yaw) - Math.abs(rpg.yawArc[1])) < 1e-6, deg(behind.yaw));
const sky = aimMountedWeapon(car, mg, 0, { x: 0, y: 60, z: -20 }, { yaw: 0, pitch: 0 });
check('elevation is clamped too', Math.abs(sky.pitch - mg.pitchArc[1]) < 1e-6, deg(sky.pitch));
const bot = aimMountedWeapon(car, rpg, 0, null, { yaw: 0.4, pitch: 0.1 });
check('with no target (a bot), the given angles are used', Math.abs(bot.yaw - 0.4) < 1e-9 && Math.abs(bot.pitch - 0.1) < 1e-9);

console.log('\n=== 5. the fire schedule absorbs jitter but holds the rate ===');
const interval = 62.5; // 16 rounds/s
check('a shot exactly on time is accepted', scheduleShot(1000, 1000, interval, 0.5) !== null);
check('a shot bunched 20 ms early by jitter is accepted', scheduleShot(1000, 980, interval, 0.5) !== null);
check('a shot far too early is rejected', scheduleShot(1000, 900, interval, 0.5) === null);
// Hammer the trigger every 1 ms for a second: the accepted rate must not exceed the weapon's.
let due = 0;
let accepted = 0;
for (let t = 0; t < 1000; t++) {
  const next = scheduleShot(due, t, interval, 0.5);
  if (next !== null) {
    due = next;
    accepted++;
  }
}
check('spamming cannot beat the rate (≤ 16 + 1 in a second)', accepted <= 17, `${accepted} accepted`);

console.log('\n=== 6. the drawn parts match the muzzle maths ===');
// The brawler's gun and roof station are scaled in the vehicle manifest; the
// muzzle offsets in crews.ts use the same scales. If they drift apart, shots
// leave from somewhere other than the drawn barrel.
const manifest = JSON.parse(readFileSync(join(import.meta.dirname, '..', 'public', 'assets', 'vehicles', 'manifest.json'), 'utf8')) as {
  parts: Record<string, { scale?: number }>;
};
check('the manifest gun scale matches SOLO_GUN_SCALE', (manifest.parts['solo/gun']?.scale ?? 1) === SOLO_GUN_SCALE);
check('the manifest roof-station scale matches SOLO_TURRET_SCALE', (manifest.parts['solo/turret']?.scale ?? 1) === SOLO_TURRET_SCALE);

console.log(failures === 0 ? '\n✓ all weapon checks passed\n' : `\n✗ ${failures} weapon check(s) failed\n`);
process.exit(failures === 0 ? 0 : 1);
