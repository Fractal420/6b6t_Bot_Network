/**
 * Optional Discord remote control for Fractal.
 * Opt-in via DISCORD_ENABLED=1 + DISCORD_TOKEN + DISCORD_CHANNEL_ID.
 * discord.js is loaded lazily so installs without Discord stay light.
 */
import { createRequire } from "node:module";
import { log } from "../logger.ts";
import type { FractalBot } from "../api/FractalBot.ts";

const require = createRequire(import.meta.url);

export interface DiscordControlOptions {
  token: string;
  channelId: string;
  /** Prefix for commands, default "!" */
  prefix?: string;
  /** Mirror bot logs into the channel */
  mirrorLogs?: boolean;
}

export interface DiscordControl {
  start(): void;
  stop(): void;
  /** Queue a line for batched send to the control channel */
  log(text: string): void;
}

export function createDiscordControl(bot: FractalBot, options: DiscordControlOptions): DiscordControl {
  let Client: new (opts: unknown) => {
    on: (e: string, fn: (...args: unknown[]) => void) => void;
    once: (e: string, fn: (...args: unknown[]) => void) => void;
    login: (token: string) => Promise<unknown>;
    destroy: () => void;
    user?: { tag?: string };
    channels: { cache: { get: (id: string) => { send: (t: string) => Promise<unknown> } | undefined } };
  };
  let GatewayIntentBits: { Guilds: number; GuildMessages: number; MessageContent: number };

  try {
    const discord = require("discord.js") as {
      Client: typeof Client;
      GatewayIntentBits: typeof GatewayIntentBits;
    };
    Client = discord.Client;
    GatewayIntentBits = discord.GatewayIntentBits;
  } catch {
    throw new Error(
      'DISCORD_ENABLED is set but "discord.js" is not installed. Run: npm install discord.js',
    );
  }

  const prefix = options.prefix ?? "!";
  const channelId = options.channelId;
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.MessageContent,
    ],
  });

  let buffer: string[] = [];
  let flushScheduled = false;
  const LIMIT = 1900;

  const flush = () => {
    flushScheduled = false;
    if (!buffer.length) return;
    const ch = client.channels.cache.get(channelId);
    const lines = buffer;
    buffer = [];
    if (!ch) return;
    let cur = "";
    const chunks: string[] = [];
    for (const l of lines) {
      const cand = cur ? `${cur}\n${l}` : l;
      if (cand.length > LIMIT) {
        if (cur) chunks.push(cur);
        cur = l.slice(0, LIMIT);
      } else cur = cand;
    }
    if (cur) chunks.push(cur);
    for (const t of chunks) {
      ch.send(t).catch((err: Error) => log.warn(`[discord] send failed: ${err.message}`));
    }
  };

  const queueLog = (text: string) => {
    if (!options.mirrorLogs) return;
    buffer.push(String(text));
    if (!flushScheduled) {
      flushScheduled = true;
      setTimeout(flush, 4000);
    }
  };

  const replyHelp = () =>
    [
      "**Fractal Discord control**",
      `\`${prefix}status\` — bot + mapper status`,
      `\`${prefix}join\` / \`${prefix}leave\` / \`${prefix}reconnect\``,
      `\`${prefix}chat <msg>\` / \`${prefix}cmd <command>\``,
      `\`${prefix}hunt\` / \`${prefix}unhunt\` — lobby portals`,
      `\`${prefix}map on [mode]\` — start elytra mapping (box, spawn, ring, north, …)`,
      `\`${prefix}map on box:x1,z1,x2,z2\` — map a box`,
      `\`${prefix}map off\` / \`${prefix}map status\``,
      `\`${prefix}captcha\` — last kick / captcha links / code`,
      `\`${prefix}help\` — this list`,
    ].join("\n");

  const handleCommand = async (sub: string, arg: string, reply: (t: string) => void) => {
    const s = sub.toLowerCase();

    // !map … namespace (Elytra-compatible)
    if (s === "map") {
      const parts = arg.trim().split(/\s+/);
      const mapSub = (parts[0] || "").toLowerCase();
      const mapArg = parts.slice(1).join(" ");
      if (mapSub === "on") {
        let mode = mapArg || "box";
        const bm = mode.match(/^box[:\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)[,\s]+(-?\d+)/i);
        if (bm) {
          bot.setMappingConfig({
            box: {
              x1: Number(bm[1]),
              z1: Number(bm[2]),
              x2: Number(bm[3]),
              z2: Number(bm[4]),
            },
          });
          mode = "box";
        }
        reply(bot.startMapping(mode));
        return;
      }
      if (mapSub === "off") {
        reply(bot.stopMapping());
        return;
      }
      if (mapSub === "status") {
        const st = bot.getMappingStatus();
        const m = (st.mapping || {}) as Record<string, unknown>;
        reply(
          `active=${st.active} state=${m.state ?? "?"} mode=${m.mode ?? "?"} covered=${m.covered ?? "?"}/${m.waypoints ?? "?"} out=${st.output?.dir ?? "?"}`,
        );
        return;
      }
      reply(`map commands: \`${prefix}map on [mode]\`, \`${prefix}map off\`, \`${prefix}map status\``);
      return;
    }

    switch (s) {
      case "help":
        reply(replyHelp());
        break;
      case "status": {
        const st = bot.getStatus();
        const map = bot.getMappingStatus();
        reply(
          [
            `phase=${st.phase} world=${st.worldKind} auth=${st.authenticated}`,
            `pos=${st.position ? `${st.position.x.toFixed(0)},${st.position.y.toFixed(0)},${st.position.z.toFixed(0)}` : "?"}`,
            `hp=${st.health ?? "?"} food=${st.food ?? "?"} players=${st.players}`,
            `mapping=${map.active ? "on" : "off"} lastKick=${st.lastKickKind ?? "none"}`,
            st.lastKick ? `kick: ${String(st.lastKick).slice(0, 200)}` : "",
          ]
            .filter(Boolean)
            .join("\n"),
        );
        break;
      }
      case "join":
        await bot.join();
        reply("join requested");
        break;
      case "leave":
        await bot.leave("discord");
        reply("left");
        break;
      case "reconnect":
        await bot.reconnect();
        reply("reconnect requested");
        break;
      case "chat":
        if (!arg.trim()) {
          reply("usage: chat <message>");
          break;
        }
        bot.chat(arg);
        reply("sent");
        break;
      case "cmd":
        if (!arg.trim()) {
          reply("usage: cmd <command without slash>");
          break;
        }
        bot.runCommand(arg.replace(/^\//, ""));
        reply("command sent");
        break;
      case "hunt":
        bot.startPortalHunt();
        reply("portal hunt on");
        break;
      case "unhunt":
        bot.stopPortalHunt();
        reply("portal hunt off");
        break;
      case "captcha": {
        const st = bot.getStatus();
        const links = st.lastKickLinks || [];
        reply(
          [
            `kind=${st.lastKickKind ?? "none"}`,
            st.lastKick ? String(st.lastKick).slice(0, 300) : "no kick stored",
            links.length ? links.map((u) => u).join("\n") : "no links",
          ].join("\n"),
        );
        break;
      }
      default:
        reply(`unknown \`${prefix}${s}\` — try \`${prefix}help\``);
    }
  };

  client.on("error", (e: unknown) => {
    const msg = e instanceof Error ? e.message : String(e);
    log.warn(`[discord] client error: ${msg}`);
  });

  client.on("messageCreate", (msg: {
    author?: { bot?: boolean };
    channelId?: string;
    content?: string;
    reply: (t: string) => Promise<unknown>;
  }) => {
    if (msg.author?.bot || msg.channelId !== channelId) return;
    const content = String(msg.content ?? "").trim();
    if (!content.startsWith(prefix)) return;
    const body = content.slice(prefix.length).trim();
    const parts = body.split(/\s+/);
    const sub = parts[0] || "";
    const arg = parts.slice(1).join(" ");
    if (!sub) return;
    void handleCommand(sub, arg, (text) => {
      msg.reply(String(text)).catch(() => {});
    }).catch((err: Error) => {
      log.warn(`[discord] command error: ${err.message}`);
      msg.reply(`error: ${err.message}`).catch(() => {});
    });
  });

  // Forward captcha kicks into Discord immediately
  bot.on("kicked", (info) => {
    const reason = info.reason;
    const kind = info.kind;
    const links = info.links || [];
    if (kind === "captcha" || links.length) {
      queueLog(`[CAPTCHA] ${reason}`);
      for (const link of links) queueLog(link);
      // Force faster flush for captcha
      if (!flushScheduled) {
        flushScheduled = true;
        setTimeout(flush, 500);
      } else {
        setTimeout(flush, 500);
      }
    }
  });

  return {
    start() {
      const onReady = () => {
        log.info(`[discord] connected as ${client.user?.tag ?? "?"}, channel ${channelId}`);
      };
      client.once("clientReady", onReady);
      client.once("ready", onReady);
      client.login(options.token).catch((e: Error) => {
        log.error(`[discord] login failed: ${e.message}`);
      });
    },
    stop() {
      try {
        client.destroy();
      } catch {
        /* ignore */
      }
    },
    log: queueLog,
  };
}
