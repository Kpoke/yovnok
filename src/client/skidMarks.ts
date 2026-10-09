/**
 * Skid marks — visual feedback for the handbrake.
 *
 * The handbrake is the game's core skill expression (DESIGN.md §3.1), and it
 * was previously invisible: a slide changed nothing on screen, so even a large
 * change in handling was hard to perceive. These marks are drawn by writing
 * quads from each rear wheel's previous position to its current one while the
 * tyres are slipping.
 *
 * Implementation is a fixed-size ring buffer inside one BufferGeometry, so
 * there are no allocations at runtime and the whole thing is a single draw
 * call. Unused slots stay at the origin, producing zero-area triangles that
 * cost nothing to rasterise.
 */

import * as THREE from 'three';

const MAX_SEGMENTS = 900;
/** Half the drawn width of a tyre mark, in metres. */
const HALF_WIDTH = 0.17;

export class SkidMarks {
  readonly mesh: THREE.Mesh;

  private positions: Float32Array;
  private attribute: THREE.BufferAttribute;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(MAX_SEGMENTS * 6 * 3);

    const geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.attribute);
    geometry.setDrawRange(0, MAX_SEGMENTS * 6);

    const material = new THREE.MeshBasicMaterial({
      color: 0x0b0d10,
      transparent: true,
      opacity: 0.5,
      depthWrite: false,
      side: THREE.DoubleSide,
      // Lift the marks off the floor so they never z-fight with it.
      polygonOffset: true,
      polygonOffsetFactor: -4,
      polygonOffsetUnits: -4,
    });

    this.mesh = new THREE.Mesh(geometry, material);
    this.mesh.frustumCulled = false;
    this.mesh.renderOrder = 1;
    this.mesh.name = 'skidmarks';
  }

  /** Lay one tyre mark between two ground positions. */
  segment(ax: number, az: number, bx: number, bz: number, y: number): void {
    const dx = bx - ax;
    const dz = bz - az;
    const length = Math.hypot(dx, dz);
    // Ignore sub-millimetre steps: at low speed this would spam degenerate quads.
    if (length < 2e-3) return;

    const nx = (-dz / length) * HALF_WIDTH;
    const nz = (dx / length) * HALF_WIDTH;

    const i = this.cursor * 18;
    const p = this.positions;

    // Two triangles: (a+n, a-n, b-n) and (a+n, b-n, b+n)
    p[i + 0] = ax + nx; p[i + 1] = y; p[i + 2] = az + nz;
    p[i + 3] = ax - nx; p[i + 4] = y; p[i + 5] = az - nz;
    p[i + 6] = bx - nx; p[i + 7] = y; p[i + 8] = bz - nz;
    p[i + 9] = ax + nx; p[i + 10] = y; p[i + 11] = az + nz;
    p[i + 12] = bx - nx; p[i + 13] = y; p[i + 14] = bz - nz;
    p[i + 15] = bx + nx; p[i + 16] = y; p[i + 17] = bz + nz;

    this.cursor = (this.cursor + 1) % MAX_SEGMENTS;
    this.attribute.needsUpdate = true;
  }
}
