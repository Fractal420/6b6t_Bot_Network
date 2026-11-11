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
  // Current (Nov 2026) second lobby portal area — large custom structure
  { x: 242, y: 64.5, z: 221 },
  { x: 245, y: 67, z: 220 },
  { x: 250, y: 65, z: 225 },
  { x: 238, y: 64, z: 220 },
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
  // Sample feet, body, head, and a step forward at multiple heights —
  // the second lobby portal sits ~2 blocks above ground level.
  const samples = [
    pos.floored(),
    pos.offset(0, 1, 0).floored(),
    pos.offset(0, 1.5, 0).floored(),
    pos.offset(0, 2, 0).floored(),
    pos.offset(0, 0.5, 0).floored(),
    pos.offset(fx, 0, fz).floored(),
    pos.offset(fx, 1, fz).floored(),
    pos.offset(fx, 1.5, fz).floored(),
    pos.offset(fx, 2, fz).floored(),
    pos.offset(fx * 0.5, 1, fz * 0.5).floored(),
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
    let portal = pickServerPortal(raw, worldKind, true, {
      x: pos.x,
      y: pos.y,
      z: pos.z,
    });
    if (!portal) {
      // Last resort: nearest nether_portal block, offset slightly toward the
      // bot so we never aim at the far side of a thick wall.
      const nether = raw.filter((p) => p.blockName === "nether_portal");
      if (nether.length > 0) {
        nether.sort((a, b) => a.distance - b.distance);
        const nearest = nether[0];
        const dx = pos.x - (nearest.position.x + 0.5);
        const dz = pos.z - (nearest.position.z + 0.5);
        const len = Math.hypot(dx, dz) || 1;
        portal = {
          ...nearest,
          kind: "server",
          position: {
            x: nearest.position.x + 0.5 + (dx / len) * 0.6,
            y: nearest.position.y + 0.5,
            z: nearest.position.z + 0.5 + (dz / len) * 0.6,
          },
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
    // Target is already the nearest face of the portal (or a known spot).
    // Integer coords come from known-spot fallbacks — snap those to block center.
    const px = portal.position.x;
    const py = portal.position.y;
    const pz = portal.position.z;
    const target = new Vec3(
      Number.isInteger(px) ? px + 0.5 : px,
      Number.isInteger(py) ? py + 0.5 : py,
      Number.isInteger(pz) ? pz + 0.5 : pz,
    );

    // Estimate how big the portal cluster is so we can push further through
    // large second-lobby portals (they are not vanilla 2×3).
    const netherNear = raw.filter(
      (p) => p.blockName === "nether_portal" && p.distance < (portal.distance + 12),
    );
    const isLargePortal = netherNear.length >= 8;
    const pastDist = isLargePortal ? 12 : 6;

    const flat = new Vec3(target.x - startPos.x, 0, target.z - startPos.z);
    const fl = Math.hypot(flat.x, flat.z) || 1;
    // Aim well past the face so we walk straight through the opening
    const past = new Vec3(
      target.x + (flat.x / fl) * pastDist,
      target.y,
      target.z + (flat.z / fl) * pastDist,
    );

    // Prefer a lower look height on large portals so we hit the walkable part
    // of the opening instead of the upper frame / crying_obsidian lip.
    const lookYOffset = isLargePortal ? 0.4 : 1.0;

    const deadline = Date.now() + (isLargePortal ? 22_000 : 14_000);
    let lastMoveCheck = Date.now();
    let lastMovePos = startPos.clone();
    let stuckBoosts = 0;
    let chargeUntil = 0;

    while (Date.now() < deadline && !stopped) {
      if (!bot.entity) break;
      const here = bot.entity.position;

      if (hasTransferred(startPos, startDim)) {
        stopMovement();
        hooks.onEntered(portal);
        return true;
      }

      const dist = Math.hypot(here.x - target.x, here.z - target.z);
      const belowPortal = here.y < target.y - 0.3;
      const inside = inPortalBlock(bot);

      // Look at a point past the face. When below the portal, aim upward so
      // the bot jumps into the purple blocks instead of the bottom frame.
      const lookY = belowPortal
        ? Math.max(here.y + 1.6, target.y + 0.5)
        : here.y + lookYOffset;
      void bot.lookAt(new Vec3(past.x, lookY, past.z), true).catch(() => {});

      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);

      // Height is the main problem on the second lobby portal: portal blocks
      // sit at ~Y64 while the bot stands at ~Y62. Hold jump the whole time
      // we are close and still below the opening.
      const needJump =
        inside ||
        Date.now() < chargeUntil ||
        (dist < (isLargePortal ? 9 : 5) && (belowPortal || isLargePortal));

      if (needJump) {
        bot.setControlState("jump", true);
        if (inside || (dist < 3 && belowPortal)) {
          chargeUntil = Date.now() + 1200;
        }
      } else {
        bot.setControlState("jump", false);
      }

      // Stuck detector — very aggressive when we are under the portal lip
      if (Date.now() - lastMoveCheck > 500) {
        if (here.distanceTo(lastMovePos) < 0.5) {
          stuckBoosts += 1;
          // Physics can stay paused after Velocity reconfigure on some accounts
          try {
            if (bot.physicsEnabled === false) {
              bot.physicsEnabled = true;
              log.info("Re-enabled physics during portal approach");
            }
          } catch {
            /* ignore */
          }
          log.info(
            `Portal approach stuck (boost ${stuckBoosts}${isLargePortal ? ", large" : ""}${belowPortal ? ", low" : ""}) y=${here.y.toFixed(1)} physics=${bot.physicsEnabled !== false} → re-center + jump`,
          );
          void bot.lookAt(new Vec3(past.x, lookY, past.z), true).catch(() => {});

          // Back up a step so we get a clean run-up, then charge with jump
          bot.setControlState("forward", false);
          bot.setControlState("back", true);
          bot.setControlState("jump", true);
          await sleep(belowPortal ? 280 : 160);
          bot.setControlState("back", false);
          bot.setControlState("forward", true);

          // Strafe to slide off the frame edge
          bot.setControlState(stuckBoosts % 2 === 0 ? "left" : "right", true);
          await sleep(isLargePortal ? 220 : 140);
          bot.setControlState("left", false);
          bot.setControlState("right", false);

          // Every few stuck cycles, try pathfinder toward the portal mouth
          if (stuckBoosts % 4 === 0) {
            try {
              const { goals } = await import("../pathfinder.ts");
              bot.pathfinder?.setGoal(
                new goals.GoalNear(target.x, target.y, target.z, 0.8),
                true,
              );
            } catch {
              /* pathfinder optional */
            }
          }

          // After recovery, force a long jump-sprint charge
          chargeUntil = Date.now() + (belowPortal ? 1800 : 1200);
          bot.setControlState("jump", true);
          bot.setControlState("sprint", true);
        }
        lastMoveCheck = Date.now();
        lastMovePos = here.clone();
      }

      await sleep(30);
    }

    stopMovement();
    // Only count the enter once — the in-loop hasTransferred path already
    // called onEntered when it returned true earlier.
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
        // Real portal hop — wait for Velocity transfer + world reclassify
        // before hunting the next portal. A short pause let overlapping hunts
        // all count the same transfer (1/2 → 7/2) and skip the second portal.
        stopMovement();
        await sleep(2500);
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
