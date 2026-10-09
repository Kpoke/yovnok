import { NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { getBounds } from '@gltf-transform/functions';
const doc = await new NodeIO().registerExtensions(ALL_EXTENSIONS).read(process.argv[2]);
const root = doc.getRoot(); const scene = root.getDefaultScene() ?? root.listScenes()[0];
const sb = getBounds(scene);
console.log(`size ${sb.max.map((v, i) => (v - sb.min[i]).toFixed(3)).join(' x ')} min ${sb.min.map(v=>v.toFixed(3))} max ${sb.max.map(v=>v.toFixed(3))}`);
console.log('materials:', root.listMaterials().map(m => m.getName()).join(', '), '| textures', root.listTextures().map(t => t.getSize()?.join('x')).join(' '));
const tris = (n: Node) => { let t = 0; const m = n.getMesh(); if (m) for (const p of m.listPrimitives()) { const i = p.getIndices(); t += Math.floor((i ? i.getCount() : p.getAttribute('POSITION')!.getCount()) / 3); } return t; };
for (const n of root.listNodes()) if (n.getMesh()) { const b = getBounds(n); console.log(' ', n.getName(), tris(n), 'size', b.max.map((v, i) => (v - b.min[i]).toFixed(3)).join('x'), 'centre', b.max.map((v, i) => ((v + b.min[i]) / 2).toFixed(3)).join(','), n.getMesh()!.listPrimitives().map(p => p.getMaterial()?.getName()).join('/')); }
