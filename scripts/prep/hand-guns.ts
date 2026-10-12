/**
 * Prep the window gunners' hand-held guns from their downloads.
 *
 *   npx tsx scripts/prep/hand-guns.ts     # then: npm run assetbuild
 *
 * Inputs (unmodified downloads, kept as the preferred form for modification):
 *   assets-src/weapons/hand-rifle/original/rifle.glb         "Low-Poly M4a1", TastyTony, CC BY 4.0
 *   assets-src/weapons/hand-marksman/original/marksman.glb   "Low-Poly SR-25", TastyTony, CC BY 4.0
 *   assets-src/weapons/hand-shotgun/original/shotgun.glb     "Remington 870 Shotgun", milinam2002, CC BY 4.0
 *   assets-src/weapons/hand-launcher/original/launcher.glb   "low-poly Milkor MGL", DU1701, CC BY 4.0
 *
 * Outputs: assets-src/weapons/hand-<id>/gun.glb — the gun alone, in game
 * convention: metres at its real length, the barrel pointing -Z, its top +Y,
 * and the origin at the butt (the shoulder), level with the top of the stock.
 *
 * The downloads come in different units and axes, so each is MEASURED: the
 * longest side runs butt to muzzle; the muzzle is the slimmer end; of the other
 * two sides the taller is up/down, and the barrel runs along the top (the grip
 * and magazine hang below it).
 */

import { join } from 'node:path';
import type { Document, Node } from '@gltf-transform/core';
import { getBounds, prune } from '@gltf-transform/functions';
import * as THREE from 'three';
import { bake, io, ROOT } from './lib';

const GUNS: Array<{ id: string; file: string; length: number; drop?: (node: Node) => boolean }> = [
  { id: 'rifle', file: 'rifle', length: 0.84 },
  { id: 'marksman', file: 'marksman', length: 1.03 },
  { id: 'shotgun', file: 'shotgun', length: 1.0 },
  // The download lays four spare grenades beside the launcher.
  {
    id: 'launcher',
    file: 'launcher',
    length: 0.78,
    drop: (n) =>
      /material(_1|_2)?$/.test(n.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName() ?? '') && !n.getName().includes('Object_8'),
  },
];

/**
 * Bake rigged downloads (the M4 and SR-25 are rigged for animation) into plain
 * meshes: each vertex where its bones hold it, the rig dropped. A hand-held gun
 * is posed by the hands that hold it, never by bones of its own.
 */
