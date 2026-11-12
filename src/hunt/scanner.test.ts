import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyBlockName,
  RegionScanner,
  recordBlock,
  scanChunk,
  scanChunkFully,
  sweepStorage,
  type BlockReader,
} from "./scanner.ts";
import { containerCount, emptyEvidence, totalStorage } from "./scoring.ts";

test("block names map to the right evidence field", () => {
  assert.equal(classifyBlockName("chest"), "chests");
  assert.equal(classifyBlockName("trapped_chest"), "trappedChests");
  assert.equal(classifyBlockName("barrel"), "barrels");
  assert.equal(classifyBlockName("white_shulker_box"), "shulkerBoxes");
  assert.equal(classifyBlockName("shulker_box"), "shulkerBoxes");
  assert.equal(classifyBlockName("ender_chest"), "enderChests");
  assert.equal(classifyBlockName("blast_furnace"), "furnaces");
  assert.equal(classifyBlockName("hopper"), "hoppers");
  assert.equal(classifyBlockName("dropper"), "dispensers");
  assert.equal(classifyBlockName("spawner"), "spawners");
  assert.equal(classifyBlockName("beacon"), "beaconLike");
  assert.equal(classifyBlockName("stone"), null);
  assert.equal(classifyBlockName(""), null);
});

test("recordBlock tallies recognised blocks only", () => {
  const e = emptyEvidence();
  assert.ok(recordBlock(e, "chest"));
  assert.ok(recordBlock(e, "chest"));
  assert.ok(!recordBlock(e, "dirt"));
  assert.equal(e.chests, 2);
});

/** A reader backed by a sparse map of "x,y,z" -> block name. */
function mapReader(blocks: Record<string, string>): BlockReader {
  return {
    blockName(x, y, z) {
      return blocks[`${x},${y},${z}`] ?? "air";
    },
  };
}

test("scanChunkFully finds storage placed in a chunk", () => {
  const reader = mapReader({
    "0,64,0": "chest",
    "1,64,0": "chest",
    "2,64,0": "barrel",
    "3,64,0": "white_shulker_box",
  });
  const e = scanChunkFully(reader, 0, 0, { yMin: 64, yMax: 64, yStep: 1, step: 1 });
  assert.equal(e.chests, 2);
  assert.equal(e.barrels, 1);
  assert.equal(e.shulkerBoxes, 1);
  assert.equal(containerCount(e), 4);
});

test("scanChunk honours its budget and resumes", () => {
  const blocks: Record<string, string> = {};
  for (let i = 0; i < 16; i++) blocks[`${i},64,0`] = i % 2 === 0 ? "chest" : "air";
  const reader = mapReader(blocks);
  const bounds = { yMin: 64, yMax: 64, yStep: 1, step: 1 };

  // First pass: a tiny budget scans only part of the chunk.
  const first = scanChunk(reader, 0, 0, 10, 0, bounds);
  assert.equal(first.result.scanned, 10);
  assert.equal(first.result.done, false);
  assert.ok(first.cursor > 0);

  // Second pass continues from the cursor with enough budget to finish.
  const second = scanChunk(reader, 0, 0, 500, first.cursor, bounds, first.result.evidence);
  assert.equal(second.result.done, true);
  assert.equal(second.result.evidence.chests, 8);
});

test("RegionScanner walks a square of chunks under a budget", () => {
  const blocks: Record<string, string> = { "0,64,0": "chest", "16,64,0": "chest", "0,64,16": "chest" };
  const reader = mapReader(blocks);
  const scanner = new RegionScanner(reader, 0, 0, 1, { yMin: 64, yMax: 64, yStep: 1, step: 1 });
  assert.equal(scanner.totalChunks, 9);

  // Step with a small budget repeatedly until done.
  let guard = 0;
  while (!scanner.done && guard++ < 1000) scanner.step(5);
  assert.ok(scanner.done);
  assert.equal(containerCount(scanner.result()), 3);
  assert.equal(scanner.chunksDone, 9);
});

test("totalStorage counts utility blocks too", () => {
  const e = emptyEvidence();
  e.chests = 2;
  e.furnaces = 3;
  assert.equal(totalStorage(e), 5);
});

test("sweepStorage uses findBlocks and keeps only storage inside the box", () => {
  const found = [
    { x: 8, y: 64, z: 8, name: "chest" },
    { x: 9, y: 64, z: 8, name: "barrel" },
    { x: 8, y: 64, z: 9, name: "white_shulker_box" },
    { x: 8, y: 300, z: 8, name: "chest" }, // far above: outside the vertical box
    { x: 400, y: 64, z: 8, name: "chest" }, // far away: outside the horizontal box
  ];
  const bot = {
    entity: { position: { x: 8, y: 64, z: 8 } },
    findBlocks(options: { matching: (b: { name?: string } | null) => boolean }) {
      // Only blocks whose name the matcher accepts are returned, mirroring mineflayer.
      return found.filter((b) => options.matching(b));
    },
    blockAt(pos: { x: number; y: number; z: number }) {
      return found.find((b) => b.x === pos.x && b.y === pos.y && b.z === pos.z) ?? null;
    },
  };
  const result = sweepStorage(bot as never, { verticalRadius: 32, radiusChunks: 2 });
  assert.ok(result);
  assert.equal(result.centreChunk.x, 0);
  assert.equal(result.centreChunk.z, 0);
  assert.equal(result.evidence.chests, 1);
  assert.equal(result.evidence.barrels, 1);
  assert.equal(result.evidence.shulkerBoxes, 1);
  assert.equal(containerCount(result.evidence), 3);
});

test("sweepStorage returns null when findBlocks is unavailable", () => {
  const bot = { entity: { position: { x: 0, y: 64, z: 0 } } };
  assert.equal(sweepStorage(bot as never, { verticalRadius: 32, radiusChunks: 1 }), null);
});
