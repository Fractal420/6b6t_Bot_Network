/**
 * Server-specific, dimension-aware persistence for stash, player and exploration data.
 *
 * Requirements this file exists to satisfy: writes must be crash-safe (never leave a half-written file that
 * bricks the next load), a single corrupted record must never stop the addon loading, records must be
 * de-duplicated by identity, and the whole store must be exportable/importable. Every file carries a version
 * so future schema changes can migrate rather than discard data.
 */

import fs from "node:fs";
import path from "node:path";

export const DATABASE_VERSION = 1;

export interface StashRecord {
  id: string;
  /** Block coordinates of the location the stash was centred on. */
  x: number;
  y: number;
  z: number;
  chunkX: number;
  chunkZ: number;
  dimension: string;
  server: string;
  score: number;
  tier: string;
  containers: number;
  evidence: Record<string, number>;
  discoveredAtMs: number;
  lastSeenMs: number;
  /** How it was found: "scan", "manual", "player". */
  method: string;
  /** Usernames of players associated with the location. */
  playerSightings: string[];
  notes?: string;
}

export interface PlayerRecord {
  username: string;
  firstSeenMs: number;
  lastSeenMs: number;
  sightings: number;
  dimension: string;
  server: string;
  lastX: number;
  lastY: number;
  lastZ: number;
}

export interface ExplorationState {
  exploredKeys: string[];
  reviewKeys: string[];
}

export interface DatabaseDocument {
  version: number;
  server: string;
  updatedAt: number;
  stashes: StashRecord[];
  players: PlayerRecord[];
  exploration: ExplorationState;
}

export interface HuntDatabaseOptions {
  /** Root directory for all hunt data. */
  dir: string;
  /** Server address the data is keyed to. */
  server: string;
  /** Players not seen for longer than this are pruned (days). 0 disables. */
  maxPlayerAgeDays?: number;
  /** Stashes not seen for longer than this are pruned (days). 0 disables. */
  maxStashAgeDays?: number;
  /** Injected clock, for tests. */
  now?: () => number;
}

const DAY_MS = 86_400_000;

function freshDocument(server: string, nowMs: number): DatabaseDocument {
  return {
    version: DATABASE_VERSION,
    server,
    updatedAt: nowMs,
    stashes: [],
    players: [],
    exploration: { exploredKeys: [], reviewKeys: [] },
  };
}

/** Sanitises a server address into a filesystem-safe directory name. */
export function safeServerName(server: string): string {
  const cleaned = (server || "unknown").toLowerCase().replace(/[^a-z0-9._-]+/g, "_");
  return cleaned.slice(0, 80) || "unknown";
}

/** De-duplication key for a stash: rounded position plus dimension. */
export function stashIdentity(x: number, y: number, z: number, dimension: string): string {
  return `${dimension}:${Math.round(x)}:${Math.round(y)}:${Math.round(z)}`;
}

/** Validates and normalises a stash record read from disk, returning null when unusable. */
export function parseStash(raw: unknown): StashRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  // A position is the one thing a stash cannot be without; anything else has a sane default. Rejecting here
  // keeps a malformed line from materialising as a phantom stash at the world origin.
  if (typeof r.x !== "number" || !Number.isFinite(r.x) || typeof r.z !== "number" || !Number.isFinite(r.z)) {
    return null;
  }
  const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  const x = num(r.x);
  const y = num(r.y);
  const z = num(r.z);
  const dimension = str(r.dimension, "overworld");
  const id = str(r.id) || stashIdentity(x, y, z, dimension);
  const evidence =
    r.evidence && typeof r.evidence === "object" ? (r.evidence as Record<string, number>) : {};
  const sightings = Array.isArray(r.playerSightings)
    ? r.playerSightings.filter((s): s is string => typeof s === "string")
    : [];
  return {
    id,
    x,
    y,
    z,
    chunkX: num(r.chunkX, Math.floor(x / 16)),
    chunkZ: num(r.chunkZ, Math.floor(z / 16)),
    dimension,
    server: str(r.server),
    score: num(r.score),
    tier: str(r.tier, "unconfirmed"),
    containers: num(r.containers),
    evidence,
    discoveredAtMs: num(r.discoveredAtMs),
    lastSeenMs: num(r.lastSeenMs),
    method: str(r.method, "scan"),
    playerSightings: sightings,
    notes: typeof r.notes === "string" ? r.notes : undefined,
  };
}

