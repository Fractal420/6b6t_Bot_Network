/**
 * Persistent settings under Settings/ and per-account profiles under Settings/Profiles/.
 *
 * Layout:
 *   Settings/settings.json          — global knobs (former .env)
 *   Settings/announcements.json     — default announcement list
 *   Settings/Profiles/<LabelOrUsername>.json — one file per account profile
 *
 * Legacy `.env` and `accounts.json` are still read once for migration.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID } from "node:crypto";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

function resolveRoot(): string {
  const cwd = process.cwd();
  // Prefer package root when running from repo; otherwise cwd
  if (fs.existsSync(path.join(packageRoot, "package.json"))) return packageRoot;
  return cwd;
}

export function settingsDir(): string {
  return path.join(resolveRoot(), "Settings");
}

export function profilesDir(): string {
  return path.join(settingsDir(), "Profiles");
}

export function settingsFilePath(): string {
  return path.join(settingsDir(), "settings.json");
}

export function announcementsFilePath(): string {
  return path.join(settingsDir(), "announcements.json");
}

export function ensureSettingsLayout(): void {
  const dir = settingsDir();
  const profiles = profilesDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!fs.existsSync(profiles)) fs.mkdirSync(profiles, { recursive: true, mode: 0o700 });
}

function safeWriteJson(filePath: string, data: unknown): void {
  ensureSettingsLayout();
  const tmp = `${filePath}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n", { mode: 0o600 });
  fs.renameSync(tmp, filePath);
  try {
    fs.chmodSync(filePath, 0o600);
  } catch {
    /* ignore */
  }
}

function readJson<T>(filePath: string): T | null {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, "utf8")) as T;
  } catch {
    return null;
  }
}

/** Flat key → string map matching SETTINGS_FIELDS / .env keys. */
export type SettingsMap = Record<string, string>;

export interface SettingsDocument {
  version: 1;
  values: SettingsMap;
}

const DEFAULT_VALUES: SettingsMap = {
  MC_HOST: "alt3.6b6t.org",
  MC_HOSTS: "alt3.6b6t.org,alt.6b6t.org,alt4.6b6t.org,alt5.6b6t.org,alt2.6b6t.org",
  MC_PORT: "25565",
  MC_USERNAME: "",
  MC_PASSWORD: "",
  MC_AUTH: "offline",
  MC_VERSION: "1.21.11",
  MC_VIEW_DISTANCE: "6",
  CONTROL_HOST: "127.0.0.1",
  CONTROL_PORT: "37637",
  CONTROL_TOKEN: "",
  CONTROL_EXPOSE: "0",
  SERVER_PORTALS: "2",
  PORTAL_RETRY_MS: "60000",
  RECONNECT_MS: "8000",
  RECONNECT_MAX_MS: "300000",
  RATE_LIMIT_COOLDOWN_MS: "45000",
  CAPTCHA_COOLDOWN_MS: "3600000",
  MAP_OUTPUT_DIR: "./output",
  MAP_MODE: "box",
  MAP_HOME_NAME: "spawn",
  MAP_BOX_X1: "20000",
  MAP_BOX_Z1: "20000",
  MAP_BOX_X2: "24000",
  MAP_BOX_Z2: "24000",
  MAP_AUTO_START: "0",
  DISCORD_ENABLED: "0",
  DISCORD_TOKEN: "",
  DISCORD_CHANNEL_ID: "",
  DISCORD_MIRROR_LOGS: "1",
};

function envCandidates(): string[] {
  const root = resolveRoot();
  const cwdEnv = path.resolve(process.cwd(), ".env");
  const packageEnv = path.resolve(root, ".env");
  return cwdEnv === packageEnv ? [packageEnv] : [cwdEnv, packageEnv];
}

/** Parse a simple KEY=VALUE .env file into a map (no export/quotes complexity beyond basics). */
function parseEnvFile(filePath: string): SettingsMap {
  if (!fs.existsSync(filePath)) return {};
  const out: SettingsMap = {};
  const text = fs.readFileSync(filePath, "utf8");
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1);
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }
    if (/^[A-Z0-9_]+$/.test(key)) out[key] = value;
  }
  return out;
}

function applyToProcessEnv(values: SettingsMap): void {
  for (const [key, value] of Object.entries(values)) {
    if (value !== undefined && value !== null) process.env[key] = String(value);
  }
}

/**
 * Load global settings. Priority:
 * 1. Settings/settings.json
 * 2. Migrate from .env if present
 * 3. Defaults
 */
