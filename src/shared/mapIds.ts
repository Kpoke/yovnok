/**
 * Map ids. Kept free of any import so the protocol and the page can name a map
 * without pulling in its geometry.
 */
export const MAP_IDS = ['stadium', 'canyon', 'dockyard', 'snowbase', 'quarry', 'forest'] as const;
export type MapId = (typeof MAP_IDS)[number];
export const DEFAULT_MAP: MapId = 'stadium';

export function isMapId(value: unknown): value is MapId {
  return typeof value === 'string' && (MAP_IDS as readonly string[]).includes(value);
}
