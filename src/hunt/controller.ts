/**
 * The base-hunting orchestrator.
 *
 * Owns the hunt state machine for one bot: it picks a route, drives the {@link FlightDriver}, scans the chunks
 * it flies over for storage, records what it finds, watches survival, manages Mending and Ender Chest
 * operations, and reports through the {@link NotificationCenter}. Every player-control action goes through the
 * shared {@link Scheduler} so no two concerns fight over movement, the inventory or equipment.
 *
 * The heavy work — chunk scanning — is budgeted per tick and run on an interval, never synchronously on every
 * client tick. Nothing here throws out to the caller: a failed operation is reported and the loop continues.
 */

import type { Bot } from "mineflayer";
import { log } from "../logger.ts";
import {
  classifyStash,
  containerCount,
  describeTier,
  isNoteworthy,
  meetsThreshold,
  scoreStash,
  type StashTier,
} from "./scoring.ts";
import { RegionScanner, sweepStorage, type BlockReader } from "./scanner.ts";
import {
  chunkKeyX,
  chunkKeyZ,
  directionRoute,
  ExploredDatabase,
  ExplorationPlanner,
  gridRoute,
  spiralRoute,
  type ChunkPos,
  type ExplorationMode,
} from "./exploration.ts";
import { HuntDatabase } from "./database.ts";
import { NotificationCenter, type NotificationKind } from "./notifications.ts";
import { Priority, Scheduler, type ControlResource } from "./scheduler.ts";
import { DEFAULT_THRESHOLDS, evaluateSurvival, type SurvivalThresholds } from "./survival.ts";
import { readSurvivalSnapshot, hasXpSource } from "./survivalRuntime.ts";
import { holdForMending, selectMendingTarget, type MendingWeights } from "./mendingRuntime.ts";
import { FlightDriver, type FlightConfig, type FlightWaypoint } from "./flightRuntime.ts";
import {
  countContainerByCategory,
  closeEnderChest,
  executeDeposit,
  executeWithdraw,
  findEnderChest,
  openEnderChest,
  planDeposit,
  planWithdraw,
  readOpenContainer,
  type EnderChestLocation,
} from "./enderChestRuntime.ts";
import type { ItemCategory } from "./inventory.ts";

const OWNER = "hunt";

export interface HuntConfig {
  mode: ExplorationMode;
  /** Route spacing, in chunks. */
  spacing: number;
  /** Route half-size, in chunks. */
  halfCount: number;
  /** Bearing for `direction` mode. */
  bearing: number;
  /** Cruise altitude. */
  cruiseY: number;
  /** Blocks inspected per scan tick. */
  scanBudget: number;
  /** Minimum ms between scan ticks. */
  scanIntervalMs: number;
  /** Radius (chunks) of the region scanned around each waypoint. */
  scanRadiusChunks: number;
  /** Use the palette-based storage sweep (fast) instead of the per-block budgeted scan. */
  paletteScan: boolean;
  /** Minimum score for a scan result to be recorded. */
  minScore: number;
  /** Minimum container count for a scan result to be recorded. */
  minContainers: number;
  /** Distance (chunks) within which a waypoint counts as reached. */
  reachChunks: number;
  /** Mending item weights by item name. */
  mendingWeights: MendingWeights;
  /** Categories to deposit into an ender chest. */
  depositCategories: ItemCategory[];
  /** Categories to withdraw from an ender chest. */
  withdrawCategories: ItemCategory[];
  /** Auto-organise an ender chest when one is opened during a restock. */
  autoEchest: boolean;
  survival: SurvivalThresholds;
  flight: Partial<FlightConfig>;
  /** Custom chunk waypoints for `waypoints` mode. Replaces the generated route when non-empty. */
  waypoints: ChunkPos[];
}

export const DEFAULT_HUNT_CONFIG: HuntConfig = {
  mode: "spiral",
  spacing: 8,
  halfCount: 24,
  bearing: 0,
  cruiseY: 180,
  scanBudget: 2_000,
  scanIntervalMs: 500,
  scanRadiusChunks: 2,
  paletteScan: true,
  minScore: 24,
  minContainers: 3,
  reachChunks: 2,
  mendingWeights: { elytra: 10, "*": 1 },
  depositCategories: ["building-blocks", "utility", "valuable"],
  withdrawCategories: ["elytra", "food", "fireworks", "totems", "xp-supplies"],
  autoEchest: true,
  survival: DEFAULT_THRESHOLDS,
  flight: {},
  waypoints: [],
};

