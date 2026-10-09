/**
 * Headlights and tail lights, for every car — it is night.
 *
 * Under floodlights a dark car on a dark floor is a silhouette; with its lights
 * on it is a car, and you can tell which way it is facing from across the arena
 * (white = coming at you, red = going away). Purely cosmetic.
 *
 *   - Glows: one point sprite per lamp, all cars in ONE draw call, sized in
 *     metres (perspective-correct) and additive, so they read as light.
 *   - Beams: real light on the ground, for the local car only — one SpotLight,
 *     created once and never removed (adding a light recompiles every material).
 */

import * as THREE from 'three';

/** Car-local lamp positions, from the chassis model's bounds (`buildVehicle`). */
export type LightAnchors = {
  /** Left headlight; the right one mirrors x. */
  head: THREE.Vector3;
  /** Left tail light; the right one mirrors x. */
  tail: THREE.Vector3;
};

const HEAD = new THREE.Color(1.0, 0.93, 0.8);
const TAIL = new THREE.Color(1.0, 0.08, 0.04);
const CAPACITY = 64 * 4;

export class CarLights {
  readonly object = new THREE.Group();
  /** The local car's beams. Aim it with `beam(...)`. */
  readonly spot: THREE.SpotLight;

  private readonly glows: THREE.Points;
  private readonly positions = new Float32Array(CAPACITY * 3);
  private readonly colours = new Float32Array(CAPACITY * 3);
  private readonly sizes = new Float32Array(CAPACITY);
  private readonly geometry = new THREE.BufferGeometry();
  private readonly material: THREE.ShaderMaterial;
  private count = 0;
  private readonly v = new THREE.Vector3();

  constructor() {
    this.object.name = 'car-lights';
    this.geometry.setAttribute('position', new THREE.BufferAttribute(this.positions, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aColour', new THREE.BufferAttribute(this.colours, 3).setUsage(THREE.DynamicDrawUsage));
    this.geometry.setAttribute('aSize', new THREE.BufferAttribute(this.sizes, 1).setUsage(THREE.DynamicDrawUsage));
    this.material = new THREE.ShaderMaterial({
      uniforms: { uScale: { value: 500 } },
      vertexShader: `
        attribute vec3 aColour;
        attribute float aSize;
        uniform float uScale;
        varying vec3 vColour;
        void main() {
          vColour = aColour;
          vec4 mv = modelViewMatrix * vec4(position, 1.0);
          gl_PointSize = clamp(aSize * uScale / max(-mv.z, 0.1), 0.0, 256.0);
          gl_Position = projectionMatrix * mv;
        }`,
      fragmentShader: `
        varying vec3 vColour;
        void main() {
          float d = length(gl_PointCoord - 0.5) * 2.0;
          float core = smoothstep(0.35, 0.0, d);
          float halo = pow(max(0.0, 1.0 - d), 3.0) * 0.5;
          gl_FragColor = vec4(vColour * (core + halo), 1.0);
          #include <tonemapping_fragment>
          #include <colorspace_fragment>
        }`,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      transparent: true,
    });
    this.glows = new THREE.Points(this.geometry, this.material);
    this.glows.frustumCulled = false;
    this.glows.renderOrder = 6;
    this.glows.name = 'car-light-glows';

    this.spot = new THREE.SpotLight(0xfff1dd, 0, 45, 0.55, 0.65, 1.4);
    this.spot.name = 'headlight-beams';
    this.object.add(this.glows, this.spot, this.spot.target);
  }

  /** Start a frame: forget last frame's lamps. */
  begin(camera: THREE.PerspectiveCamera, viewportHeight: number): void {
    this.count = 0;
    // Pixels per metre at 1 m distance, so `aSize` is in metres.
    this.material.uniforms.uScale.value = viewportHeight / (2 * Math.tan(THREE.MathUtils.degToRad(camera.fov) / 2));
  }

  /** One car's four lamps. `braking` brightens the tail lights. */
  add(root: THREE.Object3D, anchors: LightAnchors, braking = false): void {
    if (this.count + 4 > CAPACITY) return;
    const matrix = root.matrixWorld;
    for (const side of [-1, 1]) {
      this.push(this.v.set(anchors.head.x * side, anchors.head.y, anchors.head.z).applyMatrix4(matrix), HEAD, 1.0, 1.1);
      this.push(this.v.set(anchors.tail.x * side, anchors.tail.y, anchors.tail.z).applyMatrix4(matrix), TAIL, braking ? 1.6 : 0.8, braking ? 0.75 : 0.5);
    }
  }

  /** Point the local car's beams (or switch them off with `null`). */
  beam(root: THREE.Object3D | null, anchors?: LightAnchors): void {
    if (!root || !anchors) {
      this.spot.intensity = 0;
      return;
    }
    const matrix = root.matrixWorld;
    this.spot.position.set(0, anchors.head.y + 0.2, anchors.head.z).applyMatrix4(matrix);
    // Aim ~22 m ahead, at the ground.
    this.spot.target.position.set(0, -1.2, anchors.head.z - 22).applyMatrix4(matrix);
    this.spot.target.updateMatrixWorld();
    this.spot.intensity = 90;
  }

  /** Upload this frame's lamps. */
  end(): void {
    this.geometry.setDrawRange(0, this.count);
    for (const name of ['position', 'aColour', 'aSize']) this.geometry.getAttribute(name).needsUpdate = true;
  }

  dispose(): void {
    this.geometry.dispose();
    this.material.dispose();
  }

  private push(p: THREE.Vector3, colour: THREE.Color, intensity: number, size: number): void {
    const i = this.count++;
    const o = i * 3;
    // Element writes, not `.set([...])`: no array allocated per lamp per frame.
    this.positions[o] = p.x;
    this.positions[o + 1] = p.y;
    this.positions[o + 2] = p.z;
    this.colours[o] = colour.r * intensity;
    this.colours[o + 1] = colour.g * intensity;
    this.colours[o + 2] = colour.b * intensity;
    this.sizes[i] = size;
  }
}
