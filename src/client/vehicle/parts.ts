/**
 * Vehicle part geometry.
 *
 * Two real vehicle classes (DESIGN.md §3.3): a modern two-seat coupe and a tall
 * four-seat SUV. Both are civilian cars — **nothing is bolted to them**.
 *
 * Gunners are seated INSIDE and fire out of the windows, so the geometry that
 * matters is the greenhouse: pillars, window apertures, and the seats those
 * gunners occupy. Each seat exposes two sockets:
 *
 *   `eye`       where the occupant's viewpoint sits — M4's per-seat camera
 *   `firePort`  the window aperture they shoot through — M5's weapon origin
 *
 * Bodies are **lofted from cross sections** rather than built from axis-aligned
 * boxes, because a car's readability is almost entirely in its profile: the
 * raked windscreen, the taper into the nose, the belt line. Box-swept bodies
 * look like vans. See `loft.ts`.
 *
 * Still stylised low-poly — that is the agreed art direction (DESIGN.md §9).
 * This file is the only one that changes if vehicles ever move to authored glTF
 * assets.
 */

import * as THREE from 'three';
import type { VehicleSpec } from '../../shared/config';
import type { Finish, RoofKind, WheelStyle } from '../../shared/cosmetics';
import { EYE_OFFSET, FIRE_PORT_OFFSET, HEAD_OFFSET } from '../../shared/crews';
import { loft, type LoftSection } from './loft';

export type VehicleMaterials = {
  body: THREE.Material;
  bodyDark: THREE.Material;
  trim: THREE.Material;
  glass: THREE.Material;
  interior: THREE.Material;
  seat: THREE.Material;
  metal: THREE.Material;
  wheel: THREE.Material;
  /** Rim and spokes. Separate from `hub` so a wheel style can recolour them. */
  rim: THREE.Material;
  hub: THREE.Material;
  lamp: THREE.Material;
  tailLamp: THREE.Material;
};

const flat = (color: number, extra: THREE.MeshStandardMaterialParameters = {}) =>
  new THREE.MeshStandardMaterial({ color, flatShading: true, roughness: 0.55, metalness: 0.35, ...extra });

/**
 * Paint finishes (M12). All four are the same base colour under different
 * surfaces — clearcoat and roughness are what make matte read as matte and
 * chrome as chrome, not a different hue.
 */
const FINISHES: Record<Finish, THREE.MeshPhysicalMaterialParameters> = {
  // A tight, bright highlight over a duller body: painted metal.
  gloss: { roughness: 0.34, metalness: 0.5, clearcoat: 1, clearcoatRoughness: 0.12 },
  matte: { roughness: 0.82, metalness: 0.12, clearcoat: 0.2, clearcoatRoughness: 0.7 },
  chrome: { roughness: 0.06, metalness: 1, clearcoat: 1, clearcoatRoughness: 0.04, envMapIntensity: 2 },
  // Sheen is what separates pearl from plain gloss white in this lighting rig.
  pearl: {
    roughness: 0.3,
    metalness: 0.35,
    clearcoat: 1,
    clearcoatRoughness: 0.16,
    sheen: 1,
    sheenRoughness: 0.35,
    sheenColor: new THREE.Color(0xffffff),
  },
};

