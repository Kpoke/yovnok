/**
 * How a car SHOWS its damage, from across the arena (DESIGN.md §8).
 *
 * Damage escalates through stages, so you can read a car's state at a glance and
 * a nearly-dead car is unmistakable:
 *
 *   stage      hull    what you see
 *   ---------  ------  ----------------------------------------------------------
 *   intact     >75%    nothing
 *   scuffed    ≤75%    thin pale wisps from the engine bay; the body dirties
 *   smoking    ≤50%    a steady grey plume that trails behind the car
 *   critical   ≤25%    thick black smoke, flames licking out of the engine bay,
 *                      sparks; the paint is scorched
 *   burning    ≤10%    the car is on fire: tall flames front and back, embers,
 *                      a flickering firelight on the ground around it
 *   wreck      dead    the wreck burns out where it died for a few seconds
 *
 * Within a stage the intensity still rises continuously with damage, so two
 * smoking cars are not identical. A damaged ENGINE smokes as if the hull were
 * that low too — the engine bay is where the smoke comes from.
 *
 * All particles are WORLD-space (they are left behind as the car drives, so a
 * fast damaged car draws a trail), in three instanced pools shared by every
 * car — three draw calls however many cars burn. Firelight is a small fixed set
 * of point lights handed to the burning cars nearest the camera; lights are
 * never added or removed at runtime, which would recompile every material.
 *
 * Client-side and cosmetic: hull and component health come from the server.
 */

import * as THREE from 'three';
import { DAMAGE_FX } from '../shared/config';
import { ParticlePool, softTexture, type Particle } from './explosions';

export type DamageStage = 'intact' | 'scuffed' | 'smoking' | 'critical' | 'burning';

/** Stage from 0..1 damage (1 = dead). */
export function damageStage(damage: number): DamageStage {
  const [scuffed, smoking, critical, burning] = DAMAGE_FX.stages;
  if (damage >= burning) return 'burning';
  if (damage >= critical) return 'critical';
  if (damage >= smoking) return 'smoking';
  if (damage >= scuffed) return 'scuffed';
  return 'intact';
}

/**
 * Damage 0..1 from hull and engine. The engine counts as if it were the hull, so
 * a car with a shot-out engine smokes even on a healthy hull.
 */
export function damageOf(hullFraction: number, engineFraction = 1): number {
  return THREE.MathUtils.clamp(Math.max(1 - hullFraction, (1 - engineFraction) * 0.8), 0, 1);
}

/** Where on a car its damage comes from, in the car's local frame. */
export type DamageAnchors = {
  /** The engine bay: smoke and the first flames. */
  engine: THREE.Vector3;
  /** The rear (fuel): the second fire once the car is burning. */
  rear: THREE.Vector3;
};

type Emitter = { smoke: number; fire: number; ember: number; spark: number; seen: number };

type Wreck = { x: number; y: number; z: number; life: number; smoke: number; fire: number };

type FireSource = { x: number; y: number; z: number; strength: number };

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

/**
 * A cloudier blob than the explosion's: several overlapping soft lobes, so a
 * puff of smoke has texture rather than reading as a perfect disc.
 */