export type HuntPhase = "idle" | "scanning" | "flying" | "restocking" | "paused" | "stopping";

export interface HuntStatus {
  active: boolean;
  paused: boolean;
  phase: HuntPhase;
  mode: ExplorationMode;
  target: FlightWaypoint | null;
  waypointIndex: number;
  waypointsTotal: number;
  exploredChunks: number;
  stashes: number;
  players: number;
  flight: ReturnType<FlightDriver["status"]>;
  survival: ReturnType<typeof evaluateSurvival> | null;
  notes: string[];
}

export interface HuntControllerOptions {
  getBot: () => Bot | null;
  database: HuntDatabase;
  notifications: NotificationCenter;
  scheduler?: Scheduler;
  config?: Partial<HuntConfig>;
  server?: string;
  now?: () => number;
}

/** Live controller. Create one per bot; `start`/`stop` are idempotent. */
export class HuntController {
  private readonly getBot: () => Bot | null;
  private readonly db: HuntDatabase;
  private readonly notify: NotificationCenter;
  private readonly scheduler: Scheduler;
  private readonly now: () => number;
  private config: HuntConfig;

  private readonly explored: ExploredDatabase;
  private planner: ExplorationPlanner;
  private readonly flight: FlightDriver;
  private scanner: RegionScanner | null = null;
  private scannerKey = "";
  private lastScanAt = 0;
  private lastSurvivalAt = 0;
  private lastSurvival: ReturnType<typeof evaluateSurvival> | null = null;

  private active = false;
  private paused = false;
  private phase: HuntPhase = "idle";
  private notes: string[] = [];
  private currentWaypoint: ChunkPos | null = null;
  private scanCentre: ChunkPos | null = null;

  constructor(opts: HuntControllerOptions) {
    this.getBot = opts.getBot;
    this.db = opts.database;
    this.notify = opts.notifications;
    this.scheduler = opts.scheduler ?? new Scheduler();
    this.now = opts.now ?? (() => Date.now());
    this.config = { ...DEFAULT_HUNT_CONFIG, ...opts.config };

    const exploration = this.db.getExploration();
    this.explored = new ExploredDatabase({ initial: exploration.exploredKeys });
    this.planner = new ExplorationPlanner({
      route: this.buildRoute(),
      db: this.explored,
      reachChunks: this.config.reachChunks,
    });
    this.flight = new FlightDriver(this.getBot, this.config.flight, this.now);
  }

