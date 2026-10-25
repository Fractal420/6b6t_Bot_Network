import type { Bot } from "mineflayer";
import { log } from "../logger.ts";

/** Play-state packets that must not be written during configuration / mid-switch. */
const PLAY_PACKETS = new Set([
  "position",
  "position_look",
  "look",
  "steer_vehicle",
  "vehicle_move",
  "player_command",
  "arm_animation",
  "use_entity",
  "block_dig",
  "block_place",
  "flying",
  "player_input",
  "entity_action",
  "teleport_confirm",
]);

const CONFIG_ALLOWED = new Set([
  "settings",
  "cookie_response",
  "custom_payload",
  "finish_configuration",
  "keep_alive",
  "pong",
  "resource_pack_receive",
  "select_known_packs",
  "custom_click_action",
  "accept_code_of_conduct",
  "configuration_acknowledged",
]);

/**
 * 6b6t lobby portal is a Velocity backend transfer. During configuration,
 * movement packets get you kicked with "An internal error occurred in your connection."
 * Also answers cookie + resource-pack the way a vanilla client does (join-bot style).
 */
export function attachVelocityTransfer(bot: Bot): void {
  let inConfig = false;
  let awaitingLogin = false;

  const enter = (reason: string) => {
    if (inConfig) return;
    inConfig = true;
    awaitingLogin = true;
    bot.physicsEnabled = false;
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
    log.info(`Entered configuration phase (${reason}); physics paused`);
  };

  const leave = (reason: string) => {
    if (!inConfig) {
      bot.physicsEnabled = true;
      return;
    }
    inConfig = false;
    bot.physicsEnabled = true;
    log.info(`Left configuration phase (${reason}); physics resumed`);
  };

  const raw = bot._client as unknown as {
    write: (name: string, params: unknown) => void;
    state?: string;
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    setMaxListeners?: (n: number) => void;
  };
  try {
    raw.setMaxListeners?.(100);
  } catch {
    /* ignore */
  }

  const originalWrite = raw.write.bind(raw);
  raw.write = (name: string, params: unknown) => {
    const n = String(name);
    const state = raw.state;
    if (state === "configuration" && !CONFIG_ALLOWED.has(n) && PLAY_PACKETS.has(n)) {
      return;
    }
    if ((inConfig || state === "configuration") && PLAY_PACKETS.has(n)) {
      return;
    }
    // Hold movement until first play login after a switch settles
    if (awaitingLogin && state === "play" && PLAY_PACKETS.has(n) && inConfig) {
      return;
    }
    return originalWrite(name, params);
  };

  raw.on("start_configuration", () => enter("start_configuration"));
  raw.on("finish_configuration", () => {
    setTimeout(() => leave("finish_configuration"), 50);
  });
  raw.on("select_known_packs", () => enter("select_known_packs"));
  raw.on("transfer", (...args: unknown[]) => {
    const data = args[0] as { host?: string; port?: number } | undefined;
    log.info(`Transfer packet to ${data?.host}:${data?.port}`);
    enter("transfer");
  });

  // Empty cookie reply (vanilla)
  raw.on("cookie_request", (...args: unknown[]) => {
    const p = args[0] as { cookie?: string; key?: string } | undefined;
    try {
      originalWrite("cookie_response", { key: p?.cookie ?? p?.key });
    } catch {
      /* ignore */
    }
  });

  // Accept resource pack by uuid (avoid mineflayer deny path issues on 1.21.x)
  raw.on("add_resource_pack", (...args: unknown[]) => {
    const p = args[0] as { uuid?: string } | undefined;
    if (!p?.uuid) return;
    try {
      originalWrite("resource_pack_receive", { uuid: p.uuid, result: 3 }); // accepted
      originalWrite("resource_pack_receive", { uuid: p.uuid, result: 0 }); // successfully loaded
      log.info(`Accepted resource pack ${p.uuid}`);
    } catch (error) {
      log.warn("resource_pack_receive failed", error instanceof Error ? error.message : error);
    }
  });

  bot.on("resourcePack", (packUrl) => {
    try {
      bot.acceptResourcePack();
      log.info(`Accepted resource pack (mineflayer) ${String(packUrl ?? "").slice(0, 120)}`);
    } catch (error) {
      log.warn("Could not accept resource pack", error instanceof Error ? error.message : error);
    }
  });

  bot.on("login", () => {
    awaitingLogin = false;
    leave("login");
  });
  bot.on("spawn", () => {
    awaitingLogin = false;
    leave("spawn");
  });
}