export function loadSettingsDocument(): SettingsDocument {
  ensureSettingsLayout();
  const existing = readJson<SettingsDocument>(settingsFilePath());
  if (existing?.version === 1 && existing.values && typeof existing.values === "object") {
    const merged = { ...DEFAULT_VALUES, ...existing.values };
    applyToProcessEnv(merged);
    return { version: 1, values: merged };
  }

  // Migrate from first existing .env
  let migrated: SettingsMap = { ...DEFAULT_VALUES };
  for (const envPath of envCandidates()) {
    const parsed = parseEnvFile(envPath);
    if (Object.keys(parsed).length) {
      migrated = { ...migrated, ...parsed };
      break;
    }
  }
  // Also pick up anything already in process.env (e.g. shell-exported)
  for (const key of Object.keys(DEFAULT_VALUES)) {
    if (process.env[key] !== undefined && process.env[key] !== "") {
      migrated[key] = process.env[key] as string;
    }
  }

  const doc: SettingsDocument = { version: 1, values: migrated };
  safeWriteJson(settingsFilePath(), doc);
  applyToProcessEnv(migrated);
  return doc;
}

export function getSettingsValues(): SettingsMap {
  return loadSettingsDocument().values;
}

export function setSettingsValue(key: string, value: string): void {
  if (!/^[A-Z0-9_]+$/.test(key)) throw new Error("invalid settings key");
  if (/[\r\n]/.test(value)) throw new Error("invalid settings value");
  const doc = loadSettingsDocument();
  doc.values[key] = value;
  safeWriteJson(settingsFilePath(), doc);
  process.env[key] = value;
}

export function saveSettingsMap(
  values: Record<string, string>,
  opts?: { skipEmptySecrets?: Set<string> },
): { saved: string[]; skipped: string[] } {
  const doc = loadSettingsDocument();
  const saved: string[] = [];
  const skipped: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (!/^[A-Z0-9_]+$/.test(key)) {
      skipped.push(key);
      continue;
    }
    if (opts?.skipEmptySecrets?.has(key) && (value === undefined || value === "")) {
      skipped.push(key);
      continue;
    }
    if (/[\r\n]/.test(String(value ?? ""))) throw new Error(`invalid value for ${key}`);
    doc.values[key] = String(value ?? "");
    process.env[key] = doc.values[key];
    saved.push(key);
  }
  safeWriteJson(settingsFilePath(), doc);
  return { saved, skipped };
}

// ── Profiles (one JSON file each under Settings/Profiles/) ───────────────

export interface ProfileFile {
  version: 1;
  /** Same shape as AccountRecord in accounts.ts */
  account: Record<string, unknown>;
}

