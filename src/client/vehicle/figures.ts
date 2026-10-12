/**
 * The people in the cars: a driver behind every wheel and, in duos and squads,
 * gunners who sit tucked in and LEAN OUT of their window to aim.
 *
 * Each outfit is a skinned model on the same (Mixamo) skeleton, prepared by
 * scripts/prep/characters.ts. Nothing is animated from clips: every frame the
 * skeleton is posed from what the person is doing — seated, hands on the
 * wheel; holding their gun in their lap; out of the window from the waist up,
 * twisted to their aim with the gun at the shoulder; slumped when knocked down.
 *
 * Posing is by direction, so it does not care how a model's bones are oriented
 * locally: each limb is turned (shortest arc, in world space) to point where it
 * should, and arms and legs reach their targets with a two-bone IK.
 * Car frame throughout: x right, y up, -z forward.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { COMBAT } from '../../shared/config';
import { OUTFITS } from '../../shared/cosmetics';
import type { WeaponId } from '../../shared/weapons';

/** What one seat's person is doing, for `Figure.pose`. */
export type FigurePose = {
  role: 'driver' | 'gunner';
  /** Which window a gunner leans out of. */
  side: 'left' | 'right';
  /** Where their hips sit (on the seat), car frame. */
  hip: THREE.Vector3;
  /**
   * Where the hips go up on the window sill to shoot over the roof, car frame,
   * and how far up there they are for this aim (0 at the window … 1 over the
   * roof; `roofAmount`).
   */
  sill: THREE.Vector3;
  roof: number;
  /** Aim relative to the car's nose (+ = left) and pitch (+ = up), radians. */
  yaw: number;
  pitch: number;
  /** Leaning out of the window to aim (held aim). */
  out: boolean;
  alive: boolean;
  /** What a gunner holds (null: empty hands, e.g. the driver). */
  gun: WeaponId | null;
  /** Reloading the gun in hand. */
  reload: boolean;
};

/**
 * Where the hands go on each gun, in metres from the butt: across, up, and
 * along the barrel. The rear hand on the grip, the front hand on the handguard
 * (or pump, or foregrip), and the magazine for a reload.
 */
const GRIPS: Record<WeaponId, { grip: [number, number, number]; fore: [number, number, number]; mag: [number, number, number] }> = {
  rifle: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  marksman: { grip: [0, -0.08, 0.3], fore: [0, -0.02, 0.62], mag: [0, -0.1, 0.42] },
  shotgun: { grip: [0, -0.06, 0.3], fore: [0, -0.04, 0.6], mag: [0, -0.03, 0.42] },
  launcher: { grip: [0, -0.1, 0.27], fore: [0, -0.12, 0.5], mag: [0, -0.03, 0.4] },
  mg: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  rocket: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  scatter: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  lancer: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  swarm: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
};
/** Seconds to put one gun away and bring the other up. */
const SWAP_SECONDS = 0.45;

// ------------------------------------------------------------------ library

type Outfit = { scene: THREE.Object3D; tintable: Set<string> };

/** Loads the outfits (once) and makes figures from them. */
export class FigureLibrary {
  private readonly outfits = new Map<number, Outfit>();
  /** The hand-held guns (scripts/prep/hand-guns.ts): butt at the origin, barrel -Z. */
  private readonly guns = new Map<WeaponId, THREE.Object3D>();
  private pending: Promise<void> | null = null;

  constructor(private readonly loader: GLTFLoader) {}

