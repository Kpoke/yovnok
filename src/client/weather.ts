/**
 * Weather: rain, snow, drifting dust or low mist, in a box that follows the
 * camera (so a few thousand particles read as weather everywhere). One draw
 * call each, positions advanced on the CPU and wrapped inside the box.
 */

import * as THREE from 'three';
import { softTexture } from './explosions';
import type { Weather as WeatherKind } from './maps/themes';

type Settings = {
  count: number;
  /** Box half-sizes around the camera: across, up, across. */
  half: [number, number, number];
  /** Fall speed (m/s) and sideways drift. */
  fall: number;
  drift: number;
};

const SETTINGS: Record<Exclude<WeatherKind, 'none'>, Settings> = {
  rain: { count: 5000, half: [45, 22, 45], fall: 26, drift: 3 },
  snow: { count: 4500, half: [55, 25, 55], fall: 1.6, drift: 1.2 },
  dust: { count: 1400, half: [70, 10, 70], fall: -0.1, drift: 5 },
  mist: { count: 70, half: [140, 3, 140], fall: 0, drift: 1.5 },
};

export class Weather {
  readonly object: THREE.Object3D;
  private readonly positions: Float32Array;
  private readonly settings: Settings;
  private readonly kind: Exclude<WeatherKind, 'none'>;
  private readonly attribute: THREE.BufferAttribute;
  private readonly phases: Float32Array;
  private time = 0;

  constructor(kind: Exclude<WeatherKind, 'none'>) {
    this.kind = kind;
    this.settings = SETTINGS[kind];
    const { count, half } = this.settings;
    const rain = kind === 'rain';
    // Rain is a short streak (two vertices); the rest are points.
    this.positions = new Float32Array(count * 3 * (rain ? 2 : 1));
    this.phases = new Float32Array(count);
    for (let i = 0; i < count; i++) {
      const x = (Math.random() * 2 - 1) * half[0];
      const y = (Math.random() * 2 - 1) * half[1];
      const z = (Math.random() * 2 - 1) * half[2];
      this.phases[i] = Math.random() * Math.PI * 2;
      this.write(i, x, y, z);
    }
    const geometry = new THREE.BufferGeometry();
    this.attribute = new THREE.BufferAttribute(this.positions, 3);
    this.attribute.setUsage(THREE.DynamicDrawUsage);
    geometry.setAttribute('position', this.attribute);

    if (rain) {
      const material = new THREE.LineBasicMaterial({ color: 0x9fb4c8, transparent: true, opacity: 0.35, depthWrite: false });
      this.object = new THREE.LineSegments(geometry, material);
    } else {
      const material = new THREE.PointsMaterial({
        map: softTexture(),
        color: kind === 'snow' ? 0xffffff : kind === 'dust' ? 0xe0b088 : 0xdfe6e2,
        size: kind === 'snow' ? 0.32 : kind === 'dust' ? 0.22 : 48,
        sizeAttenuation: true,
        transparent: true,
        opacity: kind === 'snow' ? 0.9 : kind === 'dust' ? 0.5 : 0.16,
        depthWrite: false,
      });
      this.object = new THREE.Points(geometry, material);
    }
    this.object.frustumCulled = false;
    this.object.renderOrder = 4;
    this.object.name = `weather-${kind}`;
    this.object.raycast = () => {};
  }

  /** Store one particle (rain: both ends of its streak). */
  private write(i: number, x: number, y: number, z: number): void {
    if (this.kind === 'rain') {
      const o = i * 6;
      this.positions[o] = x;
      this.positions[o + 1] = y;
      this.positions[o + 2] = z;
      // The streak trails upward, slightly against the wind.
      this.positions[o + 3] = x - 0.06;
      this.positions[o + 4] = y + 0.9;
      this.positions[o + 5] = z - 0.03;
    } else {
      const o = i * 3;
      this.positions[o] = x;
      this.positions[o + 1] = y;
      this.positions[o + 2] = z;
    }
  }

  update(dt: number, view: THREE.Vector3): void {
    this.time += dt;
    const { count, half, fall, drift } = this.settings;
    const stride = this.kind === 'rain' ? 6 : 3;
    // World positions, wrapped into a box around the view: a moving camera
    // drives THROUGH the weather instead of carrying it along.
    const cy = this.kind === 'mist' ? 2.5 : view.y;
    const wrap = (v: number, c: number, h: number): number => {
      const r = v - c;
      return r > h ? v - 2 * h : r < -h ? v + 2 * h : v;
    };
    for (let i = 0; i < count; i++) {
      const o = i * stride;
      const phase = this.phases[i];
      let x = this.positions[o] + Math.sin(this.time * 0.7 + phase) * drift * dt + drift * 0.3 * dt;
      let y = this.positions[o + 1] - fall * dt;
      let z = this.positions[o + 2] + Math.cos(this.time * 0.5 + phase) * drift * dt;
      x = wrap(x, view.x, half[0]);
      y = wrap(y, cy, half[1]);
      z = wrap(z, view.z, half[2]);
      this.write(i, x, y, z);
    }
    this.attribute.needsUpdate = true;
  }
}
