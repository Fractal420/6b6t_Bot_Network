/**
 * Live Ender Chest management: find one nearby, walk to it, open it through the normal interaction path, and
 * move items by category.
 *
 * Everything here uses ordinary client actions (`bot.pathfinder`, `bot.openContainer`, `bot.moveSlotItem`).
 * No packet tricks. The window is always closed again, even on failure, so an interrupted operation cannot
 * leave the bot stuck inside a container.
 */

import type { Bot } from "mineflayer";
import type { Block } from "prismarine-block";
import { goals } from "../minecraft/pathfinder.ts";
import { classifyItem, isPrecious, type ItemCategory } from "./inventory.ts";

export interface EnderChestLocation {
  x: number;
  y: number;
  z: number;
  distance: number;
}

/** Nearest ender chest within `radius` blocks of the bot, or `null`. */
export function findEnderChest(bot: Bot, radius = 48): EnderChestLocation | null {
  const pos = bot.entity?.position;
  if (!pos) return null;
  let best: EnderChestLocation | null = null;
  try {
    const block = bot.findBlock({
      matching: (b: Block) => b?.name === "ender_chest",
      maxDistance: radius,
    });
    if (block) {
      best = {
        x: block.position.x,
        y: block.position.y,
        z: block.position.z,
        distance: Math.hypot(block.position.x + 0.5 - pos.x, block.position.y - pos.y, block.position.z + 0.5 - pos.z),
      };
    }
  } catch {
    return null;
  }
  return best;
}

export interface EnderChestSlot {
  slot: number;
  name: string;
  count: number;
  displayName: string;
}

export interface EnderChestContents {
  title: string;
  /** Container slots only (the player inventory portion of the window is excluded). */
  slots: EnderChestSlot[];
  inventoryStart: number;
}

/**
 * Walks to an ender chest and opens it. Returns the open window's container contents, or `null` on failure.
 * The caller owns the returned handle and must call {@link closeEnderChest} when finished.
 */
export async function openEnderChest(bot: Bot, target: EnderChestLocation, reach = 3): Promise<Block | null> {
  const block = bot.blockAt({ x: target.x, y: target.y, z: target.z } as never);
  if (!block) return null;
  try {
    const distance = bot.entity?.position
      ? bot.entity.position.distanceTo(block.position.offset(0.5, 0.5, 0.5))
      : Number.POSITIVE_INFINITY;
    if (distance > reach) {
      await bot.pathfinder.goto(new goals.GoalNear(target.x, target.y, target.z, reach));
    }
    await bot.openContainer(block);
    return block;
  } catch {
    return null;
  }
}

/** Reads the currently open container window's contents. */
export function readOpenContainer(bot: Bot): EnderChestContents | null {
  const win = bot.currentWindow;
  if (!win) return null;
  const inventoryStart = typeof win.inventoryStart === "number" ? win.inventoryStart : win.slots.length;
  const slots: EnderChestSlot[] = [];
  for (let slot = 0; slot < inventoryStart; slot++) {
    const item = win.slots[slot];
    if (!item?.name) continue;
    slots.push({
      slot,
      name: item.name,
      count: item.count ?? 1,
      displayName: item.displayName || item.name,
    });
  }
  return { title: win.title || "container", slots, inventoryStart };
}

export function closeEnderChest(bot: Bot): void {
  try {
    if (bot.currentWindow) bot.closeWindow(bot.currentWindow);
  } catch {
    /* already closed */
  }
}

export interface CategoryCount {
  category: ItemCategory;
  items: number;
  stacks: number;
}

/** Counts items in the open container by category. */
export function countContainerByCategory(contents: EnderChestContents): CategoryCount[] {
  const byCategory = new Map<ItemCategory, CategoryCount>();
  for (const slot of contents.slots) {
    const category = classifyItem(slot.name);
    const entry = byCategory.get(category) ?? { category, items: 0, stacks: 0 };
    entry.items += slot.count;
    entry.stacks += 1;
    byCategory.set(category, entry);
  }
  return [...byCategory.values()].sort((a, b) => b.items - a.items);
}

export interface DepositPreview {
  move: Array<{ name: string; count: number; category: ItemCategory }>;
  keep: Array<{ name: string; count: number; category: ItemCategory; reason: string }>;
}

/**
 * Plans a deposit: every main-inventory stack whose category is in `deposit` is a move candidate, unless it is
 * needed to keep a minimum reserve. Never proposes a precious item.
 */
