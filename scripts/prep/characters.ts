/**
 * Prep the CREW figures — the people in the cars — from their downloads.
 *
 *   npx tsx scripts/prep/characters.ts     # then: npm run assetbuild
 *
 * Inputs (unmodified downloads, kept as the preferred form for modification),
 * all by 1799danly, CC BY 4.0, all on the same Mixamo skeleton:
 *   assets-src/characters/tactical/original/tactical.glb   masked, plate carrier
 *   assets-src/characters/striker/original/striker.glb     racing jumpsuit, helmet
 *   assets-src/characters/soldier/original/soldier.glb     military kit, cap
 *
 * Outputs: assets-src/characters/<id>/figure.glb — one skinned figure, in game
 * convention (metres, +Y up, facing -Z), feet on y = 0 and centred under the
 * hips; 1.72 m from toe to crown. No animation: the game poses the skeleton
 * itself (sitting, at the wheel, leaning out of a window to aim). The joints are
 * renamed to plain Mixamo names ("Hips", "LeftForeArm"…) so one posing routine
 * drives every outfit. Simplified for a dozen figures on screen at once.
 *
 * The hierarchy is NOT flattened: a skinned mesh follows its joints, so the
 * turn and scale go on one node above everything.
 */

import { join } from 'node:path';
import type { Document } from '@gltf-transform/core';
import { prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { io, ROOT } from './lib';

const OUTFITS = ['tactical', 'striker', 'soldier'] as const;
/** Toe to crown, metres (the toe joint sits at the ball of the foot). */
const HEIGHT = 1.72;
/** Triangles kept per figure. */
const TRIANGLES = Number(process.env.FIGURE_TRIS ?? 7000);

/** "mixamorig:LeftForeArm_022" → "LeftForeArm". */
const tidy = (name: string): string => name.replace(/^mixamorig:/, '').replace(/_\d+$/, '');

function triangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) n += (prim.getIndices()?.getCount() ?? 0) / 3;
  }
  return n;
}

/**
 * The Tactical download's gloves and head are broken: their vertices sit in
 * another space from the rest of the body (the gloves stretch into long
 * sheets, the head floats). Its base body is the Striker's — the same meshes,
 * textured differently — whose geometry is carried over (keeping the
 * Tactical's own materials).
 * Each vertex moves with the bone that mainly drives it — into that bone's
 * frame in the Striker, out of the same-named bone in the Tactical — which is
 * exact for a rigid hand whatever else differs between the two bodies.
 */
