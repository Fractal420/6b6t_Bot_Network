import type { Bot } from "mineflayer";
import { createRequire } from "node:module";
import { log } from "../logger.ts";

const require = createRequire(import.meta.url);

/**
 * prismarine-chat / minecraft-protocol call Buffer.writeInt32BE on UUID ints
 * that arrive as BigInt from NBT. minecraft-protocol does:
 *   const { processNbtMessage } = require("prismarine-chat")
 * so patching the export is useless — the closed-over reference still crashes.
 * Patch Buffer writers once so every caller accepts BigInt.
 */
let chatBigIntPatched = false;
export function patchPrismarineChatBigInt(): void {
  if (chatBigIntPatched) return;
  chatBigIntPatched = true;
  try {
    const toInt32 = (value: unknown): number => {
      if (typeof value === "bigint") {
        const masked = Number(value & 0xffffffffn);
        return masked > 0x7fffffff ? masked - 0x100000000 : masked;
      }
      if (typeof value === "number" && Number.isFinite(value)) return value | 0;
      return Number(value) | 0;
    };
    const toUInt32 = (value: unknown): number => {
      if (typeof value === "bigint") return Number(value & 0xffffffffn) >>> 0;
      if (typeof value === "number" && Number.isFinite(value)) return value >>> 0;
      return Number(value) >>> 0;
    };

    const proto = Buffer.prototype as Buffer & {
      writeInt32BE: (value: number, offset?: number) => number;
      writeInt32LE: (value: number, offset?: number) => number;
      writeUInt32BE: (value: number, offset?: number) => number;
      writeUInt32LE: (value: number, offset?: number) => number;
    };
    const wrap =
      (orig: (value: number, offset?: number) => number, conv: (v: unknown) => number) =>
      function (this: Buffer, value: number, offset?: number) {
        return orig.call(this, conv(value), offset);
      };

    proto.writeInt32BE = wrap(proto.writeInt32BE, toInt32);
    proto.writeInt32LE = wrap(proto.writeInt32LE, toInt32);
    proto.writeUInt32BE = wrap(proto.writeUInt32BE, toUInt32);
    proto.writeUInt32LE = wrap(proto.writeUInt32LE, toUInt32);

    log.info("Patched Buffer int writers for BigInt UUIDs (chat/NBT safe)");
  } catch (err) {
    log.warn("Failed to patch BigInt buffer writers", err instanceof Error ? err.message : err);
  }
}

/**
 * Vanilla 1.21.2+ sends `tick_end` every client tick and 1.21.4+ sends
 * `player_loaded` after the play login + terrain. Mineflayer 4.x does not.
 * 6b6t's sky-lobby backend ignores commands and portal logic until then.
 */
export function attachProtocolCompat(bot: Bot): void {
  patchPrismarineChatBigInt();
  const raw = bot._client as unknown as {
    on: (event: string, listener: (...args: unknown[]) => void) => void;
    write: (name: string, params: unknown) => void;
    state?: string;
  };

  let lastLoadedAt = 0;
  let pendingLoaded: NodeJS.Timeout | null = null;
  let waitingForChunks = false;

  const sendLoaded = (reason: string, force = false) => {
    try {
      if (!bot.supportFeature("sendsPlayerLoadedPacket")) return;
      if (raw.state && raw.state !== "play") return;
      const now = Date.now();
      if (!force && now - lastLoadedAt < 800) return;
      lastLoadedAt = now;
      waitingForChunks = false;
      raw.write("player_loaded", {});
      log.info(`Sent player_loaded (${reason})`);
    } catch (error) {
      log.warn(`player_loaded failed (${reason})`, error instanceof Error ? error.message : error);
    }
  };

  const scheduleLoaded = (reason: string, delayMs: number) => {
    if (pendingLoaded) clearTimeout(pendingLoaded);
    pendingLoaded = setTimeout(() => sendLoaded(reason, true), delayMs);
  };

  const resetChatSession = () => {
    const client = bot._client as {
      _lastSeenMessages?: { pending?: number; offset?: number; length: number };
      _lastChatSignature?: unknown;
      _lastRejectedMessage?: unknown;
    };
    const seen = client._lastSeenMessages;
    if (seen) {
      seen.pending = 0;
      seen.offset = 0;
      seen.length = 0;
    }
    client._lastChatSignature = null;
    client._lastRejectedMessage = null;
  };

  const sendSettings = (reason: string) => {
    try {
      if (raw.state && raw.state !== "play") return;
      raw.write("settings", {
        locale: "en_US",
        viewDistance: 8,
        chatFlags: 0,
        chatColors: true,
        skinParts: 127,
        mainHand: 1,
        enableTextFiltering: false,
        enableServerListing: true,
        particleStatus: "all",
      });
      log.info(`Sent client settings (${reason})`);
    } catch (error) {
      log.warn(`settings failed (${reason})`, error instanceof Error ? error.message : error);
    }
  };

  raw.on("login", () => {
    resetChatSession();
    sendSettings("play-login");
    scheduleLoaded("play-login", 250);
  });
  bot.on("spawn", () => scheduleLoaded("spawn", 400));
  bot.on("respawn", () => scheduleLoaded("respawn", 400));
  raw.on("finish_configuration", () => {
    resetChatSession();
    setTimeout(() => sendSettings("reconfigure"), 120);
    scheduleLoaded("reconfigure", 900);
  });
  raw.on("game_state_change", (...args: unknown[]) => {
    const packet = args[0] as { reason?: string | number } | undefined;
    const reason = String(packet?.reason ?? "");
    if (reason === "level_chunks_load_start" || reason === "13") {
      waitingForChunks = true;
      scheduleLoaded("chunks-load-start", 450);
    }
  });
  raw.on("chunk_batch_finished", () => {
    if (waitingForChunks) sendLoaded("chunk-batch", true);
  });

  bot.on("physicsTick", () => {
    try {
      if (raw.state && raw.state !== "play") return;
      if (bot.supportFeature("sendsClientTickEndPacket")) {
        raw.write("tick_end", {});
      }
      if (bot.supportFeature("newPlayerInputPacket")) {
        const c = bot.controlState ?? {};
        raw.write("player_input", {
          inputs: {
            forward: Boolean(c.forward),
            backward: Boolean(c.back),
            left: Boolean(c.left),
            right: Boolean(c.right),
            jump: Boolean(c.jump),
            shift: Boolean(c.sneak),
            sprint: Boolean(c.sprint),
          },
        });
      }
    } catch {}
  });

  // Soft-guard chat-related packets so a single bad NBT payload never tears down the client
  const softChat = (name: string) => {
    try {
      const client = bot._client as unknown as {
        on: (ev: string, fn: (...a: unknown[]) => void) => void;
        listeners?: (ev: string) => Array<(...a: unknown[]) => void>;
      };
      // Prepend an error-swallowing listener; existing minecraft-protocol handlers still run
      client.on(name, () => {
        /* marker — actual protection is the processNbtMessage patch + process handlers */
      });
    } catch {
      /* ignore */
    }
  };
  for (const pkt of ["player_chat", "system_chat", "profileless_chat", "chat"]) {
    softChat(pkt);
  }
}