export function createMaterials(
  accentColour: number,
  finish: Finish = 'gloss',
  rimColour = 0xa7b0bb,
): VehicleMaterials {
  return {
    // Car paint is a clearcoat over a coloured base: a tight, bright highlight
    // over a duller body, which is what makes a car read as painted metal rather
    // than coloured plastic. With `scene.environment` set, it reflects the sky.
    body: new THREE.MeshPhysicalMaterial({ color: accentColour, flatShading: true, ...FINISHES[finish] }),
    bodyDark: flat(0x24282e, { roughness: 0.5, metalness: 0.45 }),
    trim: flat(0x14171b, { roughness: 0.75, metalness: 0.15 }),
    // Tinted glass is NOT a mirror: it is a dark dielectric with a very glossy
    // surface, so it shows a bright sky reflection rather than behaving like
    // chrome. High `envMapIntensity` is what sells the glint.
    glass: flat(0x0a1016, { roughness: 0.05, metalness: 0.0, envMapIntensity: 1.8 }),
    interior: flat(0x1b1e23, { roughness: 0.92, metalness: 0.05 }),
    seat: flat(0x2c3138, { roughness: 0.95, metalness: 0.02 }),
    metal: flat(0x9aa3ad, { roughness: 0.28, metalness: 0.85 }),
    wheel: flat(0x0f1114, { roughness: 0.95, metalness: 0.05 }),
    rim: flat(rimColour, { roughness: 0.28, metalness: 0.9 }),
    hub: flat(0xa7b0bb, { roughness: 0.28, metalness: 0.9 }),
    lamp: new THREE.MeshStandardMaterial({
      color: 0xfff2d8,
      emissive: 0xfff2d8,
      emissiveIntensity: 1.6,
      flatShading: true,
    }),
    tailLamp: new THREE.MeshStandardMaterial({
      color: 0xff3b30,
      emissive: 0xff3b30,
      emissiveIntensity: 1.3,
      flatShading: true,
    }),
  };
}

export function disposeMaterials(m: VehicleMaterials): void {
  for (const material of Object.values(m)) material.dispose();
}

export type PartBuild = {
  group: THREE.Group;
  sockets: Record<string, THREE.Object3D>;
};

export type SeatSide = 'left' | 'right';

function socket(
  group: THREE.Group,
  sockets: Record<string, THREE.Object3D>,
  name: string,
  x: number,
  y: number,
  z: number,
): void {
  const node = new THREE.Object3D();
  node.name = name;
  node.position.set(x, y, z);
  group.add(node);
  sockets[name] = node;
}

function add(
  group: THREE.Group,
  geometry: THREE.BufferGeometry,
  material: THREE.Material,
  x: number,
  y: number,
  z: number,
  rotation?: [number, number, number],
): THREE.Mesh {
  const mesh = new THREE.Mesh(geometry, material);
  mesh.position.set(x, y, z);
  if (rotation) mesh.rotation.set(rotation[0], rotation[1], rotation[2]);
  mesh.castShadow = true;
  mesh.receiveShadow = true;
  group.add(mesh);
  return mesh;
}

/** A lofted cross-section: width tapers front-to-back, `yTop` is the belt line. */
const section = (z: number, w: number, yBottom: number, yTop: number): LoftSection => ({
  z,
  wTop: w,
  wBottom: w * 0.93,
  yBottom,
  yTop,
});

/**
 * A raked glass panel spanning between two points in the profile.
 *
 * Glass is the single biggest readability win on a low-poly car: it separates
 * the cabin from the bodywork and shows the windscreen rake, which is most of
 * what makes a car look like a car rather than a box.
 */
function rakePanel(
  group: THREE.Group,
  material: THREE.Material,
  width: number,
  thickness: number,
  fromZ: number,
  fromY: number,
  toZ: number,
  toY: number,
): void {
  const dz = toZ - fromZ;
  const dy = toY - fromY;
  const length = Math.hypot(dz, dy);
  // Local +Z maps to (0, -sin φ, cos φ) under rotation.x = φ.
  const phi = -Math.atan2(dy, dz);
  add(
    group,
    new THREE.BoxGeometry(width, thickness, length),
    material,
    0,
    (fromY + toY) / 2,
    (fromZ + toZ) / 2,
    [phi, 0, 0],
  );
}

// ------------------------------------------------------------------ chassis

