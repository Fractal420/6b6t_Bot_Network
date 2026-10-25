import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import type { VoxelEntity, VoxelField } from "../api/types.ts";

const AIR = new Set(["air", "cave_air", "void_air", "structure_void", "light"]);
const MAX_CELLS_FULL = 14_000;
const MAX_CELLS_LITE = 3_500;

export type VoxelQuality = "full" | "lite";

export interface VoxelSampleOptions {
  radius?: number;
  /** full = every block; lite = every 2nd block + fewer cells (far less bandwidth). */
  quality?: VoxelQuality;
}

function nameAt(bot: Bot, x: number, y: number, z: number): string {
  try {
    return bot.blockAt(new Vec3(x, y, z))?.name ?? "air";
  } catch {
    return "air";
  }
}

function isAir(name: string): boolean {
  return AIR.has(name);
}

function occludes(name: string): boolean {
  if (isAir(name)) return false;
  if (name.includes("glass") || name.includes("leaves") || name.includes("pane")) return false;
  if (name.includes("portal") || name.includes("sign") || name.includes("torch")) return false;
  if (name === "fire" || name === "soul_fire" || name === "barrier" || name === "vine") return false;
  if (name === "water" || name === "lava" || name === "bubble_column" || name === "kelp") return false;
  if (name.endsWith("_carpet") || name.endsWith("_pressure_plate") || name.endsWith("_button")) return false;
  return true;
}

export function clampVoxelRadius(raw: unknown, fallback = 20, quality: VoxelQuality = "full"): number {
  const n = typeof raw === "number" ? raw : Number(raw);
  const base = Number.isFinite(n) ? n : fallback;
  if (quality === "lite") {
    // Lite stays tight around the bot — enough to see threats / portals
    return Math.min(16, Math.max(6, Math.round(base)));
  }
  return Math.min(28, Math.max(8, Math.round(base)));
}

