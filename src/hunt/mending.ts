/**
 * Deciding which damaged Mending item to repair next, and whether repairing is worthwhile at all.
 *
 * XP is scarce on anarchy servers, so the rule is: only repair when an XP source is actually available, and
 * repair the item that is most damaged first. An item that is already whole is never selected, which stops
 * available XP being wasted on equipment that does not need it.
 */

export interface MendingCandidate {
  name: string;
  slot: number;
  remaining: number;
  maxDamage: number;
  equipped: boolean;
  priorityWeight: number;
}

export function missing(c: MendingCandidate): number {
  return Math.max(0, c.maxDamage - c.remaining);
}

export function damagedFraction(c: MendingCandidate): number {
  if (c.maxDamage <= 0) return 0;
  return missing(c) / c.maxDamage;
}

export function needsRepair(c: MendingCandidate): boolean {
  return missing(c) > 0;
}

/**
 * Ranks candidates worst-first: most missing durability, then the configured weight, then equipped items
 * ahead of stored ones (an equipped elytra matters more than a spare chestplate).
 */
export function rankCandidates(candidates: MendingCandidate[]): MendingCandidate[] {
  return candidates
    .filter(needsRepair)
    .sort((a, b) => {
      if (missing(b) !== missing(a)) return missing(b) - missing(a);
      if (b.priorityWeight !== a.priorityWeight) return b.priorityWeight - a.priorityWeight;
      return Number(b.equipped) - Number(a.equipped);
    });
}

/** True when it is worth starting a repair cycle. */
export function shouldRepair(xpAvailable: boolean, worstMissing: number, minMissing: number): boolean {
  return xpAvailable && worstMissing >= Math.max(1, minMissing);
}

/** Slot of the highest priority candidate, or -1 when nothing needs repair. */
export function selectSlot(candidates: MendingCandidate[]): number {
  const ranked = rankCandidates(candidates);
  return ranked.length ? ranked[0].slot : -1;
}

/** The most damaged candidate's missing durability, or 0 when nothing needs repair. */
export function worstMissing(candidates: MendingCandidate[]): number {
  const ranked = rankCandidates(candidates);
  return ranked.length ? missing(ranked[0]) : 0;
}