/** Validates and normalises a player record read from disk, returning null when unusable. */
export function parsePlayer(raw: unknown): PlayerRecord | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const username = typeof r.username === "string" ? r.username.trim() : "";
  if (!username) return null;
  const num = (v: unknown, fallback = 0): number => (typeof v === "number" && Number.isFinite(v) ? v : fallback);
  const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
  return {
    username,
    firstSeenMs: num(r.firstSeenMs),
    lastSeenMs: num(r.lastSeenMs),
    sightings: num(r.sightings, 1),
    dimension: str(r.dimension, "overworld"),
    server: str(r.server),
    lastX: num(r.lastX),
    lastY: num(r.lastY),
    lastZ: num(r.lastZ),
  };
}

/** Reads and migrates a document, recovering from corruption by quarantining the bad file. */
export function readDocument(file: string, server: string, nowMs: number): DatabaseDocument {
  if (!fs.existsSync(file)) return freshDocument(server, nowMs);
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    // Corrupted JSON must never stop the addon loading. Quarantine and start clean.
    try {
      fs.renameSync(file, `${file}.corrupt-${nowMs}`);
    } catch {
      /* ignore */
    }
    return freshDocument(server, nowMs);
  }

  const doc = parsed as Partial<DatabaseDocument>;
  const stashes = Array.isArray(doc.stashes)
    ? doc.stashes.map(parseStash).filter((s): s is StashRecord => s !== null)
    : [];
  const players = Array.isArray(doc.players)
    ? doc.players.map(parsePlayer).filter((p): p is PlayerRecord => p !== null)
    : [];
  const explorationRaw = doc.exploration as Partial<ExplorationState> | undefined;
  const exploration: ExplorationState = {
    exploredKeys: Array.isArray(explorationRaw?.exploredKeys)
      ? explorationRaw!.exploredKeys.filter((k): k is string => typeof k === "string")
      : [],
    reviewKeys: Array.isArray(explorationRaw?.reviewKeys)
      ? explorationRaw!.reviewKeys.filter((k): k is string => typeof k === "string")
      : [],
  };

  return {
    version: typeof doc.version === "number" ? doc.version : DATABASE_VERSION,
    server: typeof doc.server === "string" ? doc.server : server,
    updatedAt: typeof doc.updatedAt === "number" ? doc.updatedAt : nowMs,
    stashes,
    players,
    exploration,
  };
}

/** Writes a document atomically: a temp file then a rename, so a crash cannot leave a partial file. */
export function writeDocumentAtomic(file: string, doc: DatabaseDocument): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
  fs.renameSync(tmp, file);
}

export interface StashSearch {
  tier?: string;
  dimension?: string;
  minScore?: number;
  text?: string;
  limit?: number;
}

/**
 * A server-keyed store of stashes, players and exploration state, with atomic saves and a coalescing
 * scheduler so a burst of discoveries results in one write, not hundreds.
 */
export class HuntDatabase {
  private readonly dir: string;
  private readonly server: string;
  private readonly file: string;
  private readonly now: () => number;
  private readonly maxPlayerAgeDays: number;
  private readonly maxStashAgeDays: number;
  private doc: DatabaseDocument;
  private dirty = false;
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private readonly saveDebounceMs: number;

  constructor(opts: HuntDatabaseOptions & { saveDebounceMs?: number } = { dir: ".", server: "unknown" }) {
    this.dir = opts.dir;
    this.server = opts.server;
    this.now = opts.now ?? (() => Date.now());
    this.maxPlayerAgeDays = opts.maxPlayerAgeDays ?? 0;
    this.maxStashAgeDays = opts.maxStashAgeDays ?? 0;
    this.saveDebounceMs = opts.saveDebounceMs ?? 2_000;
    this.file = path.join(opts.dir, "hunt", safeServerName(opts.server), "database.json");
    this.doc = readDocument(this.file, this.server, this.now());
  }

