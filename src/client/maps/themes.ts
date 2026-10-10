/**
 * How each map LOOKS: what its palette roles are made of, the scenery built
 * around and on it, and its weather. The shape (and its time of day) is shared
 * data in `shared/maps/`; none of this touches the simulation.
 */

import type * as THREE from 'three';
import type { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import type { MapId } from '../../shared/mapIds';
import type { SurfaceTable } from '../arenaSurfaces';
import { buildProps } from '../buildProps';
import { buildStadium } from '../buildStadium';

export type Weather = 'none' | 'dust' | 'rain' | 'snow' | 'mist';

/** Something happened in the arena that the scenery may react to. */
export type WorldEvent = { kind: 'kill' | 'blast'; x: number; z: number; label?: string };

/** A map's scenery: its objects, and optional per-frame and event hooks. */
export type Dressing = {
  objects: THREE.Object3D[];
  update?: (dt: number) => void;
  react?: (event: WorldEvent) => void;
};

export type MapTheme = {
  /** Materials by palette role, over the defaults (arenaSurfaces.SURFACES). */
  surfaces?: SurfaceTable;
  /** Draw cover blocks as stacks of shipping containers. */
  containers: boolean;
  /** Scenery: everything drawn beyond the solids themselves. */
  dressing: (loader: GLTFLoader) => Promise<Dressing[]>;
  weather: Weather;
};

export const THEMES: Record<MapId, MapTheme> = {
  stadium: {
    containers: true,
    dressing: async (loader) => [buildStadium(), { objects: [await buildProps(loader)] }],
    weather: 'none',
  },
};
