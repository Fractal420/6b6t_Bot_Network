import type { Bot } from "mineflayer";
import type { Entity } from "prismarine-entity";
import { Vec3 } from "vec3";
import type { BlockInfo, ControlState, EntityInfo, PlaceFace } from "../api/types.ts";

const EMPTY_CONTROL: ControlState = {
  forward: false,
  back: false,
  left: false,
  right: false,
  jump: false,
  sneak: false,
  sprint: false,
};

const FACES: Record<PlaceFace, Vec3> = {
  up: new Vec3(0, 1, 0),
  down: new Vec3(0, -1, 0),
  north: new Vec3(0, 0, -1),
  south: new Vec3(0, 0, 1),
  west: new Vec3(-1, 0, 0),
  east: new Vec3(1, 0, 0),
};

export function idleControl(): ControlState {
  return { ...EMPTY_CONTROL };
}

export function controlSnapshot(bot: Bot | null): ControlState {
  const c = bot?.controlState;
  if (!c) return idleControl();
  return {
    forward: Boolean(c.forward),
    back: Boolean(c.back),
    left: Boolean(c.left),
    right: Boolean(c.right),
    jump: Boolean(c.jump),
    sneak: Boolean(c.sneak),
    sprint: Boolean(c.sprint),
  };
}

export function snapshotBlockAt(bot: Bot, x: number, y: number, z: number): BlockInfo {
  const block = bot.blockAt(new Vec3(x, y, z));
  return {
    x: Math.floor(x),
    y: Math.floor(y),
    z: Math.floor(z),
    name: block?.name ?? "air",
  };
}

export function cursorBlock(bot: Bot, maxDistance = 6): BlockInfo | null {
  try {
    const block = bot.blockAtCursor(maxDistance);
    if (!block || block.name === "air" || block.name === "cave_air" || block.name === "void_air") return null;
    const p = block.position;
    return { x: p.x, y: p.y, z: p.z, name: block.name };
  } catch {
    return null;
  }
}

export function cursorEntity(bot: Bot, maxDistance = 6): EntityInfo | null {
  try {
    const entity = bot.entityAtCursor(maxDistance);
    if (!entity || entity === bot.entity) return null;
    return describeEntity(bot, entity);
  } catch {
    return null;
  }
}

export function listEntities(bot: Bot, limit = 48): EntityInfo[] {
  const rows: EntityInfo[] = [];
  const entities = bot.entities ? Object.values(bot.entities) : [];
  const origin = bot.entity?.position;
  for (const entity of entities) {
    if (!entity?.position || entity === bot.entity) continue;
    // Skip ghosts that stayed in the map after unload (common on Velocity /
    // high-latency anarchy transfers). Farther than ~192 is outside normal
    // player view and almost always stale.
    if (origin && origin.distanceTo(entity.position) > 192) continue;
    rows.push(describeEntity(bot, entity));
  }
  rows.sort((a, b) => (a.distance ?? 9e9) - (b.distance ?? 9e9));
  return rows.slice(0, limit);
}

export function faceVector(face: PlaceFace = "up"): Vec3 {
  return FACES[face] ?? FACES.up;
}

export function resolveBlock(bot: Bot, x?: number, y?: number, z?: number) {
  if ([x, y, z].every((n) => typeof n === "number" && Number.isFinite(n))) {
    return bot.blockAt(new Vec3(x as number, y as number, z as number));
  }
  return bot.blockAtCursor(6);
}

function describeEntity(bot: Bot, entity: Entity): EntityInfo {
  const origin = bot.entity?.position;
  const name =
    ("username" in entity && typeof entity.username === "string" && entity.username) ||
    entity.displayName ||
    entity.name ||
    entity.type ||
    "entity";
  return {
    id: entity.id,
    name: String(name),
    kind: entity.type || "unknown",
    position: {
      x: round(entity.position.x),
      y: round(entity.position.y),
      z: round(entity.position.z),
    },
    yaw: entity.yaw,
    pitch: entity.pitch,
    distance: origin ? origin.distanceTo(entity.position) : undefined,
  };
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
