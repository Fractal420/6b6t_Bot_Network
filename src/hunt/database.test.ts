import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  DATABASE_VERSION,
  HuntDatabase,
  parsePlayer,
  parseStash,
  safeServerName,
  stashIdentity,
} from "./database.ts";

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bh-db-"));
}

function stashInput(x: number, z: number, score: number) {
  return {
    x,
    y: 64,
    z,
    chunkX: Math.floor(x / 16),
    chunkZ: Math.floor(z / 16),
    dimension: "overworld",
    score,
    tier: score >= 180 ? "large" : "small",
    containers: 10,
    evidence: { chests: 10 },
    discoveredAtMs: 1000,
    lastSeenMs: 1000,
    method: "scan",
    playerSightings: [] as string[],
  };
}

test("safe server names are filesystem-safe", () => {
  assert.equal(safeServerName("alt3.6b6t.org"), "alt3.6b6t.org");
  assert.equal(safeServerName("Weird Server:25565"), "weird_server_25565");
  assert.equal(safeServerName(""), "unknown");
});

test("stash identity is stable and position-based", () => {
  assert.equal(stashIdentity(10, 64, -10, "overworld"), "overworld:10:64:-10");
  assert.equal(stashIdentity(10.4, 64.2, -10, "overworld"), stashIdentity(10, 64, -10, "overworld"));
});

test("records and de-duplicates stashes", () => {
  const db = new HuntDatabase({ dir: tmpDir(), server: "test", now: () => 1000, saveDebounceMs: 1 });
  const first = db.recordStash(stashInput(100, 200, 50));
  assert.ok(first.isNew);
  const again = db.recordStash(stashInput(100, 200, 250));
  assert.ok(!again.isNew);
  assert.equal(db.getStashes().length, 1);
  // The stronger observation wins.
  assert.equal(again.record.score, 250);
  db.flush();
});

test("records and accumulates player sightings", () => {
  const db = new HuntDatabase({ dir: tmpDir(), server: "test", now: () => 1000, saveDebounceMs: 1 });
  db.recordPlayerSighting({ username: "Steve", x: 0, y: 64, z: 0, dimension: "overworld", atMs: 1000 });
  db.recordPlayerSighting({ username: "steve", x: 10, y: 64, z: 10, dimension: "overworld", atMs: 2000 });
  const players = db.getPlayers();
  assert.equal(players.length, 1);
  assert.equal(players[0].sightings, 2);
  assert.equal(players[0].lastX, 10);
  db.flush();
});

test("persists across reloads", () => {
  const dir = tmpDir();
  const db = new HuntDatabase({ dir, server: "test", now: () => 1000, saveDebounceMs: 1 });
  db.recordStash(stashInput(1, 2, 300));
  db.recordPlayerSighting({ username: "Alex", x: 1, y: 2, z: 3, dimension: "nether", atMs: 1000 });
  db.setExploration({ exploredKeys: ["1,1", "2,2"], reviewKeys: ["9,9"] });
  db.flush();

  const reloaded = new HuntDatabase({ dir, server: "test", now: () => 2000, saveDebounceMs: 1 });
  assert.equal(reloaded.getStashes().length, 1);
  assert.equal(reloaded.getPlayers().length, 1);
  assert.deepEqual(reloaded.getExploration().exploredKeys, ["1,1", "2,2"]);
  assert.equal(reloaded.version, DATABASE_VERSION);
});

test("recovers from a corrupted file without throwing", () => {
  const dir = tmpDir();
  const db = new HuntDatabase({ dir, server: "test", now: () => 1000, saveDebounceMs: 1 });
  db.recordStash(stashInput(5, 5, 100));
  db.flush();
  const file = db.filePath;

  fs.writeFileSync(file, "{ this is not json", "utf8");
  const recovered = new HuntDatabase({ dir, server: "test", now: () => 2000, saveDebounceMs: 1 });
  assert.equal(recovered.getStashes().length, 0, "a corrupt file starts clean");
  // The bad file is quarantined, not deleted.
  assert.ok(fs.existsSync(`${file}.corrupt-2000`));
});

