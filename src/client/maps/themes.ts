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

export type MapTheme = {
  /** Materials by palette role, over the defaults (arenaSurfaces.SURFACES). */
  surfaces?: SurfaceTable;
  /** Draw cover blocks as stacks of shipping containers. */
  containers: boolean;
  /** Scenery: everything drawn beyond the solids themselves. */
  dressing: (loader: GLTFLoader) => Promise<THREE.Object3D[]>;
  weather: Weather;
};

export const THEMES: Record<MapId, MapTheme> = {
  stadium: {
    containers: true,
    dressing: async (loader) => [buildStadium(), await buildProps(loader)],
    weather: 'none',
  },
};
