import assert from "node:assert/strict";
import test from "node:test";
import { Priority, Scheduler, TaskScheduler } from "./scheduler.ts";

test("only one owner may hold a resource at a time", () => {
  const s = new Scheduler();
  assert.ok(s.acquire("a", Priority.Exploration, ["movement"]).ok);
  const second = s.acquire("b", Priority.Exploration, ["movement"]);
  assert.ok(!second.ok);
  assert.equal(second.heldBy, "a");
});

test("a higher priority preempts a lower one", () => {
  const s = new Scheduler();
  s.acquire("explore", Priority.Exploration, ["movement"]);
  const preempt = s.acquire("survive", Priority.CriticalSurvival, ["movement"]);
  assert.ok(preempt.ok);
  assert.ok(s.isHeldBy("survive", "movement"));
  assert.ok(!s.isHeldBy("explore", "movement"));
});

test("an equal priority cannot preempt", () => {
  const s = new Scheduler();
  s.acquire("a", Priority.Exploration, ["inventory"]);
  assert.ok(!s.acquire("b", Priority.Exploration, ["inventory"]).ok);
});

test("acquiring a set is all-or-nothing", () => {
  const s = new Scheduler();
  s.acquire("a", Priority.Inventory, ["inventory"]);
  const result = s.acquire("b", Priority.Exploration, ["movement", "inventory"]);
  assert.ok(!result.ok);
  // The failed request must not have grabbed the free resource.
  assert.equal(s.holder("movement"), undefined);
});

test("release frees the resource for the next owner", () => {
  const s = new Scheduler();
  s.acquire("a", Priority.Exploration, ["movement"]);
  s.release("a");
  assert.ok(s.acquire("b", Priority.Exploration, ["movement"]).ok);
});

test("releaseAll clears everything an owner holds", () => {
  const s = new Scheduler();
  s.acquire("a", Priority.Exploration, ["movement", "chat"]);
  s.releaseAll("a");
  assert.equal(s.snapshot().length, 0);
});

test("task scheduler runs in priority order and retires completed tasks", () => {
  const order: string[] = [];
  const tasks = new TaskScheduler();
  tasks.submit({ name: "low", priority: Priority.Background, run: () => void order.push("low") });
  tasks.submit({ name: "high", priority: Priority.CriticalSurvival, run: () => void order.push("high") });
  tasks.submit({ name: "done", priority: Priority.Exploration, run: () => false });

  tasks.tick();
  assert.deepEqual(order, ["high", "low"]);
  assert.ok(!tasks.has("done"));
  assert.ok(tasks.has("low"));
});

test("submitting by name replaces an existing task", () => {
  const tasks = new TaskScheduler();
  tasks.submit({ name: "x", priority: Priority.Exploration, run: () => true });
  tasks.submit({ name: "x", priority: Priority.Inventory, run: () => true });
  assert.equal(tasks.pending.length, 1);
  assert.equal(tasks.pending[0].priority, Priority.Inventory);
});
