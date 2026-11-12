/**
 * Reads loaded chunks and turns block names into stash {@link StashEvidence}.
 *
 * Scanning is deliberately budgeted and resumable: the controller hands this a block budget per call, so a
 * large sweep is spread across ticks and can be cancelled, rather than freezing the client on one huge loop.
 * The reader is abstracted behind {@link BlockReader} so the tallying logic is testable without a live world.
 */

import type { Bot } from "mineflayer";
import { emptyEvidence, type StashEvidence } from "./scoring.ts";

/** Returns the block name at a coordinate, or `null` when the position is not loaded. */
export interface BlockReader {
  blockName(x: number, y: number, z: number): string | null;
}

/** The evidence fields a block can contribute to. */
export type EvidenceKey =
  | "chests"
  | "trappedChests"
  | "barrels"
  | "shulkerBoxes"
  | "enderChests"
  | "furnaces"
  | "hoppers"
  | "dispensers"
  | "spawners"
  | "beaconLike";

const CATEGORY: Record<string, EvidenceKey> = {
  chest: "chests",
  trapped_chest: "trappedChests",
  barrel: "barrels",
  ender_chest: "enderChests",
  furnace: "furnaces",
  blast_furnace: "furnaces",
  smoker: "furnaces",
  hopper: "hoppers",
  dispenser: "dispensers",
  dropper: "dispensers",
  spawner: "spawners",
  mob_spawner: "spawners",
  beacon: "beaconLike",
};

/** Which evidence field a block name contributes to, or `null` for anything that is not storage. */
export function classifyBlockName(name: string): EvidenceKey | null {
  if (!name) return null;
  if (name === "shulker_box" || name.endsWith("_shulker_box")) return "shulkerBoxes";
  return CATEGORY[name] ?? null;
}

/** Adds one block's contribution to the evidence tally. */
export function recordBlock(evidence: StashEvidence, name: string): boolean {
  const key = classifyBlockName(name);
  if (!key) return false;
  evidence[key] += 1;
  return true;
}

export interface ScanBounds {
  yMin: number;
  yMax: number;
  /** Vertical step; 1 scans every layer. */
  yStep: number;
  /** Horizontal step; 1 scans every column. */
  step: number;
}

export const DEFAULT_BOUNDS: ScanBounds = { yMin: -64, yMax: 320, yStep: 1, step: 1 };

export interface ChunkScanResult {
  evidence: StashEvidence;
  /** Blocks actually inspected (including air), for budgeting. */
  scanned: number;
  done: boolean;
}

/**
 * Scans a single chunk column-by-column under a block budget, resuming from `cursor` on the next call.
 *
 * Returns `done: false` when the budget ran out mid-chunk, so the caller can call again with the returned
 * cursor to continue. The cursor is an opaque integer offset into the chunk's flattened block sequence.
 */
export function scanChunk(
  reader: BlockReader,
  chunkX: number,
  chunkZ: number,
  budget: number,
  cursor = 0,
  bounds: ScanBounds = DEFAULT_BOUNDS,
  evidence: StashEvidence = emptyEvidence(),
): { result: ChunkScanResult; cursor: number } {
  const baseX = chunkX * 16;
  const baseZ = chunkZ * 16;
  const layers: number[] = [];
  for (let y = bounds.yMin; y <= bounds.yMax; y += bounds.yStep) layers.push(y);

  const columnsPerChunk = Math.ceil(16 / bounds.step) * Math.ceil(16 / bounds.step);
  const perColumn = layers.length;
  const total = columnsPerChunk * perColumn;

  let index = cursor;
  let scanned = 0;

  while (index < total && scanned < budget) {
    const column = Math.floor(index / perColumn);
    const layer = index % perColumn;
    const cx = (column % Math.ceil(16 / bounds.step)) * bounds.step;
    const cz = Math.floor(column / Math.ceil(16 / bounds.step)) * bounds.step;
    const x = baseX + cx;
    const z = baseZ + cz;
    const y = layers[layer];

    const name = reader.blockName(x, y, z);
    if (name) recordBlock(evidence, name);

    index += 1;
    scanned += 1;
  }

  return {
    result: { evidence, scanned, done: index >= total },
    cursor: index,
  };
}

/** Scans one chunk to completion, ignoring the budget. Intended for tests and small sweeps. */
export function scanChunkFully(
  reader: BlockReader,
  chunkX: number,
  chunkZ: number,
  bounds: ScanBounds = DEFAULT_BOUNDS,
): StashEvidence {
  const evidence = emptyEvidence();
  let cursor = 0;
  for (;;) {
    const { result, cursor: next } = scanChunk(reader, chunkX, chunkZ, Number.MAX_SAFE_INTEGER, cursor, bounds, evidence);
    cursor = next;
    if (result.done) break;
  }
  return evidence;
}

