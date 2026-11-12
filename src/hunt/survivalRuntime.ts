/**
 * Live survival snapshot: reads the bot's health, hunger, equipment and inventory into a
 * {@link SurvivalSnapshot} that the pure evaluator can judge.
 */

import type { Bot } from "mineflayer";
import { classifyItem } from "./inventory.ts";
import type { SurvivalSnapshot } from "./survival.ts";

interface DurabilityItem {
  name?: string;
  durabilityUsed?: number;
  maxDurability?: number;
}

function remaining(item: DurabilityItem | null | undefined): number {
  if (!item || !item.name || !item.maxDurability) return -1;
  const used = item.durabilityUsed ?? 0;
  return Math.max(0, item.maxDurability - used);
}

function armorSlots(bot: Bot): DurabilityItem[] {
  const out: DurabilityItem[] = [];
  for (const dest of ["head", "torso", "legs", "feet"] as const) {
    try {
      const slot = bot.getEquipmentDestSlot(dest);
      const item = bot.inventory.slots[slot] as DurabilityItem | null;
      if (item) out.push(item);
    } catch {
      /* ignore */
    }
  }
  return out;
}

/** Builds a snapshot from the live bot. Returns `null` when the bot is not connected. */
export function readSurvivalSnapshot(bot: Bot): SurvivalSnapshot | null {
  if (!bot?.entity) return null;

  const health = typeof bot.health === "number" ? bot.health : 20;
  const food = typeof bot.food === "number" ? bot.food : 20;

  let elytraRemaining = -1;
  let armorRemaining = -1;
  try {
    const torsoSlot = bot.getEquipmentDestSlot("torso");
    const worn = bot.inventory.slots[torsoSlot] as DurabilityItem | null;
    if (worn?.name === "elytra") elytraRemaining = remaining(worn);
    const wornArmor = armorSlots(bot).filter((a) => a.name !== "elytra");
    if (wornArmor.length) armorRemaining = Math.min(...wornArmor.map((a) => remaining(a)).filter((r) => r >= 0));
    if (armorRemaining < 0 && wornArmor.length) armorRemaining = 0;
  } catch {
    /* ignore */
  }

  let totems = 0;
  let foodItems = 0;
  let fireworks = 0;
  let freeSlots = 0;
  try {
    const slots = bot.inventory.slots;
    for (const raw of slots) {
      const item = raw as { name?: string; count?: number } | null;
      if (!item || !item.name) {
        freeSlots += 1;
        continue;
      }
      const count = item.count ?? 1;
      const category = classifyItem(item.name);
      if (category === "totems") totems += count;
      else if (category === "food") foodItems += count;
      else if (category === "fireworks") fireworks += count;
    }
  } catch {
    /* ignore */
  }

  let gliding = false;
  try {
    gliding = Boolean(bot.entity.elytraFlying);
  } catch {
    gliding = false;
  }

  return {
    health,
    food,
    elytraRemaining,
    armorRemaining,
    totems,
    foodItems,
    fireworks,
    freeSlots,
    gliding,
  };
}

/**
 * Heuristic for whether the bot has a legitimate XP source available.
 *
 * XP is only "available" when there are actually XP orbs nearby, or the bot is carrying bottles o' enchanting
 * it can throw. This deliberately does not claim XP from "there are mobs around" — repairing must be driven by
 * a real source, not a guess.
 */
export function hasXpSource(bot: Bot, orbRadius = 12): boolean {
  try {
    const pos = bot.entity?.position;
    if (!pos) return false;
    const orbs = Object.values(bot.entities ?? {}).filter((e) => e?.name === "experience_orb");
    for (const orb of orbs) {
      const p = (orb as { position?: { distanceTo?: (v: unknown) => number } }).position;
      if (p && typeof p.distanceTo === "function" && p.distanceTo(pos) <= orbRadius) return true;
    }
    // Bottles o' enchanting count as a source the bot can use on itself.
    return countItem(bot, "experience_bottle") > 0;
  } catch {
    return false;
  }
}

/** Total count of an item across the inventory. */
export function countItem(bot: Bot, name: string): number {
  let total = 0;
  try {
    for (const raw of bot.inventory.slots) {
      const item = raw as { name?: string; count?: number } | null;
      if (item?.name === name) total += item.count ?? 1;
    }
  } catch {
    /* ignore */
  }
  return total;
}