async function replaceTacticalParts(doc: Document): Promise<void> {
  const donor = await io.read(join(ROOT, 'assets-src', 'characters', 'striker', 'original', 'striker.glb'));
  // Tactical part ← the same mesh in the Striker (its visor glass is "Material.001").
  // Old and new positions of every base-body vertex, with its main joint.
  const pairs: Array<{ joint: number; from: number[]; to: number[] }> = [];
  for (const [here, there] of [
    ['gloves', 'gloves'],
    ['Head', 'Head'],
    ['material', 'material'],
    ['Material.001', 'Glass'],
    ['jumpsuit', 'Jumpsuit'],
    ['boots', 'Boots'],
  ] as const) {
    const before = carryMesh(doc, donor, here, there);
    const prim = nodeByMaterial(doc, here).getMesh()!.listPrimitives()[0];
    const after = prim.getAttribute('POSITION')!.getArray()!;
    const W = prim.getAttribute('WEIGHTS_0')!;
    const J = prim.getAttribute('JOINTS_0')!;
    const w = [0, 0, 0, 0];
    const j = [0, 0, 0, 0];
    for (let i = 0; i < W.getCount(); i++) {
      W.getElement(i, w);
      J.getElement(i, j);
      const k = w.indexOf(Math.max(...w));
      pairs.push({
        joint: j[k],
        from: [before[i * 3], before[i * 3 + 1], before[i * 3 + 2]],
        to: [after[i * 3], after[i * 3 + 1], after[i * 3 + 2]],
      });
    }
  }
  // The Tactical's own kit sat on the OLD body: move it as the body moved,
  // by a least-squares affine fit per joint (its parent's when too few points).
  const skinJoints = nodeByMaterial(doc, 'gloves').getSkin()!.listJoints();
  const fits = new Map<number, THREE.Matrix4 | null>();
  const fitFor = (joint: number): THREE.Matrix4 | null => {
    if (fits.has(joint)) return fits.get(joint)!;
    const pts = pairs.filter((p) => p.joint === joint);
    let fit: THREE.Matrix4 | null = null;
    if (pts.length >= 12) {
      // Solve [x y z 1]·A = [x' y' z'] (normal equations, 4×4).
      const ata = new THREE.Matrix4().set(0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0);
      const e = ata.elements;
      const atb = [0, 1, 2].map(() => [0, 0, 0, 0]);
      for (const p of pts) {
        const r = [...p.from, 1];
        for (let x = 0; x < 4; x++) {
          for (let y = 0; y < 4; y++) e[y * 4 + x] += r[x] * r[y];
          for (let c = 0; c < 3; c++) atb[c][x] += r[x] * p.to[c];
        }
      }
      const inv = ata.clone().invert();
      const col = (c: number) => new THREE.Vector4().fromArray(atb[c]).applyMatrix4(inv);
      const [cx, cy, cz] = [col(0), col(1), col(2)];
      fit = new THREE.Matrix4().set(cx.x, cx.y, cx.z, cx.w, cy.x, cy.y, cy.z, cy.w, cz.x, cz.y, cz.z, cz.w, 0, 0, 0, 1);
    } else {
      const parent = skinJoints[joint].getParentNode();
      const index = parent ? skinJoints.indexOf(parent) : -1;
      fit = index >= 0 ? fitFor(index) : null;
    }
    fits.set(joint, fit);
    return fit;
  };
  for (const material of ['ShoulderPads', 'Headphones', 'plate']) {
    for (const node of doc.getRoot().listNodes()) {
      const prim = node.getMesh()?.listPrimitives()[0];
      if (!prim || prim.getMaterial()?.getName() !== material) continue;
      const P = prim.getAttribute('POSITION')!;
      const W = prim.getAttribute('WEIGHTS_0')!;
      const J = prim.getAttribute('JOINTS_0')!;
      const out = new Float32Array(P.getCount() * 3);
      const v = new THREE.Vector3();
      const w = [0, 0, 0, 0];
      const j = [0, 0, 0, 0];
      const e = [0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        W.getElement(i, w);
        J.getElement(i, j);
        P.getElement(i, e);
        const fit = fitFor(j[w.indexOf(Math.max(...w))]);
        (fit ? v.fromArray(e).applyMatrix4(fit) : v.fromArray(e)).toArray(out, i * 3);
      }
      P.setArray(out);
    }
  }
  console.log('tactical: base body carried over from the striker, its kit refitted');
}

const nodeByMaterial = (d: Document, material: string) =>
  d
    .getRoot()
    .listNodes()
    .find((x) => x.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName() === material)!;

