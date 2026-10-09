/**
 * Cameras (DESIGN.md §7).
 *
 * Two of them, for two different questions, and they are not variations on a
 * theme:
 *
 *   `update`        the DRIVER's chase camera — a view **of** the car, orbiting
 *                   it. Every role that shared this camera got the same picture.
 *   `updateGunner`  the GUNNER's window camera — a view **from** the car,
 *                   anchored to one particular window on one particular side.
 *
 * The distinction is not cosmetic. A crosshair is only meaningful if the centre
 * of the screen is the world, and the chase camera's centre of screen is the
 * car. More importantly it is what makes the crew legible: a front-right gunner
 * and a rear-left gunner should not be looking at the same thing.
 *
 * Both are collision-aware: geometry between the car and the eye pulls the view
 * in rather than letting it sit inside a wall.
 */

import * as THREE from 'three';
import { CAMERA, FEEL, VEHICLE } from '../shared/config';
import { clamp, damp, wrapAngle } from '../shared/math';
import { seatPointWorld } from '../shared/combat';
import { WINDOW_EYE_OFFSET, type SeatDef } from '../shared/crews';
import type { VehicleState } from '../shared/vehicle';

export class CameraRig {
  private camYaw = 0;
  private ready = false;
  private raycaster = new THREE.Raycaster();
  private focal = new THREE.Vector3();
  private desired = new THREE.Vector3();
  private dir = new THREE.Vector3();
  private look = new THREE.Vector3();

  /**
   * The driver's chase camera: a view of the car from behind.
   *
   * Position is rigidly anchored to the car so it never lags behind at speed,
   * but the *heading* is damped — so when the car spins or drifts the camera
   * swings round smoothly instead of snapping.
   */
  update(
    camera: THREE.PerspectiveCamera,
    state: VehicleState,
    lookYaw: number,
    lookPitch: number,
    dt: number,
    obstacles: THREE.Object3D[],
  ): void {
    // The camera normally sits behind the car's HEADING, but blends towards the
    // direction of TRAVEL as the car slides.
    //
    // This matters more than it sounds. Following the heading alone means the
    // camera rotates with the car, keeping the car pinned to the centre of the
    // screen no matter how sideways it goes — so a drift was nearly invisible
    // even when the physics had the car sliding at 10 m/s. Letting the camera
    // swing towards the direction of travel is what makes the car visibly point
    // away from where it is going.
    let targetYaw = state.yaw;
    const travelSpeed = Math.hypot(state.vel.x, state.vel.z);
    if (travelSpeed > 4) {
      // Yaw of the velocity vector (forward is -Z at yaw 0).
      const travelYaw = Math.atan2(-state.vel.x, -state.vel.z);
      const slide = clamp(Math.abs(state.slipSpeed) / 12, 0, 1);
      targetYaw = state.yaw + wrapAngle(travelYaw - state.yaw) * slide * 0.75;
    }

    // Damp towards that target rather than snapping to it.
    if (!this.ready) {
      this.camYaw = targetYaw;
      this.ready = true;
    } else {
      const delta = wrapAngle(targetYaw - this.camYaw);
      this.camYaw = wrapAngle(this.camYaw + delta * (1 - Math.exp(-CAMERA.follow * dt)));
    }

    const yaw = this.camYaw + lookYaw;
    const pitch = clamp(CAMERA.pitch + lookPitch, CAMERA.minPitch, CAMERA.maxPitch);
    const cosPitch = Math.cos(pitch);

    this.focal.set(state.pos.x, state.pos.y + CAMERA.lookAtHeight, state.pos.z);
    this.desired.set(
      state.pos.x + Math.sin(yaw) * cosPitch * CAMERA.distance,
      state.pos.y + CAMERA.height + Math.sin(pitch) * CAMERA.distance,
      state.pos.z + Math.cos(yaw) * cosPitch * CAMERA.distance,
    );

    this.avoidGeometry(this.focal, obstacles, 1.4);

    camera.position.copy(this.desired);
    camera.lookAt(this.focal);
    this.applySpeedFov(camera, state, dt);
  }

