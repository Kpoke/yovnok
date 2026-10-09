/**
 * Repair crate visuals (DESIGN.md §4.3, §11).
 *
 * The crate is the most important object on the map, so it has to be findable
 * from a moving car at distance and its state readable at a glance: ready means
 * go here, spent means somebody has already been here.
 *
 * Since M11 the list is not fixed: wreck **salvage** appears where a car died and
 * disappears when it is used or times out. So this syncs meshes against the
 * snapshot by id — adding, updating and removing — rather than indexing a fixed
 * array. Salvage is drawn in rust rather than green, because "temporary, and
 * somebody just died here" is different information from "permanent crate".
 *
 * Position and state are the server's; this only draws them.
 */

import * as THREE from 'three';
import { PALETTE } from '../shared/config';
import { terrainHeightAt } from '../shared/arena';
import type { RepairCrateSnapshot } from '../shared/protocol';

const READY_COLOUR = 0x6fd08c;
const SPENT_COLOUR = 0x373d45;
const SALVAGE_READY = 0xffb347;
const SALVAGE_SPENT = 0x4a3a30;

export type CrateRig = {
  group: THREE.Group;
  update(crates: RepairCrateSnapshot[]): void;
  dispose(): void;
};

/**
 * Two complete material sets, swapped wholesale.
 *
 * Swapping the reference is cheaper than mutating colours per crate per frame,
 * and it makes "ready" and "spent" impossible to half-apply — a crate is one
 * thing or the other.
 */
function makeSet(body: number, lid: number, marker: number, lit: boolean) {
  const standard = (color: number) =>
    new THREE.MeshStandardMaterial({ color, roughness: 0.7, metalness: 0.15, flatShading: true });

  const materials = {
    body: standard(body),
    lid: standard(lid),
    marker: new THREE.MeshStandardMaterial({
      color: marker,
      roughness: 0.4,
      metalness: 0.1,
      emissive: lit ? marker : 0x000000,
      emissiveIntensity: lit ? 0.6 : 0,
      flatShading: true,
    }),
  };
  return {
    materials,
    dispose: () => {
      materials.body.dispose();
      materials.lid.dispose();
      materials.marker.dispose();
    },
  };
}

type BuiltCrate = {
  root: THREE.Group;
  salvage: boolean;
  body: THREE.Mesh;
  lid: THREE.Mesh;
  marker: THREE.Mesh;
};

export function buildCrates(): CrateRig {
  const group = new THREE.Group();
  group.name = 'crates';

  const staticReady = makeSet(PALETTE.block, PALETTE.pad, READY_COLOUR, true);
  const staticSpent = makeSet(SPENT_COLOUR, SPENT_COLOUR, SPENT_COLOUR, false);
  const salvageReady = makeSet(0x6b4a35, 0x8a5a3a, SALVAGE_READY, true);
  const salvageSpent = makeSet(SALVAGE_SPENT, SALVAGE_SPENT, SALVAGE_SPENT, false);

  const rigs = new Map<number, BuiltCrate>();

  const make = (crate: RepairCrateSnapshot): BuiltCrate => {
    const root = new THREE.Group();
    // Sit on whatever is underneath — the centre crate lives on the platform.
    const ground = terrainHeightAt(crate.x, crate.z, 40);
    root.position.set(crate.x, Number.isFinite(ground) ? ground : 0, crate.z);

    const piece = (w: number, h: number, d: number, x: number, y: number, z: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), staticReady.materials.body);
      mesh.position.set(x, y, z);
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      root.add(mesh);
      return mesh;
    };

    const built: BuiltCrate = {
      root,
      salvage: crate.salvage,
      body: piece(1.5, 0.9, 1.5, 0, 0.45, 0),
      lid: piece(1.2, 0.16, 1.2, 0, 0.98, 0),
      // A post that reads over cover, so a crate is findable from across the map.
      marker: piece(0.22, 1.5, 0.22, 0, 1.8, 0),
    };
    return built;
  };

  const update = (snapshot: RepairCrateSnapshot[]): void => {
    const seen = new Set<number>();

    for (const crate of snapshot) {
      seen.add(crate.id);
      let rig = rigs.get(crate.id);

      // A crate that changed kind (or is new) is rebuilt; ids are never reused
      // for a different kind, but this keeps the code honest if they ever are.
      if (!rig || rig.salvage !== crate.salvage) {
        if (rig) {
          group.remove(rig.root);
          rig.body.geometry.dispose();
          rig.lid.geometry.dispose();
          rig.marker.geometry.dispose();
        }
        rig = make(crate);
        group.add(rig.root);
        rigs.set(crate.id, rig);
      }

      const set = crate.salvage
        ? crate.ready
          ? salvageReady
          : salvageSpent
        : crate.ready
          ? staticReady
          : staticSpent;
      rig.body.material = set.materials.body;
      rig.lid.material = set.materials.lid;
      rig.marker.material = set.materials.marker;
    }

    for (const [id, rig] of [...rigs]) {
      if (seen.has(id)) continue;
      group.remove(rig.root);
      rig.body.geometry.dispose();
      rig.lid.geometry.dispose();
      rig.marker.geometry.dispose();
      rigs.delete(id);
    }
  };

  return {
    group,
    update,
    dispose: () => {
      for (const rig of rigs.values()) {
        rig.body.geometry.dispose();
        rig.lid.geometry.dispose();
        rig.marker.geometry.dispose();
      }
      rigs.clear();
      staticReady.dispose();
      staticSpent.dispose();
      salvageReady.dispose();
      salvageSpent.dispose();
    },
  };
}
