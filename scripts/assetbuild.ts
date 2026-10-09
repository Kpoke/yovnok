/**
 * Asset build: source models in, game-ready models out.
 *
 *   npm run assetbuild                       # every model under assets-src/
 *   npm run assetbuild -- vehicles/truck.glb # just one (path under assets-src/)
 *
 * `assets-src/` holds the editable originals (GPL-3 asks for the "preferred
 * form for modification", so they are kept, not thrown away). Each one is
 * written to the same relative path under `public/assets/`, optimised for a
 * browser:
 *
 *   1. clean-up      dedup, prune, weld — free wins, no visual change
 *   2. LODs          two simplified copies (meshoptimizer), so a car 80 m away
 *                    costs a fraction of one at 5 m. The output scene's roots are
 *                    `lod0`, `lod1`, `lod2`; `GltfPartLibrary` turns them into a
 *                    THREE.LOD. Named helper nodes (sockets) are kept on lod0 only.
 *   3. textures      resized to fit `maxTexture` (default 2048), then KTX2:
 *                    UASTC for normal/ORM data (keeps detail), ETC1S for colour
 *                    (small). KTX2 stays compressed ON THE GPU, which is the
 *                    point: download size is not a goal, video memory is.
 *   4. meshopt       quantised, EXT_meshopt_compression geometry.
 *
 * Folders named `original/` are skipped: they hold untouched downloads, which a
 * script in `scripts/prep/` turns into the sources built here.
 *
 * Optional sidecar `<model>.asset.json` next to a source file:
 *   { "lods": [0.35, 0.1], "maxTexture": 2048, "ktx2": true, "dropFarMaterials": ["interior"] }
 * `lods: []` skips LOD generation (e.g. for a tiny prop).
 *
 * Every source and output file must also be listed in `assets.json`;
 * `npm run licensecheck` fails otherwise.
 */

import { existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { Document, NodeIO, type Node } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import {
  cloneDocument,
  dedup,
  getBounds,
  join as joinMeshes,
  meshopt,
  mergeDocuments,
  prune,
  simplify,
  textureCompress,
  unpartition,
  weld,
} from '@gltf-transform/functions';
import { ktx2 } from 'ktx2-encoder/gltf-transform';
import { MeshoptDecoder, MeshoptEncoder, MeshoptSimplifier } from 'meshoptimizer';
import sharp from 'sharp';
import { PART_ASSET_SPECS } from '../src/shared/assetSpec';

const ROOT = join(import.meta.dirname, '..');
const SRC = join(ROOT, 'assets-src');
const OUT = join(ROOT, 'public', 'assets');

export type BuildOptions = {
  /** Vertex ratio kept for each extra LOD. `[]` = no LODs. */
  lods: number[];
  /** Longest texture edge, px. */
  maxTexture: number;
  /** Convert textures to KTX2. Off only for debugging a texture problem. */
  ktx2: boolean;
  /**
   * Material names left out of the FAR LODs (ratio < 0.3) entirely — parts
   * nobody can see from there, such as a cab interior or the suspension under
   * the body. Often worth more than simplification, which texture seams limit.
   */
  dropFarMaterials: string[];
  /**
   * The file is a material library, not a model: its geometry is replaced by a
   * single quad per primitive, keeping only the materials. Poly Haven's
   * material glTFs carry a 107k-triangle displacement plane nobody draws.
   */
  materialOnly: boolean;
  /**
   * Simplify the WHOLE model to this vertex ratio before anything else, so even
   * lod0 is lighter. For scan-grade props (Poly Haven's road barrier is 80k
   * triangles for a 1.5 m block) placed dozens of times. 1 = untouched.
   */
  baseRatio: number;
};

const DEFAULTS: BuildOptions = {
  lods: [0.35, 0.1],
  maxTexture: 2048,
  ktx2: true,
  dropFarMaterials: [],
  materialOnly: false,
  baseRatio: 1,
};

/** Texture slots holding data rather than colour: compress with UASTC, linear. */
const DATA_SLOTS = /normalTexture|occlusionTexture|metallicRoughnessTexture|clearcoat.*Texture|specular.*Texture/;
const COLOUR_SLOTS = /baseColorTexture|emissiveTexture|sheenColorTexture/;

export async function createIO(): Promise<NodeIO> {
  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;
  return new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
}

/** Decode PNG/JPEG/WebP to raw RGBA for the Basis encoder. */
async function decodeImage(buffer: Uint8Array): Promise<{ width: number; height: number; data: Uint8Array }> {
  const { data, info } = await sharp(buffer).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  return { width: info.width, height: info.height, data: new Uint8Array(data) };
}

export function countTriangles(doc: Document, root?: Node): number {
  let total = 0;
  const visit = (node: Node): void => {
    const mesh = node.getMesh();
    if (mesh) {
      for (const prim of mesh.listPrimitives()) {
        const indices = prim.getIndices();
        const count = indices ? indices.getCount() : (prim.getAttribute('POSITION')?.getCount() ?? 0);
        total += Math.floor(count / 3);
      }
    }
    for (const child of node.listChildren()) visit(child);
  };
  if (root) visit(root);
  else for (const scene of doc.getRoot().listScenes()) for (const node of scene.listChildren()) visit(node);
  return total;
}

/**
 * Wrap a scene's top-level nodes in one group node. Returns the group.
 * For LODs above 0, named nodes without a mesh (sockets) are suffixed so the
 * loader resolves sockets from lod0 alone.
 */
function wrapScene(doc: Document, sceneIndex: number, name: string, level: number): Node {
  const scene = doc.getRoot().listScenes()[sceneIndex];
  const group = doc.createNode(name);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    group.addChild(child);
  }
  if (level > 0) {
    group.traverse((node) => {
      if (node !== group && node.getName() && !node.getMesh()) node.setName(`${node.getName()}@lod${level}`);
    });
  }
  return group;
}

