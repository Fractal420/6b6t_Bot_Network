import type { Bot } from "mineflayer";
import { Vec3 } from "vec3";
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
  { x: 245, y: 67, z: 220 },
  { x: 250, y: 65, z: 225 },
];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function inPortalBlock(bot: Bot): boolean {
  const pos = bot.entity?.position;
  if (!pos) return false;
  const yaw = bot.entity.yaw;
  const fx = -Math.sin(yaw);
  const fz = -Math.cos(yaw);
  const samples = [
    pos.floored(),
    pos.offset(0, 1, 0).floored(),
    pos.offset(0, 0.5, 0).floored(),
    pos.offset(fx, 0, fz).floored(),
    pos.offset(fx, 1, fz).floored(),
  ];
  return samples.some((p) => {
    const name = bot.blockAt(p)?.name;
    return name === "nether_portal" || name === "end_gateway" || name === "end_portal";
  });
}

export function createPortalNavigator(bot: Bot, retryMs: number, hooks: NavigatorHooks): PortalNavigator {
  let hunting = false;
  let stopped = false;
  let loopGen = 0;

  const stopMovement = () => {
    try {
      bot.clearControlStates();
    } catch {
      /* ignore */
    }
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* ignore */
    }
  };

  const hasTransferred = (startPos: Vec3, startDim: string): boolean => {
    if (!bot.entity) return false;
    const here = bot.entity.position;
    const dim = String(bot.game?.dimension ?? "");
    const gm = String(bot.game?.gameMode ?? "").toLowerCase();
    if (gm === "survival" || gm === "0") return true;
    if (dim !== startDim) return true;
    if (here.distanceTo(startPos) > 20) return true;
    return false;
  };

  const huntOnce = async (): Promise<boolean> => {
    if (!bot.entity) return false;
    const worldKind = hooks.getWorldKind();
    if (!hooks.allowServerPortals()) return false;
    if (worldKind === "backup") return false;

    const pos = bot.entity.position;
    const dim = String(bot.game?.dimension ?? "").toLowerCase();

    if (dim.includes("overworld") && pos.y > 90) {
      try {
        const client = bot._client as { write: (name: string, params: unknown) => void; state?: string };
        if (!client.state || client.state === "play") client.write("player_loaded", {});
      } catch {
        /* ignore */
      }
    }

    // Fast portal find — no pathfinder, pure sprint
    const raw = findPortalBlocks(bot, 72, 1024);
    let portal = pickServerPortal(raw, worldKind, true);
    if (!portal) {
      // Last resort: cluster remaining nether_portal blocks and aim at their
      // middle (never a single edge block — that is how bots get stuck on
      // the side of the large second lobby portal).
      const nether = raw.filter((p) => p.blockName === "nether_portal");
      if (nether.length > 0) {
        const cx = nether.reduce((s, p) => s + p.position.x + 0.5, 0) / nether.length;
        const cy = nether.reduce((s, p) => s + p.position.y + 0.5, 0) / nether.length;
        const cz = nether.reduce((s, p) => s + p.position.z + 0.5, 0) / nether.length;
        const nearest = nether.sort((a, b) => a.distance - b.distance)[0];
        portal = {
          ...nearest,
          kind: "server",
          position: { x: cx, y: cy, z: cz },
          distance: nearest.distance,
        };
      }
    }
    if (!portal) {
      const known = KNOWN_SERVER_PORTALS.map((spot) => ({
        spot,
        distance: pos.distanceTo(new Vec3(spot.x, spot.y, spot.z)),
      }))
        .filter((e) => e.distance < 180)
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
      hooks.onMiss(raw.length ? "no usable portal" : "no portal in range");
      return false;
    }

    hooks.onFound(portal);
    log.info(
      `Sprint → portal ${portal.position.x.toFixed(0)},${portal.position.y.toFixed(0)},${portal.position.z.toFixed(0)} (${portal.distance.toFixed(1)}m)`,
    );

    // Cancel any leftover pathfinder so it cannot slow or stop us
    try {
      bot.pathfinder?.setGoal(null);
    } catch {
      /* ignore */
    }

    const startPos = bot.entity.position.clone();
    const startDim = String(bot.game?.dimension ?? "");
    // pickServerPortal already returns the geometric center of the portal cluster
    // (block centers averaged). Integer coords come from single-block / known-spot
    // fallbacks — snap those to block center. Never add 0.5 twice or the bot
    // aims at the side of large second portals and gets stuck on the frame.
    const px = portal.position.x;
    const py = portal.position.y;
    const pz = portal.position.z;
    const target = new Vec3(
      Number.isInteger(px) ? px + 0.5 : px,
      Number.isInteger(py) ? py + 0.5 : py,
      Number.isInteger(pz) ? pz + 0.5 : pz,
    );
    const flat = new Vec3(target.x - startPos.x, 0, target.z - startPos.z);
    const fl = Math.hypot(flat.x, flat.z) || 1;
    // Aim well past the middle so we walk straight through the opening
    const past = new Vec3(target.x + (flat.x / fl) * 6, target.y, target.z + (flat.z / fl) * 6);

    const deadline = Date.now() + 14_000;
    let lastMoveCheck = Date.now();
    let lastMovePos = startPos.clone();
    let stuckBoosts = 0;

    while (Date.now() < deadline && !stopped) {
      if (!bot.entity) break;
      const here = bot.entity.position;

      if (hasTransferred(startPos, startDim)) {
        stopMovement();
        hooks.onEntered(portal);
        return true;
      }

      // Always face the middle of the portal and a point past it so we walk
      // straight through the opening instead of grazing the side.
      void bot.lookAt(new Vec3(past.x, here.y + 1.0, past.z), true).catch(() => {});

      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);

      const dist = Math.hypot(here.x - target.x, here.z - target.z);
      const inside = inPortalBlock(bot);

      // Close or inside: jump-burst through frame (obsidian lip)
      if (dist < 5 || inside) {
        bot.setControlState("jump", true);
        await sleep(50);
        bot.setControlState("jump", false);
      }

      // Stuck detector: not moving for 700ms while holding forward
      if (Date.now() - lastMoveCheck > 700) {
        if (here.distanceTo(lastMovePos) < 0.35) {
          stuckBoosts += 1;
          log.info(`Portal approach stuck (boost ${stuckBoosts}) — re-center + jump/strafe`);
          // Re-aim hard at the portal middle, not the side we drifted into
          void bot.lookAt(new Vec3(past.x, here.y + 1.0, past.z), true).catch(() => {});
          bot.setControlState("jump", true);
          bot.setControlState(stuckBoosts % 2 === 0 ? "left" : "right", true);
          await sleep(140);
          bot.setControlState("left", false);
          bot.setControlState("right", false);
          bot.setControlState("jump", false);
        }
        lastMoveCheck = Date.now();
        lastMovePos = here.clone();
      }

      await sleep(50);
    }

    stopMovement();
    if (bot.entity && hasTransferred(startPos, startDim)) {
      hooks.onEntered(portal);
      return true;
    }
    hooks.onMiss("timed out at portal");
    return false;
  };

  const runLoop = async (gen: number) => {
    while (hunting && !stopped && gen === loopGen) {
      if (!hooks.allowServerPortals()) {
        hunting = false;
        break;
      }
      const ok = await huntOnce();
      if (gen !== loopGen) break;
      if (ok) {
        // Immediately look for next portal (second portal) — minimal pause
        await sleep(400);
        continue;
      }
      const waitMs = Math.min(Math.max(retryMs, 1500), 3000);
      log.info(`Portal retry in ${Math.round(waitMs / 1000)}s`);
      const until = Date.now() + waitMs;
      while (hunting && !stopped && gen === loopGen && Date.now() < until) {
        await sleep(150);
      }
    }
    if (gen === loopGen) stopMovement();
  };

  return {
    start() {
      stopped = true;
      hunting = false;
      stopMovement();
      loopGen += 1;
      const gen = loopGen;
      stopped = false;
      hunting = true;
      void runLoop(gen);
    },
    stop() {
      hunting = false;
      stopped = true;
      loopGen += 1;
      stopMovement();
    },
    huntOnce,
    get hunting() {
      return hunting;
    },
  };
}