  get running(): boolean {
    return this.active;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setConfig(partial: Partial<HuntConfig>): void {
    this.config = { ...this.config, ...partial };
    this.flight.setConfig(this.config.flight);
  }

  getConfig(): HuntConfig {
    return { ...this.config };
  }

  /**
   * Replace the custom waypoint route and switch to `waypoints` mode. Waypoints are in chunk coordinates.
   * When hunting is already active the route is rebuilt immediately so the change takes effect without a restart.
   */
  setWaypoints(waypoints: ChunkPos[]): number {
    this.config = { ...this.config, mode: "waypoints", waypoints: waypoints.map((w) => ({ x: Math.round(w.x), z: Math.round(w.z) })) };
    if (this.active) {
      const centre = this.botChunk() ?? undefined;
      this.planner.reset(this.buildRoute(centre));
    }
    return this.config.waypoints.length;
  }

  /** The configured custom waypoint route (empty unless `waypoints` mode has been given points). */
  getWaypoints(): ChunkPos[] {
    return this.config.waypoints.map((w) => ({ ...w }));
  }

  /** Starts hunting. Builds a fresh route from the bot's current chunk. */
  start(): void {
    if (this.active) return;
    const bot = this.getBot();
    const chunk = this.botChunk();
    if (bot && chunk) {
      this.planner.reset(this.buildRoute(chunk));
    }
    this.active = true;
    this.paused = false;
    this.phase = "scanning";
    this.flight.beginLeg();
    this.notes = ["hunt started"];
    log.info(`[hunt] started (${this.config.mode} route)`);
  }

  pause(): void {
    if (!this.active) return;
    this.paused = true;
    this.phase = "paused";
    this.flight.setTarget(null);
    this.scheduler.releaseAll(OWNER);
    // Persist immediately: a pause usually means a disconnect, and the debounced save may never fire while
    // offline. This is what lets an interrupted route resume with its exploration progress intact.
    this.persistExploration();
    this.notes = ["hunt paused"];
  }

  resume(): void {
    if (!this.active) return;
    this.paused = false;
    this.phase = "scanning";
    this.flight.beginLeg();
    this.notes = ["hunt resumed"];
  }

  /** Stops hunting, persisting exploration progress and releasing all control. */
  stop(): void {
    if (!this.active) return;
    this.phase = "stopping";
    this.active = false;
    this.flight.stop();
    this.scheduler.releaseAll(OWNER);
    this.persistExploration();
    this.scanner = null;
    this.phase = "idle";
    this.notes = ["hunt stopped"];
    log.info("[hunt] stopped");
  }

  status(): HuntStatus {
    return {
      active: this.active,
      paused: this.paused,
      phase: this.phase,
      mode: this.config.mode,
      target: this.currentWaypoint ? this.waypointToWorld(this.currentWaypoint) : null,
      waypointIndex: this.planner.position,
      waypointsTotal: this.planner.total,
      exploredChunks: this.explored.exploredCount,
      stashes: this.db.getStashes().length,
      players: this.db.getPlayers().length,
      flight: this.flight.status(),
      survival: this.lastSurvival,
      notes: this.notes,
    };
  }

  /** Advances one tick. Never throws. */
  tick(): void {
    if (!this.active || this.paused) return;
    try {
      this.scheduler.releaseAll(OWNER);
      const bot = this.getBot();
      if (!bot?.entity) {
        this.notes = ["waiting for connection"];
        return;
      }

      if (this.checkSurvival(bot)) return;

      this.maybeScan(bot);
      this.advanceRoute(bot);
      this.maybeMend(bot);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      log.warn(`[hunt] tick error: ${message}`);
      this.notify.notify("system-error", "Hunt tick error", message);
    }
  }

  /** Evaluates survival and reacts. Returns true when a higher-priority concern took over this tick. */
  private checkSurvival(bot: Bot): boolean {
    const nowMs = this.now();
    if (nowMs - this.lastSurvivalAt < 1_000) return false;
    this.lastSurvivalAt = nowMs;

    const snap = readSurvivalSnapshot(bot);
    if (!snap) return false;
    const report = evaluateSurvival(snap, this.config.survival);
    this.lastSurvival = report;

    if (report.concerns.length) {
      this.notes = report.notes;
    }

    if (report.shouldDisconnect) {
      // Highest priority: stop flying and let the caller's auto-log logic act. We only signal via the note and
      // an emergency notification; we never disconnect on our own, to avoid fighting the AutoLog owner.
      this.scheduler.acquire(OWNER, Priority.CriticalSurvival, ["movement"]);
      this.flight.setTarget(null);
      this.phase = "restocking";
      this.notify.notify("emergency", "Critical condition", report.notes.join("; "));
      return true;
    }

    if (report.shouldReturn) {
      this.notes = [...report.notes, "returning to base is advised"];
    }
    return false;
  }

  /** Runs the chunk scanner on an interval with a per-tick budget. */
  private maybeScan(bot: Bot): void {
    const nowMs = this.now();
    if (nowMs - this.lastScanAt < this.config.scanIntervalMs) return;
    this.lastScanAt = nowMs;

    const chunk = this.botChunk();
    if (!chunk) return;

    if (this.config.paletteScan && this.scanner === null) {
      // Fast path: a palette-based sweep skips sections with no storage at all, so it covers a whole region
      // in one cheap pass instead of reading every block.
      const swept = sweepStorage(bot, { verticalRadius: 32, radiusChunks: this.config.scanRadiusChunks });
      if (swept) {
        this.finishScan(bot, { x: swept.centreChunk.x, z: swept.centreChunk.z }, swept.evidence);
        return;
      }
    }

    if (!this.scanner || this.scannerKey !== `${chunk.x},${chunk.z}`) {
      this.scanner = new RegionScanner(this.makeReader(bot), chunk.x, chunk.z, this.config.scanRadiusChunks);
      this.scannerKey = `${chunk.x},${chunk.z}`;
      this.scanCentre = chunk;
    }

    this.scanner.step(this.config.scanBudget);
    if (!this.scanner.done) return;

    const evidence = this.scanner.result();
    // Hand off to a fresh scanner around the new position next interval.
    this.scanner = null;
    this.scannerKey = "";
    this.finishScan(bot, this.scanCentre ?? chunk, evidence);
  }

  /** Scores a completed scan, marks the chunk explored and records anything worth keeping. */
  private finishScan(bot: Bot, chunk: ChunkPos, evidence: ReturnType<RegionScanner["result"]>): void {
    const containers = containerCount(evidence);
    const score = scoreStash(evidence);
    this.explored.markExplored(chunk.x, chunk.z);

    if (meetsThreshold(score, containers, this.config.minScore, this.config.minContainers)) {
      this.recordDiscovery(bot, chunk, score, containers, evidence);
    }
  }

  private recordDiscovery(
    bot: Bot,
    chunk: ChunkPos,
    score: number,
    containers: number,
    evidence: ReturnType<RegionScanner["result"]>,
  ): void {
    const botPos = bot.entity?.position ?? { x: chunk.x * 16, y: 64, z: chunk.z * 16 };
    const tier = classifyStash(score, containers);
    const dimension = bot.game?.dimension || "overworld";
    const nowMs = this.now();
    const { record, isNew } = this.db.recordStash({
      x: Math.round(botPos.x),
      y: Math.round(botPos.y),
      z: Math.round(botPos.z),
      chunkX: chunk.x,
      chunkZ: chunk.z,
      dimension,
      score,
      tier,
      containers,
      evidence: { ...evidence },
      discoveredAtMs: nowMs,
      lastSeenMs: nowMs,
      method: "scan",
      playerSightings: [],
    });

    this.notes = [`${describeTier(tier)} at ${record.x},${record.z} (score ${score})`];
    if (isNew) {
      const kind: NotificationKind = tier === "major" ? "major-storage" : "stash-discovery";
      this.notify.notify(
        kind,
        `${describeTier(tier)} discovered`,
        `${containers} containers, score ${score} at ${record.x},${record.y},${record.z} in the ${dimension}`,
        { score, containers, dimension, x: record.x, y: record.y, z: record.z },
      );
    }
    this.explored.markRequiresReview(chunk.x, chunk.z);
  }

  /** Moves the bot to the next waypoint, driving the flight controller. */
  private advanceRoute(bot: Bot): void {
    const chunk = this.botChunk();
    if (!chunk) return;

    if (this.currentWaypoint && this.planner.isReached(this.currentWaypoint, chunk.x, chunk.z)) {
      this.planner.reached(this.currentWaypoint);
      this.currentWaypoint = null;
    }

    if (!this.currentWaypoint) {
      this.currentWaypoint = this.planner.next();
      if (!this.currentWaypoint) {
        // Route exhausted: expand outward from the current position.
        this.planner.reset(this.buildRoute(chunk));
        this.currentWaypoint = this.planner.next();
        this.notify.notify("exploration-milestone", "Route complete", `expanded exploration around ${chunk.x},${chunk.z}`);
      }
      if (this.currentWaypoint) this.flight.beginLeg();
    }

    if (this.currentWaypoint) {
      this.phase = "flying";
      this.scheduler.acquire(OWNER, Priority.Exploration, ["movement"]);
      this.flight.setTarget(this.waypointToWorld(this.currentWaypoint));
    }

    void this.flight.update();
    if (this.flight.deployFailed) {
      this.notify.notify("equipment-problem", "Elytra deploy failed", "could not get airborne; check elytra and fireworks");
    }
  }

  /** Runs a Mending pass when there is a real XP source and something to repair. */
  private maybeMend(bot: Bot): void {
    if (!hasXpSource(bot)) return;
    const target = selectMendingTarget(bot, this.config.mendingWeights);
    if (!target) return;
    this.scheduler.acquire(OWNER, Priority.EquipmentRecovery, ["equipment"]);
    void holdForMending(bot, target).then((ok) => {
      if (ok) this.notes = [`holding ${target.candidate.name} to mend`];
    });
  }

  /**
   * Restocks from a nearby ender chest: walks to it, opens it, withdraws the configured categories and
   * deposits the configured categories. Returns a human-readable result.
   */
  async restock(): Promise<string> {
    const bot = this.getBot();
    if (!bot?.entity) return "not connected";
    const lease = this.scheduler.acquire(OWNER, Priority.Inventory, ["movement", "inventory"]);
    if (!lease.ok) return `busy: ${lease.heldBy} holds ${lease.heldBy ? "the controls" : "resources"}`;

    const location = findEnderChest(bot, 64);
    if (!location) {
      this.scheduler.release(OWNER);
      return "no ender chest within 64 blocks";
    }
    this.phase = "restocking";
    const opened = await this.openAndOrganise(bot, location);
    this.scheduler.release(OWNER);
    this.phase = "flying";
    return opened;
  }

  private async openAndOrganise(bot: Bot, location: EnderChestLocation): Promise<string> {
    const block = await openEnderChest(bot, location);
    if (!block) return "could not open the ender chest";
    try {
      const contents = readOpenContainer(bot);
      if (!contents) return "ender chest opened but no window";
      this.notify.notify("echest-operation", "Ender chest opened", `at ${location.x},${location.y},${location.z}`);
      if (!this.config.autoEchest) return "ender chest opened";

      const summary = countContainerByCategory(contents);
      const deposit = planDeposit(bot, this.config.depositCategories);
      const withdraw = planWithdraw(contents, this.config.withdrawCategories, 1);
      const movedOut = await executeDeposit(bot, contents, deposit);
      const movedIn = await executeWithdraw(bot, contents, withdraw);
      return `ender chest: ${summary.length} categories, deposited ${movedOut}, withdrew ${movedIn}`;
    } finally {
      closeEnderChest(bot);
    }
  }

  /** The nearest recorded stash, for navigation. */
  nearestStash(maxDistance = 10_000): { x: number; y: number; z: number; tier: StashTier } | null {
    const bot = this.getBot();
    const pos = bot?.entity?.position;
    if (!pos) return null;
    const stashes = this.db.getStashes();
    let best: { x: number; y: number; z: number; tier: StashTier; d: number } | null = null;
    for (const s of stashes) {
      const d = Math.hypot(s.x - pos.x, s.z - pos.z);
      if (d > maxDistance) continue;
      if (!best || d < best.d) best = { x: s.x, y: s.y, z: s.z, tier: s.tier as StashTier, d };
    }
    return best ? { x: best.x, y: best.y, z: best.z, tier: best.tier } : null;
  }

  private makeReader(bot: Bot): BlockReader {
    return {
      blockName: (x, y, z) => {
        try {
          const block = bot.blockAt({ x, y, z } as never);
          return block?.name ?? null;
        } catch {
          return null;
        }
      },
    };
  }

  private buildRoute(centre?: ChunkPos): ChunkPos[] {
    const c = centre ?? this.botChunk() ?? { x: 0, z: 0 };
    switch (this.config.mode) {
      case "grid":
        return gridRoute(c, this.config.spacing, this.config.halfCount);
      case "spiral":
        return spiralRoute(c, this.config.spacing, this.config.halfCount);
      case "direction":
        return directionRoute(c, this.config.bearing, this.config.spacing, this.config.halfCount * 2);
      case "waypoints":
        // A custom route replaces the generated one entirely; the bot's current chunk is still scanned.
        return this.config.waypoints.length ? [...this.config.waypoints] : spiralRoute(c, this.config.spacing, this.config.halfCount);
      case "adaptive":
      default:
        // Adaptive begins as a spiral; it expands on completion via advanceRoute.
        return spiralRoute(c, this.config.spacing, this.config.halfCount);
    }
  }

  private botChunk(): ChunkPos | null {
    const pos = this.getBot()?.entity?.position;
    if (!pos) return null;
    return { x: Math.floor(pos.x / 16), z: Math.floor(pos.z / 16) };
  }

  private waypointToWorld(wp: ChunkPos): FlightWaypoint {
    return { x: wp.x * 16 + 8, y: this.config.cruiseY, z: wp.z * 16 + 8 };
  }

  private persistExploration(): void {
    this.db.setExploration({ exploredKeys: this.explored.exploredKeys(), reviewKeys: [] });
    this.db.flush();
  }
}

/** Re-export so the CLI can list the chunk a key refers to. */
export { chunkKeyX, chunkKeyZ };