  /** Download every outfit. Figures are only drawn once this has resolved. */
  load(): Promise<void> {
    if (!this.pending) {
      this.pending = Promise.all(
        OUTFITS.map(async (outfit, index) => {
          try {
            const gltf = await this.loader.loadAsync(`/assets/characters/${outfit.id}/figure.glb`);
            const tintable = new Set<string>();
            gltf.scene.traverse((o) => {
              const mesh = o as THREE.SkinnedMesh;
              if (!mesh.isMesh) return;
              mesh.castShadow = false;
              mesh.receiveShadow = true;
              mesh.frustumCulled = false; // a posed skin's bounds are stale
              const material = mesh.material as THREE.MeshStandardMaterial;
              // The suit (not skin, gloves, glass or kit) takes the paint colour.
              if (/suit/i.test(material.name)) tintable.add(material.name);
            });
            this.outfits.set(index, { scene: gltf.scene, tintable });
          } catch (error) {
            console.warn(`[figures] ${outfit.id} failed to load`, error);
          }
        }),
      )
        .then(() =>
          Promise.all(
            (['rifle', 'shotgun', 'marksman', 'launcher'] as const).map(async (id) => {
              try {
                const gltf = await this.loader.loadAsync(`/assets/weapons/hand-${id}/gun.glb`);
                gltf.scene.traverse((o) => {
                  const mesh = o as THREE.Mesh;
                  if (mesh.isMesh) mesh.castShadow = false;
                });
                this.guns.set(id, gltf.scene);
              } catch (error) {
                console.warn(`[figures] the ${id} failed to load; drawing a plain one`, error);
              }
            }),
          ),
        )
        .then(() => undefined);
    }
    return this.pending;
  }

  get ready(): boolean {
    return this.outfits.size > 0;
  }

  /** A new figure wearing `outfit`, its suit tinted toward `tint`; null until loaded. */
  create(outfit: number, tint: number): Figure | null {
    const source = this.outfits.get(outfit) ?? this.outfits.values().next().value;
    if (!source) return null;
    return new Figure(cloneSkinned(source.scene), source.tintable, tint, (id) => this.guns.get(id)?.clone() ?? handGun(id));
  }
}

// ------------------------------------------------------------------- guns

const gunMetal = new THREE.MeshStandardMaterial({
  color: 0x24282d,
  roughness: 0.45,
  metalness: 0.7,
});
const furniture = new THREE.MeshStandardMaterial({
  color: 0x3b3d33,
  roughness: 0.7,
  metalness: 0.2,
});
const tubeGreen = new THREE.MeshStandardMaterial({
  color: 0x4a5236,
  roughness: 0.6,
  metalness: 0.3,
});

/** A hand-held gun along -Z, its butt at the origin (the shoulder). */
function handGun(weapon: WeaponId): THREE.Group {
  const g = new THREE.Group();
  const add = (geometry: THREE.BufferGeometry, material: THREE.Material): void => {
    g.add(new THREE.Mesh(geometry, material));
  };
  const tube = (r: number, z0: number, z1: number, y = 0): THREE.BufferGeometry =>
    new THREE.CylinderGeometry(r, r, z1 - z0, 10).rotateX(Math.PI / 2).translate(0, y, -(z0 + z1) / 2);
  if (weapon === 'launcher') {
    add(tube(0.05, 0.0, 0.62), tubeGreen);
    add(tube(0.065, 0.48, 0.66), tubeGreen);
    add(new THREE.BoxGeometry(0.03, 0.1, 0.05).translate(0, -0.08, -0.22), gunMetal);
    return g;
  }
  const length = weapon === 'marksman' ? 1.0 : weapon === 'shotgun' ? 0.82 : 0.78;
  add(new THREE.BoxGeometry(0.045, 0.1, 0.2).translate(0, -0.02, -0.1), furniture); // stock
  add(new THREE.BoxGeometry(0.055, 0.09, 0.32).translate(0, 0, -0.36), gunMetal); // receiver
  add(tube(weapon === 'shotgun' ? 0.022 : 0.013, 0.52, length), gunMetal); // barrel
  add(new THREE.BoxGeometry(0.03, 0.09, 0.05).translate(0, -0.08, -0.3), gunMetal); // grip
  if (weapon === 'rifle') add(new THREE.BoxGeometry(0.035, 0.13, 0.06).rotateX(0.2).translate(0, -0.1, -0.42), gunMetal);
  if (weapon === 'shotgun') add(tube(0.03, 0.5, 0.68, -0.045), furniture); // pump
  if (weapon === 'marksman') add(tube(0.022, 0.3, 0.52, 0.075), gunMetal); // scope
  return g;
}