export function sampleVoxels(bot: Bot, radiusOrOpts: number | VoxelSampleOptions = 20): VoxelField {
  const opts: VoxelSampleOptions =
    typeof radiusOrOpts === "number" ? { radius: radiusOrOpts, quality: "full" } : radiusOrOpts || {};
  const quality: VoxelQuality = opts.quality === "lite" ? "lite" : "full";
  const step = quality === "lite" ? 2 : 1;
  const maxCells = quality === "lite" ? MAX_CELLS_LITE : MAX_CELLS_FULL;
  const r = clampVoxelRadius(opts.radius ?? 20, quality === "lite" ? 12 : 20, quality);
  const pos = bot.entity?.position;
  const yDown = Math.max(quality === "lite" ? 4 : 6, Math.round(r * (quality === "lite" ? 0.35 : 0.45)));
  const yUp = Math.max(quality === "lite" ? 5 : 8, Math.round(r * (quality === "lite" ? 0.45 : 0.6)));
  const ox = pos ? Math.floor(pos.x) - r : 0;
  const oy = pos ? Math.floor(pos.y) - yDown : 0;
  const oz = pos ? Math.floor(pos.z) - r : 0;
  const sx = r * 2 + 1;
  const sy = yDown + yUp + 1;
  const sz = sx;
  const volume = new Array<string>(sx * sy * sz);
  const index = (ix: number, iy: number, iz: number) => ix + iz * sx + iy * sx * sz;

  if (pos) {
    for (let iy = 0; iy < sy; iy += step) {
      for (let iz = 0; iz < sz; iz += step) {
        for (let ix = 0; ix < sx; ix += step) {
          const name = nameAt(bot, ox + ix, oy + iy, oz + iz);
          volume[index(ix, iy, iz)] = name;
          // Fill the step cube so surface culling still works on a coarse grid
          if (step > 1) {
            for (let dy = 0; dy < step && iy + dy < sy; dy++) {
              for (let dz = 0; dz < step && iz + dz < sz; dz++) {
                for (let dx = 0; dx < step && ix + dx < sx; dx++) {
                  if (dx === 0 && dy === 0 && dz === 0) continue;
                  volume[index(ix + dx, iy + dy, iz + dz)] = name;
                }
              }
            }
          }
        }
      }
    }
  }

  const at = (ix: number, iy: number, iz: number): string => {
    if (ix < 0 || iy < 0 || iz < 0 || ix >= sx || iy >= sy || iz >= sz) return "air";
    return volume[index(ix, iy, iz)] ?? "air";
  };

  const palette: string[] = [];
  const palIndex = new Map<string, number>();
  const take = (name: string): number => {
    const existing = palIndex.get(name);
    if (existing !== undefined) return existing;
    const next = palette.length;
    palette.push(name);
    palIndex.set(name, next);
    return next;
  };

  const scored: { cell: [number, number, number, number]; dist: number }[] = [];
  const cx = r;
  const cy = pos ? Math.floor(pos.y) - oy : Math.floor(sy / 2);
  const cz = r;

  if (pos) {
    // Emit only on the step lattice so payload stays small in lite mode
    for (let iy = 0; iy < sy; iy += step) {
      for (let iz = 0; iz < sz; iz += step) {
        for (let ix = 0; ix < sx; ix += step) {
          const name = at(ix, iy, iz);
          if (isAir(name)) continue;
          const n0 = at(ix - step, iy, iz);
          const n1 = at(ix + step, iy, iz);
          const n2 = at(ix, iy - step, iz);
          const n3 = at(ix, iy + step, iz);
          const n4 = at(ix, iy, iz - step);
          const n5 = at(ix, iy, iz + step);
          const neighbors = [n0, n1, n2, n3, n4, n5];
          const buried = neighbors.every((n) => occludes(n) || n === name);
          if (buried && occludes(name)) continue;
          if (buried && (name === "water" || name === "lava")) continue;
          const dx = ix - cx;
          const dy = iy - cy;
          const dz = iz - cz;
          scored.push({
            cell: [ix, iy, iz, take(name)],
            dist: dx * dx + dy * dy + dz * dz,
          });
        }
      }
    }
    scored.sort((a, b) => a.dist - b.dist);
  }

  const kept = scored.slice(0, maxCells);
  const cells = new Array<number>(kept.length * 4);
  for (let i = 0; i < kept.length; i++) {
    const [lx, ly, lz, pi] = kept[i]!.cell;
    const o = i * 4;
    cells[o] = lx;
    cells[o + 1] = ly;
    cells[o + 2] = lz;
    cells[o + 3] = pi;
  }

  return {
    at: new Date().toISOString(),
    ox,
    oy,
    oz,
    sx,
    sy,
    sz,
    palette,
    cells,
    entities: collectEntities(bot),
  };
}

function collectEntities(bot: Bot): VoxelEntity[] {
  const out: VoxelEntity[] = [];
  const self = bot.entity;
  if (self?.position) {
    out.push({
      name: bot.username,
      kind: "bot",
      x: round(self.position.x),
      y: round(self.position.y),
      z: round(self.position.z),
      yaw: self.yaw,
    });
  }
  const loaded = bot.entities ?? {};
  const players = Object.values(bot.players)
    .filter((player) => {
      if (player.username === bot.username) return false;
      const entity = player.entity;
      if (!entity?.position) return false;
      // Must still be in the loaded entity map (not a left-behind ghost)
      if (entity.id == null || loaded[entity.id] !== entity) return false;
      return true;
    })
    .map((player) => {
      const p = player.entity!.position;
      const origin = self?.position;
      return {
        player,
        dist: origin ? origin.distanceTo(p) : 0,
      };
    })
    .filter((row) => row.dist <= 192)
    .sort((a, b) => a.dist - b.dist)
    .slice(0, 40);

  for (const { player } of players) {
    const p = player.entity!.position;
    out.push({
      name: player.username,
      kind: "player",
      x: round(p.x),
      y: round(p.y),
      z: round(p.z),
      yaw: player.entity?.yaw,
    });
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}
