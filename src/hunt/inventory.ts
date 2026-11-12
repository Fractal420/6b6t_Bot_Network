/**
 * Inventory classification for ender-chest and inventory organisation.
 *
 * Classification is driven by item id names rather than a hardcoded list of every block, so new items from a
 * Minecraft update fall into "other" instead of breaking, and the "valuable" set can be tuned without a code
 * change.
 */

export type ItemCategory =
  | "elytra"
  | "armor"
  | "tools"
  | "fireworks"
  | "food"
  | "totems"
  | "xp-supplies"
  | "building-blocks"
  | "utility"
  | "spare-equipment"
  | "valuable"
  | "other";

/**
 * Files an item by its registry path (e.g. "diamond_chestplate").
 *
 * Ordering matters: the more specific rules run before the general ones, so a diamond chestplate is armour
 * rather than being swept up by the "valuable" rule.
 */
export function classifyItem(itemId: string): ItemCategory {
  const id = (itemId || "").trim().toLowerCase();
  if (!id) return "other";

  if (id.includes("elytra")) return "elytra";

  if (
    id.endsWith("_helmet") ||
    id.endsWith("_chestplate") ||
    id.endsWith("_leggings") ||
    id.endsWith("_boots") ||
    id === "turtle_helmet" ||
    id.endsWith("_horse_armor") ||
    id === "shield" ||
    id === "wolf_armor"
  ) {
    return "armor";
  }

  if (id === "firework_rocket") return "fireworks";
  if (id === "totem_of_undying") return "totems";
  if (id.includes("experience_bottle") || id === "enchanted_book") return "xp-supplies";

  if (
    id.endsWith("_sword") ||
    id.endsWith("_pickaxe") ||
    id.endsWith("_axe") ||
    id.endsWith("_shovel") ||
    id.endsWith("_hoe") ||
    id === "bow" ||
    id === "crossbow" ||
    id === "trident" ||
    id === "fishing_rod" ||
    id === "shears" ||
    id === "flint_and_steel" ||
    id === "mace"
  ) {
    return "tools";
  }

  if (isFood(id)) return "food";
  if (isBuildingBlock(id)) return "building-blocks";
  if (isUtility(id)) return "utility";
  if (isValuable(id)) return "valuable";
  return "other";
}

function isFood(id: string): boolean {
  return (
    [
      "cooked_beef",
      "cooked_porkchop",
      "cooked_chicken",
      "cooked_mutton",
      "cooked_salmon",
      "cooked_cod",
      "bread",
      "golden_carrot",
      "golden_apple",
      "enchanted_golden_apple",
      "baked_potato",
      "apple",
      "honey_bottle",
    ].includes(id) || id.endsWith("_stew")
  );
}

function isBuildingBlock(id: string): boolean {
  return (
    id.endsWith("_planks") ||
    id.endsWith("_log") ||
    id.endsWith("_wood") ||
    id.endsWith("_concrete") ||
    id.endsWith("_concrete_powder") ||
    id.endsWith("_terracotta") ||
    id.endsWith("_wool") ||
    id.endsWith("_carpet") ||
    id.endsWith("_glass") ||
    id.endsWith("_glass_pane") ||
    id.endsWith("_bricks") ||
    id.endsWith("_stairs") ||
    id.endsWith("_slab") ||
    id.endsWith("_wall") ||
    id.endsWith("_fence") ||
    id.endsWith("_fence_gate") ||
    id.endsWith("_door") ||
    id.endsWith("_trapdoor") ||
    [
      "stone",
      "cobblestone",
      "dirt",
      "grass_block",
      "sand",
      "gravel",
      "netherrack",
      "end_stone",
      "deepslate",
      "tuff",
      "calcite",
      "diorite",
      "granite",
      "andesite",
      "scaffolding",
      "torch",
      "glowstone",
      "sea_lantern",
      "shroomlight",
    ].includes(id)
  );
}

function isUtility(id: string): boolean {
  return (
    id === "shulker_box" ||
    id.endsWith("_shulker_box") ||
    [
      "ender_chest",
      "ender_pearl",
      "ender_eye",
      "chest",
      "barrel",
      "water_bucket",
      "lava_bucket",
      "bucket",
      "crafting_table",
      "anvil",
      "grindstone",
      "enchanting_table",
      "respawn_anchor",
      "obsidian",
      "crying_obsidian",
      "end_crystal",
      "tnt",
      "bed",
    ].includes(id) ||
    id.endsWith("_bed")
  );
}

function isValuable(id: string): boolean {
  return (
    id.endsWith("_ingot") ||
    id.endsWith("_nugget") ||
    id.endsWith("_ore") ||
    id.endsWith("_skull") ||
    id.endsWith("_head") ||
    [
      "diamond",
      "emerald",
      "netherite_scrap",
      "ancient_debris",
      "nether_star",
      "dragon_egg",
      "echo_shard",
      "heart_of_the_sea",
      "nautilus_shell",
      "wither_skeleton_skull",
      "gunpowder",
      "blaze_rod",
      "ghast_tear",
      "shulker_shell",
      "beacon",
      "conduit",
      "trident",
      "totem_of_undying",
      "enchanted_golden_apple",
      "netherite_ingot",
      "netherite_block",
      "diamond_block",
      "emerald_block",
      "gold_block",
      "iron_block",
    ].includes(id)
  );
}

/** True when losing this item is serious enough that it must never be auto-dropped. */
export function isPrecious(category: ItemCategory): boolean {
  return (
    category === "elytra" ||
    category === "armor" ||
    category === "tools" ||
    category === "totems" ||
    category === "valuable" ||
    category === "spare-equipment" ||
    category === "xp-supplies"
  );
}

/** All categories, in a stable order for config and UI. */
export const ITEM_CATEGORIES: ItemCategory[] = [
  "elytra",
  "armor",
  "tools",
  "fireworks",
  "food",
  "totems",
  "xp-supplies",
  "building-blocks",
  "utility",
  "spare-equipment",
  "valuable",
  "other",
];
