/** Every map, by id. */

import type { MapId } from '../mapIds';
import { STADIUM } from './stadium';
import type { ArenaMap } from './types';

export type { ArenaMap } from './types';

export const MAPS: Record<MapId, ArenaMap> = {
  stadium: STADIUM,
};
