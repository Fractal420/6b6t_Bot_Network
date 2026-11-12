import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { readElytraStatus, needsReplacement, equipBestElytra } from "./elytraRuntime.ts";
import {
  findEnderChest,
  openEnderChest,
  readOpenContainer,
  planDeposit,
  planWithdraw,
  executeDeposit,
} from "./enderChestRuntime.ts";
import { readMendingCandidates, selectMendingTarget } from "./mendingRuntime.ts";
import { readSurvivalSnapshot, countItem, hasXpSource } from "./survivalRuntime.ts";

interface Slot {
  name?: string;
  count?: number;
  slot?: number;
  maxDurability?: number;
  durabilityUsed?: number;
  enchants?: Array<{ name?: string }>;
}

interface MockBot {
  bot: Bot;
  slots: Array<Slot | null>;
  blocks: Map<string, { name: string; position: { x: number; y: number; z: number; offset: () => unknown } }>;
  controls: Record<string, boolean>;
  equipped: Array<{ dest: string; name?: string }>;
  window: unknown;
}

function makeBot(): MockBot {
  const slots: Array<Slot | null> = new Array(46).fill(null);
  const blocks = new Map<string, { name: string; position: { x: number; y: number; z: number; offset: () => unknown } }>();
  const controls: Record<string, boolean> = {};
  const equipped: Array<{ dest: string; name?: string }> = [];
  const mock: MockBot = { slots, blocks, controls, equipped, window: null, bot: undefined as unknown as Bot };

  const destSlot: Record<string, number> = { torso: 38, head: 39, legs: 40, feet: 41, "off-hand": 42, hand: 0 };

  mock.bot = {
    entity: {
      position: { x: 0, y: 64, z: 0, distanceTo: () => 1, offset: () => ({ x: 0, y: 64, z: 0 }) },
      velocity: { x: 0, y: 0, z: 0 },
      onGround: true,
      elytraFlying: false,
      isInWater: false,
    },
    game: { dimension: "overworld" },
    health: 20,
    food: 20,
    entities: {},
    inventory: { slots },
    getEquipmentDestSlot: (dest: string) => destSlot[dest] ?? 36,
    blockAt: (pos: { x: number; y: number; z: number }) => mock.blocks.get(`${pos.x},${pos.y},${pos.z}`) ?? null,
    findBlock: ({ matching }: { matching: (b: { name?: string }) => boolean }) => {
      for (const b of mock.blocks.values()) if (matching(b)) return b;
      return null;
    },
    clearControlStates: () => {
      for (const k of Object.keys(controls)) controls[k] = false;
    },
    setControlState: (name: string, value: boolean) => {
      controls[name] = value;
    },
    look: async () => {},
    equip: async (item: Slot, dest: string) => {
      equipped.push({ dest, name: item.name });
      // Mirror the equip into the destination slot so subsequent reads see it.
      const slot = destSlot[dest];
      if (slot != null) slots[slot] = item;
    },
    openContainer: async () => {
      mock.window = (mock.bot as unknown as { currentWindow: unknown }).currentWindow;
    },
    closeWindow: () => {
      mock.window = null;
    },
    pathfinder: { goto: async () => {} },
    moveSlotItem: async () => {},
    get currentWindow() {
      return mock.window;
    },
  } as unknown as Bot;

  return mock;
}

// --- Elytra -----------------------------------------------------------------------------------------

test("elytra status counts the worn piece and excludes it from the spares", () => {
  const mock = makeBot();
  mock.slots[38] = { name: "elytra", slot: 38, maxDurability: 432, durabilityUsed: 100 };
  mock.slots[10] = { name: "elytra", slot: 10, maxDurability: 432, durabilityUsed: 400 };
  const status = readElytraStatus(mock.bot);
  assert.equal(status.equipped, true);
  assert.equal(status.remaining, 332);
  assert.equal(status.spares, 1, "only the stored elytra counts as a spare");
  assert.equal(status.bestSpareRemaining, 32);
});

test("needsReplacement triggers below the threshold and not at or above it", () => {
  const status = { equipped: true, remaining: 20, bestSpareRemaining: 100 } as ReturnType<typeof readElytraStatus>;
  assert.equal(needsReplacement(status, 16), false);
  assert.equal(needsReplacement({ ...status, remaining: 10 }, 16), true);
  // Not wearing one is a deployment problem, not a replacement one.
  assert.equal(needsReplacement({ ...status, equipped: false, remaining: -1 }, 16), false);
  assert.equal(needsReplacement({ ...status, remaining: 10, bestSpareRemaining: -1 }, 16), false, "no spare means no replacement");
});

