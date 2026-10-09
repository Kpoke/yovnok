import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const node = doc.getRoot().listNodes().find(n => n.getName() === 'Car01_Car01_0')!;
const world = node.getWorldMatrix();
const prim = node.getMesh()!.listPrimitives()[0];
const pos = prim.getAttribute('POSITION')!; const idx = prim.getIndices()!;
const n = pos.getCount(); const parent = Int32Array.from({ length: n }, (_, i) => i);
const find = (a: number): number => { while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; } return a; };
// weld by position too, so UV seams do not split islands
const key = new Map<string, number>(); const v = [0, 0, 0];
for (let i = 0; i < n; i++) { pos.getElement(i, v); const k = v.map(x => x.toFixed(4)).join(','); const j = key.get(k); if (j === undefined) key.set(k, i); else parent[find(i)] = find(j); }
for (let t = 0; t < idx.getCount(); t += 3) { const a = idx.getScalar(t), b = idx.getScalar(t + 1), c = idx.getScalar(t + 2); parent[find(b)] = find(a); parent[find(c)] = find(a); }
const isl = new Map<number, { tris: number; min: number[]; max: number[] }>();
const m = world; const tx = (p: number[]) => [m[0]*p[0]+m[4]*p[1]+m[8]*p[2]+m[12], m[1]*p[0]+m[5]*p[1]+m[9]*p[2]+m[13], m[2]*p[0]+m[6]*p[1]+m[10]*p[2]+m[14]];
for (let t = 0; t < idx.getCount(); t += 3) {
  const a = idx.getScalar(t); const r = find(a);
  let e = isl.get(r); if (!e) isl.set(r, e = { tris: 0, min: [1e9,1e9,1e9], max: [-1e9,-1e9,-1e9] });
  e.tris++;
  for (const vi of [a, idx.getScalar(t+1), idx.getScalar(t+2)]) { pos.getElement(vi, v); const w = tx(v); for (let k = 0; k < 3; k++) { e.min[k] = Math.min(e.min[k], w[k]); e.max[k] = Math.max(e.max[k], w[k]); } }
}
console.log('islands', isl.size);
const rows = [...isl.entries()].map(([id, e]) => ({ id, ...e, c: e.min.map((x, k) => (x + e.max[k]) / 2), s: e.max.map((x, k) => x - e.min[k]) }));
for (const r of rows.filter(r => r.c[0] > 40 && r.c[1] > 90 && Math.abs(r.c[2]) < 60).sort((a, b) => b.tris - a.tris).slice(0, 40))
  console.log(r.tris.toString().padStart(5), 'centre', r.c.map(x => x.toFixed(0)).join(','), 'size', r.s.map(x => x.toFixed(0)).join('x'));
