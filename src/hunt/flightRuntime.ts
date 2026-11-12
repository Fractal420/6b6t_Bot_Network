/**
 * The single hunt-side flight controller.
 *
 * This mirrors the flight technique already proven on 6b6t by `mapper-lib/mapper.js`, because the naive
 * approaches do not work on a real server:
 *
 *   1. leave the ground (walk off / jump) so a deploy is legal,
 *   2. `bot.elytraFly()` sends the real `start_elytra_flying` packet; we also set the local gliding flag, the
 *      way a vanilla client does, because the server does not always echo our own metadata back,
 *   3. keep a firework boost alive by setting `bot.fireworkRocketDuration` — prismarine-physics applies the
 *      real vanilla boost maths and only while genuinely gliding, so no rocket item is consumed and no
 *      impossible movement is produced,
 *   4. steer by look direction, climbing shallow and holding altitude in a band.
 *
 * It never fabricates physics state. If the bot cannot get airborne it reports that instead of pretending.
 * Only one flight controller may be active at a time; `FractalBot.startHunt` stops the terrain mapper first.
 */

import type { Bot } from "mineflayer";
import { classifyFlightState, decideFlight, DeploymentGovernor, isViable, type FlightAction, type FlightState } from "./flight.ts";
import { equipBestElytra, readElytraStatus } from "./elytraRuntime.ts";

export interface FlightConfig {
  /** Minimum remaining durability for a journey. */
  minDurability: number;
  /** Swap the worn elytra once it drops to this. */
  replaceThreshold: number;
  /** Delay before the first launch attempt of a leg. */
  deployDelayMs: number;
  maxDeployAttempts: number;
  maxDeployDelayMs: number;
  /** Cruise altitude to hold, when the waypoint does not specify one. */
  cruiseY: number;
  /** Half-height of the altitude dead-band around the cruise altitude, in blocks. */
  cruiseBand: number;
  /** Blocks of horizontal separation from the launch point before climbing to cruise. */
  departDist: number;
}

export const DEFAULT_FLIGHT_CONFIG: FlightConfig = {
  minDurability: 16,
  replaceThreshold: 24,
  deployDelayMs: 1500,
  maxDeployAttempts: 6,
  maxDeployDelayMs: 20_000,
  cruiseY: 180,
  cruiseBand: 24,
  departDist: 140,
};

// Pitch targets. Positive pitch is up. Climb shallow: an elytra trades airspeed for altitude, so a steep
// nose-up under boost stalls it outright (verified live on 6b6t).
const PITCH_UP = 0.12;
const PITCH_LEVEL = 0.05;
const PITCH_DOWN = -0.15;
const STALL_SPEED = 0.25;
const PITCH_STALL_RECOVER = -0.35;
// Firework boost pulse lengths (ticks). A full flight-1 rocket is ~25 ticks; a short pulse governs cruise
// speed so we settle near the target instead of pinning to elytra top speed.
const BOOST_TICKS = 25;
const BOOST_REFRESH_AT = 3;
const GOVERN_BOOST_TICKS = 8;
const TARGET_CRUISE_BPT = 1.0;
const DEPLOY_RETRY_MS = 800;

export interface FlightWaypoint {
  x: number;
  y: number;
  z: number;
}

/** Snapshot of the driver for the status HUD. */
export interface FlightDriverStatus {
  state: FlightState;
  wantsFlight: boolean;
  action: FlightAction;
  elytraRemaining: number;
  elytraSpares: number;
  deployAttempts: number;
  exhausted: boolean;
  lastNote: string;
}

/** The subset of mineflayer's Bot this driver drives, so the optional members are typed explicitly. */
type FlyableBot = Bot & {
  elytraFly?: () => Promise<void>;
  fireworkRocketDuration?: number;
};

/**
 * Drives a single bot's elytra flight toward a waypoint. `update` is called every tick with the current target
 * (or `null` to stop flying). All failures are reported through the returned status, never thrown.
 */
export class FlightDriver {
  private readonly governor: DeploymentGovernor;
  private config: FlightConfig;
  private target: FlightWaypoint | null = null;
  private lastAction: FlightAction = "none";
  private lastNote = "";
  private lastDeployAt = 0;
  private launchX = 0;
  private launchZ = 0;