export function buildChassis(spec: VehicleSpec, m: VehicleMaterials): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};
  const halfW = spec.halfWidth;
  const halfL = spec.halfLength;

  if (spec.id !== 'suv') {
    // ---- low body (coupe and solo brawler): long bonnet, cabin set back --
    const belt = 0.08;
    const bodySections = [
      section(-halfL, halfW * 0.58, -0.34, 0.0),
      section(-1.85, halfW * 0.82, -0.34, 0.04),
      section(-1.30, halfW * 0.95, -0.34, 0.06),
      section(-0.70, halfW, -0.34, belt),
      section(0.10, halfW, -0.34, belt + 0.02),
      section(0.90, halfW * 0.99, -0.34, belt + 0.03),
      section(1.60, halfW * 0.97, -0.34, belt + 0.03),
      section(2.00, halfW * 0.9, -0.34, belt),
      section(halfL, halfW * 0.62, -0.34, 0.06),
    ];
    const sillSections = bodySections.map((s) => ({ ...s, wTop: s.wTop * 0.98, wBottom: s.wBottom * 0.98, yBottom: -0.6, yTop: -0.34 }));
    add(group, loft(sillSections), m.bodyDark, 0, 0, 0);
    add(group, loft(bodySections), m.body, 0, 0, 0);

    // Raked windscreen and fastback rear glass.
    rakePanel(group, m.glass, halfW * 1.44, 0.05, -0.82, belt, -0.22, 0.6);
    rakePanel(group, m.glass, halfW * 1.4, 0.05, 0.98, 0.6, 1.56, 0.2);
    // Roof skin.
    add(group, new THREE.BoxGeometry(halfW * 1.56, 0.08, 1.24), m.body, 0, 0.6, 0.38);
    // A and C pillars, following the glass rake.
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.09, 0.09, 0.8), m.body, side * halfW * 0.72, 0.34, -0.52, [-0.76, 0, 0]);
      add(group, new THREE.BoxGeometry(0.1, 0.09, 0.74), m.body, side * halfW * 0.68, 0.4, 1.26, [0.59, 0, 0]);
    }
    add(group, new THREE.BoxGeometry(halfW * 1.66, 0.66, 1.7), m.interior, 0, 0.24, 0.35);
    // Door shut line.
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.02, 0.34, 0.03), m.trim, side * halfW * 1.005, -0.15, 0.9);
    }
  } else {
    // ---- four-seat SUV: tall and boxy, two clear rows of windows ---------
    const belt = 0.12;
    const bodySections = [
      section(-halfL, halfW * 0.84, -0.6, 0.0),
      section(-2.2, halfW * 0.97, -0.6, 0.06),
      section(-1.75, halfW, -0.6, 0.1),
      section(-1.05, halfW, -0.6, belt),
      section(-0.2, halfW, -0.6, belt + 0.02),
      section(1.2, halfW, -0.6, belt + 0.03),
      section(2.05, halfW * 0.98, -0.6, belt + 0.02),
      section(2.4, halfW * 0.9, -0.6, 0.1),
      section(halfL, halfW * 0.72, -0.6, 0.08),
    ];
    const sillSections = bodySections.map((s) => ({ ...s, wTop: s.wTop * 0.98, wBottom: s.wBottom * 0.98, yBottom: -0.88, yTop: -0.6 }));
    add(group, loft(sillSections), m.bodyDark, 0, 0, 0);
    add(group, loft(bodySections), m.body, 0, 0, 0);

    // Upright windscreen and near-vertical tailgate glass.
    rakePanel(group, m.glass, halfW * 1.72, 0.06, -1.05, belt, -0.6, 0.84);
    rakePanel(group, m.glass, halfW * 1.7, 0.06, 1.6, 0.84, 2.12, 0.3);
    // Roof skin plus rails.
    add(group, new THREE.BoxGeometry(halfW * 1.72, 0.1, 2.2), m.body, 0, 0.86, 0.5);
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.08, 0.07, 1.9), m.metal, side * halfW * 0.72, 0.95, 0.5);
    }
    // A, B and C pillars leave two side windows open per side.
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.1, 0.76, 0.12), m.body, side * halfW * 0.92, 0.48, -0.84);
      add(group, new THREE.BoxGeometry(0.1, 0.78, 0.12), m.body, side * halfW * 0.95, 0.5, 0.12);
      add(group, new THREE.BoxGeometry(0.1, 0.78, 0.12), m.body, side * halfW * 0.95, 0.5, 1.58);
      // Door shut lines.
      add(group, new THREE.BoxGeometry(0.02, 0.44, 0.03), m.trim, side * halfW * 1.005, -0.2, -0.55);
      add(group, new THREE.BoxGeometry(0.02, 0.44, 0.03), m.trim, side * halfW * 1.005, -0.2, 1.02);
    }
    add(group, new THREE.BoxGeometry(halfW * 1.76, 0.8, 3.0), m.interior, 0, 0.26, 0.45);
  }

  // ---- shared details ---------------------------------------------------
  const noseZ = -halfL * 0.98;
  const bumperY = spec.id === 'suv' ? -0.66 : -0.42;
  add(group, new THREE.BoxGeometry(halfW * 2.0, 0.22, 0.16), m.bodyDark, 0, bumperY, noseZ - 0.02);
  add(group, new THREE.BoxGeometry(0.36, 0.15, 0.1), m.lamp, -halfW * 0.64, bumperY + 0.3, noseZ);
  add(group, new THREE.BoxGeometry(0.36, 0.15, 0.1), m.lamp, halfW * 0.64, bumperY + 0.3, noseZ);
  add(group, new THREE.BoxGeometry(0.3, 0.12, 0.1), m.tailLamp, -halfW * 0.66, bumperY + 0.36, halfL * 0.98);
  add(group, new THREE.BoxGeometry(0.3, 0.12, 0.1), m.tailLamp, halfW * 0.66, bumperY + 0.36, halfL * 0.98);
  const mirrorZ = spec.id === 'suv' ? -1.0 : -0.6;
  const mirrorY = spec.id === 'suv' ? 0.3 : 0.2;
  add(group, new THREE.BoxGeometry(0.22, 0.1, 0.09), m.trim, -halfW * 1.14, mirrorY, mirrorZ);
  add(group, new THREE.BoxGeometry(0.22, 0.1, 0.09), m.trim, halfW * 1.14, mirrorY, mirrorZ);

  socket(group, sockets, 'exhaust.left', -halfW * 0.6, bumperY - 0.02, halfL * 0.96);
  socket(group, sockets, 'exhaust.right', halfW * 0.6, bumperY - 0.02, halfL * 0.96);
  socket(group, sockets, 'decal.left', -halfW, -0.15, 0.2);
  socket(group, sockets, 'decal.right', halfW, -0.15, 0.2);
  socket(group, sockets, 'roofRack', 0, spec.id === 'suv' ? 0.95 : 0.66, 0.2);

  return { group, sockets };
}

