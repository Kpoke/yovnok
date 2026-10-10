/**
 * Arena set dressing: concrete road barriers, barrels, tyres and crates.
 *
 * The shared arena marks a few collision boxes as `prop` (see the checkpoints
 * in shared/arena.ts); this fills each one with real models, so what you see is
 * what you hit — a line of barriers end to end along the box, or a nest of
 * barrels, tyre stacks and a crate inside it. Models are Poly Haven CC0 props
 * (ASSETS.md), simplified at build time.
 *
 * INSTANCED: each prop model's meshes become one InstancedMesh each, holding
 * every copy in the arena — a handful of draw calls however many props there
 * are. If a model fails to load, the box is drawn plain instead: a collision
 * box must never be invisible.
 */

import * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import { SOLIDS, type Solid } from '../shared/arena';

type PropId = 'barrier' | 'barrel' | 'tyre' | 'crate';

const FILES: Record<PropId, string> = {
  barrier: '/assets/props/concrete_road_barrier/concrete_road_barrier_1k.glb',
  barrel: '/assets/props/Barrel_01/Barrel_01_1k.glb',
  tyre: '/assets/props/old_tyre/old_tyre_1k.glb',
  crate: '/assets/props/wooden_crate_01/wooden_crate_01_1k.glb',
};

/** A loaded prop: its meshes baked into one frame, and its bounds there. */
type Model = { parts: Array<{ geometry: THREE.BufferGeometry; material: THREE.Material }>; box: THREE.Box3 };

/** One placement: where, which way, how big. */
type Place = { x: number; y: number; z: number; yaw: number };

/** Stable pseudo-random from a position, so the layout is the same every load. */
const hash = (x: number, z: number, salt: number): number => {
  const v = Math.sin(x * 12.9898 + z * 78.233 + salt * 37.719) * 43758.5453;
  return v - Math.floor(v);
};

/**
 * Per-model fix-ups. The tyre is authored standing on its tread; stacked tyres
 * lie flat, so its thinnest axis is turned vertical. The crate is a small
 * fruit-box; scaled up it reads as an ammo crate at a checkpoint.
 */
const FIXUPS: Partial<Record<PropId, { layFlat?: boolean; scale?: number }>> = {
  tyre: { layFlat: true },
  crate: { scale: 1.7 },
};

async function loadModel(loader: GLTFLoader, url: string, fix: { layFlat?: boolean; scale?: number } = {}): Promise<Model> {
  const gltf = await loader.loadAsync(url);
  // The highest-detail LOD; the props are small and few enough to afford it.
  const root = gltf.scene.getObjectByName('lod0') ?? gltf.scene;
  root.updateWorldMatrix(true, true);
  const inverse = new THREE.Matrix4().copy(root.matrixWorld).invert();
  const parts: Model['parts'] = [];
  const box = new THREE.Box3();
  root.traverse((object) => {
    const mesh = object as THREE.Mesh;
    if (!mesh.isMesh) return;
    const geometry = mesh.geometry.clone().applyMatrix4(new THREE.Matrix4().multiplyMatrices(inverse, mesh.matrixWorld));
    geometry.computeBoundingBox();
    box.union(geometry.boundingBox!);
    parts.push({ geometry, material: mesh.material as THREE.Material });
  });
  if (fix.layFlat || fix.scale) {
    const size = box.getSize(new THREE.Vector3());
    const turn = new THREE.Matrix4();
    if (fix.layFlat && size.z <= size.x && size.z < size.y) turn.makeRotationX(Math.PI / 2);
    else if (fix.layFlat && size.x < size.y) turn.makeRotationZ(Math.PI / 2);
    if (fix.scale) turn.premultiply(new THREE.Matrix4().makeScale(fix.scale, fix.scale, fix.scale));
    box.makeEmpty();
    for (const part of parts) {
      part.geometry.applyMatrix4(turn);
      part.geometry.computeBoundingBox();
      box.union(part.geometry.boundingBox!);
    }
  }
  return { parts, box };
}

/** Lay barriers end to end along the box's long axis. */
function barrierPlaces(solid: Solid, model: Model): Place[] {
  const size = model.box.getSize(new THREE.Vector3());
  // The model's own long axis (x or z), so it can be turned to match the line.
  const modelAlongX = size.x >= size.z;
  const modelLength = Math.max(size.x, size.z);
  const sx = solid.max.x - solid.min.x;
  const sz = solid.max.z - solid.min.z;
  const lineAlongX = sx >= sz;
  const length = lineAlongX ? sx : sz;
  const count = Math.max(1, Math.round(length / modelLength));
  const step = length / count;
  const yaw = modelAlongX === lineAlongX ? 0 : Math.PI / 2;
  const out: Place[] = [];
  for (let i = 0; i < count; i++) {
    const t = (i + 0.5) * step;
    const flip = hash(solid.min.x + i, solid.min.z, 1) < 0.5 ? 0 : Math.PI;
    out.push({
      x: lineAlongX ? solid.min.x + t : (solid.min.x + solid.max.x) / 2,
      y: solid.min.y,
      z: lineAlongX ? (solid.min.z + solid.max.z) / 2 : solid.min.z + t,
      yaw: yaw + flip + (hash(solid.min.x, solid.min.z + i, 2) - 0.5) * 0.06,
    });
  }
  return out;
}

/**
 * A nest, laid out in the box's own frame (u along its long side, v across),
 * proportionally, so it fits any footprint: five barrels, three tyre stacks
 * and two crates.
 */
