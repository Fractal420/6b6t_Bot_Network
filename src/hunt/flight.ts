/**
 * Elytra durability arithmetic and the flight deployment state machine — pure logic.
 *
 * These numbers decide whether a flight starts, continues or is abandoned, which is exactly the logic that
 * must not silently drift, so they are separated from the runtime that reads the live bot.
 */

/** Below this many remaining points an elytra is treated as unusable for a new journey. */
export const DEFAULT_MIN_DURABILITY = 16;

/** Roughly one durability point is consumed per this many blocks flown; journey estimates are conservative. */
const BLOCKS_PER_DURABILITY = 100;

/** Remaining durability from max damage and accumulated damage. */
export function remainingDurability(maxDamage: number, damage: number): number {
  if (maxDamage <= 0) return 0;
  return Math.max(0, maxDamage - damage);
}

/** Remaining durability as a percentage in `[0, 100]`. Returns 0 for a non-damageable stack. */
export function durabilityPercent(remaining: number, maxDamage: number): number {
  if (maxDamage <= 0) return 0;
  return Math.max(0, Math.min(100, (remaining * 100) / maxDamage));
}

/** True when the worn elytra has dropped to the point where a spare should be swapped in. */
export function shouldReplace(remaining: number, threshold: number): boolean {
  return threshold > 0 && remaining <= threshold;
}

/** True when an elytra is good enough to start or continue a journey. */
export function isViable(remaining: number, minimum: number): boolean {
  return remaining >= 0 && remaining >= Math.max(0, minimum);
}

/** Index of the healthiest candidate at or above `minimum`, or -1 when none qualifies. */
export function bestSlot(remainingBySlot: number[], minimum: number): number {
  let best = -1;
  let bestRemaining = -1;
  for (let slot = 0; slot < remainingBySlot.length; slot++) {
    const remaining = remainingBySlot[slot];
    if (remaining < 0 || remaining < minimum) continue;
    if (remaining > bestRemaining) {
      bestRemaining = remaining;
      best = slot;
    }
  }
  return best;
}

/** True when the worn elytra plus the spares hold enough total durability to finish a journey. */
export function canCompleteJourney(
  wornRemaining: number,
  spareRemaining: number[],
  journeyBlocks: number,
  minimum: number,
): boolean {
  let total = Math.max(0, wornRemaining);
  for (const remaining of spareRemaining) if (remaining > 0) total += remaining;
  const required = Math.floor(journeyBlocks / BLOCKS_PER_DURABILITY) + Math.max(0, minimum);
  return total >= required;
}

/** The physical state of the bot, as it matters to flight automation. */
export type FlightState =
  | "unknown"
  | "grounded"
  | "gliding"
  | "falling"
  | "swimming"
  | "climbing"
  | "airborne";

/**
 * Classifies the bot from cheap boolean observations, in priority order.
 *
 * Gliding wins over everything; climbing and swimming win over grounded/airborne because they change whether
 * a launch is even possible; a downward vertical velocity distinguishes falling from a simple jump.
 */
export function classifyFlightState(
  gliding: boolean,
  swimming: boolean,
  climbing: boolean,
  onGround: boolean,
  verticalVelocity: number,
): FlightState {
  if (gliding) return "gliding";
  if (swimming) return "swimming";
  if (climbing) return "climbing";
  if (onGround) return "grounded";
  return verticalVelocity < -0.05 ? "falling" : "airborne";
}

export function canDeploy(state: FlightState): boolean {
  return state === "grounded" || state === "airborne" || state === "falling";
}

export function isSupported(state: FlightState): boolean {
  return state === "grounded" || state === "swimming" || state === "climbing";
}

export type FlightAction = "none" | "launch" | "cruise" | "replace" | "wait" | "abort";

export interface FlightDecisionInput {
  state: FlightState;
  hasElytra: boolean;
  wornUsable: boolean;
  wornNeedsReplace: boolean;
  spareViable: boolean;
  flightOn: boolean;
  wantsFlight: boolean;
  /** Whether the backoff gate currently allows a launch attempt. */
  canAttempt: boolean;
}

/**
 * The pure decision for deploying and keeping an elytra flight alive.
 *
 * It separates the cases a naive "am I gliding?" check conflates: a grounded bot can be launched, a falling
 * bot can deploy, a worn-out elytra should be swapped rather than relaunched, and with no elytra at all the
 * route must abort.
 */
