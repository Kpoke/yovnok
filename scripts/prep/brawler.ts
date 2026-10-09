/**
 * Prep the solo "brawler" — a 2-seat armoured muscle car — from its download.
 *
 *   npx tsx scripts/prep/brawler.ts      # then: npm run assetbuild
 *
 * Input (unmodified download, kept as the preferred form for modification):
 *   assets-src/vehicles/brawler/original/armored-car-death-race.glb  (jaack, CC BY 4.0)
 *   assets-src/vehicles/brawler/original/textures/Car01_*.png       (its 4096 px maps)
 *
 * Outputs, in game convention (metres, +Y up, -Z forward, part-local origins —
 * see ASSET_SPEC.md):
 *   assets-src/vehicles/brawler/chassis.glb  body without wheels or its hood guns
 *   assets-src/vehicles/brawler/wheel.glb    one (rear) wheel, axle along X,
 *                                            hub facing -X (mirrored on the right)
 *
 * The car's guns and roof weapon reuse the armoured truck's parts (the M2 and
 * the RPG station), scaled in the manifest.
 *
 * Changes from the original: turned to face -Z (it faces +X), units cm → m,
 * wheels split out, the modelled hood guns removed (the twin M2s sit at the
 * headlights instead), and the 4096 px source maps used — flipped to glTF's
 * texture convention — with AO/roughness/metalness packed into one ORM map.
 */

import { join } from 'node:path';
import type { Document, Node, Primitive } from '@gltf-transform/core';
import { cloneDocument, getBounds, prune } from '@gltf-transform/functions';
import { bake, centreOf, io, keepOnly, removeNodes, ROOT, textureKit, yaw } from './lib';

const BRAWLER = join(ROOT, 'assets-src', 'vehicles', 'brawler');
const tex = textureKit(join(BRAWLER, 'original', 'textures'));

/** cm → m. The model is real-world sized: 4.9 m long, 1.5 m tall. */
const SCALE = 0.01;
/** Axle midpoint along the model's +X (its forward axis), cm. */
const AXLE_MID_X = 13.15;
/** Ground-to-chassis-centre height, cm. Matches `VEHICLE_CLASSES.solo.rideHeight`. */
const CENTRE_Y = 78;
/**
 * The modelled hood guns, as a box in model space (cm). Every geometry island
 * lying wholly inside it is removed; the hood skin around it is one big island
 * and is untouched.
 */
const HOOD_GUNS = { min: [92, 88, -16], max: [192, 116, 57] };

const isWheel = (node: Node): boolean => node.getName().startsWith('Car01_Wheel');

/** Model point p → yaw(+90°)·S·(p − origin): the model's +X becomes the game's -Z. */
function toGameTranslation(origin: [number, number, number]): [number, number, number] {
  // Rotating (x, z) by +90° about Y gives (z, -x).
  return [-origin[2] * SCALE, -origin[1] * SCALE, origin[0] * SCALE];
}

/** Drop the triangles of every geometry island that lies wholly inside `box` (world space). */
function cutIslands(node: Node, box: { min: number[]; max: number[] }): number {
  const world = node.getWorldMatrix();
  let removed = 0;
  for (const prim of node.getMesh()?.listPrimitives() ?? []) removed += cutPrimitive(prim, world, box);
  return removed;
}

function cutPrimitive(prim: Primitive, m: readonly number[], box: { min: number[]; max: number[] }): number {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  if (!pos || !idx) return 0;
  const n = pos.getCount();
  // Union-find over vertices, welding by position so UV seams don't split islands.
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  const byPosition = new Map<string, number>();
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const key = v.map((x) => x.toFixed(4)).join(',');
    const first = byPosition.get(key);
    if (first === undefined) byPosition.set(key, i);
    else parent[find(i)] = find(first);
  }
  for (let t = 0; t < idx.getCount(); t += 3) {
    const a = idx.getScalar(t);
    parent[find(idx.getScalar(t + 1))] = find(a);
    parent[find(idx.getScalar(t + 2))] = find(a);
  }
  // An island is cut only if EVERY one of its vertices is inside the box.
  const outside = new Set<number>();
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const w = [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    ];
    if (w.some((x, k) => x < box.min[k] || x > box.max[k])) outside.add(find(i));
  }
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < idx.getCount(); t += 3) {
    if (outside.has(find(idx.getScalar(t)))) {
      kept.push(idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2));
    } else {
      removed++;
    }
  }
  idx.setArray(n > 65535 ? new Uint32Array(kept) : new Uint16Array(kept));
  return removed;
}

async function upgradeTextures(doc: Document): Promise<void> {
  const body = doc.getRoot().listMaterials().find((m) => m.getName() === 'Car01');
  if (body) {
    await tex.upgrade(doc, body, {
      base: 'Car01_BaseColor.png',
      normal: 'Car01_normal.png',
      orm: ['Car01_Ao.png', 'Car01_Roughness.png', 'Car01_metalness.png'],
    });
  }
  // The glass keeps the download's own maps.
}

async function chassis(source: Document): Promise<{ doc: Document; cut: number }> {
  const doc = cloneDocument(source);
  removeNodes(doc, isWheel);
  const body = doc.getRoot().listNodes().find((n) => n.getName() === 'Car01_Car01_0');
  if (!body) throw new Error('car body not found');
  const cut = cutIslands(body, HOOD_GUNS);
  await bake(doc, toGameTranslation([AXLE_MID_X, CENTRE_Y, 0]), yaw(Math.PI / 2), SCALE);
  await upgradeTextures(doc);
  await doc.transform(prune());
  return { doc, cut };
}

async function wheel(source: Document): Promise<Document> {
  const doc = cloneDocument(source);
  // The rear-left wheel: rear is the model's -X, left its -Z (the turn to game
  // space puts -Z on the car's left). Rear, because the front meshes are wider
  // than round (0.57 × 0.75 m — they carry suspension parts); the rear is a
  // clean 0.70 m disc, which the rig can spin.
  const pick = doc
    .getRoot()
    .listNodes()
    .filter((n) => isWheel(n) && n.getMesh())
    .find((n) => {
      const [x, , z] = centreOf(n);
      return x < 0 && z < 0;
    });
  if (!pick) throw new Error('rear-left wheel not found');
  keepOnly(doc, (n) => n === pick);
  const b = getBounds(pick);
  const centre: [number, number, number] = [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
  await bake(doc, toGameTranslation(centre), yaw(Math.PI / 2), SCALE);
  await upgradeTextures(doc);
  await doc.transform(prune());
  return doc;
}

async function main(): Promise<void> {
  const car = await io.read(join(BRAWLER, 'original', 'armored-car-death-race.glb'));
  const { doc: body, cut } = await chassis(car);
  const parts: Array<[string, Document]> = [
    [join(BRAWLER, 'chassis.glb'), body],
    [join(BRAWLER, 'wheel.glb'), await wheel(car)],
  ];
  for (const [path, doc] of parts) {
    await io.write(path, doc);
    const b = getBounds(doc.getRoot().getDefaultScene()!);
    const size = b.max.map((v, i) => (v - b.min[i]).toFixed(2)).join(' × ');
    const centre = b.max.map((v, i) => ((v + b.min[i]) / 2).toFixed(2)).join(', ');
    console.log(`✓ ${path.slice(ROOT.length + 1)}: ${size} m, centre (${centre}), y ${b.min[1].toFixed(2)}..${b.max[1].toFixed(2)}`);
  }
  console.log(`  hood guns: ${cut} triangles removed`);
}

await main();