  get filePath(): string {
    return this.file;
  }

  get version(): number {
    return this.doc.version;
  }

  /** Records a stash, de-duplicating by identity and keeping the strongest evidence seen. */
  recordStash(input: Omit<StashRecord, "id" | "server"> & { id?: string }): { record: StashRecord; isNew: boolean } {
    const id = input.id || stashIdentity(input.x, input.y, input.z, input.dimension);
    const existing = this.doc.stashes.find((s) => s.id === id);
    if (existing) {
      existing.lastSeenMs = Math.max(existing.lastSeenMs, input.lastSeenMs);
      if (input.score >= existing.score) {
        existing.score = input.score;
        existing.tier = input.tier;
        existing.containers = input.containers;
        existing.evidence = input.evidence;
      }
      const merged = new Set([...existing.playerSightings, ...input.playerSightings]);
      existing.playerSightings = [...merged];
      this.touch();
      return { record: existing, isNew: false };
    }
    const record: StashRecord = { ...input, id, server: this.server };
    this.doc.stashes.push(record);
    this.touch();
    return { record, isNew: true };
  }

  /** Records a player sighting, de-duplicating by username and accumulating counts. */
  recordPlayerSighting(input: {
    username: string;
    x: number;
    y: number;
    z: number;
    dimension: string;
    atMs?: number;
  }): PlayerRecord {
    const username = input.username.trim();
    const atMs = input.atMs ?? this.now();
    const existing = this.doc.players.find((p) => p.username.toLowerCase() === username.toLowerCase());
    if (existing) {
      existing.lastSeenMs = Math.max(existing.lastSeenMs, atMs);
      existing.sightings += 1;
      existing.lastX = input.x;
      existing.lastY = input.y;
      existing.lastZ = input.z;
      existing.dimension = input.dimension;
      this.touch();
      return existing;
    }
    const record: PlayerRecord = {
      username,
      firstSeenMs: atMs,
      lastSeenMs: atMs,
      sightings: 1,
      dimension: input.dimension,
      server: this.server,
      lastX: input.x,
      lastY: input.y,
      lastZ: input.z,
    };
    this.doc.players.push(record);
    this.touch();
    return record;
  }

  setExploration(state: ExplorationState): void {
    this.doc.exploration = state;
    this.touch();
  }

  getExploration(): ExplorationState {
    return this.doc.exploration;
  }

  getStashes(): StashRecord[] {
    return this.doc.stashes;
  }

  getPlayers(): PlayerRecord[] {
    return this.doc.players;
  }

  /** Case-insensitive substring search over stashes. */
  searchStashes(query: StashSearch = {}): StashRecord[] {
    const text = (query.text || "").toLowerCase();
    let rows = this.doc.stashes;
    if (query.tier) rows = rows.filter((s) => s.tier === query.tier);
    if (query.dimension) rows = rows.filter((s) => s.dimension === query.dimension);
    if (query.minScore !== undefined) rows = rows.filter((s) => s.score >= query.minScore!);
    if (text) {
      rows = rows.filter(
        (s) =>
          s.tier.includes(text) ||
          s.dimension.includes(text) ||
          (s.notes || "").toLowerCase().includes(text) ||
          s.playerSightings.some((p) => p.toLowerCase().includes(text)),
      );
    }
    rows = [...rows].sort((a, b) => b.score - a.score);
    return query.limit ? rows.slice(0, query.limit) : rows;
  }

  /** Case-insensitive substring search over players, most recently seen first. */
  searchPlayers(text = "", limit?: number): PlayerRecord[] {
    const q = text.toLowerCase();
    let rows = q
      ? this.doc.players.filter((p) => p.username.toLowerCase().includes(q))
      : [...this.doc.players];
    rows = rows.sort((a, b) => b.lastSeenMs - a.lastSeenMs);
    return limit ? rows.slice(0, limit) : rows;
  }