test("equipBestElytra picks the healthiest spare that clears the minimum", async () => {
  const mock = makeBot();
  mock.slots[38] = { name: "elytra", slot: 38, maxDurability: 432, durabilityUsed: 420 };
  mock.slots[5] = { name: "elytra", slot: 5, maxDurability: 432, durabilityUsed: 300 };
  mock.slots[9] = { name: "elytra", slot: 9, maxDurability: 432, durabilityUsed: 200 };
  const remaining = await equipBestElytra(mock.bot, 16);
  assert.equal(remaining, 232, "the least-damaged viable spare is chosen");
  assert.equal(mock.equipped.at(-1)?.dest, "torso");
});

test("equipBestElytra reports -1 when no spare clears the minimum", async () => {
  const mock = makeBot();
  mock.slots[38] = { name: "elytra", slot: 38, maxDurability: 432, durabilityUsed: 430 };
  mock.slots[5] = { name: "elytra", slot: 5, maxDurability: 432, durabilityUsed: 430 };
  assert.equal(await equipBestElytra(mock.bot, 16), -1);
});

// --- Ender chest ------------------------------------------------------------------------------------

function enderChestBlock(x: number, y: number, z: number) {
  return { name: "ender_chest", position: { x, y, z, offset: () => ({ x, y, z }) } };
}

test("findEnderChest returns null when there is none nearby", () => {
  const mock = makeBot();
  assert.equal(findEnderChest(mock.bot, 48), null);
});

test("findEnderChest locates a nearby ender chest", () => {
  const mock = makeBot();
  mock.blocks.set("5,64,0", enderChestBlock(5, 64, 0));
  const loc = findEnderChest(mock.bot, 48);
  assert.ok(loc);
  assert.equal(loc?.x, 5);
});

test("openEnderChest returns null when the block is not loaded", async () => {
  const mock = makeBot();
  const result = await openEnderChest(mock.bot, { x: 5, y: 64, z: 0, distance: 5 });
  assert.equal(result, null);
});

test("readOpenContainer reads container slots and excludes the player inventory", () => {
  const mock = makeBot();
  mock.window = {
    title: "Ender Chest",
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: [
      { name: "elytra", count: 1 },
      null,
      { name: "cooked_beef", count: 16 },
      ...new Array(24).fill(null),
      { name: "stone", count: 64 }, // player inventory starts at 27 — must not appear
    ],
  };
  const contents = readOpenContainer(mock.bot);
  assert.ok(contents);
  assert.equal(contents?.slots.length, 2);
  assert.equal(contents?.inventoryStart, 27);
});

test("planDeposit keeps valuable items and honours reserves", () => {
  const mock = makeBot();
  mock.slots[0] = { name: "diamond_block", count: 1, slot: 0 }; // valuable — never auto-deposited
  mock.slots[1] = { name: "cobblestone", count: 64, slot: 1 };
  mock.slots[2] = { name: "cobblestone", count: 64, slot: 2 };
  mock.slots[3] = { name: "stone_bricks", count: 32, slot: 3 };

  const plan = planDeposit(mock.bot, ["building-blocks"], { "building-blocks": 100 });
  assert.equal(plan.move.length, 1, "reserve of 100 keeps 128 of the 160 building blocks");
  assert.equal(plan.move[0].name, "stone_bricks", "the surplus stack moves, the cobblestone reserve stays");
  const planNoReserve = planDeposit(mock.bot, ["building-blocks"]);
  assert.equal(planNoReserve.move.length, 3, "without a reserve every building block moves");
  // Selecting the valuable category must still never move a precious item.
  const planValuable = planDeposit(mock.bot, ["valuable"]);
  assert.equal(planValuable.move.length, 0, "valuable items are never auto-deposited");
  assert.ok(planValuable.keep.some((k) => k.name === "diamond_block" && /valuable/.test(k.reason)));
});

