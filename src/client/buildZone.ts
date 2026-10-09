/**
 * The closing danger zone, drawn as a ring on the ground.
 *
 * Deliberately cheap: ONE mesh whose radius is a scale factor, updated from the
 * snapshot. The server owns the schedule; the client only has to make the
 * boundary legible, because "am I about to be outside?" is a decision the player
 * has to make at a glance. A vertical wall of light is M9's job.
 */

import * as THREE from 'three';

const RING_SEGMENTS = 160;

export type ZoneRig = {
  object: THREE.Object3D;
  /** Move/scale to the current boundary; pass null to hide. */
  update(x: number, z: number, radius: number | null, shrinking: boolean): void;
};

export function buildZone(): ZoneRig {
  // Unit ring in the XZ plane; scale sets the radius.
  const geometry = new THREE.RingGeometry(0.982, 1, RING_SEGMENTS);
  geometry.rotateX(-Math.PI / 2);

  const material = new THREE.MeshBasicMaterial({
    color: 0xff5a5a,
    transparent: true,
    opacity: 0.85,
    side: THREE.DoubleSide,
    depthWrite: false,
  });

  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.y = 0.25; // just above the floor, below car ride height
  mesh.renderOrder = 2;
  mesh.visible = false;

  return {
    object: mesh,
    update(x, z, radius, shrinking) {
      mesh.visible = radius !== null;
      if (radius === null) return;
      mesh.position.x = x;
      mesh.position.z = z;
      mesh.scale.set(radius, 1, radius);
      // Brighter while it is actually closing, so the shrink window reads.
      material.opacity = shrinking ? 1 : 0.6;
      material.color.setHex(shrinking ? 0xff2d2d : 0xff5a5a);
    },
  };
}
