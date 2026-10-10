/**
 * The scene's map: builds the active map's arena and scenery, its materials and
 * its time of day, and swaps maps when the match moves to another one.
 *
 * Downloads (materials, the HDRI, scenery models) are cached, and `prefetch`
 * starts them early — the server names the next map at the end of a match, so
 * the switch at the next countdown is usually instant.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { MAPS, useMap } from '../shared/arena';
import { LIGHTING_PRESETS } from '../shared/config';
import type { MapId } from '../shared/mapIds';
import { applyArenaSurfaces, loadMaterial, materialsOf, setSurfaces } from './arenaSurfaces';
import { buildArena } from './buildArena';
import type { Lighting } from './lighting';
import { THEMES, type Dressing, type WorldEvent } from './maps/themes';
import { buildSky, setSky } from './sky';

export class World {
  /** Everything of the current map. Stays the same object across switches. */
  readonly group = new THREE.Group();
  private readonly sky = buildSky();
  /** The map on screen, and the one being built. */
  mapId: MapId | null = null;
  private building: MapId | null = null;
  private generation = 0;
  /** The current map's scenery hooks. */
  private dressing: Dressing[] = [];
  /** Called once a map is on screen (crates, skid marks… reset). */
  onShown: ((id: MapId) => void) | null = null;

  constructor(
    private readonly scene: THREE.Scene,
    private readonly lighting: Lighting,
    private readonly loader: GLTFLoader,
  ) {
    this.group.name = 'world';
    scene.add(this.sky, this.group);
  }

  /** True while a map change is still loading. */
  get loading(): boolean {
    return this.building !== null;
  }

  /** Per frame: animate the scenery (crowd, screens, weather). */
  update(dt: number, view: THREE.Vector3): void {
    for (const d of this.dressing) d.update?.(dt, view);
  }

  /** A kill or a blast: the scenery reacts (cheers, pyro, the big screen). */
  react(event: WorldEvent): void {
    for (const d of this.dressing) d.react?.(event);
  }

  /** Start a map's downloads without showing it. */
  prefetch(id: MapId): Promise<unknown> {
    const map = MAPS[id];
    const theme = THEMES[id];
    return Promise.all([
      ...materialsOf(theme.surfaces, theme.containers, new Set(map.solids.map((s) => s.color))).map((m) =>
        loadMaterial(m, this.loader),
      ),
      this.lighting.loadEnvironment(LIGHTING_PRESETS[map.lighting]),
    ]);
  }

  /** Show a map (resolves once it is on screen). A newer call wins. */
  async show(id: MapId): Promise<void> {
    if (id === this.mapId && this.building === null) return;
    if (id === this.building) return;
    const generation = ++this.generation;
    this.building = id;
    const map = MAPS[id];
    const theme = THEMES[id];
    const preset = LIGHTING_PRESETS[map.lighting];
    await this.prefetch(id);
    if (generation !== this.generation) return;

    // Builders read the active map's solids and surfaces.
    useMap(id);
    setSurfaces(theme.surfaces);
    const arena = buildArena({ containers: theme.containers, skip: new Set(theme.skip ?? []) });
    const [dressing] = await Promise.all([theme.dressing(this.loader), applyArenaSurfaces(arena, this.loader)]);
    const objects = dressing.flatMap((d) => d.objects);
    if (generation !== this.generation) {
      dispose(arena);
      for (const o of objects) dispose(o);
      return;
    }
    // The dressing may also carry arena surfaces (stands, barriers).
    const holder = new THREE.Group();
    holder.add(...objects);
    await applyArenaSurfaces(holder, this.loader);
    if (generation !== this.generation) return;

    // Swap.
    for (const child of [...this.group.children]) {
      this.group.remove(child);
      dispose(child);
    }
    this.group.add(arena, ...objects);
    this.dressing = dressing;
    useMap(id);
    setSurfaces(theme.surfaces);
    this.lighting.applyPreset(preset);
    setSky(this.sky, preset);
    this.scene.background = new THREE.Color(preset.sky.background);
    this.scene.fog = new THREE.Fog(preset.sky.fog, preset.sky.fogNear, preset.sky.fogFar);
    this.mapId = id;
    this.building = null;
    this.onShown?.(id);
  }
}

/** Free a subtree's geometry and materials (textures are shared and cached). */
function dispose(root: THREE.Object3D): void {
  root.traverse((o) => {
    const mesh = o as THREE.Mesh;
    if (!mesh.isMesh && !(o as THREE.Points).isPoints) return;
    mesh.geometry?.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const m of materials) m?.dispose();
  });
}