/** Replace one mesh's geometry with the donor's same mesh; returns the old positions. */
function carryMesh(doc: Document, donor: Document, hereMaterial: string, thereMaterial: string): ArrayLike<number> {
  const hereNode = nodeByMaterial(doc, hereMaterial);
  const thereNode = nodeByMaterial(donor, thereMaterial);
  const gloves = hereNode.getMesh()!.listPrimitives()[0];
  const source = thereNode.getMesh()!.listPrimitives()[0];
  const old = Float32Array.from(gloves.getAttribute('POSITION')!.getArray()! as ArrayLike<number>);
  const name = (j: { getName(): string }): string =>
    j
      .getName()
      .replace(/^mixamorig:/, '')
      .replace(/_\d+$/, '');
  const hereJoints = hereNode.getSkin()!.listJoints().map(name);
  const thereJoints = thereNode.getSkin()!.listJoints().map(name);
  const ibm = (node: typeof hereNode, i: number): THREE.Matrix4 => {
    const m = new Array<number>(16).fill(0);
    node.getSkin()!.getInverseBindMatrices()!.getElement(i, m);
    return new THREE.Matrix4().fromArray(m);
  };
  // (Only the hand and finger joints are used; tips differ between the two.)
  const map = thereJoints.map((j) => hereJoints.indexOf(j));
  const carry = new Map<number, THREE.Matrix4>();
  /** Donor bind space → its bone j → the same bone here → this bind space. */
  const carryOf = (j: number): THREE.Matrix4 => {
    if (map[j] < 0) throw new Error(`tactical: no ${thereJoints[j]} joint for the ${hereMaterial}`);
    let m = carry.get(j);
    if (!m) carry.set(j, (m = ibm(hereNode, map[j]).invert().multiply(ibm(thereNode, j))));
    return m;
  };

  const P = source.getAttribute('POSITION')!;
  const N = source.getAttribute('NORMAL');
  const W = source.getAttribute('WEIGHTS_0')!;
  const J = source.getAttribute('JOINTS_0')!;
  const positions = new Float32Array(P.getCount() * 3);
  const normals = N ? new Float32Array(P.getCount() * 3) : null;
  const joints = new Uint16Array(P.getCount() * 4);
  const v = new THREE.Vector3();
  const w = [0, 0, 0, 0];
  const jj = [0, 0, 0, 0];
  const e = [0, 0, 0];
  for (let i = 0; i < P.getCount(); i++) {
    W.getElement(i, w);
    J.getElement(i, jj);
    let k = 0;
    for (let c = 1; c < 4; c++) if (w[c] > w[k]) k = c;
    const m = carryOf(jj[k]);
    P.getElement(i, e);
    v.fromArray(e)
      .applyMatrix4(m)
      .toArray(positions, i * 3);
    if (N && normals) {
      N.getElement(i, e);
      v.fromArray(e)
        .transformDirection(m)
        .toArray(normals, i * 3);
    }
    for (let c = 0; c < 4; c++) joints[i * 4 + c] = w[c] > 0 ? (carryOf(jj[c]), map[jj[c]]) : 0;
  }
  const set = (attr: string, array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>, type: 'VEC3' | 'VEC4') => {
    const existing = gloves.getAttribute(attr);
    if (existing) existing.setArray(array).setType(type);
    else gloves.setAttribute(attr, doc.createAccessor().setArray(array).setType(type).setBuffer(doc.getRoot().listBuffers()[0]));
  };
  set('POSITION', positions, 'VEC3');
  if (normals) set('NORMAL', normals, 'VEC3');
  set('JOINTS_0', joints, 'VEC4');
  gloves.getAttribute('WEIGHTS_0')!.setArray(Float32Array.from(W.getArray()! as ArrayLike<number>));
  const uv = source.getAttribute('TEXCOORD_0');
  if (uv) gloves.getAttribute('TEXCOORD_0')?.setArray(Float32Array.from(uv.getArray()!));
  gloves.getIndices()!.setArray(source.getIndices()!.getArray()!.slice());
  return old;
}

/**
 * Rebind every skinned mesh to the pose the download was SAVED in. In these
 * downloads the skeleton's pose and its inverse-bind matrices disagree: the
 * vertices only look right in that one pose, sitting up to 0.4 m away from
 * the bones that drive them, so turning a hand against its forearm tore the
 * glove apart. Baking each vertex where it appears now and binding to the
 * bones as they stand makes the figure look the same and deform correctly.
 */
