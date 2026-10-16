/**
 * Shot tracers.
 *
 * A hitscan shot exists for exactly one tick on the server, so there is no
 * object to replicate — it arrives as an event and is drawn as a short-lived
 * streak. Without it, firing is invisible: the target takes damage and nothing
 * on screen explains why, which makes the weapon impossible to learn.
 *
 * Each streak is a glowing ribbon a few centimetres wide, turned to face the
 * camera every frame (a one-pixel line vanished at any distance). Fixed-size
 * pool in one mesh: one draw call, no allocations. Expired ribbons are
 * collapsed to zero width, which renders nothing.
 */

import * as THREE from 'three';

const MAX_TRACERS = 64;
const LIFETIME = 0.14;
/**
 * How much of the shot to draw.
 *
 * A tracer is a streak leaving the barrel, not a laser to the horizon: the
 * full 220 m ray reads as a line ruled across the map.
 */
const MAX_LENGTH = 16;
/** Ribbon width (m): a bright core inside a soft glow (the texture). */
const WIDTH = 0.16;
const COLOUR = new THREE.Color(0xffd27a);

/** A soft band, bright in the middle: the glow across the ribbon. */
function glowTexture(): THREE.Texture {
  const canvas = document.createElement('canvas');
  canvas.width = 4;
  canvas.height = 64;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createLinearGradient(0, 0, 0, 64);
  g.addColorStop(0, 'rgba(255,255,255,0)');
  g.addColorStop(0.38, 'rgba(255,255,255,0.35)');
  g.addColorStop(0.5, 'rgba(255,255,255,1)');
  g.addColorStop(0.62, 'rgba(255,255,255,0.35)');
  g.addColorStop(1, 'rgba(255,255,255,0)');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 4, 64);
  return new THREE.CanvasTexture(canvas);
}

export class Tracers {
  readonly object: THREE.Mesh;

  /** Each tracer's two ends (x, y, z, x, y, z). */
  private ends: Float32Array;
  private remaining: Float32Array;
  private positions: Float32Array;
  private colours: Float32Array;
  private cursor = 0;
  private readonly side = new THREE.Vector3();
  private readonly dir = new THREE.Vector3();
  private readonly toCam = new THREE.Vector3();

  constructor() {
    this.ends = new Float32Array(MAX_TRACERS * 6);
    this.remaining = new Float32Array(MAX_TRACERS);
    this.positions = new Float32Array(MAX_TRACERS * 4 * 3);
    this.colours = new Float32Array(MAX_TRACERS * 4 * 3);

    const uvs = new Float32Array(MAX_TRACERS * 4 * 2);
    const index: number[] = [];
    for (let i = 0; i < MAX_TRACERS; i++) {
      // Corners: start-left, start-right, end-left, end-right.
      uvs.set([0, 0, 0, 1, 1, 0, 1, 1], i * 8);
      const v = i * 4;
      index.push(v, v + 1, v + 2, v + 2, v + 1, v + 3);
    }
    const geometry = new THREE.BufferGeometry();
    const position = new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage);
    const colour = new THREE.BufferAttribute(this.colours, 3).setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', position);
    geometry.setAttribute('color', colour);
    geometry.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));
    geometry.setIndex(index);

    const material = new THREE.MeshBasicMaterial({
      map: glowTexture(),
      vertexColors: true,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      side: THREE.DoubleSide,
      fog: false,
    });

    this.object = new THREE.Mesh(geometry, material);
    this.object.frustumCulled = false;
    this.object.renderOrder = 2;
    this.object.name = 'tracers';
  }

  add(from: { x: number; y: number; z: number }, to: { x: number; y: number; z: number }): void {
    // Clamp to a short streak, so the tracer reads as a shot rather than as a
    // line ruled across the map.
    const dx = to.x - from.x;
    const dy = to.y - from.y;
    const dz = to.z - from.z;
    const distance = Math.hypot(dx, dy, dz);
    const scale = distance > MAX_LENGTH ? MAX_LENGTH / distance : 1;
    this.ends.set([from.x, from.y, from.z, from.x + dx * scale, from.y + dy * scale, from.z + dz * scale], this.cursor * 6);
    this.remaining[this.cursor] = LIFETIME;
    this.cursor = (this.cursor + 1) % MAX_TRACERS;
  }

  /** Age the tracers and turn each ribbon to face `camera`. */
  update(dt: number, camera?: THREE.Camera): void {
    const cam = camera?.position;
    for (let i = 0; i < MAX_TRACERS; i++) {
      const p = i * 12;
      if (this.remaining[i] <= 0 || !cam) {
        this.positions.fill(0, p, p + 12);
        continue;
      }
      this.remaining[i] -= dt;
      const e = i * 6;
      this.dir.set(this.ends[e + 3] - this.ends[e], this.ends[e + 4] - this.ends[e + 1], this.ends[e + 5] - this.ends[e + 2]);
      this.toCam.set(
        cam.x - (this.ends[e] + this.ends[e + 3]) / 2,
        cam.y - (this.ends[e + 1] + this.ends[e + 4]) / 2,
        cam.z - (this.ends[e + 2] + this.ends[e + 5]) / 2,
      );
      this.side
        .crossVectors(this.dir, this.toCam)
        .normalize()
        .multiplyScalar(WIDTH / 2);
      for (const [k, end] of [
        [0, 0],
        [1, 0],
        [2, 3],
        [3, 3],
      ] as const) {
        const sign = k % 2 === 0 ? -1 : 1;
        this.positions[p + k * 3] = this.ends[e + end] + this.side.x * sign;
        this.positions[p + k * 3 + 1] = this.ends[e + end + 1] + this.side.y * sign;
        this.positions[p + k * 3 + 2] = this.ends[e + end + 2] + this.side.z * sign;
      }
      // Bright at the muzzle end, fading along the streak and with age.
      const life = Math.max(0, this.remaining[i] / LIFETIME);
      for (let k = 0; k < 4; k++) {
        const fade = life * (k < 2 ? 1 : 0.35);
        this.colours.set([COLOUR.r * fade, COLOUR.g * fade, COLOUR.b * fade], i * 12 + k * 3);
      }
    }
    const geometry = this.object.geometry;
    geometry.getAttribute('position').needsUpdate = true;
    geometry.getAttribute('color').needsUpdate = true;
  }

  dispose(): void {
    this.object.geometry.dispose();
    const material = this.object.material as THREE.MeshBasicMaterial;
    material.map?.dispose();
    material.dispose();
  }
}
