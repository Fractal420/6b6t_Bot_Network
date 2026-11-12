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
  const entity = { position: start, yaw: 0, pitch: 0 };
  const controls: Record<string, boolean> = {};
  let blockKeys = new Set<string>();
  const key = (p: { x: number; y: number; z: number }) =>
    `${Math.floor(p.x)},${Math.floor(p.y)},${Math.floor(p.z)}`;
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
      blockKeys = new Set(state.blocks.map(key));
      return state.blocks;
    },
    blockAt(pos: { x: number; y: number; z: number }) {
      return blockKeys.has(key(pos)) ? { name: "nether_portal" } : null;
    },
    clearControlStates() {
      for (const key of Object.keys(controls)) controls[key] = false;
    },
    setControlState(name: string, value: boolean) {
      controls[name] = value;
      if (name === "forward" && value) {
        // Walk along the facing direction so the approach loop actually moves.
        const yaw = entity.yaw || 0;
        entity.position = entity.position.offset(-Math.sin(yaw) * 0.35, 0, -Math.cos(yaw) * 0.35);
        // Simulate Velocity accepting the portal hop once we have walked in.
        if (entity.position.distanceTo(start) > 3) game.gameMode = "survival";
      }
    },
    async look(yaw: number, pitch: number) {
      entity.yaw = yaw;
      entity.pitch = pitch;
    },
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
  // When a vanilla 2×3 interior is present the navigator still prefers it, even
  // with a large decorative wall nearby.
  assert.equal(found[0]?.position.x, 11);
  assert.equal(found[0]?.position.y, 65.5);
  assert.equal(found[0]?.position.z, 0.5);
  assert.deepEqual(entered, ["11,65.5,0.5"]);

  mock.game.dimension = "minecraft:overworld";
  mock.game.gameMode = "adventure";
  mock.entity.position = new Vec3(0, 110, 0);
  mock.state.blocks = [...wallBlocks(new Vec3(1, 106, 0)), ...vanillaBlocks(new Vec3(20, 108, 4), "z")];

  assert.equal(await settle(navigator.huntOnce(), 3_000), true);
  assert.equal(found[1]?.position.x, 20.5);
  assert.equal(found[1]?.position.y, 109.5);
  assert.equal(found[1]?.position.z, 5);
  assert.deepEqual(entered, ["11,65.5,0.5", "20.5,109.5,5"]);
  assert.equal(mock.scans.every((scan) => scan.count === 1024 && scan.maxDistance === 72), true);
  assert.ok(mock.writes.includes("player_loaded"));
  assert.equal(mock.writes.includes("chat_command"), false);
});

test("treats a lone large sky-lobby portal wall as a server portal", async () => {
  // The second 6b6t lobby portal is a custom wall rather than a 2×3 vanilla
  // interior. The navigator must still target it (regression for b89b374) and
  // aim at the near face along the thin axis (X), keeping the wall's centre Z.
  const mock = createMockBot(new Vec3(0, 120, 0), "minecraft:overworld");
  mock.state.blocks = wallBlocks(new Vec3(2, 116, 0));
  const found: PortalTarget[] = [];
  const navigator = createPortalNavigator(mock.bot, 60_000, {
    onFound: (portal) => found.push(portal),
    onEntered: () => {},
    onMiss: () => {},
    getWorldKind: () => "lobby",
    allowServerPortals: () => true,
  });

  assert.equal(await settle(navigator.huntOnce(), 3_000), true);
  assert.equal(found.length, 1);
  assert.equal(found[0]?.position.x, 2.5);
  assert.equal(found[0]?.position.z, 6);
  assert.equal(mock.writes.includes("chat_command"), false);
});

test("reports a miss when no portal blocks are in range", async () => {
  const mock = createMockBot(new Vec3(0, 120, 0), "minecraft:overworld");
  mock.state.blocks = [];
  const misses: string[] = [];
  const navigator = createPortalNavigator(mock.bot, 60_000, {
    onFound: () => {
      throw new Error("no portal should be selected");
    },
    onEntered: () => {
      throw new Error("nothing should be entered");
    },
    onMiss: (reason) => misses.push(reason),
    getWorldKind: () => "lobby",
    allowServerPortals: () => true,
  });

  assert.equal(await settle(navigator.huntOnce(), 3_000), false);
  assert.deepEqual(misses, ["no portal in range"]);
  assert.equal(mock.writes.includes("chat_command"), false);
});
