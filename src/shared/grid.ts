/**
 * A uniform spatial hash (DESIGN.md §13.5).
 *
 * The first thing that does not scale in a room is asking "what is near this
 * point?" by scanning everything. At two crews that is free; at thirty it is
 * O(n) work per query, every tick, for interest management, repairs and hit
 * broadphase. A uniform grid turns "near" into "the cells that overlap a box".
 *
 * DELIBERATELY PLAIN. It rebuilds from scratch each use rather than supporting
 * removal, because a room's entities move every tick and a rebuild is both
 * simpler and faster than tracking movement. Cell size wants to be roughly the
 * query radius: too small and a query walks many cells, too large and every
 * cell holds everything.
 *
 * Shared, but not part of the deterministic simulation: it is an index over
 * state, never a source of it, so the client and server need not agree on it.
 */

/** Half the coordinate range an integer cell key can hold, in cells. */
const KEY_OFFSET = 1 << 15;

export class SpatialGrid<T> {
  private readonly cellSize: number;
  private readonly cells = new Map<number, Array<{ x: number; z: number; value: T }>>();

  constructor(cellSize = 48) {
    this.cellSize = Math.max(1, cellSize);
  }

  clear(): void {
    this.cells.clear();
  }

  insert(x: number, z: number, value: T): void {
    const key = this.key(x, z);
    const bucket = this.cells.get(key);
    if (bucket) bucket.push({ x, z, value });
    else this.cells.set(key, [{ x, z, value }]);
  }

  /** Everything within `radius` of (x, z). Callers still filter by type. */
  queryRadius(x: number, z: number, radius: number, out: T[] = []): T[] {
    out.length = 0;
    const r2 = radius * radius;
    const minX = Math.floor((x - radius) / this.cellSize);
    const maxX = Math.floor((x + radius) / this.cellSize);
    const minZ = Math.floor((z - radius) / this.cellSize);
    const maxZ = Math.floor((z + radius) / this.cellSize);

    for (let cx = minX; cx <= maxX; cx++) {
      for (let cz = minZ; cz <= maxZ; cz++) {
        const bucket = this.cells.get(this.cellKey(cx, cz));
        if (!bucket) continue;
        for (const item of bucket) {
          const dx = item.x - x;
          const dz = item.z - z;
          if (dx * dx + dz * dz <= r2) out.push(item.value);
        }
      }
    }
    return out;
  }

  private key(x: number, z: number): number {
    return this.cellKey(Math.floor(x / this.cellSize), Math.floor(z / this.cellSize));
  }

  /**
   * Pack two cell indices into one integer key. Offsets keep negative cells
   * positive, and the range is far wider than any arena, so this cannot collide
   * in practice. Using a number rather than a string keeps the hot path off the
   * allocation-heavy Map-of-strings.
   */
  private cellKey(cx: number, cz: number): number {
    return (cx + KEY_OFFSET) * (KEY_OFFSET * 2) + (cz + KEY_OFFSET);
  }
}
