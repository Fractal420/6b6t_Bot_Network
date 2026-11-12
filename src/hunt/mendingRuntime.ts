/**
 * Live Mending management: finds damaged Mending gear and holds the right item while XP is collected.
 *
 * Armour and the elytra repair in place while worn, so for those the "action" is simply to be near the XP —
 * no swap is needed. Tools and weapons repair only while held, so those are equipped to the hand. XP is never
 * fabricated: the caller must have confirmed a real source with {@link hasXpSource}.
 */

import type { Bot } from "mineflayer";
import { rankCandidates, type MendingCandidate } from "./mending.ts";

interface ItemLike {
  name?: string;
  slot?: number;
  durabilityUsed?: number;
  maxDurability?: number;
  enchants?: Array<{ name?: string }>;
}

function hasMending(item: ItemLike): boolean {
  try {
    return (item.enchants ?? []).some((e) => typeof e.name === "string" && e.name.includes("mending"));
  } catch {
    return false;
  }
}

function candidateFrom(item: ItemLike, equipped: boolean, weight: number): MendingCandidate | null {
  if (!item?.name || !item.maxDurability || !hasMending(item)) return null;
  const remaining = Math.max(0, item.maxDurability - (item.durabilityUsed ?? 0));
  return {
    name: item.name,
    slot: item.slot ?? -1,
    remaining,
    maxDamage: item.maxDurability,
    equipped,
    priorityWeight: weight,
  };
}

/** Per-item-name priority weights, from config. Missing names default to 0. */
export type MendingWeights = Record<string, number>;

/**
 * Collects damaged Mending items from worn armour plus the main inventory. Tools and weapons in the hotbar are
 * included so they can be held; the offhand and armour slots are treated as equipped.
 */
export function readMendingCandidates(bot: Bot, weights: MendingWeights = {}): MendingCandidate[] {
  const out: MendingCandidate[] = [];
  const weightFor = (name: string): number => weights[name] ?? 0;

  try {
    for (const dest of ["head", "torso", "legs", "feet", "off-hand"] as const) {
      const slot = bot.getEquipmentDestSlot(dest);
      const item = bot.inventory.slots[slot] as ItemLike | null;
      const candidate = item ? candidateFrom({ ...item, slot }, true, weightFor(item.name ?? "")) : null;
      if (candidate) out.push(candidate);
    }
  } catch {
    /* ignore */
  }

  try {
    const slots = bot.inventory.slots;
    for (let slot = 0; slot < slots.length; slot++) {
      const item = slots[slot] as ItemLike | null;
      if (!item?.name) continue;
      // Skip the armour/offhand region; those were handled as equipped above.
      if (isArmorSlot(bot, slot)) continue;
      const candidate = candidateFrom({ ...item, slot }, false, weightFor(item.name));
      if (candidate) out.push(candidate);
    }
  } catch {
    /* ignore */
  }

  return out;
}

function isArmorSlot(bot: Bot, slot: number): boolean {
  try {
    for (const dest of ["head", "torso", "legs", "feet", "off-hand"] as const) {
      if (bot.getEquipmentDestSlot(dest) === slot) return true;
    }
  } catch {
    /* ignore */
  }
  return false;
}

export interface MendingTarget {
  candidate: MendingCandidate;
  /** True when the item must be held in the hand to repair (tools/weapons). */
  mustHold: boolean;
}

/** The highest priority damaged Mending item, or `null` when nothing needs repair. */
export function selectMendingTarget(bot: Bot, weights: MendingWeights = {}): MendingTarget | null {
  const ranked = rankCandidates(readMendingCandidates(bot, weights));
  if (!ranked.length) return null;
  const candidate = ranked[0];
  return { candidate, mustHold: !candidate.equipped };
}

/** Equips the target item to the hand so it repairs while XP is collected. */
export async function holdForMending(bot: Bot, target: MendingTarget): Promise<boolean> {
  if (!target.mustHold || target.candidate.slot < 0) return true;
  try {
    const item = bot.inventory.slots[target.candidate.slot] as Parameters<Bot["equip"]>[0];
    if (!item) return false;
    await bot.equip(item, "hand");
    return true;
  } catch {
    return false;
  }
}