test("planWithdraw takes up to one stack per selected category", () => {
  const contents = {
    title: "Ender Chest",
    inventoryStart: 27,
    slots: [
      { slot: 0, name: "elytra", count: 1, displayName: "Elytra" },
      { slot: 1, name: "cooked_beef", count: 16, displayName: "Steak" },
      { slot: 2, name: "cooked_beef", count: 16, displayName: "Steak" },
      { slot: 3, name: "diamond", count: 64, displayName: "Diamond" },
    ],
  };
  const plan = planWithdraw(contents, ["food"], 1);
  assert.equal(plan.take.length, 1, "only one food stack per category");
  assert.equal(plan.take[0].name, "cooked_beef");
});

test("executeDeposit moves only the planned stacks and respects the reserve", async () => {
  const mock = makeBot();
  const moves: Array<[number, number]> = [];
  (mock.bot as unknown as { moveSlotItem: (a: number, b: number) => Promise<void> }).moveSlotItem = async (a, b) => {
    moves.push([a, b]);
  };
  const contents = { title: "Ender Chest", inventoryStart: 27, slots: [] };
  mock.window = {
    inventoryStart: 27,
    inventoryEnd: 63,
    slots: [
      null,
      null,
      ...new Array(25).fill(null),
      { name: "cobblestone", count: 64 }, // slot 27 — first player inventory slot
      { name: "cobblestone", count: 64 }, // slot 28
    ],
  };
  const moved = await executeDeposit(mock.bot, contents, {
    move: [{ name: "cobblestone", count: 64, category: "building-blocks" }],
    keep: [],
  });
  assert.equal(moved, 1, "only the planned 64 cobblestone moved");
  assert.equal(moves.length, 1);
});

// --- Mending ----------------------------------------------------------------------------------------

test("mending candidates include only damaged enchanted gear, worst first", () => {
  const mock = makeBot();
  mock.slots[38] = { name: "elytra", slot: 38, maxDurability: 432, durabilityUsed: 300, enchants: [{ name: "mending" }] };
  mock.slots[39] = { name: "netherite_helmet", slot: 39, maxDurability: 407, durabilityUsed: 7, enchants: [{ name: "mending" }] };
  mock.slots[0] = { name: "diamond_pickaxe", slot: 0, maxDurability: 1561, durabilityUsed: 0, enchants: [{ name: "mending" }] };
  mock.slots[1] = { name: "iron_sword", slot: 1, maxDurability: 250, durabilityUsed: 100 };

  const candidates = readMendingCandidates(mock.bot);
  const names = candidates.map((c) => c.name);
  assert.ok(names.includes("elytra"));
  assert.ok(names.includes("netherite_helmet"));
  assert.ok(!names.includes("iron_sword"), "no Mending enchantment means no candidate");

  const target = selectMendingTarget(mock.bot);
  assert.equal(target?.candidate.name, "elytra", "the most damaged Mending item is targeted first");
});

// --- Survival ---------------------------------------------------------------------------------------

test("survival snapshot reads health, hunger, equipment and inventory", () => {
  const mock = makeBot();
  mock.bot.health = 14;
  mock.bot.food = 9;
  mock.slots[38] = { name: "elytra", slot: 38, maxDurability: 432, durabilityUsed: 200 };
  mock.slots[39] = { name: "netherite_helmet", slot: 39, maxDurability: 407, durabilityUsed: 100 };
  mock.slots[0] = { name: "totem_of_undying", count: 2, slot: 0 };
  mock.slots[1] = { name: "cooked_beef", count: 8, slot: 1 };
  mock.slots[2] = { name: "firework_rocket", count: 32, slot: 2 };

  const snap = readSurvivalSnapshot(mock.bot);
  assert.ok(snap);
  assert.equal(snap?.health, 14);
  assert.equal(snap?.food, 9);
  assert.equal(snap?.elytraRemaining, 232);
  assert.equal(snap?.totems, 2);
  assert.equal(snap?.foodItems, 8);
  assert.equal(snap?.fireworks, 32);
});

test("countItem totals matching stacks", () => {
  const mock = makeBot();
  mock.slots[0] = { name: "firework_rocket", count: 32 };
  mock.slots[1] = { name: "firework_rocket", count: 32 };
  assert.equal(countItem(mock.bot, "firework_rocket"), 64);
});

test("hasXpSource is false with no orbs and no bottles", () => {
  const mock = makeBot();
  assert.equal(hasXpSource(mock.bot), false);
  mock.slots[0] = { name: "experience_bottle", count: 1 };
  assert.equal(hasXpSource(mock.bot), true);
});