export function planDeposit(
  bot: Bot,
  deposit: ItemCategory[],
  reserves: Partial<Record<ItemCategory, number>> = {},
): DepositPreview {
  const wanted = new Set(deposit);
  const move: DepositPreview["move"] = [];
  const keep: DepositPreview["keep"] = [];

  const categoryTotals = new Map<ItemCategory, number>();
  const rows: Array<{ slot: number; name: string; count: number; category: ItemCategory }> = [];
  try {
    for (const raw of bot.inventory.slots) {
      const item = raw as { name?: string; count?: number; slot?: number } | null;
      if (!item?.name || item.slot == null) continue;
      const category = classifyItem(item.name);
      rows.push({ slot: item.slot, name: item.name, count: item.count ?? 1, category });
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + (item.count ?? 1));
    }
  } catch {
    return { move, keep };
  }

  const remaining = new Map(categoryTotals);
  for (const row of rows) {
    if (!wanted.has(row.category)) {
      keep.push({ name: row.name, count: row.count, category: row.category, reason: "category not selected" });
      continue;
    }
    if (isPrecious(row.category)) {
      keep.push({ name: row.name, count: row.count, category: row.category, reason: "valuable — never auto-deposited" });
      continue;
    }
    const reserve = reserves[row.category] ?? 0;
    const left = remaining.get(row.category) ?? 0;
    if (left - row.count < reserve) {
      keep.push({ name: row.name, count: row.count, category: row.category, reason: `keeping the reserve of ${reserve}` });
      continue;
    }
    move.push({ name: row.name, count: row.count, category: row.category });
    remaining.set(row.category, left - row.count);
  }

  return { move, keep };
}

export interface WithdrawPreview {
  take: Array<{ name: string; count: number; category: ItemCategory }>;
}

/** Plans a withdrawal: up to `perCategory` stacks of each selected category. */
export function planWithdraw(contents: EnderChestContents, withdraw: ItemCategory[], perCategory = 1): WithdrawPreview {
  const wanted = new Set(withdraw);
  const taken = new Map<ItemCategory, number>();
  const take: WithdrawPreview["take"] = [];
  for (const slot of contents.slots) {
    const category = classifyItem(slot.name);
    if (!wanted.has(category)) continue;
    const already = taken.get(category) ?? 0;
    if (already >= perCategory) continue;
    take.push({ name: slot.name, count: slot.count, category });
    taken.set(category, already + 1);
  }
  return { take };
}

/**
 * Executes a deposit by moving the planned stacks into the open container window.
 *
 * Items are moved from the player-inventory portion of the window into the first free container slot. The
 * per-name counts from the plan are honoured exactly, so a stack the planner kept back as a reserve is never
 * swept up by a same-named stack. Returns the number of stacks actually moved.
 */
export async function executeDeposit(bot: Bot, contents: EnderChestContents, plan: DepositPreview): Promise<number> {
  const win = bot.currentWindow;
  if (!win) return 0;
  // How many items of each name the plan still wants moved. Decrementing as we go keeps the reserve intact.
  const remaining = new Map<string, number>();
  for (const entry of plan.move) remaining.set(entry.name, (remaining.get(entry.name) ?? 0) + entry.count);

  let moved = 0;
  const invEnd = typeof win.inventoryEnd === "number" ? win.inventoryEnd : win.slots.length;
  const freeSlots: number[] = [];
  for (let slot = 0; slot < contents.inventoryStart; slot++) if (!win.slots[slot]) freeSlots.push(slot);
  let freeIndex = 0;

  for (let slot = contents.inventoryStart; slot < invEnd && freeIndex < freeSlots.length; slot++) {
    const item = win.slots[slot];
    if (!item?.name) continue;
    const want = remaining.get(item.name) ?? 0;
    if (want <= 0) continue;
    try {
      await bot.moveSlotItem(slot, freeSlots[freeIndex]);
      freeIndex += 1;
      moved += 1;
      remaining.set(item.name, want - (item.count ?? 1));
    } catch {
      /* skip this stack; keep going */
    }
  }
  return moved;
}

/** Executes a withdrawal by moving the planned container stacks into the player inventory. */
export async function executeWithdraw(bot: Bot, contents: EnderChestContents, plan: WithdrawPreview): Promise<number> {
  const win = bot.currentWindow;
  if (!win) return 0;
  const wantedNames = new Set(plan.take.map((t) => t.name));
  const invEnd = typeof win.inventoryEnd === "number" ? win.inventoryEnd : win.slots.length;
  let moved = 0;
  for (let slot = 0; slot < contents.inventoryStart; slot++) {
    const item = win.slots[slot];
    if (!item?.name || !wantedNames.has(item.name)) continue;
    // First empty player-inventory slot in this window.
    let dest = -1;
    for (let s = contents.inventoryStart; s < invEnd; s++) {
      if (!win.slots[s]) {
        dest = s;
        break;
      }
    }
    if (dest < 0) break;
    try {
      await bot.moveSlotItem(slot, dest);
      moved += 1;
    } catch {
      /* skip */
    }
  }
  return moved;
}