export function decideFlight(input: FlightDecisionInput): FlightAction {
  const {
    state,
    hasElytra,
    wornUsable,
    wornNeedsReplace,
    spareViable,
    flightOn,
    wantsFlight,
    canAttempt,
  } = input;

  if (!wantsFlight) return flightOn ? "wait" : "none";

  if (state === "gliding") {
    if (wornNeedsReplace && spareViable) return "replace";
    return "cruise";
  }

  if (!hasElytra) return spareViable ? "replace" : "abort";
  if (!wornUsable) return spareViable ? "replace" : "abort";

  // Healthy enough to fly, but a fresh spare is available and the worn one is wearing out: swap before it
  // becomes critical, so a mid-flight break is avoided rather than recovered from.
  if (wornNeedsReplace && spareViable) return "replace";

  if (!canDeploy(state)) return "wait";
  return canAttempt ? "launch" : "wait";
}

/** Retry/backoff state for an action that can fail repeatedly. */
export class RetryPolicy {
  private attempts = 0;
  private lastAttemptAt = 0;
  private nextAllowedAt = 0;
  private readonly maxAttempts: number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;

  constructor(maxAttempts: number, baseDelayMs: number, maxDelayMs: number) {
    this.maxAttempts = Math.max(1, Math.floor(maxAttempts));
    this.baseDelayMs = Math.max(0, baseDelayMs);
    this.maxDelayMs = Math.max(this.baseDelayMs, maxDelayMs);
  }

  canAttempt(nowMs: number): boolean {
    return this.attempts < this.maxAttempts && nowMs >= this.nextAllowedAt;
  }

  exhausted(): boolean {
    return this.attempts >= this.maxAttempts;
  }

  get attemptCount(): number {
    return this.attempts;
  }

  recordAttempt(nowMs: number): void {
    this.attempts += 1;
    this.lastAttemptAt = nowMs;
    const delay = this.baseDelayMs * 2 ** Math.min(this.attempts - 1, 6);
    this.nextAllowedAt = nowMs + Math.min(delay, this.maxDelayMs);
  }

  reset(): void {
    this.attempts = 0;
    this.nextAllowedAt = 0;
  }

  millisUntilNextAttempt(nowMs: number): number {
    return Math.max(0, this.nextAllowedAt - nowMs);
  }
}

/**
 * The retry and transition policy behind elytra redeployment.
 *
 * The subtle rule this enforces: re-asserting "flight is wanted" every tick must NOT reset the retry budget.
 * Only a genuine transition from "not wanted" to "wanted", an explicit {@link beginLeg}, or a glide actually
 * starting replenishes the budget.
 */
export class DeploymentGovernor {
  private readonly policy: RetryPolicy;
  private wants = false;
  private startedFlag = false;
  private failureReported = false;
  private last: FlightState = "unknown";
  private lastTransitionEndedGlide = false;

  constructor(maxLaunchAttempts: number, launchDelayMs: number, maxLaunchDelayMs: number) {
    this.policy = new RetryPolicy(maxLaunchAttempts, launchDelayMs, maxLaunchDelayMs);
  }

  setWantsFlight(wants: boolean): void {
    if (wants && !this.wants) {
      this.startedFlag = true;
      this.policy.reset();
      this.failureReported = false;
    }
    this.wants = wants;
  }

  get wantsFlight(): boolean {
    return this.wants;
  }

  get started(): boolean {
    return this.startedFlag;
  }

  beginLeg(): void {
    this.policy.reset();
    this.failureReported = false;
  }

  /** Feeds the current physical state. Returns true when a glide just began. */
  noteState(state: FlightState): boolean {
    if (state === this.last) {
      this.lastTransitionEndedGlide = false;
      return false;
    }
    const previous = this.last;
    this.last = state;
    this.lastTransitionEndedGlide = previous === "gliding" && state !== "gliding";
    if (state === "gliding" && previous !== "gliding") {
      this.policy.reset();
      this.failureReported = false;
      return true;
    }
    return false;
  }

  get justLanded(): boolean {
    return this.lastTransitionEndedGlide && this.wants;
  }

  get lastState(): FlightState {
    return this.last;
  }

  canAttempt(nowMs: number): boolean {
    return this.policy.canAttempt(nowMs);
  }

  recordAttempt(nowMs: number): void {
    this.policy.recordAttempt(nowMs);
  }

  get attempts(): number {
    return this.policy.attemptCount;
  }

  get exhausted(): boolean {
    return this.policy.exhausted();
  }

  millisUntilNextAttempt(nowMs: number): number {
    return this.policy.millisUntilNextAttempt(nowMs);
  }

  /** True the first time after the budget is spent, so a failure is reported once, not per tick. */
  shouldReportDeployFailure(): boolean {
    if (this.policy.exhausted() && !this.failureReported) {
      this.failureReported = true;
      return true;
    }
    return false;
  }
}
