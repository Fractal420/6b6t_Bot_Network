import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

function envFileCandidates(): string[] {
  const cwdEnv = path.resolve(process.cwd(), ".env");
  const packageEnv = path.resolve(root, ".env");
  return cwdEnv === packageEnv ? [packageEnv] : [cwdEnv, packageEnv];
}

for (const envPath of envFileCandidates()) {
  dotenv.config({ path: envPath });
}

function envString(name: string, fallback = ""): string {
  const value = process.env[name];
  return value === undefined ? fallback : value;
}

function envNumber(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export type AuthMode = "offline" | "microsoft";

export interface FractalConfig {
  host: string;
  port: number;
  username: string;
  password: string;
  auth: AuthMode;
  version: string;
  viewDistance: number;
  controlHost: string;
  controlPort: number;
  controlToken: string;
  requiredServerPortals: number;
  portalRetryMs: number;
  reconnectMs: number;
  rootDir: string;
}

export function loadConfig(overrides: Partial<FractalConfig> = {}): FractalConfig {
  const authRaw = envString("FRACTAL_AUTH", "offline").toLowerCase();
  const config: FractalConfig = {
    host: envString("FRACTAL_HOST", "alt3.6b6t.org"),
    port: envNumber("FRACTAL_PORT", 25565),
    username: envString("FRACTAL_USERNAME"),
    password: envString("FRACTAL_PASSWORD"),
    auth: authRaw === "microsoft" ? "microsoft" : "offline",
    version: envString("FRACTAL_VERSION", "1.21.11"),
    viewDistance: envNumber("FRACTAL_VIEW_DISTANCE", 6),
    controlHost: envString("FRACTAL_CONTROL_HOST", "127.0.0.1"),
    controlPort: envNumber("FRACTAL_CONTROL_PORT", 37637),
    controlToken: envString("FRACTAL_CONTROL_TOKEN"),
    requiredServerPortals: envNumber("FRACTAL_SERVER_PORTALS", 2),
    portalRetryMs: envNumber("FRACTAL_PORTAL_RETRY_MS", 60_000),
    reconnectMs: envNumber("FRACTAL_RECONNECT_MS", 8_000),
    rootDir: root,
  };
  const cleaned = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<FractalConfig>;
  return { ...config, ...cleaned };
}

export function assertJoinConfig(config: FractalConfig): void {
  if (!config.username) {
    throw new Error("Missing username. Set FRACTAL_USERNAME in .env");
  }
  if (config.auth === "offline" && !config.password) {
    throw new Error("Missing in-game password. Set FRACTAL_PASSWORD in .env");
  }
}

export function credentialsExist(config: FractalConfig): boolean {
  return Boolean(config.username && (config.auth !== "offline" || config.password));
}

export function configPath(): string {
  for (const envPath of envFileCandidates()) {
    if (fs.existsSync(envPath)) return envPath;
  }
  return path.join(process.cwd(), ".env");
}

export function upsertEnvVar(key: string, value: string): void {
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("invalid env key");
  if (/[\r\n]/.test(value)) throw new Error("invalid env value");
  const envPath = configPath();
  const line = `${key}=${value}`;
  let text = "";
  if (fs.existsSync(envPath)) {
    text = fs.readFileSync(envPath, "utf8");
    const re = new RegExp(`^${key}=.*$`, "m");
    text = re.test(text) ? text.replace(re, line) : `${text.replace(/\s*$/, "")}\n${line}\n`;
    fs.writeFileSync(envPath, text, { mode: 0o600 });
    fs.chmodSync(envPath, 0o600);
    return;
  }
  fs.writeFileSync(envPath, `${line}\n`, { mode: 0o600 });
}
