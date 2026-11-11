import { Command } from "commander";
import chalk from "chalk";
import { assertJoinConfig, loadConfig, type FractalConfig } from "../config.ts";
import { FractalBot } from "../api/FractalBot.ts";
import { startControlServer } from "../api/controlServer.ts";
import { hardenControlConfig } from "../api/security.ts";
import { log } from "../logger.ts";
import { complete, renderCompletionScript } from "./complete.ts";
import { controlClient } from "./client.ts";
import { startRepl } from "./repl.ts";
import type { ControlRequest, ControlState, EquipmentDest, InvOp } from "../api/types.ts";
import { redactSecrets, stripCtl } from "../api/security.ts";

export async function runCli(argv = process.argv): Promise<void> {
  const completionIndex = argv.indexOf("--complete");
  if (completionIndex >= 0) {
    const rest = argv.slice(completionIndex + 1).filter((arg) => arg !== "--");
    for (const suggestion of complete(rest)) console.log(suggestion);
    return;
  }

  const program = new Command();
  program
    .name("fractalbot")
    .description("Mineflayer control system for 6b6t")
    .showHelpAfterError()
    .enablePositionalOptions();

  program
    .command("join")
    .description("Join 6b6t with the stored offline account (MC_USERNAME / MC_PASSWORD)")
    .option("--host <host>", "server host")
    .option("--port <port>", "server port")
    .option("-u, --username <name>", "offline username")
    .option("--daemon", "run without an interactive shell")
    .option("--no-lobby", "do not auto-walk server portals")
    .option("--no-reconnect", "do not auto-rejoin after kicks")
    .action(async (opts) => {
      const config = loadConfig({
        host: opts.host,
        port: opts.port ? Number(opts.port) : undefined,
        username: opts.username,
      });
      assertJoinConfig(config);
      await runSession(config, {
        daemon: Boolean(opts.daemon),
        autoLobby: opts.lobby !== false,
        autoReconnect: opts.reconnect !== false,
      });
    });

  program
    .command("leave")
    .description("Disconnect the running bot")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "leave" });
    });

  program
    .command("reconnect")
    .description("Force a reconnect of the running bot")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "reconnect" });
    });

  program
    .command("status")
    .description("Print bot status")
    .action(async () => {
      const config = loadConfig();
      const client = controlClient(config);
      if (await client.ping()) {
        printResult(await client.rpc({ action: "status" }));
        return;
      }
      console.log({ connected: false, hint: "Bot is not running. Use `fractalbot join`." });
    });

  program
    .command("chat")
    .argument("<message...>", "chat message")
    .description("Send a chat message")
    .action(async (message: string[]) => {
      await proxyOrFail(loadConfig(), { action: "chat", message: message.join(" ") });
    });

  program
    .command("cmd")
    .argument("<command...>", "in-game command without requiring a leading slash")
    .description("Send a slash command")
    .action(async (command: string[]) => {
      await proxyOrFail(loadConfig(), { action: "command", command: command.join(" ") });
    });

  program
    .command("goto")
    .argument("<x>")
    .argument("<y>")
    .argument("<z>")
    .description("Pathfind to a block")
    .action(async (x: string, y: string, z: string) => {
      await proxyOrFail(loadConfig(), { action: "goto", x: Number(x), y: Number(y), z: Number(z) });
    });

  program
    .command("look")
    .argument("[a]")
    .argument("[b]")
    .argument("[c]")
    .description("Look at x y z, or pass yaw pitch in radians")
    .action(async (a?: string, b?: string, c?: string) => {
      if (c != null) {
        await proxyOrFail(loadConfig(), { action: "lookAt", x: Number(a), y: Number(b), z: Number(c) });
        return;
      }
      if (a != null && b != null) {
        await proxyOrFail(loadConfig(), { action: "look", yaw: Number(a), pitch: Number(b) });
        return;
      }
      await proxyOrFail(loadConfig(), { action: "cursor" });
    });

  program
    .command("turn")
    .argument("<yaw>")
    .argument("[pitch]")
    .description("Add radians to current look")
    .action(async (yaw: string, pitch?: string) => {
      await proxyOrFail(loadConfig(), { action: "turn", yaw: Number(yaw), pitch: Number(pitch ?? 0) });
    });

  program
    .command("jump")
    .description("Tap jump")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "jump" });
    });

  program
    .command("walk")
    .argument("<direction>", "forward | back | left | right | jump | sprint | sneak")
    .description("Hold a movement key")
    .action(async (direction: string) => {
      const state: Partial<ControlState> = { [direction]: true };
      await proxyOrFail(loadConfig(), { action: "control", state });
    });

  program
    .command("stop")
    .description("Clear movement")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "stop" });
    });

  program
    .command("attack")
    .argument("[username]")
    .description("Attack the looked-at entity, or a player name")
    .action(async (username?: string) => {
      await proxyOrFail(loadConfig(), { action: "attack", username });
    });

  program
    .command("dig")
    .argument("[x]")
    .argument("[y]")
    .argument("[z]")
    .description("Dig the looked-at block, or x y z")
    .action(async (x?: string, y?: string, z?: string) => {
      if (x != null && y != null && z != null) {
        await proxyOrFail(loadConfig(), { action: "dig", x: Number(x), y: Number(y), z: Number(z) });
        return;
      }
      await proxyOrFail(loadConfig(), { action: "dig" });
    });

  program
    .command("view")
    .argument("[radius]")
    .description("Fetch surroundings (voxels, look target, entities)")
    .option("--map", "include ASCII map")
    .action(async (radius?: string, opts?: { map?: boolean }) => {
      await proxyOrFail(loadConfig(), {
        action: "view",
        radius: radius != null ? Number(radius) : undefined,
        map: Boolean(opts?.map),
      });
    });

  program
    .command("voxels")
    .argument("[radius]")
    .description("Fetch the 3D block field around the bot")
    .action(async (radius?: string) => {
      await proxyOrFail(loadConfig(), { action: "voxels", radius: radius != null ? Number(radius) : undefined });
    });

  program
    .command("catalog")
    .description("List control API routes and RPC actions")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "catalog" });
    });

  program
    .command("players")
    .description("List nearby/known players")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "players" });
    });

  program
    .command("inv")
    .argument("[op]", "hold | drop | toss | equip | use | swap")
    .argument("[slot]", "inventory slot number")
    .argument("[extra]", "dest, count, or destination slot")
    .description("Show or manage inventory")
    .action(async (op?: string, slot?: string, extra?: string) => {
      if (!op) {
        await proxyOrFail(loadConfig(), { action: "inventory" });
        return;
      }
      await proxyOrFail(loadConfig(), parseInvCommand(op, slot, extra));
    });

  program
    .command("map")
    .description("Print a top-down ASCII map of the area")
    .action(async () => {
      const result = await proxyOrFail(loadConfig(), { action: "map" });
      if (typeof result.data === "string") console.log(result.data);
    });

  program
    .command("dump")
    .description("Dump world probe JSON")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "dump" });
    });

  program
    .command("hunt")
    .description("Start (or restart) automatic server-portal hunting")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "hunt" });
    });

  program
    .command("unhunt")
    .description("Stop automatic server-portal hunting")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "unhunt" });
    });

  program
    .command("map-start")
    .description("Start elytra terrain mapping (Xaero regions). Mode: box, spawn, ring, north, ...")
    .argument("[mode]", "mapping mode", "box")
    .action(async (mode: string) => {
      await proxyOrFail(loadConfig(), { action: "mapStart", mode });
    });

  program
    .command("map-stop")
    .description("Stop elytra terrain mapping")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "mapStop" });
    });

  program
    .command("map-status")
    .description("Show elytra mapper status and output paths")
    .action(async () => {
      await proxyOrFail(loadConfig(), { action: "mapStatus" });
    });

  program

  program

  program

  program
    .command("shell")
    .description("Open an interactive control shell (starts the API if needed)")
    .action(async () => {
      await runSession(loadConfig(), { daemon: false, autoLobby: true, autoReconnect: true, joinNow: false });
    });

  program
    .command("completion")
    .argument("[shell]", "bash | zsh | install")
    .description("Print or install shell autocomplete")
    .action(async (shell?: string) => {
      const kind = shell === "bash" ? "bash" : "zsh";
      const script = renderCompletionScript(kind);
      if (shell === "install") {
        console.log(script);
        console.log(chalk.green(`\nAdd this to your ~/.${kind}rc:\n  eval "$(fractalbot completion ${kind})"`));
        return;
      }
      process.stdout.write(script);
    });

  program.action(async () => {
    await runSession(loadConfig(), { daemon: false, autoLobby: true, autoReconnect: true, joinNow: false });
  });

  await program.parseAsync(argv);
}