test("a single corrupt record does not sink the whole document", () => {
  const dir = tmpDir();
  const file = path.join(dir, "hunt", safeServerName("test"), "database.json");
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    JSON.stringify({
      version: 1,
      server: "test",
      updatedAt: 0,
      stashes: [stashInput(1, 1, 100), null, { garbage: true }, stashInput(2, 2, 100)],
      players: [{ username: "ok" }, { notAUsername: 1 }],
      exploration: { exploredKeys: ["1,1", 5, "2,2"], reviewKeys: [] },
    }),
    "utf8",
  );
  const db = new HuntDatabase({ dir, server: "test", now: () => 1000, saveDebounceMs: 1 });
  assert.equal(db.getStashes().length, 2, "the valid stashes survive");
  assert.equal(db.getPlayers().length, 1);
  assert.deepEqual(db.getExploration().exploredKeys, ["1,1", "2,2"]);
});

test("atomic write leaves no temp file behind", () => {
  const dir = tmpDir();
  const db = new HuntDatabase({ dir, server: "test", now: () => 1000, saveDebounceMs: 1 });
  db.recordStash(stashInput(1, 1, 100));
  db.flush();
  const files = fs.readdirSync(path.dirname(db.filePath));
  assert.ok(files.includes("database.json"));
  assert.ok(!files.some((f) => f.includes(".tmp-")));
});

test("searches stashes by tier and text", () => {
  const db = new HuntDatabase({ dir: tmpDir(), server: "test", now: () => 1000, saveDebounceMs: 1 });
  db.recordStash({ ...stashInput(1, 1, 300), tier: "large" });
  db.recordStash({ ...stashInput(2, 2, 30), tier: "small" });
  assert.equal(db.searchStashes({ tier: "large" }).length, 1);
  assert.equal(db.searchStashes({ minScore: 100 }).length, 1);
  assert.equal(db.searchStashes({ text: "small" }).length, 1);
  db.flush();
});

test("prunes stale players", () => {
  const now = 100 * 86_400_000;
  const db = new HuntDatabase({
    dir: tmpDir(),
    server: "test",
    now: () => now,
    maxPlayerAgeDays: 30,
    saveDebounceMs: 1,
  });
  db.recordPlayerSighting({ username: "old", x: 0, y: 0, z: 0, dimension: "overworld", atMs: 0 });
  db.recordPlayerSighting({ username: "new", x: 0, y: 0, z: 0, dimension: "overworld", atMs: now });
  const pruned = db.prune();
  assert.equal(pruned.players, 1);
  assert.equal(db.getPlayers()[0].username, "new");
  db.flush();
});

test("exports and imports", () => {
  const source = new HuntDatabase({ dir: tmpDir(), server: "test", now: () => 1000, saveDebounceMs: 1 });
  source.recordStash(stashInput(9, 9, 300));
  source.recordPlayerSighting({ username: "Zed", x: 9, y: 9, z: 9, dimension: "overworld", atMs: 1000 });
  const json = source.exportJson();
  source.flush();

  const target = new HuntDatabase({ dir: tmpDir(), server: "other", now: () => 2000, saveDebounceMs: 1 });
  const counts = target.importJson(json, "merge");
  assert.equal(counts.stashes, 1);
  assert.equal(counts.players, 1);
  assert.equal(target.getStashes()[0].score, 300);
  target.flush();
});

test("import rejects a non-database document", () => {
  const db = new HuntDatabase({ dir: tmpDir(), server: "test", now: () => 1000, saveDebounceMs: 1 });
  assert.throws(() => db.importJson(JSON.stringify({ hello: "world" })));
});

test("parsers reject unusable input", () => {
  assert.equal(parseStash(null), null);
  assert.equal(parseStash("nope"), null);
  assert.equal(parsePlayer({}), null);
  assert.ok(parsePlayer({ username: "x" }));
});
