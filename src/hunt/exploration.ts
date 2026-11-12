/**
 * Exploration intelligence: which chunks have been covered, which waypoints are still pending, and where to
 * fly next. Pure and clock-free so the coverage/expansion rules are testable.
 *
 * Two failure modes this guards against: re-flying over the same empty territory (wasted elytra), and an
 * unbounded record of visited chunks slowly eating memory over a long session.
 */

export interface ChunkPos {
  x: number;
  z: number;
}

/**
 * Packs chunk coordinates into a stable key.
 *
 * JavaScript numbers only hold 53 bits exactly, so two full 32-bit chunk coordinates cannot be packed into
 * one number without collisions at the world edge. A string key is exact for every coordinate and still fast
 * enough for a `Set` lookup.
 */
export function packChunkKey(x: number, z: number): string {
  return `${x},${z}`;
}

/** The x component of a packed chunk key. */
export function chunkKeyX(key: string): number {
  return Number(key.slice(0, key.indexOf(",")));
}

/** The z component of a packed chunk key. */
export function chunkKeyZ(key: string): number {
  return Number(key.slice(key.indexOf(",") + 1));
}

export type ExplorationMode = "grid" | "spiral" | "adaptive" | "direction" | "waypoints";

/** Builds a square grid of chunk waypoints centred on `centre`, `spacing` chunks apart. */
export function gridRoute(centre: ChunkPos, spacing: number, halfCount: number): ChunkPos[] {
  const step = Math.max(1, Math.floor(spacing));
  const n = Math.max(1, Math.floor(halfCount));
  const out: ChunkPos[] = [];
  for (let i = -n; i <= n; i++) {
    for (let j = -n; j <= n; j++) {
      out.push({ x: centre.x + i * step, z: centre.z + j * step });
    }
  }
  return out;
}

/** Builds an outward spiral of chunk waypoints centred on `centre`, `spacing` chunks apart. */
export function spiralRoute(centre: ChunkPos, spacing: number, halfCount: number): ChunkPos[] {
  const step = Math.max(1, Math.floor(spacing));
  const n = Math.max(1, Math.floor(halfCount));
  const out: ChunkPos[] = [{ x: centre.x, z: centre.z }];
  let x = 0;
  let z = 0;
  let dx = 0;
  let dz = -1;

  // Walk a growing square ring; `side` controls how far each leg runs before turning.
  for (let i = 0; i < (2 * n + 1) * (2 * n + 1) - 1; i++) {
    if (x === z || (x < 0 && x === -z) || (x > 0 && x === 1 - z)) {
      const tmp = dx;
      dx = -dz;
      dz = tmp;
    }
    x += dx;
    z += dz;
    if (Math.abs(x) <= n && Math.abs(z) <= n) {
      out.push({ x: centre.x + x * step, z: centre.z + z * step });
    }
  }
  return out;
}

/** Builds a straight-line route of chunk waypoints from `centre` along a compass bearing. */
export function directionRoute(centre: ChunkPos, bearingDegrees: number, spacing: number, count: number): ChunkPos[] {
  const step = Math.max(1, Math.floor(spacing));
  const n = Math.max(1, Math.floor(count));
  const rad = (bearingDegrees * Math.PI) / 180;
  const dx = Math.sin(rad);
  const dz = -Math.cos(rad);
  const out: ChunkPos[] = [];
  for (let i = 1; i <= n; i++) {
    out.push({ x: centre.x + Math.round(dx * i * step), z: centre.z + Math.round(dz * i * step) });
  }
  return out;
}

export interface ExploredDatabaseOptions {
  /** Maximum number of visited chunks retained (oldest evicted first). */
  limit?: number;
  /** Initial visited keys, e.g. loaded from disk. */
  initial?: Iterable<string>;
}

/** A bounded, serialisable record of explored chunks and chunks needing another look. */
export class ExploredDatabase {
  private readonly limit: number;
  private readonly visited = new Set<string>();
  private readonly order: string[] = [];
  private readonly requiresReview = new Set<string>();

  constructor(opts: ExploredDatabaseOptions = {}) {
    this.limit = Math.max(1024, opts.limit ?? 250_000);
    if (opts.initial) this.restore(opts.initial);
  }

  wasExplored(x: number, z: number): boolean {
    return this.visited.has(packChunkKey(x, z));
  }