async function runSession(
  config: FractalConfig,
  options: { daemon: boolean; autoLobby: boolean; autoReconnect: boolean; joinNow?: boolean },
): Promise<void> {
  const existing = controlClient(config);
  if (await existing.ping()) {
    if (options.joinNow !== false && options.daemon) {
      printResult(await existing.rpc({ action: "join", options: { autoLobby: options.autoLobby, autoReconnect: options.autoReconnect } }));
      return;
    }
    log.info(`Control API already running at ${existing.baseUrl}. Sending join and attaching is CLI-only in this process.`);
    if (options.joinNow !== false) {
      printResult(
        await existing.rpc({
          action: "join",
          options: { autoLobby: options.autoLobby, autoReconnect: options.autoReconnect },
        }),
      );
    }
    if (!options.daemon) {
      console.log(chalk.yellow("A bot process is already running. Use `fractalbot status`, `fractalbot chat`, etc."));
    }
    return;
  }

  const { FleetManager } = await import("../fleet/FleetManager.ts");
  const fleet = new FleetManager(config);
  const hardened = hardenControlConfig(config);
  const server = await startControlServer(fleet, hardened.controlHost, hardened.controlPort, hardened.controlToken);

  let discord: { start: () => void; stop: () => void; log: (t: string) => void } | null = null;
  if (config.discordEnabled) {
    if (!config.discordToken || !config.discordChannelId) {
      log.warn("DISCORD_ENABLED=1 but DISCORD_TOKEN or DISCORD_CHANNEL_ID is missing — Discord control skipped");
    } else {
      try {
        const { createDiscordControl } = await import("../discord/control.ts");
        // Discord binds to primary bot when available; fleet commands use web/RPC
        const primary = fleet.resolveBot(null) || new (await import("../api/FractalBot.ts")).FractalBot(config);
        discord = createDiscordControl(primary, {
          token: config.discordToken,
          channelId: config.discordChannelId,
          mirrorLogs: config.discordMirrorLogs,
        });
        discord.start();
        log.info("Discord remote control starting…");
      } catch (err) {
        log.error("Discord control failed to start", err instanceof Error ? err.message : err);
      }
    }
  }

  const shutdown = async () => {
    try {
      discord?.stop();
    } catch {
      /* ignore */
    }
    await fleet.stopAll();
    await server.close();
    process.exit(0);
  };
  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });
  process.on("uncaughtException", (error) => {
    const msg = error instanceof Error ? error.message : String(error);
    // Known prismarine-chat / NBT UUID BigInt crash — patched, but keep process alive if it slips through
    if (/Cannot convert a BigInt value to a number/i.test(msg) || /BigInt/i.test(msg)) {
      log.warn("ignored BigInt conversion error (chat/NBT)", msg);
      return;
    }
    log.error("uncaught exception", error);
  });
  process.on("unhandledRejection", (reason) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    if (/Cannot convert a BigInt value to a number/i.test(msg) || /BigInt/i.test(msg)) {
      log.warn("ignored BigInt rejection (chat/NBT)", msg);
      return;
    }
    log.error("unhandled rejection", reason instanceof Error ? reason : String(reason));
  });

  if (options.joinNow !== false) {
    const results = await fleet.startAllEnabled();
    for (const r of results) log.info(r);
  }

  if (options.daemon) {
    log.info(`Dashboard at ${server.url}  ·  Fleet accounts: ${fleet.listAccounts().length}`);
    log.info(`CLI: fractalbot status · Web: Fleet panel to add bots & assign tasks`);
    return;
  }

  const bot = fleet.resolveBot(null);
  if (bot) {
    await startRepl(bot);
    await shutdown();
    return;
  }

  // No bot yet — keep the control API / dashboard alive so the user can add
  // accounts via the web Fleet panel or accounts.json, then start them.
  log.warn("No bot running — add accounts in the web Fleet panel or accounts.json");
  log.info(`Dashboard at ${server.url}  ·  Fleet accounts: ${fleet.listAccounts().length}`);
  log.info("Server staying up. Press Ctrl+C to stop.");
}

