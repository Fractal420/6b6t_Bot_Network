import assert from "node:assert/strict";
import test from "node:test";
import type { PortalTarget } from "../../api/types.ts";
import { isNormalVanillaPortal, pickServerPortal } from "./portals.ts";

function portalBlocks(coords: Array<[number, number, number]>, distance: number): PortalTarget[] {
  return coords.map(([x, y, z]) => ({
    kind: "unknown" as const,
    position: { x, y, z },
    distance,
    blockName: "nether_portal",
  }));
}

function vanillaPortal(x: number, y: number, z: number, axis: "x" | "z", distance: number): PortalTarget[] {
  const coords: Array<[number, number, number]> = [];
  for (let dy = 0; dy < 3; dy++) {
    for (let width = 0; width < 2; width++) {
      coords.push(axis === "x" ? [x + width, y + dy, z] : [x, y + dy, z + width]);
    }
  }
  return portalBlocks(coords, distance);
}

function decorativeWall(distance: number): PortalTarget[] {
  const coords: Array<[number, number, number]> = [];
  for (let y = 0; y < 8; y++) {
    for (let z = 0; z < 12; z++) {
      coords.push([1, 100 + y, z]);
    }
  }
  return portalBlocks(coords, distance);
}

test("accepts a normal 2×3 vanilla portal on either axis", () => {
  assert.equal(isNormalVanillaPortal(vanillaPortal(0, 64, 0, "x", 4)), true);
  assert.equal(isNormalVanillaPortal(vanillaPortal(0, 64, 0, "z", 4)), true);
});

test("accepts a vanilla portal interior that is still loading", () => {
  const partial = vanillaPortal(0, 64, 0, "x", 4).filter((_, index) => index !== 1 && index !== 4);
  assert.equal(partial.length, 4);
  assert.equal(isNormalVanillaPortal(partial), true);
});

test("rejects oversized and decorative portal shapes", () => {
  const wide: Array<[number, number, number]> = [];
  for (let x = 0; x < 4; x++) {
    for (let y = 0; y < 5; y++) wide.push([x, y, 0]);
  }
  assert.equal(isNormalVanillaPortal(portalBlocks(wide, 2)), false);
  assert.equal(isNormalVanillaPortal(decorativeWall(1)), false);
  assert.equal(isNormalVanillaPortal(vanillaPortal(0, 64, 0, "x", 4).slice(0, 3)), false);
});

test("picks the nearer vanilla portal and ignores a closer decorative wall", () => {
  const picked = pickServerPortal(
    [...decorativeWall(1), ...vanillaPortal(12, 64, 0, "z", 9), ...vanillaPortal(30, 70, 4, "x", 20)],
    "lobby",
    true,
  );
  assert.ok(picked);
  assert.equal(picked.kind, "server");
  assert.equal(picked.position.x, 12.5);
  assert.equal(picked.position.y, 65.5);
  assert.equal(picked.position.z, 1);
  assert.equal(picked.distance, 9);
});

test("returns null when the only portal blocks are a decorative wall", () => {
  assert.equal(pickServerPortal(decorativeWall(2), "lobby", true), null);
});

test("does not treat survival nether portals as lobby exits", () => {
  assert.equal(pickServerPortal(vanillaPortal(0, 64, 0, "x", 3), "overworld", false), null);
});