/** Safe filesystem stem from display label or username (not UUID). */
export function sanitizeProfileFileBase(name: string): string {
  const s = String(name || "")
    .trim()
    .replace(/[^a-zA-Z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64);
  return s || "profile";
}

/**
 * Preferred filename stem: profile label → player username → id.
 * Collisions get `_<shortId>` appended by the caller.
 */
export function preferredProfileBase(account: Record<string, unknown>): string {
  const label = typeof account.label === "string" ? account.label.trim() : "";
  const username = typeof account.username === "string" ? account.username.trim() : "";
  const id = account.id != null ? String(account.id) : "";
  return sanitizeProfileFileBase(label || username || id || "profile");
}

function accountIdFromFile(file: string): string | null {
  const doc = readJson<ProfileFile>(file);
  if (doc?.version === 1 && doc.account && typeof doc.account === "object") {
    const id = doc.account.id;
    return id != null ? String(id) : null;
  }
  const raw = readJson<Record<string, unknown>>(file);
  if (raw?.id != null) return String(raw.id);
  return null;
}

export function listProfileFiles(): string[] {
  ensureSettingsLayout();
  if (!fs.existsSync(profilesDir())) return [];
  return fs
    .readdirSync(profilesDir())
    .filter((name) => name.endsWith(".json"))
    .map((name) => path.join(profilesDir(), name));
}

export function loadAllProfiles(): Array<Record<string, unknown>> {
  ensureSettingsLayout();
  const out: Array<Record<string, unknown>> = [];
  for (const file of listProfileFiles()) {
    const doc = readJson<ProfileFile>(file);
    if (doc?.version === 1 && doc.account && typeof doc.account === "object") {
      out.push(doc.account);
    } else {
      // tolerate raw AccountRecord files
      const raw = readJson<Record<string, unknown>>(file);
      if (raw && (raw.username || raw.id)) out.push(raw);
    }
  }
  return out;
}

/**
 * Write one profile using label/username for the file name.
 * Pass `baseOverride` when resolving collisions in a batch save.
 */
export function saveProfile(account: Record<string, unknown>, baseOverride?: string): string {
  ensureSettingsLayout();
  const id = String(account.id || randomUUID());
  account.id = id;
  const base = sanitizeProfileFileBase(baseOverride || preferredProfileBase(account));
  const filePath = path.join(profilesDir(), `${base}.json`);
  const doc: ProfileFile = { version: 1, account };
  safeWriteJson(filePath, doc);
  return filePath;
}

export function removeProfileFile(id: string): boolean {
  const target = String(id);
  let removed = false;
  for (const file of listProfileFiles()) {
    const fileId = accountIdFromFile(file);
    const base = path.basename(file, ".json");
    if (fileId === target || base === target) {
      try {
        fs.unlinkSync(file);
        removed = true;
      } catch {
        /* ignore */
      }
    }
  }
  return removed;
}

export function saveAllProfiles(accounts: Array<Record<string, unknown>>): void {
  ensureSettingsLayout();
  const usedBases = new Set<string>();
  const keepBases = new Set<string>();
  const keepIds = new Set<string>();

  for (const account of accounts) {
    const id = String(account.id || randomUUID());
    account.id = id;
    keepIds.add(id);

    let base = preferredProfileBase(account);
    const key = base.toLowerCase();
    if (usedBases.has(key)) {
      base = sanitizeProfileFileBase(`${base}_${id.slice(0, 8)}`);
    }
    usedBases.add(base.toLowerCase());
    keepBases.add(base);

    saveProfile(account, base);
  }

  // Drop files that are no longer in the set (old UUID names, renames, deleted accounts)
  for (const file of listProfileFiles()) {
    const base = path.basename(file, ".json");
    const fileId = accountIdFromFile(file);
    if (keepBases.has(base)) continue;
    if (fileId && keepIds.has(fileId)) {
      // Same account written under a new name — remove stale path
      try {
        fs.unlinkSync(file);
      } catch {
        /* ignore */
      }
      continue;
    }
    try {
      fs.unlinkSync(file);
    } catch {
      /* ignore */
    }
  }
}

export interface AnnouncementsDocument {
  version: 1;
  defaultAnnouncements: Array<{ message: string; intervalMs: number }>;
}

export function loadAnnouncements(): AnnouncementsDocument {
  ensureSettingsLayout();
  const existing = readJson<AnnouncementsDocument>(announcementsFilePath());
  if (existing?.version === 1 && Array.isArray(existing.defaultAnnouncements)) {
    return existing;
  }
  const fallback: AnnouncementsDocument = {
    version: 1,
    defaultAnnouncements: [{ message: "Fractal bot online.", intervalMs: 300_000 }],
  };
  safeWriteJson(announcementsFilePath(), fallback);
  return fallback;
}

export function saveAnnouncements(doc: AnnouncementsDocument): void {
  safeWriteJson(announcementsFilePath(), { version: 1, defaultAnnouncements: doc.defaultAnnouncements });
}

/**
 * One-shot migration of legacy accounts.json into Settings/Profiles/.
 * Returns true if migration wrote files.
 */
export function migrateLegacyAccountsIfNeeded(
  legacyPath: string,
): { migrated: boolean; count: number } {
  ensureSettingsLayout();
  if (listProfileFiles().length > 0) return { migrated: false, count: 0 };
  if (!fs.existsSync(legacyPath)) return { migrated: false, count: 0 };
  try {
    const raw = JSON.parse(fs.readFileSync(legacyPath, "utf8")) as {
      accounts?: Array<Record<string, unknown>>;
      defaultAnnouncements?: Array<{ message: string; intervalMs: number }>;
    };
    const accounts = Array.isArray(raw.accounts) ? raw.accounts : [];
    if (!accounts.length) return { migrated: false, count: 0 };
    saveAllProfiles(accounts);
    if (Array.isArray(raw.defaultAnnouncements) && raw.defaultAnnouncements.length) {
      saveAnnouncements({ version: 1, defaultAnnouncements: raw.defaultAnnouncements });
    }
    return { migrated: true, count: accounts.length };
  } catch {
    return { migrated: false, count: 0 };
  }
}