  /**
   * The gunner's window camera: a head leaning out of a particular window.
   *
   * The position comes from the seat and the car's yaw alone, so the car holds
   * still in the frame and only the gaze moves. That is what "looking out of my
   * window" means, and it is why this cannot be a chase camera: a view anchored
   * to the *car* is the same view for every seat, which would make a four-crew
   * SUV three players sharing one perspective.
   *
   * Attitude (ramp pitch and roll) is deliberately ignored, matching the
   * simulation, which treats it as cosmetic. The anchor sits within half a metre
   * of the car's pitch and roll axes, so a 15° ramp moves it by about 6 cm — far
   * less than the error of having the camera disagree with the shot it is aiming.
   */
  updateGunner(
    camera: THREE.PerspectiveCamera,
    state: VehicleState,
    seat: SeatDef,
    aimYaw: number,
    aimPitch: number,
    dt: number,
    obstacles: THREE.Object3D[],
  ): void {
    // Rigid, not damped. A head in a window moves with the car; smoothing here
    // would slide the camera off its own window in every corner.
    const anchor = seatPointWorld(state, seat, WINDOW_EYE_OFFSET[seat.side]);
    this.desired.set(anchor.x, anchor.y, anchor.z);

    // If the car is pressed against a wall, the window itself is inside it. Pull
    // the view in toward the car rather than rendering the inside of a wall.
    this.focal.set(state.pos.x, state.pos.y + CAMERA.lookAtHeight, state.pos.z);
    this.avoidGeometry(this.focal, obstacles, 0.5);

    camera.position.copy(this.desired);

    // Look along the aim. Aim yaw is car-relative — it is clamped to the
    // window's arc — so the gaze turns with the car, which is correct: the arc
    // is exactly what this window can reach.
    const yaw = state.yaw + aimYaw;
    const cosPitch = Math.cos(aimPitch);
    // LOOK PITCH CONVENTION: positive means the player moved the mouse DOWN, so
    // the view pitches down. Every camera must agree or the look inverts when
    // you change seat — which is exactly the bug this negates. The chase camera
    // already follows this (a positive pitch raises it to look down); the
    // window and solo cameras look along the aim and so must negate.
    this.look.set(
      this.desired.x - Math.sin(yaw) * cosPitch,
      this.desired.y - Math.sin(aimPitch),
      this.desired.z - Math.cos(yaw) * cosPitch,
    );
    camera.lookAt(this.look);
    this.applySpeedFov(camera, state, dt);
  }

  /**
   * The solo brawler's camera: a view FORWARD of the car, aligned to its guns.
   *
   * The driver of a one-man team drives and shoots at once (DESIGN.md §2.3), so
   * this camera has to do two jobs the other two cannot do alone. The chase
   * camera keeps the car centred, which would put the crosshair on the car; the
   * window camera is a view FROM a seat, which would hide the car you are
   * driving. This sits behind and above and looks where the gun points: the car
   * stays in the lower frame, the crosshair is the world, and the aim is rigid
   * rather than damped — a lagging crosshair is a crosshair that lies.
   */
  /** Smoothed solo camera position, and whether it has been placed yet. */
  private soloPos = new THREE.Vector3();
  private soloReady = false;

  // ---- feel of speed (Phase 8) -------------------------------------------
  /** Last frame's forward speed, for acceleration. */
  private lastSpeed = 0;
  /** Smoothed fall-back (+) / push-in (−) from acceleration, metres. */
  private accelLag = 0;
  /** Running clock for the shake's noise. */
  private shakeTime = 0;
  /** Landing dip, metres, decaying; and whether we were airborne last frame. */
  private jolt = 0;
  private wasAirborne = false;
  private lastVy = 0;
  private boostFov = 0;