// ------------------------------------------------------------------ figure

const _a = new THREE.Vector3();
const _b = new THREE.Vector3();
const _d = new THREE.Vector3();
const _q = new THREE.Quaternion();
const _w = new THREE.Quaternion();
const _p = new THREE.Quaternion();

/** Turn `bone` (in world space, shortest arc) so it points from itself toward `child` along `dir`. */
function aimBone(bone: THREE.Object3D, child: THREE.Object3D, dirWorld: THREE.Vector3): void {
  aimBoneAt(bone, child.getWorldPosition(new THREE.Vector3()), dirWorld);
}

/** Turn `bone` so the world point `point` (which moves with it) lies along `dir` from it. */
function aimBoneAt(bone: THREE.Object3D, point: THREE.Vector3, dirWorld: THREE.Vector3): void {
  bone.getWorldPosition(_a);
  _b.copy(point);
  _d.subVectors(_b, _a);
  if (_d.lengthSq() < 1e-10 || dirWorld.lengthSq() < 1e-10) return;
  _q.setFromUnitVectors(_d.normalize(), _b.copy(dirWorld).normalize());
  bone.getWorldQuaternion(_w);
  _w.premultiply(_q);
  bone.parent!.getWorldQuaternion(_p);
  bone.quaternion.copy(_p.invert().multiply(_w));
  bone.updateMatrixWorld(true);
}

/** Turn `bone` about the world axis by `angle`. */
function twistBone(bone: THREE.Object3D, axisWorld: THREE.Vector3, angle: number): void {
  bone.getWorldQuaternion(_w);
  _w.premultiply(_q.setFromAxisAngle(axisWorld, angle));
  bone.parent!.getWorldQuaternion(_p);
  bone.quaternion.copy(_p.invert().multiply(_w));
  bone.updateMatrixWorld(true);
}

/**
 * Two bones to a reach point: the end joint (a foot), or a point held in the
 * middle bone's frame (a palm — where the hand is DRAWN, which in these
 * downloads is not where the hand joint is).
 */
type Limb = {
  root: THREE.Bone;
  mid: THREE.Bone;
  end: THREE.Bone;
  a: number;
  b: number;
  endLocal: THREE.Vector3 | null;
};

const SPINE = ['Spine', 'Spine1', 'Spine2', 'Neck'] as const;

export class Figure {
  readonly root = new THREE.Group();
  private readonly bones = new Map<string, THREE.Bone>();
  private readonly rest = new Map<THREE.Bone, THREE.Quaternion>();
  private readonly hipsRest = new THREE.Vector3();
  private readonly arms: { left: Limb; right: Limb };
  private readonly legs: { left: Limb; right: Limb };
  private readonly gunHolder = new THREE.Group();
  private gunId: WeaponId | null = null;
  /** The gun being swapped in (undefined: no swap under way). */
  private pendingGun: WeaponId | null | undefined = undefined;
  /** 1 → 0 through a swap. */
  private swap = 0;
  /** The kick of recent shots, decaying. */
  private recoil = 0;
  private reloadPhase = 0;
  private time = 0;
  /** Each person sways out of step with the others. */
  private readonly phase = Math.random() * Math.PI * 2;
  /** 0 tucked in … 1 out of the window, eased toward the wanted state. */
  private lean = 0;
  /** 0 at the window … 1 up on the sill over the roof, eased toward the aim's. */
  private roof = 0;
  private readonly tinted: THREE.Material[] = [];

