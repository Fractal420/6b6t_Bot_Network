/**
 * Multi-account fleet with stackable features (online, hunt, map, announcements, antiAfk).
 */
import { EventEmitter } from "node:events";
import type { FractalConfig } from "../config.ts";
import { loadConfig } from "../config.ts";
import { log } from "../logger.ts";
import { FractalBot } from "../api/FractalBot.ts";
import {
  type AccountRecord,
  type AccountFeatures,
  type AnnouncementItem,
  type BotTask,
  loadAccountsFile,
  saveAccountsFile,
  seedFromEnvIfEmpty,
  upsertAccount,
  removeAccount,
  accountsFilePath,
  normalizeFeatures,
  featuresSummary,
  defaultAnnouncementPreset,
} from "./accounts.ts";
import { startAnnouncements, startAntiAfk, type SideJobHandles } from "./sideJobs.ts";

export interface FleetBotStatus {
  id: string;
  label?: string;
  username: string;
  enabled: boolean;
  features: AccountFeatures;
  featuresSummary: string;
  profile?: import("./accounts.ts").AccountProfile;
  auth: "offline" | "microsoft";
  host?: string;
  port?: number;
  notes?: string;
  /** @deprecated */
  task?: BotTask;
  running: boolean;
  bot: ReturnType<FractalBot["getStatus"]> | null;
}

export class FleetManager extends EventEmitter {
  private bots = new Map<string, FractalBot>();
  private accounts: AccountRecord[] = [];
  private defaultAnnouncements: AnnouncementItem[] = defaultAnnouncementPreset();
  private baseConfig: FractalConfig;
  private sideJobs = new Map<string, SideJobHandles[]>();

  constructor(baseConfig?: FractalConfig) {
    super();
    this.baseConfig = baseConfig || loadConfig();
    this.reloadAccountsFromDisk();
  }

  reloadAccountsFromDisk(): void {
    const file = loadAccountsFile();
    file.accounts = seedFromEnvIfEmpty(file.accounts, {
      username: this.baseConfig.username,
      password: this.baseConfig.password,
      auth: this.baseConfig.auth,
    });
    this.accounts = file.accounts;
    this.defaultAnnouncements = file.defaultAnnouncements ?? defaultAnnouncementPreset();
    if (file.accounts.length) {
      const prev = loadAccountsFile();
      if (!prev.accounts.length) {
        saveAccountsFile(file);
        log.info(`Seeded accounts.json from env → ${accountsFilePath()}`);
      }
    }
  }

  listAccounts(): AccountRecord[] {
    return this.accounts.map((a) => ({ ...a, password: a.password ? "***" : "" }));
  }

  getAccount(id: string): AccountRecord | undefined {
    return this.accounts.find((a) => a.id === id);
  }

  getDefaultAnnouncements(): AnnouncementItem[] {
    return this.defaultAnnouncements;
  }

