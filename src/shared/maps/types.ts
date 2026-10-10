import type { Solid } from '../arena';
import type { LIGHTING_PRESETS } from '../config';
import type { MapId } from '../mapIds';

/** One arena: its shape (shared by server and client) and its time of day. */
export type ArenaMap = {
  id: MapId;
  name: string;
  /** One line for the map picker. */
  blurb: string;
  lighting: keyof typeof LIGHTING_PRESETS;
  /** Tyre grip on this map's ground (1 = dry tarmac and concrete). */
  grip: number;
  solids: Solid[];
  /** Repair crate positions. */
  crates: ReadonlyArray<{ x: number; z: number }>;
};
