import assert from "node:assert/strict";
import test from "node:test";
import type { Bot } from "mineflayer";
import { FlightDriver } from "./flightRuntime.ts";

interface MockFlight {
  bot: Bot;
  entity: {
    position: { x: number; y: number; z: number };
    velocity: { x: number; y: number; z: number };
    onGround: boolean;
    elytraFlying: boolean;
    isInWater: boolean;
  };
  controls: Record<string, boolean>;
  looks: Array<{ yaw: number; pitch: number }>;
  deployed: number;
  fireworkRocketDuration: number;
  clearElytra: () => void;
}

/** A minimal bot that records the control actions the driver takes. */
function makeBot(): MockFlight {
  const controls: Record<string, boolean> = {};
  const looks: Array<{ yaw: number; pitch: number }> = [];
  const entity = {
    position: { x: 0, y: 64, z: 0 },
    velocity: { x: 0, y: 0, z: 0 },
    onGround: true,
    elytraFlying: false,
    isInWater: false,
  };
  const slots: Array<{ name?: string; maxDurability?: number; durabilityUsed?: number } | null> = new Array(46).fill(null);
  slots[38] = { name: "elytra", maxDurability: 432, durabilityUsed: 10 };
  const mock: MockFlight = {
    entity,
    controls,
    looks,
    deployed: 0,
    fireworkRocketDuration: 0,
    clearElytra() {
      slots[38] = null;
    },
    bot: undefined as unknown as Bot,
  };
  mock.bot = {
    entity,
    game: { dimension: "overworld" },
    inventory: { slots },
    getEquipmentDestSlot: () => 38,
    clearControlStates() {
      for (const key of Object.keys(controls)) controls[key] = false;
    },
    setControlState(name: string, value: boolean) {
      controls[name] = value;
    },
    async look(yaw: number, pitch: number) {
      looks.push({ yaw, pitch });
    },
    async elytraFly() {
      mock.deployed += 1;
      entity.elytraFlying = true;
    },
    async equip() {},
    activateItem() {},
    get fireworkRocketDuration() {
      return mock.fireworkRocketDuration;
    },
    set fireworkRocketDuration(value: number) {
      mock.fireworkRocketDuration = value;
    },
  } as unknown as Bot;
  return mock;
}

test("a grounded bot with a usable elytra launches", async () => {
  const mock = makeBot();
  const driver = new FlightDriver(() => mock.bot, {}, () => 1000);
  driver.setTarget({ x: 100, y: 180, z: 0 });
  const action = await driver.update();
  assert.equal(action, "launch");
  assert.equal(mock.controls.forward, true);
  assert.equal(mock.controls.jump, true);
});

test("an airborne, non-gliding bot deploys the elytra", async () => {
  const mock = makeBot();
  mock.entity.onGround = false;
  mock.entity.velocity.y = -0.2;
  const driver = new FlightDriver(() => mock.bot, {}, () => 5000);
  driver.setTarget({ x: 100, y: 180, z: 0 });
  await driver.update();
  assert.equal(mock.entity.elytraFlying, true);
  assert.equal(mock.deployed, 1);
});

test("gliding below the band climbs and keeps a firework boost alive", async () => {
  const mock = makeBot();
  mock.entity.onGround = false;
  mock.entity.elytraFlying = true;
  mock.entity.position.y = 120;
  mock.entity.velocity.x = 1;
  const driver = new FlightDriver(() => mock.bot, { cruiseY: 180, cruiseBand: 24, departDist: 0 }, () => 5000);
  driver.setTarget({ x: 1000, y: 180, z: 0 });
  const action = await driver.update();
  assert.equal(action, "cruise");
  assert.ok(mock.fireworkRocketDuration > 0, "boost engaged while climbing");
  assert.ok(mock.looks.length > 0, "look was issued to steer");
  assert.ok(mock.looks.at(-1)!.pitch > 0, "climbs while below the band");
});

test("a stalled glide dives to recover airspeed", async () => {
  const mock = makeBot();
  mock.entity.onGround = false;
  mock.entity.elytraFlying = true;
  mock.entity.position.y = 200;
  mock.entity.velocity.x = 0;
  const driver = new FlightDriver(() => mock.bot, { cruiseY: 180, cruiseBand: 24, departDist: 0 }, () => 5000);
  driver.setTarget({ x: 1000, y: 180, z: 0 });
  await driver.update();
  assert.ok(mock.looks.at(-1)!.pitch < 0, "dives when stalled");
});

test("no elytra and no spare aborts instead of pretending to fly", async () => {
  const mock = makeBot();
  mock.clearElytra();
  const driver = new FlightDriver(() => mock.bot, {}, () => 5000);
  driver.setTarget({ x: 100, y: 180, z: 0 });
  const action = await driver.update();
  assert.equal(action, "abort");
});

test("stopping clears the target and control state", async () => {
  const mock = makeBot();
  const driver = new FlightDriver(() => mock.bot, {}, () => 5000);
  driver.setTarget({ x: 100, y: 180, z: 0 });
  await driver.update();
  driver.stop();
  assert.equal(driver.wantsFlight, false);
  assert.equal(mock.controls.forward, false);
});
