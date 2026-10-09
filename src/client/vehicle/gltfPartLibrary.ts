/**
 * glTF-backed parts.
 *
 * Loads a manifest describing which .glb provides each part, resolves sockets by
 * node name, and substitutes materials by slot name so cosmetic colours still
 * apply. Everything is loaded once in `prepare` and then cloned per car, which
 * keeps `create` synchronous — the rig builds a car the moment a player appears
 * and cannot await.
 *
 * Nothing currently ships in this form. It exists so that the day a model
 * arrives — from an artist, a parametric generator, or an AI tool — it drops in
 * by editing a manifest rather than by editing the game. Anything the manifest
 * cannot satisfy falls back to the procedural library rather than leaving a car
 * with a missing wheel.
 *
 * Assets must satisfy `src/shared/assetSpec.ts`; `npm run assetcheck` enforces it.
 */

import * as THREE from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { PartManifestEntry, VehicleManifest } from '../../shared/assetSpec';
import { partKey, type PartLibrary, type PartRequest } from './partLibrary';
import type { PartBuild, VehicleMaterials } from './parts';

export class GltfPartLibrary implements PartLibrary {
  readonly name = 'gltf';

  private readonly loader: GLTFLoader;
  private readonly templates = new Map<string, THREE.Object3D>();
  /** Manifest entry per loaded template, for per-part options such as paint. */
  private readonly entries = new Map<string, PartManifestEntry>();
  /** One download and parse per file, however many parts point at it. */
  private readonly files = new Map<string, Promise<THREE.Group>>();
  private readonly manifestUrl: string;
  private readonly fallback: PartLibrary;

  private manifest: VehicleManifest | null = null;
  /** Part keys with no usable asset, so `create` falls through without retrying. */
  private readonly unavailable = new Set<string>();

  /**
   * `loader` should come from `createGltfLoader` so built assets (meshopt
   * geometry, KTX2 textures) decode; a bare GLTFLoader reads only plain glTF.
   */
  constructor(manifestUrl: string, fallback: PartLibrary, loader: GLTFLoader = new GLTFLoader()) {
    this.manifestUrl = manifestUrl;
    this.fallback = fallback;
    this.loader = loader;
  }

  /** How many parts actually came from assets, for a startup log line. */
  get loadedCount(): number {
    return this.templates.size;
  }

  async prepare(requests: PartRequest[]): Promise<void> {
    try {
      const response = await fetch(this.manifestUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      this.manifest = (await response.json()) as VehicleManifest;
    } catch (error) {
      // No manifest is a perfectly normal state: the game runs on procedural
      // parts and should say so once, not per part.
      console.info('[assets] no vehicle manifest found; using procedural parts');
      return;
    }

    const base = new URL(this.manifestUrl, location.href);

    await Promise.all(
      requests.map(async (request) => {
        const key = this.cacheKey(request);
        // Most specific first: `solo/wheel.2`, `wheel.2`, then `solo/wheel` so
        // one realistic wheel can serve every cosmetic wheel style.
        const entry =
          this.manifest?.parts[key] ??
          this.manifest?.parts[partKey(request)] ??
          this.manifest?.parts[`${request.cls}/${request.kind}`];
        if (!entry) {
          this.unavailable.add(key);
          return;
        }

        try {
          const url = new URL(entry.file, base).href;
          let file = this.files.get(url);
          if (!file) {
            file = this.loader.loadAsync(url).then((gltf) => gltf.scene);
            this.files.set(url, file);
          }
          // A private copy per part: `toLod` restructures what it is given.
          const scene = (await file).clone(true);
          const root = entry.node ? (scene.getObjectByName(entry.node) ?? scene) : scene;
          const template = toLod(root, entry.lodDistances);
          template.traverse((object) => {
            const mesh = object as THREE.Mesh;
            if (!mesh.isMesh) return;
            mesh.castShadow = true;
            mesh.receiveShadow = true;
            for (const material of [mesh.material].flat()) noTransmission(material);
          });
          this.entries.set(key, entry);

          if (entry.scale && entry.scale !== 1) template.scale.multiplyScalar(entry.scale);
          if (entry.offset) template.position.add(new THREE.Vector3(...entry.offset));
          template.updateMatrixWorld(true);

          this.templates.set(key, template);
        } catch (error) {
          console.warn(`[assets] failed to load "${key}"; falling back`, error);
          this.unavailable.add(key);
        }
      }),
    );

    console.info(
      `[assets] ${this.templates.size}/${requests.length} vehicle parts loaded from glTF`,
    );
  }

  create(request: PartRequest, materials: VehicleMaterials): PartBuild {
    const key = this.cacheKey(request);
    const template = this.templates.get(key) ?? this.templates.get(partKey(request));
    if (!template) return this.fallback.create(request, materials);
    const entry = this.entries.get(key);
    const paint = new Set(entry?.paint ?? []);
    const strength = entry?.paintStrength ?? 0.45;

    const instance = template.clone(true);
    const sockets: Record<string, THREE.Object3D> = {};

    instance.traverse((object) => {
      // Sockets are plain nodes the asset author placed and named.
      if (object.name) sockets[object.name] = object;

      const mesh = object as THREE.Mesh;
      if (!mesh.isMesh) return;
      // Substitute by slot name, so an asset's "body" takes the accent colour.
      const material = mesh.material as THREE.Material | THREE.Material[];
      const apply = (m: THREE.Material): THREE.Material => {
        const base = entry?.baseTint?.[m.name];
        if (base || paint.has(m.name)) {
          return tint(m, base ? new THREE.Color(base) : null, paint.has(m.name) ? materials : null, strength);
        }
        return substitute(m, materials);
      };
      if (Array.isArray(material)) {
        mesh.material = material.map(apply);
      } else if (material) {
        mesh.material = apply(material);
      }
    });

    const group = new THREE.Group();
    group.add(instance);
    return { group, sockets };
  }

  dispose(): void {
    for (const template of this.templates.values()) {
      template.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.geometry) mesh.geometry.dispose();
      });
    }
    this.templates.clear();
  }

  private cacheKey(request: PartRequest): string {
    return `${request.cls}/${partKey(request)}`;
  }
}

