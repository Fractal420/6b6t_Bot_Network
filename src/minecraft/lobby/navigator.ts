import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
import { goals, Movements } from "../pathfinder.ts";
import type { PortalTarget, WorldKind } from "../../api/types.ts";
import { log } from "../../logger.ts";
import { pickServerPortal, findPortalBlocks } from "./portals.ts";
import { isLobbyLike } from "./worldKind.ts";

export interface NavigatorHooks {
  onFound(portal: PortalTarget): void;
  onEntered(portal: PortalTarget): void;
  onMiss(reason: string): void;
  getWorldKind(): WorldKind;
  allowServerPortals(): boolean;
}

export interface PortalNavigator {
  start(): void;
  stop(): void;
  huntOnce(): Promise<boolean>;
  get hunting(): boolean;
}

const KNOWN_SERVER_PORTALS = [
  { x: -1000, y: 102, z: -988 },
  { x: 311, y: 163.5, z: 427 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inPortalBlock(bot: Bot): boolean {
  const pos = bot.entity?.position;
  if (!pos) return false;
  const names = [
    bot.blockAt(pos.floored())?.name,
    bot.blockAt(pos.offset(0, 1, 0).floored())?.name,
    bot.blockAt(pos.offset(0, 0.5, 0).floored())?.name,
  ];
  return names.some((name) => name === "nether_portal" || name === "end_gateway" || name === "end_portal");
}

export function createPortalNavigator(bot: Bot, retryMs: number, hooks: NavigatorHooks): PortalNavigator {
  let hunting = false;
  let stopped = false;
  let lastPos = bot.entity?.position?.clone();

  const stopMovement = () => {
    try {
      bot.clearControlStates();
    } catch {}
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      // pathfinder may not be loaded yet
    }
  };

  const waitForTransfer = async (portal: PortalTarget, start: Vec3): Promise<boolean> => {
    stopMovement();
    const startDim = String(bot.game?.dimension ?? "");
    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !stopped) {
      if (!bot.entity) return false;
      const here = bot.entity.position;
      const dim = String(bot.game?.dimension ?? "");
      const gm = String(bot.game?.gameMode ?? "").toLowerCase();
      if (gm === "survival" || gm === "0" || dim !== startDim) {
        hooks.onEntered(portal);
        return true;
      }
      await sleep(200);
    }
    return false;
  };

  const huntOnce = async (): Promise<boolean> => {
    if (!bot.entity) return false;
    const worldKind = hooks.getWorldKind();
    if (!hooks.allowServerPortals() || worldKind === "backup" || (!isLobbyLike(worldKind) && worldKind !== "unknown")) {
      return false;
    }

    const pos = bot.entity.position;
    const dim = String(bot.game?.dimension ?? "").toLowerCase();
    const gm = String(bot.game?.gameMode ?? "").toLowerCase();

    if (dim.includes("overworld") && (gm === "adventure" || gm === "1") && pos.y < 40) {
      log.info("Post-portal staging; waiting for main-world transfer");
      stopMovement();
      const until = Date.now() + 12_000;
      while (Date.now() < until && !stopped) {
        if (!bot.entity) return false;
        const nowGm = String(bot.game?.gameMode ?? "").toLowerCase();
        if (nowGm === "survival" || nowGm === "0") {
          const here = bot.entity.position;
          hooks.onEntered({
            kind: "server",
            position: { x: here.x, y: here.y, z: here.z },
            distance: 0,
            blockName: "staging-transfer",
          });
          return true;
        }
        await sleep(200);
      }
    }

    if (dim.includes("overworld") && pos.y > 90) {
      try {
        const client = bot._client as { write: (name: string, params: unknown) => void; state?: string };
        if (!client.state || client.state === "play") {
          client.write("player_loaded", {});
          log.info("Sky lobby: resent player_loaded before the second portal");
        }
      } catch {
        // client may already be closing
      }
      await sleep(400);
    }

    const raw = findPortalBlocks(bot, 64, 2048);
    let portal = pickServerPortal(raw, worldKind, true);
    if (!portal && raw.length > 0) {
      log.info("Nearby portal blocks are not a normal 2×3 vanilla portal; skipping decorative portal wall");
    }
    if (!portal) {
      const known = KNOWN_SERVER_PORTALS
        .map((spot) => ({ spot, distance: pos.distanceTo(new Vec3(spot.x, spot.y, spot.z)) }))
        .filter((entry) => entry.distance < 80)
        .sort((a, b) => a.distance - b.distance)[0];
      if (known) {
        portal = {
          kind: "server",
          position: known.spot,
          distance: known.distance,
          blockName: "nether_portal",
        };
      }
    }
    if (!portal) {
      hooks.onMiss(raw.length > 0 ? "no vanilla-sized server portal in range" : "no server portal in range");
      return false;
    }

    hooks.onFound(portal);
    log.info(
      `Walking into ${portal.kind} portal at ${portal.position.x.toFixed(1)},${portal.position.y.toFixed(1)},${portal.position.z.toFixed(1)} (${portal.blockName}, ${portal.distance.toFixed(1)}m)`,
    );

    const start = bot.entity.position.clone();
    lastPos = start;
    const toward = new Vec3(portal.position.x, portal.position.y, portal.position.z);
    const target = new Vec3(toward.x, start.y, toward.z);

    try {
      const movements = new Movements(bot);
      movements.canDig = false;
      movements.allow1by1towers = false;
      bot.pathfinder.setMovements(movements);
      bot.pathfinder.setGoal(new goals.GoalNear(target.x, start.y, target.z, 0.6));
    } catch (error) {
      log.warn("Pathfinder unavailable, walking forward instead", error instanceof Error ? error.message : error);
    }

    const deadline = Date.now() + 20_000;
    while (Date.now() < deadline && !stopped) {
      if (!bot.entity) break;
      const here = bot.entity.position;
      if (lastPos && here.distanceTo(lastPos) > 18) {
        stopMovement();
        hooks.onEntered(portal);
        return true;
      }
      if (inPortalBlock(bot)) {
        log.info("Inside server portal; standing with physics on until transfer");
        stopMovement();
        return waitForTransfer(portal, start);
      }

      try {
        await bot.lookAt(new Vec3(target.x, here.y + 1.2, target.z), true);
      } catch {
        // look can fail mid-teleport
      }
      bot.setControlState("forward", true);
      bot.setControlState("sprint", here.distanceTo(target) > 3);
      lastPos = here.clone();
      await sleep(150);
    }

    stopMovement();
    hooks.onMiss("timed out walking into portal");
    return false;
  };

  const runLoop = async () => {
    while (hunting && !stopped) {
      const worldKind = hooks.getWorldKind();
      if (!hooks.allowServerPortals()) {
        hunting = false;
        break;
      }
      if (worldKind === "backup" || (!isLobbyLike(worldKind) && worldKind !== "unknown")) {
        hunting = false;
        break;
      }
      const ok = await huntOnce();
      if (ok) {
        await sleep(3500);
        continue;
      }
      log.info(`Portal not found or not entered. Retrying in ${Math.round(retryMs / 1000)}s`);
      const waitUntil = Date.now() + retryMs;
      while (hunting && !stopped && Date.now() < waitUntil) {
        await sleep(500);
      }
    }
    stopMovement();
  };

  return {
    start() {
      if (hunting) return;
      stopped = false;
      hunting = true;
      void runLoop();
    },
    stop() {
      hunting = false;
      stopped = true;
      stopMovement();
    },
    huntOnce,
    get hunting() {
      return hunting;
    },
  };
}
