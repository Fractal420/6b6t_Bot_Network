/**
 * Stash scoring and target prioritisation — pure, Minecraft-independent logic.
 *
 * A single chest is not a base. The score combines several independent indicators (container counts,
 * container type, storage density, spawners, suspicious arrangements) so an isolated chest scores low and
 * only a real concentration reaches the "confirmed" range. Kept free of mineflayer types so the thresholds
 * can be verified with `node --test` and never silently drift.
 */

export type StashTier =
  | "unconfirmed"
  | "possible"
  | "small"
  | "medium"
  | "large"
  | "major"
  | "structure";

export interface StashEvidence {
  chests: number;
  trappedChests: number;
  barrels: number;
  shulkerBoxes: number;
  enderChests: number;
  furnaces: number;
  hoppers: number;
  dispensers: number;
  spawners: number;
  beaconLike: number;
  suspiciousPatterns: number;
}

export function emptyEvidence(): StashEvidence {
  return {
    chests: 0,
    trappedChests: 0,
    barrels: 0,
    shulkerBoxes: 0,
    enderChests: 0,
    furnaces: 0,
    hoppers: 0,
    dispensers: 0,
    spawners: 0,
    beaconLike: 0,
    suspiciousPatterns: 0,
  };
}

export function containerCount(e: StashEvidence): number {
  return e.chests + e.trappedChests + e.barrels + e.shulkerBoxes + e.enderChests;
}

export function totalStorage(e: StashEvidence): number {
  return containerCount(e) + e.furnaces + e.hoppers + e.dispensers;
}

// Weights. Shulkers are worth the most because they are expensive and portable, so a pile of them is a
// strong signal of a working base rather than a mine entrance.
const W = {
  chest: 2,
  trapped: 3,
  barrel: 2,
  shulker: 8,
  enderChest: 3,
  furnace: 1,
  hopper: 2,
  dispenser: 1,
  spawner: 6,
  beacon: 10,
  pattern: 4,
};

const DENSITY_STEP = 4;
const DENSITY_MAX = 24;
const DIVERSITY_PER_TYPE = 3;
const DIVERSITY_MAX = 15;

/** Total weighted score for the evidence. Always a non-negative integer. */
export function scoreStash(e: StashEvidence): number {
  const base =
    e.chests * W.chest +
    e.trappedChests * W.trapped +
    e.barrels * W.barrel +
    e.shulkerBoxes * W.shulker +
    e.enderChests * W.enderChest +
    e.furnaces * W.furnace +
    e.hoppers * W.hopper +
    e.dispensers * W.dispenser +
    e.spawners * W.spawner +
    e.beaconLike * W.beacon +
    e.suspiciousPatterns * W.pattern;

  // Density bonus: many containers packed together are more than the sum of their parts.
  const containers = containerCount(e);
  const densityBonus = Math.min(DENSITY_MAX, (Math.max(0, containers - 2) * DENSITY_STEP) / 2);

  // Diversity bonus: a base has a mix of storage types, a lone chest does not.
  let types = 0;
  if (e.chests > 0) types++;
  if (e.trappedChests > 0) types++;
  if (e.barrels > 0) types++;
  if (e.shulkerBoxes > 0) types++;
  if (e.enderChests > 0) types++;
  if (e.furnaces > 0) types++;
  if (e.hoppers > 0) types++;
  const diversityBonus = Math.min(DIVERSITY_MAX, types * DIVERSITY_PER_TYPE);

  return base + densityBonus + diversityBonus;
}

/** Classifies a score. Thresholds are deliberately well separated. */
export function classifyStash(score: number, containers: number): StashTier {
  if (containers <= 0 && score <= 0) return "unconfirmed";
  if (score >= 400 || containers >= 120) return "major";
  if (score >= 180 || containers >= 60) return "large";
  if (score >= 80 || containers >= 24) return "medium";
  if (score >= 24 || containers >= 8) return "small";
  if (score >= 8 || containers >= 3) return "possible";
  return "unconfirmed";
}

/** Human-readable tier name, shared by CLI, API, Discord and the dashboard. */
export function describeTier(tier: StashTier): string {
  switch (tier) {
    case "unconfirmed":
      return "unconfirmed";
    case "possible":
      return "possible stash";
    case "small":
      return "small stash";
    case "medium":
      return "medium stash";
    case "large":
      return "large stash";
    case "major":
      return "major storage location";
    case "structure":
      return "interesting structure";
  }
}

/** True for the tiers worth sending an alert for. */
export function isNoteworthy(tier: StashTier): boolean {
  return tier === "medium" || tier === "large" || tier === "major" || tier === "structure";
}

/** True when a chunk should be reported at all under the given minimum thresholds. */
export function meetsThreshold(score: number, containers: number, minScore: number, minContainers: number): boolean {
  return score >= minScore || containers >= minContainers;
}

export interface TargetCandidate {
  id: string;
  score: number;
  tier: StashTier;
  /** Straight-line distance from the bot, in blocks. */
  distance: number;
  /** Recorded in an earlier session. */
  previouslyDiscovered: boolean;
  /** Number of distinct player sightings associated with this location. */
  playerSightings: number;
  /** Last time this location was observed, epoch ms. */
  lastSeenMs: number;
  /** Chunks around this location that are still unexplored, if known. */
  unexploredNeighbours: number;
}

export interface PriorityWeights {
  /** Higher means confidence matters more. */
  score: number;
  /** Higher means nearby targets are preferred. */
  distance: number;
  /** Bonus multiplier for locations seen in earlier sessions (worth re-checking). */
  rediscovery: number;
  /** Bonus per associated player sighting. */
  playerActivity: number;
  /** Bonus per unexplored neighbouring chunk (a fresh base is more interesting). */
  frontier: number;
  /** Penalty applied per day since the location was last seen (stale intel). */
  staleness: number;
}

export const DEFAULT_PRIORITY_WEIGHTS: PriorityWeights = {
  score: 1,
  distance: 0.35,
  rediscovery: 0.15,
  playerActivity: 6,
  frontier: 2,
  staleness: 0.4,
};

const DAY_MS = 86_400_000;

/**
 * Priority value for a candidate; higher means "investigate sooner".
 *
 * Confidence dominates, distance trades off against it, and the remaining terms nudge the order without ever
 * letting a low-confidence location outrank a high-confidence one by distance alone.
 */
export function targetPriority(c: TargetCandidate, nowMs: number, w: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS): number {
  const confidence = c.score * w.score;
  const proximity = (c.distance / 1000) * w.distance;
  const rediscovery = (c.previouslyDiscovered ? 1 : 0) * c.score * w.rediscovery;
  const activity = c.playerSightings * w.playerActivity;
  const frontier = c.unexploredNeighbours * w.frontier;
  const ageDays = Math.max(0, (nowMs - c.lastSeenMs) / DAY_MS);
  const staleness = ageDays * w.staleness;

  return confidence - proximity + rediscovery + activity + frontier - staleness;
}

/** Orders candidates best-first by priority. */
export function rankTargets(
  candidates: TargetCandidate[],
  nowMs: number,
  w: PriorityWeights = DEFAULT_PRIORITY_WEIGHTS,
): TargetCandidate[] {
  return [...candidates].sort((a, b) => targetPriority(b, nowMs, w) - targetPriority(a, nowMs, w));
}
