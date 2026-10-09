/**
 * Driving effects (Phase 8, feel of speed): what the WHEELS and the EXHAUST do.
 *
 *   - dust: dirt kicked up behind the wheels, thicker with speed and slip;
 *   - tyre smoke: on hard ground (asphalt, concrete), only while sliding;
 *   - sparks: a shower where a hard impact happened;
 *   - boost: flame and heat from the tailpipes while boosting.
 *
 * Every car gets them (a dust plume is how you spot a car across the arena),
 * from three instanced pools shared by all cars — three draw calls in total.
 * World-space and cosmetic: nothing here touches the simulation.
 */

import * as THREE from 'three';
import { SOLIDS, surfaceTopAt } from '../shared/arena';
import { FEEL, VEHICLE } from '../shared/config';
import type { VehicleState } from '../shared/vehicle';
import { surfaceOf } from './arenaSurfaces';
import { ParticlePool, softTexture, type Particle } from './explosions';

export type Ground = 'dirt' | 'hard';

/**
 * What the car is driving on, from the arena's ground pieces: the highest one
 * under the point. Dirt is anything the arena draws matte (mud, sand, gravel).
 */
export function groundAt(x: number, z: number): Ground {
  let top = -Infinity;
  let colour: number | null = null;
  for (const solid of SOLIDS) {
    if (!solid.ground) continue;
    const y = surfaceTopAt(solid, x, z);
    if (y !== null && y > top) {
      top = y;
      colour = solid.color;
    }
  }
  return colour !== null && surfaceOf(colour)?.matte ? 'dirt' : 'hard';
}

const rand = (a: number, b: number): number => a + Math.random() * (b - a);

type Emitter = { dust: number; flame: number; seen: number; ground: Ground; groundAge: number };

export class DriveFx {
  readonly object = new THREE.Group();
  private readonly dust: ParticlePool;
  private readonly sparks: ParticlePool;
  private readonly flame: ParticlePool;
  private readonly emitters = new Map<number, Emitter>();
  private readonly v = new THREE.Vector3();
  private readonly back = new THREE.Vector3();
  private frame = 0;

  constructor() {
    this.object.name = 'drive-fx';
    const soft = softTexture();
    this.dust = new ParticlePool(500, soft, THREE.NormalBlending, 2);
    this.sparks = new ParticlePool(220, soft, THREE.AdditiveBlending, 5);
    this.flame = new ParticlePool(160, soft, THREE.AdditiveBlending, 4);
    this.dust.mesh.name = 'drive-dust';
    this.sparks.mesh.name = 'drive-sparks';
    this.flame.mesh.name = 'drive-flame';
    this.object.add(this.dust.mesh, this.sparks.mesh, this.flame.mesh);
  }