function unskin(doc: Document): void {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const buffer = doc.getRoot().listBuffers()[0];
  for (const node of doc.getRoot().listNodes()) {
    const skin = node.getSkin();
    const mesh = node.getMesh();
    if (!skin || !mesh) continue;
    const ibms = skin.getInverseBindMatrices()!;
    const matrices = skin.listJoints().map((joint, i) => {
      const m = new Array<number>(16).fill(0);
      ibms.getElement(i, m);
      return new THREE.Matrix4().fromArray(joint.getWorldMatrix() as number[]).multiply(new THREE.Matrix4().fromArray(m));
    });
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!;
      const N = prim.getAttribute('NORMAL');
      const W = prim.getAttribute('WEIGHTS_0')!;
      const J = prim.getAttribute('JOINTS_0')!;
      const positions = new Float32Array(P.getCount() * 3);
      const normals = N ? new Float32Array(P.getCount() * 3) : null;
      const blend = new THREE.Matrix4();
      const v = new THREE.Vector3();
      const e = [0, 0, 0];
      const w = [0, 0, 0, 0];
      const j = [0, 0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        W.getElement(i, w);
        J.getElement(i, j);
        const total = w[0] + w[1] + w[2] + w[3] || 1;
        blend.elements.fill(0);
        for (let k = 0; k < 4; k++) {
          if (!w[k]) continue;
          for (let x = 0; x < 16; x++) blend.elements[x] += (matrices[j[k]].elements[x] * w[k]) / total;
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
      prim.setAttribute('JOINTS_0', null).setAttribute('WEIGHTS_0', null);
    }
    node.setSkin(null);
    node.getParentNode()?.removeChild(node);
    for (const sc of doc.getRoot().listScenes()) sc.removeChild(node);
    node.setTranslation([0, 0, 0]).setRotation([0, 0, 0, 1]).setScale([1, 1, 1]);
    scene.addChild(node);
  }
  for (const skin of doc.getRoot().listSkins()) skin.dispose();
}

/** Every vertex of the scene in world space. */
function points(doc: Document): THREE.Vector3[] {
  const out: THREE.Vector3[] = [];
  for (const node of doc.getRoot().listNodes()) {
    const mesh = node.getMesh();
    if (!mesh) continue;
    const m = new THREE.Matrix4().fromArray(node.getWorldMatrix() as number[]);
    for (const prim of mesh.listPrimitives()) {
      const P = prim.getAttribute('POSITION')!;
      const e = [0, 0, 0];
      for (let i = 0; i < P.getCount(); i++) {
        P.getElement(i, e);
        out.push(new THREE.Vector3().fromArray(e).applyMatrix4(m));
      }
    }
  }
  return out;
}

async function prepare(gun: (typeof GUNS)[number]): Promise<void> {
  const dir = join(ROOT, 'assets-src', 'weapons', `hand-${gun.id}`);
  const doc = await io.read(join(dir, 'original', `${gun.file}.glb`));
  for (const animation of doc.getRoot().listAnimations()) animation.dispose();
  unskin(doc);
  if (gun.drop) for (const node of doc.getRoot().listNodes()) if (node.getMesh() && gun.drop(node)) node.dispose();
  await doc.transform(prune());

  const pts = points(doc);
  const b = getBounds(doc.getRoot().listScenes()[0]);
  const size = [0, 1, 2].map((k) => b.max[k] - b.min[k]);
  const axes = [0, 1, 2].sort((p, q) => size[q] - size[p]);
  const [long, tall] = axes;
  const unit = (k: number, sign: number): THREE.Vector3 => new THREE.Vector3().setComponent(k, sign);

  // The two ends: each end's tenth of the length, measured across.
  const span = size[long];
  const slice = (end: 'min' | 'max') =>
    pts.filter((p) => (end === 'min' ? p.getComponent(long) - b.min[long] : b.max[long] - p.getComponent(long)) < span * 0.1);
  const height = (set: THREE.Vector3[]): number =>
    Math.max(...set.map((p) => p.getComponent(tall))) - Math.min(...set.map((p) => p.getComponent(tall)));
  const muzzleAtMax = height(slice('max')) < height(slice('min'));
  const muzzleSlice = slice(muzzleAtMax ? 'max' : 'min');
  // The barrel runs along the top: the muzzle sits above the gun's middle.
  const mid = (b.max[tall] + b.min[tall]) / 2;
  const muzzleMid = muzzleSlice.reduce((s, p) => s + p.getComponent(tall), 0) / muzzleSlice.length;
  const upSign = muzzleMid > mid ? 1 : -1;

  // Rotation: forward (toward the muzzle) → -Z, up → +Y.
  const forward = unit(long, muzzleAtMax ? 1 : -1);
  const up = unit(tall, upSign);
  const right = new THREE.Vector3().crossVectors(forward, up);
  const R = new THREE.Matrix4().makeBasis(right, up, forward.clone().negate()).transpose();
  const q = new THREE.Quaternion().setFromRotationMatrix(R);
  const scale = gun.length / span;

  // Origin: the butt end, level with the top of the stock there.
  const buttSlice = slice(muzzleAtMax ? 'min' : 'max').map((p) => p.clone().applyMatrix4(R).multiplyScalar(scale));
  const turned = pts.map((p) => p.clone().applyMatrix4(R).multiplyScalar(scale));
  const buttZ = Math.max(...turned.map((p) => p.z));
  const centreX = (Math.max(...turned.map((p) => p.x)) + Math.min(...turned.map((p) => p.x))) / 2;
  const stockTop = Math.max(...buttSlice.map((p) => p.y));
  await bake(doc, [-centreX, -stockTop, -buttZ], q.toArray() as [number, number, number, number], scale);
  await doc.transform(prune());
  await io.write(join(dir, 'gun.glb'), doc);

  const after = getBounds(doc.getRoot().listScenes()[0]);
  console.log(
    `${gun.id}: ${span.toFixed(1)} → ${gun.length} m; muzzle at ${muzzleAtMax ? '+' : '-'}${'xyz'[long]}, top ${upSign > 0 ? '+' : '-'}${'xyz'[tall]};` +
      ` now ${after.min.map((v) => v.toFixed(2)).join(',')} .. ${after.max.map((v) => v.toFixed(2)).join(',')}`,
  );
}

for (const gun of GUNS) await prepare(gun);
