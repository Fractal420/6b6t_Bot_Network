/**
 * Multi-account registry (accounts.json).
 * Features are stackable; only mutually exclusive jobs conflict.
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { configPath } from "../config.ts";

/** Legacy single-task names (still accepted when loading old files). */
export type BotTask = "idle" | "join" | "hunt" | "map"  | "leave";

export interface AnnouncementItem {
  message: string;
  /** Interval in ms */
  intervalMs: number;
}

/**
 * Per-account feature flags. Safe combinations:
 * - announcements + anything online
 * - antiAfk + online (paused while map/hunt active)
 * Conflicts:
 * - map vs hunt (map wins on main world intent)
 * - leave/offline clears active jobs
 */
export interface AccountFeatures {
  /** Stay connected with auto-reconnect / auto-lobby */
  online: boolean;
  /** Lobby portal hunt */
  hunt: boolean;
  /** Elytra terrain mapping */
  map: boolean;
  mapMode?: string;
  /** Timed chat announcements */
  announcements: boolean;
  /** Periodic anti-AFK movement (skipped while map/hunt running) */
  antiAfk: boolean;
}

export interface AccountRecord {
  id: string;
  username: string;
  password: string;
  auth: "offline" | "microsoft";
  host?: string;
  port?: number;
  enabled: boolean;
  features: AccountFeatures;
  /** Optional per-account announcement list (else global defaults). */
  announcementMessages?: AnnouncementItem[];
  /** @deprecated kept for migration */
  task?: BotTask;
  taskOptions?: { mapMode?: string };
  label?: string;
}

export interface AccountsFile {
  version: 2;
  accounts: AccountRecord[];
  /** Global default announcements used when account has none of its own */
  defaultAnnouncements?: AnnouncementItem[];
}

const DEFAULT_FEATURES: AccountFeatures = {
  online: true,
  hunt: false,
  map: false,
  mapMode: "box",
  announcements: false,
  antiAfk: false,
};

function accountsPath(): string {
  const envPath = configPath();
  return path.join(path.dirname(envPath), "accounts.json");
}

export function defaultFeatures(): AccountFeatures {
  return { ...DEFAULT_FEATURES };
}

/** Resolve conflicts: map disables hunt; offline clears jobs. */
export function normalizeFeatures(f: Partial<AccountFeatures> | undefined): AccountFeatures {
  const out: AccountFeatures = {
    ...DEFAULT_FEATURES,
    ...(f || {}),
    mapMode: f?.mapMode || DEFAULT_FEATURES.mapMode,
  };
  if (!out.online) {
    out.hunt = false;
    out.map = false;
    // announcements flags kept but won't run while offline
  }
  if (out.map && out.hunt) {
    out.hunt = false; // map wins
  }
  return out;
}

function featuresFromLegacyTask(task?: BotTask, taskOptions?: { mapMode?: string }): AccountFeatures {
  const f = defaultFeatures();
  switch (task) {
    case "leave":
      f.online = false;
      break;
    case "idle":
    case "join":
      f.online = true;
      break;
    case "hunt":
      f.online = true;
      f.hunt = true;
      break;
    case "map":
      f.online = true;
      f.map = true;
      f.mapMode = taskOptions?.mapMode || "box";
      break;
    default:
      break;
  }
  return f;
}

function normalizeAccount(a: Partial<AccountRecord>): AccountRecord {
  let features: AccountFeatures;
  if (a.features) {
    features = normalizeFeatures(a.features);
  } else {
    features = featuresFromLegacyTask(a.task, a.taskOptions);
  }
  if (a.taskOptions?.mapMode && !a.features?.mapMode) {
    features.mapMode = a.taskOptions.mapMode;
  }
  return {
    id: a.id || randomUUID(),
    username: String(a.username || ""),
    password: String(a.password || ""),
    auth: a.auth === "microsoft" ? "microsoft" : "offline",
    host: a.host || undefined,
    port: typeof a.port === "number" ? a.port : undefined,
    enabled: a.enabled !== false,
    features,
    announcementMessages: Array.isArray(a.announcementMessages)
      ? a.announcementMessages.filter((x) => x && x.message && x.intervalMs > 0)
      : undefined,
    label: a.label || undefined,
  };
}

export function loadAccountsFile(): AccountsFile {
  const p = accountsPath();
  if (!fs.existsSync(p)) {
    return { version: 2, accounts: [], defaultAnnouncements: defaultAnnouncementPreset() };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8")) as AccountsFile;
    if (!raw || !Array.isArray(raw.accounts)) {
      return { version: 2, accounts: [], defaultAnnouncements: defaultAnnouncementPreset() };
    }
    return {
      version: 2,
      accounts: raw.accounts.map(normalizeAccount),
      defaultAnnouncements:
        Array.isArray(raw.defaultAnnouncements) && raw.defaultAnnouncements.length
          ? raw.defaultAnnouncements
          : defaultAnnouncementPreset(),
    };
  } catch {
    return { version: 2, accounts: [], defaultAnnouncements: defaultAnnouncementPreset() };
  }
}

export function defaultAnnouncementPreset(): AnnouncementItem[] {
  return [
    { message: "Fractal bot online.", intervalMs: 300_000 },
  ];
}

export function saveAccountsFile(data: AccountsFile): void {
  const p = accountsPath();
  const payload: AccountsFile = {
    version: 2,
    accounts: data.accounts,
    defaultAnnouncements: data.defaultAnnouncements ?? defaultAnnouncementPreset(),
  };
  fs.writeFileSync(p, JSON.stringify(payload, null, 2) + "\n", { mode: 0o600 });
  try {
    fs.chmodSync(p, 0o600);
  } catch {
    /* ignore */
  }
}

export function accountsFilePath(): string {
  return accountsPath();
}

export function upsertAccount(
  accounts: AccountRecord[],
  input: Partial<AccountRecord> & { username: string },
): AccountRecord[] {
  const id = input.id || randomUUID();
  const existing = accounts.findIndex((a) => a.id === id || a.username === input.username);
  const base = existing >= 0 ? accounts[existing] : {};
  const mergedFeatures = normalizeFeatures({
    ...(base as AccountRecord).features,
    ...input.features,
  });
  const next = normalizeAccount({
    ...base,
    ...input,
    features: mergedFeatures,
    id: existing >= 0 ? (base as AccountRecord).id : id,
  });
  if (existing >= 0) {
    const copy = accounts.slice();
    copy[existing] = next;
    return copy;
  }
  return [...accounts, next];
}

export function removeAccount(accounts: AccountRecord[], id: string): AccountRecord[] {
  return accounts.filter((a) => a.id !== id);
}

export function seedFromEnvIfEmpty(
  accounts: AccountRecord[],
  env: { username: string; password: string; auth: "offline" | "microsoft" },
): AccountRecord[] {
  if (accounts.length > 0) return accounts;
  if (!env.username) return accounts;
  return [
    normalizeAccount({
      username: env.username,
      password: env.password,
      auth: env.auth,
      enabled: true,
      features: { ...defaultFeatures(), online: true },
      label: "primary",
    }),
  ];
}

/** Human-readable feature summary */
export function featuresSummary(f: AccountFeatures): string {
  const parts: string[] = [];
  if (!f.online) return "offline";
  parts.push("online");
  if (f.hunt) parts.push("hunt");
  if (f.map) parts.push(`map:${f.mapMode || "box"}`);
  if (f.announcements) parts.push("announce");
  if (f.antiAfk) parts.push("antiAfk");
  return parts.join("+");
}
