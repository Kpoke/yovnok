/**
 * The DUOS car: the brawler's body with its bonnet gun bracket removed (the
 * guns were already cut; in duos the car carries no weapons at all).
 *
 *   npx tsx scripts/prep/brawler-plain.ts     # then: npm run assetbuild
 *
 * Input:  assets-src/vehicles/brawler/chassis.glb        (from prep/brawler.ts)
 * Output: assets-src/vehicles/brawler/chassis-plain.glb
 *
 * Every geometry island lying wholly inside BRACKET (game space, metres) is
 * removed: the two posts, their plates and feet, and the crossbar. The bonnet
 * skin around them is one big island and stays.
 */

import { join } from 'node:path';
import type { Primitive } from '@gltf-transform/core';
import { io, ROOT } from './lib';

const BRACKET = { min: [-0.25, 0.05, -1.3], max: [0.7, 0.42, -0.85] };

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
for (const node of doc.getRoot().listNodes()) {
  const world = node.getWorldMatrix();
  for (const prim of node.getMesh()?.listPrimitives() ?? []) removed += cut(prim, world);
}
await io.write(join(DIR, 'chassis-plain.glb'), doc);
console.log(`chassis-plain.glb: bonnet bracket removed (${removed} triangles)`);
