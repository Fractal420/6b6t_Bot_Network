import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { WorldKind } from "../../api/types.ts";

export interface WorldContext {
  authenticated: boolean;
  serverPortalsEntered: number;
  requiredServerPortals: number;
  /** Set when server chat confirms main join (e.g. "You're now playing on …"). */
  mainConfirmed?: boolean;
}

export interface IslandScan {
  solid: number;
  water: number;
  airish: number;
  looksLikeIsland: boolean;
}

function nameAt(bot: Bot, x: number, y: number, z: number): string {
  try {
    return bot.blockAt(new Vec3(x, y, z))?.name ?? "air";
  } catch {
    return "air";
  }
}

export function scanIsland(bot: Bot, pos: { x: number; y: number; z: number }, radius = 28): IslandScan {
  const ox = Math.floor(pos.x);
  const oy = Math.floor(pos.y);
  const oz = Math.floor(pos.z);
  let solid = 0;
  let water = 0;
  let airish = 0;

  for (let dx = -radius; dx <= radius; dx += 2) {
    for (let dz = -radius; dz <= radius; dz += 2) {
      const ground = nameAt(bot, ox + dx, oy - 1, oz + dz);
      const feet = nameAt(bot, ox + dx, oy, oz + dz);
      const sample = ground === "air" ? feet : ground;
      if (sample.includes("water") || sample === "kelp" || sample === "seagrass") water += 1;
      else if (sample === "air" || sample === "cave_air" || sample === "void_air") airish += 1;
      else solid += 1;
    }
  }

  const total = solid + water + airish || 1;
  const waterIsland = water / total > 0.28 && solid < 350 && solid > 8;
  const voidIsland = airish / total > 0.45 && solid < 280 && solid > 4;
  return { solid, water, airish, looksLikeIsland: waterIsland || voidIsland };
}

/**
 * Prefer 6b6t-join-bot signals when available:
 * - main = Fox (FasterVelocity), survival, ~1000 slots
 * - lobby = Paper, adventure, large slot counts
 * - backup/queue = Limbo / 1 slot
 * Then fall back to dimension / island / portal heuristics.
 * Does not rely on absolute world coordinates (those change).
 */
export function classifyWorld(bot: Bot, ctx: WorldContext): WorldKind {
  const dimension = String(bot.game?.dimension ?? "").toLowerCase();
  const pos = bot.entity?.position;
  const island = pos ? scanIsland(bot, pos) : undefined;
  const inEnd = dimension.includes("the_end") || dimension.endsWith(":the_end");
  const inNether = dimension.includes("nether");
  const gameMode = String(bot.game?.gameMode ?? "").toLowerCase();
  const adventure = gameMode === "adventure" || gameMode === "1";
  const survival = gameMode === "survival" || gameMode === "0";
  const slots = Number(bot.game?.maxPlayers ?? 0);
  const brand = String(
    (bot as { brand?: string }).brand ||
      (bot as { _client?: { brand?: string } })._client?.brand ||
      "",
  ).toLowerCase();

  // Chat / explicit main confirmation (e.g. "You're now playing on worker-…")
  if (ctx.mainConfirmed && ctx.authenticated) {
    if (inNether) return "nether";
    if (inEnd && !adventure) return "end";
    return "overworld";
  }

  // Queue / limbo
  if (/limbo|picolimbo/i.test(brand) || (slots === 1 && adventure)) {
    return "backup";
  }

  // 6b6t main backend brand (from packet log: switches Paper → Fox on final hop)
  if (/^fox\b/i.test(brand) && ctx.authenticated) {
    if (inNether) return "nether";
    if (inEnd) return "end";
    return "overworld";
  }

  // Classic main: survival + ~1000 slots
  if (ctx.authenticated && survival && slots >= 800 && slots <= 1500) {
    if (!inNether && !inEnd) return "overworld";
  }

  // Lobby proxy brand (Paper FasterVelocity) while still adventure
  if (/^paper\b/i.test(brand) || (adventure && slots >= 5000)) {
    if (!ctx.authenticated && inEnd) return "auth";
    return "lobby";
  }

  if (inNether) {
    if (ctx.serverPortalsEntered < ctx.requiredServerPortals && (island?.looksLikeIsland || adventure)) {
      return "lobby";
    }
    return "nether";
  }

  if (inEnd) {
    if (!ctx.authenticated) return "auth";
    // Adventure End = intermediate lobby hop, not the real end dimension on main
    if (adventure) return "lobby";
    return "end";
  }

  if (!ctx.authenticated) return "auth";
  if (!adventure && survival && slots >= 800) return "overworld";
  if (!adventure) return "overworld";

  // Still in join sequence
  if (adventure && pos && pos.y > 90) return "lobby";
  if (
    ctx.serverPortalsEntered < ctx.requiredServerPortals &&
    (island?.looksLikeIsland || (adventure && pos && pos.y > 80))
  ) {
    return "lobby";
  }

  if (ctx.serverPortalsEntered >= ctx.requiredServerPortals && !adventure) return "overworld";
  if (!adventure && pos && pos.y < 90) return "overworld";

  if (island?.looksLikeIsland) return "lobby";

  const game = bot.game as { worldBorder?: { diameter?: number; size?: number } } | undefined;
  const border = game?.worldBorder?.diameter ?? game?.worldBorder?.size;
  if (typeof border === "number" && border > 2_000 && !adventure) return "overworld";

  return ctx.serverPortalsEntered > 0 && !adventure ? "overworld" : "lobby";
}

export function isMainWorld(kind: WorldKind): boolean {
  return kind === "overworld" || kind === "nether" || kind === "end";
}

export function isLobbyLike(kind: WorldKind): boolean {
  return kind === "auth" || kind === "lobby" || kind === "backup";
}
