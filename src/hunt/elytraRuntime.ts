/**
 * Live elytra management: reading the worn elytra and swapping in the healthiest spare.
 *
 * This is the single owner of elytra replacement for the hunt controller. It never touches the hotbar or
 * drops anything — a replacement is a straight `equip` of an item already in the inventory.
 */

import type { Bot } from "mineflayer";
import { bestSlot, durabilityPercent, remainingDurability, shouldReplace } from "./flight.ts";

export interface ElytraStatus {
  equipped: boolean;
  remaining: number;
  max: number;
  percent: number;
  /** Count of usable spare elytras in the inventory (excludes the worn one). */
  spares: number;
  /** Remaining durability of the healthiest spare, or -1 when there is none. */
  bestSpareRemaining: number;
  /** Registry slot of the worn elytra, or -1. */
  torsoSlot: number;
}

interface DurabilityItem {
  name?: string;
  durabilityUsed?: number;
  maxDurability?: number;
  slot?: number;
}

function remainingOf(item: DurabilityItem | null | undefined): number {
  if (!item || item.name !== "elytra") return -1;
  const max = item.maxDurability ?? 432;
  const used = item.durabilityUsed ?? 0;
  return remainingDurability(max, used);
}

function torsoSlotOf(bot: Bot): number {
  try {
    return bot.getEquipmentDestSlot("torso");
  } catch {
    return -1;
  }
}

/** Reads the worn elytra's state plus a count of usable spares. Never throws. */
export function readElytraStatus(bot: Bot): ElytraStatus {
  let torsoSlot = -1;
  let worn: DurabilityItem | null = null;
  try {
    torsoSlot = torsoSlotOf(bot);
    worn = torsoSlot >= 0 ? (bot.inventory.slots[torsoSlot] as DurabilityItem | null) : null;
  } catch {
    worn = null;
  }

  const remaining = remainingOf(worn);
  const equipped = remaining >= 0;
  const max = worn?.maxDurability ?? 432;

  let spares = 0;
  let bestSpareRemaining = -1;
  try {
    const slots = bot.inventory.slots;
    for (let slot = 0; slot < slots.length; slot++) {
      if (slot === torsoSlot) continue;
      const item = slots[slot] as DurabilityItem | null;
      const rem = remainingOf(item);
      if (rem < 0) continue;
      spares += 1;
      if (rem > bestSpareRemaining) bestSpareRemaining = rem;
    }
  } catch {
    /* ignore */
  }

  return {
    equipped,
    remaining,
    max,
    percent: equipped ? durabilityPercent(remaining, max) : 0,
    spares,
    bestSpareRemaining,
    torsoSlot,
  };
}

/** True when the worn elytra should be swapped for a fresh spare now. */
export function needsReplacement(status: ElytraStatus, threshold: number): boolean {
  return status.equipped && shouldReplace(status.remaining, threshold) && status.bestSpareRemaining >= 0;
}

/**
 * Equips the healthiest elytra at or above `minimum`. Returns the remaining durability equipped, or -1 when
 * nothing suitable was found. The worn elytra is left alone if it is already the best.
 */
export async function equipBestElytra(bot: Bot, minimum: number): Promise<number> {
  const torsoSlot = torsoSlotOf(bot);
  const candidates: DurabilityItem[] = [];
  try {
    const slots = bot.inventory.slots;
    for (let slot = 0; slot < slots.length; slot++) {
      const item = slots[slot] as DurabilityItem | null;
      if (!item || item.name !== "elytra") continue;
      const remaining = remainingOf(item);
      if (remaining < 0) continue;
      candidates.push({ ...item, slot });
    }
  } catch {
    return -1;
  }

  const remainingBySlot = candidates.map((c) => remainingOf(c));
  const pick = bestSlot(remainingBySlot, minimum);
  if (pick < 0) return -1;

  const chosen = candidates[pick];
  const worn = torsoSlot >= 0 ? (bot.inventory.slots[torsoSlot] as DurabilityItem | null) : null;
  if (chosen.slot === torsoSlot) return remainingOf(worn);

  const item = bot.inventory.slots[chosen.slot!] as Parameters<Bot["equip"]>[0];
  try {
    await bot.equip(item, "torso");
    return remainingOf(chosen);
  } catch {
    return -1;
  }
}