/** Default switch distances (m) for lod0, lod1, lod2… when the manifest gives none. */
export const DEFAULT_LOD_DISTANCES = [0, 30, 80];

/**
 * Built assets carry their detail levels as root children named `lod0`, `lod1`…
 * (see scripts/assetbuild.ts). Turn those into a THREE.LOD, which the renderer
 * switches by camera distance every frame. Anything else is returned unchanged.
 */
export function toLod(root: THREE.Object3D, distances: readonly number[] = DEFAULT_LOD_DISTANCES): THREE.Object3D {
  const levels = root.children
    .filter((child) => /^lod\d+$/.test(child.name))
    .sort((a, b) => Number(a.name.slice(3)) - Number(b.name.slice(3)));
  if (levels.length === 0) return root;

  const lod = new THREE.LOD();
  lod.name = root.name;
  lod.position.copy(root.position);
  lod.quaternion.copy(root.quaternion);
  lod.scale.copy(root.scale);
  levels.forEach((level, i) => {
    root.remove(level);
    // Past the listed distances, keep spacing the levels out by the last gap.
    const last = distances[distances.length - 1] ?? 0;
    const gap = distances.length > 1 ? last - distances[distances.length - 2] : 50;
    lod.addLevel(level, distances[i] ?? last + gap * (i - distances.length + 1));
  });
  return lod;
}

/**
 * A textured material with a fixed `base` multiplier and/or the livery PAINTED
 * over it. Cached per source material and colour, so a field of cars shares a
 * handful of materials.
 *
 * The livery used to MULTIPLY the texture, and multiplying can only darken: on
 * the brawler's dark, rusty texture every livery came out dark brown, the colour
 * of the arena floor. Now it is a paint layer (`applyPaint`): the livery colour,
 * shaded by the texture's own brightness, so rust, plates and grime still show
 * through it but the car reads as orange, cyan, ivory…
 */
const tints = new WeakMap<THREE.Material, Map<string, THREE.Material>>();
function tint(
  material: THREE.Material,
  base: THREE.Color | null,
  livery: VehicleMaterials | null,
  strength: number,
): THREE.Material {
  const source = material as THREE.MeshStandardMaterial;
  if (!source.color) return material;
  const target = base ? base.clone() : new THREE.Color(1, 1, 1);
  const liveryBody = livery ? (livery.body as THREE.MeshPhysicalMaterial) : null;
  const body = liveryBody ? liveryBody.color : null;
  // The FINISH (gloss / matte / pearl / chrome) lives on the livery's procedural
  // body material; it is part of the paint, so it is part of the cache key.
  const finishKey = liveryBody
    ? `${liveryBody.roughness}:${liveryBody.metalness}:${liveryBody.clearcoat}:${liveryBody.sheen}`
    : '';
  const key = `${target.getHexString()}:${body?.getHexString() ?? ''}:${strength}:${finishKey}`;
  let byColour = tints.get(material);
  if (!byColour) tints.set(material, (byColour = new Map()));
  let tinted = byColour.get(key);
  if (!tinted) {
    const copy = source.clone();
    copy.color.copy(target);
    if (body) applyPaint(copy, body.clone(), strength);
    if (liveryBody) applyFinish(copy, liveryBody);
    byColour.set(key, (tinted = copy));
  }
  return tinted;
}

