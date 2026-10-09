/**
 * Shared helpers for the model prep scripts (`scripts/prep/*.ts`), which turn an
 * untouched download in an `original/` folder under `assets-src/` into game-convention part
 * files for `npm run assetbuild`.
 */

import { join } from 'node:path';
import { Document, NodeIO, type Material, type Node, type Texture } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import { clearNodeTransform, flatten, getBounds, prune } from '@gltf-transform/functions';
import sharp from 'sharp';

export const ROOT = join(import.meta.dirname, '..', '..');

export const io = new NodeIO().registerExtensions(ALL_EXTENSIONS);

/** Quaternion for a rotation of `angle` radians about +Y. */
export const yaw = (angle: number): [number, number, number, number] => [0, Math.sin(angle / 2), 0, Math.cos(angle / 2)];

/**
 * Put every scene root under one node carrying `translation/rotation/scale`,
 * then bake all transforms into vertex data so the part has a clean,
 * transform-free hierarchy around its own origin.
 */
export async function bake(
  doc: Document,
  t: [number, number, number],
  r: [number, number, number, number],
  s: number,
): Promise<void> {
  const scene = doc.getRoot().getDefaultScene() ?? doc.getRoot().listScenes()[0];
  const wrap = doc.createNode('wrap').setTranslation(t).setRotation(r).setScale([s, s, s]);
  for (const child of scene.listChildren()) {
    scene.removeChild(child);
    wrap.addChild(child);
  }
  scene.addChild(wrap);
  await doc.transform(flatten());
  for (const node of doc.getRoot().listNodes()) if (node.getMesh()) clearNodeTransform(node);
  // Drop the now-empty transform shells; keep mesh nodes and named sockets.
  for (const node of doc.getRoot().listNodes()) {
    if (!node.getMesh() && node.listChildren().length === 0 && !node.getExtras().socket) node.dispose();
  }
  await doc.transform(prune());
}

/** Remove every node (and its subtree) whose name matches. */
export function removeNodes(doc: Document, match: (node: Node) => boolean): void {
  for (const node of doc.getRoot().listNodes()) {
    if (!node.isDisposed() && match(node)) node.traverse((n) => n.dispose());
  }
}

/** Keep only the subtrees rooted at matching nodes (and their ancestors). */
export function keepOnly(doc: Document, match: (node: Node) => boolean): void {
  const keep = new Set<Node>();
  for (const node of doc.getRoot().listNodes()) {
    if (match(node)) {
      node.traverse((n) => keep.add(n));
      // ...and its ancestors, so their transforms still apply.
      let parent = node.getParentNode();
      while (parent) {
        keep.add(parent);
        parent = parent.getParentNode();
      }
    }
  }
  for (const node of doc.getRoot().listNodes()) if (!keep.has(node)) node.dispose();
}

/** The first mesh node whose first primitive uses material `name`. */
export const byMaterial = (doc: Document, name: string): Node | undefined =>
  doc.getRoot().listNodes().find((n) => n.getMesh()?.listPrimitives()[0]?.getMaterial()?.getName() === name);

/** World-space centre of a node's bounds. */
export function centreOf(node: Node): [number, number, number] {
  const b = getBounds(node);
  return [(b.min[0] + b.max[0]) / 2, (b.min[1] + b.max[1]) / 2, (b.min[2] + b.max[2]) / 2];
}

/**
 * Source texture maps from a download's `textures/` folder. They use the FBX
 * texture convention (V up); a glTF model's UVs expect them flipped
 * top-to-bottom, exactly as Sketchfab's own lower-resolution copies are. Without
 * the flip, texture gutters land on the paintwork as bright patches (measured
 * on both vehicles: ~100% island overlap flipped, much less unflipped).
 */
export function textureKit(dir: string) {
  const source = (name: string) => sharp(join(dir, name)).flip();

  async function grey(file: string | null, size: number, fill: number): Promise<Buffer> {
    if (!file) return Buffer.alloc(size * size, fill);
    return source(file).resize(size, size).greyscale().raw().toBuffer();
  }

  /** glTF ORM: R = occlusion, G = roughness, B = metalness. */
  async function packOrm(ao: string, rough: string, metal: string | null, size = 2048): Promise<Uint8Array> {
    const [r, g, b] = await Promise.all([grey(ao, size, 255), grey(rough, size, 255), grey(metal, size, 0)]);
    const rgb = Buffer.alloc(size * size * 3);
    for (let i = 0; i < size * size; i++) {
      rgb[i * 3] = r[i];
      rgb[i * 3 + 1] = g[i];
      rgb[i * 3 + 2] = b[i];
    }
    return new Uint8Array(await sharp(rgb, { raw: { width: size, height: size, channels: 3 } }).png().toBuffer());
  }

  const pngTexture = (doc: Document, name: string, data: Uint8Array): Texture =>
    doc.createTexture(name).setMimeType('image/png').setImage(data).setURI(`${name}.png`);

  const file = async (name: string): Promise<Uint8Array> => new Uint8Array(await source(name).png().toBuffer());

  /** Swap a material's maps for the higher-resolution source set. */
  async function upgrade(
    doc: Document,
    material: Material,
    maps: { base: string; normal?: string; orm?: [string, string, string | null] },
  ): Promise<void> {
    const name = material.getName();
    material.setBaseColorTexture(pngTexture(doc, `${name}_basecolor`, await file(maps.base)));
    if (maps.normal) material.setNormalTexture(pngTexture(doc, `${name}_normal`, await file(maps.normal)));
    if (maps.orm) {
      const orm = pngTexture(doc, `${name}_orm`, await packOrm(...maps.orm));
      material.setOcclusionTexture(orm).setMetallicRoughnessTexture(orm);
    }
  }

  return { upgrade };
}