async function proxyOrFail(config: FractalConfig, request: ControlRequest) {
  const client = controlClient(config);
  if (!(await client.ping())) {
    throw new Error("Bot is not running. Start it with `fractalbot join`.");
  }
  const result = await client.rpc(request);
  printResult(result);
  if (!result.ok) process.exitCode = 1;
  return result;
}

function parseInvCommand(opRaw: string, slotRaw?: string, extra?: string): ControlRequest {
  const aliases: Record<string, InvOp> = {
    hold: "hold",
    drop: "drop",
    toss: "dropStack",
    dropstack: "dropStack",
    equip: "equip",
    unequip: "unequip",
    use: "use",
    swap: "swap",
  };
  const op = aliases[opRaw.toLowerCase()];
  if (!op) throw new Error("inv op must be hold, drop, toss, equip, unequip, use, or swap");
  const slot = slotRaw == null || slotRaw === "" ? undefined : Number(slotRaw);
  if (slotRaw != null && slotRaw !== "" && !Number.isFinite(slot)) throw new Error("slot must be a number");
  if (extra == null || extra === "") return { action: "inv", op, slot };
  if (op === "swap") {
    const to = Number(extra);
    if (!Number.isFinite(to)) throw new Error("destination slot must be a number");
    return { action: "inv", op, slot, to };
  }
  if (op === "drop") {
    const count = Number(extra);
    if (!Number.isFinite(count)) throw new Error("count must be a number");
    return { action: "inv", op, slot, count };
  }
  const dest = extra === "offhand" ? "off-hand" : extra;
  const allowed: EquipmentDest[] = ["hand", "off-hand", "head", "torso", "legs", "feet"];
  if (!allowed.includes(dest as EquipmentDest)) {
    throw new Error("dest must be hand, off-hand, head, torso, legs, or feet");
  }
  return { action: "inv", op, slot, dest: dest as EquipmentDest };
}

function printResult(result: { ok: boolean; error?: string; data?: unknown }): void {
  if (!result.ok) {
    console.error(chalk.red(result.error ?? "request failed"));
    return;
  }
  if (result.data !== undefined) {
    if (typeof result.data === "string") console.log(result.data);
    else console.log(JSON.stringify(result.data, null, 2));
  } else {
    console.log(chalk.green("ok"));
  }
}

function wireLogs(bot: FractalBot): void {
  bot.on("chat", (event) => log.info(`chat ${redactSecrets(stripCtl(event.raw))}`));
  bot.on("kicked", (info) => {
    const reason = typeof info === "string" ? info : info.reason;
    const kind = typeof info === "object" && info.kind ? info.kind : "other";
    const links = typeof info === "object" && Array.isArray(info.links) ? info.links : [];
    log.warn(`kicked (${kind}) ${reason}`);
    for (const link of links) log.warn(`captcha link: ${link}`);
  });
  bot.on("portalFound", (portal) =>
    log.info(`portal ${portal.kind} ${portal.blockName} @ ${portal.position.x},${portal.position.y},${portal.position.z}`),
  );
  bot.on("error", (error) => log.error(error.message));
}
