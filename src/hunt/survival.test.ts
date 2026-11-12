import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_THRESHOLDS, evaluateSurvival, type SurvivalSnapshot } from "./survival.ts";

function snap(partial: Partial<SurvivalSnapshot>): SurvivalSnapshot {
  return {
    health: 20,
    food: 20,
    elytraRemaining: 400,
    armorRemaining: 300,
    totems: 2,
    foodItems: 20,
    fireworks: 0,
    freeSlots: 10,
    gliding: false,
    ...partial,
  };
}

test("a healthy snapshot is ok", () => {
  const report = evaluateSurvival(snap({}));
  assert.equal(report.verdict, "ok");
  assert.equal(report.concerns.length, 0);
  assert.ok(!report.shouldReturn);
  assert.ok(!report.shouldDisconnect);
});

test("low health warns and should return", () => {
  const report = evaluateSurvival(snap({ health: 10 }));
  assert.equal(report.verdict, "warn");
  assert.ok(report.concerns.includes("low-health"));
  assert.ok(report.shouldReturn);
  assert.ok(!report.shouldDisconnect);
});

test("very low health is critical and disconnects", () => {
  const report = evaluateSurvival(snap({ health: 4 }));
  assert.equal(report.verdict, "critical");
  assert.ok(report.shouldDisconnect);
});

test("a worn elytra should return, but is not a disconnect", () => {
  const report = evaluateSurvival(snap({ elytraRemaining: 5 }));
  assert.ok(report.concerns.includes("elytra-worn"));
  assert.ok(report.shouldReturn);
  assert.ok(!report.shouldDisconnect);
});

test("no totem only forces a return while gliding", () => {
  assert.ok(evaluateSurvival(snap({ totems: 0, gliding: true })).shouldReturn);
  assert.ok(!evaluateSurvival(snap({ totems: 0, gliding: false })).shouldReturn);
});

test("a full inventory should return", () => {
  const report = evaluateSurvival(snap({ freeSlots: 0 }));
  assert.ok(report.concerns.includes("inventory-full"));
  assert.ok(report.shouldReturn);
});

test("a missing elytra is not reported as worn", () => {
  const report = evaluateSurvival(snap({ elytraRemaining: -1 }));
  assert.ok(!report.concerns.includes("elytra-worn"));
});

test("thresholds are overridable", () => {
  const report = evaluateSurvival(snap({ health: 15 }), { ...DEFAULT_THRESHOLDS, minHealth: 18 });
  assert.ok(report.concerns.includes("low-health"));
});