function nestPlaces(solid: Solid): Record<Exclude<PropId, 'barrier'>, Place[]> {
  const sx = solid.max.x - solid.min.x;
  const sz = solid.max.z - solid.min.z;
  const alongX = sx >= sz;
  const at = (u: number, v: number): { x: number; z: number } => {
    const U = u * (alongX ? sx : sz);
    const V = v * (alongX ? sz : sx);
    return alongX ? { x: solid.min.x + U, z: solid.min.z + V } : { x: solid.min.x + V, z: solid.min.z + U };
  };
  const h = (salt: number): number => hash(solid.min.x, solid.min.z, salt);
  const y = solid.min.y;
  const barrels: Place[] = [
    { ...at(0.1, 0.2), y, yaw: h(3) * 6.28 },
    { ...at(0.26, 0.18), y, yaw: h(4) * 6.28 },
    { ...at(0.12, 0.5), y, yaw: h(5) * 6.28 },
    { ...at(0.28, 0.48), y, yaw: h(6) * 6.28 },
    { ...at(0.15, 0.8), y, yaw: h(7) * 6.28 },
  ];
  const tyres: Place[] = [];
  for (const [u, v, n] of [
    [0.86, 0.2, 4],
    [0.86, 0.55, 3],
    [0.68, 0.82, 2],
  ] as const) {
    for (let k = 0; k < n; k++) tyres.push({ ...at(u, v), y: y + k * 0.17, yaw: h(10 + k + u * 7) * 6.28 });
  }
  const crates: Place[] = [
    { ...at(0.52, 0.32), y, yaw: (h(20) - 0.5) * 0.4 },
    { ...at(0.5, 0.68), y, yaw: (h(22) - 0.5) * 0.4 },
  ];
  return { barrel: barrels, tyre: tyres, crate: crates };
}

/** Prop models, downloaded once and shared by every map that uses them. */
const modelCache = new Map<PropId, Promise<Model | null>>();

/** Download the prop models (once). */
export function loadPropModels(loader: GLTFLoader): Promise<Map<PropId, Model>> {
  return Promise.all(
    (Object.keys(FILES) as PropId[]).map(async (id) => {
      let pending = modelCache.get(id);
      if (!pending) {
        pending = loadModel(loader, FILES[id], FIXUPS[id]).catch((error) => {
          console.warn(`[props] ${id} failed to load; drawing its boxes plain`, error);
          return null;
        });
        modelCache.set(id, pending);
      }
      return [id, await pending] as const;
    }),
  ).then((entries) => new Map(entries.filter((e): e is readonly [PropId, Model] => e[1] !== null)));
}

/** Prop meshes for every `prop` solid in the arena. */
export async function buildProps(loader: GLTFLoader): Promise<THREE.Group> {
  const group = new THREE.Group();
  group.name = 'props';
  const solids = SOLIDS.filter((s) => s.prop);
  if (solids.length === 0) return group;
  const models = await loadPropModels(loader);

  const places = new Map<PropId, Place[]>();
  const push = (id: PropId, list: Place[]): void => {
    places.set(id, [...(places.get(id) ?? []), ...list]);
  };
  const plain: Solid[] = [];
  for (const solid of solids) {
    if (solid.prop === 'barriers') {
      const model = models.get('barrier');
      if (model) push('barrier', barrierPlaces(solid, model));
      else plain.push(solid);
    } else if (solid.prop === 'nest') {
      if (!models.has('barrel') || !models.has('tyre') || !models.has('crate')) {
        plain.push(solid);
        continue;
      }
      const nest = nestPlaces(solid);
      push('barrel', nest.barrel);
      push('tyre', nest.tyre);
      push('crate', nest.crate);
    }
  }

  // One InstancedMesh per model part, holding every placement of that model.
  const matrix = new THREE.Matrix4();
  const q = new THREE.Quaternion();
  const e = new THREE.Euler(0, 0, 0, 'YXZ');
  const one = new THREE.Vector3(1, 1, 1);
  for (const [id, list] of places) {
    const model = models.get(id)!;
    // Stand the model on its base: its lowest point at the placement's y.
    const lift = -model.box.min.y;
    const centre = model.box.getCenter(new THREE.Vector3());
    for (const part of model.parts) {
      const mesh = new THREE.InstancedMesh(part.geometry, part.material, list.length);
      list.forEach((p, i) => {
        e.set(0, p.yaw, 0);
        q.setFromEuler(e);
        // Centre the model's footprint on the placement point.
        const offset = new THREE.Vector3(-centre.x, lift, -centre.z).applyQuaternion(q);
        matrix.compose(new THREE.Vector3(p.x + offset.x, p.y + offset.y, p.z + offset.z), q, one);
        mesh.setMatrixAt(i, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      mesh.name = `prop:${id}`;
      group.add(mesh);
    }
  }

  // Fallback: plain concrete boxes for anything whose model did not load.
  for (const solid of plain) {
    const size = new THREE.Vector3().subVectors(solid.max as THREE.Vector3, solid.min as THREE.Vector3);
    const box = new THREE.Mesh(new THREE.BoxGeometry(size.x, size.y, size.z), new THREE.MeshStandardMaterial({ color: 0x8a8580 }));
    box.position.set((solid.min.x + solid.max.x) / 2, (solid.min.y + solid.max.y) / 2, (solid.min.z + solid.max.z) / 2);
    box.castShadow = true;
    box.receiveShadow = true;
    group.add(box);
  }
  return group;
}
