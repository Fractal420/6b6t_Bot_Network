import assert from "node:assert/strict";
import test from "node:test";
import {
  chunkKeyX,
  chunkKeyZ,
  directionRoute,
  ExploredDatabase,
  ExplorationPlanner,
  gridRoute,
  packChunkKey,
  spiralRoute,
} from "./exploration.ts";

test("chunk keys round-trip", () => {
  for (const [x, z] of [
    [0, 0],
    [-1, -1],
    [12345, -67890],
    [2147483647, -2147483648],
  ]) {
    const key = packChunkKey(x, z);
    assert.equal(chunkKeyX(key), x);
    assert.equal(chunkKeyZ(key), z);
  }
});

test("explored database tracks and de-duplicates", () => {
  const db = new ExploredDatabase();
  assert.ok(!db.wasExplored(3, 4));
  db.markExplored(3, 4);
  assert.ok(db.wasExplored(3, 4));
  assert.equal(db.exploredCount, 1);
  db.markExplored(3, 4);
  assert.equal(db.exploredCount, 1);
});

test("explored database evicts oldest beyond the cap", () => {
  const db = new ExploredDatabase({ limit: 1024 });
  for (let i = 0; i < 2000; i++) db.markExplored(i, 0);
  assert.equal(db.exploredCount, 1024);
  assert.ok(!db.wasExplored(0, 0));
  assert.ok(db.wasExplored(1999, 0));
});

test("review list is bounded and clearable", () => {
  const db = new ExploredDatabase();
  db.markRequiresReview(1, 1);
  assert.ok(db.needsReview(1, 1));
  db.clearReview(1, 1);
  assert.ok(!db.needsReview(1, 1));
});

test("coverage is fractional", () => {
  const db = new ExploredDatabase();
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) db.markExplored(dx, dz);
  assert.equal(db.coverageAround(0, 0, 1), 1);
  assert.equal(db.coverageAround(100, 100, 1), 0);
});

test("restore rebuilds the set", () => {
  const db = new ExploredDatabase({ initial: [packChunkKey(5, 6), packChunkKey(7, 8)] });
  assert.ok(db.wasExplored(5, 6));
  assert.ok(db.wasExplored(7, 8));
});

test("grid route is a full square", () => {
  const route = gridRoute({ x: 0, z: 0 }, 4, 1);
  assert.equal(route.length, 9);
  assert.ok(route.some((p) => p.x === -4 && p.z === -4));
  assert.ok(route.some((p) => p.x === 4 && p.z === 4));
});

test("spiral route starts at the centre and stays in bounds", () => {
  const route = spiralRoute({ x: 10, z: 10 }, 2, 2);
  assert.equal(route[0].x, 10);
  assert.equal(route[0].z, 10);
  for (const p of route) {
    assert.ok(Math.abs(p.x - 10) <= 4 && Math.abs(p.z - 10) <= 4);
  }
});

test("direction route walks a bearing", () => {
  const north = directionRoute({ x: 0, z: 0 }, 0, 10, 3);
  assert.deepEqual(north, [
    { x: 0, z: -10 },
    { x: 0, z: -20 },
    { x: 0, z: -30 },
  ]);
  const east = directionRoute({ x: 0, z: 0 }, 90, 10, 2);
  assert.deepEqual(east, [
    { x: 10, z: 0 },
    { x: 20, z: 0 },
  ]);
});

test("planner skips explored waypoints and marks progress", () => {
  const db = new ExploredDatabase();
  db.markExplored(4, 0);
  const planner = new ExplorationPlanner({
    route: [
      { x: 0, z: 0 },
      { x: 4, z: 0 },
      { x: 8, z: 0 },
    ],
    db,
  });
  assert.deepEqual(planner.next(), { x: 0, z: 0 });
  planner.reached({ x: 0, z: 0 });
  // (4,0) was pre-explored so it is skipped.
  assert.deepEqual(planner.next(), { x: 8, z: 0 });
  planner.reached({ x: 8, z: 0 });
  assert.equal(planner.next(), null);
  assert.ok(planner.exhausted);
});

test("planner reports region completion", () => {
  const db = new ExploredDatabase();
  const planner = new ExplorationPlanner({ route: [], db, coverageTarget: 0.5 });
  assert.ok(!planner.regionDone(0, 0, 2));
  for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) db.markExplored(dx, dz);
  assert.ok(planner.regionDone(0, 0, 2));
});