function rebindToPose(doc: Document): void {
  const world = (node: { getWorldMatrix(): number[] | Float32Array }) => new THREE.Matrix4().fromArray(node.getWorldMatrix() as number[]);
  const buffer = doc.getRoot().listBuffers()[0];
  // Every mesh first (they share skins: the old binding must stay until all
  // are baked), then each skin rebound once.
  const nodes = doc
    .getRoot()
    .listNodes()
    .filter((n) => n.getSkin() && n.getMesh());
  const skins = new Set(nodes.map((n) => n.getSkin()!));
  const skinning = new Map(
    [...skins].map((skin) => {
      const ibms = skin.getInverseBindMatrices()!;
      // As glTF (and three.js) skin: Σ joint · inverse bind (the mesh node's
      // own transform does not apply to a skinned mesh).
      return [
        skin,
        skin.listJoints().map((joint, i) => {
          const m = new Array<number>(16).fill(0);
          ibms.getElement(i, m);
          return world(joint).multiply(new THREE.Matrix4().fromArray(m));
        }),
      ] as const;
    }),
  );
  for (const node of nodes) {
    const matrices = skinning.get(node.getSkin()!)!;
    for (const prim of node.getMesh()!.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!;
      const N = prim.getAttribute('NORMAL');
      const W = prim.getAttribute('WEIGHTS_0')!;
      const J = prim.getAttribute('JOINTS_0')!;
      const positions = new Float32Array(P.getCount() * 3);
      const normals = N ? new Float32Array(P.getCount() * 3) : null;
      const blend = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const w = [0, 0, 0, 0];
      const j = [0, 0, 0, 0];
      const e = [0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        W.getElement(i, w);
        J.getElement(i, j);
        const total = w[0] + w[1] + w[2] + w[3] || 1;
        blend.elements.fill(0);
        for (let k = 0; k < 4; k++) {
          if (!w[k]) continue;
          const src = matrices[j[k]].elements;
          for (let x = 0; x < 16; x++) blend.elements[x] += (src[x] * w[k]) / total;
        }
        P.getElement(i, e);
        v.fromArray(e)
          .applyMatrix4(blend)
          .toArray(positions, i * 3);
        if (N && normals) {
          N.getElement(i, e);
          v.fromArray(e)
            .transformDirection(blend)
            .toArray(normals, i * 3);
        }
      }
      prim.setAttribute('POSITION', doc.createAccessor().setType('VEC3').setArray(positions).setBuffer(buffer));
      if (normals) prim.setAttribute('NORMAL', doc.createAccessor().setType('VEC3').setArray(normals).setBuffer(buffer));
    }
    // The mesh node at the scene root, untransformed: the joints alone place it.
    node.getParentNode()?.removeChild(node);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    for (const sc of doc.getRoot().listScenes()) sc.removeChild(node);
    (doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0]).addChild(node);
  }
  // The downloads' skeletons do not fit their meshes (the Striker's arms are
  // far shorter than its sleeves). Fit each joint to its skin: vertices
  // shared between a joint and its parent (weights split) ring that joint, so
  // their centre is where it belongs. A joint with no such ring keeps its
  // offset from its parent, grown as the whole figure is. Orientations stay.
  const allJoints = [...new Set([...skins].flatMap((skin) => skin.listJoints()))];
  const before = new Map(allJoints.map((j) => [j, world(j)]));
  const rings = new Map(allJoints.map((j) => [j, { sum: new THREE.Vector3(), n: 0 }]));
  let top = -Infinity;
  let floor = Infinity;
  for (const node of nodes) {
    const joints = node.getSkin()!.listJoints();
    for (const prim of node.getMesh()!.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!;
      const W = prim.getAttribute('WEIGHTS_0')!;
      const J = prim.getAttribute('JOINTS_0')!;
      const e = [0, 0, 0];
      const w = [0, 0, 0, 0];
      const j = [0, 0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, e);
        top = Math.max(top, e[1]);
        floor = Math.min(floor, e[1]);
        W.getElement(i, w);
        J.getElement(i, j);
        for (let x = 0; x < 4; x++) {
          if (w[x] < 0.25) continue;
          const child = joints[j[x]];
          const parent = child.getParentNode();
          for (let y = 0; y < 4; y++) {
            if (y === x || w[y] < 0.25 || joints[j[y]] !== parent) continue;
            const ring = rings.get(child)!;
            ring.sum.add(new THREE.Vector3().fromArray(e));
            ring.n++;
          }
        }
      }
    }
  }
  const find = (name: string) => allJoints.find((j) => tidy(j.getName()) === name)!;
  const k = (top - floor) / (before.get(find('HeadTop_End'))!.elements[13] - floor);
  const depth = (n: (typeof allJoints)[number]): number => (n.getParentNode() ? depth(n.getParentNode()!) + 1 : 0);
  const moved = new Map<(typeof allJoints)[number], THREE.Matrix4>();
  let fitted = 0;
  for (const joint of [...allJoints].sort((a, b) => depth(a) - depth(b))) {
    const position = new THREE.Vector3();
    const rotation = new THREE.Quaternion();
    const scale = new THREE.Vector3();
    before.get(joint)!.decompose(position, rotation, scale);
    const parent = joint.getParentNode();
    const ring = rings.get(joint)!;
    if (ring.n >= 6) {
      position.copy(ring.sum).divideScalar(ring.n);
      fitted++;
    } else if (parent && moved.has(parent)) {
      const was = new THREE.Vector3().setFromMatrixPosition(before.get(parent)!);
      const now = new THREE.Vector3().setFromMatrixPosition(moved.get(parent)!);
      position.sub(was).multiplyScalar(k).add(now);
    }
    const newWorld = new THREE.Matrix4().compose(position, rotation, scale);
    moved.set(joint, newWorld);
    const parentWorld = parent ? (moved.get(parent) ?? world(parent)) : new THREE.Matrix4();
    const local = parentWorld.clone().invert().multiply(newWorld);
    const t = new THREE.Vector3();
    const r = new THREE.Quaternion();
    const sc = new THREE.Vector3();
    local.decompose(t, r, sc);
    joint.setTranslation(t.toArray() as [number, number, number]);
    joint.setRotation(r.toArray() as [number, number, number, number]);
    joint.setScale(sc.toArray() as [number, number, number]);
  }
  console.log(`  skeleton fitted to its mesh: ${fitted}/${allJoints.length} joints from their skin`);
  for (const skin of skins) {
    const joints = skin.listJoints();
    const fresh = new Float32Array(joints.length * 16);
    joints.forEach((joint, i) =>
      world(joint)
        .invert()
        .toArray(fresh, i * 16),
    );
    skin.setInverseBindMatrices(doc.createAccessor().setType('MAT4').setArray(fresh).setBuffer(buffer));
  }
}