  /** Removes players and stashes older than the configured windows. Returns how many were pruned. */
  prune(): { players: number; stashes: number } {
    const nowMs = this.now();
    let players = 0;
    let stashes = 0;
    if (this.maxPlayerAgeDays > 0) {
      const cutoff = nowMs - this.maxPlayerAgeDays * DAY_MS;
      const before = this.doc.players.length;
      this.doc.players = this.doc.players.filter((p) => p.lastSeenMs >= cutoff);
      players = before - this.doc.players.length;
    }
    if (this.maxStashAgeDays > 0) {
      const cutoff = nowMs - this.maxStashAgeDays * DAY_MS;
      const before = this.doc.stashes.length;
      this.doc.stashes = this.doc.stashes.filter((s) => s.lastSeenMs >= cutoff);
      stashes = before - this.doc.stashes.length;
    }
    if (players || stashes) this.touch();
    return { players, stashes };
  }

  stats(): { server: string; stashes: number; players: number; explored: number; version: number } {
    return {
      server: this.server,
      stashes: this.doc.stashes.length,
      players: this.doc.players.length,
      explored: this.doc.exploration.exploredKeys.length,
      version: this.doc.version,
    };
  }

  exportJson(): string {
    return JSON.stringify(this.doc, null, 2);
  }

  /** Imports a previously exported document. Merges by identity; a corrupt import throws. */
  importJson(json: string, mode: "merge" | "replace" = "merge"): { stashes: number; players: number } {
    const parsed = JSON.parse(json) as Partial<DatabaseDocument>;
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.stashes)) {
      throw new Error("import file is not a hunt database document");
    }
    if (mode === "replace") {
      this.doc = readDocumentFromObject(parsed, this.server, this.now());
    } else {
      for (const raw of parsed.stashes) {
        const s = parseStash(raw);
        if (s) this.recordStash(s);
      }
      for (const raw of parsed.players ?? []) {
        const p = parsePlayer(raw);
        if (p) {
          const existing = this.doc.players.find((x) => x.username.toLowerCase() === p.username.toLowerCase());
          if (existing) {
            existing.firstSeenMs = Math.min(existing.firstSeenMs, p.firstSeenMs);
            existing.lastSeenMs = Math.max(existing.lastSeenMs, p.lastSeenMs);
            existing.sightings = Math.max(existing.sightings, p.sightings);
          } else {
            this.doc.players.push(p);
          }
        }
      }
    }
    this.touch();
    this.save();
    return { stashes: this.doc.stashes.length, players: this.doc.players.length };
  }

  /** Marks the document dirty and schedules a coalesced save. */
  private touch(): void {
    this.dirty = true;
    this.doc.updatedAt = this.now();
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.save();
    }, this.saveDebounceMs);
    this.saveTimer.unref?.();
  }

  /** Writes immediately when there are pending changes. */
  save(): void {
    if (!this.dirty) return;
    this.dirty = false;
    try {
      writeDocumentAtomic(this.file, this.doc);
    } catch {
      // A failed save must not crash the bot; the next touch will retry.
      this.dirty = true;
    }
  }

  /** Forces a synchronous save and cancels any pending debounce (used on shutdown). */
  flush(): void {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.dirty = true;
    this.save();
  }

  close(): void {
    this.flush();
  }
}

function readDocumentFromObject(
  parsed: Partial<DatabaseDocument>,
  server: string,
  nowMs: number,
): DatabaseDocument {
  const stashes = Array.isArray(parsed.stashes)
    ? parsed.stashes.map(parseStash).filter((s): s is StashRecord => s !== null)
    : [];
  const players = Array.isArray(parsed.players)
    ? parsed.players.map(parsePlayer).filter((p): p is PlayerRecord => p !== null)
    : [];
  const exploration = parsed.exploration ?? { exploredKeys: [], reviewKeys: [] };
  return {
    version: typeof parsed.version === "number" ? parsed.version : DATABASE_VERSION,
    server,
    updatedAt: nowMs,
    stashes,
    players,
    exploration,
  };
}