  constructor(
    model: THREE.Object3D,
    tintable: Set<string>,
    tint: number,
    private readonly makeGun: (id: WeaponId) => THREE.Object3D = handGun,
  ) {
    this.root.name = 'figure';
    this.root.add(model, this.gunHolder);
    const paint = new THREE.Color(0xffffff).lerp(new THREE.Color(tint), 0.6);
    const materials = new Map<THREE.Material, THREE.Material>();
    model.traverse((o) => {
      if ((o as THREE.Bone).isBone) {
        const bone = o as THREE.Bone;
        this.bones.set(bone.name, bone);
        this.rest.set(bone, bone.quaternion.clone());
      }
      const mesh = o as THREE.Mesh;
      if (mesh.isMesh && tintable.has((mesh.material as THREE.Material).name)) {
        const source = mesh.material as THREE.MeshStandardMaterial;
        let own = materials.get(source);
        if (!own) {
          own = source.clone();
          (own as THREE.MeshStandardMaterial).color.multiply(paint);
          materials.set(source, own);
          this.tinted.push(own);
        }
        mesh.material = own;
      }
    });
    this.root.updateMatrixWorld(true);
    this.bone('Hips').getWorldPosition(this.hipsRest);
    this.root.worldToLocal(this.hipsRest);
    const limb = (root: string, mid: string, end: string): Limb => {
      const r = this.bone(root);
      const m = this.bone(mid);
      const e = this.bone(end);
      return {
        root: r,
        mid: m,
        end: e,
        a: r.getWorldPosition(new THREE.Vector3()).distanceTo(m.getWorldPosition(new THREE.Vector3())),
        b: m.getWorldPosition(new THREE.Vector3()).distanceTo(e.getWorldPosition(new THREE.Vector3())),
        endLocal: null,
      };
    };
    this.arms = {
      left: limb('LeftArm', 'LeftForeArm', 'LeftHand'),
      right: limb('RightArm', 'RightForeArm', 'RightHand'),
    };
    // Where each palm is drawn: the skinned vertices the hand bone drives.
    for (const [arm, name] of [
      [this.arms.left, 'LeftHand'],
      [this.arms.right, 'RightHand'],
    ] as const) {
      const sum = new THREE.Vector3();
      let n = 0;
      const v = new THREE.Vector3();
      model.traverse((o) => {
        const mesh = o as THREE.SkinnedMesh;
        if (!mesh.isSkinnedMesh) return;
        const index = mesh.skeleton.bones.findIndex((b) => b.name === name);
        if (index < 0) return;
        mesh.skeleton.update();
        const J = mesh.geometry.attributes.skinIndex;
        const W = mesh.geometry.attributes.skinWeight;
        for (let i = 0; i < W.count; i++) {
          let best = 0;
          for (let k = 1; k < 4; k++) if (W.getComponent(i, k) > W.getComponent(i, best)) best = k;
          if (J.getComponent(i, best) !== index) continue;
          mesh.getVertexPosition(i, v);
          sum.add(v.applyMatrix4(mesh.matrixWorld));
          n++;
        }
      });
      if (n > 0) {
        const palm = sum.divideScalar(n);
        arm.endLocal = arm.mid.worldToLocal(palm.clone());
        arm.b = arm.mid.getWorldPosition(new THREE.Vector3()).distanceTo(palm);
      }
    }
    this.legs = {
      left: limb('LeftUpLeg', 'LeftLeg', 'LeftFoot'),
      right: limb('RightUpLeg', 'RightLeg', 'RightFoot'),
    };
  }

  private bone(name: string): THREE.Bone {
    const bone = this.bones.get(name);
    if (!bone) throw new Error(`figure has no ${name} bone`);
    return bone;
  }

