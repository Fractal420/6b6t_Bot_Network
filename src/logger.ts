import chalk from "chalk";

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

function now(): string {
  return new Date().toISOString().slice(11, 23);
}

export class Logger {
  constructor(
    private readonly name: string,
    private minLevel: LogLevel = "info",
  ) {}

  setLevel(level: LogLevel): void {
    this.minLevel = level;
  }

  child(name: string): Logger {
    return new Logger(`${this.name}:${name}`, this.minLevel);
  }

  debug(message: string, extra?: unknown): void {
    this.write("debug", chalk.gray, message, extra);
  }

  info(message: string, extra?: unknown): void {
    this.write("info", chalk.cyan, message, extra);
  }

  warn(message: string, extra?: unknown): void {
    this.write("warn", chalk.yellow, message, extra);
  }

  error(message: string, extra?: unknown): void {
    this.write("error", chalk.red, message, extra);
  }

  private write(level: LogLevel, color: (s: string) => string, message: string, extra?: unknown): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[this.minLevel]) return;
    const prefix = `${chalk.dim(now())} ${color(level.padEnd(5))} ${chalk.white(this.name)}`;
    if (extra === undefined) {
      console.log(`${prefix} ${message}`);
      return;
    }
    console.log(`${prefix} ${message}`, extra);
  }
}

export const log = new Logger("fractalbot");
