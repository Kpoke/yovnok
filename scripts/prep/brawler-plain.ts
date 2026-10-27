/**
 * The DUOS car: the brawler's body with its bonnet gun bracket removed (the
 * guns were already cut; in duos the car carries no weapons at all), and its
 * passenger window opened: the armoured louvres cut away so the gunner can
 * lean out of it.
 *
 *   npx tsx scripts/prep/brawler-plain.ts     # then: npm run assetbuild
 *
 * Input:  assets-src/vehicles/brawler/chassis.glb        (from prep/brawler.ts)
 * Output: assets-src/vehicles/brawler/chassis-plain.glb
 *
 * Every geometry island lying wholly inside BRACKET (game space, metres) is
 * removed: the two posts, their plates and feet, and the crossbar. The bonnet
 * skin around them is one big island and stays.
 *
 * The louvres are part of the body's own island, so for them it is every
 * TRIANGLE lying wholly inside LOUVRES: the slats go, the door and roof edges
 * around the opening (which reach outside the box) stay.
 */

import { join } from 'node:path';
import type { Primitive } from '@gltf-transform/core';
import { io, ROOT } from './lib';

const BRACKET = { min: [-0.25, 0.05, -1.3], max: [0.7, 0.42, -0.85] };
/** The passenger (right) window opening; must agree with shared/crews.ts CABIN.coupe. */
const LOUVRES = { min: [0.5, 0.17, -0.35], max: [0.95, 0.6, 0.8] };

/** The primitive's vertices in game space, through its node's world matrix. */
function worldPositions(prim: Primitive, m: readonly number[]): Float32Array {
  const pos = prim.getAttribute('POSITION');
  const n = pos?.getCount() ?? 0;
  const out = new Float32Array(n * 3);
  const v = [0, 0, 0];
  for (let i = 0; i < n; i++) {
    pos!.getElement(i, v);
    out[i * 3] = m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12];
    out[i * 3 + 1] = m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13];
    out[i * 3 + 2] = m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14];
  }
  return out;
}

/** Remove every triangle lying wholly inside `box`. */
function cutTriangles(prim: Primitive, m: readonly number[], box: { min: number[]; max: number[] }): number {
  const idx = prim.getIndices();
  if (!idx) return 0;
  const w = worldPositions(prim, m);
  const inside = (i: number): boolean => [0, 1, 2].every((k) => w[i * 3 + k] >= box.min[k] && w[i * 3 + k] <= box.max[k]);
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < idx.getCount(); t += 3) {
    const a = idx.getScalar(t);
    const b = idx.getScalar(t + 1);
    const c = idx.getScalar(t + 2);
    if (inside(a) && inside(b) && inside(c)) removed++;
    else kept.push(a, b, c);
  }
  idx.setArray(w.length / 3 > 65535 ? new Uint32Array(kept) : new Uint16Array(kept));
  return removed;
}

function cut(prim: Primitive, m: readonly number[]): number {
  const pos = prim.getAttribute('POSITION');
  const idx = prim.getIndices();
  if (!pos || !idx) return 0;
  const n = pos.getCount();
  const parent = Int32Array.from({ length: n }, (_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) {
      parent[a] = parent[parent[a]];
      a = parent[a];
    }
    return a;
  };
  // Weld by position so UV seams do not split an island.
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
  const outside = new Set<number>();
  for (let i = 0; i < n; i++) {
    pos.getElement(i, v);
    const w = [
      m[0] * v[0] + m[4] * v[1] + m[8] * v[2] + m[12],
      m[1] * v[0] + m[5] * v[1] + m[9] * v[2] + m[13],
      m[2] * v[0] + m[6] * v[1] + m[10] * v[2] + m[14],
    ];
    if (w.some((x, k) => x < BRACKET.min[k] || x > BRACKET.max[k])) outside.add(find(i));
  }
  const kept: number[] = [];
  let removed = 0;
  for (let t = 0; t < idx.getCount(); t += 3) {
    if (outside.has(find(idx.getScalar(t)))) kept.push(idx.getScalar(t), idx.getScalar(t + 1), idx.getScalar(t + 2));
    else removed++;
  }
  idx.setArray(n > 65535 ? new Uint32Array(kept) : new Uint16Array(kept));
  return removed;
}

const DIR = join(ROOT, 'assets-src', 'vehicles', 'brawler');
const doc = await io.read(join(DIR, 'chassis.glb'));
let removed = 0;
let louvres = 0;
for (const node of doc.getRoot().listNodes()) {
  const world = node.getWorldMatrix();
  for (const prim of node.getMesh()?.listPrimitives() ?? []) {
    removed += cut(prim, world);
    louvres += cutTriangles(prim, world, LOUVRES);
  }
}
await io.write(join(DIR, 'chassis-plain.glb'), doc);
console.log(`chassis-plain.glb: bonnet bracket removed (${removed} triangles), passenger window opened (${louvres} triangles)`);
