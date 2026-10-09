/**
 * Lofted body geometry.
 *
 * Cars built from axis-aligned boxes look like van-shaped blocks: no raked
 * windscreen, no taper, no shoulder line. A car's readability lives almost
 * entirely in its *profile*, so bodies are lofted from a series of cross
 * sections instead.
 *
 * Each section is a 6-point ring — a chamfered rectangle — and consecutive
 * sections are connected into a closed tube. Varying the ring's width and the
 * section's height along the length gives the taper, the shoulder line and the
 * belt line for free, and it stays low-poly, which is the agreed art direction.
 *
 * This is deliberately a *shape* tool, not a modelling pipeline. If vehicles
 * ever move to authored glTF assets, `parts.ts` is the only file that changes.
 */

import * as THREE from 'three';

export type LoftSection = {
  /** Position along the vehicle's length. Forward is -Z. */
  z: number;
  /** Half-width at the section's top edge (the widest point). */
  wTop: number;
  /** Half-width at the section's bottom edge. Slightly less gives tumblehome. */
  wBottom: number;
  /** Vertical position of the bottom edge, in vehicle local space. */
  yBottom: number;
  /** Vertical position of the top edge. */
  yTop: number;
};

/** Points per ring. Six gives a chamfered rectangle: cheap, but not a slab. */
const PROFILE = 6;

/** Ring points, ordered consistently so quads between sections wind uniformly. */
function ring(s: LoftSection): Array<{ x: number; y: number }> {
  const { wBottom, wTop, yBottom, yTop } = s;
  // The shoulder sits a little below the top, which reads as a belt line.
  const shoulderY = yBottom + (yTop - yBottom) * 0.62;
  return [
    { x: -wBottom, y: yBottom },
    { x: -wTop, y: shoulderY },
    { x: -wTop * 0.88, y: yTop },
    { x: wTop * 0.88, y: yTop },
    { x: wTop, y: shoulderY },
    { x: wBottom, y: yBottom },
  ];
}

/**
 * Build a closed tube through the given sections, capped at both ends.
 * Sections must be ordered front to back (ascending z).
 */
export function loft(sections: LoftSection[]): THREE.BufferGeometry {
  const rings = sections.map((s) => ring(s).map((p) => ({ x: p.x, y: p.y, z: s.z })));
  const positions: number[] = [];
  const tri = (
    a: { x: number; y: number; z: number },
    b: { x: number; y: number; z: number },
    c: { x: number; y: number; z: number },
  ): void => {
    positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
  };

  for (let i = 0; i < rings.length - 1; i++) {
    const a = rings[i];
    const b = rings[i + 1];
    for (let k = 0; k < PROFILE; k++) {
      const k2 = (k + 1) % PROFILE;
      tri(a[k], a[k2], b[k2]);
      tri(a[k], b[k2], b[k]);
    }
  }

  // Fan the end rings from their own centroid.
  const cap = (r: typeof rings[number], reverse: boolean): void => {
    const centre = {
      x: 0,
      y: r.reduce((sum, p) => sum + p.y, 0) / r.length,
      z: r[0].z,
    };
    for (let k = 0; k < PROFILE; k++) {
      const k2 = (k + 1) % PROFILE;
      if (reverse) tri(centre, r[k2], r[k]);
      else tri(centre, r[k], r[k2]);
    }
  };
  cap(rings[0], true);
  cap(rings[rings.length - 1], false);

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.computeVertexNormals();
  return geometry;
}