/** Swap a material whose name matches a slot in the vehicle's material set. */
function substitute(material: THREE.Material, materials: VehicleMaterials): THREE.Material {
  const slot = (materials as Record<string, THREE.Material>)[material.name];
  return slot ?? material;
}

/**
 * Turn physically-based TRANSMISSION (KHR_materials_transmission) into plain
 * transparency. While any transmissive material is on screen, three.js renders
 * every opaque object a second time into a buffer for it to refract — the car
 * glass alone doubled the frame's draw calls. Tinted car glass at driving
 * distance looks the same as ordinary alpha blending.
 */
function noTransmission(material: THREE.Material): void {
  const physical = material as THREE.MeshPhysicalMaterial;
  if (!physical.isMeshPhysicalMaterial || physical.transmission <= 0) return;
  physical.opacity = Math.min(physical.opacity, 1 - physical.transmission * 0.6);
  physical.transmission = 0;
  physical.transparent = true;
  physical.depthWrite = false;
  physical.needsUpdate = true;
}

/**
 * Paint a textured material: blend its albedo toward the paint colour, shaded by
 * the texture's own luminance so its detail survives. Runs after the map (and
 * after `color`, so scorching still darkens the paint). Every painted material
 * shares one shader program; the colour and strength are per-material uniforms.
 *
 * Material.clone() does not carry `onBeforeCompile` — anything that clones a
 * painted material must copy it across (see `copyPaint`).
 */
export function applyPaint(material: THREE.MeshStandardMaterial, colour: THREE.Color, strength: number): void {
  material.userData.paint = { colour, strength };
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uPaint = { value: colour };
    shader.uniforms.uPaintStrength = { value: strength };
    shader.fragmentShader = shader.fragmentShader
      .replace('void main() {', 'uniform vec3 uPaint;\nuniform float uPaintStrength;\nvoid main() {')
      .replace(
        '#include <map_fragment>',
        `#include <map_fragment>
        {
          float lum = dot(diffuseColor.rgb, vec3(0.299, 0.587, 0.114));
          // The brawler's texture is dark (lum ~0.1–0.3): lift it so the paint
          // comes out at full colour, with the texture's detail as variation.
          vec3 painted = uPaint * clamp(0.35 + lum * 2.8, 0.3, 1.2);
          diffuseColor.rgb = mix(diffuseColor.rgb, painted, uPaintStrength);
        }`,
      );
  };
  material.customProgramCacheKey = () => 'livery-paint';
}

/** Carry a material's paint onto a clone of it. */
export function copyPaint(from: THREE.Material, to: THREE.MeshStandardMaterial): void {
  const paint = from.userData.paint as { colour: THREE.Color; strength: number } | undefined;
  if (paint) applyPaint(to, paint.colour, paint.strength);
}

/**
 * Carry the livery's FINISH onto a textured, painted material: how rough, how
 * metallic, how much clear coat and sheen. The model's roughness MAP stays (it
 * is the grime and wear); the finish scales it, so matte is dull everywhere and
 * chrome is mirror-bright where the texture is clean. Before this, every finish
 * was only a colour on the realistic car — Matte Black and Chrome looked alike.
 */
function applyFinish(material: THREE.MeshStandardMaterial, finish: THREE.MeshPhysicalMaterial): void {
  // Gloss (0.34) is the reference: it keeps the texture's own roughness.
  material.roughness = THREE.MathUtils.clamp(finish.roughness / 0.34, 0.15, 2.4);
  material.metalness = finish.metalness;
  material.envMapIntensity = finish.envMapIntensity;
  const physical = material as THREE.MeshPhysicalMaterial;
  if (physical.isMeshPhysicalMaterial) {
    physical.clearcoat = finish.clearcoat;
    physical.clearcoatRoughness = finish.clearcoatRoughness;
    physical.sheen = finish.sheen;
    physical.sheenRoughness = finish.sheenRoughness;
    physical.sheenColor.copy(finish.sheenColor);
  }
  material.needsUpdate = true;
}