/**
 * Walks a square of chunks around a centre, spending at most `budget` blocks per call and reporting whether
 * the whole region is finished. Chunks that are not loaded (the reader returns `null` for every block) are
 * still traversed cheaply, so the caller advances past them instead of stalling.
 */
export class RegionScanner {
  private readonly chunks: Array<{ x: number; z: number }> = [];
  private chunkIndex = 0;
  private cursor = 0;
  private readonly evidence = emptyEvidence();

  constructor(
    private readonly reader: BlockReader,
    centreChunkX: number,
    centreChunkZ: number,
    radiusChunks: number,
    private readonly bounds: ScanBounds = DEFAULT_BOUNDS,
  ) {
    const r = Math.max(0, Math.floor(radiusChunks));
    for (let dx = -r; dx <= r; dx++) {
      for (let dz = -r; dz <= r; dz++) {
        this.chunks.push({ x: centreChunkX + dx, z: centreChunkZ + dz });
      }
    }
  }

  get totalChunks(): number {
    return this.chunks.length;
  }

  get chunksDone(): number {
    return this.chunkIndex;
  }

  get done(): boolean {
    return this.chunkIndex >= this.chunks.length;
  }

  /** Spends up to `budget` block inspections, accumulating evidence. */
  step(budget: number): { scanned: number; done: boolean } {
    let scanned = 0;
    while (this.chunkIndex < this.chunks.length && scanned < budget) {
      const chunk = this.chunks[this.chunkIndex];
      const { result, cursor } = scanChunk(
        this.reader,
        chunk.x,
        chunk.z,
        budget - scanned,
        this.cursor,
        this.bounds,
        this.evidence,
      );
      scanned += result.scanned;
      this.cursor = cursor;
      if (result.done) {
        this.chunkIndex += 1;
        this.cursor = 0;
      }
    }
    return { scanned, done: this.done };
  }

  /** The evidence accumulated so far. */
  result(): StashEvidence {
    return this.evidence;
  }
}

/** Every block name that contributes to stash evidence, for a palette-based sweep. */
export const STORAGE_BLOCK_NAMES: string[] = [
  "chest",
  "trapped_chest",
  "barrel",
  "ender_chest",
  "furnace",
  "blast_furnace",
  "smoker",
  "hopper",
  "dispenser",
  "dropper",
  "spawner",
  "mob_spawner",
  "beacon",
  "shulker_box",
  ...["white", "orange", "magenta", "light_blue", "yellow", "lime", "pink", "gray", "light_gray", "cyan", "purple", "blue", "brown", "green", "red", "black"].map(
    (colour) => `${colour}_shulker_box`,
  ),
];

const STORAGE_BLOCK_SET = new Set(STORAGE_BLOCK_NAMES);

export interface BotScanBounds {
  /** Number of blocks above and below the bot to inspect. */
  verticalRadius: number;
  /** Radius of the centre chunk; the swept square is (2·radius + 1) chunks across. */
  radiusChunks: number;
}

/**
 * A single-pass storage sweep around the bot's current position, using mineflayer's `findBlocks`.
 *
 * `findBlocks` walks the world's section palettes and skips sections that contain none of the wanted blocks,
 * so this inspects a whole region far more cheaply than reading every coordinate. It returns its findings in
 * one synchronous call, which is why the caller must keep the radius modest. When `findBlocks` is unavailable
 * (or throws) this returns `null` so the caller can fall back to the budgeted per-block scanner.
 */
export function sweepStorage(
  bot: Bot,
  bounds: BotScanBounds,
): { evidence: StashEvidence; centreChunk: { x: number; z: number } } | null {
  const pos = bot.entity?.position;
  if (!pos || typeof bot.findBlocks !== "function") return null;

  const centreChunk = { x: Math.floor(pos.x / 16), z: Math.floor(pos.z / 16) };
  const centreX = centreChunk.x * 16 + 8;
  const centreZ = centreChunk.z * 16 + 8;
  const radius = bounds.radiusChunks * 16 + 8;

  let blocks: Array<{ x: number; y: number; z: number }>;
  try {
    blocks = bot.findBlocks({
      matching: (block: { name?: string } | null) => Boolean(block?.name && STORAGE_BLOCK_SET.has(block.name)),
      maxDistance: Math.round(Math.hypot(radius, bounds.verticalRadius, radius)),
      count: 4096,
    }) as Array<{ x: number; y: number; z: number }>;
  } catch {
    return null;
  }

  const evidence = emptyEvidence();
  for (const block of blocks) {
    // findBlocks uses a spherical distance; clamp back to the intended box so a tall column does not inflate
    // the swept area.
    if (Math.abs(block.y - pos.y) > bounds.verticalRadius) continue;
    if (Math.abs(block.x - centreX) > radius || Math.abs(block.z - centreZ) > radius) continue;
    let name: string | null = null;
    try {
      name = bot.blockAt(block as never)?.name ?? null;
    } catch {
      name = null;
    }
    if (name) recordBlock(evidence, name);
  }

  return { evidence, centreChunk };
}
