import assert from "node:assert/strict";
import test from "node:test";
import {
  bestSlot,
  canCompleteJourney,
  canDeploy,
  classifyFlightState,
  decideFlight,
  DEFAULT_MIN_DURABILITY,
  DeploymentGovernor,
  durabilityPercent,
  isSupported,
  isViable,
  remainingDurability,
  RetryPolicy,
  shouldReplace,
} from "./flight.ts";

test("remaining durability never goes negative", () => {
  assert.equal(remainingDurability(432, 100), 332);
  assert.equal(remainingDurability(432, 9999), 0);
  assert.equal(remainingDurability(0, 0), 0);
});

test("durability percent is clamped", () => {
  assert.equal(durabilityPercent(216, 432), 50);
  assert.equal(durabilityPercent(-5, 432), 0);
  assert.equal(durabilityPercent(500, 432), 100);
  assert.equal(durabilityPercent(10, 0), 0);
});

test("replace and viability rules", () => {
  assert.ok(shouldReplace(10, 20));
  assert.ok(!shouldReplace(30, 20));
  assert.ok(!shouldReplace(10, 0));
  assert.ok(isViable(16, DEFAULT_MIN_DURABILITY));
  assert.ok(!isViable(15, DEFAULT_MIN_DURABILITY));
  assert.ok(!isViable(-1, DEFAULT_MIN_DURABILITY));
});

test("bestSlot picks the healthiest above the minimum", () => {
  assert.equal(bestSlot([10, 200, 150], 16), 1);
  assert.equal(bestSlot([10, -1, 5], 16), -1);
  assert.equal(bestSlot([100, 100], 16), 0);
});

test("journey estimate adds spares", () => {
  assert.ok(canCompleteJourney(200, [200], 10_000, DEFAULT_MIN_DURABILITY));
  assert.ok(!canCompleteJourney(20, [], 10_000, DEFAULT_MIN_DURABILITY));
});

test("flight state classification", () => {
  assert.equal(classifyFlightState(true, true, true, true, 0), "gliding");
  assert.equal(classifyFlightState(false, true, true, true, 0), "swimming");
  assert.equal(classifyFlightState(false, false, true, true, 0), "climbing");
  assert.equal(classifyFlightState(false, false, false, true, 0), "grounded");
  assert.equal(classifyFlightState(false, false, false, false, -1), "falling");
  assert.equal(classifyFlightState(false, false, false, false, 0.1), "airborne");
});

test("deployable and supported states", () => {
  assert.ok(canDeploy("grounded"));
  assert.ok(canDeploy("falling"));
  assert.ok(!canDeploy("swimming"));
  assert.ok(isSupported("grounded"));
  assert.ok(isSupported("swimming"));
  assert.ok(!isSupported("falling"));
});

function decision(partial: Partial<Parameters<typeof decideFlight>[0]>) {
  return decideFlight({
    state: "grounded",
    hasElytra: true,
    wornUsable: true,
    wornNeedsReplace: false,
    spareViable: false,
    flightOn: false,
    wantsFlight: true,
    canAttempt: true,
    ...partial,
  });
}

test("grounded with a healthy elytra launches", () => {
  assert.equal(decision({}), "launch");
});

test("gliding cruises", () => {
  assert.equal(decision({ state: "gliding", flightOn: true, canAttempt: false }), "cruise");
});

test("no elytra aborts without a spare, replaces with one", () => {
  assert.equal(decision({ hasElytra: false, wornUsable: false }), "abort");
  assert.equal(decision({ hasElytra: false, wornUsable: false, spareViable: true }), "replace");
});

test("worn-out elytra swaps for a spare instead of relaunching", () => {
  assert.equal(decision({ state: "falling", wornUsable: false, spareViable: true }), "replace");
});

test("swimming waits rather than aborting", () => {
  assert.equal(decision({ state: "swimming" }), "wait");
});

test("the backoff gate blocks a launch", () => {
  assert.equal(decision({ canAttempt: false }), "wait");
});

test("not wanted does nothing", () => {
  assert.equal(decision({ wantsFlight: false }), "none");
});

test("retry policy backs off and gives up", () => {
  const p = new RetryPolicy(3, 100, 1000);
  assert.ok(p.canAttempt(0));
  p.recordAttempt(0);
  assert.ok(!p.canAttempt(0));
  assert.ok(p.canAttempt(100));
  p.recordAttempt(100);
  p.recordAttempt(400);
  assert.ok(p.exhausted());
  assert.ok(!p.canAttempt(100_000));
  p.reset();
  assert.ok(p.canAttempt(100_000));
});

test("governor does not reset its budget on repeated wants", () => {
  const g = new DeploymentGovernor(2, 100, 1000);
  g.setWantsFlight(true);
  g.recordAttempt(0);
  g.recordAttempt(100);
  assert.ok(g.exhausted);
  g.setWantsFlight(true);
  assert.ok(g.exhausted, "repeated wants reset the retry budget");
  g.setWantsFlight(false);
  g.setWantsFlight(true);
  assert.ok(!g.exhausted);
});

test("governor reports a glide start once", () => {
  const g = new DeploymentGovernor(5, 100, 1000);
  g.setWantsFlight(true);
  assert.ok(g.noteState("gliding"));
  assert.ok(!g.noteState("gliding"));
});

test("governor reports a landing once", () => {
  const g = new DeploymentGovernor(5, 100, 1000);
  g.setWantsFlight(true);
  g.noteState("gliding");
  g.noteState("grounded");
  assert.ok(g.justLanded);
  g.noteState("grounded");
  assert.ok(!g.justLanded);
});

test("governor reports a deploy failure once", () => {
  const g = new DeploymentGovernor(1, 100, 1000);
  g.setWantsFlight(true);
  g.recordAttempt(0);
  assert.ok(g.shouldReportDeployFailure());
  assert.ok(!g.shouldReportDeployFailure());
});