  /** Reach `limb`'s end to `target` (world), the middle joint bending toward `pole` (world dir). */
  private reach(limb: Limb, target: THREE.Vector3, pole: THREE.Vector3): void {
    const s = limb.root.getWorldPosition(new THREE.Vector3());
    const toTarget = target.clone().sub(s);
    const d = Math.min(toTarget.length(), (limb.a + limb.b) * 0.999);
    const axis = toTarget.normalize();
    // Elbow/knee: along the axis by x, off it toward the pole by h.
    const x = (limb.a * limb.a - limb.b * limb.b + d * d) / (2 * d);
    const h = Math.sqrt(Math.max(0, limb.a * limb.a - x * x));
    const bend = pole
      .clone()
      .sub(axis.clone().multiplyScalar(pole.dot(axis)))
      .normalize();
    const joint = s.clone().addScaledVector(axis, x).addScaledVector(bend, h);
    const end = s.clone().addScaledVector(axis, d);
    aimBone(limb.root, limb.mid, joint.clone().sub(s));
    if (limb.endLocal) aimBoneAt(limb.mid, limb.mid.localToWorld(limb.endLocal.clone()), end.sub(joint));
    else aimBone(limb.mid, limb.end, end.sub(joint));
  }

  /** Pose for this frame. The figure must be a child of the car's root. */
  pose(p: FigurePose, dt: number): void {
    const car = this.root.parent;
    if (!car) return;
    const want = p.role === 'gunner' && p.alive && p.out ? 1 : 0;
    const step = dt / COMBAT.leanSeconds;
    this.lean = want > this.lean ? Math.min(want, this.lean + step) : Math.max(want, this.lean - step * 1.5);
    const lean = this.lean * this.lean * (3 - 2 * this.lean); // eased
    const side = p.side === 'right' ? 1 : -1;

    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    // Hips on the seat; leaning out shifts them a little up and toward the
    // window — the person stays seated and leans out from the waist.
    // Aiming across the car they climb onto the sill instead and shoot over
    // the roof (eased in with the lean, and as the aim swings across).
    this.roof += (p.roof - this.roof) * Math.min(1, dt * 8);
    const roof = this.roof * lean;
    const window = p.hip.clone().add(new THREE.Vector3(side * 0.25 * lean, 0.5 * lean, 0));
    const hip = window.lerp(p.sill, roof);
    this.root.position.copy(hip).sub(this.hipsRest);
    this.root.updateMatrixWorld(true);

    // Development: `window.__figureRest = true` shows the model unposed.
    if (import.meta.env.DEV && (window as unknown as { __figureRest?: boolean }).__figureRest) return;
    car.updateMatrixWorld();
    const toWorldDir = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).transformDirection(car.matrixWorld);
    const toWorld = (v: THREE.Vector3): THREE.Vector3 => v.clone().applyMatrix4(car.matrixWorld);
    const carUp = toWorldDir(0, 1, 0);

    // Legs: seated, knees forward, feet on the floor ahead of the seat.
    for (const [limb, sx] of [
      [this.legs.left, -1],
      [this.legs.right, 1],
    ] as const) {
      // Up on the sill the feet stay inside, on the seat, knees bent inward.
      const seated = p.hip.clone().add(new THREE.Vector3(sx * 0.16, -0.3, -0.62));
      const onSeat = p.hip.clone().add(new THREE.Vector3(sx * 0.14 - side * 0.05, 0.02, -0.28));
      const foot = toWorld(seated.lerp(onSeat, roof));
      this.reach(limb, foot, toWorldDir(-side * 0.8 * roof, 0.4 - 0.2 * roof, -1 + 0.4 * roof));
    }

    // Spine: upright (a little reclined); out of the window it bends outward;
    // knocked down it slumps forward.
    // Over the roof the body is upright, leaning in over it.
    const spineDir = !p.alive
      ? toWorldDir(0.1 * side, 0.55, -0.8)
      : toWorldDir(side * (0.6 * lean * (1 - roof) - 0.35 * roof), 1, 0.3 * (1 - lean));
    for (let i = 0; i < SPINE.length - 1; i++) aimBone(this.bone(SPINE[i]), this.bone(SPINE[i + 1]), spineDir);

