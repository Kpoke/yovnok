/**
 * The guns chosen in the garage that have no model of their own: built from
 * simple shapes, each ending exactly at its mount's muzzle (where the shot and
 * the flash start). -Z is forward; the group sits on the mount's pivot.
 */

import * as THREE from 'three';
import { mergeGeometries } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import type { WeaponId } from '../../shared/weapons';

const gunmetal = new THREE.MeshStandardMaterial({ color: 0x2b2f35, roughness: 0.45, metalness: 0.8 });
const steel = new THREE.MeshStandardMaterial({ color: 0x5c636c, roughness: 0.35, metalness: 0.85 });
const coil = new THREE.MeshStandardMaterial({ color: 0x0a2a33, emissive: 0x2cd8ff, emissiveIntensity: 2.2, roughness: 0.3 });
const tube = new THREE.MeshStandardMaterial({ color: 0x3a3f2c, roughness: 0.6, metalness: 0.4 });

/** A cylinder along -Z, from z0 to z1 (z1 further forward, i.e. more negative). */
function barrel(radius: number, x: number, y: number, z0: number, z1: number, segments = 10): THREE.BufferGeometry {
  const g = new THREE.CylinderGeometry(radius, radius, Math.abs(z1 - z0), segments);
  g.rotateX(Math.PI / 2);
  g.translate(x, y, (z0 + z1) / 2);
  return g;
}
const box = (sx: number, sy: number, sz: number, x: number, y: number, z: number): THREE.BufferGeometry =>
  new THREE.BoxGeometry(sx, sy, sz).translate(x, y, z);

/**
 * A bumper gun (one of a pair) or the roof weapon, for a weapon with no model.
 * Returns null for the guns that have one (the .50 and the RPG).
 */
export function buildGun(weapon: WeaponId, muzzle: readonly [number, number, number]): THREE.Group | null {
  const [mx, my, mz] = muzzle;
  const group = new THREE.Group();
  group.name = `gun:${weapon}`;
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material): void => {
    const mesh = new THREE.Mesh(geometry, material);
    mesh.castShadow = true;
    group.add(mesh);
  };

  if (weapon === 'scatter') {
    // Double-barrelled, short and fat, with a drum underneath.
    add(box(0.16, 0.16, 0.42, mx, my, 0.02), gunmetal);
    add(mergeGeometries([barrel(0.045, mx - 0.045, my + 0.01, -0.18, mz), barrel(0.045, mx + 0.045, my + 0.01, -0.18, mz)])!, steel);
    add(barrel(0.09, mx, my - 0.12, 0.1, -0.12, 14), gunmetal);
    return group;
  }
  if (weapon === 'lancer') {
    // A long, slim rail with glowing coils and a capacitor at the back.
    add(box(0.13, 0.13, 0.36, mx, my, 0.08), gunmetal);
    add(barrel(0.028, mx, my, -0.1, mz, 8), steel);
    add(mergeGeometries([0.22, 0.36, 0.5].map((t) => barrel(0.05, mx, my, -t + 0.02, -t - 0.02, 12)))!, coil);
    add(box(0.09, 0.09, 0.16, mx, my + 0.11, 0.12), coil);
    return group;
  }
  if (weapon === 'swarm') {
    // A six-tube rocket pod on the roof mount.
    const tubes: THREE.BufferGeometry[] = [];
    for (let row = 0; row < 2; row++) {
      for (let col = 0; col < 3; col++) {
        tubes.push(barrel(0.07, mx + (col - 1) * 0.16, my - 0.02 + row * 0.15, 0.25, mz, 10));
      }
    }
    // The pod's box stops just short of the tube mouths.
    add(box(0.56, 0.38, 0.25 - mz - 0.08, mx, my + 0.05, (0.25 + mz + 0.08) / 2), tube);
    add(mergeGeometries(tubes)!, gunmetal);
    add(box(0.22, 0.3, 0.3, mx, my - 0.3, 0.15), steel);
    return group;
  }
  return null;
}
