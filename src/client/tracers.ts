/**
 * Shot tracers.
 *
 * A hitscan shot exists for exactly one tick on the server, so there is no
 * object to replicate — it arrives as an event and is drawn as a short-lived
 * line. Without it, firing is invisible: the target takes damage and nothing on
 * screen explains why, which makes the weapon impossible to learn.
 *
 * Fixed-size pool in one LineSegments, so this costs a single draw call and no
 * allocations. Expired segments are collapsed to zero length rather than
 * removed, which renders nothing and is free.
 */

import * as THREE from 'three';

const MAX_TRACERS = 64;
const LIFETIME = 0.11;
/**
 * How much of the shot to draw.
 *
 * A tracer is a streak leaving the barrel, not a laser to the horizon. Drawing
 * the full 220 m ray produces a one-pixel line that is invisible in practice —
 * measured, not assumed: the trace was confirmed present in the buffer and could
 * not be seen on screen.
 */
const MAX_LENGTH = 16;

export class Tracers {
  readonly object: THREE.LineSegments;

  private positions: Float32Array;
  private remaining: Float32Array;
  private cursor = 0;

  constructor() {
    this.positions = new Float32Array(MAX_TRACERS * 2 * 3);
    this.remaining = new Float32Array(MAX_TRACERS);

    const geometry = new THREE.BufferGeometry();
    const attribute = new THREE.BufferAttribute(this.positions, 3);
    attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', attribute);

    const material = new THREE.LineBasicMaterial({
      color: 0xffd9a0,
      transparent: true,
      opacity: 0.85,
      depthWrite: false,
    });

    this.object = new THREE.LineSegments(geometry, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.name = 'tracers';
  }

  add(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    // Clamp to a short streak, so the tracer reads as a shot rather than as a
    // hairline ruled across the map.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    const scale = distance > MAX_LENGTH ? MAX_LENGTH / distance : 1;

    const i = this.cursor * 6;
    const p = this.positions;
    p[i + 0] = from.x;
    p[i + 1] = from.y;
    p[i + 2] = from.z;
    p[i + 3] = from.x + dx * scale;
    p[i + 4] = from.y + dy * scale;
    p[i + 5] = from.z + dz * scale;
    this.remaining[this.cursor] = LIFETIME;
    this.cursor = (this.cursor + 1) % MAX_TRACERS;

    const attribute = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
    attribute.needsUpdate = true;
  }

  update(dt: number): void {
    let changed = false;
    for (let i = 0; i < MAX_TRACERS; i++) {
      if (this.remaining[i] <= 0) continue;
      this.remaining[i] -= dt;
      if (this.remaining[i] > 0) continue;
      // Collapse to a point: zero-length lines draw nothing.
      const j = i * 6;
      const p = this.positions;
      p[j + 3] = p[j + 0];
      p[j + 4] = p[j + 1];
      p[j + 5] = p[j + 2];
      changed = true;
    }
    if (changed) {
      const attribute = this.object.geometry.getAttribute('position') as THREE.BufferAttribute;
      attribute.needsUpdate = true;
    }
  }

  dispose(): void {
    this.object.geometry.dispose();
    (this.object.material as THREE.Material).dispose();
  }
}
