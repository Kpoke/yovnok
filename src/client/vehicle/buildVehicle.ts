/**
 * The vehicle rig — a named part graph.
 *
 * Part ids mirror the simulation's modules (DESIGN.md §4.1) so the thing you
 * damage is the thing you can see:
 *
 *     chassis            hull integrity (the kill condition)
 *     engine             power / boost
 *     wheel.fl/fr/rl/rr  mobility, traction
 *     seat.*             crew positions, each with a field of fire
 *
 * NOTE ON SEATS. Crew positions were originally gun *stations* with mounted
 * weapons and turret traverse. They are now seats inside a civilian car: gunners
 * fire out of the windows, so a position's field of fire comes from which window
 * it sits beside, not from a turret's traverse rate. Each seat exposes `eye`
 * (M4's per-seat camera) and `firePort` (M5's weapon origin, on armed seats
 * only — the driver is unarmed, DESIGN.md §3.1).
 */

import type { Figure, FigureLibrary } from './figures';
import type { CrewPose } from '../net';
import { GUNNER_PRIMARIES, GUNNER_SECONDARY } from '../../shared/weapons';
import * as THREE from 'three';
import { DAMAGE_FX, type VehicleSpec } from '../../shared/config';
import { damageOf, type DamageAnchors } from '../damageFx';
import { copyPaint } from './gltfPartLibrary';
import type { LightAnchors } from '../carLights';
import {
  ACCENTS,
  clampLook,
  DEFAULT_LOOK,
  GLOWS,
  LIVERIES,
  loadoutOf,
  ROOFS,
  WHEELS,
  type CosmeticLook,
} from '../../shared/cosmetics';
import { buildGun } from './guns';
import { buildBodyKit, buildDecals } from './bodyKits';
import { CABIN, gunnerBody, seatsFor } from '../../shared/crews';
import { componentIntegrity, type ComponentId } from '../../shared/components';
import type { VehicleInput, VehicleState } from '../../shared/vehicle';
import { createMaterials, disposeMaterials, type SeatSide, type VehicleMaterials } from './parts';
import { proceduralPartLibrary, type PartLibrary } from './partLibrary';

export type PartId =
  | 'chassis'
  | 'engine'
  | 'wheel.fl'
  | 'wheel.fr'
  | 'wheel.rl'
  | 'wheel.rr'
  | 'seat.driver'
  | 'seat.frontRight'
  | 'seat.rearLeft'
  | 'seat.rearRight'
  | 'turret';

export type VehiclePart = {
  id: PartId;
  /** Root object of this part, positioned at its mount on the chassis. */
  group: THREE.Group;
  /** Named cosmetic and gameplay attachment points, in the part's local space. */
  sockets: Record<string, THREE.Object3D>;
};

export type VehicleRig = {
  root: THREE.Group;
  spec: VehicleSpec;
  parts: Map<PartId, VehiclePart>;
  part(id: PartId): VehiclePart | undefined;
  /** Every seat the crew can occupy, driver first. */
  seats: PartId[];
  /**
   * The people inside, by seat (`Net.crewOf`): a figure in each occupied
   * seat, posed for what they are doing. Seats not listed are empty.
   */
  setCrew: (crew: ReadonlyMap<string, CrewPose>, dt: number) => void;
  /** A shot left this seat: its person's gun kicks. */
  kick: (seatId: string) => void;
  /**
   * Turn the car-mounted guns: one aim per mounted weapon (slot order), relative
   * to the car's nose, already clamped to that weapon's limits. Every gun of a
   * weapon turns together (twin guns converge by firing from their muzzles).
   */
  setWeaponAims: (aims: ReadonlyArray<{ yaw: number; pitch: number }>) => void;
  /** Where its headlights and tail lights are, car-local (left side; mirror x). */
  lightAnchors: LightAnchors;
  /** Cast shadows (the big meshes only) or none: off for distant cars. */
  setShadowDetail: (on: boolean) => void;
  /** Where damage smoke and fire come from, car-local (client/damageFx.ts). */
  damageAnchors: DamageAnchors;
  /** 0..1 from the last `update`'s vitals: what the damage effects show. */
  readonly damage: number;
  /** Diagnostics: occupant meshes by seat, for `scripts/seatprobe.mjs`. */
  occupantMeshes: Map<PartId, THREE.Object3D[]>;
  /**
   * @param vitals  Hull integrity, for damage effects. Kept out of `VehicleState`
   *   on purpose: hull does not affect motion, so the simulation never sees it.
   */
  update(
    state: VehicleState,
    input: VehicleInput,
    dt: number,
    vitals?: { hull: number; maxHull: number },
  ): void;
  dispose(): void;
};