/**
 * Make each hand rigid: finger weights move to the hand. The game never bends
 * a finger, and the downloads' finger joints sit where no skin rings them, so
 * any turn of a hand pulled the glove's fingers into spikes.
 */
function rigidHands(doc: Document): void {
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    if (!skin || !node.getMesh()) continue;
    const names = skin.listJoints().map((j) => j.getName());
    const target = names.map((name, i) => {
      const finger = /^(Left|Right)Hand(Thumb|Index|Middle|Ring|Pinky)/.exec(name);
      return finger ? names.indexOf(`${finger[1]}Hand`) : i;
    });
    for (const prim of node.getMesh()!.listPrimitives()) {
      const J = prim.getAttribute('JOINTS_0')!;
      const W = prim.getAttribute('WEIGHTS_0')!;
      const j = [0, 0, 0, 0];
      const w = [0, 0, 0, 0];
      for (let i = 0; i < J.getCount(); i++) {
        J.getElement(i, j);
        W.getElement(i, w);
        // Fold duplicates together (a finger and its hand, now the same joint).
        const merged = new Map<number, number>();
        for (let k = 0; k < 4; k++) if (w[k] > 0) merged.set(target[j[k]], (merged.get(target[j[k]]) ?? 0) + w[k]);
        const entries = [...merged].sort((a, b) => b[1] - a[1]);
        for (let k = 0; k < 4; k++) {
          j[k] = entries[k]?.[0] ?? 0;
          w[k] = entries[k]?.[1] ?? 0;
        }
        J.setElement(i, j);
        W.setElement(i, w);
      }
    }
  }
}