// ------------------------------------------------------------------- engine

/** Exposed engine block: a damageable module (power and boost). */
/**
 * A car-mounted gun: a ring, a shielded cradle and a barrel pointing -Z, with a
 * `muzzle` socket at the tip. The procedural stand-in for a turret asset, so a
 * class with mounted weapons always SHOWS its gun.
 */
export function buildTurret(m: VehicleMaterials): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};
  add(group, new THREE.CylinderGeometry(0.42, 0.46, 0.14, 14), m.bodyDark, 0, 0.07, 0);
  add(group, new THREE.BoxGeometry(0.5, 0.32, 0.6), m.metal, 0, 0.3, -0.05);
  add(group, new THREE.BoxGeometry(0.78, 0.42, 0.06), m.bodyDark, 0, 0.36, -0.42);
  add(group, new THREE.CylinderGeometry(0.045, 0.05, 1.0, 8), m.metal, 0.07, 0.34, -0.93, [Math.PI / 2, 0, 0]);
  socket(group, sockets, 'muzzle', 0.07, 0.34, -1.43);
  return { group, sockets };
}

/**
 * One car-mounted machine gun: a pintle post, a receiver and a barrel along -Z,
 * with a `muzzle` socket at the tip (matching `SOLO_MG_MUZZLE`). The procedural
 * stand-in for the M2 asset.
 */
