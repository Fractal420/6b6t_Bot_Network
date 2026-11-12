/**
 * Multi-account registry — one profile file each under Settings/Profiles/.
 * Features are stackable; only mutually exclusive jobs conflict.
 */
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  loadAllProfiles,
  saveAllProfiles,
  loadAnnouncements,
  saveAnnouncements,
  migrateLegacyAccountsIfNeeded,
  profilesDir,
  settingsDir,
} from "../settings/store.ts";

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

/**
 * Per-account profile overrides (isolated from global .env).
 * Undefined fields fall back to the process-level FractalConfig.
 */
export interface AccountProfile {
  autoLobby?: boolean;
  autoReconnect?: boolean;
  viewDistance?: number;
  /** Protocol version override for this bot */
  version?: string;
  /** Mapper output directory for this bot only */
  mapOutputDir?: string;
  mapMode?: string;
  mapHomeName?: string;
  mapBox?: { x1: number; z1: number; x2: number; z2: number };
  mapAutoStart?: boolean;
  reconnectMs?: number;
  reconnectMaxMs?: number;
  rateLimitCooldownMs?: number;
  captchaCooldownMs?: number;
  requiredServerPortals?: number;
  portalRetryMs?: number;
  /** Re-scan loaded players every N ms (teleport / chunk unload misses entityGone). */
  detectionRecheckMs?: number;
  /**
   * Wait this long after a player leaves render range before emitting player_leave.
   * Re-entry within the window suppresses leave + enter (no log / notify spam).
   * Stored per profile in Settings/Profiles.
   */
  detectionPlayerLeaveGraceMs?: number;
  detectionPlayers?: boolean;
  detectionCrystals?: boolean;
  detectionTnt?: boolean;
  detectionExplosions?: boolean;
  detectionCombat?: boolean;
  serverListener?: boolean;
  /** Include client→server packets when serverListener is on (default true). */
  serverListenerOutbound?: boolean;
  /** Anti-AFK interval for this profile (ms). */
  antiAfkIntervalMs?: number;
  /**
   * Push/browser notification prefs for detection — stored per profile on disk.
   */
  notifyPrefs?: {
    playerEnter?: boolean;
    playerLeave?: boolean;
    combat?: boolean;
    crystals?: boolean;
    tnt?: boolean;
    explosions?: boolean;
    onlyHidden?: boolean;
    lobby?: boolean;
  };
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
  /** Independent settings for this bot profile */
  profile?: AccountProfile;
  /** Optional per-account announcement list (else global defaults). */
  announcementMessages?: AnnouncementItem[];
  /** @deprecated kept for migration */
  task?: BotTask;
  taskOptions?: { mapMode?: string };
  label?: string;
  notes?: string;
}

export interface AccountsFile {
  version: 2;
  accounts: AccountRecord[];
  /** Global default announcements used when account has none of its own */
  defaultAnnouncements?: AnnouncementItem[];
}

const DEFAULT_FEATURES: AccountFeatures = {
  online: false,
  hunt: false,
  map: false,
  mapMode: "box",
  announcements: false,
  antiAfk: false,
};

function accountsPath(): string {
  return profilesDir();
}

function legacyAccountsJsonPath(): string {
  // Old single-file store next to package root / cwd
  const candidates = [
    path.join(settingsDir(), "..", "accounts.json"),
    path.join(process.cwd(), "accounts.json"),
  ];
  return candidates[0];
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
  const profile = normalizeProfile(a.profile);
  return {
    id: a.id || randomUUID(),
    username: String(a.username || ""),
    password: String(a.password || ""),
    auth: a.auth === "microsoft" ? "microsoft" : "offline",
    host: a.host || undefined,
    port: typeof a.port === "number" ? a.port : undefined,
    enabled: a.enabled !== false,
    features,
    profile: Object.keys(profile).length ? profile : undefined,
    announcementMessages: Array.isArray(a.announcementMessages)
      ? a.announcementMessages.filter((x) => x && x.message && x.intervalMs > 0)
      : undefined,
    label: a.label || undefined,
    notes: a.notes ? String(a.notes) : undefined,
  };
}

