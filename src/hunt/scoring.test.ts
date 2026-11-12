import assert from "node:assert/strict";
import test from "node:test";
import {
  classifyStash,
  containerCount,
  describeTier,
  emptyEvidence,
  isNoteworthy,
  meetsThreshold,
  rankTargets,
  scoreStash,
  targetPriority,
  type TargetCandidate,
} from "./scoring.ts";

test("a lone chest is not a stash", () => {
  const e = emptyEvidence();
  e.chests = 1;
  const s = scoreStash(e);
  assert.ok(s < 8, `a single chest scored ${s}`);
  assert.equal(classifyStash(s, containerCount(e)), "unconfirmed");
});

test("a pile of shulkers scores high", () => {
  const e = emptyEvidence();
  e.shulkerBoxes = 20;
  e.barrels = 12;
  e.chests = 10;
  const s = scoreStash(e);
  assert.ok(s >= 180, `expected a large stash, scored ${s}`);
  assert.ok(["large", "major"].includes(classifyStash(s, containerCount(e))));
  assert.ok(isNoteworthy(classifyStash(s, containerCount(e))));
});

test("a mix of storage types scores higher than one type alone", () => {
  const same = emptyEvidence();
  same.chests = 6;
  const mixed = emptyEvidence();
  mixed.chests = 2;
  mixed.barrels = 2;
  mixed.trappedChests = 2;
  assert.ok(scoreStash(mixed) > scoreStash(same));
});

test("thresholds report the expected tiers", () => {
  assert.equal(classifyStash(0, 0), "unconfirmed");
  assert.equal(classifyStash(10, 1), "possible");
  assert.equal(classifyStash(30, 1), "small");
  assert.equal(classifyStash(90, 1), "medium");
  assert.equal(classifyStash(200, 1), "large");
  assert.equal(classifyStash(500, 1), "major");
  assert.equal(classifyStash(1, 130), "major");
});

test("noteworthy tiers and descriptions", () => {
  assert.ok(isNoteworthy("medium"));
  assert.ok(!isNoteworthy("small"));
  assert.equal(describeTier("major"), "major storage location");
  assert.equal(describeTier("structure"), "interesting structure");
});

test("meetsThreshold accepts either signal", () => {
  assert.ok(meetsThreshold(100, 1, 50, 8));
  assert.ok(meetsThreshold(1, 10, 50, 8));
  assert.ok(!meetsThreshold(1, 1, 50, 8));
});

function cand(partial: Partial<TargetCandidate>): TargetCandidate {
  return {
    id: "x",
    score: 100,
    tier: "medium",
    distance: 1000,
    previouslyDiscovered: false,
    playerSightings: 0,
    lastSeenMs: 0,
    unexploredNeighbours: 0,
    ...partial,
  };
}

test("confidence dominates distance", () => {
  const strong = cand({ id: "strong", score: 400, distance: 8000 });
  const weak = cand({ id: "weak", score: 40, distance: 100 });
  const ranked = rankTargets([weak, strong], 0);
  assert.equal(ranked[0].id, "strong");
});

test("distance breaks a tie at equal confidence", () => {
  const near = cand({ id: "near", score: 200, distance: 500 });
  const far = cand({ id: "far", score: 200, distance: 5000 });
  assert.equal(rankTargets([far, near], 0)[0].id, "near");
});

test("player activity and frontier raise priority", () => {
  const quiet = cand({ id: "quiet", score: 200, distance: 1000 });
  const busy = cand({ id: "busy", score: 200, distance: 1000, playerSightings: 3, unexploredNeighbours: 4 });
  assert.ok(targetPriority(busy, 0) > targetPriority(quiet, 0));
});

test("stale intel is penalised", () => {
  const fresh = cand({ id: "fresh", score: 200, distance: 1000, lastSeenMs: 0 });
  const stale = cand({ id: "stale", score: 200, distance: 1000, lastSeenMs: -30 * 86_400_000 });
  assert.ok(targetPriority(fresh, 0) > targetPriority(stale, 0));
});
