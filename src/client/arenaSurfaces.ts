/**
 * What each part of the arena is MADE of.
 *
 * The shared arena (`shared/arena.ts`) describes shapes and tags them with a
 * palette colour; this maps each palette role to a real material — a CC0 Poly
 * Haven PBR set (see ASSETS.md), built to KTX2 by `npm run assetbuild` — and the
 * size, in metres, of one repeat of its texture. The shape data, collision and
 * gameplay never see any of this.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { PALETTE } from '../shared/config';
import { applyGroundBias } from './buildArena';

export type Surface = {
  /** Poly Haven id; the material lives in public/assets/materials/<id>/<id>_2k.glb. */
  material: string;
  /** Metres per texture repeat. Ground wants big repeats, a concrete block small. */
  tile: number;
  /** Optional colour multiplier, e.g. to make a hazard read as a hazard. */
  tint?: number;
  /** Multiply by per-vertex colour (container paint, one colour per box). */
  vertexColors?: boolean;
  /**
   * Dry, dull ground (mud, sand, gravel): uniformly rough, with softened normal
   * detail. Under a strong floodlight key the texture's fine roughness and
   * normal variation glittered like wet glass at grazing angles.
   */
  matte?: boolean;
};

/** Shipping containers (buildContainers.ts): galvanised corrugated metal, painted per box. */
export const CONTAINER_SURFACE: Surface = { material: 'corrugated_iron', tile: 7, vertexColors: true };

type PaletteRole = keyof typeof PALETTE;

/**
 * The look of each role. The stadium floor is worn concrete; the outfield goes
 * from dried mud to gravelly sand toward the rim; cover is cast concrete; ramps
 * are steel plate; the scrapyard crane is rusted metal.
 */
export const SURFACES: Partial<Record<PaletteRole, Surface>> = {
  zoneCentre: { material: 'concrete_floor_worn_001', tile: 7 },
  zoneDunes: { material: 'brown_mud_dry', tile: 9, matte: true },
  zoneScrapyard: { material: 'gravel_concrete', tile: 8, matte: true },
  zoneLakebed: { material: 'brown_mud_dry', tile: 12, tint: 0xd9cfc0, matte: true },
  zoneRim: { material: 'gravelly_sand', tile: 9, matte: true },
  road: { material: 'asphalt_02', tile: 6 },
  pad: { material: 'concrete_floor_painted', tile: 5 },
  block: { material: 'concrete_wall_008', tile: 4 },
  wall: { material: 'concrete_wall_007', tile: 5 },
  plateau: { material: 'concrete_wall_008', tile: 6, tint: 0xc9c2b8 },
  ramp: { material: 'metal_plate', tile: 3 },
  landmark: { material: 'rusty_metal_02', tile: 3 },
  hazard: { material: 'brown_mud_03', tile: 4, tint: 0xb07a5a, matte: true },
};

const byColour = new Map<number, Surface>();
for (const [role, surface] of Object.entries(SURFACES) as [PaletteRole, Surface][]) {
  byColour.set(PALETTE[role] as number, surface);
}

/** The surface for a solid's palette colour, or undefined to keep it flat-coloured. */
export function surfaceOf(colour: number): Surface | undefined {
  return byColour.get(colour);
}

/**
 * Load every material the arena uses and put them on its meshes. Meshes carry
 * `userData.surface` (set by `buildArena`); until this resolves they show their
 * flat palette colour, so a slow load never leaves holes in the map.
 */
export async function applyArenaSurfaces(arena: THREE.Object3D, loader: GLTFLoader): Promise<void> {
  const ids = [...new Set([...Object.values(SURFACES).map((s) => s!.material), CONTAINER_SURFACE.material])];
  const loaded = new Map<string, THREE.MeshStandardMaterial>();
  await Promise.all(
    ids.map(async (id) => {
      try {
        const gltf = await loader.loadAsync(`/assets/materials/${id}/${id}_2k.glb`);
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh;
          if (mesh.isMesh && !loaded.has(id)) loaded.set(id, mesh.material as THREE.MeshStandardMaterial);
        });
      } catch (error) {
        console.warn(`[arena] material ${id} failed to load; keeping flat colour`, error);
      }
    }),
  );

  // One material per (id, tint), shared by every mesh that uses it.
  const variants = new Map<string, THREE.MeshStandardMaterial>();
  arena.traverse((o) => {
    const mesh = o as THREE.Mesh;
    const surface = mesh.userData.surface as Surface | undefined;
    if (!mesh.isMesh || !surface) return;
    const base = loaded.get(surface.material);
    if (!base) return;
    const layer = (mesh.userData.groundLayer as number | undefined) ?? -1;
    const key = `${surface.material}:${surface.tint ?? ''}:${mesh.userData.doubleSided ? 2 : 1}:${layer}:${surface.vertexColors ? 'vc' : ''}:${surface.matte ? 'm' : ''}`;
    let material = variants.get(key);
    if (!material) {
      material = base.clone();
      for (const map of [material.map, material.normalMap, material.roughnessMap, material.metalnessMap, material.aoMap]) {
        if (!map) continue;
        // World-space UVs run well past 0..1: the texture must tile.
        map.wrapS = THREE.RepeatWrapping;
        map.wrapT = THREE.RepeatWrapping;
        map.anisotropy = 8;
        map.needsUpdate = true;
      }
      if (surface.tint !== undefined) material.color.multiply(new THREE.Color(surface.tint));
      if (mesh.userData.doubleSided) material.side = THREE.DoubleSide;
      if (surface.matte) {
        material.roughnessMap = null;
        material.roughness = 0.97;
        material.metalnessMap = null;
        material.metalness = 0;
        material.normalScale.set(0.55, 0.55);
      }
      if (surface.vertexColors) {
        // Painted steel: the paint is a dielectric coat over the metal, so the
        // texture's (bare, galvanised) metalness would turn every dark paint
        // black. Keep its roughness and normal detail, not its metalness.
        material.vertexColors = true;
        material.metalnessMap = null;
        material.metalness = 0.15;
      }
      applyGroundBias(material, layer);
      variants.set(key, material);
    }
    (mesh.material as THREE.Material).dispose();
    mesh.material = material;
  });
}