  constructor(
    private readonly getBot: () => Bot | null,
    config: Partial<FlightConfig> = {},
    private readonly now: () => number = () => Date.now(),
  ) {
    this.config = { ...DEFAULT_FLIGHT_CONFIG, ...config };
    this.governor = new DeploymentGovernor(
      this.config.maxDeployAttempts,
      this.config.deployDelayMs,
      this.config.maxDeployDelayMs,
    );
  }

  setConfig(partial: Partial<FlightConfig>): void {
    this.config = { ...this.config, ...partial };
  }

  /** Points the driver at a waypoint, or `null` to stop wanting flight. */
  setTarget(target: FlightWaypoint | null): void {
    this.target = target;
    this.governor.setWantsFlight(target !== null);
  }

  /** Start a fresh leg, replenishing the deploy retry budget. */
  beginLeg(): void {
    this.governor.beginLeg();
  }

  get wantsFlight(): boolean {
    return this.governor.wantsFlight;
  }

  get state(): FlightState {
    return this.governor.lastState;
  }

  /** True when the bot just landed mid-route and wants to continue. */
  get justLanded(): boolean {
    return this.governor.justLanded;
  }

  /** True the first time the deploy budget is spent, so the caller can report failure once. */
  get deployFailed(): boolean {
    return this.governor.shouldReportDeployFailure();
  }

  status(): FlightDriverStatus {
    const bot = this.getBot();
    const elytra = bot ? readElytraStatus(bot) : null;
    return {
      state: this.governor.lastState,
      wantsFlight: this.governor.wantsFlight,
      action: this.lastAction,
      elytraRemaining: elytra?.remaining ?? -1,
      elytraSpares: elytra?.spares ?? 0,
      deployAttempts: this.governor.attempts,
      exhausted: this.governor.exhausted,
      lastNote: this.lastNote,
    };
  }

  /** Advances one tick. Safe to call with no bot. */
  async update(): Promise<FlightAction> {
    const bot = this.getBot() as FlyableBot | null;
    if (!bot?.entity) {
      this.lastAction = "none";
      return "none";
    }

    const nowMs = this.now();
    const state = this.readState(bot);
    this.governor.noteState(state);

    const elytra = readElytraStatus(bot);
    const wornNeedsReplace = elytra.equipped && elytra.remaining <= this.config.replaceThreshold;
    const spareViable = elytra.bestSpareRemaining >= this.config.minDurability;

    const action = decideFlight({
      state,
      hasElytra: elytra.equipped,
      wornUsable: elytra.equipped && isViable(elytra.remaining, this.config.minDurability),
      wornNeedsReplace,
      spareViable,
      flightOn: state === "gliding",
      wantsFlight: this.governor.wantsFlight,
      canAttempt: this.governor.canAttempt(nowMs),
    });

    this.lastAction = action;
    switch (action) {
      case "replace":
        await this.replaceElytra(bot);
        break;
      case "launch":
        this.governor.recordAttempt(nowMs);
        this.launch(bot);
        break;
      case "cruise":
        this.cruise(bot, state);
        break;
      case "wait":
        if (state === "gliding") this.cruise(bot, state);
        break;
      case "abort":
        this.lastNote = "no usable elytra and no spare";
        this.stopControls(bot);
        break;
      case "none":
        break;
    }

    // Deploy retry while airborne and not yet gliding — separate from the launch backoff, because a momentary
    // ground flicker as we clear an edge would otherwise make elytraFly() throw and never be retried.
    const airborne = state === "airborne" || state === "falling";
    if (
      this.governor.wantsFlight &&
      airborne &&
      !bot.entity.elytraFlying &&
      elytra.equipped &&
      isViable(elytra.remaining, this.config.minDurability) &&
      nowMs - this.lastDeployAt > DEPLOY_RETRY_MS
    ) {
      this.lastDeployAt = nowMs;
      void this.deployElytra(bot);
    }

    return action;
  }

  private readState(bot: Bot): FlightState {
    const gliding = Boolean(bot.entity?.elytraFlying);
    let swimming = false;
    try {
      swimming = Boolean((bot.entity as { isInWater?: boolean })?.isInWater);
    } catch {
      swimming = false;
    }
    const climbing = false; // ladder/vine detection is not reliable enough to steer on; treated as airborne.
    const onGround = Boolean(bot.entity?.onGround);
    const vy = bot.entity?.velocity?.y ?? 0;
    return classifyFlightState(gliding, swimming, climbing, onGround, vy);
  }

