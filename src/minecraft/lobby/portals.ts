import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { PortalKind, PortalTarget, WorldKind } from "../../api/types.ts";
import { isLobbyLike } from "./worldKind.ts";

const PORTAL_BLOCKS = new Set([
  "nether_portal",
  "end_portal",
  "end_gateway",
  "end_portal_frame",
]);

function idOf(bot: Bot, name: string): number | undefined {
  return bot.registry?.blocksByName?.[name]?.id;
}

function kindForBlock(name: string, worldKind: WorldKind, treatAsServer: boolean): PortalKind {
  if (treatAsServer) return "server";
  if (name === "end_portal" || name === "end_gateway" || name === "end_portal_frame") return "end";
  if (name === "nether_portal") return "nether";
  return "unknown";
}

/** Default flint-and-steel nether portal interior, in blocks. */
export const VANILLA_PORTAL_WIDTH = 2;
export const VANILLA_PORTAL_HEIGHT = 3;

export function findPortalBlocks(bot: Bot, maxDistance = 48, count = 64): PortalTarget[] {
  const pos = bot.entity?.position;
  if (!pos) return [];

  const matchingIds = [...PORTAL_BLOCKS]
    .map((name) => idOf(bot, name))
    .filter((id): id is number => typeof id === "number");

  let positions: Vec3[] = [];
  try {
    if (matchingIds.length > 0) {
      positions = bot.findBlocks({
        matching: matchingIds,
        maxDistance,
        count,
      }) as unknown as Vec3[];
    }
  } catch {
    positions = [];
  }

  if (positions.length === 0) {
    const origin = pos.floored();
    for (let dx = -maxDistance; dx <= maxDistance; dx++) {
      for (let dy = -8; dy <= 12; dy++) {
        for (let dz = -maxDistance; dz <= maxDistance; dz++) {
          const block = bot.blockAt(origin.offset(dx, dy, dz));
          if (block && PORTAL_BLOCKS.has(block.name)) {
            positions.push(block.position.clone());
          }
        }
      }
    }
  }

  const seen = new Set<string>();
  const targets: PortalTarget[] = [];
  for (const p of positions) {
    const key = `${p.x},${p.y},${p.z}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const block = bot.blockAt(p);
    const name = block?.name ?? "nether_portal";
    const distance = pos.distanceTo(p.offset(0.5, 0.5, 0.5));
    targets.push({
      kind: "unknown",
      position: { x: p.x, y: p.y, z: p.z },
      distance,
      blockName: name,
    });
  }

  targets.sort((a, b) => a.distance - b.distance);
  return targets;
}

export function classifyPortals(
  portals: PortalTarget[],
  worldKind: WorldKind,
  allowServerPortals: boolean,
): PortalTarget[] {
  const treatAsServer = allowServerPortals && (isLobbyLike(worldKind) || worldKind === "unknown");
  return portals.map((portal) => ({
    ...portal,
    kind: kindForBlock(portal.blockName, worldKind, treatAsServer),
  }));
}

/**
 * A normal vanilla nether portal is a 4×5 obsidian frame with a 2×3 interior.
 * Lobby passes target that interior and ignore decorative portal walls.
 */
export function isNormalVanillaPortal(blocks: PortalTarget[]): boolean {
  const interior = VANILLA_PORTAL_WIDTH * VANILLA_PORTAL_HEIGHT;
  if (blocks.length < interior - 2 || blocks.length > interior) return false;

  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minZ = Infinity;
  let maxZ = -Infinity;
  for (const block of blocks) {
    minX = Math.min(minX, block.position.x);
    maxX = Math.max(maxX, block.position.x);
    minY = Math.min(minY, block.position.y);
    maxY = Math.max(maxY, block.position.y);
    minZ = Math.min(minZ, block.position.z);
    maxZ = Math.max(maxZ, block.position.z);
  }

  const spanX = maxX - minX;
  const spanY = maxY - minY;
  const spanZ = maxZ - minZ;
  const horizontal = [spanX, spanZ].sort((a, b) => a - b);
  return horizontal[0] === 0 && horizontal[1] === VANILLA_PORTAL_WIDTH - 1 && spanY === VANILLA_PORTAL_HEIGHT - 1;
}

export function pickServerPortal(
  portals: PortalTarget[],
  worldKind: WorldKind,
  allowServerPortals: boolean,
  botPos?: { x: number; y: number; z: number },
): PortalTarget | null {
  const classified = classifyPortals(portals, worldKind, allowServerPortals);
  const servers = classified.filter((portal) => portal.kind === "server" && portal.blockName === "nether_portal");
  if (servers.length === 0) return null;

  const clusters = clusterTouching(servers);
  // Prefer strict vanilla 2×3 interiors; fall back to any nether_portal cluster.
  // The current second lobby portal is a large custom wall, so we must accept
  // oversized clusters — otherwise the bot never targets it.
  let chosen = clusters.filter(isNormalVanillaPortal);
  if (chosen.length === 0) chosen = clusters.filter((c) => c.length >= 2);
  if (chosen.length === 0) chosen = clusters;
  chosen.sort((a, b) => minDistance(a) - minDistance(b));
  const clusterPortals = chosen[0];
  if (!clusterPortals?.length) return null;

  // Bounding box of the cluster
  let minX = Infinity, maxX = -Infinity;
  let minY = Infinity, maxY = -Infinity;
  let minZ = Infinity, maxZ = -Infinity;
  for (const p of clusterPortals) {
    minX = Math.min(minX, p.position.x);
    maxX = Math.max(maxX, p.position.x);
    minY = Math.min(minY, p.position.y);
    maxY = Math.max(maxY, p.position.y);
    minZ = Math.min(minZ, p.position.z);
    maxZ = Math.max(maxZ, p.position.z);
  }

  const cx = (minX + maxX) / 2 + 0.5;
  const cy = (minY + maxY) / 2 + 0.5;
  const cz = (minZ + maxZ) / 2 + 0.5;
  const spanX = maxX - minX;
  const spanZ = maxZ - minZ;

  // For thick/large walls: aim at the face nearest the bot instead of the
  // geometric centre (which can sit inside the wall or on the far side).
  let tx = cx;
  let ty = cy;
  let tz = cz;
  if (botPos && (spanX >= 2 || spanZ >= 2 || clusterPortals.length >= 8)) {
    // Prefer the thinner axis as the "depth" of the portal wall
    if (spanX <= spanZ) {
      // Wall is mostly in Z — faces are on ±X
      tx = botPos.x < cx ? minX + 0.5 : maxX + 0.5;
      // Keep Y in the lower-middle of the opening (easier to walk into)
      ty = minY + Math.min(2.0, (maxY - minY) * 0.4) + 0.5;
    } else {
      // Wall is mostly in X — faces are on ±Z
      tz = botPos.z < cz ? minZ + 0.5 : maxZ + 0.5;
      ty = minY + Math.min(2.0, (maxY - minY) * 0.4) + 0.5;
    }
  }

  const dist = botPos
    ? Math.hypot(botPos.x - tx, botPos.y - ty, botPos.z - tz)
    : minDistance(clusterPortals);

  return {
    ...clusterPortals[0],
    position: { x: tx, y: ty, z: tz },
    distance: dist,
  };
}

function clusterTouching(portals: PortalTarget[]): PortalTarget[][] {
  const parent = portals.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root] !== root) root = parent[root];
    while (parent[index] !== root) {
      const next = parent[index];
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const union = (a: number, b: number) => {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent[ra] = rb;
  };

  for (let i = 0; i < portals.length; i++) {
    for (let j = i + 1; j < portals.length; j++) {
      const dx = Math.abs(portals[i].position.x - portals[j].position.x);
      const dy = Math.abs(portals[i].position.y - portals[j].position.y);
      const dz = Math.abs(portals[i].position.z - portals[j].position.z);
      if (Math.max(dx, dy, dz) <= 1) union(i, j);
    }
  }

  const groups = new Map<number, PortalTarget[]>();
  for (let i = 0; i < portals.length; i++) {
    const root = find(i);
    const group = groups.get(root);
    if (group) group.push(portals[i]);
    else groups.set(root, [portals[i]]);
  }
  return [...groups.values()];
}

function minDistance(portals: PortalTarget[]): number {
  return portals.reduce((min, portal) => Math.min(min, portal.distance), Infinity);
}

function average(values: number[]): number {
  return values.reduce((a, b) => a + b, 0) / values.length;
}

export function looksLikePortalFrame(bot: Bot, pos: Vec3): boolean {
  const names = [
    bot.blockAt(pos)?.name,
    bot.blockAt(pos.offset(1, 0, 0))?.name,
    bot.blockAt(pos.offset(-1, 0, 0))?.name,
    bot.blockAt(pos.offset(0, 0, 1))?.name,
    bot.blockAt(pos.offset(0, 0, -1))?.name,
  ];
  return names.some((n) => n === "obsidian" || n === "crying_obsidian" || n === "nether_portal");
}
