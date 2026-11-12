import assert from "node:assert/strict";
import test from "node:test";
import { NotificationCenter, type Notification } from "./notifications.ts";

function collector(): { sent: Notification[]; sink: (n: Notification) => void } {
  const sent: Notification[] = [];
  return { sent, sink: (n) => void sent.push(n) };
}

test("an enabled notification is delivered", () => {
  const { sent, sink } = collector();
  const center = new NotificationCenter({ sink, now: () => 0 });
  assert.ok(center.notify("stash-discovery", "Stash", "found one"));
  assert.equal(sent.length, 1);
  assert.equal(sent[0].kind, "stash-discovery");
});

test("a cooldown suppresses a burst of the same kind", () => {
  let now = 0;
  const { sent, sink } = collector();
  const center = new NotificationCenter({ sink, now: () => now });
  assert.ok(center.notify("stash-discovery", "a", "b"));
  now = 5_000;
  assert.ok(!center.notify("stash-discovery", "a", "b"), "still inside the default cooldown");
  now = 20_000;
  assert.ok(center.notify("stash-discovery", "a", "b"), "past the cooldown");
  assert.equal(sent.length, 2);
});

test("cooldowns are per kind", () => {
  let now = 0;
  const { sent, sink } = collector();
  const center = new NotificationCenter({ sink, now: () => now });
  assert.ok(center.notify("stash-discovery", "a", "b"));
  now = 1_000;
  assert.ok(center.notify("emergency", "a", "b"), "a different kind is not blocked");
  assert.equal(sent.length, 2);
});

test("a disabled kind is never delivered", () => {
  const { sent, sink } = collector();
  const center = new NotificationCenter({ sink, config: { enabled: { "player-sighting": false } } });
  assert.ok(!center.notify("player-sighting", "a", "b"));
  assert.equal(sent.length, 0);
});

test("a custom cooldown overrides the default", () => {
  let now = 0;
  const { sent, sink } = collector();
  const center = new NotificationCenter({ sink, config: { cooldownMs: { "stash-discovery": 100_000 } }, now: () => now });
  assert.ok(center.notify("stash-discovery", "a", "b"));
  now = 30_000;
  assert.ok(!center.notify("stash-discovery", "a", "b"));
  now = 100_000;
  assert.ok(center.notify("stash-discovery", "a", "b"));
  assert.equal(sent.length, 2);
});

test("a throwing sink does not break the caller", () => {
  const center = new NotificationCenter({
    sink: () => {
      throw new Error("boom");
    },
    now: () => 0,
  });
  assert.ok(center.notify("system-error", "a", "b"));
});

test("urgent kinds have a shorter default cooldown", () => {
  const center = new NotificationCenter({ sink: () => {}, now: () => 0 });
  assert.ok(center.cooldownFor("emergency") < center.cooldownFor("stash-discovery"));
});
