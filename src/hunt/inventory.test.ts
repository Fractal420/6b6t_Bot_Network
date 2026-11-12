import assert from "node:assert/strict";
import test from "node:test";
import { classifyItem, isPrecious, ITEM_CATEGORIES } from "./inventory.ts";

test("files the obvious cases", () => {
  assert.equal(classifyItem("elytra"), "elytra");
  assert.equal(classifyItem("diamond_chestplate"), "armor");
  assert.equal(classifyItem("turtle_helmet"), "armor");
  assert.equal(classifyItem("netherite_pickaxe"), "tools");
  assert.equal(classifyItem("firework_rocket"), "fireworks");
  assert.equal(classifyItem("golden_carrot"), "food");
  assert.equal(classifyItem("totem_of_undying"), "totems");
  assert.equal(classifyItem("experience_bottle"), "xp-supplies");
  assert.equal(classifyItem("oak_planks"), "building-blocks");
  assert.equal(classifyItem("ender_chest"), "utility");
  assert.equal(classifyItem("diamond"), "valuable");
  assert.equal(classifyItem("stick"), "other");
});

test("armour wins over valuable", () => {
  assert.equal(classifyItem("netherite_boots"), "armor");
});

test("an unknown item is other, not a crash", () => {
  assert.equal(classifyItem("some_future_block"), "other");
  assert.equal(classifyItem(""), "other");
});

test("precious categories are protected", () => {
  assert.ok(isPrecious("elytra"));
  assert.ok(isPrecious("totems"));
  assert.ok(!isPrecious("building-blocks"));
  assert.ok(!isPrecious("other"));
});

test("category list is complete and stable", () => {
  assert.ok(ITEM_CATEGORIES.includes("elytra"));
  assert.ok(ITEM_CATEGORIES.includes("other"));
  assert.equal(ITEM_CATEGORIES.length, 12);
});