export function buildGun(m: VehicleMaterials): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};
  add(group, new THREE.CylinderGeometry(0.03, 0.04, 0.1, 8), m.metal, 0, 0.05, 0);
  add(group, new THREE.BoxGeometry(0.1, 0.11, 0.38), m.bodyDark, 0, 0.14, 0.05);
  add(group, new THREE.CylinderGeometry(0.018, 0.022, 0.62, 8), m.metal, 0.02, 0.13, -0.45, [Math.PI / 2, 0, 0]);
  socket(group, sockets, 'muzzle', 0.02, 0.13, -0.76);
  return { group, sockets };
}

export function buildEngine(spec: VehicleSpec, m: VehicleMaterials): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};

  add(group, new THREE.BoxGeometry(0.9, 0.32, 0.78), m.metal, 0, 0, 0);
  add(group, new THREE.BoxGeometry(0.98, 0.08, 0.86), m.bodyDark, 0, 0.19, 0);
  add(group, new THREE.CylinderGeometry(0.15, 0.17, 0.2, 8), m.metal, 0, 0.29, -0.1);
  add(group, new THREE.BoxGeometry(0.11, 0.32, 0.11), m.metal, -0.29, 0.29, 0.27);
  add(group, new THREE.BoxGeometry(0.11, 0.32, 0.11), m.metal, 0.29, 0.29, 0.27);
  add(group, new THREE.CylinderGeometry(0.1, 0.1, 0.13, 8), m.hub, 0, 0.02, -0.45, [Math.PI / 2, 0, 0]);

  socket(group, sockets, 'intake', 0, 0.42, -0.1);
  socket(group, sockets, 'exhaustPort.left', -0.29, 0.5, 0.27);
  socket(group, sockets, 'exhaustPort.right', 0.29, 0.5, 0.27);

  return { group, sockets };
}

// -------------------------------------------------------------------- wheel

export function buildWheel(spec: VehicleSpec, m: VehicleMaterials, style?: WheelStyle): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};
  const r = spec.wheelRadius;
  // Zero spokes is a plain steel wheel: the rim disc itself is the face.
  const spokes = style?.spokes ?? 4;

  const tyre = add(group, new THREE.CylinderGeometry(r, r, r * 0.8, 16), m.wheel, 0, 0, 0);
  tyre.rotation.z = Math.PI / 2;
  const rim = add(group, new THREE.CylinderGeometry(r * 0.62, r * 0.62, r * 0.84, 12), m.rim, 0, 0, 0);
  rim.rotation.z = Math.PI / 2;
  const hubCentre = add(group, new THREE.CylinderGeometry(r * 0.2, r * 0.2, r * 0.9, 8), m.metal, 0, 0, 0);
  hubCentre.rotation.z = Math.PI / 2;

  // Spokes, so wheel rotation is legible at speed.
  for (let i = 0; i < spokes; i++) {
    const angle = (i / spokes) * Math.PI;
    const spoke = add(group, new THREE.BoxGeometry(r * 0.86, r * 0.13, r * 0.5), m.rim, 0, 0, 0);
    spoke.rotation.x = angle;
    spoke.rotation.z = Math.PI / 2;
  }

  socket(group, sockets, 'rim', 0, 0, 0);
  return { group, sockets };
}

// --------------------------------------------------------------------- seat

/**
 * One crew position.
 *
 * `side` is which way the occupant faces — i.e. which window they shoot out of.
 * That single value gives the position its field of fire, so it is gameplay data
 * as much as geometry.
 */
