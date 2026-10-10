import type { Solid } from './arena';

/** Highest top surface of any solid under a point (the ground there). */
export function terrainTop(solids: readonly Solid[], x: number, z: number): number {
  let best = 0;
  for (const s of solids) {
    if (x < s.min.x || x > s.max.x || z < s.min.z || z > s.max.z) continue;
    let top = s.max.y;
    if (s.kind === 'ramp') {
      const span = s.along === 'x' ? s.max.x - s.min.x : s.max.z - s.min.z;
      const t = span <= 1e-6 ? 0 : s.along === 'x' ? (x - s.min.x) / span : (z - s.min.z) / span;
      top = s.hStart! + (s.hEnd! - s.hStart!) * t;
    }
    if (top > best) best = top;
  }
  return best;
}
