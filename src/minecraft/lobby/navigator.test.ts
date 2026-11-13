import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { PortalTarget } from "../../api/types.ts";
import { createPortalNavigator } from "./navigator.ts";

function vanillaBlocks(origin: Vec3, axis: "x" | "z"): Vec3[] {
  const blocks: Vec3[] = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let width = 0; width < 2; width++) {
      blocks.push(axis === "x" ? origin.offset(width, dy, 0) : origin.offset(0, dy, width));
    }
  }
  return blocks;
}

function wallBlocks(origin: Vec3): Vec3[] {
  const blocks: Vec3[] = [];
  for (let y = 0; y < 8; y++) {
    for (let z = 0; z < 12; z++) {
      blocks.push(origin.offset(0, y, z));
    }
  }
  return blocks;
}

function createMockBot(start: Vec3, dimension: string) {
  const writes: string[] = [];
  const scans: Array<{ maxDistance?: number; count?: number }> = [];
  const game = { dimension, gameMode: "adventure" };
  const state: { blocks: Vec3[] } = { blocks: [] };
  const entity = { position: start };
  const bot = {
    entity,
    game,
    registry: {
      blocksByName: {
        nether_portal: { id: 1 },
        end_portal: { id: 2 },
        end_gateway: { id: 3 },
        end_portal_frame: { id: 4 },
      },
    },
    _client: {
      state: "play",
      write(name: string) {
        writes.push(name);
      },
    },
    findBlocks(options: { maxDistance?: number; count?: number }) {
      scans.push(options);
      return state.blocks;
    },
    blockAt() {
      return { name: "nether_portal" };
    },
    clearControlStates() {
      game.gameMode = "survival";
    },
    setControlState() {},
    async lookAt() {},
    pathfinder: {
      setMovements() {},
      setGoal() {},
    },
  };
  return { bot: bot as unknown as Bot, writes, scans, game, entity, state };
}

async function settle<T>(work: Promise<T>, ms: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`hunt timed out after ${ms}ms`)), ms);
  });
  try {
    return await Promise.race([work, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

test("walks a vanilla end portal and then the sky portal without /skiplobby", async () => {
  const mock = createMockBot(new Vec3(0, 64, 0), "minecraft:the_end");
  mock.state.blocks = [...wallBlocks(new Vec3(1, 60, 0)), ...vanillaBlocks(new Vec3(10, 64, 0), "x")];
  const found: PortalTarget[] = [];
  const entered: string[] = [];
  const navigator = createPortalNavigator(mock.bot, 60_000, {
    onFound: (portal) => found.push(portal),
    onEntered: (portal) => entered.push(`${portal.position.x},${portal.position.y},${portal.position.z}`),
    onMiss: () => {},
    getWorldKind: () => "lobby",
    allowServerPortals: () => true,
  });

  assert.equal(await settle(navigator.huntOnce(), 2_000), true);
  assert.equal(found[0]?.position.x, 11);
  assert.equal(found[0]?.position.y, 65.5);
  assert.equal(found[0]?.position.z, 0.5);

  mock.game.dimension = "minecraft:overworld";
  mock.game.gameMode = "adventure";
  mock.entity.position = new Vec3(0, 110, 0);
  mock.state.blocks = [...wallBlocks(new Vec3(1, 106, 0)), ...vanillaBlocks(new Vec3(20, 108, 4), "z")];

  assert.equal(await settle(navigator.huntOnce(), 3_000), true);
  assert.equal(found[1]?.position.x, 20.5);
  assert.equal(found[1]?.position.y, 109.5);
  assert.equal(found[1]?.position.z, 5);
  assert.deepEqual(entered, ["11,65.5,0.5", "20.5,109.5,5"]);
  assert.equal(mock.scans.every((scan) => scan.count === 2048 && scan.maxDistance === 64), true);
  assert.ok(mock.writes.includes("player_loaded"));
  assert.equal(mock.writes.includes("chat_command"), false);
});

test("does not walk into a decorative sky-lobby portal wall", async () => {
  const mock = createMockBot(new Vec3(0, 120, 0), "minecraft:overworld");
  mock.state.blocks = wallBlocks(new Vec3(2, 116, 0));
  const misses: string[] = [];
  const navigator = createPortalNavigator(mock.bot, 60_000, {
    onFound: () => {
      throw new Error("decorative wall was selected");
    },
    onEntered: () => {
      throw new Error("decorative wall was entered");
    },
    onMiss: (reason) => misses.push(reason),
    getWorldKind: () => "lobby",
    allowServerPortals: () => true,
  });

  assert.equal(await settle(navigator.huntOnce(), 3_000), false);
  assert.deepEqual(misses, ["no vanilla-sized server portal in range"]);
  assert.equal(mock.writes.includes("chat_command"), false);
});
