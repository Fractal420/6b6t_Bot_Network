/**
 * Optional full protocol dump of packets the Minecraft server sends the bot
 * (and optionally what the bot sends back). Used to reverse-engineer features
 * like tab-complete and /homes GUIs on custom servers (e.g. 6b6t).
 *
 * Output: NDJSON lines in logs/packetlistener/<nickname>.ndjson by default.
 * Toggle via SERVER_LISTENER=1 in settings (no restart required once attached).
 */
import fs from "node:fs";
import path from "node:path";
import type { Bot } from "mineflayer";
import { log } from "../logger.ts";

export interface ServerListenerOptions {
  enabled: boolean;
  /** Also log client → server packets. */
  outbound: boolean;
  /** Absolute or relative path to the NDJSON log file. */
  filePath: string;
  /** Max serialized size per packet field before truncation (chars). */
  maxFieldChars?: number;
  /** Max total JSON size per line (chars). */
  maxLineChars?: number;
}

type Detach = () => void;

const DEFAULT_MAX_FIELD = 4_000;
const DEFAULT_MAX_LINE = 32_000;

/** Packet names that are almost pure noise at volume (still logged, but payload trimmed hard). */
const BULKY = new Set([
  "map_chunk",
  "map_chunk_bulk",
  "level_chunk",
  "level_chunk_with_light",
  "chunk_data",
  "chunk_batch_start",
  "chunk_batch_finished",
  "light_update",
  "update_light",
  "map",
  "declare_commands",
  "commands",
  "tags",
  "registry_data",
  "login",
  "login_plugin_request",
  "custom_payload",
  "plugin",
  "entity_metadata",
  "entity_update_attributes",
  "set_equipment",
  "acknowledge_player_digging",
]);

/** Names that matter for homes / tab-complete / windows — never drop the name even if bulky. */
const INTERESTING = new Set([
  "tab_complete",
  "declare_commands",
  "commands",
  "open_window",
  "open_screen",
  "close_window",
  "close_container",
  "window_items",
  "set_slot",
  "container_set_content",
  "container_set_slot",
  "container_close",
  "open_horse_window",
  "trade_list",
  "chat",
  "player_chat",
  "system_chat",
  "profileless_chat",
  "disconnect",
  "kick_disconnect",
  "game_state_change",
  "respawn",
  "success",
  "set_title_text",
  "set_title_subtitle",
  "action_bar",
  "playerlist_header",
  "scoreboard_objective",
  "scoreboard_score",
  "teams",
  "boss_bar",
  "custom_payload",
  "plugin",
  "show_dialog",
  "clear_dialog",
  "custom_click_action",
]);


function safeJson(
  value: unknown,
  maxField: number,
  depth = 0,
  maxDepth = 8,
  maxArray = 80,
): unknown {
  if (value == null) return value;
  if (typeof value === "bigint") return value.toString() + "n";
  if (typeof value === "string") {
    if (value.length > maxField) return value.slice(0, maxField) + `…[+${value.length - maxField} chars]`;
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") return value;
  if (Buffer.isBuffer(value)) {
    const hex = value.subarray(0, Math.min(value.length, 64)).toString("hex");
    return `<Buffer len=${value.length} ${hex}${value.length > 64 ? "…" : ""}>`;
  }
  if (ArrayBuffer.isView(value)) {
    const u8 = new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    const hex = Buffer.from(u8.subarray(0, Math.min(u8.length, 64))).toString("hex");
    return `<TypedArray ${value.constructor?.name || "view"} len=${u8.length} ${hex}${u8.length > 64 ? "…" : ""}>`;
  }
  if (depth > maxDepth) return "[MaxDepth]";
  if (Array.isArray(value)) {
    if (value.length > maxArray) {
      return value
        .slice(0, maxArray)
        .map((v) => safeJson(v, maxField, depth + 1, maxDepth, maxArray))
        .concat([`…[+${value.length - maxArray} items]`]);
    }
    return value.map((v) => safeJson(v, maxField, depth + 1, maxDepth, maxArray));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v.length > maxField * 2 && /data|payload|chunk|nbt|buffer/i.test(k)) {
        out[k] = `<omitted ${v.length} chars>`;
        continue;
      }
      out[k] = safeJson(v, maxField, depth + 1, maxDepth, maxArray);
    }
    return out;
  }
  try {
    return String(value);
  } catch {
    return "[Unserializable]";
  }
}

let writeQueue: Promise<void> = Promise.resolve();