  setDefaultAnnouncements(items: AnnouncementItem[]): void {
    this.defaultAnnouncements = items.filter((x) => x.message && x.intervalMs > 0);
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });
  }

  addOrUpdateAccount(input: Partial<AccountRecord> & { username: string }): AccountRecord {
    this.accounts = upsertAccount(this.accounts, input);
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });
    const username = String(input.username || "").trim();
    const acc =
      (input.id ? this.accounts.find((a) => a.id === input.id) : undefined) ||
      this.accounts.find((a) => a.username.toLowerCase() === username.toLowerCase());
    if (!acc) throw new Error("account save failed");
    // If bot is running, push host/user config for next reconnect
    const live = this.bots.get(acc.id);
    if (live) {
      try {
        live.applyRuntimeConfig(this.configFor(acc));
      } catch {
        /* ignore */
      }
    }
    this.emit("accounts", this.listAccounts());
    this.emit("fleet", this.getFleetStatus());
    return {
      ...acc,
      password: acc.password ? "***" : "",
      hasPassword: Boolean(acc.password),
    } as AccountRecord & { hasPassword: boolean };
  }

  deleteAccount(id: string): void {
    void this.stopBot(id);
    this.accounts = removeAccount(this.accounts, id);
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });
    this.emit("accounts", this.listAccounts());
  }

  private configFor(account: AccountRecord): FractalConfig {
    const p = account.profile || {};
    const mapMode = p.mapMode || account.features.mapMode || this.baseConfig.mapMode;
    return {
      ...this.baseConfig,
      username: account.username,
      password: account.password,
      auth: account.auth,
      host: account.host || this.baseConfig.host,
      port: account.port ?? this.baseConfig.port,
      viewDistance: p.viewDistance ?? this.baseConfig.viewDistance,
      mapOutputDir: p.mapOutputDir || this.baseConfig.mapOutputDir,
      mapMode,
      mapHomeName: p.mapHomeName || this.baseConfig.mapHomeName,
      mapBox: p.mapBox || this.baseConfig.mapBox,
      mapAutoStart: p.mapAutoStart ?? this.baseConfig.mapAutoStart,
      reconnectMs: p.reconnectMs ?? this.baseConfig.reconnectMs,
      reconnectMaxMs: p.reconnectMaxMs ?? this.baseConfig.reconnectMaxMs,
      rateLimitCooldownMs: p.rateLimitCooldownMs ?? this.baseConfig.rateLimitCooldownMs,
      captchaCooldownMs: p.captchaCooldownMs ?? this.baseConfig.captchaCooldownMs,
      requiredServerPortals: p.requiredServerPortals ?? this.baseConfig.requiredServerPortals,
      portalRetryMs: p.portalRetryMs ?? this.baseConfig.portalRetryMs,
      detectionRecheckMs: p.detectionRecheckMs ?? this.baseConfig.detectionRecheckMs,
      detectionPlayers: p.detectionPlayers ?? this.baseConfig.detectionPlayers,
      detectionCrystals: p.detectionCrystals ?? this.baseConfig.detectionCrystals,
      detectionTnt: p.detectionTnt ?? this.baseConfig.detectionTnt,
      detectionExplosions: p.detectionExplosions ?? this.baseConfig.detectionExplosions,
      detectionCombat: p.detectionCombat ?? this.baseConfig.detectionCombat,
    };
  }

  private wireBot(id: string, bot: FractalBot): void {
    const forward = (event: string) => {
      bot.on(event as keyof import("../api/types.ts").FractalBotEvents, (...args: unknown[]) => {
        this.emit("botEvent", { id, event, args });
        this.emit("fleet", this.getFleetStatus());
      });
    };
    for (const e of [
      "phase",
      "kicked",
      "connected",
      "disconnected",
      "status",
      "authenticated",
      "chat",
      "detection",
      "portalEntered",
      "portalFound",
      "worldKind",
      "error",
      "msaCode",
    ] as const) {
      forward(e);
    }
  }

  /**
   * Start (or re-use) the bot instance and connect so Microsoft device-code auth runs.
   * Tokens are cached under Settings/auth_cache and reused on later restarts.
   */
  async authenticateMicrosoft(id: string): Promise<string> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return `unknown account ${id}`;
    if (account.auth !== "microsoft") {
      return `profile "${account.username}" is offline — switch Auth to Microsoft first`;
    }
    if (!account.username) return "account missing username";

    let bot = this.bots.get(id);
    if (!bot) {
      bot = new FractalBot(this.configFor(account));
      this.wireBot(id, bot);
      this.bots.set(id, bot);
    } else {
      bot.applyRuntimeConfig(this.configFor(account));
    }

    // Ensure Online so applyFeatures keeps the session if already connected.
    if (!account.features.online) {
      account.features = normalizeFeatures({ ...account.features, online: true });
      saveAccountsFile({
        version: 2,
        accounts: this.accounts,
        defaultAnnouncements: this.defaultAnnouncements,
      });
    }

    const status = bot.getStatus();
    if (!status.connected) {
      await bot.join({
        autoLobby: account.profile?.autoLobby !== false,
        autoReconnect: true,
        username: account.username,
        password: account.password,
        host: account.host || this.baseConfig.host,
        port: account.port ?? this.baseConfig.port,
      });
    }

    return `Microsoft auth started for ${account.username} — enter the device code when it appears`;
  }

  private stopSideJobs(id: string): void {
    const jobs = this.sideJobs.get(id);
    if (!jobs) return;
    for (const j of jobs) {
      try {
        j.stop();
      } catch {
        /* ignore */
      }
    }
    this.sideJobs.delete(id);
  }

  async startBot(id: string): Promise<string> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return `unknown account ${id}`;
    if (!account.username) return "account missing username";
    if (account.auth !== "microsoft" && !account.password) {
      return `account "${account.username}" has no password — edit the profile and set one before starting`;
    }

    let bot = this.bots.get(id);
    if (!bot) {
      bot = new FractalBot(this.configFor(account));
      this.wireBot(id, bot);
      this.bots.set(id, bot);
    } else {
      bot.applyRuntimeConfig(this.configFor(account));
    }

    account.enabled = true;
    // Activate profile only — do NOT join the server.
    // Connecting is exclusively controlled by the Online switch.
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });

    this.emit("fleet", this.getFleetStatus());
    return `profile ready: ${account.username} — turn Online on to connect`;
  }

  async stopBot(id: string): Promise<string> {
    this.stopSideJobs(id);
    const bot = this.bots.get(id);
    const account = this.accounts.find((a) => a.id === id);
    if (bot) {
      try {
        bot.stopMapping();
      } catch {
        /* ignore */
      }
      await bot.leave("fleet-stop");
      this.bots.delete(id);
    }
    if (account) {
      account.enabled = false;
      // Do not change Online task flag — user controls that on Tasks
      saveAccountsFile({
        version: 2,
        accounts: this.accounts,
        defaultAnnouncements: this.defaultAnnouncements,
      });
    }
    this.emit("fleet", this.getFleetStatus());
    return `stopped ${account?.username || id}`;
  }

  async startAllEnabled(): Promise<string[]> {
    const out: string[] = [];
    for (const a of this.accounts) {
      if (!a.features.online) continue;
      try {
        out.push(await this.startBot(a.id));
        // Online is already on for these accounts — connect them
        out.push(await this.applyFeatures(a.id));
      } catch (e) {
        out.push(`${a.username}: ${e instanceof Error ? e.message : e}`);
      }
    }
    return out;
  }

  async stopAll(): Promise<void> {
    for (const id of [...this.bots.keys()]) {
      await this.stopBot(id);
    }
  }

  getBot(id: string): FractalBot | null {
    return this.bots.get(id) ?? null;
  }

  resolveBot(id?: string | null): FractalBot | null {
    // Explicit id: only that bot (no silent fallback to another profile)
    if (id) return this.bots.get(id) ?? null;
    for (const b of this.bots.values()) return b;
    return null;
  }

  defaultBotId(): string | null {
    for (const [id] of this.bots) return id;
    return this.accounts[0]?.id ?? null;
  }

  /** Update feature flags (stackable) and re-apply. */
  async setFeatures(id: string, partial: Partial<AccountFeatures>): Promise<string> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return `unknown account ${id}`;
    account.features = normalizeFeatures({ ...account.features, ...partial });
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });
    // Online on: ensure bot instance exists (no join yet — applyFeatures connects)
    if (account.features.online && !this.bots.has(id)) {
      if (account.auth !== "microsoft" && !account.password) {
        return `account "${account.username}" has no password — set one before going Online`;
      }
      const bot = new FractalBot(this.configFor(account));
      this.wireBot(id, bot);
      this.bots.set(id, bot);
      account.enabled = true;
      saveAccountsFile({
        version: 2,
        accounts: this.accounts,
        defaultAnnouncements: this.defaultAnnouncements,
      });
    }
    // Online off must always disconnect
    const msg = await this.applyFeatures(id, { skipDisconnect: false });
    this.emit("fleet", this.getFleetStatus());
    return msg;
  }

  /** Legacy: map single task → features then apply. */
  async setTask(id: string, task: BotTask, taskOptions?: { mapMode?: string }): Promise<string> {
    const partial: Partial<AccountFeatures> = {
      online: task !== "leave",
      hunt: task === "hunt",
      map: task === "map",
      mapMode: taskOptions?.mapMode || "box",
    };
    // Preserve announcements/antiAfk when switching primary job
    return this.setFeatures(id, partial);
  }

  private async applyFeatures(
    id: string,
    opts: { skipDisconnect?: boolean } = {},
  ): Promise<string> {
    const account = this.accounts.find((a) => a.id === id);
    if (!account) return "no account";
    const f = normalizeFeatures(account.features);
    account.features = f;
    const bot = this.bots.get(id);
    const label = account.label || account.username;

    this.stopSideJobs(id);

    if (!f.online) {
      if (bot) {
        try {
          bot.stopMapping();
        } catch {
          /* ignore */
        }
        // Stop movement/portal walk without clearing the autoLobby preference
        try {
          bot.setFlags({ autoReconnect: false });
        } catch {
          /* ignore */
        }
        if (!opts.skipDisconnect) {
          await bot.leave("features-offline");
        }
      }
      return opts.skipDisconnect
        ? `${label}: ready (Online is off)`
        : `${label}: offline`;
    }

    if (!bot) {
      return `${label}: features saved [${featuresSummary(f)}] — press Start to run`;
    }

    // Online implies reconnect; autoLobby stays whatever the user set (default on)
    const autoLobby = account.profile?.autoLobby !== false;
    const autoReconnect = true;
    bot.setFlags({ autoLobby, autoReconnect });
    if (!bot.getStatus().connected) {
      await bot.join({
        autoLobby,
        autoReconnect,
        username: account.username,
        password: account.password,
        host: account.host || this.baseConfig.host,
        port: account.port ?? this.baseConfig.port,
      });
    }

    // Hunt vs map: map wins (already normalized)
    try {
      bot.stopPortalHunt();
    } catch {
      /* ignore */
    }
    if (f.hunt && !f.map) {
      bot.startPortalHunt();
    }

    if (f.map) {
      const mode = f.mapMode || this.baseConfig.mapMode || "box";
      bot.startMapping(mode);
    } else {
      try {
        bot.stopMapping();
      } catch {
        /* ignore */
      }
    }

    const handles: SideJobHandles[] = [];

    // Announcements: never conflict
    if (f.announcements) {
      const items =
        account.announcementMessages && account.announcementMessages.length
          ? account.announcementMessages
          : this.defaultAnnouncements;
      handles.push(
        startAnnouncements(
          () => this.bots.get(id)?.raw ?? null,
          items,
          label,
        ),
      );
    }

    // Anti-AFK: skip ticks while map or hunt owns movement
    if (f.antiAfk) {
      handles.push(
        startAntiAfk(() => this.bots.get(id)?.raw ?? null, label, {
          intervalMs: 60_000,
          shouldRun: () => {
            const acc = this.accounts.find((a) => a.id === id);
            if (!acc) return false;
            // Pause while heavy movement jobs run
            if (acc.features.map || acc.features.hunt) return false;
            const b = this.bots.get(id);
            const phase = b?.getStatus().phase;
            return phase === "in_game" || phase === "lobby";
          },
        }),
      );
    }

    if (handles.length) this.sideJobs.set(id, handles);

    return `${label}: ${featuresSummary(f)}`;
  }

  getFleetStatus(): {
    accountsPath: string;
    defaultAnnouncements: AnnouncementItem[];
    bots: FleetBotStatus[];
  } {
    return {
      accountsPath: accountsFilePath(),
      defaultAnnouncements: this.defaultAnnouncements,
      bots: this.accounts.map((a) => {
        const bot = this.bots.get(a.id);
        const features = normalizeFeatures(a.features);
        const status = bot ? bot.getStatus() : null;
        return {
          id: a.id,
          label: a.label,
          username: a.username,
          enabled: a.enabled,
          features,
          featuresSummary: featuresSummary(features),
          profile: a.profile || {},
          auth: a.auth,
          host: a.host,
          port: a.port,
          notes: a.notes,
          hasPassword: Boolean(a.password),
          running: Boolean(bot && (status?.connected || status?.phase !== "idle")),
          bot: status,
          announcementMessages: a.announcementMessages,
        };
      }),
    };
  }

  applyBaseConfig(next: FractalConfig): void {
    this.baseConfig = next;
    for (const [id, bot] of this.bots) {
      const acc = this.accounts.find((a) => a.id === id);
      if (acc) bot.applyRuntimeConfig(this.configFor(acc));
    }
  }

  getBaseConfig(): FractalConfig {
    return this.baseConfig;
  }
}