  markExplored(x: number, z: number): void {
    const key = packChunkKey(x, z);
    if (this.visited.has(key)) return;
    this.visited.add(key);
    this.order.push(key);
    while (this.order.length > this.limit) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.visited.delete(evicted);
    }
  }

  markRequiresReview(x: number, z: number): void {
    if (this.requiresReview.size >= this.limit) {
      const victim = this.requiresReview.values().next().value;
      if (victim !== undefined) this.requiresReview.delete(victim);
    }
    this.requiresReview.add(packChunkKey(x, z));
  }

  needsReview(x: number, z: number): boolean {
    return this.requiresReview.has(packChunkKey(x, z));
  }

  clearReview(x: number, z: number): void {
    this.requiresReview.delete(packChunkKey(x, z));
  }

  get exploredCount(): number {
    return this.visited.size;
  }

  get reviewCount(): number {
    return this.requiresReview.size;
  }

  restore(keys: Iterable<string>): void {
    for (const key of keys) {
      if (!this.visited.has(key)) {
        this.visited.add(key);
        this.order.push(key);
      }
    }
    while (this.order.length > this.limit) {
      const evicted = this.order.shift();
      if (evicted !== undefined) this.visited.delete(evicted);
    }
  }

  clear(): void {
    this.visited.clear();
    this.order.length = 0;
    this.requiresReview.clear();
  }

  /** Visited chunk keys, for persistence. */
  exploredKeys(): string[] {
    return [...this.visited];
  }

  /** Fraction of chunks within `radiusChunks` of a centre that have been explored, in `[0, 1]`. */
  coverageAround(centreX: number, centreZ: number, radiusChunks: number): number {
    const r = Math.max(1, Math.floor(radiusChunks));
    let total = 0;
    let seen = 0;
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        total += 1;
        if (this.visited.has(packChunkKey(centreX + dx, centreZ + dz))) seen += 1;
      }
    }
    return total === 0 ? 0 : seen / total;
  }
}

export interface ExplorationPlannerOptions {
  /** Route the planner cycles through. */
  route: ChunkPos[];
  db: ExploredDatabase;
  /** Distance (chunks) within which a waypoint counts as reached. */
  reachChunks?: number;
  /** Coverage below which a region is considered "still worth flying". */
  coverageTarget?: number;
}

/**
 * Walks a route of chunk waypoints, skipping ones already explored, and reports when a region is exhausted so
 * the controller can expand. A route is a plain list, so it is trivial to persist and resume.
 */
export class ExplorationPlanner {
  private readonly route: ChunkPos[];
  private readonly reachChunks: number;
  private readonly coverageTarget: number;
  private index = 0;

  constructor(private readonly opts: ExplorationPlannerOptions) {
    this.route = opts.route;
    this.reachChunks = Math.max(1, opts.reachChunks ?? 2);
    this.coverageTarget = Math.min(1, Math.max(0.1, opts.coverageTarget ?? 0.85));
  }

  /** Next unexplored waypoint, or `null` when the route is exhausted. */
  next(): ChunkPos | null {
    while (this.index < this.route.length) {
      const wp = this.route[this.index];
      if (!this.opts.db.wasExplored(wp.x, wp.z)) return wp;
      this.index += 1;
    }
    return null;
  }

  /** Records that the bot reached a waypoint, marking it (and its immediate neighbours) explored. */
  reached(wp: ChunkPos): void {
    this.opts.db.markExplored(wp.x, wp.z);
    this.index += 1;
  }

  /** True when the waypoint is close enough to count as reached. */
  isReached(wp: ChunkPos, botChunkX: number, botChunkZ: number): boolean {
    return Math.hypot(wp.x - botChunkX, wp.z - botChunkZ) <= this.reachChunks;
  }

  get position(): number {
    return this.index;
  }

  get total(): number {
    return this.route.length;
  }

  get exhausted(): boolean {
    return this.next() === null;
  }

  /** Whether the region around a centre has been covered enough to move on. */
  regionDone(centreX: number, centreZ: number, radiusChunks: number): boolean {
    return this.opts.db.coverageAround(centreX, centreZ, radiusChunks) >= this.coverageTarget;
  }

  /** Replace the route (e.g. after the controller decides to expand exploration). */
  reset(route: ChunkPos[]): void {
    this.route.length = 0;
    this.route.push(...route);
    this.index = 0;
  }
}