function appendLine(filePath: string, obj: Record<string, unknown>, maxLine: number): void {
  let line: string;
  try {
    line = JSON.stringify(obj);
  } catch {
    line = JSON.stringify({ t: obj.t, dir: obj.dir, name: obj.name, error: "stringify_failed" });
  }
  if (line.length > maxLine) {
    line =
      JSON.stringify({
        t: obj.t,
        dir: obj.dir,
        name: obj.name,
        state: obj.state,
        truncated: true,
        size: line.length,
        preview: line.slice(0, Math.min(2000, maxLine - 80)),
      }) + "\n";
  } else {
    line += "\n";
  }
  writeQueue = writeQueue
    .then(() => fs.promises.appendFile(filePath, line, "utf8"))
    .catch((err) => {
      log.warn("serverListener write failed", err instanceof Error ? err.message : err);
    });
}

type ListenerEntry = {
  detach: Detach;
  filePath: string;
  lines: number;
  username: string;
};

/** One listener per profile/username so only that account's packets are logged. */
const listeners = new Map<string, ListenerEntry>();

function listenerKey(bot: Bot, explicit?: string): string {
  const u = (explicit || bot.username || "unknown").trim().toLowerCase() || "unknown";
  return u;
}

/**
 * Attach (or re-attach) the packet logger for one bot/profile.
 * Does not affect other profiles' listeners.
 */
export function attachServerListener(bot: Bot, options: ServerListenerOptions & { key?: string }): void {
  const key = listenerKey(bot, options.key);
  detachServerListener(key);

  if (!options.enabled) {
    log.info(`Server packet listener OFF for ${key}`);
    return;
  }

  const filePath = path.resolve(options.filePath);
  const maxField = options.maxFieldChars ?? DEFAULT_MAX_FIELD;
  const maxLine = options.maxLineChars ?? DEFAULT_MAX_LINE;
  const outbound = options.outbound;

  try {
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.appendFileSync(
      filePath,
      JSON.stringify({
        t: new Date().toISOString(),
        dir: "meta",
        name: "listener_start",
        username: bot.username,
        key,
        version: bot.version,
        outbound,
      }) + "\n",
      "utf8",
    );
  } catch (err) {
    log.warn("serverListener cannot open file", filePath, err instanceof Error ? err.message : err);
    return;
  }

  let lineCount = 0;
  const client = bot._client as {
    state?: string;
    on: (ev: string, fn: (...args: unknown[]) => void) => void;
    off?: (ev: string, fn: (...args: unknown[]) => void) => void;
    removeListener?: (ev: string, fn: (...args: unknown[]) => void) => void;
    write?: (name: string, params: unknown) => void;
  };

  const trackAppend = (obj: Record<string, unknown>) => {
    appendLine(filePath, obj, maxLine);
    lineCount += 1;
    const entry = listeners.get(key);
    if (entry) entry.lines = lineCount;
  };

  const onPacket = (data: unknown, meta: { name?: string; state?: string } | undefined) => {
    const name = meta?.name || "unknown";
    const state = meta?.state || client.state || "";
    const bulky = BULKY.has(name) && !INTERESTING.has(name);
    const interesting = INTERESTING.has(name);
    const payload = bulky
      ? { _note: "bulky_packet_trimmed", keys: data && typeof data === "object" ? Object.keys(data as object) : [] }
      : safeJson(
          data,
          interesting ? maxField * 4 : maxField,
          0,
          interesting ? 24 : 8,
          interesting ? 500 : 80,
        );

    trackAppend({
      t: new Date().toISOString(),
      dir: "S→C",
      name,
      state,
      username: bot.username,
      data: payload,
    });
  };

  client.on("packet", onPacket as (...args: unknown[]) => void);

  const extraHandlers: Array<{ name: string; fn: (...args: unknown[]) => void }> = [];
  for (const name of INTERESTING) {
    const fn = (data: unknown) => {
      trackAppend({
        t: new Date().toISOString(),
        dir: "S→C",
        name,
        state: client.state || "",
        username: bot.username,
        data: safeJson(data, maxField * 2, 0, 24, 500),
        via: "named",
      });
    };
    try {
      client.on(name, fn as (...args: unknown[]) => void);
      extraHandlers.push({ name, fn: fn as (...args: unknown[]) => void });
    } catch {
      /* packet name not in this protocol */
    }
  }

  let originalWrite: ((name: string, params: unknown) => void) | undefined;
  if (outbound && typeof client.write === "function") {
    originalWrite = client.write.bind(client);
    client.write = (name: string, params: unknown) => {
      try {
        trackAppend({
          t: new Date().toISOString(),
          dir: "C→S",
          name,
          state: client.state || "",
          username: bot.username,
          data: safeJson(params, maxField),
        });
      } catch {
        /* never break gameplay */
      }
      return originalWrite!(name, params);
    };
  }

  const remove = (ev: string, fn: (...args: unknown[]) => void) => {
    try {
      if (client.off) client.off(ev, fn);
      else if (client.removeListener) client.removeListener(ev, fn);
    } catch {
      /* ignore */
    }
  };

  const detach: Detach = () => {
    remove("packet", onPacket as (...args: unknown[]) => void);
    for (const { name, fn } of extraHandlers) remove(name, fn);
    if (originalWrite) {
      client.write = originalWrite;
    }
    trackAppend({ t: new Date().toISOString(), dir: "meta", name: "listener_stop", lines: lineCount, username: bot.username });
    listeners.delete(key);
    log.info(`Server packet listener stopped for ${key} (${lineCount} lines → ${filePath})`);
  };

  listeners.set(key, { detach, filePath, lines: 0, username: bot.username || key });
  log.info(`Server packet listener ON for ${key} → ${filePath} (outbound=${outbound ? "yes" : "no"})`);
}