function puffTexture(): THREE.Texture {
  const size = 128;
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d');
  if (ctx) {
    let seed = 11;
    const r = (): number => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    for (let i = 0; i < 14; i++) {
      const angle = r() * Math.PI * 2;
      const distance = r() * size * 0.2;
      const x = size / 2 + Math.cos(angle) * distance;
      const y = size / 2 + Math.sin(angle) * distance;
      const radius = size * (0.16 + r() * 0.18);
      const g = ctx.createRadialGradient(x, y, 0, x, y, radius);
      g.addColorStop(0, `rgba(255,255,255,${0.35 + r() * 0.2})`);
      g.addColorStop(1, 'rgba(255,255,255,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, size, size);
    }
  }
  const texture = new THREE.CanvasTexture(canvas);
  texture.needsUpdate = true;
  return texture;
}

export class DamageFx {
  readonly object = new THREE.Group();

  private smoke: ParticlePool;
  private fire: ParticlePool;
  private embers: ParticlePool;
  private emitters = new Map<number, Emitter>();
  private wrecks: Wreck[] = [];
  private lights: THREE.PointLight[] = [];
  private fireSources: FireSource[] = [];
  private frame = 0;
  private time = 0;
  private readonly world = new THREE.Vector3();
  private readonly rearWorld = new THREE.Vector3();

  constructor() {
    this.object.name = 'damage-fx';
    const puff = puffTexture();
    const soft = softTexture();
    // Smoke draws first, fire over it, embers on top.
    this.smoke = new ParticlePool(DAMAGE_FX.smokeCapacity, puff, THREE.NormalBlending, 3);
    this.fire = new ParticlePool(DAMAGE_FX.fireCapacity, soft, THREE.AdditiveBlending, 4);
    this.embers = new ParticlePool(DAMAGE_FX.emberCapacity, soft, THREE.AdditiveBlending, 5);
    this.smoke.mesh.name = 'damage-smoke';
    this.fire.mesh.name = 'damage-fire';
    this.embers.mesh.name = 'damage-embers';
    this.object.add(this.smoke.mesh, this.fire.mesh, this.embers.mesh);
    for (let i = 0; i < DAMAGE_FX.fireLights; i++) {
      const light = new THREE.PointLight(0xff7a2a, 0, 14, 1.6);
      this.lights.push(light);
      this.object.add(light);
    }
  }

  /**
   * Emit for one car this frame.
   *
   * @param id       crew id, so each car keeps its own emission timers
   * @param root     the car's root (its world matrix places the anchors)
   * @param anchors  engine and rear points, car-local
   * @param velocity the car's velocity: particles inherit part of it
   * @param damage   0..1, from `damageOf`
   */
  emit(id: number, root: THREE.Object3D, anchors: DamageAnchors, velocity: THREE.Vector3Like, damage: number, dt: number): void {
    let e = this.emitters.get(id);
    if (!e) this.emitters.set(id, (e = { smoke: 0, fire: 0, ember: 0, spark: 0, seen: 0 }));
    e.seen = this.frame;
    const stage = damageStage(damage);
    if (stage === 'intact') return;

    root.updateMatrixWorld();
    const engine = this.world.copy(anchors.engine).applyMatrix4(root.matrixWorld);
    const ex = engine.x;
    const ey = engine.y;
    const ez = engine.z;
    const [scuffed, , critical, burning] = DAMAGE_FX.stages;
    // 0 at the first stage, 1 at death: how hard everything runs.
    const k = THREE.MathUtils.clamp((damage - scuffed) / (1 - scuffed), 0, 1);

    // ---- smoke: pale and thin → grey → black and thick -------------------
    const smokeRate = DAMAGE_FX.smokeRate[0] + (DAMAGE_FX.smokeRate[1] - DAMAGE_FX.smokeRate[0]) * k * k;
    e.smoke += smokeRate * dt;
    // Colour runs from pale grey (coolant steam) to near-black (burning oil).
    // LINEAR values, shown through sRGB output: 0.2 already reads light grey,
    // so black smoke has to be very dark here.
    const shade = THREE.MathUtils.lerp(0.2, 0.01, Math.min(1, k * 1.3));
    const onFire = damage >= critical;
    while (e.smoke >= 1) {
      e.smoke -= 1;
      this.smoke.spawn((p) => {
        this.atCar(p, ex, ey, ez, velocity, 0.25);
        p.vy = rand(1.2, 2.0) + k * 1.8;
        p.drag = 1.2;
        p.gravity = -0.35; // buoyant: it keeps rising
        p.maxLife = p.life = rand(1.6, 2.4) + k * 1.6;
        p.size0 = 0.5 + k * 0.6;
        p.size1 = 2.2 + k * 3.6;
        // A hint of firelight on the young smoke while the car burns.
        const warm = onFire ? 0.06 : 0;
        p.r0 = shade + warm;
        p.g0 = shade + warm * 0.4;
        p.b0 = shade;
        p.r1 = p.g1 = p.b1 = shade;
        p.opacity = 0.35 + k * 0.5;
        p.fade = p.opacity / p.maxLife;
      });
    }

    if (!onFire) return;

    // ---- flames: licking out of the engine bay, then the whole car ---------
    const blaze = damage >= burning;
    const f = THREE.MathUtils.clamp((damage - critical) / (1 - critical), 0, 1);
    const fireRate = DAMAGE_FX.fireRate[0] + (DAMAGE_FX.fireRate[1] - DAMAGE_FX.fireRate[0]) * f;
    e.fire += fireRate * dt;
    const rear = blaze ? this.rearWorld.copy(anchors.rear).applyMatrix4(root.matrixWorld) : null;
    let flip = false;
    while (e.fire >= 1) {
      e.fire -= 1;
      // Once burning, every other flame comes from the rear: the car is alight.
      const at = rear && (flip = !flip) ? rear : engine;
      this.fire.spawn((p) => {
        this.atCar(p, at.x, at.y, at.z, velocity, blaze ? 0.5 : 0.3);
        p.vy = rand(2.2, 3.6) + f * 2.5;
        p.drag = 2;
        p.gravity = -2.5;
        p.maxLife = p.life = rand(0.25, 0.45) + f * 0.2;
        // Many small tongues, not one ball: they overlap additively, so each
        // is small and dim, and they shrink as they rise and cool.
        p.size0 = rand(0.35, 0.6) + f * 0.45;
        p.size1 = 0.12;
        p.r0 = 1.0;
        p.g0 = 0.42;
        p.b0 = 0.08;
        p.r1 = 0.55;
        p.g1 = 0.08;
        p.b1 = 0.01;
        p.opacity = 0.55;
        p.fade = 0.55 / p.maxLife;
      });
    }

    // ---- embers and sparks ------------------------------------------------
    e.ember += (blaze ? 22 : 7) * dt;
    while (e.ember >= 1) {
      e.ember -= 1;
      this.embers.spawn((p) => {
        this.atCar(p, ex, ey, ez, velocity, 0.5);
        p.vx += rand(-1.5, 1.5);
        p.vz += rand(-1.5, 1.5);
        p.vy = rand(2.5, 5.5);
        p.drag = 0.8;
        p.gravity = 1.2;
        p.maxLife = p.life = rand(0.6, 1.3);
        p.size0 = rand(0.07, 0.13);
        p.size1 = 0.03;
        p.r0 = 2.2;
        p.g0 = 1.2;
        p.b0 = 0.35;
        p.r1 = 1.2;
        p.g1 = 0.25;
        p.b1 = 0.05;
        p.opacity = 1;
        p.fade = 1 / p.maxLife;
      });
    }

    this.fireSources.push({ x: ex, y: ey + 0.6, z: ez, strength: 0.4 + f * 0.6 });
  }

  /** A destroyed car's wreck keeps burning where it died. */
  wreck(x: number, y: number, z: number): void {
    this.wrecks.push({ x, y, z, life: DAMAGE_FX.wreckBurn, smoke: 0, fire: 0 });
  }

  update(dt: number, camera: THREE.Camera): void {
    this.time += dt;

    // ---- burning wrecks ---------------------------------------------------
    for (const w of this.wrecks) {
      w.life -= dt;
      const t = Math.max(0, w.life / DAMAGE_FX.wreckBurn); // 1 → 0 as it burns out
      w.smoke += (6 + 10 * t) * dt;
      while (w.smoke >= 1) {
        w.smoke -= 1;
        this.smoke.spawn((p) => {
          this.atCar(p, w.x, w.y + 0.5, w.z, { x: 0, y: 0, z: 0 }, 0.9);
          p.vy = rand(1.8, 2.8);
          p.drag = 1;
          p.gravity = -0.4;
          p.maxLife = p.life = rand(2.5, 3.5);
          p.size0 = 1.2;
          p.size1 = 5 + t * 2;
          p.r0 = 0.05;
          p.g0 = 0.03;
          p.b0 = 0.015;
          p.r1 = p.g1 = p.b1 = 0.012;
          p.opacity = 0.75 * (0.4 + 0.6 * t);
          p.fade = p.opacity / p.maxLife;
        });
      }
      w.fire += 26 * t * dt;
      while (w.fire >= 1) {
        w.fire -= 1;
        this.fire.spawn((p) => {
          this.atCar(p, w.x, w.y + 0.3, w.z, { x: 0, y: 0, z: 0 }, 1.3);
          p.vy = rand(2, 3.5);
          p.drag = 2.5;
          p.gravity = -1.5;
          p.maxLife = p.life = rand(0.4, 0.7);
          p.size0 = rand(0.6, 1.0) * (0.5 + 0.5 * t);
          p.size1 = 0.15;
          p.r0 = 1.0;
          p.g0 = 0.42;
          p.b0 = 0.08;
          p.r1 = 0.55;
          p.g1 = 0.08;
          p.b1 = 0.01;
          p.opacity = 0.55;
          p.fade = 0.55 / p.maxLife;
        });
      }
      if (t > 0.05) this.fireSources.push({ x: w.x, y: w.y + 1, z: w.z, strength: t });
    }
    this.wrecks = this.wrecks.filter((w) => w.life > 0);

    // ---- firelight: the strongest fires nearest the camera -------------------
    const cam = camera.position;
    this.fireSources.sort(
      (a, b) =>
        Math.hypot(a.x - cam.x, a.z - cam.z) / a.strength - Math.hypot(b.x - cam.x, b.z - cam.z) / b.strength,
    );
    this.lights.forEach((light, i) => {
      const source = this.fireSources[i];
      if (!source) {
        light.intensity = 0;
        return;
      }
      // Flicker: two incommensurate sines and a little noise.
      const flicker = 0.75 + 0.15 * Math.sin(this.time * 17 + i * 3) + 0.1 * Math.sin(this.time * 41 + i) + rand(-0.05, 0.05);
      light.position.set(source.x, source.y, source.z);
      light.intensity = DAMAGE_FX.fireLightIntensity * source.strength * flicker;
    });
    this.fireSources.length = 0;

    // Forget emitters for cars that are gone.
    for (const [id, e] of this.emitters) if (e.seen < this.frame - 2) this.emitters.delete(id);
    this.frame++;

    this.smoke.update(dt);
    this.fire.update(dt);
    this.embers.update(dt);
  }

  dispose(): void {
    this.smoke.dispose();
    this.fire.dispose();
    this.embers.dispose();
  }

  /** Place a particle at a point with a little scatter, carrying some of the car's motion. */
  private atCar(p: Particle, x: number, y: number, z: number, velocity: THREE.Vector3Like, scatter: number): void {
    p.x = x + rand(-scatter, scatter);
    p.y = y + rand(0, scatter * 0.4);
    p.z = z + rand(-scatter, scatter);
    // Particles inherit part of the car's motion, then drag slows them: at speed
    // the plume streams out behind the car rather than travelling with it.
    p.vx = velocity.x * 0.35 + rand(-0.3, 0.3);
    p.vz = velocity.z * 0.35 + rand(-0.3, 0.3);
    p.vy = 0;
  }
}
