/**
 * Stackable side jobs: announcements + anti-AFK (from THC Announcements bot ideas).
 * Safe to run alongside mapping; anti-AFK pauses while hunt/map movement owns controls.
 */
import type { Bot } from "mineflayer";
import type { AnnouncementItem } from "./accounts.ts";
import { log } from "../logger.ts";

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export interface SideJobHandles {
  stop: () => void;
}

/** Timed chat messages while the bot has an entity. */
export function startAnnouncements(
  getBot: () => Bot | null,
  items: AnnouncementItem[],
  label: string,
): SideJobHandles {
  const timers: ReturnType<typeof setInterval>[] = [];
  for (const item of items) {
    if (!item.message || !(item.intervalMs > 0)) continue;
    const t = setInterval(() => {
      const bot = getBot();
      if (!bot?.entity) return;
      try {
        bot.chat(item.message);
        log.info(`[${label}] announcement: ${item.message.slice(0, 80)}`);
      } catch (e) {
        log.warn(`[${label}] announcement failed`, e instanceof Error ? e.message : e);
      }
    }, item.intervalMs);
    timers.push(t);
  }
  if (timers.length) log.info(`[${label}] announcements on (${timers.length} timer(s))`);
  return {
    stop: () => {
      for (const t of timers) clearInterval(t);
    },
  };
}

export interface AntiAfkOptions {
  intervalMs?: number;
  jump?: boolean;
  lookAround?: boolean;
  move?: boolean;
  /** Return false to skip this tick (e.g. while mapping/hunting). */
  shouldRun?: () => boolean;
}

/** Light anti-AFK: optional step, jump, look — skipped when shouldRun() is false. */
export function startAntiAfk(
  getBot: () => Bot | null,
  label: string,
  opts: AntiAfkOptions = {},
): SideJobHandles {
  const intervalMs = opts.intervalMs ?? 60_000;
  const jump = opts.jump !== false;
  const lookAround = opts.lookAround !== false;
  const move = opts.move !== false;

  const timer = setInterval(() => {
    void (async () => {
      if (opts.shouldRun && !opts.shouldRun()) return;
      const bot = getBot();
      if (!bot?.entity) return;
      try {
        if (move) {
          bot.setControlState("forward", true);
          await sleep(800 + Math.floor(Math.random() * 400));
          bot.setControlState("forward", false);
        }
        if (jump) {
          bot.setControlState("jump", true);
          await sleep(250);
          bot.setControlState("jump", false);
        }
        if (lookAround) {
          const yaw = bot.entity.yaw + (Math.random() > 0.5 ? 1 : -1) * (Math.PI / 2);
          await bot.look(yaw, bot.entity.pitch, true);
        }
      } catch {
        /* ignore */
      }
    })();
  }, intervalMs);

  log.info(`[${label}] anti-AFK on (every ${Math.round(intervalMs / 1000)}s)`);
  return {
    stop: () => clearInterval(timer),
  };
}
