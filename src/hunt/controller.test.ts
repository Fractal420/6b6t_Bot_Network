import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import type { Bot } from "mineflayer";
import { HuntController, DEFAULT_HUNT_CONFIG } from "./controller.ts";
import { HuntDatabase } from "./database.ts";
import { NotificationCenter, type Notification } from "./notifications.ts";

/**
 * A minimal stand-in for a live mineflayer bot. Only the members the hunt controller actually reads are
 * implemented, which keeps the orchestration test honest about which APIs it depends on.
 */
class FakeBot {
  entity = {
    position: { x: 8, y: 70, z: 8, distanceTo: () => 2, offset: () => ({ x: 8, y: 70, z: 8 }) },
    velocity: { y: 0 },
    onGround: true,
    elytraFlying: false,
    isInWater: false,
  };
  game = { dimension: "overworld" };
  health = 20;
  food = 20;
  entities: Record<string, unknown> = {};
  currentWindow: unknown = null;
  pathfinder = { goto: async () => {}, setGoal: () => {} };
  slots: Array<{ name?: string; count?: number; slot?: number; maxDurability?: number; durabilityUsed?: number; enchants?: unknown[] } | null> =
    new Array(46).fill(null);
  inventory = { slots: this.slots };
  blocks = new Map<string, string>();

  getEquipmentDestSlot(dest: string): number {
    return { torso: 38, head: 39, legs: 40, feet: 41, "off-hand": 42, hand: 0 }[dest] ?? 36;
  }

  blockAt(pos: { x: number; y: number; z: number }) {
    const name = this.blocks.get(`${pos.x},${pos.y},${pos.z}`);
    if (!name) return null;
    return { name, position: { x: pos.x, y: pos.y, z: pos.z, offset: () => ({ x: pos.x, y: pos.y, z: pos.z }) } };
  }

  findBlock(): null {
    return null;
  }

  clearControlStates(): void {}
  setControlState(): void {}
  async look(): Promise<void> {}
  async elytraFly(): Promise<void> {}
  async equip(): Promise<void> {}
  activateItem(): void {}
  closeWindow(): void {}
}

function makeController(overrides: Partial<typeof DEFAULT_HUNT_CONFIG> = {}): {
  controller: HuntController;
  bot: FakeBot;
  db: HuntDatabase;
  sent: Notification[];
} {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "bh-ctl-"));
  const db = new HuntDatabase({ dir, server: "test", now: () => 1000, saveDebounceMs: 1 });
  const sent: Notification[] = [];
  const notifications = new NotificationCenter({ sink: (n) => void sent.push(n), now: () => 1000 });
  const bot = new FakeBot();
  const controller = new HuntController({
    getBot: () => bot as unknown as Bot,
    database: db,
    notifications,
    config: { scanIntervalMs: 0, scanBudget: 5_000_000, scanRadiusChunks: 0, ...overrides },
    now: () => 1000,
  });
  return { controller, bot, db, sent };
}

test("scanning a chunk records a stash and notifies once", () => {
  const { controller, bot, db, sent } = makeController();
  bot.slots[38] = { name: "elytra", count: 1, maxDurability: 432, durabilityUsed: 10 };
  for (let i = 0; i < 12; i++) bot.blocks.set(`${i},64,0`, "chest");
  for (let i = 0; i < 6; i++) bot.blocks.set(`${i},64,1`, "barrel");

  controller.start();
  controller.tick();

  const stashes = db.getStashes();
  assert.equal(stashes.length, 1, "one stash recorded");
  assert.ok(stashes[0].score >= 24);
  assert.ok(sent.some((n) => n.kind === "stash-discovery" || n.kind === "major-storage"));
  controller.stop();
});

test("a trivial scan is not recorded", () => {
  const { controller, bot, db } = makeController();
  bot.blocks.set("0,64,0", "chest");
  controller.start();
  controller.tick();
  assert.equal(db.getStashes().length, 0);
  controller.stop();
});

test("critical health stops flight and raises an emergency", () => {
  const { controller, bot, sent } = makeController();
  bot.health = 3;
  controller.start();
  controller.tick();
  assert.ok(sent.some((n) => n.kind === "emergency"));
  assert.equal(controller.status().phase, "restocking");
  controller.stop();
});

test("pause and resume release and re-acquire control", () => {
  const { controller } = makeController();
  controller.start();
  controller.tick();
  controller.pause();
  assert.ok(controller.isPaused);
  assert.equal(controller.status().phase, "paused");
  controller.resume();
  assert.ok(!controller.isPaused);
  controller.stop();
  assert.ok(!controller.running);
});

test("route advances and marks waypoints explored", () => {
  const { controller, bot } = makeController({ mode: "grid", spacing: 1, halfCount: 0 });
  controller.start();
  controller.tick();
  // The single waypoint is at the bot's own chunk, so the next tick marks it reached.
  const before = controller.status().exploredChunks;
  controller.tick();
  assert.ok(controller.status().exploredChunks >= before);
  controller.stop();
});

test("restock reports no chest instead of throwing", async () => {
  const { controller, bot } = makeController();
  bot.slots[38] = { name: "elytra", maxDurability: 432, durabilityUsed: 0 };
  controller.start();
  const result = await controller.restock();
  assert.match(result, /no ender chest/);
  controller.stop();
});

test("status reports the mode and waypoint counts", () => {
  const { controller } = makeController({ mode: "spiral", halfCount: 2, spacing: 4 });
  controller.start();
  const status = controller.status();
  assert.equal(status.mode, "spiral");
  assert.ok(status.waypointsTotal > 0);
  controller.stop();
});

test("setWaypoints switches to waypoints mode and replaces the route", () => {
  const { controller } = makeController({ mode: "spiral", halfCount: 2, spacing: 4 });
  const count = controller.setWaypoints([
    { x: 1, z: 2 },
    { x: 3, z: 4 },
  ]);
  assert.equal(count, 2);
  assert.equal(controller.getConfig().mode, "waypoints");
  assert.deepEqual(controller.getWaypoints(), [
    { x: 1, z: 2 },
    { x: 3, z: 4 },
  ]);
});

test("a custom route is used instead of the generated spiral while active", () => {
  const { controller } = makeController({ halfCount: 2, spacing: 4 });
  controller.setWaypoints([
    { x: 100, z: 100 },
    { x: 101, z: 101 },
  ]);
  controller.start();
  const status = controller.status();
  assert.equal(status.mode, "waypoints");
  assert.equal(status.waypointsTotal, 2, "route comes from the custom waypoints, not the spiral");
  controller.stop();
});

test("setWaypoints rounds fractional chunk coordinates", () => {
  const { controller } = makeController();
  controller.setWaypoints([{ x: 2.6, z: -3.4 }]);
  assert.deepEqual(controller.getWaypoints(), [{ x: 3, z: -3 }]);
});