  private async replaceElytra(bot: Bot): Promise<void> {
    const remaining = await equipBestElytra(bot, this.config.minDurability);
    this.lastNote = remaining >= 0 ? `equipped elytra (${remaining} durability)` : "no viable spare elytra";
    if (remaining >= 0) this.governor.beginLeg();
  }

  /** Gets airborne: walk forward off a ledge and jump, facing the target. */
  private launch(bot: Bot): void {
    const target = this.target;
    this.lastNote = "launching";
    const pos = bot.entity?.position;
    if (pos) {
      this.launchX = pos.x;
      this.launchZ = pos.z;
    }
    try {
      bot.clearControlStates();
      if (target && pos) {
        const yaw = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));
        void bot.look(yaw, 0, false);
      }
      bot.setControlState("forward", true);
      bot.setControlState("sprint", true);
      bot.setControlState("jump", true);
    } catch {
      /* ignore */
    }
  }

  /** Sends the elytra deploy packet and mirrors the client-side gliding flag. Never throws. */
  private async deployElytra(bot: FlyableBot): Promise<void> {
    try {
      await bot.elytraFly?.();
    } catch {
      /* the server may reject a deploy while grounded; the caller retries */
    }
    try {
      if (bot.entity) bot.entity.elytraFlying = true;
    } catch {
      /* ignore */
    }
  }

  /** Steers toward the waypoint, holds altitude and keeps the boost alive. */
  private cruise(bot: FlyableBot, state: FlightState): void {
    const target = this.target;
    const pos = bot.entity?.position;
    if (!target || !pos) return;

    const cruiseY = target.y || this.config.cruiseY;
    const yaw = Math.atan2(-(target.x - pos.x), -(target.z - pos.z));

    const horizontalDist = Math.hypot(pos.x - this.launchX, pos.z - this.launchZ);
    const departing = horizontalDist < this.config.departDist;
    const band = this.config.cruiseBand;
    const speed = Math.hypot(bot.entity?.velocity?.x ?? 0, bot.entity?.velocity?.z ?? 0);

    let pitch: number;
    if (state === "gliding" && speed < STALL_SPEED) {
      // Rebuild airspeed before worrying about altitude, exactly as a pilot would.
      pitch = PITCH_STALL_RECOVER;
    } else if (departing) {
      // Do not climb back onto the launch platform: fly level until clear of it.
      pitch = PITCH_LEVEL;
    } else if (pos.y < cruiseY - band) {
      pitch = PITCH_UP;
    } else if (pos.y > cruiseY + band) {
      pitch = PITCH_DOWN;
    } else {
      pitch = PITCH_LEVEL;
    }

    try {
      void bot.look(yaw, pitch, false);
      bot.setControlState("forward", true);
    } catch {
      /* ignore */
    }

    if (state === "gliding") this.topUpBoost(bot, cruiseY, band);
  }

  /**
   * Keeps a client-style firework boost running. prismarine-physics honours `fireworkRocketDuration` only
   * while genuinely gliding and applies the real vanilla boost maths, so no rocket item is consumed and the
   * trajectory stays physically legitimate.
   */
  private topUpBoost(bot: FlyableBot, cruiseY: number, band: number): void {
    try {
      const pos = bot.entity?.position;
      if (!pos) return;
      const v = bot.entity?.velocity ?? { x: 0, y: 0, z: 0 };
      const speed = Math.hypot(v.x, v.z);
      const climbing = pos.y < cruiseY - band;
      // In-band governor: coast once already at cruise speed so we settle near the cap.
      if (!climbing && speed >= TARGET_CRUISE_BPT) return;
      if ((bot.fireworkRocketDuration ?? 0) <= BOOST_REFRESH_AT) {
        bot.fireworkRocketDuration = climbing || speed < STALL_SPEED ? BOOST_TICKS : GOVERN_BOOST_TICKS;
      }
    } catch {
      /* a failed boost is not fatal */
    }
  }

  private stopControls(bot: Bot): void {
    try {
      bot.clearControlStates();
    } catch {
      /* ignore */
    }
  }

  /** Releases all control state and clears the target. */
  stop(): void {
    const bot = this.getBot();
    if (bot) this.stopControls(bot);
    this.target = null;
    this.governor.setWantsFlight(false);
  }
}
