/**
 * The people in the cars: a driver behind every wheel and, in duos and squads,
 * gunners who sit tucked in and LEAN OUT of their window to aim.
 *
 * Each outfit is a skinned model on the same (Mixamo) skeleton, prepared by
 * scripts/prep/characters.ts. The body's motion comes from animation clips,
 * blended for what the person is doing: the driver from YOVNOK's own
 * (scripts/blender/anims.py), seated with hands on the wheel; a gunner from
 * Quaternius' CC0 library (scripts/blender/ual.py) — sat in the seat with the
 * gun in their lap, or leaning out of the window to aim (pistol aim poses,
 * blended by pitch), reloading and firing. On top, code puts the body where
 * this car's seat and window put it (crews.gunnerBody, the same body a shot is
 * tested against), turns it to the aim, lines the barrel up with it exactly
 * and puts the support hand on the gun.
 *
 * Code posing is by direction, so it does not care how a model's bones are
 * oriented locally: each limb is turned (shortest arc, in world space) to point
 * where it should, and arms and legs reach their targets with a two-bone IK.
 * Car frame throughout: x right, y up, -z forward.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/examples/jsm/utils/SkeletonUtils.js';
import { COMBAT } from '../../shared/config';
import { FIGURE_SCALE, HAND_GUN_SCALE } from '../../shared/crews';
import { OUTFITS } from '../../shared/cosmetics';
import type { WeaponId } from '../../shared/weapons';

/** What one seat's person is doing, for `Figure.pose`. */
export type FigurePose = {
  role: 'driver' | 'gunner';
  /** Which window a gunner rides out of. */
  side: 'left' | 'right';
  /** Where their hips are on the seat, car frame. */
  seat: THREE.Vector3;
  /**
   * Out of the window, car frame: where the hips go, which way the spine runs
   * (crews.gunnerBody — the same body a shot is tested against) and how far
   * round over the roof they are (0 at the window … 1 over the roof).
   */
  hips: THREE.Vector3;
  spine: THREE.Vector3;
  roof: number;
  /** Aim relative to the car's nose (+ = left) and pitch (+ = up), radians. */
  yaw: number;
  pitch: number;
  /** Out of the window to aim (held aim). */
  out: boolean;
  alive: boolean;
  /** What a gunner holds (null: empty hands, e.g. the driver). */
  gun: WeaponId | null;
  /** Reloading the gun in hand. */
  reload: boolean;
  /** The driver's steering, -1 (left) … 1 (right). */
  steer: number;
};

/**
 * Where the hands go on each gun, in metres from the butt: across, up, and
 * along the barrel. The rear hand on the grip, the front hand on the handguard
 * (or pump, or foregrip), and the magazine for a reload.
 */
const GRIPS: Record<WeaponId, { grip: [number, number, number]; fore: [number, number, number]; mag: [number, number, number] }> = {
  // Measured on YOVNOK's own guns (scripts/blender/guns.py).
  rifle: { grip: [0, -0.08, 0.27], fore: [0, -0.04, 0.58], mag: [0, -0.1, 0.38] },
  marksman: { grip: [0, -0.08, 0.29], fore: [0, -0.05, 0.62], mag: [0, -0.1, 0.42] },
  shotgun: { grip: [0, -0.08, 0.29], fore: [0, -0.06, 0.64], mag: [0, -0.05, 0.42] },
  launcher: { grip: [0, -0.1, 0.27], fore: [0, -0.12, 0.55], mag: [0, -0.06, 0.37] },
  smg: { grip: [0, -0.08, 0.22], fore: [0, -0.1, 0.42], mag: [0, -0.12, 0.31] },
  lmg: { grip: [0, -0.08, 0.29], fore: [0, -0.06, 0.62], mag: [0, -0.12, 0.42] },
  // Held out at arm's length: both hands round the grip, well forward of the shoulder.
  revolver: { grip: [0, -0.07, 0.46], fore: [0.01, -0.09, 0.47], mag: [0, -0.01, 0.53] },
  burst: { grip: [0, -0.1, 0.4], fore: [0, -0.05, 0.55], mag: [0, -0.12, 0.24] },
  mg: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  rocket: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  scatter: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  lancer: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
  swarm: { grip: [0, -0.08, 0.27], fore: [0, -0.02, 0.52], mag: [0, -0.1, 0.38] },
};
/** How hard each gun kicks (1 = the rifle): the recoil clip's weight and the gun's jump. */
const KICK: Partial<Record<WeaponId, number>> = {
  smg: 0.5,
  rifle: 0.75,
  burst: 0.75,
  lmg: 0.65,
  marksman: 1.25,
  revolver: 1.35,
  shotgun: 1.5,
  launcher: 1.5,
};

/** Held out in the hand, as the library's pistol poses hold it; every other gun is shouldered. */
const PISTOLS = new Set<WeaponId>(['revolver']);

/** Seconds to put one gun away and bring the other up. */
const SWAP_SECONDS = 0.45;

// ------------------------------------------------------------------ library

type Outfit = { scene: THREE.Object3D; tintable: Set<string> };

