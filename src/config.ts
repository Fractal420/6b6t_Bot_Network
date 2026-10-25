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
  /** Ordered failover list; first entry is preferred host. */
  hosts: string[];
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
  /** Base reconnect delay (ms). Used for normal kicks. */
  reconnectMs: number;
  /** Max exponential backoff (ms). */
  reconnectMaxMs: number;
  /** Minimum delay after a rate-limit / "logging in too fast" kick. */
  rateLimitCooldownMs: number;
  /**
   * Cooldown after a captcha / anti-bot kick (ms).
   * Set to 0 to stop reconnecting entirely until the operator restarts.
   */
  captchaCooldownMs: number;
  rootDir: string;
  /** Elytra mapper output directory (Xaero regions). */
  mapOutputDir: string;
  /** Default mapping mode: box, spawn, ring, north, ... */
  mapMode: string;
  mapHomeName: string;
  mapBox: { x1: number; z1: number; x2: number; z2: number };
  mapAutoStart: boolean;
  discordEnabled: boolean;
  discordToken: string;
  discordChannelId: string;
  discordMirrorLogs: boolean;
}

export function loadConfig(overrides: Partial<FractalConfig> = {}): FractalConfig {
  const authRaw = envString("MC_AUTH", "offline").toLowerCase();
  const config: FractalConfig = {
    host: envString("MC_HOST", "alt3.6b6t.org"),
    hosts: (envString("MC_HOSTS", "") || envString("MC_HOST", "alt3.6b6t.org"))
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    port: envNumber("MC_PORT", 25565),
    username: envString("MC_USERNAME"),
    password: envString("MC_PASSWORD"),
    auth: authRaw === "microsoft" ? "microsoft" : "offline",
    version: envString("MC_VERSION", "1.21.11"),
    viewDistance: envNumber("MC_VIEW_DISTANCE", 6),
    controlHost: envString("CONTROL_HOST", "127.0.0.1"),
    controlPort: envNumber("CONTROL_PORT", 37637),
    controlToken: envString("CONTROL_TOKEN"),
    requiredServerPortals: envNumber("SERVER_PORTALS", 2),
    portalRetryMs: envNumber("PORTAL_RETRY_MS", 60_000),
    reconnectMs: envNumber("RECONNECT_MS", 8_000),
    reconnectMaxMs: envNumber("RECONNECT_MAX_MS", 300_000),
    rateLimitCooldownMs: envNumber("RATE_LIMIT_COOLDOWN_MS", 45_000),
    captchaCooldownMs: envNumber("CAPTCHA_COOLDOWN_MS", 3_600_000),
    rootDir: root,
    mapOutputDir: envString("MAP_OUTPUT_DIR", path.join(root, "output")),
    mapMode: envString("MAP_MODE", "box"),
    mapHomeName: envString("MAP_HOME_NAME", "spawn"),
    mapBox: {
      x1: envNumber("MAP_BOX_X1", 20000),
      z1: envNumber("MAP_BOX_Z1", 20000),
      x2: envNumber("MAP_BOX_X2", 24000),
      z2: envNumber("MAP_BOX_Z2", 24000),
    },
    mapAutoStart: envString("MAP_AUTO_START", "0") === "1",
    discordEnabled: envString("DISCORD_ENABLED", "0") === "1",
    discordToken: envString("DISCORD_TOKEN", ""),
    discordChannelId: envString("DISCORD_CHANNEL_ID", ""),
    discordMirrorLogs: envString("DISCORD_MIRROR_LOGS", "1") === "1",
  };
  if (!config.hosts.length) config.hosts = [config.host];
  if (!config.host) config.host = config.hosts[0];
  const cleaned = Object.fromEntries(
    Object.entries(overrides).filter(([, value]) => value !== undefined),
  ) as Partial<FractalConfig>;
  return { ...config, ...cleaned };
}

export function assertJoinConfig(config: FractalConfig): void {
  if (!config.username) {
    throw new Error("Missing username. Set MC_USERNAME in .env");
  }
  if (config.auth === "offline" && !config.password) {
    throw new Error("Missing in-game password. Set MC_PASSWORD in .env");
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
  } else {
    fs.writeFileSync(envPath, `${line}\n`, { mode: 0o600 });
  }
  process.env[key] = value;
}

export type SettingsFieldType = "string" | "number" | "boolean" | "password" | "select";

export interface SettingsFieldDef {
  key: string;
  label: string;
  group: string;
  type: SettingsFieldType;
  secret?: boolean;
  /** Needs process restart to fully apply */
  restart?: boolean;
  options?: string[];
  help?: string;
}