async function prepare(id: string): Promise<void> {
  const dir = join(ROOT, 'assets-src', 'characters', id);
  const doc = await io.read(join(dir, 'original', `${id}.glb`));
  const root = doc.getRoot();

  for (const animation of root.listAnimations()) animation.dispose();
  for (const joint of root.listSkins()[0].listJoints()) joint.setName(tidy(joint.getName()));
  if (id === 'tactical') await replaceTacticalParts(doc);
  rebindToPose(doc);
  rigidHands(doc);
  // Stray unskinned meshes (the soldier carries an empty placeholder), and the
  // soldier's headset, which floats above its cap in the download itself.
  for (const node of root.listNodes()) {
    const material = node.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName();
    if ((node.getMesh() && !node.getSkin()) || material === 'HeadphonesT') node.dispose();
  }

  const skin = root.listSkins()[0];
  const joints = skin.listJoints();
  for (const joint of joints) joint.setName(tidy(joint.getName()));
  const at = (name: string): number[] => {
    const joint = joints.find((j) => j.getName() === name);
    if (!joint) throw new Error(`${id}: no ${name} joint`);
    return joint.getWorldTranslation();
  };

  // Measured in the bind pose (a T-pose): standing.
  // Measured in the download's own pose (a frame of its idle), axes and units:
  // up runs from the toes to the crown, and the hands lie right → left.
  const v = (name: string): THREE.Vector3 => new THREE.Vector3().fromArray(at(name));
  const toe = v('LeftToeBase').add(v('RightToeBase')).multiplyScalar(0.5);
  const crown = v('HeadTop_End');
  const up = crown.clone().sub(toe);
  const scale = HEIGHT / up.length();
  up.normalize();
  const left = v('LeftHand').sub(v('RightHand'));
  left.addScaledVector(up, -left.dot(up)).normalize();
  // The game's figure: up +Y, its right +X (so it faces -Z). R maps the
  // download's (right, up, back) onto (X, Y, Z).
  const right = left.clone().negate();
  const back = new THREE.Vector3().crossVectors(right, up);
  const R = new THREE.Matrix4().makeBasis(right, up, back).transpose();
  const turn = new THREE.Quaternion().setFromRotationMatrix(R);
  // p' = R·(s·p) + t, with the hips over the origin and the toes at y = 0.
  const hips = v('Hips').applyMatrix4(R).multiplyScalar(scale);
  const toeY = toe.clone().applyMatrix4(R).multiplyScalar(scale).y;
  const t: [number, number, number] = [-hips.x, -toeY + 0.03, -hips.z];

  const scene = root.getDefaultScene() ?? root.listScenes()[0];
  const wrap = doc
    .createNode('figure')
    .setTranslation(t)
    .setRotation(turn.toArray() as [number, number, number, number])
    .setScale([scale, scale, scale]);
  // (Not the skinned meshes: they stay untransformed at the root, see rebindToPose.)
  for (const child of scene.listChildren()) {
    if (child.getSkin()) continue;
    scene.removeChild(child);
    wrap.addChild(child);
  }
  scene.addChild(wrap);

  const before = triangles(doc);
  const ratio = Math.min(1, TRIANGLES / before);
  await doc.transform(prune({ keepLeaves: true }), weld(), simplify({ simplifier: MeshoptSimplifier, ratio, error: 0.02 }));
  await doc.transform(prune({ keepLeaves: true }));
  await io.write(join(dir, 'figure.glb'), doc);
  console.log(`${id}: ${before} → ${triangles(doc)} tris, scale ${scale.toFixed(4)}`);
}

await MeshoptSimplifier.ready;
for (const id of OUTFITS) if (!process.env.ONLY || process.env.ONLY === id) await prepare(id);