function normalizeProfile(p: Partial<AccountProfile> | undefined): AccountProfile {
  if (!p || typeof p !== "object") return {};
  const out: AccountProfile = {};
  if (typeof p.autoLobby === "boolean") out.autoLobby = p.autoLobby;
  if (typeof p.autoReconnect === "boolean") out.autoReconnect = p.autoReconnect;
  if (typeof p.viewDistance === "number" && Number.isFinite(p.viewDistance)) out.viewDistance = p.viewDistance;
  if (typeof p.version === "string" && p.version.trim()) out.version = p.version.trim();
  if (typeof p.mapOutputDir === "string" && p.mapOutputDir.trim()) out.mapOutputDir = p.mapOutputDir.trim();
  if (typeof p.mapMode === "string" && p.mapMode.trim()) out.mapMode = p.mapMode.trim();
  if (typeof p.mapHomeName === "string" && p.mapHomeName.trim()) out.mapHomeName = p.mapHomeName.trim();
  if (p.mapBox && typeof p.mapBox === "object") {
    const b = p.mapBox;
    if ([b.x1, b.z1, b.x2, b.z2].every((n) => typeof n === "number" && Number.isFinite(n))) {
      out.mapBox = { x1: b.x1, z1: b.z1, x2: b.x2, z2: b.z2 };
    }
  }
  if (typeof p.mapAutoStart === "boolean") out.mapAutoStart = p.mapAutoStart;
  for (const k of [
    "reconnectMs",
    "reconnectMaxMs",
    "rateLimitCooldownMs",
    "captchaCooldownMs",
    "requiredServerPortals",
    "portalRetryMs",
    "detectionRecheckMs",
    "detectionPlayerLeaveGraceMs",
  ] as const) {
    const v = p[k];
    if (typeof v === "number" && Number.isFinite(v) && v >= 0) out[k] = v;
  }
  for (const k of ["detectionPlayers", "detectionCrystals", "detectionTnt", "detectionExplosions", "detectionCombat"] as const) {
    if (typeof p[k] === "boolean") out[k] = p[k];
  }
  if (typeof p.serverListener === "boolean") out.serverListener = p.serverListener;
  if (typeof p.serverListenerOutbound === "boolean") out.serverListenerOutbound = p.serverListenerOutbound;
  if (typeof p.antiAfkIntervalMs === "number" && Number.isFinite(p.antiAfkIntervalMs) && p.antiAfkIntervalMs >= 5_000) {
    out.antiAfkIntervalMs = Math.floor(p.antiAfkIntervalMs);
  }
  if (p.notifyPrefs && typeof p.notifyPrefs === "object") {
    const n = p.notifyPrefs as Record<string, unknown>;
    const prefs: NonNullable<AccountProfile["notifyPrefs"]> = {};
    for (const k of ["playerEnter", "playerLeave", "combat", "crystals", "tnt", "explosions", "onlyHidden", "lobby"] as const) {
      if (typeof n[k] === "boolean") prefs[k] = n[k] as boolean;
    }
    if (Object.keys(prefs).length) out.notifyPrefs = prefs;
  }
  return out;
}

export function loadAccountsFile(): AccountsFile {
  // Migrate legacy accounts.json → Settings/Profiles/*.json once
  migrateLegacyAccountsIfNeeded(legacyAccountsJsonPath());
  migrateLegacyAccountsIfNeeded(path.join(process.cwd(), "accounts.json"));

  const accounts = loadAllProfiles().map((raw) => normalizeAccount(raw as Partial<AccountRecord>));
  const announcements = loadAnnouncements();
  return {
    version: 2,
    accounts,
    defaultAnnouncements:
      announcements.defaultAnnouncements?.length > 0
        ? announcements.defaultAnnouncements
        : defaultAnnouncementPreset(),
  };
}

export function defaultAnnouncementPreset(): AnnouncementItem[] {
  return [
    { message: "Fractal bot online.", intervalMs: 300_000 },
  ];
}

export function saveAccountsFile(data: AccountsFile): void {
  saveAllProfiles(data.accounts as unknown as Array<Record<string, unknown>>);
  saveAnnouncements({
    version: 1,
    defaultAnnouncements: data.defaultAnnouncements ?? defaultAnnouncementPreset(),
  });
}

export function accountsFilePath(): string {
  return accountsPath();
}

export function upsertAccount(
  accounts: AccountRecord[],
  input: Partial<AccountRecord> & { username: string },
): AccountRecord[] {
  const username = String(input.username || "").trim();
  if (!username) {
    throw new Error("username is required");
  }

  // Prefer match by id; never silently merge two different profiles by username
  let existing = -1;
  if (input.id) {
    existing = accounts.findIndex((a) => a.id === input.id);
  }

  if (existing < 0) {
    // Creating a new account (or id not found): reject duplicate username
    const dup = accounts.findIndex((a) => a.username.toLowerCase() === username.toLowerCase());
    if (dup >= 0 && (!input.id || accounts[dup].id !== input.id)) {
      throw new Error(`username "${username}" already exists on another profile`);
    }
  } else {
    // Updating: if username changes, ensure no other profile owns it
    const dup = accounts.findIndex(
      (a, i) => i !== existing && a.username.toLowerCase() === username.toLowerCase(),
    );
    if (dup >= 0) {
      throw new Error(`username "${username}" already exists on another profile`);
    }
  }

  const id = existing >= 0 ? accounts[existing].id : input.id || randomUUID();
  const base = existing >= 0 ? accounts[existing] : {};
  const mergedFeatures = normalizeFeatures({
    ...(base as AccountRecord).features,
    ...(input.features || {}),
  });
  const mergedProfile = {
    ...((base as AccountRecord).profile || {}),
    ...(input.profile || {}),
  };
  const password =
    input.password !== undefined && input.password !== "" && input.password !== "***"
      ? input.password
      : (base as AccountRecord).password || "";

  // Preserve enabled/features when not provided on update
  const enabled =
    input.enabled !== undefined
      ? Boolean(input.enabled)
      : existing >= 0
        ? (base as AccountRecord).enabled
        : false;

  const next = normalizeAccount({
    ...base,
    ...input,
    username,
    password,
    features: mergedFeatures,
    profile: mergedProfile,
    id,
    enabled,
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
