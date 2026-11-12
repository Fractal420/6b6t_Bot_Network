/**
 * A priority-based task scheduler and control-resource arbiter.
 *
 * Every automation concern that touches the player — movement, the inventory, equipment slots — must acquire
 * the matching resource before acting and release it afterwards. Only one holder per resource exists at a
 * time, and a higher priority may preempt a lower one, so two modules can never fight over the same controls.
 * Pure and synchronous so the arbitration rules are testable.
 */

export enum Priority {
  /** Critical survival (about to die). */
  CriticalSurvival = 1,
  /** Equipment failure recovery (elytra broke, replacement needed). */
  EquipmentRecovery = 2,
  /** Flight safety (landing, aborting a doomed glide). */
  FlightSafety = 3,
  /** Inventory management (deposit/withdraw, sorting). */
  Inventory = 4,
  /** Active exploration (flying the route). */
  Exploration = 5,
  /** Investigating a specific target. */
  TargetInvestigation = 6,
  /** Background discovery (idle scanning). */
  Background = 7,
}

export function priorityName(p: Priority): string {
  switch (p) {
    case Priority.CriticalSurvival:
      return "critical-survival";
    case Priority.EquipmentRecovery:
      return "equipment-recovery";
    case Priority.FlightSafety:
      return "flight-safety";
    case Priority.Inventory:
      return "inventory";
    case Priority.Exploration:
      return "exploration";
    case Priority.TargetInvestigation:
      return "target-investigation";
    case Priority.Background:
      return "background";
  }
}

/** A player-control resource that only one task may hold at a time. */
export type ControlResource = "movement" | "inventory" | "equipment" | "chat";

export interface Lease {
  owner: string;
  priority: Priority;
  resource: ControlResource;
  acquiredAt: number;
}

export interface AcquireResult {
  ok: boolean;
  /** The current holder, when the request was denied. */
  heldBy?: string;
  heldPriority?: Priority;
}

/** Arbitrates exclusive access to the player-control resources. */
export class Scheduler {
  private readonly leases = new Map<ControlResource, Lease>();
  private readonly owners = new Map<string, Set<ControlResource>>();

  /**
   * Requests a set of resources at a priority. Succeeds only when every requested resource is free or held
   * by a strictly lower priority; on success any preempted lower-priority holder is evicted.
   */
  acquire(owner: string, priority: Priority, resources: ControlResource[], nowMs = 0): AcquireResult {
    for (const resource of resources) {
      const current = this.leases.get(resource);
      if (current && current.owner !== owner && current.priority <= priority) {
        return { ok: false, heldBy: current.owner, heldPriority: current.priority };
      }
    }

    for (const resource of resources) {
      const current = this.leases.get(resource);
      if (current && current.owner !== owner && current.priority > priority) {
        this.releaseOwner(current.owner, resource);
      }
      this.leases.set(resource, { owner, priority, resource, acquiredAt: nowMs });
      let set = this.owners.get(owner);
      if (!set) {
        set = new Set();
        this.owners.set(owner, set);
      }
      set.add(resource);
    }

    return { ok: true };
  }

  /** Releases the given resources (or all of the owner's resources when omitted). */
  release(owner: string, resources?: ControlResource[]): void {
    const owned = this.owners.get(owner);
    if (!owned) return;
    const toRelease = resources ?? [...owned];
    for (const resource of toRelease) {
      const current = this.leases.get(resource);
      if (current && current.owner === owner) {
        this.leases.delete(resource);
        owned.delete(resource);
      }
    }
    if (owned.size === 0) this.owners.delete(owner);
  }

  /** Releases everything owned by an owner (used when a module deactivates). */
  releaseAll(owner: string): void {
    this.release(owner);
  }

  private releaseOwner(owner: string, resource: ControlResource): void {
    const current = this.leases.get(resource);
    if (!current || current.owner !== owner) return;
    this.leases.delete(resource);
    const owned = this.owners.get(owner);
    if (owned) {
      owned.delete(resource);
      if (owned.size === 0) this.owners.delete(owner);
    }
  }

  holder(resource: ControlResource): Lease | undefined {
    return this.leases.get(resource);
  }

  isHeldBy(owner: string, resource: ControlResource): boolean {
    return this.leases.get(resource)?.owner === owner;
  }

  /** All current leases, for diagnostics and the status HUD. */
  snapshot(): Lease[] {
    return [...this.leases.values()];
  }

  clear(): void {
    this.leases.clear();
    this.owners.clear();
  }
}

export interface Task {
  name: string;
  priority: Priority;
  /** Returns true when the task is still pending; false removes it. */
  run: () => boolean | void;
}

/**
 * A cooperative task list ordered by priority. Tasks are polled in priority order each tick and a task
 * returning `false` is retired, so a completed job cannot keep running.
 */
export class TaskScheduler {
  private readonly tasks: Task[] = [];

  /** Adds or replaces a task by name. */
  submit(task: Task): void {
    const existing = this.tasks.findIndex((t) => t.name === task.name);
    if (existing >= 0) this.tasks[existing] = task;
    else this.tasks.push(task);
  }

  cancel(name: string): boolean {
    const index = this.tasks.findIndex((t) => t.name === name);
    if (index < 0) return false;
    this.tasks.splice(index, 1);
    return true;
  }

  has(name: string): boolean {
    return this.tasks.some((t) => t.name === name);
  }

  /** Runs every pending task in priority order, retiring those that return false. */
  tick(): void {
    const ordered = [...this.tasks].sort((a, b) => a.priority - b.priority);
    for (const task of ordered) {
      const index = this.tasks.indexOf(task);
      if (index < 0) continue;
      const keep = task.run();
      if (keep === false) this.tasks.splice(index, 1);
    }
  }

  get pending(): Task[] {
    return [...this.tasks].sort((a, b) => a.priority - b.priority);
  }

  clear(): void {
    this.tasks.length = 0;
  }
}