/** Loads the outfits (once) and makes figures from them. */
export class FigureLibrary {
  private readonly outfits = new Map<number, Outfit>();
  /** The hand-held guns (scripts/prep/hand-guns.ts): butt at the origin, barrel -Z. */
  private readonly guns = new Map<WeaponId, THREE.Object3D>();
  /**
   * The crew's animation clips — YOVNOK's own (scripts/blender/anims.py) and
   * the CC0 library's (scripts/blender/ual.py) — each with its skeleton's rest rotations.
   */
  private readonly anims: { clips: THREE.AnimationClip[]; rest: Map<string, THREE.Quaternion> }[] = [];
  /** The clips retargeted onto each outfit's skeleton, made once per outfit. */
  private readonly retargeted = new Map<number, Map<string, THREE.AnimationClip>>();
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
              // The crew's team-colour kit takes the paint colour, so a crew
              // reads as one team: the material the generator names "Team"
              // (carrier, helmet rim, scarf, shoulder plate…).
              if (/^Team(\.\d+)?$/.test(material.name)) tintable.add(material.name);
            });
            this.outfits.set(index, { scene: gltf.scene, tintable });
          } catch (error) {
            console.warn(`[figures] ${outfit.id} failed to load`, error);
          }
        }),
      )
        .then(() =>
          Promise.all(
            (['rifle', 'shotgun', 'marksman', 'launcher', 'smg', 'lmg', 'revolver', 'burst'] as const).map(async (id) => {
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
        .then(() =>
          Promise.all(
            ['anims', 'ual'].map(async (file) => {
              try {
                const gltf = await this.loader.loadAsync(`/assets/characters/${file}.glb`);
                const rest = new Map<string, THREE.Quaternion>();
                gltf.scene.traverse((o) => rest.set(o.name, o.quaternion.clone()));
                this.anims.push({ clips: gltf.animations, rest });
              } catch (error) {
                // Without clips the figures are posed by code alone.
                console.warn(`[figures] the ${file} animations failed to load; posing by code`, error);
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
    const index = this.outfits.get(outfit) ? outfit : this.outfits.keys().next().value!;
    return new Figure(
      cloneSkinned(source.scene),
      source.tintable,
      tint,
      (id) => this.guns.get(id)?.clone() ?? handGun(id),
      this.clipsFor(index, source.scene),
    );
  }

  /**
   * The clips, retargeted onto one outfit's skeleton: each bone's rotation is
   * taken relative to the animation skeleton's rest and applied on top of this
   * skeleton's rest, so bodies of other builds play them the same way. Bone
   * rotations only: where the hips sit is the game's to decide.
   */
  private clipsFor(outfit: number, scene: THREE.Object3D): Map<string, THREE.AnimationClip> | undefined {
    if (this.anims.length === 0) return undefined;
    const cached = this.retargeted.get(outfit);
    if (cached) return cached;
    const figureRest = new Map<string, THREE.Quaternion>();
    scene.traverse((o) => {
      if ((o as THREE.Bone).isBone) figureRest.set(o.name, o.quaternion.clone());
    });
    const clips = new Map<string, THREE.AnimationClip>();
    const q = new THREE.Quaternion();
    for (const anims of this.anims) {
      for (const source of anims.clips) {
        const tracks: THREE.KeyframeTrack[] = [];
        for (const track of source.tracks) {
          const [bone, property] = track.name.split('.');
          const restFigure = figureRest.get(bone);
          const restClip = anims.rest.get(bone);
          if (property !== 'quaternion' || !restFigure || !restClip) continue;
          const toFigure = restFigure.clone().multiply(restClip.clone().invert());
          const values = track.values.slice();
          for (let i = 0; i < values.length; i += 4) q.fromArray(values, i).premultiply(toFigure).toArray(values, i);
          tracks.push(new THREE.QuaternionKeyframeTrack(`${bone}.quaternion`, Array.from(track.times), Array.from(values)));
        }
        // Blender's exporter may suffix a clip's name (".001").
        const name = source.name.replace(/\.\d+$/, '');
        clips.set(name, new THREE.AnimationClip(name, source.duration, tracks));
      }
    }
    this.retargeted.set(outfit, clips);
    return clips;
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

/** The end of a gun's barrel (along -Z): the middle of its frontmost vertices, in the gun's frame. */
function barrelTip(gun: THREE.Object3D): THREE.Vector3 | null {
  gun.updateMatrixWorld(true);
  const points: THREE.Vector3[] = [];
  gun.traverse((object) => {
    const position = (object as THREE.Mesh).geometry?.getAttribute('position');
    if (!position) return;
    for (let i = 0; i < position.count; i++) points.push(new THREE.Vector3().fromBufferAttribute(position, i).applyMatrix4(object.matrixWorld));
  });
  if (!points.length) return null;
  const front = points.reduce((z, v) => Math.min(z, v.z), Infinity);
  const ends = points.filter((v) => v.z < front + 0.01);
  return ends.reduce((sum, v) => sum.add(v), new THREE.Vector3()).divideScalar(ends.length);
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

/** Turn `bone` in world space by `rot` (premultiplied). */
function rotateBone(bone: THREE.Object3D, rot: THREE.Quaternion): void {
  bone.getWorldQuaternion(_w);
  _w.premultiply(rot);
  bone.parent!.getWorldQuaternion(_p);
  bone.quaternion.copy(_p.invert().multiply(_w));
  bone.updateMatrixWorld(true);
}

/** The legs and hips: what a clip's lower half moves. */
const LOWER = /^(Hips|(Left|Right)(UpLeg|Leg|Foot|ToeBase))\./;

/** A clip's rotations, upper body only or lower body only. */
function half(clip: THREE.AnimationClip, upper: boolean, name = clip.name): THREE.AnimationClip {
  return new THREE.AnimationClip(name, clip.duration, clip.tracks.filter((t) => t.name.endsWith('.quaternion') && LOWER.test(t.name) !== upper));
}

/** The CC0 library's layers a gunner is blended from (client/vehicle/figures.ts header). */
type GunnerActions = {
  sitLower: THREE.AnimationAction;
  sitUpper: THREE.AnimationAction;
  aim: Record<'up' | 'mid' | 'down', THREE.AnimationAction>;
  idle: THREE.AnimationAction;
  reload: THREE.AnimationAction;
  shoot: THREE.AnimationAction;
  /** Flinches, played over the rest when they are shot (null: not in the library). */
  hit: Record<'head' | 'chest', THREE.AnimationAction> | null;
};

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

/** YOVNOK's own clips (scripts/blender/anims.py), played by name; the CC0 library's are layered (`GunnerActions`). */
const OWN_CLIPS = new Set(['seated', 'ready', 'climb_left', 'climb_right', 'out', 'reload', 'down']);

/** An angle brought into -π … π. */
function wrapAngle(a: number): number {
  return a - Math.PI * 2 * Math.round(a / (Math.PI * 2));
}

/** From angle `a` toward `b` by `t`, the short way round. */
function lerpAngle(a: number, b: number, t: number): number {
  return a + wrapAngle(b - a) * t;
}

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
  /** 1 just shot … 0 recovered; and which way the round was travelling (world). */
  private hurt = 0;
  private hurtHead = false;
  private readonly hurtDir = new THREE.Vector3();
  private reloadPhase = 0;
  private time = 0;
  /** Each person sways out of step with the others. */
  private readonly phase = Math.random() * Math.PI * 2;
  /** 0 tucked in … 1 out of the window, eased toward the wanted state. */
  private lean = 0;
  /** 0 at the window … 1 up on the sill over the roof, eased toward the aim's. */
  private roof = 0;
  /** Out of the window: the hips and spine, eased toward the aim's. */
  private readonly outHips = new THREE.Vector3();
  private readonly outSpine = new THREE.Vector3(0, 1, 0);
  private posed = false;
  /** Which way the hips face (+ = left of the car's nose), and the head on top of the chest. */
  private pelvis = 0;
  private headYaw = 0;
  private steer = 0;
  /** Idle glances about: where the eyes go next, and when. */
  private glance = 0;
  private glanceAt = 0;
  /** The car's motion, felt in the body: its acceleration, car frame, smoothed. */
  private readonly g = new THREE.Vector3();
  private readonly lastPos = new THREE.Vector3();
  private readonly lastVel = new THREE.Vector3();
  private moving = 0;
  private readonly tinted: THREE.Material[] = [];
  /**
   * The animation layer (null: posed by code alone). Base states blend by
   * weight (seated, ready, out, reload, down); the climb is scrubbed by how far
   * out the gunner is; recoil plays on top, additively.
   */
  private readonly mixer: THREE.AnimationMixer | null = null;
  private readonly actions = new Map<string, THREE.AnimationAction>();
  private recoilAction: THREE.AnimationAction | null = null;
  private downTime = 0;
  /** A gunner's layers from the CC0 library (null: without them, posed the older way). */
  private readonly gunner: GunnerActions | null = null;
  /** The mixer's own output last frame (see `mix`). */
  private clean: Map<THREE.Bone, THREE.Quaternion> | null = null;
  /** The end of the gun's barrel, in the gun's frame (`barrelTip`). */
  private tip: THREE.Vector3 | null = null;
  /** Posed this frame as a window gunner (the gun out, `muzzle` is the drawn one). */
  private gunnerPosed = false;
  /** The gun in the right hand: where it sits in the hand's frame, and its muzzle (gun frame, -Z). */
  private hold: { inHand: THREE.Matrix4; muzzleZ: number } | null = null;
  /** The pitch each aim pose holds the gun at, measured for the gun in hand. */
  private readonly posePitch = { up: 1.4, mid: 0.25, down: -1.35 };
  /** A gunner's aim, eased a little (other players' arrives in network steps); and whether set yet. */
  private aimYaw = 0;
  private aimPitch = 0;
  private aimed = false;
  /** Which way the head looks at rest (the figure's forward, -Z), in the head's own frame. */
  private readonly headFwd = new THREE.Vector3(0, 0, -1);

  constructor(
    model: THREE.Object3D,
    tintable: Set<string>,
    tint: number,
    private readonly makeGun: (id: WeaponId) => THREE.Object3D = handGun,
    clips?: Map<string, THREE.AnimationClip>,
  ) {
    this.root.name = 'figure';
    // Larger than life, so they read from the chase camera (crews.FIGURE_SCALE);
    // set before the limbs are measured, so the reach lengths include it.
    this.root.scale.setScalar(FIGURE_SCALE);
    // The gun is larger again (HAND_GUN_SCALE overall).
    this.gunHolder.scale.setScalar(HAND_GUN_SCALE / FIGURE_SCALE);
    this.root.add(model, this.gunHolder);
    if (clips) {
      this.mixer = new THREE.AnimationMixer(model);
      for (const [name, clip] of clips) {
        if (name === 'recoil' || !OWN_CLIPS.has(name)) continue;
        const action = this.mixer.clipAction(clip);
        action.setEffectiveWeight(0).play();
        // Scrubbed rather than run: the climb follows the lean, the reload its
        // own clock, the knock-down holds its last frame.
        if (name.startsWith('climb') || name === 'reload' || name === 'down') action.paused = true;
        this.actions.set(name, action);
      }
      const recoil = clips.get('recoil');
      if (recoil) {
        const additive = THREE.AnimationUtils.makeClipAdditive(recoil.clone());
        this.recoilAction = this.mixer.clipAction(additive);
        this.recoilAction.blendMode = THREE.AdditiveAnimationBlendMode;
        this.recoilAction.setLoop(THREE.LoopOnce, 1);
      }
    }
    // The team kit is modelled light, so it takes the paint colour as it is.
    const paint = new THREE.Color(tint).multiplyScalar(1.15);
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
    this.headFwd.applyQuaternion(this.bone('Head').getWorldQuaternion(new THREE.Quaternion()).invert());
    if (clips) this.gunner = this.gunnerActions(clips);
  }

  /** The gunner's layers, from the CC0 library's clips; null when they did not load. */
  private gunnerActions(clips: Map<string, THREE.AnimationClip>): GunnerActions | null {
    const mixer = this.mixer;
    const need = ['Sitting_Idle_Loop', 'Pistol_Aim_Up', 'Pistol_Aim_Neutral', 'Pistol_Aim_Down', 'Pistol_Idle_Loop', 'Pistol_Reload', 'Pistol_Shoot'];
    if (!mixer || need.some((name) => !clips.has(name))) return null;
    const clip = (name: string): THREE.AnimationClip => clips.get(name)!;
    const play = (c: THREE.AnimationClip): THREE.AnimationAction => {
      const action = mixer.clipAction(c);
      action.setEffectiveWeight(0).play();
      this.actions.set(c.name, action);
      return action;
    };
    const reload = play(half(clip('Pistol_Reload'), true, 'gunner.reload'));
    reload.paused = true; // scrubbed by the reload's own clock
    const additive = (name: string, as: string): THREE.AnimationAction => {
      const action = mixer.clipAction(THREE.AnimationUtils.makeClipAdditive(half(clip(name), true, as)));
      action.blendMode = THREE.AdditiveAnimationBlendMode;
      action.setLoop(THREE.LoopOnce, 1);
      return action;
    };
    const shoot = additive('Pistol_Shoot', 'gunner.shoot');
    const hit = clips.has('Hit_Head') && clips.has('Hit_Chest') ? { head: additive('Hit_Head', 'gunner.hitHead'), chest: additive('Hit_Chest', 'gunner.hitChest') } : null;
    return {
      sitLower: play(this.facingForward(half(clip('Sitting_Idle_Loop'), false, 'gunner.sitLower'))),
      sitUpper: play(half(clip('Sitting_Idle_Loop'), true, 'gunner.sitUpper')),
      aim: {
        up: play(half(clip('Pistol_Aim_Up'), true, 'gunner.aimUp')),
        mid: play(half(clip('Pistol_Aim_Neutral'), true, 'gunner.aimMid')),
        down: play(half(clip('Pistol_Aim_Down'), true, 'gunner.aimDown')),
      },
      idle: play(half(clip('Pistol_Idle_Loop'), true, 'gunner.idle')),
      reload,
      shoot,
      hit,
    };
  }

  /**
   * The library's sitting clip faces the other way from its other clips: turn
   * its hips about the vertical so the knees point forward (-Z), the way the seat faces.
   */
  private facingForward(clip: THREE.AnimationClip): THREE.AnimationClip {
    const model = this.root.children[0];
    const m = new THREE.AnimationMixer(model);
    m.clipAction(clip).play();
    m.update(0);
    this.root.updateMatrixWorld(true);
    const hips = this.bone('Hips').getWorldPosition(new THREE.Vector3());
    const knees = this.bone('LeftLeg').getWorldPosition(new THREE.Vector3()).add(this.bone('RightLeg').getWorldPosition(new THREE.Vector3())).multiplyScalar(0.5);
    const d = knees.sub(hips);
    m.stopAllAction();
    m.uncacheRoot(model);
    for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    this.root.updateMatrixWorld(true);
    const parent = this.bone('Hips').parent!.getWorldQuaternion(new THREE.Quaternion());
    const turn = parent.clone().invert().multiply(new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), Math.PI - Math.atan2(d.x, d.z))).multiply(parent);
    const out = clip.clone();
    const q = new THREE.Quaternion();
    for (const track of out.tracks) {
      if (track.name !== 'Hips.quaternion') continue;
      for (let i = 0; i < track.values.length; i += 4) q.fromArray(track.values, i).premultiply(turn).toArray(track.values, i);
    }
    return out;
  }

  /**
   * Run the mixer. It only writes a bone whose animated value has changed, so
   * the code's corrections from the last frame would stay and pile up: each
   * frame starts from the mixer's own last output instead.
   */
  private mix(dt: number): void {
    const mixer = this.mixer!;
    if (this.clean) for (const [bone, q] of this.clean) bone.quaternion.copy(q);
    mixer.update(dt);
    this.clean ??= new Map([...this.bones.values()].map((bone) => [bone, new THREE.Quaternion()]));
    for (const [bone, q] of this.clean) q.copy(bone.quaternion);
    this.root.updateMatrixWorld(true);
  }

  /** Where a hand is drawn (its palm), world. */
  private palm(limb: Limb): THREE.Vector3 {
    return limb.endLocal ? limb.mid.localToWorld(limb.endLocal.clone()) : limb.end.getWorldPosition(new THREE.Vector3());
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

  /**
   * Feel the car move: its acceleration in its own frame, smoothed, so bodies
   * sway into corners, pitch under braking and settle over bumps.
   */
  private sense(car: THREE.Object3D, dt: number): void {
    const pos = car.getWorldPosition(_a);
    if (dt <= 0) return;
    const vel = _b.subVectors(pos, this.lastPos).divideScalar(dt);
    this.lastPos.copy(pos);
    if (this.moving < 2 || vel.lengthSq() > 90 * 90) {
      // The first frames, or a jump (respawn): nothing to feel yet.
      this.moving++;
      this.lastVel.copy(vel.lengthSq() > 90 * 90 ? _d.set(0, 0, 0) : vel);
      return;
    }
    const acc = _d.subVectors(vel, this.lastVel).divideScalar(dt);
    this.lastVel.copy(vel);
    car.getWorldQuaternion(_w);
    acc.applyQuaternion(_w.invert()).clampLength(0, 30);
    this.g.lerp(acc, 1 - Math.exp(-dt * 5));
  }

  /**
   * Blend the clips for this frame: seated (a driver), ready (a gunner tucked
   * in), out (up in the window), the climb between those two scrubbed by how
   * far out they are, a reload over the out pose, and the knock-down.
   * Returns false when there is nothing to play.
   */
  private animate(p: FigurePose, dt: number): boolean {
    const mixer = this.mixer;
    if (!mixer) return false;
    const weights = new Map<string, number>();
    if (!p.alive) {
      this.downTime += dt;
      weights.set('down', 1);
    } else {
      this.downTime = 0;
      if (p.role === 'driver') weights.set('seated', 1);
      else {
        const t = this.lean;
        const climb = Math.sin(Math.PI * t);
        const reloading = p.reload && t > 0.5 ? Math.min(1, this.reloadPhase * 4) : 0;
        weights.set('ready', (1 - t) * (1 - climb));
        weights.set('out', t * (1 - climb) * (1 - reloading));
        weights.set('reload', t * (1 - climb) * reloading);
        weights.set(p.side === 'right' ? 'climb_right' : 'climb_left', climb);
      }
    }
    for (const [name, action] of this.actions) {
      action.setEffectiveWeight(weights.get(name) ?? 0);
      const clip = action.getClip();
      if (name.startsWith('climb')) action.time = this.lean * clip.duration;
      else if (name === 'reload') action.time = this.reloadPhase % clip.duration;
      else if (name === 'down') action.time = Math.min(this.downTime, clip.duration);
    }
    this.mix(dt);
    return true;
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
    const ease = this.posed ? 1 - Math.exp(-dt * 10) : 1;
    // Climbing up over the roof or back down to the window reads as a climb.
    const climb = this.posed ? 1 - Math.exp(-dt * 4) : 1;
    this.outHips.lerp(p.hips, climb);
    this.outSpine.lerp(p.spine, ease).normalize();
    this.roof += (p.roof - this.roof) * climb;
    this.steer += (p.steer - this.steer) * ease;
    this.posed = true;
    this.time += dt;
    this.sense(car, dt);
    if (this.time > this.glanceAt) {
      this.glanceAt = this.time + 2 + Math.random() * 4;
      this.glance = Math.random() < 0.5 ? 0 : (Math.random() - 0.5) * 1.2;
    }
    this.gunnerPosed = p.role === 'gunner' && p.alive && this.gunner !== null;
    if (p.role === 'gunner' && p.alive && this.gunner) {
      this.poseGunner(this.gunner, p, dt, lean, car);
      return;
    }
    const g = this.g;
    const roof = this.roof * lean;

    // The body's own motion: the animation clips, blended for what the person
    // is doing (without them, the rest pose for the code below to work from).
    const animated = this.mixer !== null && this.animate(p, dt);
    if (!animated) for (const [bone, q] of this.rest) bone.quaternion.copy(q);
    // How much of the climb is under way: 0 seated or settled out, 1 mid-climb.
    const climbing = animated && p.alive ? Math.sin(Math.PI * this.lean) : 0;
    // The hips: on the seat, or out in the window (gunnerBody). Climbing out,
    // they rise and swing out together; the body settles with the car's heave.
    const hip = p.seat.clone().lerp(this.outHips, lean);
    hip.y += THREE.MathUtils.clamp(-g.y * 0.004, -0.04, 0.04);
    this.root.position.copy(hip).addScaledVector(this.hipsRest, -FIGURE_SCALE);
    this.root.updateMatrixWorld(true);

    // Development: `window.__figureRest = true` shows the model unposed.
    if (import.meta.env.DEV && (window as unknown as { __figureRest?: boolean }).__figureRest) return;
    car.updateMatrixWorld();
    const toWorldDir = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).transformDirection(car.matrixWorld);
    const toWorld = (v: THREE.Vector3): THREE.Vector3 => v.clone().applyMatrix4(car.matrixWorld);
    const carUp = toWorldDir(0, 1, 0);

    // Aim, car frame (+yaw = left).
    const cosP = Math.cos(p.pitch);
    const aim = new THREE.Vector3(-Math.sin(p.yaw) * cosP, Math.sin(p.pitch), -Math.cos(p.yaw) * cosP);
    const aimWorld = aim.clone().transformDirection(car.matrixWorld);

    // The hips face the way the legs can go: forward on the seat; out of the
    // window, outward and turned part way to the aim; over the roof, inward.
    // The chest turns the rest of the way, so it is square to the gun.
    const outward = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const toward = (base: number): number => base + THREE.MathUtils.clamp(wrapAngle(p.yaw - base), -1.2, 1.2) * 0.45;
    const pelvisOut = lerpAngle(toward(outward), toward(-outward), this.roof);
    this.pelvis = lerpAngle(this.pelvis, p.alive ? lerpAngle(0, pelvisOut, lean) : 0, ease);
    twistBone(this.bone('Hips'), carUp, this.pelvis);

    // Legs. Seated: knees forward, feet on the floor ahead of the seat. Out of
    // the window: knelt up on the seat, feet back toward the middle of the car.
    // Over the roof: stood up on the seat, knees toward the middle. (Below the
    // door's edge, all of this is out of sight but for glimpses.)
    for (const [limb, sx] of [
      [this.legs.left, -1],
      [this.legs.right, 1],
    ] as const) {
      const seated = p.seat.clone().add(new THREE.Vector3(sx * 0.16, -0.3, -0.62));
      const knelt = p.seat.clone().add(new THREE.Vector3(-side * 0.3 + sx * 0.12, -0.05, 0.3));
      const stood = p.seat.clone().add(new THREE.Vector3(-side * 0.15 + sx * 0.14, -0.02, 0.05));
      const upright = knelt.lerp(stood, this.roof);
      const foot = toWorld(seated.lerp(upright, lean));
      const pole = new THREE.Vector3(0, 0.4, -1).lerp(new THREE.Vector3(-side * (0.8 * this.roof), -0.3, -1 + 0.6 * this.roof), lean);
      // Animated, the clip places the legs when seated; out of the window the
      // feet go where this car's seat is, eased from wherever the clip had them.
      if (animated) {
        if (lean <= 0.001 || !p.alive) continue;
        foot.lerp(limb.end.getWorldPosition(new THREE.Vector3()), 1 - lean);
      }
      this.reach(limb, foot, pole.transformDirection(car.matrixWorld));
    }

    // Spine: seated, a little reclined; out, along gunnerBody's spine; knocked
    // down, slumped forward. It sways against the car's acceleration (less when
    // braced out of the window), breathes, and rocks back with each shot.
    const spineDir = !p.alive
      ? toWorldDir(0.1 * side, 0.55, -0.8)
      : new THREE.Vector3().lerpVectors(toWorldDir(0, 1, 0.12), this.outSpine.clone().transformDirection(car.matrixWorld), lean);
    if (p.alive) {
      const give = 0.014 * (1 - 0.4 * lean);
      spineDir.add(toWorldDir(-g.x * give, 0, -g.z * give));
      spineDir.add(toWorldDir(0, 0, Math.sin(this.time * 1.7 + this.phase) * 0.015));
      spineDir.addScaledVector(aimWorld, -this.recoil * 0.07 * lean);
    }
    spineDir.normalize();
    if (animated) {
      // The clip's spine (its curve, breathing, the climb's dip) turned as a
      // whole toward where this body leans in this car: out, along the
      // window's lean; in the seat, only the car's sway.
      if (p.alive) {
        const base = this.bone('Spine').getWorldPosition(new THREE.Vector3());
        const top = this.bone('Neck').getWorldPosition(new THREE.Vector3());
        const now = top.clone().sub(base).normalize();
        const wanted = now.clone().lerp(spineDir, lean * (1 - climbing * 0.7)).normalize();
        wanted.add(toWorldDir(-g.x * 0.01 * (1 - lean), 0, -g.z * 0.01 * (1 - lean))).normalize();
        aimBoneAt(this.bone('Spine'), top, wanted);
      }
    } else for (let i = 0; i < SPINE.length - 1; i++) aimBone(this.bone(SPINE[i]), this.bone(SPINE[i + 1]), spineDir);
    if (p.alive && lean > 0) {
      // Turned about the spine's ACTUAL axis (with clips it is not exactly
      // spineDir): twisting a large angle about any other axis tips the whole
      // torso over sideways.
      const axis = this.bone('Neck')
        .getWorldPosition(new THREE.Vector3())
        .sub(this.bone('Spine').getWorldPosition(new THREE.Vector3()))
        .normalize();
      const twist = wrapAngle(p.yaw - this.pelvis) * lean;
      twistBone(this.bone('Spine1'), axis, twist * 0.45);
      twistBone(this.bone('Spine2'), axis, twist * 0.55);
    }

    // The head, held level whatever the body does. Out: square to the aim,
    // tipped toward the sights. In: the
    // gunner looks the way they are aiming; the driver into the turn, with
    // the odd glance about.
    const chestYaw = this.pelvis + (p.alive && lean > 0 ? wrapAngle(p.yaw - this.pelvis) * lean : 0);
    const lookYaw =
      p.role === 'driver'
        ? -this.steer * 0.35 + this.glance * 0.6
        : lean > 0.5
          ? p.yaw
          : THREE.MathUtils.clamp(wrapAngle(p.yaw), -1.1, 1.1) * 0.8 + this.glance * 0.3;
    this.headYaw = lerpAngle(this.headYaw, THREE.MathUtils.clamp(wrapAngle(lookYaw - chestYaw), -1.2, 1.2), 1 - Math.exp(-dt * 6));
    const headDir = !p.alive
      ? toWorldDir(0, -0.4, -1)
      : new THREE.Vector3()
          .lerpVectors(carUp, aimWorld, 0.18 * lean)
          .add(toWorldDir(-g.x * 0.006, 0, -g.z * 0.006))
          .normalize();
    if (animated) {
      if (p.alive) {
        // Out: the head levels and looks down the gun; seated it keeps the clip's
        // own looking about, with only the turn below added.
        const head = this.bone('Head').getWorldPosition(new THREE.Vector3());
        const neckAt = this.bone('Neck').getWorldPosition(new THREE.Vector3());
        const now = head.clone().sub(neckAt).normalize();
        aimBoneAt(this.bone('Neck'), head, now.lerp(headDir, lean * (1 - climbing)).normalize());
        twistBone(this.bone('Head'), carUp, this.headYaw * (p.role === 'driver' ? 1 : lean > 0.5 ? 1 : 0.6));
      }
    } else {
      aimBone(this.bone('Neck'), this.bone('Head'), headDir);
      if (p.alive) twistBone(this.bone('Head'), carUp, this.headYaw);
    }

    // Arms and the gun.
    const shoulder = this.arms.right.root.getWorldPosition(new THREE.Vector3());
    this.setGun(p.gun);
    if (!p.alive) {
      if (!animated) {
        this.reach(this.arms.left, toWorld(p.seat.clone().add(new THREE.Vector3(-0.22, 0.05, -0.28))), toWorldDir(-1, 0, 0.3));
        this.reach(this.arms.right, toWorld(p.seat.clone().add(new THREE.Vector3(0.22, 0.05, -0.28))), toWorldDir(1, 0, 0.3));
      }
      this.gunHolder.visible = false;
      return;
    }
    if (p.role === 'driver') {
      // Hands at ten to two on a wheel ahead of the chest, turning it.
      const wheel = p.seat.clone().add(new THREE.Vector3(0, 0.38, -0.5));
      const turn = this.steer * 1.4;
      const onWheel = (angle: number): THREE.Vector3 =>
        toWorld(wheel.clone().add(new THREE.Vector3(Math.sin(angle) * 0.17, Math.cos(angle) * 0.17, 0)));
      this.reach(this.arms.left, onWheel(-1.15 + turn), toWorldDir(-1, -1, 0.2));
      this.reach(this.arms.right, onWheel(1.15 + turn), toWorldDir(1, -1, 0.2));
      this.gunHolder.visible = false;
      return;
    }
    // A gunner: the gun at the shoulder out of the window, at low ready tucked in.
    this.recoil = Math.max(0, this.recoil - dt * 9);
    // Swap: the gun goes down and the new one comes up (`setGun` starts it).
    this.swap = Math.max(0, this.swap - dt / SWAP_SECONDS);
    this.reloadPhase = p.reload ? this.reloadPhase + dt : 0;
    this.shoulderGun(p, lean, climbing, toWorld(p.seat.clone().add(new THREE.Vector3(0.18, 0.18, -0.2))), aimWorld, shoulder);
    // Halfway through a swap, out of sight: the new gun goes in.
    if (this.pendingGun !== undefined && this.swap <= 0.5) this.putGun(this.pendingGun);
  }

  /**
   * Close a hand round the gun: turned so its palm faces `palm` with the
   * fingers along `fingers` (world), then each finger curled in by `curl`
   * per joint. The palm is told from the hand's own bones (at rest the palms
   * face down), so it works for either hand however the model rolls them.
   */
  private grip(side: 'Left' | 'Right', palm: THREE.Vector3, fingers: THREE.Vector3, curl: number): void {
    const hand = this.bone(`${side}Hand`);
    const at = (name: string): THREE.Vector3 => this.bone(name).getWorldPosition(new THREE.Vector3());
    const frame = (): { f: THREE.Vector3; n: THREE.Vector3 } => {
      const wrist = hand.getWorldPosition(new THREE.Vector3());
      const f = at(`${side}HandMiddle1`).sub(wrist).normalize();
      const across = at(`${side}HandIndex1`).sub(at(`${side}HandPinky1`)).normalize();
      const n = new THREE.Vector3().crossVectors(across, f).normalize();
      return { f, n: side === 'Left' ? n.negate() : n };
    };
    const basis = (f: THREE.Vector3, n: THREE.Vector3): THREE.Quaternion => {
      const x = new THREE.Vector3().crossVectors(f, n).normalize();
      const y = new THREE.Vector3().crossVectors(x, f).normalize();
      return new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(x, y, f));
    };
    const now = frame();
    const want = fingers.clone().normalize();
    const wantPalm = palm.clone().projectOnPlane(want).normalize();
    rotateBone(hand, basis(want, wantPalm).multiply(basis(now.f, now.n).invert()));
    const { n } = frame();
    for (const finger of ['Index', 'Middle', 'Ring', 'Pinky']) {
      for (const k of [1, 2, 3]) {
        const bone = this.bones.get(`${side}Hand${finger}${k}`);
        const next = this.bones.get(`${side}Hand${finger}${k + 1}`) ?? bone?.children[0];
        if (!bone || !next) continue;
        // About the axis that swings the finger toward the palm.
        const dir = next.getWorldPosition(new THREE.Vector3()).sub(bone.getWorldPosition(new THREE.Vector3())).normalize();
        twistBone(bone, new THREE.Vector3().crossVectors(dir, n).normalize(), curl);
      }
    }
  }

  /**
   * A long gun, both hands on it: out of the window (`lean` 1) shouldered along
   * the aim — butt in the shoulder pocket, rear hand on the grip, front hand on
   * the handguard — and tucked in (0) at low ready across the body, muzzle up.
   * On top: idle sway and breathing, the kick of each shot, a reload (gun
   * canted, hand to the magazine) and a swap (gun lowered out of view).
   */
  private shoulderGun(p: FigurePose, lean: number, climbing: number, lowReady: THREE.Vector3, aimWorld: THREE.Vector3, shoulder: THREE.Vector3): void {
    const car = this.root.parent!;
    const toWorldDir = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).transformDirection(car.matrixWorld);
    const carUp = toWorldDir(0, 1, 0);
    const side = p.side === 'right' ? 1 : -1;
    const grips = GRIPS[this.gunId ?? 'rifle'];
    const swapDip = Math.sin(this.swap * Math.PI) * 1.1;
    const reloadAmount = p.reload ? Math.min(1, this.reloadPhase * 4) : 0;
    const sway = (1 - 0.6 * lean) * 0.03 + 0.008;
    const breathe = Math.sin(this.time * 1.6 + this.phase) * sway;
    const drift = Math.sin(this.time * 0.9 + this.phase * 2.3) * sway;

    const right0 = new THREE.Vector3().crossVectors(aimWorld, carUp).normalize();
    const low = toWorldDir(0.25 * side, 0.75, -0.6).normalize();
    const gunDir = new THREE.Vector3()
      .lerpVectors(low, aimWorld, lean)
      .addScaledVector(carUp, breathe + this.recoil * 0.15 - swapDip * 0.8 - reloadAmount * 0.35)
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
      .addScaledVector(gunDir, -0.02 - this.recoil * 0.06);
    const butt = new THREE.Vector3().lerpVectors(lowReady, pocket, lean);
    const onGun = (local: readonly [number, number, number]): THREE.Vector3 =>
      butt
        .clone()
        .addScaledVector(gunRight, local[0] * HAND_GUN_SCALE)
        .addScaledVector(gunUp, local[1] * HAND_GUN_SCALE)
        .addScaledVector(gunDir, local[2] * HAND_GUN_SCALE);
    const grip = onGun(grips.grip);
    // Reloading, the front hand goes down to the magazine and back.
    const reach = reloadAmount * (0.5 - 0.5 * Math.cos(this.reloadPhase * 5));
    const fore = onGun(grips.fore).lerp(onGun(grips.mag).addScaledVector(gunUp, -0.12), reach);
    // Out of the support arm's reach (a long handguard, a short arm), the
    // hand slides back along the gun rather than letting go of it.
    const support = this.arms.left.root.getWorldPosition(new THREE.Vector3());
    const span = (this.arms.left.a + this.arms.left.b) * 0.97;
    for (let i = 0; i < 20 && fore.distanceTo(support) > span; i++) fore.addScaledVector(gunDir, -0.02);
    // Elbows: the trigger arm out to the side and a little down; the support
    // arm tucked under the gun.
    this.reach(this.arms.right, grip, gunRight.clone().multiplyScalar(0.8).addScaledVector(carUp, -0.6));
    // Mid-climb the support hand lets go and follows the clip (up to the
    // window frame), coming back to the gun as they settle.
    if (climbing > 0.05) {
      const palm = this.arms.left.endLocal ? this.arms.left.mid.localToWorld(this.arms.left.endLocal.clone()) : this.arms.left.end.getWorldPosition(new THREE.Vector3());
      fore.lerp(palm, climbing * 0.85);
    }
    this.reach(this.arms.left, fore, gunRight.clone().multiplyScalar(-0.3).addScaledVector(carUp, -1));
    // The support hand under the handguard, palm up, fingers round its far side.
    if (this.gunner && lean > 0.01) this.grip('Left', gunUp, gunRight.clone().addScaledVector(gunDir, 0.3), 0.8 * lean * (1 - reach));

    // Place the gun: butt at `butt`, barrel along `gunDir`.
    this.gunHolder.visible = this.gunId !== null;
    const basis = new THREE.Matrix4().makeBasis(gunRight, gunUp, gunDir.clone().negate());
    const world = new THREE.Quaternion().setFromRotationMatrix(basis);
    this.root.getWorldQuaternion(_p);
    this.gunHolder.quaternion.copy(_p.invert().multiply(world));
    this.gunHolder.position.copy(this.root.worldToLocal(butt.clone()));
  }

  /**
   * A gunner, from the CC0 library's clips. Sat in the seat (its sitting
   * clip), the gun in their lap. Out of the window to aim: slid to the door
   * and sat up, the upper body tipped out along the window's lean
   * (gunnerBody), the pistol aim poses blended to the aim's pitch and turned
   * to its yaw — hips a little, the spine the rest. A pistol stays in the hand
   * the pose holds it in, its barrel laid exactly on the aim; a long gun is
   * shouldered along the aim with both hands on it. Aiming across the
   * car, up over the roof, the same, stood on the seat. Reloading, they duck
   * back in a little; each shot plays the library's recoil on top.
   */
  private poseGunner(g: GunnerActions, p: FigurePose, dt: number, lean: number, car: THREE.Object3D): void {
    const side = p.side === 'right' ? 1 : -1;
    const ease = 1 - Math.exp(-dt * 10);
    const toWorldDir = (x: number, y: number, z: number): THREE.Vector3 => new THREE.Vector3(x, y, z).transformDirection(car.matrixWorld);
    const toWorld = (v: THREE.Vector3): THREE.Vector3 => v.clone().applyMatrix4(car.matrixWorld);
    car.updateMatrixWorld();
    const carUp = toWorldDir(0, 1, 0);
    const follow = this.aimed ? 1 - Math.exp(-dt * 18) : 1;
    this.aimYaw = lerpAngle(this.aimYaw, p.yaw, follow);
    this.aimPitch += (p.pitch - this.aimPitch) * follow;
    this.aimed = true;
    const yaw = this.aimYaw;

    // A gun change: the gun dips out of the window and the new one comes up.
    this.setGun(p.gun);
    this.swap = Math.max(0, this.swap - dt / SWAP_SECONDS);
    if (this.pendingGun !== undefined && this.swap <= 0.5) this.putGun(this.pendingGun);
    if (this.gunId && PISTOLS.has(this.gunId) && !this.hold) this.holdGun(g);
    this.recoil = Math.max(0, this.recoil - dt * 9);
    const A = lean * (1 - 0.85 * Math.sin(this.swap * Math.PI));
    this.reloadPhase = p.reload ? this.reloadPhase + dt : 0;
    const reloadW = p.reload ? Math.min(1, this.reloadPhase * 6) : 0;

    // The clips: sat, or the aim poses (by pitch, between the pitches they hold
    // the gun at), the reload over either.
    const P = this.posePitch;
    const pitch = THREE.MathUtils.clamp(this.aimPitch, P.down, P.up);
    const up = pitch >= P.mid ? (pitch - P.mid) / Math.max(1e-3, P.up - P.mid) : 0;
    const down = pitch < P.mid ? (P.mid - pitch) / Math.max(1e-3, P.mid - P.down) : 0;
    const aimW = (1 - reloadW) * 0.92 * A;
    for (const action of this.actions.values()) action.setEffectiveWeight(0);
    g.sitLower.setEffectiveWeight(1);
    g.sitUpper.setEffectiveWeight((1 - reloadW) * (1 - A));
    g.aim.up.setEffectiveWeight(up * aimW);
    g.aim.mid.setEffectiveWeight((1 - up - down) * aimW);
    g.aim.down.setEffectiveWeight(down * aimW);
    g.idle.setEffectiveWeight((1 - reloadW) * 0.08 * A);
    g.reload.setEffectiveWeight(reloadW);
    g.reload.time = this.reloadPhase % g.reload.getClip().duration;
    this.mix(dt);

    // The hips: on the seat, or where this window puts them leaning out
    // (gunnerBody); they settle with the car's heave.
    const roof = this.roof * lean;
    const hip = p.seat.clone().lerp(this.outHips, lean * (1 - 0.35 * reloadW));
    hip.y += THREE.MathUtils.clamp(-this.g.y * 0.004, -0.04, 0.04);
    this.root.position.copy(hip).addScaledVector(this.hipsRest, -FIGURE_SCALE);
    this.root.updateMatrixWorld(true);
    if (import.meta.env.DEV && (window as unknown as { __figureRest?: boolean }).__figureRest) return;

    // Which way the body faces: sat, the road ahead; out, the aim; reloading,
    // in toward the front with the gun. Measured from the window, so an aim
    // swept past straight behind does not wrap round through the nose (the
    // wrap is across the car, over the roof). The hips stay forward on the seat
    // for an aim ahead and turn with it as it goes round toward the back, where
    // no chest can twist that far alone; up over the roof they face across it.
    const outward = side > 0 ? -Math.PI / 2 : Math.PI / 2;
    const aimFaced = outward + wrapAngle(yaw - outward);
    const faced = THREE.MathUtils.lerp(THREE.MathUtils.lerp(-side * 0.12, aimFaced, A), -side * 0.35, reloadW);
    const atWindow = Math.sign(faced) * Math.max(0, Math.abs(faced) - 0.6) * 0.6;
    const overRoof = -outward + THREE.MathUtils.clamp(wrapAngle(yaw + outward), -1.2, 1.2) * 0.45;
    this.pelvis = lerpAngle(this.pelvis, lerpAngle(atWindow, overRoof, roof), ease);
    twistBone(this.bone('Hips'), carUp, this.pelvis);

    // Legs: feet on the floor ahead of the seat, knees up (the seats are low
    // for these tall bodies); up over the roof, stood on the seat.
    for (const [limb, sx] of [
      [this.legs.left, -1],
      [this.legs.right, 1],
    ] as const) {
      const floor = p.seat.clone().add(new THREE.Vector3(-side * 0.06 + sx * 0.13, -0.2, -0.5));
      const stood = p.seat.clone().add(new THREE.Vector3(-side * 0.15 + sx * 0.14, -0.02, 0.05));
      const pole = new THREE.Vector3(0, 0.6, -1).lerp(new THREE.Vector3(-side * 0.8, -0.3, -0.4), roof);
      this.reach(limb, toWorld(floor.lerp(stood, roof)), pole.transformDirection(car.matrixWorld));
    }

    // The spine: the clip's own curve, turned as a whole along this window's
    // lean; it sways against the car's acceleration.
    const base = this.bone('Spine').getWorldPosition(new THREE.Vector3());
    const top = this.bone('Neck').getWorldPosition(new THREE.Vector3());
    const give = 0.012 * (1 - 0.4 * lean);
    const spine = top
      .clone()
      .sub(base)
      .normalize()
      .lerp(this.outSpine.clone().transformDirection(car.matrixWorld), lean * (1 - 0.5 * reloadW))
      .add(toWorldDir(-this.g.x * give, 0, -this.g.z * give))
      .normalize();
    aimBoneAt(this.bone('Spine'), top, spine);
    // Turned the rest of the way to the aim about the spine's ACTUAL axis:
    // twisting a large angle about any other axis tips the torso over sideways.
    const axis = this.bone('Neck').getWorldPosition(new THREE.Vector3()).sub(this.bone('Spine').getWorldPosition(new THREE.Vector3())).normalize();
    const rest = wrapAngle(faced - this.pelvis);
    twistBone(this.bone('Spine'), axis, rest * 0.3);
    twistBone(this.bone('Spine1'), axis, rest * 0.35);
    twistBone(this.bone('Spine2'), axis, rest * 0.35);

    // The barrel exactly on the aim: the chest turns the last of the way (a
    // little; the pose has it nearly right), then rolls the gun upright.
    const cosP = Math.cos(this.aimPitch);
    const aimWorld = toWorldDir(-Math.sin(yaw) * cosP, Math.sin(this.aimPitch), -Math.cos(yaw) * cosP);
    const settle = (1 - Math.min(1, reloadW * 2)) * A;
    if (this.hold && settle > 0) {
      this.placeGun();
      const fix = new THREE.Quaternion().setFromUnitVectors(this.barrel(), aimWorld);
      const angle = 2 * Math.acos(THREE.MathUtils.clamp(fix.w, -1, 1));
      rotateBone(this.bone('Spine2'), new THREE.Quaternion().slerp(fix, Math.min(1, 0.7 / Math.max(angle, 1e-4)) * settle));
      this.placeGun();
      const dir = this.barrel();
      const gunUp = new THREE.Vector3(0, 1, 0).transformDirection(this.gunHolder.matrixWorld).projectOnPlane(dir).normalize();
      const wantUp = carUp.clone().projectOnPlane(dir).normalize();
      twistBone(this.bone('Spine2'), dir, Math.atan2(_a.crossVectors(gunUp, wantUp).dot(dir), gunUp.dot(wantUp)) * 0.85 * settle);
    }

    // A pistol: the support hand round the grip too; back in the lap sat in
    // the seat, and on the gun as the reload clip has it. A long gun: shouldered
    // along the aim, both hands placed on it.
    this.placeGun();
    if (this.hold && reloadW < 0.99 && A > 0.01) {
      const fore = GRIPS[this.gunId ?? 'rifle'].fore;
      const target = new THREE.Vector3(fore[0], fore[1], -fore[2]).applyMatrix4(this.gunHolder.matrixWorld);
      target.lerp(this.palm(this.arms.left), Math.max(reloadW, 1 - A));
      this.reach(this.arms.left, target, toWorldDir(-side * 0.3, -1, 0));
      // Cupped round the gun hand: palm toward it, fingers over its knuckles.
      const m = this.gunHolder.matrixWorld;
      const gunRight = new THREE.Vector3(1, 0, 0).transformDirection(m);
      const gunDown = new THREE.Vector3(0, -1, 0).transformDirection(m);
      this.grip('Left', gunRight, gunDown.addScaledVector(this.barrel(), 0.4), 0.6 * A * (1 - reloadW));
    } else if (!this.hold && this.gunId) {
      // Bladed to the gun: the chest turns a little further, the support
      // shoulder forward toward the handguard.
      twistBone(this.bone('Spine2'), axis, -0.3 * lean);
      const shoulder = this.arms.right.root.getWorldPosition(new THREE.Vector3());
      this.shoulderGun(p, lean, 0, toWorld(p.seat.clone().add(new THREE.Vector3(0.18, 0.18, -0.2))), aimWorld, shoulder);
    }

    // The head: down the sights out of the window, at the gun reloading; sat
    // in the seat, roughly the way they are aiming, with the odd glance about.
    const head = this.bone('Head');
    const lookYaw = THREE.MathUtils.clamp(wrapAngle(yaw), -1.1, 1.1) * 0.8 + this.glance * 0.3;
    const sat = toWorldDir(-Math.sin(lookYaw), -0.1, -Math.cos(lookYaw)).normalize();
    const aimLook = reloadW > 0.3 && this.hold ? this.barrel().lerp(carUp.clone().negate(), 0.4).normalize() : aimWorld.clone().addScaledVector(carUp, -0.08).normalize();
    const look = sat.lerp(aimLook, Math.max(A, reloadW)).normalize();
    const facing = this.headFwd.clone().applyQuaternion(head.getWorldQuaternion(_w));
    rotateBone(head, new THREE.Quaternion().slerp(new THREE.Quaternion().setFromUnitVectors(facing, look), 0.75));
    // Shot: the head snaps along the round (hard for a head hit) and comes back.
    this.hurt = Math.max(0, this.hurt - dt * 2);
    if (this.hurt > 0) {
      const axis = new THREE.Vector3().crossVectors(carUp, this.hurtDir);
      if (axis.lengthSq() > 1e-6) twistBone(head, axis.normalize(), (this.hurtHead ? 0.6 : 0.25) * this.hurt * this.hurt);
    }

    this.placeGun();
    this.gunHolder.visible = this.gunId !== null;
  }

  /**
   * Put the gun in the right hand, as the level aim pose holds it: the grip in
   * the palm, the barrel on along the forearm, upright. Then measure the pitch
   * each aim pose holds it at, so the poses can be blended to an aim.
   */
  private holdGun(g: GunnerActions): void {
    const gun = this.gunHolder.children[0];
    if (!gun || !this.gunId) return;
    const only = (pose: THREE.AnimationAction): void => {
      for (const action of this.actions.values()) action.setEffectiveWeight(0);
      g.sitLower.setEffectiveWeight(1);
      pose.setEffectiveWeight(1);
      this.mix(0);
    };
    only(g.aim.mid);
    const hand = this.arms.right.end;
    const palm = this.palm(this.arms.right);
    const dir = palm.clone().sub(this.arms.right.mid.getWorldPosition(new THREE.Vector3())).normalize();
    const right = new THREE.Vector3().crossVectors(dir, new THREE.Vector3(0, 1, 0).transformDirection(this.root.matrixWorld)).normalize();
    const up = new THREE.Vector3().crossVectors(right, dir).normalize();
    const grip = GRIPS[this.gunId].grip;
    const S = HAND_GUN_SCALE;
    const butt = palm
      .addScaledVector(right, -grip[0] * S)
      .addScaledVector(up, -grip[1] * S)
      .addScaledVector(dir, -grip[2] * S);
    const rotation = new THREE.Quaternion().setFromRotationMatrix(new THREE.Matrix4().makeBasis(right, up, dir.clone().negate()));
    const world = new THREE.Matrix4().compose(butt, rotation, new THREE.Vector3(S, S, S));
    const bounds = new THREE.Box3().setFromObject(gun.clone());
    this.hold = { inHand: hand.matrixWorld.clone().invert().multiply(world), muzzleZ: Math.min(-0.2, bounds.min.z) };
    const toFigure = this.root.matrixWorld.clone().invert();
    for (const k of ['up', 'mid', 'down'] as const) {
      only(g.aim[k]);
      this.placeGun();
      const d = this.barrel().transformDirection(toFigure);
      this.posePitch[k] = Math.asin(THREE.MathUtils.clamp(d.y, -1, 1));
    }
  }

  /** The gun where the right hand holds it. */
  private placeGun(): void {
    if (!this.hold) return;
    const world = this.arms.right.end.matrixWorld.clone().multiply(this.hold.inHand);
    this.root.matrixWorld
      .clone()
      .invert()
      .multiply(world)
      .decompose(this.gunHolder.position, this.gunHolder.quaternion, this.gunHolder.scale);
    this.gunHolder.updateMatrixWorld(true);
  }

  /** Which way the barrel points, world (butt to muzzle). */
  private barrel(): THREE.Vector3 {
    const m = this.gunHolder.matrixWorld;
    const butt = new THREE.Vector3().setFromMatrixPosition(m);
    return new THREE.Vector3(0, 0, this.hold?.muzzleZ ?? -0.6).applyMatrix4(m).sub(butt).normalize();
  }

  /**
   * Where the drawn gun's barrel ends, world: what a shot's flash and tracer
   * start from. Null unless a window gunner is out with their gun up.
   */
  muzzle(): THREE.Vector3 | null {
    if (!this.gunnerPosed || !this.tip || !this.gunHolder.visible || this.lean < 0.5) return null;
    this.gunHolder.updateWorldMatrix(true, false);
    return this.tip.clone().applyMatrix4(this.gunHolder.matrixWorld);
  }

  /**
   * Shot (a window gunner, out): `at` where the round struck, `dir` the way it
   * was travelling (world). Head or chest, whichever drawn one is nearer: the
   * library's flinch plays over the pose, the gun is knocked off the aim and
   * the head snaps along the round, recovering over half a second.
   */
  hit(at: THREE.Vector3, dir: THREE.Vector3): void {
    if (!this.gunner || this.lean < 0.5) return;
    const head = this.bone('Head').getWorldPosition(new THREE.Vector3());
    const chest = this.bone('Spine2').getWorldPosition(new THREE.Vector3());
    this.hurtHead = at.distanceTo(head) < at.distanceTo(chest);
    this.hurt = 1;
    this.hurtDir.copy(dir).normalize();
    this.recoil = Math.min(1.6, this.recoil + 1.2);
    this.gunner.hit?.[this.hurtHead ? 'head' : 'chest'].reset().setEffectiveWeight(1).play();
  }

  /** A shot was fired from this seat: the gun kicks back into the shoulder. */
  kick(): void {
    // Each gun kicks its own way: a light, quick SMG; a heavy shotgun or revolver.
    const strength = KICK[this.gunId ?? 'rifle'] ?? 1;
    this.recoil = Math.min(1.6, this.recoil + strength);
    if (this.gunner) this.gunner.shoot.reset().setEffectiveWeight(Math.min(1.4, strength)).play();
    else this.recoilAction?.reset().setEffectiveWeight(strength).play();
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
    this.hold = null; // held afresh (`holdGun`)
    for (const child of [...this.gunHolder.children]) this.gunHolder.remove(child);
    this.tip = null;
    if (!id) return;
    const gun = this.makeGun(id);
    this.tip = barrelTip(gun);
    this.gunHolder.add(gun);
  }

  dispose(): void {
    for (const m of this.tinted) m.dispose();
  }
}