  /**
   * One car, this frame.
   *
   * @param root      the car's root (its world matrix places wheels and pipes)
   * @param tail      car-local tail-light anchor; the pipes sit under it
   * @param boosting  boost engaged (for remote cars: over the normal top speed)
   */
  emit(id: number, root: THREE.Object3D, state: VehicleState, tail: THREE.Vector3, boosting: boolean, dt: number): void {
    let e = this.emitters.get(id);
    if (!e) this.emitters.set(id, (e = { dust: 0, flame: 0, seen: 0, ground: 'hard', groundAge: 1 }));
    e.seen = this.frame;
    const matrix = root.matrixWorld;
    const spec = state.spec;
    const speed = Math.abs(state.forwardSpeed);
    const slip = Math.abs(state.slipSpeed);

    // Ground: sampled a few times a second, not every frame — it is a scan.
    e.groundAge += dt;
    if (e.groundAge > 0.2) {
      e.groundAge = 0;
      e.ground = groundAt(state.pos.x, state.pos.z);
    }

    // ---- wheels: dust on dirt, tyre smoke on hard ground while sliding -------
    if (state.onGround) {
      const dirt = e.ground === 'dirt';
      const k = dirt
        ? Math.min(1, speed / VEHICLE.maxSpeed) + Math.min(1, slip / 8) * 0.8
        : slip > FEEL.dust.smokeSlip
          ? Math.min(1.4, (slip - FEEL.dust.smokeSlip) / 6)
          : 0;
      e.dust += FEEL.dust.rate * 2 * k * dt; // two rear wheels
      const wheelY = -(spec.rideHeight - spec.wheelRadius) - spec.wheelRadius * 0.6;
      let side = 1;
      while (e.dust >= 1) {
        e.dust -= 1;
        side = -side;
        const p = this.v.set((side * spec.track) / 2, wheelY, spec.wheelbase / 2 + 0.2).applyMatrix4(matrix);
        this.dust.spawn((q) => {
          this.place(q, p, 0.25);
          // Thrown up and back, then hanging in the air: most of the car's
          // speed is NOT inherited, so the plume trails behind it.
          q.vx = state.vel.x * 0.15 + rand(-1, 1);
          q.vz = state.vel.z * 0.15 + rand(-1, 1);
          q.vy = rand(0.6, 1.8) + k * 0.8;
          q.drag = 1.6;
          q.gravity = dirt ? 0.25 : -0.1;
          q.maxLife = q.life = dirt ? rand(1.2, 2.2) : rand(0.8, 1.4);
          q.size0 = rand(0.5, 0.9);
          q.size1 = dirt ? rand(3.2, 5) : rand(2.2, 3.4);
          // Linear colours (converted to sRGB on output): floodlit tan dust, or
          // pale grey tyre smoke. Lit-looking, or at night they read as nothing.
          if (dirt) {
            q.r0 = 0.42;
            q.g0 = 0.3;
            q.b0 = 0.18;
          } else {
            q.r0 = q.g0 = q.b0 = 0.5;
          }
          q.r1 = q.r0 * 0.8;
          q.g1 = q.g0 * 0.8;
          q.b1 = q.b0 * 0.8;
          q.opacity = (dirt ? 0.5 : 0.45) * Math.min(1, 0.4 + k);
          q.fade = q.opacity / q.maxLife;
        });
      }
    } else {
      e.dust = 0;
    }

    // ---- sparks: a hard hit (wall, block, another car) ---------------------
    if (state.impact > 3) {
      // Where the car is heading into: its nose, roughly.
      const p = this.v.set(0, -0.1, -spec.halfLength).applyMatrix4(matrix);
      const n = Math.min(40, Math.round(state.impact * 2.5));
      for (let i = 0; i < n; i++) {
        this.sparks.spawn((q) => {
          this.place(q, p, 0.6);
          q.vx = rand(-7, 7);
          q.vz = rand(-7, 7);
          q.vy = rand(1.5, 7);
          q.drag = 0.6;
          q.gravity = 14;
          q.maxLife = q.life = rand(0.25, 0.6);
          q.size0 = rand(0.07, 0.12);
          q.size1 = 0.02;
          q.r0 = 2.6;
          q.g0 = 1.6;
          q.b0 = 0.6;
          q.r1 = 1.4;
          q.g1 = 0.4;
          q.b1 = 0.05;
          q.opacity = 1;
          q.fade = 1 / q.maxLife;
        });
      }
    }

    // ---- boost: flame from the pipes ---------------------------------------
    if (boosting) {
      e.flame += 110 * dt;
      while (e.flame >= 1) {
        e.flame -= 1;
        const side = Math.random() < 0.5 ? -1 : 1;
        const p = this.v.set(side * tail.x * 0.55, tail.y - 0.3, tail.z + 0.1).applyMatrix4(matrix);
        this.flame.spawn((q) => {
          this.place(q, p, 0.05);
          // Blown out backwards relative to the car: start at the car's own
          // velocity, then shoot rearward.
          const back = this.back.set(0, 0, 1).transformDirection(matrix);
          q.vx = state.vel.x + back.x * rand(6, 10);
          q.vy = state.vel.y + rand(-0.2, 0.4);
          q.vz = state.vel.z + back.z * rand(6, 10);
          q.drag = 6;
          q.gravity = -1;
          q.maxLife = q.life = rand(0.18, 0.3);
          q.size0 = rand(0.6, 0.9);
          q.size1 = 0.15;
          // Hot core to orange: blue-white at the pipe, as a boost should be.
          q.r0 = 1.1;
          q.g0 = 1.0;
          q.b0 = 1.6;
          q.r1 = 1.2;
          q.g1 = 0.35;
          q.b1 = 0.05;
          q.opacity = 0.75;
          q.fade = 0.75 / q.maxLife;
        });
      }
    } else {
      e.flame = 0;
    }
  }

  /** The ground last sampled under a car (for the camera and the road sound). */
  groundOf(id: number): Ground {
    return this.emitters.get(id)?.ground ?? 'hard';
  }

  update(dt: number): void {
    for (const [id, e] of this.emitters) if (e.seen < this.frame - 2) this.emitters.delete(id);
    this.frame++;
    this.dust.update(dt);
    this.sparks.update(dt);
    this.flame.update(dt);
  }

  dispose(): void {
    this.dust.dispose();
    this.sparks.dispose();
    this.flame.dispose();
  }

  private place(q: Particle, p: THREE.Vector3, scatter: number): void {
    q.x = p.x + rand(-scatter, scatter);
    q.y = p.y + rand(0, scatter * 0.5);
    q.z = p.z + rand(-scatter, scatter);
  }
}
