/**
 * Weapon effects: what makes a shot READ.
 *
 * Without these a gun was a thin line and a sound, and a rocket was invisible
 * until (and unless) something blew up. Three things, all cosmetic and
 * client-side — the server decides every hit, this only shows it:
 *
 *   - muzzle flashes, with one short-lived light so the car lights up as it fires;
 *   - impacts: bright sparks on a car (a hit you landed, or took), a dust puff on
 *     the world (a miss you can correct from);
 *   - rockets in flight: body, exhaust flame and a smoke trail, so a rocket can be
 *     seen coming — and dodged, which is the point of a projectile.
 *
 * Particles reuse the explosion module's instanced pool: every particle of a kind
 * is one draw call, however many are alive.
 */

import * as THREE from 'three';
import { ParticlePool, softTexture, type Particle } from './explosions';
import type { ProjectileSnapshot } from '../shared/protocol';
import { TICK } from '../shared/config';

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/** How long after a snapshot a rocket is extrapolated before it is held still. */
const MAX_EXTRAPOLATE = 0.12;

export class WeaponFx {
  readonly object = new THREE.Group();

  private flashes: ParticlePool;
  private sparks: ParticlePool;
  private dust: ParticlePool;
  private trail: ParticlePool;
  private light = new THREE.PointLight(0xffc070, 0, 14, 2);
  private lightLife = 0;

  /** Pooled rocket bodies, shown for live projectiles. */
  private rockets: THREE.Group[] = [];
  private rocketGeometry = new THREE.CylinderGeometry(0.06, 0.08, 0.7, 8);
  private rocketMaterial = new THREE.MeshStandardMaterial({ color: 0x4d5a3c, roughness: 0.6, metalness: 0.3 });
  private flameMaterial = new THREE.MeshBasicMaterial({ color: 0xffb25a, transparent: true, opacity: 0.95 });
  private flameGeometry = new THREE.ConeGeometry(0.09, 0.45, 8);
  private trailTimer = 0;

  constructor() {
    this.object.name = 'weapon-fx';
    const texture = softTexture();
    this.flashes = new ParticlePool(48, texture, THREE.AdditiveBlending, 4);
    this.sparks = new ParticlePool(160, texture, THREE.AdditiveBlending, 4);
    this.dust = new ParticlePool(80, texture, THREE.NormalBlending, 2);
    this.trail = new ParticlePool(220, texture, THREE.NormalBlending, 2);
    for (const pool of [this.flashes, this.sparks, this.dust, this.trail]) this.object.add(pool.mesh);
    this.object.add(this.light);
  }

  /**
   * A muzzle flash at `at`, travelling along `dir`. `heavy` is the RPG: a
   * bigger, longer bloom and a back-blast puff of smoke.
   */
  muzzle(at: { x: number; y: number; z: number }, dir: { x: number; y: number; z: number }, heavy = false): void {
    const count = heavy ? 6 : 2;
    for (let i = 0; i < count; i++) {
      this.flashes.spawn((p) =>
        setup(p, {
          x: at.x + dir.x * (0.15 + i * 0.12),
          y: at.y + dir.y * (0.15 + i * 0.12),
          z: at.z + dir.z * (0.15 + i * 0.12),
          v: [dir.x * 6, dir.y * 6, dir.z * 6],
          life: heavy ? 0.12 : 0.05,
          size: heavy ? [1.1, 1.6] : [0.45, 0.7],
          colour: [1, 0.85, 0.5, 1, 0.45, 0.1],
          opacity: 1,
          fade: heavy ? 6 : 16,
        }),
      );
    }
    if (heavy) {
      for (let i = 0; i < 8; i++) {
        this.trail.spawn((p) =>
          setup(p, {
            x: at.x - dir.x * 0.8,
            y: at.y - dir.y * 0.8,
            z: at.z - dir.z * 0.8,
            v: [-dir.x * rand(2, 5) + rand(-1, 1), rand(0.3, 1.2), -dir.z * rand(2, 5) + rand(-1, 1)],
            life: rand(0.9, 1.5),
            size: [0.6, 2.2],
            colour: [0.75, 0.72, 0.68, 0.45, 0.44, 0.42],
            opacity: 0.55,
            fade: 0.45,
            drag: 2,
          }),
        );
      }
    }
    this.light.position.set(at.x, at.y + 0.2, at.z);
    this.light.intensity = heavy ? 26 : 9;
    this.lightLife = heavy ? 0.12 : 0.05;
  }

