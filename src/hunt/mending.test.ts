import assert from "node:assert/strict";
import test from "node:test";
import {
  damagedFraction,
  missing,
  rankCandidates,
  selectSlot,
  shouldRepair,
  worstMissing,
  type MendingCandidate,
} from "./mending.ts";

function cand(partial: Partial<MendingCandidate>): MendingCandidate {
  return {
    name: "item",
    slot: 0,
    remaining: 100,
    maxDamage: 100,
    equipped: false,
    priorityWeight: 0,
    ...partial,
  };
}

test("whole items are never selected", () => {
  const candidates = [cand({ name: "elytra", slot: 38, remaining: 432, maxDamage: 432, equipped: true })];
  assert.equal(rankCandidates(candidates).length, 0);
  assert.equal(selectSlot(candidates), -1);
});

test("the most damaged item is first", () => {
  const candidates = [
    cand({ name: "helmet", slot: 39, remaining: 300, maxDamage: 400, equipped: true }),
    cand({ name: "elytra", slot: 38, remaining: 50, maxDamage: 432, equipped: true }),
  ];
  assert.equal(selectSlot(candidates), 38);
  assert.equal(worstMissing(candidates), 382);
});

test("weight breaks a tie", () => {
  const candidates = [
    cand({ name: "a", slot: 1, remaining: 100, maxDamage: 200, priorityWeight: 0 }),
    cand({ name: "b", slot: 2, remaining: 100, maxDamage: 200, priorityWeight: 5 }),
  ];
  assert.equal(selectSlot(candidates), 2);
});

test("equipped breaks a tie when weights match", () => {
  const candidates = [
    cand({ name: "stored", slot: 1, remaining: 100, maxDamage: 200, equipped: false }),
    cand({ name: "worn", slot: 2, remaining: 100, maxDamage: 200, equipped: true }),
  ];
  assert.equal(selectSlot(candidates), 2);
});

test("shouldRepair needs XP and real damage", () => {
  assert.ok(shouldRepair(true, 50, 10));
  assert.ok(!shouldRepair(false, 50, 10));
  assert.ok(!shouldRepair(true, 5, 10));
});

test("missing and damagedFraction", () => {
  const c = cand({ remaining: 25, maxDamage: 100 });
  assert.equal(missing(c), 75);
  assert.equal(damagedFraction(c), 0.75);
});
