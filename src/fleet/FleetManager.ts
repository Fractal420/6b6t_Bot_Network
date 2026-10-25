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
    const acc = this.accounts.find((a) => a.username === input.username)!;
    this.emit("accounts", this.listAccounts());
    return { ...acc, password: acc.password ? "***" : "" };
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
    return {
      ...this.baseConfig,
      username: account.username,
      password: account.password,
      auth: account.auth,
      host: account.host || this.baseConfig.host,
      port: account.port ?? this.baseConfig.port,
    };
  }

  private wireBot(id: string, bot: FractalBot): void {
    const forward = (event: string) => {
      bot.on(event as keyof import("../api/types.ts").FractalBotEvents, (...args: unknown[]) => {
        this.emit("botEvent", { id, event, args });
        this.emit("fleet", this.getFleetStatus());
      });
    };
    for (const e of ["phase", "kicked", "connected", "disconnected", "status", "authenticated", "chat"] as const) {
      forward(e);
    }
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
    if (account.auth === "offline" && !account.password) return "account missing password";

    let bot = this.bots.get(id);
    if (!bot) {
      bot = new FractalBot(this.configFor(account));
      this.wireBot(id, bot);
      this.bots.set(id, bot);
    }

    account.enabled = true;
    if (!account.features.online) {
      account.features = normalizeFeatures({ ...account.features, online: true });
    }
    saveAccountsFile({
      version: 2,
      accounts: this.accounts,
      defaultAnnouncements: this.defaultAnnouncements,
    });

    await bot.join({
      autoLobby: true,
      autoReconnect: true,
      username: account.username,
      password: account.password,
      host: account.host || this.baseConfig.host,
      port: account.port ?? this.baseConfig.port,
    });

    await this.applyFeatures(id);
    this.emit("fleet", this.getFleetStatus());
    return `started ${account.username} [${featuresSummary(account.features)}]`;
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
      saveAccountsFile({
        version: 2,
        accounts: this.accounts,
        defaultAnnouncements: this.defaultAnnouncements,
      });
    }
    this.emit("fleet", this.getFleetStatus());
    return `stopped ${id}`;
  }

  async startAllEnabled(): Promise<string[]> {
    const out: string[] = [];
    for (const a of this.accounts) {
      if (!a.enabled && !a.features.online) continue;
      // Start accounts that want to be online
      if (!a.features.online && !a.enabled) continue;
      try {
        if (!a.features.online) continue;
        out.push(await this.startBot(a.id));
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
    if (id && this.bots.has(id)) return this.bots.get(id)!;
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
    const msg = await this.applyFeatures(id);
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

  private async applyFeatures(id: string): Promise<string> {
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
        try {
                  } catch {
          /* ignore */
        }
        await bot.leave("features-offline");
      }
      return `${label}: offline`;
    }

    if (!bot) {
      return `${label}: features saved [${featuresSummary(f)}] — start bot to run`;
    }

    bot.setFlags({ autoLobby: true, autoReconnect: true });
    if (!bot.getStatus().connected) {
      await bot.join();
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
        return {
          id: a.id,
          label: a.label,
          username: a.username,
          enabled: a.enabled,
          features,
          featuresSummary: featuresSummary(features),
          running: Boolean(bot?.getStatus().connected || bot),
          bot: bot ? bot.getStatus() : null,
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