  updateSolo(
    camera: THREE.PerspectiveCamera,
    state: VehicleState,
    aimYaw: number,
    aimPitch: number,
    dt: number,
    obstacles: THREE.Object3D[],
    feel: { boosting: boolean; offroad: boolean } = { boosting: false, offroad: false },
  ): void {
    const yaw = state.yaw + aimYaw;
    const pitch = clamp(aimPitch, -0.9, 0.9);
    const cosPitch = Math.cos(pitch);

    // Where the guns point. Pitch negated to match the LOOK PITCH CONVENTION in
    // `updateGunner`: positive input means mouse-down, which looks down.
    this.dir.set(-Math.sin(yaw) * cosPitch, -Math.sin(pitch), -Math.cos(yaw) * cosPitch);

    // The look target must be built BEFORE `avoidGeometry`, which uses `this.dir`
    // as scratch. Reading the aim direction afterwards silently pointed the
    // camera backwards — away from the car — which is only obvious by measuring
    // where the car projects on screen, not by looking at the frame.
    this.look.set(
      state.pos.x + this.dir.x * CAMERA.soloLookAhead,
      state.pos.y + this.dir.y * CAMERA.soloLookAhead + CAMERA.soloAimHeight,
      state.pos.z + this.dir.z * CAMERA.soloLookAhead,
    );

    // FEEL OF SPEED: accelerating pulls the camera back (the car leaps away
    // from it), braking lets it close in. Smoothed acceleration, clamped.
    if (dt > 0) {
      const accel = (state.forwardSpeed - this.lastSpeed) / dt;
      const target = clamp(accel * FEEL.camera.accelLag, -FEEL.camera.accelLagMax, FEEL.camera.accelLagMax);
      this.accelLag = damp(this.accelLag, target, 3, dt);
    }
    this.lastSpeed = state.forwardSpeed;
    // Landing: a dip proportional to how hard it came down, springing back.
    const airborne = state.airborneTicks > 0;
    if (this.wasAirborne && !airborne) this.jolt = Math.min(0.9, Math.abs(Math.min(0, this.lastVy)) * FEEL.camera.landingJolt);
    this.wasAirborne = airborne;
    this.lastVy = state.vel.y;
    this.jolt = damp(this.jolt, 0, 7, dt);
    const distance = CAMERA.soloDistance + this.accelLag;

    // Placement uses the HORIZONTAL aim only, so looking down does not drop the
    // camera into the ground and looking up does not lift it into the sky.
    this.desired.set(
      state.pos.x + Math.sin(yaw) * distance,
      state.pos.y + CAMERA.soloHeight + Math.sin(pitch) * 1.6 - this.jolt,
      state.pos.z + Math.cos(yaw) * distance,
    );

    this.focal.set(state.pos.x, state.pos.y + CAMERA.lookAtHeight, state.pos.z);
    this.avoidGeometry(this.focal, obstacles, 1.2);

    // Position FOLLOWS (critically damped), aim does not: a rigid camera passed
    // every suspension bump and network correction straight into the view, which
    // is most of why aiming felt jittery. The look target stays exact, so the
    // crosshair is still exactly where the mouse put it. Snap on a teleport.
    if (!this.soloReady || this.soloPos.distanceTo(this.desired) > 12) {
      this.soloPos.copy(this.desired);
      this.soloReady = true;
    } else {
      this.soloPos.lerp(this.desired, 1 - Math.exp(-CAMERA.soloFollow * dt));
    }
    camera.position.copy(this.soloPos);

    // Speed shake: a little positional rumble that grows with speed², rougher
    // off-road and when boosting. Position only — the camera still looks at the
    // exact aim point, so the crosshair stays honest.
    this.shakeTime += dt;
    const speedFraction = clamp(Math.abs(state.forwardSpeed) / VEHICLE.maxSpeed, 0, 1.6);
    const shake =
      FEEL.camera.speedShake * speedFraction * speedFraction * (feel.offroad ? 1.8 : 1) * (feel.boosting ? 1.6 : 1);
    if (shake > 1e-4 && state.onGround) {
      const t = this.shakeTime;
      camera.position.x += (Math.sin(t * 37.1) + Math.sin(t * 23.3 + 1.3)) * shake * 0.5;
      camera.position.y += (Math.sin(t * 41.7 + 0.7) + Math.sin(t * 29.9 + 2.1)) * shake * 0.5;
      camera.position.z += Math.sin(t * 33.3 + 2.9) * shake * 0.5;
    }

    camera.lookAt(this.look);
    this.boostFov = damp(this.boostFov, feel.boosting ? FEEL.camera.boostFov : 0, 5, dt);
    this.applySpeedFov(camera, state, dt, this.boostFov);
  }

  /**
   * Pull the camera in toward the car if geometry is in the way.
   *
   * `origin` is the car itself, so the answer is "what is between the car and
   * this camera", which is the only thing that matters. `minDistance` is how
   * close the camera may be forced before the pull-in stops: a chase camera can
   * come all the way in, but a window camera must not be dragged into the cabin
   * it is supposed to be looking out of.
   */
  private avoidGeometry(
    origin: THREE.Vector3,
    obstacles: THREE.Object3D[],
    minDistance: number,
  ): void {
    if (!obstacles.length) return;

    this.dir.copy(this.desired).sub(origin);
    const distance = this.dir.length();
    if (distance < 1e-3) return;

    this.dir.divideScalar(distance);
    this.raycaster.set(origin, this.dir);
    this.raycaster.far = distance;
    const hits = this.raycaster.intersectObjects(obstacles, true);
    if (hits.length === 0) return;

    const safe = Math.max(minDistance, hits[0].distance - 0.4);
    this.desired.copy(origin).addScaledVector(this.dir, safe);
  }

  /** A little FOV stretch at speed sells the velocity. */
  private applySpeedFov(
    camera: THREE.PerspectiveCamera,
    state: VehicleState,
    dt: number,
    extra = 0,
  ): void {
    const speedFraction = clamp(Math.abs(state.forwardSpeed) / VEHICLE.maxSpeed, 0, 1);
    const targetFov = CAMERA.fov + CAMERA.speedFovGain * speedFraction * speedFraction + extra;
    const nextFov = damp(camera.fov, targetFov, 6, dt);
    if (Math.abs(nextFov - camera.fov) > 0.01) {
      camera.fov = nextFov;
      camera.updateProjectionMatrix();
    }
  }
}
