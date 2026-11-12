/**
 * Notification routing: per-event filtering, cooldowns and formatting.
 *
 * The delivery side (Discord, the web dashboard, the CLI) is injected as a sink, so the filtering/cooldown
 * rules are pure and testable. Cooldowns are per event kind, so a burst of stash discoveries cannot flood a
 * channel while a rare emergency is still delivered immediately.
 */

export type NotificationKind =
  | "stash-discovery"
  | "major-storage"
  | "interesting-structure"
  | "player-sighting"
  | "exploration-milestone"
  | "elytra-replaced"
  | "mending-status"
  | "equipment-problem"
  | "route-complete"
  | "route-interrupted"
  | "echest-operation"
  | "emergency"
  | "system-error";

export const NOTIFICATION_KINDS: NotificationKind[] = [
  "stash-discovery",
  "major-storage",
  "interesting-structure",
  "player-sighting",
  "exploration-milestone",
  "elytra-replaced",
  "mending-status",
  "equipment-problem",
  "route-complete",
  "route-interrupted",
  "echest-operation",
  "emergency",
  "system-error",
];

export interface NotificationConfig {
  /** Per-kind enable flag; missing means enabled. */
  enabled?: Partial<Record<NotificationKind, boolean>>;
  /** Per-kind minimum interval between deliveries, ms. */
  cooldownMs?: Partial<Record<NotificationKind, number>>;
}

/** Events that are urgent enough to bypass the default cooldown. */
const URGENT: NotificationKind[] = ["emergency", "system-error", "equipment-problem", "route-interrupted"];

const DEFAULT_COOLDOWN_MS = 15_000;
const URGENT_COOLDOWN_MS = 3_000;

export interface Notification {
  kind: NotificationKind;
  title: string;
  body: string;
  /** Structured fields rendered as embed fields / HUD rows. */
  fields?: Record<string, string | number>;
  atMs: number;
}

export type NotificationSink = (n: Notification) => void | Promise<void>;

export interface NotificationOptions {
  sink: NotificationSink;
  config?: NotificationConfig;
  now?: () => number;
}

/**
 * Filters and rate-limits notifications, then forwards the survivors to the sink.
 *
 * A suppressed notification is dropped, not queued: the next allowed one carries the current state, so a
 * flapping condition does not produce a backlog of stale alerts.
 */
export class NotificationCenter {
  private readonly sink: NotificationSink;
  private readonly config: NotificationConfig;
  private readonly now: () => number;
  private readonly lastSent = new Map<NotificationKind, number>();

  constructor(opts: NotificationOptions) {
    this.sink = opts.sink;
    this.config = opts.config ?? {};
    this.now = opts.now ?? (() => Date.now());
  }

  isEnabled(kind: NotificationKind): boolean {
    return this.config.enabled?.[kind] !== false;
  }

  cooldownFor(kind: NotificationKind): number {
    const configured = this.config.cooldownMs?.[kind];
    if (configured !== undefined) return configured;
    return URGENT.includes(kind) ? URGENT_COOLDOWN_MS : DEFAULT_COOLDOWN_MS;
  }

  /** True when a notification of this kind may be delivered now. */
  allows(kind: NotificationKind, nowMs = this.now()): boolean {
    if (!this.isEnabled(kind)) return false;
    const last = this.lastSent.get(kind);
    if (last === undefined) return true;
    return nowMs - last >= this.cooldownFor(kind);
  }

  /** Delivers a notification when allowed. Returns whether it was sent. */
  notify(kind: NotificationKind, title: string, body: string, fields?: Record<string, string | number>): boolean {
    const nowMs = this.now();
    if (!this.allows(kind, nowMs)) return false;
    this.lastSent.set(kind, nowMs);
    const notification: Notification = { kind, title, body, fields, atMs: nowMs };
    try {
      const result = this.sink(notification);
      if (result && typeof (result as Promise<void>).catch === "function") {
        (result as Promise<void>).catch(() => {
          /* a failed delivery must not break the caller */
        });
      }
    } catch {
      /* a throwing sink must not break the caller */
    }
    return true;
  }

  /** The last time each kind was delivered, for diagnostics. */
  lastSentAt(kind: NotificationKind): number | undefined {
    return this.lastSent.get(kind);
  }

  reset(): void {
    this.lastSent.clear();
  }
}
