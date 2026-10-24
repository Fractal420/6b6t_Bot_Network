import readline from "node:readline";
import chalk from "chalk";
import type { FractalBot } from "../api/FractalBot.ts";
import type { InvCommand } from "../api/types.ts";
import { CLI_COMMANDS, complete } from "./complete.ts";
import { stripCtl } from "../api/security.ts";

export function startRepl(bot: FractalBot): Promise<void> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    completer: (line: string) => {
      const args = line.trimStart().split(/\s+/);
      const hits = complete(args.filter(Boolean).length ? args : [""]);
      return [hits, args.at(-1) ?? ""];
    },
  });

  const prompt = () => {
    const status = bot.getStatus();
    rl.setPrompt(chalk.green(`fractal:${status.phase}> `));
    rl.prompt();
  };

  bot.on("chat", (event) => {
    readline.cursorTo(process.stdout, 0);
    console.log(chalk.white(stripCtl(event.raw)));
    prompt();
  });
  bot.on("phase", (phase) => {
    readline.cursorTo(process.stdout, 0);
    console.log(chalk.magenta(`phase → ${phase}`));
    prompt();
  });
  bot.on("kicked", (reason) => {
    readline.cursorTo(process.stdout, 0);
    console.log(chalk.red(`kicked: ${stripCtl(String(reason))}`));
    prompt();
  });

  console.log(chalk.dim(`Interactive control. Commands: ${CLI_COMMANDS.join(", ")}`));
  console.log(chalk.dim("Type `join` to connect with stored credentials. Tab completes."));
  prompt();

  return new Promise((resolve) => {
    rl.on("line", async (line) => {
      const raw = line.trim();
      if (!raw) {
        prompt();
        return;
      }
      if (raw === "exit" || raw === "quit") {
        rl.close();
        return;
      }
      try {
        await handleReplLine(bot, raw);
      } catch (error) {
        console.log(chalk.red(error instanceof Error ? error.message : String(error)));
      }
      prompt();
    });
    rl.on("close", () => resolve());
  });
}

export async function handleReplLine(bot: FractalBot, line: string): Promise<void> {
  const args = tokenize(line);
  const command = args.shift() ?? "";
  switch (command) {
    case "join":
      await bot.join(parseJoinFlags(args));
      break;
    case "leave":
      await bot.leave();
      break;
    case "reconnect":
      await bot.reconnect();
      break;
    case "status":
      console.log(bot.getStatus());
      break;
    case "chat":
    case "say":
      bot.chat(args.join(" "));
      break;
    case "cmd":
      bot.runCommand(args.join(" "));
      break;
    case "goto": {
      const [x, y, z] = args.map(Number);
      if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error("usage: goto <x> <y> <z>");
      bot.goto(x, y, z);
      break;
    }
    case "look": {
      if (args.length >= 3) {
        const [x, y, z] = args.map(Number);
        if ([x, y, z].some((n) => Number.isNaN(n))) throw new Error("usage: look <x> <y> <z> | look <yaw> <pitch>");
        await bot.lookAt(x, y, z);
        break;
      }
      if (args.length === 2) {
        const [yaw, pitch] = args.map(Number);
        if ([yaw, pitch].some((n) => Number.isNaN(n))) throw new Error("usage: look <yaw> <pitch>");
        console.log(await bot.look({ yaw, pitch }));
        break;
      }
      console.log(bot.getLook());
      break;
    }
    case "turn": {
      const [yaw, pitch] = args.map(Number);
      console.log(await bot.turn(yaw || 0, pitch || 0));
      break;
    }
    case "jump":
      bot.jump();
      break;
    case "walk": {
      const dir = args[0] ?? "forward";
      bot.stopMovement();
      if (dir === "stop") break;
      bot.setControl({ [dir]: true } as never);
      break;
    }
    case "stop":
      bot.stopMovement();
      break;
    case "attack":
      bot.attack(args[0]);
      break;
    case "dig": {
      if (args.length >= 3) await bot.dig(Number(args[0]), Number(args[1]), Number(args[2]));
      else await bot.dig();
      break;
    }
    case "players":
      console.log(bot.getPlayers());
      break;
    case "inv":
    case "inventory": {
      const opRaw = args[0];
      if (!opRaw) {
        console.log(bot.getInventory());
        break;
      }
      const mapped =
        opRaw === "toss" || opRaw === "dropstack" ? "dropStack" : opRaw === "offhand" ? "equip" : opRaw;
      const command: InvCommand = { op: mapped as InvCommand["op"] };
      if (args[1] != null && Number.isFinite(Number(args[1]))) command.slot = Number(args[1]);
      if (mapped === "swap" && args[2] != null) command.to = Number(args[2]);
      if (mapped === "drop" && args[2] != null) command.count = Number(args[2]);
      const destRaw = args[2] === "offhand" ? "off-hand" : args[2];
      if (destRaw && ["hand", "off-hand", "head", "torso", "legs", "feet"].includes(destRaw)) {
        command.dest = destRaw as InvCommand["dest"];
      }
      if (opRaw === "offhand") command.dest = "off-hand";
      console.log(await bot.manageInventory(command));
      break;
    }
    case "map":
      console.log(bot.getMap(args[0] ? Number(args[0]) : 24));
      break;
    case "view":
      console.log(JSON.stringify(bot.getView(args[0] ? Number(args[0]) : 20, args.includes("--map")), null, 2));
      break;
    case "voxels":
      console.log(JSON.stringify(bot.getVoxels(args[0] ? Number(args[0]) : 20), null, 2));
      break;
    case "catalog": {
      const { apiCatalog } = await import("../api/catalog.ts");
      console.log(JSON.stringify(apiCatalog(), null, 2));
      break;
    }
    case "dump":
      console.log(JSON.stringify(bot.dump(), null, 2));
      break;
    case "hunt":
      bot.startPortalHunt();
      console.log("Portal hunt started");
      break;
    case "unhunt":
      bot.stopPortalHunt();
      console.log("Portal hunt stopped");
      break;
    case "help":
      console.log(CLI_COMMANDS.join("\n"));
      break;
    default:
      if (command.startsWith("/")) {
        bot.runCommand(command.slice(1) + (args.length ? ` ${args.join(" ")}` : ""));
        break;
      }
      throw new Error(`Unknown command '${command}'. Try help.`);
  }
}

function parseJoinFlags(args: string[]): { host?: string; username?: string } {
  const options: { host?: string; username?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--host") options.host = args[++i];
    if (args[i] === "--username" || args[i] === "-u") options.username = args[++i];
  }
  return options;
}

function tokenize(line: string): string[] {
  const matches = line.match(/"[^"]*"|'[^']*'|\S+/g) ?? [];
  return matches.map((part) => part.replace(/^['"]|['"]$/g, ""));
}