const FRONT_WHEELS: PartId[] = ['wheel.fl', 'wheel.fr'];

/**
 * Assemble a vehicle.
 *
 * `library` decides where the geometry comes from — procedural today, glTF
 * assets whenever they exist. Nothing else in the rig changes.
 */
export function buildVehicle(
  spec: VehicleSpec,
  look: CosmeticLook = DEFAULT_LOOK,
  library: PartLibrary = proceduralPartLibrary,
  figures: FigureLibrary | null = null,
): VehicleRig {
  const skin = clampLook(look);
  const livery = LIVERIES[skin.livery];
  const wheelStyle = WHEELS[skin.wheels];
  const materials: VehicleMaterials = createMaterials(livery.body, livery.finish, wheelStyle.hub);
  // The pattern rides on the body material into the paint layer (gltfPartLibrary.tint).
  if (skin.pattern > 0) {
    materials.body.userData.pattern = { kind: skin.pattern, accent: new THREE.Color(ACCENTS[skin.accent].colour) };
  }
  const root = new THREE.Group();
  // Yaw, then pitch, then roll — the order a vehicle reads in.
  root.rotation.order = 'YXZ';
  root.name = `vehicle:${spec.id}`;

  const parts = new Map<PartId, VehiclePart>();
  const wheelPivots = new Map<PartId, THREE.Group>();
  const seats: PartId[] = [];

  const attach = (id: PartId, built: { group: THREE.Group; sockets: Record<string, THREE.Object3D> }, x: number, y: number, z: number): THREE.Group => {
    built.group.position.set(x, y, z);
    built.group.name = id;
    root.add(built.group);
    parts.set(id, { id, group: built.group, sockets: built.sockets });
    return built.group;
  };

  // ---- hull and engine -------------------------------------------------
  const chassis = attach('chassis', library.create({ kind: 'chassis', cls: spec.id }, materials), 0, 0, 0);
  // Cosmetic roof attachment (M12), pinned to the chassis's own `roofRack`
  // socket so the two libraries cannot drift on where a roof rack belongs.
  const roofSocket = parts.get('chassis')?.sockets['roofRack'];
  if (roofSocket) {
    const roof = library.create({ kind: 'roof', cls: spec.id, style: skin.roof }, materials);
    roof.group.position.copy(roofSocket.position);
    chassis.add(roof.group);
  }
  // Bolt-ons and door decals, placed against the chassis's measured size (the
  // realistic chassis has no roof socket; the kits fit any body).
  const bodyBox = new THREE.Box3().setFromObject(chassis);
  if (!bodyBox.isEmpty()) {
    const kit = roofSocket ? null : buildBodyKit(ROOFS[skin.roof].kind, bodyBox);
    if (kit) root.add(kit);
    const decals = buildDecals(skin.decal, skin.number, ACCENTS[skin.accent].colour, bodyBox);
    if (decals) root.add(decals);
  }
  // Engine sits under the bonnet, forward of the cabin. The low body shape
  // (coupe AND solo brawler) shares the coupe's mount; only the tall SUV differs.
  const engineZ = spec.id === 'suv' ? -1.7 : -1.45;
  // Under the bonnet: the armoured truck's bonnet is low relative to its tall
  // chassis box, so its engine sits lower than the cars'.
  const engineY = spec.id === 'suv' ? 0.0 : spec.id === 'solo' ? -0.25 : 0.14;
  const engine = attach('engine', library.create({ kind: 'engine', cls: spec.id }, materials), 0, engineY, engineZ);
  // Every car has a closed bonnet (the realistic bodies): the engine can never
  // be seen — on the duo car and the squad truck it stood up through the bonnet
  // as a block — and it was twelve draw calls a car with the shadow pass.
  engine.visible = false;

  // ---- wheels ----------------------------------------------------------
  const wheelY = -(spec.rideHeight - spec.wheelRadius);
  const wheelMounts: Array<[PartId, number, number]> = [
    ['wheel.fl', -spec.track / 2, -spec.wheelbase / 2],
    ['wheel.fr', spec.track / 2, -spec.wheelbase / 2],
    ['wheel.rl', -spec.track / 2, spec.wheelbase / 2],
    ['wheel.rr', spec.track / 2, spec.wheelbase / 2],
  ];
  for (const [id, x, z] of wheelMounts) {
    const pivot = new THREE.Group();
    pivot.rotation.order = 'YXZ';
    pivot.position.set(x, wheelY, z);
    root.add(pivot);

    const built = library.create({ kind: 'wheel', cls: spec.id, style: skin.wheels }, materials);
    // One wheel model serves all four corners, authored with its hub facing the
    // car's left. Mirror it on the right so every hub faces outward. (Three.js
    // flips the face winding for a negative scale, so lighting stays correct.)
    if (x > 0) built.group.scale.x *= -1;
    pivot.add(built.group);
    wheelPivots.set(id, pivot);
    parts.set(id, { id, group: built.group, sockets: built.sockets });
  }

  /** Per armed seat, the meshes that represent a living occupant. */
  const occupantMeshes = new Map<PartId, THREE.Object3D[]>();

  // ---- crew seats ------------------------------------------------------
  for (const seat of seatsFor(spec.id)) {
    attach(
      seat.id as PartId,
      library.create(
        // "Armed" here means a GUNNER at a window: the seat builder draws them
        // leaning out of it. An armed DRIVER (the solo car, whose arc comes from
        // its mounted guns) sits inside behind the glass — drawing the window
        // figure put a box sticking out of the car's flank. The server agrees:
        // a driver is hit-tested at the eye, inside the cabin (`headWorld`).
        { kind: 'seat', cls: spec.id, side: seat.side, armed: seat.arc !== null && !seat.drives },
        materials,
      ),
      seat.mount[0],
      seat.mount[1],
      seat.mount[2],
    );
    const meshes: THREE.Object3D[] = [];
    parts.get(seat.id as PartId)?.group.traverse((object) => {
      if (object.name === 'occupant') meshes.push(object);
    });
    occupantMeshes.set(seat.id as PartId, meshes);
    seats.push(seat.id as PartId);
  }

  // Car-mounted weapons: one pivot per physical gun, at its mount, so the gun
  // can traverse and elevate about the point it is bolted on at.
  const weaponPivots: THREE.Group[][] = [];
  const gunSeat = seatsFor(spec.id).find((seat) => seat.mounted);
  // The guns chosen in the garage (primary on the bumpers, secondary on the roof).
  const chosen = gunSeat?.mounted?.length === 2 ? loadoutOf(skin) : null;
  (gunSeat?.mounted ?? []).forEach((weapon, slot) => {
    const pivots: THREE.Group[] = [];
    const id = chosen?.[slot] ?? weapon.weapon;
    weapon.mounts.forEach((mount, index) => {
      const pivot = new THREE.Group();
      pivot.rotation.order = 'YXZ';
      pivot.position.set(mount.pivot[0], mount.pivot[1], mount.pivot[2]);
      pivot.name = `${weapon.part}.${index}`;
      root.add(pivot);
      // A gun with its own model (the .50s, the RPG), or one built from shapes.
      const custom = id !== weapon.weapon ? buildGun(id, mount.muzzle) : null;
      if (custom) {
        pivot.add(custom);
      } else {
        const built = library.create({ kind: weapon.part, cls: spec.id }, materials);
        pivot.add(built.group);
        if (weapon.part === 'turret') parts.set('turret', { id: 'turret', group: built.group, sockets: built.sockets });
      }
      pivots.push(pivot);
    });
    weaponPivots.push(pivots);
  });

  // Underglow: a neon pool of light under the car (additive, no real light).
  const glow = GLOWS[skin.glow];
  if (glow.colour) root.add(underglow(glow.colour, spec));
  const setWeaponAims = (aims: ReadonlyArray<{ yaw: number; pitch: number }>): void => {
    aims.forEach((aim, i) => {
      for (const pivot of weaponPivots[i] ?? []) {
        // Vehicle convention: +yaw turns left, which is +rotation about Y for a
        // -Z-forward model; +pitch raises the muzzle, which is +rotation about X.
        pivot.rotation.y = aim.yaw;
        pivot.rotation.x = aim.pitch;
      }
    });
  };

  // ---- damage ----------------------------------------------------------
  // Where smoke and fire come from: the engine bay (top of the bonnet) and the
  // rear (fuel), car-local.
  const damageAnchors: DamageAnchors = {
    engine: new THREE.Vector3(0, spec.id === 'suv' ? 0.5 : 0.35, engineZ),
    rear: new THREE.Vector3(0, 0.3, spec.halfLength * 0.7),
  };
  let damage = 0;

  // Lamps (client/carLights.ts), placed from the chassis model's own bounds so
  // any car gets them where its nose and tail actually are. Front is −Z.
  const body = new THREE.Box3().setFromObject(chassis);
  const lightAnchors: LightAnchors = {
    head: new THREE.Vector3(body.max.x * 0.68, THREE.MathUtils.lerp(body.min.y, body.max.y, 0.45), body.min.z - 0.03),
    tail: new THREE.Vector3(body.max.x * 0.72, THREE.MathUtils.lerp(body.min.y, body.max.y, 0.55), body.max.z + 0.03),
  };

  /**
   * Scorch the body: paint darkens toward soot and loses its sheen as damage
   * grows. Materials are shared between cars with the same look, so the first
   * time a car is damaged it takes private copies (textures stay shared).
   * Re-tinted only when the scorch level crosses a step, not every frame.
   */
  const scorched = new Map<THREE.Material, THREE.MeshStandardMaterial>();
  const originals = new Map<THREE.MeshStandardMaterial, { colour: THREE.Color; roughness: number; metalness: number }>();
  const SOOT = new THREE.Color(0x15110e);
  let scorchStep = 0;
  const scorch = (level: number): void => {
    const [, smoking] = DAMAGE_FX.stages;
    const amount = THREE.MathUtils.clamp((level - smoking) / (1 - smoking), 0, 1);
    const step = Math.round(amount * 10);
    if (step === scorchStep) return;
    scorchStep = step;
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      const own = (m: THREE.Material): THREE.Material => {
        const standard = m as THREE.MeshStandardMaterial;
        if (!standard.isMeshStandardMaterial || originals.has(standard)) return m;
        let copy = scorched.get(m);
        if (!copy) {
          copy = standard.clone();
          copyPaint(standard, copy); // clone() drops the paint shader
          scorched.set(m, copy);
          originals.set(copy, { colour: copy.color.clone(), roughness: copy.roughness, metalness: copy.metalness });
        }
        return copy;
      };
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(own) : own(mesh.material);
    });
    const k = (step / 10) * DAMAGE_FX.maxScorch;
    for (const [material, original] of originals) {
      material.color.copy(original.colour).lerp(SOOT, k);
      material.roughness = THREE.MathUtils.lerp(original.roughness, 1, k);
      material.metalness = THREE.MathUtils.lerp(original.metalness, 0.1, k);
    }
  };

  // ---- shadow detail -----------------------------------------------------
  // Every mesh used to cast a shadow, so each car drew ~39 meshes twice. A
  // shadow is a few texels of a 2048 map spread over ~220 m: a charging handle
  // or the driver's head cannot show in it. So only each part's BIG meshes cast
  // (≥15% of the triangles at their LOD level), and only while the car is near
  // enough for its shadow to read (`setShadowDetail`, driven by distance).
  const shadowCasters: THREE.Mesh[] = [];
  {
    const byLevel = new Map<THREE.Object3D, THREE.Mesh[]>();
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      mesh.castShadow = false;
      const level = mesh.parent ?? root;
      const list = byLevel.get(level) ?? [];
      list.push(mesh);
      byLevel.set(level, list);
    });
    const triangles = (m: THREE.Mesh): number => (m.geometry.index ? m.geometry.index.count : m.geometry.attributes.position.count) / 3;
    const occupants = new Set([...occupantMeshes.values()].flat());
    for (const meshes of byLevel.values()) {
      const total = meshes.reduce((sum, m) => sum + triangles(m), 0);
      for (const mesh of meshes) {
        if (occupants.has(mesh) || triangles(mesh) < total * 0.15) continue;
        mesh.castShadow = true;
        shadowCasters.push(mesh);
      }
    }
  }
  let shadowsOn = true;
  const setShadowDetail = (on: boolean): void => {
    if (on === shadowsOn) return;
    shadowsOn = on;
    for (const mesh of shadowCasters) mesh.castShadow = on;
  };

  // ---- behaviour -------------------------------------------------------

  let wheelSpin = 0;

  /**
   * @param vitals  Hull integrity, for damage smoke. Not part of `VehicleState`
   *   because hull does not affect motion — the simulation has no business
   *   knowing it, and the renderer does.
   */
  const update = (
    state: VehicleState,
    input: VehicleInput,
    dt: number,
    vitals?: { hull: number; maxHull: number },
  ): void => {
    root.position.set(state.pos.x, state.pos.y, state.pos.z);
    root.rotation.y = state.yaw;
    root.rotation.x = state.pitch;
    root.rotation.z = state.roll;

    // Rolling forward (-Z) is negative rotation about the vehicle's X axis.
    wheelSpin -= (state.forwardSpeed / spec.wheelRadius) * dt;

    for (const id of FRONT_WHEELS) {
      const pivot = wheelPivots.get(id);
      if (pivot) pivot.rotation.y = -input.steer * 0.42;
    }
    steer = input.steer;

    for (const [id, pivot] of wheelPivots) {
      const hurt = 1 - componentIntegrity(state.components, id as ComponentId);
      // A destroyed wheel is locked — it drags rather than rolls. A damaged one
      // wobbles and sits low, so a flat tyre is legible before it is fatal.
      if (hurt < 1) pivot.rotation.x = wheelSpin;
      pivot.rotation.z = hurt * 0.4 * Math.sin(wheelSpin * 2.1 + id.length);
      pivot.position.y = wheelY - hurt * spec.wheelRadius * 0.2;
    }

    // ---- damage: the body scorches as the car is shot up --------------------
    // (Smoke and fire are world-space particles in client/damageFx.ts, fed from
    // `damageAnchors` and `damage`.)
    damage = vitals ? damageOf(vitals.hull / vitals.maxHull, componentIntegrity(state.components, 'engine')) : 0;
    scorch(damage);
  };

  /**
   * The people (DESIGN.md §3.2): a figure in every occupied seat, wearing that
   * person's outfit in the car's paint, posed each frame. An empty seat is
   * empty, so you can see which windows hold a gunner.
   */
  const seated = new Map<string, { figure: Figure; outfit: number }>();
  /** The steering of the last `update`, for the driver's hands. */
  let steer = 0;
  const seatDefs = new Map(seatsFor(spec.id).map((seat) => [seat.id as string, seat]));
  // A car whose gunner stands up through the roof gets the hatch: a rim
  // round them. (No lid: propped open behind them it hid the gunner from the
  // chase camera.)
  const hatch = CABIN[spec.id]?.hatch;
  if (hatch && figures) {
    const metal = new THREE.MeshStandardMaterial({ color: 0x2a2f35, roughness: 0.55, metalness: 0.6 });
    const roofY = CABIN[spec.id]!.roof;
    for (const seat of seatDefs.values()) {
      if (seat.drives || !seat.arc) continue;
      const s = seat.side === 'right' ? 1 : -1;
      const group = new THREE.Group();
      group.name = 'hatch';
      group.position.set(s * hatch.x, roofY - 0.01, hatch.z);
      const rim = new THREE.Mesh(new THREE.CylinderGeometry(0.31, 0.33, 0.07, 20, 1, true), metal);
      rim.position.y = 0.02;
      const hole = new THREE.Mesh(new THREE.CircleGeometry(0.31, 20).rotateX(-Math.PI / 2), new THREE.MeshBasicMaterial({ color: 0x07090b }));
      hole.position.y = 0.012;
      group.add(rim, hole);
      root.add(group);
    }
  }
  const setCrew = (crew: ReadonlyMap<string, CrewPose>, dt: number): void => {
    for (const [seatId, entry] of seated) {
      const pose = crew.get(seatId);
      if (pose && pose.outfit === entry.outfit) continue;
      root.remove(entry.figure.root);
      entry.figure.dispose();
      seated.delete(seatId);
    }
    if (!figures?.ready) return;
    for (const [seatId, pose] of crew) {
      const seat = seatDefs.get(seatId);
      if (!seat) continue;
      let entry = seated.get(seatId);
      if (!entry) {
        const figure = figures.create(pose.outfit, livery.body);
        if (!figure) continue;
        entry = { figure, outfit: pose.outfit };
        seated.set(seatId, entry);
        root.add(figure.root);
      }
      const driver = seat.drives;
      // (A dev pose without `roof` takes it from the aim.)
      const body = gunnerBody(spec.id, seat, pose.yaw, pose.roof === undefined ? undefined : pose.roof ? 1 : 0);
      entry.figure.pose(
        {
          role: driver ? 'driver' : 'gunner',
          side: seat.side,
          seat: new THREE.Vector3(seat.mount[0], seat.mount[1] + 0.1, seat.mount[2] + 0.06),
          hips: new THREE.Vector3(...body.hips),
          spine: new THREE.Vector3(...body.spine),
          roof: driver ? 0 : body.roof,
          hatch: !driver && !!hatch,
          yaw: pose.yaw,
          // The aim carries the CAMERA pitch (positive looks down).
          pitch: -pose.pitch,
          out: pose.out,
          alive: pose.alive,
          gun: driver ? null : pose.slot === 1 ? GUNNER_SECONDARY : GUNNER_PRIMARIES[pose.gun] ?? GUNNER_PRIMARIES[0],
          reload: pose.reload,
          steer,
        },
        dt,
      );
    }
  };

  const dispose = (): void => {
    root.traverse((object) => {
      const mesh = object as THREE.Mesh;
      if (mesh.geometry) mesh.geometry.dispose();
    });
    for (const material of scorched.values()) material.dispose();
    for (const entry of seated.values()) entry.figure.dispose();
    disposeMaterials(materials);
  };

  return {
    root,
    spec,
    parts,
    occupantMeshes,
    part: (id) => parts.get(id),
    seats,
    update,
    setCrew,
    kick: (seatId) => seated.get(seatId)?.figure.kick(),
    setWeaponAims,
    setShadowDetail,
    damageAnchors,
    lightAnchors,
    get damage() {
      return damage;
    },
    dispose,
  };
}

