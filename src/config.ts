import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  getSettingsValues,
  loadSettingsDocument,
  saveSettingsMap,
  setSettingsValue,
  settingsFilePath,
  settingsDir,
} from "./settings/store.ts";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// Load Settings/settings.json (migrates from .env on first run) into process.env
loadSettingsDocument();

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
  /** How often to re-scan loaded player entities (ms). Fixes missed leave events after teleports. */
  detectionRecheckMs: number;
  detectionPlayers: boolean;
  detectionCrystals: boolean;
  detectionTnt: boolean;
  detectionExplosions: boolean;
  detectionCombat: boolean;
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
    portalRetryMs: envNumber("PORTAL_RETRY_MS", 3_000),
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
    detectionRecheckMs: envNumber("DETECTION_RECHECK_MS", 3_000),
    detectionPlayers: envString("DETECTION_PLAYERS", "1") !== "0",
    detectionCrystals: envString("DETECTION_CRYSTALS", "1") !== "0",
    detectionTnt: envString("DETECTION_TNT", "1") !== "0",
    detectionExplosions: envString("DETECTION_EXPLOSIONS", "1") !== "0",
    detectionCombat: envString("DETECTION_COMBAT", "1") !== "0",
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
    throw new Error("Missing username. Set MC_USERNAME in Settings/settings.json (or a profile)");
  }
  if (config.auth === "offline" && !config.password) {
    throw new Error("Missing in-game password. Set MC_PASSWORD in Settings/settings.json (or a profile)");
  }
}

export function credentialsExist(config: FractalConfig): boolean {
  return Boolean(config.username && (config.auth !== "offline" || config.password));
}

/** Path to the global settings file (Settings/settings.json). */
export function configPath(): string {
  return settingsFilePath();
}

export function settingsFolderPath(): string {
  return settingsDir();
}

export function upsertEnvVar(key: string, value: string): void {
  setSettingsValue(key, value);
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

/** Process-level knobs (Settings tab). Profile knobs live under each tab’s ⚙. */
export const SETTINGS_FIELDS: SettingsFieldDef[] = [
  { key: "CONTROL_HOST", label: "Control API host", group: "Control API", type: "string", restart: true },
  { key: "CONTROL_PORT", label: "Control API port", group: "Control API", type: "number", restart: true },
  { key: "CONTROL_TOKEN", label: "Control token", group: "Control API", type: "password", secret: true, restart: true },
  {
    key: "CONTROL_EXPOSE",
    label: "Expose API off loopback",
    group: "Control API",
    type: "boolean",
    restart: true,
    help: "Dangerous: allows non-localhost clients when token is set",
  },
  { key: "DISCORD_ENABLED", label: "Discord enabled", group: "Discord", type: "boolean", restart: true },
  { key: "DISCORD_TOKEN", label: "Discord bot token", group: "Discord", type: "password", secret: true, restart: true },
  { key: "DISCORD_CHANNEL_ID", label: "Discord channel ID", group: "Discord", type: "string", restart: true },
  { key: "DISCORD_MIRROR_LOGS", label: "Mirror logs to Discord", group: "Discord", type: "boolean", restart: true },
  { key: "MC_HOST", label: "Default server host", group: "Defaults", type: "string" },
  { key: "MC_HOSTS", label: "Host failover list", group: "Defaults", type: "string", help: "Comma-separated" },
  { key: "MC_PORT", label: "Default server port", group: "Defaults", type: "number" },
  { key: "MC_VERSION", label: "Default protocol version", group: "Defaults", type: "string" },
];

function readEnvRaw(key: string): string {
  const stored = getSettingsValues()[key];
  if (stored !== undefined) return stored;
  return process.env[key] ?? "";
}

/** Snapshot for the settings UI (secrets returned as empty unless set — use placeholder). */
export function getSettingsSnapshot(): {
  path: string;
  folder: string;
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
  return { path: configPath(), folder: settingsDir(), fields };
}

/**
 * Persist key/value pairs to Settings/settings.json and process.env.
 * Empty password fields are skipped (keep existing secret).
 */
export function saveSettingsValues(values: Record<string, string>): { saved: string[]; skipped: string[] } {
  const allowed = new Set(SETTINGS_FIELDS.map((f) => f.key));
  const prepared: Record<string, string> = {};
  const skipped: string[] = [];
  const secretKeys = new Set<string>();
  for (const [key, value] of Object.entries(values)) {
    if (!allowed.has(key)) {
      skipped.push(key);
      continue;
    }
    const def = SETTINGS_FIELDS.find((f) => f.key === key)!;
    if (def.secret && (value === undefined || value === "")) {
      skipped.push(key);
      secretKeys.add(key);
      continue;
    }
    let v = String(value ?? "");
    if (def.type === "boolean") {
      v = v === "1" || v === "true" || v === "on" || v === "yes" ? "1" : "0";
    }
    if (def.type === "number" && v !== "" && !Number.isFinite(Number(v))) {
      throw new Error(`${key} must be a number`);
    }
    prepared[key] = v;
  }
  const result = saveSettingsMap(prepared, { skipEmptySecrets: secretKeys });
  return { saved: result.saved, skipped: [...skipped, ...result.skipped] };
}

/** Build a FractalConfig from current Settings store. */
export function reloadConfigFromEnv(): FractalConfig {
  loadSettingsDocument();
  return loadConfig();
}
