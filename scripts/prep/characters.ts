/**
 * Prep the CREW figures — the people in the cars — from their downloads.
 *
 *   npx tsx scripts/prep/characters.ts     # then: npm run assetbuild
 *
 * Inputs (unmodified downloads, kept as the preferred form for modification),
 * CC BY 4.0, all on Mixamo skeletons:
 *   assets-src/characters/swat/original/swat.glb           "Swat", doctortex
 *   assets-src/characters/mechanic/original/mechanic.glb   "US Navy Mechanic", doctortex
 *   assets-src/characters/soldier/original/soldier.glb     "Army soldier Character", joneborden123
 *
 * Chosen for their rigs: every joint sits where its skin bends (within ~1% of
 * height; `rebindToPose` measures it), so they bend cleanly when posed.
 *
 * Outputs: assets-src/characters/<id>/figure.glb — one skinned figure, in game
 * convention (metres, +Y up, facing -Z), feet on y = 0 and centred under the
 * hips; 1.80 m from toe to crown. No animation: the game poses the skeleton
 * itself (sitting, at the wheel, leaning out of a window to aim). The joints are
 * renamed to plain Mixamo names ("Hips", "LeftForeArm"…) so one posing routine
 * drives every outfit. Simplified for a dozen figures on screen at once.
 *
 * The hierarchy is NOT flattened: a skinned mesh follows its joints, so the
 * turn and scale go on one node above everything.
 */

import { join } from 'node:path';
import type { Document } from '@gltf-transform/core';
import { metalRough, prune, simplify, weld } from '@gltf-transform/functions';
import { MeshoptSimplifier } from 'meshoptimizer';
import * as THREE from 'three';
import { io, ROOT } from './lib';

const OUTFITS = ['swat', 'mechanic', 'soldier'] as const;
/** Toe to crown, metres (the toe joint sits at the ball of the foot). */
const HEIGHT = 1.8;
/** Triangles kept per figure. */
const TRIANGLES = Number(process.env.FIGURE_TRIS ?? 7000);

/** "mixamorig:LeftForeArm_022" (or any "namespace:") → "LeftForeArm". */
const tidy = (name: string): string => name.replace(/^.*:/, '').replace(/_\d+$/, '');

function triangles(doc: Document): number {
  let n = 0;
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) n += (prim.getIndices()?.getCount() ?? 0) / 3;
  }
  return n;
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
  // How far the joints sit from their skin, as a share of height. A sound rig
  // (well under 3%) is left exactly as it is.
  const misses = [...rings]
    .filter(([, ring]) => ring.n >= 6)
    .map(
      ([joint, ring]) =>
        ring.sum
          .clone()
          .divideScalar(ring.n)
          .distanceTo(new THREE.Vector3().setFromMatrixPosition(before.get(joint)!)) /
        (top - floor),
    )
    .sort((a, b) => a - b);
  const median = misses[misses.length >> 1] ?? 0;
  const fit = median > 0.03;
  console.log(`  rig: joints sit ${(median * 100).toFixed(1)}% of height from their skin (median)${fit ? ' — fitting the skeleton' : ''}`);
  const depth = (n: (typeof allJoints)[number]): number => (n.getParentNode() ? depth(n.getParentNode()!) + 1 : 0);
  const moved = new Map<(typeof allJoints)[number], THREE.Matrix4>();
  let fitted = 0;
  for (const joint of fit ? [...allJoints].sort((a, b) => depth(a) - depth(b)) : []) {
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
  if (fit) console.log(`  skeleton fitted to its mesh: ${fitted}/${allJoints.length} joints from their skin`);
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
  rebindToPose(doc);
  rigidHands(doc);
  // Stray unskinned meshes (placeholders).
  for (const node of root.listNodes()) if (node.getMesh() && !node.getSkin()) node.dispose();
  // Materials: the standard metal/rough model (one download uses the retired
  // specular-glossiness one), and opaque — the downloads mark whole bodies as
  // blended, which sorts badly; only glass and eyes keep their transparency.
  await doc.transform(metalRough());
  for (const material of root.listMaterials()) {
    if (!/glass|eye|lens|visor/i.test(material.getName())) material.setAlphaMode('OPAQUE').setDoubleSided(false);
  }

  const skin = root.listSkins()[0];
  const joints = skin.listJoints();
  for (const joint of joints) joint.setName(tidy(joint.getName()));
  const at = (name: string): number[] => {
    const joint = joints.find((j) => j.getName() === name);
    if (!joint) throw new Error(`${id}: no ${name} joint`);
    return joint.getWorldTranslation();
  };

  // Measured in the download's own pose (a T-pose), axes and units: up runs
  // from the toes to the crown, and the hands lie right → left.
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