/** All .env knobs editable from the web UI */
export const SETTINGS_FIELDS: SettingsFieldDef[] = [
  { key: "MC_HOST", label: "Server host", group: "Minecraft", type: "string" },
  { key: "MC_PORT", label: "Server port", group: "Minecraft", type: "number" },
  { key: "MC_USERNAME", label: "Username", group: "Minecraft", type: "string" },
  { key: "MC_PASSWORD", label: "In-game password", group: "Minecraft", type: "password", secret: true },
  { key: "MC_AUTH", label: "Auth mode", group: "Minecraft", type: "select", options: ["offline", "microsoft"] },
  { key: "MC_VERSION", label: "Protocol version", group: "Minecraft", type: "string" },
  { key: "MC_VIEW_DISTANCE", label: "View distance (chunks)", group: "Minecraft", type: "number" },

  { key: "SERVER_PORTALS", label: "Server portals required", group: "Lobby", type: "number" },
  { key: "PORTAL_RETRY_MS", label: "Portal retry (ms)", group: "Lobby", type: "number" },

  { key: "RECONNECT_MS", label: "Base reconnect (ms)", group: "Reconnect", type: "number" },
  { key: "RECONNECT_MAX_MS", label: "Max reconnect backoff (ms)", group: "Reconnect", type: "number" },
  { key: "RATE_LIMIT_COOLDOWN_MS", label: "Rate-limit cooldown (ms)", group: "Reconnect", type: "number" },
  { key: "CAPTCHA_COOLDOWN_MS", label: "Captcha cooldown (ms, 0=halt)", group: "Reconnect", type: "number" },

  { key: "CONTROL_HOST", label: "Control API host", group: "Control API", type: "string", restart: true },
  { key: "CONTROL_PORT", label: "Control API port", group: "Control API", type: "number", restart: true },
  { key: "CONTROL_TOKEN", label: "Control token", group: "Control API", type: "password", secret: true, restart: true },

  { key: "MAP_OUTPUT_DIR", label: "Mapper output dir", group: "Elytra map", type: "string" },
  { key: "MAP_MODE", label: "Default map mode", group: "Elytra map", type: "string", help: "box, spawn, ring, north, …" },
  { key: "MAP_HOME_NAME", label: "Home name", group: "Elytra map", type: "string" },
  { key: "MAP_BOX_X1", label: "Box X1", group: "Elytra map", type: "number" },
  { key: "MAP_BOX_Z1", label: "Box Z1", group: "Elytra map", type: "number" },
  { key: "MAP_BOX_X2", label: "Box X2", group: "Elytra map", type: "number" },
  { key: "MAP_BOX_Z2", label: "Box Z2", group: "Elytra map", type: "number" },
  { key: "MAP_AUTO_START", label: "Auto-start mapping", group: "Elytra map", type: "boolean" },

  { key: "DISCORD_ENABLED", label: "Discord enabled", group: "Discord", type: "boolean", restart: true },
  { key: "DISCORD_TOKEN", label: "Discord bot token", group: "Discord", type: "password", secret: true, restart: true },
  { key: "DISCORD_CHANNEL_ID", label: "Discord channel ID", group: "Discord", type: "string", restart: true },
  { key: "DISCORD_MIRROR_LOGS", label: "Mirror logs to Discord", group: "Discord", type: "boolean", restart: true },

];

function readEnvRaw(key: string): string {
  return process.env[key] ?? "";
}

/** Snapshot for the settings UI (secrets returned as empty unless set — use placeholder). */
export function getSettingsSnapshot(): {
  path: string;
  fields: Array<SettingsFieldDef & { value: string; hasSecret?: boolean }>;
} {
  const fields = SETTINGS_FIELDS.map((def) => {
    const raw = readEnvRaw(def.key);
    if (def.secret) {
      return {
        ...def,
        value: "",
        hasSecret: Boolean(raw),
      };
    }
    if (def.type === "boolean") {
      return { ...def, value: raw === "1" || raw.toLowerCase() === "true" ? "1" : raw === "" ? "" : "0" };
    }
    return { ...def, value: raw };
  });
  return { path: configPath(), fields };
}

/**
 * Persist key/value pairs to .env and process.env.
 * Empty password fields are skipped (keep existing secret).
 */
export function saveSettingsValues(values: Record<string, string>): { saved: string[]; skipped: string[] } {
  const allowed = new Set(SETTINGS_FIELDS.map((f) => f.key));
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) {
      skipped.push(key);
      continue;
    }
    const def = SETTINGS_FIELDS.find((f) => f.key === key)!;
    if (def.secret && (value === undefined || value === "")) {
      skipped.push(key);
      continue;
    }
    let v = String(value ?? "");
    if (def.type === "boolean") {
      v = v === "1" || v === "true" || v === "on" || v === "yes" ? "1" : "0";
    }
    if (def.type === "number" && v !== "" && !Number.isFinite(Number(v))) {
      throw new Error(`${key} must be a number`);
    }
    upsertEnvVar(key, v);
    saved.push(key);
  }
  return { saved, skipped };
}

/** Build a FractalConfig from current process.env (after save). */
export function reloadConfigFromEnv(): FractalConfig {
  return loadConfig();
}