/** Detach one profile (key) or every listener if key omitted. */
export function detachServerListener(key?: string): void {
  if (key) {
    const entry = listeners.get(key.toLowerCase());
    if (entry) {
      try {
        entry.detach();
      } catch {
        listeners.delete(key.toLowerCase());
      }
    }
    return;
  }
  for (const k of [...listeners.keys()]) {
    detachServerListener(k);
  }
}

export function serverListenerStatus(key?: string): { active: boolean; filePath: string; lines: number; key?: string } {
  if (key) {
    const entry = listeners.get(key.toLowerCase());
    return {
      active: Boolean(entry),
      filePath: entry?.filePath || "",
      lines: entry?.lines || 0,
      key: key.toLowerCase(),
    };
  }
  const first = listeners.values().next().value as ListenerEntry | undefined;
  return {
    active: listeners.size > 0,
    filePath: first?.filePath || "",
    lines: first?.lines || 0,
  };
}

/**
 * logs/packetlistener/<nickname>.ndjson
 * `settingsFolder` is Settings/ — parent is the project root.
 * Name uses the account nickname/username, never the profile UUID.
 */
export function defaultServerListenerPath(settingsFolder: string, username?: string): string {
  const base = String(username || "server")
    .trim()
    // Strip UUID-looking tokens if someone passes a profile id by mistake
    .replace(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
      "server",
    )
    .replace(/[^\w.\-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 64) || "server";
  const root = path.resolve(settingsFolder, "..");
  return path.join(root, "logs", "packetlistener", `${base}.ndjson`);
}

/**
 * Truncate the packet log for a profile (or all active listeners if key omitted).
 * Safe while the listener is still running — further packets keep appending.
 */
export async function clearServerListenerLog(
  key?: string,
  settingsFolder?: string,
): Promise<{ cleared: string[]; linesBefore: number }> {
  // Let pending appends finish so we don't race a partial write
  try {
    await writeQueue;
  } catch {
    /* ignore */
  }

  const cleared: string[] = [];
  let linesBefore = 0;

  const clearFile = (filePath: string, entry?: ListenerEntry) => {
    if (!filePath) return;
    const resolved = path.resolve(filePath);
    try {
      if (entry) linesBefore += entry.lines || 0;
      else if (fs.existsSync(resolved)) {
        const size = fs.statSync(resolved).size;
        // rough pre-clear size note only
        void size;
      }
      fs.mkdirSync(path.dirname(resolved), { recursive: true });
      fs.writeFileSync(
        resolved,
        JSON.stringify({
          t: new Date().toISOString(),
          dir: "meta",
          name: "listener_cleared",
          key: key || entry?.username || undefined,
        }) + "\n",
        "utf8",
      );
      if (entry) entry.lines = 1;
      cleared.push(resolved);
      log.info(`Server packet listener log cleared → ${resolved}`);
    } catch (err) {
      log.warn("serverListener clear failed", resolved, err instanceof Error ? err.message : err);
    }
  };

  if (key) {
    const k = key.toLowerCase();
    const entry = listeners.get(k);
    if (entry?.filePath) {
      clearFile(entry.filePath, entry);
    } else if (settingsFolder) {
      clearFile(defaultServerListenerPath(settingsFolder, key));
    }
  } else {
    for (const entry of listeners.values()) {
      clearFile(entry.filePath, entry);
    }
    // If nothing active, still try default generic path
    if (cleared.length === 0 && settingsFolder) {
      clearFile(defaultServerListenerPath(settingsFolder));
    }
  }

  return { cleared, linesBefore };
}
