import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { loadHuntConfig, saveHuntConfig } from "./huntConfigStore.ts";
import { DEFAULT_HUNT_CONFIG } from "../hunt/controller.ts";

// The store takes an explicit root for tests so nothing writes to the real Settings directory.
function withTempRoot(fn: (root: string) => void): void {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "bh-cfg-"));
  try {
    fn(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test("a missing config loads the defaults", () => {
  withTempRoot((root) => {
    const config = loadHuntConfig("play.example.net:25565", root);
    assert.equal(config.mode, DEFAULT_HUNT_CONFIG.mode);
    assert.deepEqual(config.waypoints, []);
  });
});

test("a saved config round-trips, merging nested objects over the defaults", () => {
  withTempRoot((root) => {
    const server = "play.example.net:25565";
    saveHuntConfig(
      server,
      {
        ...DEFAULT_HUNT_CONFIG,
        mode: "waypoints",
        waypoints: [{ x: 3, z: 4 }],
        survival: { ...DEFAULT_HUNT_CONFIG.survival, minHealth: 15 },
      },
      root,
    );

    const loaded = loadHuntConfig(server, root);
    assert.equal(loaded.mode, "waypoints");
    assert.deepEqual(loaded.waypoints, [{ x: 3, z: 4 }]);
    assert.equal(loaded.survival.minHealth, 15);
    // Fields the save did not mention keep their defaults rather than disappearing.
    assert.equal(loaded.survival.minFood, DEFAULT_HUNT_CONFIG.survival.minFood);
  });
});

test("a corrupt config file falls back to the defaults instead of throwing", () => {
  withTempRoot((root) => {
    const server = "play.example.net:25565";
    const file = path.join(root, "hunt", "play.example.net_25565", "config.json");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "{ not valid json", "utf8");
    const config = loadHuntConfig(server, root);
    assert.equal(config.mode, DEFAULT_HUNT_CONFIG.mode);
  });
});

test("configs are keyed per server", () => {
  withTempRoot((root) => {
    saveHuntConfig("a.example.net:25565", { ...DEFAULT_HUNT_CONFIG, mode: "grid" }, root);
    saveHuntConfig("b.example.net:25565", { ...DEFAULT_HUNT_CONFIG, mode: "adaptive" }, root);
    assert.equal(loadHuntConfig("a.example.net:25565", root).mode, "grid");
    assert.equal(loadHuntConfig("b.example.net:25565", root).mode, "adaptive");
  });
});