    // Aim, car frame (+yaw = left).
    const cosP = Math.cos(p.pitch);
    const aim = new THREE.Vector3(-Math.sin(p.yaw) * cosP, Math.sin(p.pitch), -Math.cos(p.yaw) * cosP);
    const aimWorld = aim.clone().transformDirection(car.matrixWorld);
    if (lean > 0) {
      // Turn the chest toward the aim (about the car's up), the head the rest.
      const flat = Math.atan2(-aim.x, -aim.z); // yaw from forward, + = left
      twistBone(this.bone('Spine2'), carUp, flat * 0.75 * lean);
    }
    const headDir = !p.alive
      ? toWorldDir(0, -0.4, -1)
      : p.role === 'driver' || lean === 0
        ? toWorldDir(0, 1, -0.05)
        : new THREE.Vector3().lerpVectors(toWorldDir(0, 1, 0), aimWorld.clone().add(carUp.clone().multiplyScalar(1.4)), lean);
    aimBone(this.bone('Neck'), this.bone('Head'), headDir);

    // Arms and the gun.
    const shoulder = this.arms.right.root.getWorldPosition(new THREE.Vector3());
    const hipWorld = toWorld(p.hip);
    this.setGun(p.gun);
    if (!p.alive) {
      this.reach(this.arms.left, toWorld(p.hip.clone().add(new THREE.Vector3(-0.22, 0.05, -0.28))), toWorldDir(-1, 0, 0.3));
      this.reach(this.arms.right, toWorld(p.hip.clone().add(new THREE.Vector3(0.22, 0.05, -0.28))), toWorldDir(1, 0, 0.3));
      this.gunHolder.visible = false;
      return;
    }
    if (p.role === 'driver') {
      // Hands at ten to two on a wheel ahead of the chest.
      const wheel = p.hip.clone().add(new THREE.Vector3(0, 0.38, -0.5));
      this.reach(this.arms.left, toWorld(wheel.clone().add(new THREE.Vector3(-0.17, 0.05, 0))), toWorldDir(-1, -1, 0.2));
      this.reach(this.arms.right, toWorld(wheel.clone().add(new THREE.Vector3(0.17, 0.05, 0))), toWorldDir(1, -1, 0.2));
      this.gunHolder.visible = false;
      return;
    }
    // A gunner. Out of the window (or over the roof) the gun is shouldered
    // along the aim: butt in the shoulder pocket, rear hand on the grip, front
    // hand on the handguard, head down behind the sights. Tucked in, it is held
    // at low ready across the body, muzzle up. On top: idle sway and breathing,
    // the kick of each shot, a reload (gun canted, hand to the magazine) and a
    // swap (gun lowered out of view, the other raised).
    this.time += dt;
    this.recoil = Math.max(0, this.recoil - dt * 9);
    const grips = GRIPS[this.gunId ?? 'rifle'];
    // Swap: the gun goes down and the new one comes up (`setGun` starts it).
    this.swap = Math.max(0, this.swap - dt / SWAP_SECONDS);
    const swapDip = Math.sin(this.swap * Math.PI) * 1.1;
    this.reloadPhase = p.reload ? this.reloadPhase + dt : 0;
    const reloadAmount = p.reload ? Math.min(1, this.reloadPhase * 4) : 0;
    const sway = (1 - 0.6 * lean) * 0.03 + 0.008;
    const breathe = Math.sin(this.time * 1.6 + this.phase) * sway;
    const drift = Math.sin(this.time * 0.9 + this.phase * 2.3) * sway;