/** Every socket name any part kind uses (see ASSET_SPEC.md § Sockets). */
const SOCKETS = new Set(Object.values(PART_ASSET_SPECS).flatMap((spec) => spec.sockets));

/** A socket: a known socket name (or its `@lodN` copy), or flagged by a prep script. */
const isSocket = (node: Node): boolean =>
  SOCKETS.has(node.getName().split('@')[0]) || node.getExtras().socket === true;

/**
 * Remove empty leaf nodes — the transform shells an FBX export leaves behind —
 * but never a socket, which is an empty leaf node by design. Repeats until
 * stable, since removing a leaf can leave its parent empty.
 */
function pruneEmptyNodes(doc: Document): void {
  let removed = true;
  while (removed) {
    removed = false;
    for (const node of doc.getRoot().listNodes()) {
      if (node.getMesh() || node.listChildren().length > 0 || isSocket(node)) continue;
      if (/^lod\d+$/.test(node.getName())) continue;
      node.dispose();
      removed = true;
    }
  }
}

/** Remove mesh nodes smaller than `size` (bounding-box diagonal, metres). */
function dropSmallParts(doc: Document, size: number): void {
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh()) continue;
    const b = getBounds(node);
    if (Math.hypot(b.max[0] - b.min[0], b.max[1] - b.min[1], b.max[2] - b.min[2]) < size) node.dispose();
  }
}

/**
 * Every `prune` here keeps empty leaf nodes: sockets ARE empty leaf nodes, and
 * the default would silently strip every socket from every asset.
 */
/** Replace every primitive's geometry with one 1 m quad, keeping its material. */
function shrinkToQuads(doc: Document): void {
  const buffer = doc.getRoot().listBuffers()[0] ?? doc.createBuffer();
  const accessor = (type: 'VEC2' | 'VEC3' | 'VEC4' | 'SCALAR', array: Float32Array<ArrayBuffer> | Uint16Array<ArrayBuffer>) =>
    doc.createAccessor().setType(type).setArray(array).setBuffer(buffer);
  for (const mesh of doc.getRoot().listMeshes()) {
    for (const prim of mesh.listPrimitives()) {
      for (const semantic of prim.listSemantics()) prim.setAttribute(semantic, null);
      prim
        .setAttribute('POSITION', accessor('VEC3', new Float32Array([-0.5, 0, -0.5, 0.5, 0, -0.5, 0.5, 0, 0.5, -0.5, 0, 0.5])))
        .setAttribute('NORMAL', accessor('VEC3', new Float32Array([0, 1, 0, 0, 1, 0, 0, 1, 0, 0, 1, 0])))
        .setAttribute('TEXCOORD_0', accessor('VEC2', new Float32Array([0, 0, 1, 0, 1, 1, 0, 1])))
        .setIndices(accessor('SCALAR', new Uint16Array([0, 2, 1, 0, 3, 2])));
    }
  }
}