/** A soft glow texture, shared by every car's underglow. */
let glowTexture: THREE.Texture | null = null;
function underglow(colour: number, spec: VehicleSpec): THREE.Mesh {
  if (!glowTexture) {
    const canvas = document.createElement('canvas');
    canvas.width = 64;
    canvas.height = 128;
    const ctx = canvas.getContext('2d')!;
    const g = ctx.createRadialGradient(32, 64, 4, 32, 64, 60);
    g.addColorStop(0, 'rgba(255,255,255,1)');
    g.addColorStop(0.5, 'rgba(255,255,255,0.45)');
    g.addColorStop(1, 'rgba(255,255,255,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, 64, 128);
    glowTexture = new THREE.CanvasTexture(canvas);
  }
  // Inside the car's own footprint: a pool of light under it, not a carpet.
  const width = spec.halfWidth * 2 * 0.95;
  const length = spec.wheelbase + 1.2;
  const plane = new THREE.PlaneGeometry(width, length);
  plane.rotateX(-Math.PI / 2);
  const mesh = new THREE.Mesh(
    plane,
    new THREE.MeshBasicMaterial({
      map: glowTexture,
      color: colour,
      transparent: true,
      opacity: 0.85,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      fog: true,
    }),
  );
  // Just above the ground under the car (the root sits at ride height).
  mesh.position.y = -spec.rideHeight + 0.06;
  mesh.renderOrder = 2;
  mesh.name = 'underglow';
  mesh.raycast = () => {};
  return mesh;
}
