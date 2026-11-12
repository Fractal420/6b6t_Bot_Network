/**
 * Survival thresholds and evaluation — pure logic.
 *
 * Centralises the "am I safe to keep going?" decision so the hunt controller, the auto-log guard and the
 * notifier all speak the same language, and so a single low-health reading cannot be interpreted three
 * different ways by three modules.
 */

export interface SurvivalSnapshot {
  health: number;
  food: number;
  /** Remaining durability of the worn elytra, or -1 when none is worn. */
  elytraRemaining: number;
  /** Lowest remaining durability among worn armour pieces, or -1 when nothing is worn. */
  armorRemaining: number;
  /** Number of totems of undying carried (main inventory). */
  totems: number;
  /** Total food items carried. */
  foodItems: number;
  /** Total firework rockets carried. */
  fireworks: number;
  /** Free inventory slots. */
  freeSlots: number;
  /** Whether the bot is currently gliding. */
  gliding: boolean;
}

export interface SurvivalThresholds {
  minHealth: number;
  minFood: number;
  minElytraDurability: number;
  minArmorDurability: number;
  /** Totems below this count are a warning while gliding. */
  minTotems: number;
  /** Food items below this count are a warning. */
  minFoodItems: number;
  /** Fireworks below this count are a warning when the mode needs them. */
  minFireworks: number;
  /** Free slots below this count are a warning. */
  minFreeSlots: number;
  /** Disconnect (auto-log) when health drops to this or below. */
  disconnectHealth: number;
}

export const DEFAULT_THRESHOLDS: SurvivalThresholds = {
  minHealth: 12,
  minFood: 8,
  minElytraDurability: 16,
  minArmorDurability: 20,
  minTotems: 1,
  minFoodItems: 6,
  minFireworks: 0,
  minFreeSlots: 2,
  disconnectHealth: 6,
};

export type Concern =
  | "low-health"
  | "low-food"
  | "elytra-worn"
  | "armor-worn"
  | "no-totem"
  | "no-food"
  | "no-fireworks"
  | "inventory-full";

export type SurvivalVerdict = "ok" | "warn" | "critical";

export interface SurvivalReport {
  verdict: SurvivalVerdict;
  concerns: Concern[];
  /** Human-readable one-liners for chat / webhook / HUD. */
  notes: string[];
  /** True when the bot should stop exploring and return to safety. */
  shouldReturn: boolean;
  /** True when the bot should disconnect immediately (auto-log). */
  shouldDisconnect: boolean;
}

/** Evaluates a snapshot against thresholds. Pure; no side effects. */
export function evaluateSurvival(
  snap: SurvivalSnapshot,
  t: SurvivalThresholds = DEFAULT_THRESHOLDS,
): SurvivalReport {
  const concerns: Concern[] = [];
  const notes: string[] = [];

  if (snap.health <= t.disconnectHealth) {
    concerns.push("low-health");
    notes.push(`health ${snap.health} at or below the disconnect threshold (${t.disconnectHealth})`);
  } else if (snap.health <= t.minHealth) {
    concerns.push("low-health");
    notes.push(`health ${snap.health} below the safe minimum (${t.minHealth})`);
  }

  if (snap.food <= t.minFood) {
    concerns.push("low-food");
    notes.push(`hunger ${snap.food} below the safe minimum (${t.minFood})`);
  }

  if (snap.elytraRemaining >= 0 && snap.elytraRemaining < t.minElytraDurability) {
    concerns.push("elytra-worn");
    notes.push(`elytra durability ${snap.elytraRemaining} below the minimum (${t.minElytraDurability})`);
  }

  if (snap.armorRemaining >= 0 && snap.armorRemaining < t.minArmorDurability) {
    concerns.push("armor-worn");
    notes.push(`armour durability ${snap.armorRemaining} below the minimum (${t.minArmorDurability})`);
  }

  if (snap.totems < t.minTotems) {
    concerns.push("no-totem");
    notes.push(`carrying ${snap.totems} totems, wanted at least ${t.minTotems}`);
  }

  if (snap.foodItems < t.minFoodItems) {
    concerns.push("no-food");
    notes.push(`carrying ${snap.foodItems} food items, wanted at least ${t.minFoodItems}`);
  }

  if (snap.fireworks < t.minFireworks) {
    concerns.push("no-fireworks");
    notes.push(`carrying ${snap.fireworks} fireworks, wanted at least ${t.minFireworks}`);
  }

  if (snap.freeSlots < t.minFreeSlots) {
    concerns.push("inventory-full");
    notes.push(`${snap.freeSlots} free inventory slots, wanted at least ${t.minFreeSlots}`);
  }

  const shouldDisconnect = snap.health <= t.disconnectHealth;
  // A worn elytra or an empty inventory while airborne is a genuine "come home" signal; a low food count is
  // not, so return is reserved for the concerns that can strand the bot far from base.
  const shouldReturn =
    concerns.includes("low-health") ||
    concerns.includes("elytra-worn") ||
    (snap.gliding && concerns.includes("no-totem")) ||
    concerns.includes("inventory-full");

  const verdict: SurvivalVerdict = shouldDisconnect
    ? "critical"
    : concerns.length > 0
      ? "warn"
      : "ok";

  return { verdict, concerns, notes, shouldReturn, shouldDisconnect };
}
