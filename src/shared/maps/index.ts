/** Every map, by id. */

import type { MapId } from '../mapIds';
import { CANYON } from './canyon';
import { DOCKYARD } from './dockyard';
import { FOREST } from './forest';
import { QUARRY } from './quarry';
import { SNOWBASE } from './snowbase';
import { STADIUM } from './stadium';
import type { ArenaMap } from './types';

export type { ArenaMap } from './types';

export const MAPS: Record<MapId, ArenaMap> = {
  stadium: STADIUM,
  canyon: CANYON,
  dockyard: DOCKYARD,
  snowbase: SNOWBASE,
  quarry: QUARRY,
  forest: FOREST,
};