export async function buildDocument(doc: Document, options: BuildOptions): Promise<Document> {
  if (options.materialOnly) shrinkToQuads(doc);
  await doc.transform(dedup(), prune({ keepLeaves: true }), weld());
  if (options.baseRatio < 1) {
    await doc.transform(
      joinMeshes({ cleanup: false }),
      prune({ keepLeaves: true }),
      weld(),
      simplify({ simplifier: MeshoptSimplifier, ratio: options.baseRatio, error: 0.01 }),
    );
  }

  if (options.lods.length > 0) {
    // Simplify copies BEFORE merging, so each LOD is simplified from the full
    // mesh rather than from the previous LOD.
    const copies: Document[] = [];
    for (const ratio of options.lods) {
      const copy = cloneDocument(doc);
      // A far LOD may lose more shape: it is only ever seen small. Handles,
      // hinges and badges vanish first — they are pixels at that distance, and
      // tiny separate parts are what stop a model from simplifying at all.
      const near = ratio >= 0.3;
      dropSmallParts(copy, near ? 0.1 : 0.3);
      if (!near && options.dropFarMaterials.length > 0) {
        for (const prim of copy.getRoot().listMeshes().flatMap((m) => m.listPrimitives())) {
          if (options.dropFarMaterials.includes(prim.getMaterial()?.getName() ?? '')) prim.dispose();
        }
      }
      await copy.transform(
        prune({ keepLeaves: true }),
        joinMeshes({ cleanup: false }),
        prune({ keepLeaves: true }),
        weld(),
        simplify({ simplifier: MeshoptSimplifier, ratio, error: near ? 0.02 : 0.15 }),
      );
      copies.push(copy);
    }
    const lod0 = wrapScene(doc, 0, 'lod0', 0);
    const main = doc.getRoot().listScenes()[0];
    main.addChild(lod0);
    copies.forEach((copy, i) => {
      mergeDocuments(doc, copy);
      const scenes = doc.getRoot().listScenes();
      const mergedIndex = scenes.length - 1;
      const group = wrapScene(doc, mergedIndex, `lod${i + 1}`, i + 1);
      main.addChild(group);
      scenes[mergedIndex].dispose();
    });
    doc.getRoot().setDefaultScene(main);
    // The copies brought their own materials, textures and buffers; fold them
    // back into one (a .glb may hold a single buffer).
    await doc.transform(dedup(), prune({ keepLeaves: true }), unpartition());
  }

  // One draw call per material rather than per authored part: a realistic body
  // arrives as dozens of meshes, and twelve such cars would cost ~1000 calls.
  // Socket nodes carry no mesh, so they survive untouched.
  // `cleanup: false`: join's own clean-up would prune the socket nodes.
  await doc.transform(joinMeshes({ cleanup: false }), prune({ keepLeaves: true }));
  pruneEmptyNodes(doc);

  const textures = doc.getRoot().listTextures().length;
  if (textures > 0) {
    await doc.transform(
      textureCompress({ encoder: sharp, resize: [options.maxTexture, options.maxTexture] }),
    );
    if (options.ktx2) {
      await doc.transform(
        // UASTC keeps normal/ORM detail; zstd supercompression keeps the file sane.
        ktx2({ slots: DATA_SLOTS, isUASTC: true, needSupercompression: true, generateMipmap: true, enableDebug: false, imageDecoder: decodeImage }),
        ktx2({ slots: COLOUR_SLOTS, isUASTC: false, qualityLevel: 230, generateMipmap: true, enableDebug: false, imageDecoder: decodeImage }),
      );
    }
  }

  await doc.transform(meshopt({ encoder: MeshoptEncoder, level: 'medium' }));
  return doc;
}

function readOptions(source: string): BuildOptions {
  const sidecar = source.replace(/\.(glb|gltf)$/i, '.asset.json');
  if (!existsSync(sidecar)) return DEFAULTS;
  return { ...DEFAULTS, ...(JSON.parse(readFileSync(sidecar, 'utf8')) as Partial<BuildOptions>) };
}

function listSources(dir: string, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    // `original/` holds untouched downloads; a prep script turns them into
    // the sources built here (see scripts/prep/).
    if (statSync(path).isDirectory()) {
      if (name !== 'original') listSources(path, out);
    }
    else if (/\.(glb|gltf)$/i.test(name)) out.push(path);
  }
  return out;
}

const kb = (bytes: number): string => `${(bytes / 1024).toFixed(0)} KB`;

async function main(): Promise<number> {
  // The Basis encoder prints per-mip debug lines regardless of `enableDebug`.
  const log = console.log;
  console.log = (...args: unknown[]) => {
    if (typeof args[0] === 'string' && /^(Total slices|Slice: )/.test(args[0])) return;
    log(...args);
  };
  const io = await createIO();
  const only = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const sources = only.length > 0 ? only.map((p) => join(SRC, p)) : listSources(SRC);
  if (sources.length === 0) {
    console.log('assetbuild: nothing under assets-src/ yet');
    return 0;
  }

  let failures = 0;
  for (const source of sources) {
    const rel = relative(SRC, source).replace(/\.gltf$/i, '.glb');
    const target = join(OUT, rel);
    try {
      const options = readOptions(source);
      const doc = await io.read(source);
      const before = countTriangles(doc);
      await buildDocument(doc, options);
      mkdirSync(dirname(target), { recursive: true });
      await io.write(target, doc);

      const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
      const levels = scene
        .listChildren()
        .filter((n) => /^lod\d$/.test(n.getName()))
        .map((n) => `${n.getName()} ${countTriangles(doc, n)}`);
      const formats = [...new Set(doc.getRoot().listTextures().map((t) => t.getMimeType()))];
      console.log(
        `✓ ${rel}: ${before} tris → ${levels.length ? levels.join(' · ') : `${countTriangles(doc)} tris`}` +
          ` · ${doc.getRoot().listTextures().length} textures ${formats.join(', ')}` +
          ` · ${kb(statSync(source).size)} → ${kb(statSync(target).size)}`,
      );
    } catch (error) {
      failures++;
      console.error(`✗ ${rel}:`, error instanceof Error ? error.message : error);
    }
  }
  console.log('\nremember: list new files in assets.json, then npm run licensecheck -- --write');
  return failures === 0 ? 0 : 1;
}

if (process.argv[1]?.endsWith('assetbuild.ts')) {
  process.exit(await main());
}