  /**
   * Where a round ended. `vehicle` = it struck a car: hot sparks that kick back
   * toward the shooter. Otherwise a dust puff off the ground or a wall.
   */
  impact(at: { x: number; y: number; z: number }, from: { x: number; y: number; z: number }, vehicle: boolean): void {
    const bx = from.x - at.x;
    const by = from.y - at.y;
    const bz = from.z - at.z;
    const len = Math.hypot(bx, by, bz) || 1;
    const back = [bx / len, by / len, bz / len];
    if (vehicle) {
      for (let i = 0; i < 7; i++) {
        this.sparks.spawn((p) =>
          setup(p, {
            x: at.x,
            y: at.y,
            z: at.z,
            v: [back[0] * rand(3, 9) + rand(-4, 4), back[1] * rand(3, 9) + rand(1, 5), back[2] * rand(3, 9) + rand(-4, 4)],
            life: rand(0.18, 0.4),
            size: [0.16, 0.05],
            colour: [1, 0.92, 0.6, 1, 0.45, 0.1],
            opacity: 1,
            fade: 2.5,
            gravity: 14,
            drag: 1.5,
          }),
        );
      }
      this.flashes.spawn((p) =>
        setup(p, { x: at.x, y: at.y, z: at.z, v: [0, 0, 0], life: 0.06, size: [0.6, 0.9], colour: [1, 0.9, 0.6, 1, 0.6, 0.2], opacity: 1, fade: 14 }),
      );
    } else {
      for (let i = 0; i < 3; i++) {
        this.dust.spawn((p) =>
          setup(p, {
            x: at.x,
            y: at.y + 0.1,
            z: at.z,
            v: [back[0] * rand(0.5, 2) + rand(-0.6, 0.6), rand(0.6, 1.8), back[2] * rand(0.5, 2) + rand(-0.6, 0.6)],
            life: rand(0.5, 0.9),
            size: [0.35, 1.1],
            colour: [0.62, 0.55, 0.45, 0.5, 0.46, 0.4],
            opacity: 0.6,
            fade: 0.8,
            drag: 2.5,
          }),
        );
      }
    }
  }

  /**
   * Draw the live rockets. `received` is when this projectile list arrived
   * (ms); each rocket is carried forward along its last velocity until the next
   * snapshot, so it flies smoothly at 120 fps on 30 Hz updates.
   */
  updateRockets(projectiles: readonly ProjectileSnapshot[], received: number, now: number, dt: number): void {
    const ahead = Math.min(MAX_EXTRAPOLATE, Math.max(0, (now - received) / 1000));
    while (this.rockets.length < projectiles.length) this.rockets.push(this.makeRocket());
    this.trailTimer -= dt;
    const emit = this.trailTimer <= 0;
    if (emit) this.trailTimer = 1 / 60;

    this.rockets.forEach((rocket, i) => {
      const p = projectiles[i];
      rocket.visible = p !== undefined;
      if (!p) return;
      const vx = (p.x - p.px) / TICK.dt;
      const vy = (p.y - p.py) / TICK.dt;
      const vz = (p.z - p.pz) / TICK.dt;
      const x = p.x + vx * ahead;
      const y = p.y + vy * ahead;
      const z = p.z + vz * ahead;
      rocket.position.set(x, y, z);
      // Point the body along its flight: the cylinder's axis is +Y.
      const speed = Math.hypot(vx, vy, vz) || 1;
      rocket.quaternion.setFromUnitVectors(UP, scratch.set(vx / speed, vy / speed, vz / speed));
      if (emit) {
        this.trail.spawn((t) =>
          setup(t, {
            x: x - (vx / speed) * 0.5,
            y: y - (vy / speed) * 0.5,
            z: z - (vz / speed) * 0.5,
            v: [rand(-0.3, 0.3), rand(0.2, 0.6), rand(-0.3, 0.3)],
            life: rand(0.8, 1.3),
            size: [0.3, 1.4],
            colour: [0.85, 0.82, 0.78, 0.5, 0.49, 0.47],
            opacity: 0.5,
            fade: 0.42,
            drag: 1.5,
          }),
        );
      }
    });
  }

  update(dt: number): void {
    this.flashes.update(dt);
    this.sparks.update(dt);
    this.dust.update(dt);
    this.trail.update(dt);
    if (this.lightLife > 0) {
      this.lightLife -= dt;
      if (this.lightLife <= 0) this.light.intensity = 0;
    }
  }

  private makeRocket(): THREE.Group {
    const group = new THREE.Group();
    const body = new THREE.Mesh(this.rocketGeometry, this.rocketMaterial);
    body.castShadow = true;
    const flame = new THREE.Mesh(this.flameGeometry, this.flameMaterial);
    // Behind the body (axis +Y is forward), pointing backwards.
    flame.position.y = -0.55;
    flame.rotation.x = Math.PI;
    group.add(body, flame);
    group.visible = false;
    this.object.add(group);
    return group;
  }

  dispose(): void {
    this.rocketGeometry.dispose();
    this.rocketMaterial.dispose();
    this.flameGeometry.dispose();
    this.flameMaterial.dispose();
  }
}

const UP = new THREE.Vector3(0, 1, 0);
const scratch = new THREE.Vector3();

function setup(
  p: Particle,
  o: {
    x: number;
    y: number;
    z: number;
    v: number[];
    life: number;
    size: [number, number];
    colour: number[];
    opacity: number;
    fade: number;
    gravity?: number;
    drag?: number;
  },
): void {
  p.x = o.x;
  p.y = o.y;
  p.z = o.z;
  p.vx = o.v[0];
  p.vy = o.v[1];
  p.vz = o.v[2];
  p.life = o.life;
  p.maxLife = o.life;
  p.size0 = o.size[0];
  p.size1 = o.size[1];
  p.r0 = o.colour[0];
  p.g0 = o.colour[1];
  p.b0 = o.colour[2];
  p.r1 = o.colour[3];
  p.g1 = o.colour[4];
  p.b1 = o.colour[5];
  p.opacity = o.opacity;
  p.fade = o.fade;
  p.gravity = o.gravity ?? 0;
  p.drag = o.drag ?? 0;
}