export function buildSeat(side: SeatSide, armed: boolean, m: VehicleMaterials): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};

  add(group, new THREE.BoxGeometry(0.5, 0.1, 0.5), m.seat, 0, 0, 0);
  add(group, new THREE.BoxGeometry(0.5, 0.44, 0.13), m.seat, 0, 0.26, 0.22, [0.16, 0, 0]);
  add(group, new THREE.BoxGeometry(0.24, 0.14, 0.13), m.seat, 0, 0.52, 0.24);

  // Where the occupant's head sits — the per-seat camera anchor at M4, and the
  // point the server hit-tests against when shooting them out of the seat.
  socket(group, sockets, 'eye', EYE_OFFSET[0], EYE_OFFSET[1], EYE_OFFSET[2]);
  // The window aperture they fire through. Only armed seats get one, which is
  // how "the driver is unarmed" (DESIGN.md §3.1) is expressed in geometry.
  if (armed) {
    const port = FIRE_PORT_OFFSET[side];
    socket(group, sockets, 'firePort', port[0], port[1], port[2]);

    // The occupant, at their window.
    //
    // Not decoration: the server hit-tests a gunner's head at exactly this point
    // (`headWorld`), because a head modelled inside the cabin can never be hit.
    // Without a mesh here players would be shot out of a car by nothing, and
    // "you can see which windows are occupied" (§3.2) would be false.
    //
    // Kept SMALL and tight to the glass. An earlier version drew it at the
    // camera offset, which put two boxes floating half a metre off each flank.
    const head = HEAD_OFFSET[side];
    const headMesh = add(group, new THREE.BoxGeometry(0.3, 0.3, 0.28), m.metal, head[0], head[1], head[2]);
    const torsoMesh = add(
      group,
      new THREE.BoxGeometry(0.42, 0.34, 0.3),
      m.seat,
      head[0] * 0.86,
      head[1] - 0.3,
      head[2],
    );
    // Named so the rig can show them only while someone is actually sitting
    // there — an empty seat must not look occupied, or "you can see which
    // windows are occupied" (§3.2) stops being true.
    headMesh.name = 'occupant';
    torsoMesh.name = 'occupant';
    // Hidden until told otherwise: an empty car should look empty.
    headMesh.visible = false;
    torsoMesh.visible = false;
    socket(group, sockets, 'windowHead', head[0], head[1], head[2]);
  }

  return { group, sockets };
}

// ------------------------------------------------------------------- roof kit

/**
 * A cosmetic roof attachment (M12), mounted at the chassis's `roofRack` socket.
 * Purely visual — no collision, no physics, nothing the simulation can feel.
 *
 * `none` returns an empty group so the caller never needs a branch; the rig just
 * attaches whatever comes back.
 */
export function buildRoofKit(
  spec: VehicleSpec,
  kind: RoofKind,
  m: VehicleMaterials,
): PartBuild {
  const group = new THREE.Group();
  const sockets: Record<string, THREE.Object3D> = {};
  if (kind === 'none') return { group, sockets };

  const halfW = spec.halfWidth;
  const length = spec.id === 'suv' ? 2.2 : 1.4;

  if (kind === 'rack') {
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.07, 0.07, length), m.metal, side * halfW * 0.7, 0.06, 0);
    }
    for (const z of [-length / 2 + 0.2, length / 2 - 0.2]) {
      add(group, new THREE.BoxGeometry(halfW * 1.44, 0.05, 0.07), m.metal, 0, 0.06, z);
    }
  } else if (kind === 'wing') {
    // A roof-mounted spoiler: two short struts and a blade, swept back.
    for (const side of [-1, 1]) {
      add(group, new THREE.BoxGeometry(0.08, 0.22, 0.16), m.bodyDark, side * halfW * 0.6, 0.11, 0.35);
    }
    add(group, new THREE.BoxGeometry(halfW * 1.7, 0.06, 0.4), m.bodyDark, 0, 0.24, 0.45, [0.16, 0, 0]);
  } else if (kind === 'scoop') {
    add(group, new THREE.BoxGeometry(0.52, 0.16, 0.7), m.body, 0, 0.08, -0.15);
    add(group, new THREE.BoxGeometry(0.4, 0.1, 0.16), m.trim, 0, 0.13, -0.48);
  } else if (kind === 'lights') {
    add(group, new THREE.BoxGeometry(halfW * 1.5, 0.1, 0.2), m.bodyDark, 0, 0.07, -0.15);
    for (let i = 0; i < 4; i++) {
      const x = (i - 1.5) * (halfW * 1.5 / 4);
      add(group, new THREE.BoxGeometry(0.18, 0.09, 0.1), m.lamp, x, 0.13, -0.15);
    }
  }

  return { group, sockets };
}