    const right0 = new THREE.Vector3().crossVectors(aimWorld, carUp).normalize();
    const low = toWorldDir(0.25 * side, 0.75, -0.6).normalize();
    const gunDir = new THREE.Vector3()
      .lerpVectors(low, aimWorld, lean)
      .addScaledVector(carUp, breathe + this.recoil * 0.12 - swapDip * 0.8 - reloadAmount * 0.35)
      .addScaledVector(right0, drift)
      .normalize();
    const right = new THREE.Vector3().crossVectors(gunDir, carUp).normalize();
    let gunUp = new THREE.Vector3().crossVectors(right, gunDir).normalize();
    // A reload cants the gun over onto its side.
    if (reloadAmount > 0) gunUp = gunUp.applyAxisAngle(gunDir, -0.5 * reloadAmount * side).normalize();
    const gunRight = new THREE.Vector3().crossVectors(gunDir, gunUp).normalize();

    // The shoulder pocket: just inside the right shoulder joint, a little low;
    // the gun slides back into it with each shot.
    const pocket = shoulder
      .clone()
      .addScaledVector(gunRight, -0.06)
      .addScaledVector(gunUp, -0.04)
      .addScaledVector(gunDir, -0.02 - this.recoil * 0.05);
    const lowReady = toWorld(p.hip.clone().add(new THREE.Vector3(0.18, 0.18, -0.2)));
    const butt = new THREE.Vector3().lerpVectors(lowReady, pocket, lean);
    const onGun = (local: readonly [number, number, number]): THREE.Vector3 =>
      butt.clone().addScaledVector(gunRight, local[0]).addScaledVector(gunUp, local[1]).addScaledVector(gunDir, local[2]);
    const grip = onGun(grips.grip);
    // Reloading, the front hand goes down to the magazine and back.
    const reach = reloadAmount * (0.5 - 0.5 * Math.cos(this.reloadPhase * 5));
    const fore = onGun(grips.fore).lerp(onGun(grips.mag).addScaledVector(gunUp, -0.12), reach);
    // Elbows: the trigger arm out to the side and a little down; the support
    // arm tucked under the gun.
    this.reach(this.arms.right, grip, gunRight.clone().multiplyScalar(0.8).addScaledVector(carUp, -0.6));
    this.reach(this.arms.left, fore, gunRight.clone().multiplyScalar(-0.3).addScaledVector(carUp, -1));
    // The head: down to the sights when out, looking over the gun.
    if (p.alive && lean > 0.2) {
      const sight = gunDir.clone().addScaledVector(carUp, 0.35).normalize();
      aimBone(this.bone('Neck'), this.bone('Head'), new THREE.Vector3().lerpVectors(headDir, sight, lean));
    }

    // Place the gun: butt at `butt`, barrel along `gunDir`.
    this.gunHolder.visible = this.gunId !== null;
    const basis = new THREE.Matrix4().makeBasis(gunRight, gunUp, gunDir.clone().negate());
    const world = new THREE.Quaternion().setFromRotationMatrix(basis);
    this.root.getWorldQuaternion(_p);
    this.gunHolder.quaternion.copy(_p.invert().multiply(world));
    this.gunHolder.position.copy(this.root.worldToLocal(butt.clone()));
    // Halfway through a swap, out of sight: the new gun goes in.
    if (this.pendingGun !== undefined && this.swap <= 0.5) this.putGun(this.pendingGun);
  }

  /** A shot was fired from this seat: the gun kicks back into the shoulder. */
  kick(): void {
    this.recoil = Math.min(1.4, this.recoil + 1);
  }

  /** Change gun: the first one goes straight in; later ones swap (down, then up). */
  private setGun(id: WeaponId | null): void {
    if (id === (this.pendingGun ?? this.gunId)) return;
    if (this.gunId === null || id === null) {
      this.putGun(id);
      return;
    }
    this.pendingGun = id;
    this.swap = 1;
  }

  private putGun(id: WeaponId | null): void {
    this.pendingGun = undefined;
    this.gunId = id;
    for (const child of [...this.gunHolder.children]) this.gunHolder.remove(child);
    if (id) this.gunHolder.add(this.makeGun(id));
  }

  dispose(): void {
    for (const m of this.tinted) m.dispose();
  }
}
