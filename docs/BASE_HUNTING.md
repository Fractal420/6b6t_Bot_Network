# Base Hunting Guide

The base-hunting subsystem turns FractalBot into an autonomous exploration and equipment-management
assistant for anarchy servers. It flies a route with the elytra, scans the terrain it passes for storage
concentrations, records everything it finds, keeps itself equipped, and reports through Discord/webhook —
without any single module fighting another over movement, the inventory or the equipment.

This guide covers what each part does, how to drive it, and the design rules that keep it stable.

---

## Quick start

```bash
npm install
fractalbot join                 # connect the bot (uses the selected profile)
fractalbot bh start spiral      # begin autonomous base hunting
fractalbot bh status            # phase, target, elytra, survival
```

From Discord (prefix `!` by default): `!bh start spiral`, `!bh status`, `!bh stash`, `!bh restock`.
From the web dashboard: open the **Hunt** tab.

---

## Architecture

Everything lives under `src/hunt/` and is wired into the bot by `src/api/FractalBot.ts`. Pure logic is
separated from live Minecraft access so the rules can be tested without a server.

```
src/hunt/
├── controller.ts        HuntController — the tick loop and orchestration
├── scheduler.ts         Priority-based task scheduler + control-resource arbiter
├── flight.ts            Pure flight decisions (shouldReplace, isViable, decideFlight …)
├── flightRuntime.ts     FlightDriver — drives mineflayer controls/elytra for real
├── elytraRuntime.ts     Worn/spare elytra reads and equipBestElytra()
├── mending.ts           Pure Mending ranking (rankCandidates, selectSlot …)
├── mendingRuntime.ts    Live Mending candidate reads + hold-for-repair
├── survival.ts          Pure survival thresholds and evaluation
├── survivalRuntime.ts   Live snapshot (health, food, gear, totems, capacity)
├── inventory.ts         Item classification + "is this precious?" rules
├── enderChestRuntime.ts Find/open/read ender chests, plan + execute deposit/withdraw
├── scanner.ts           RegionScanner, storage block sweep, block classification
├── scoring.ts           Weighted stash scoring, tiering, target prioritisation
├── exploration.ts       Route generators (grid/spiral/direction), explored DB, planner
├── database.ts          Crash-safe, versioned, per-server persistence
└── notifications.ts     Per-event filtering, cooldowns, formatting
```

`src/settings/huntConfigStore.ts` persists the hunt config per server (`Settings/hunt/<server>/config.json`).

---

## The controller tick

`HuntController.tick()` runs on a fixed interval and never throws — a bad tick is logged and reported as a
`system-error` notification rather than crashing the bot. Each tick, in priority order:

1. **Survival** (`checkSurvival`) — reads a live snapshot and evaluates it. Critical health stops flight
   and raises an `emergency`; it never disconnects on its own (AutoLog owns that decision).
2. **Scanning** (`maybeScan`) — scans the current region with a per-tick block budget, or runs the fast
   palette sweep. Results are scored; anything over threshold is recorded.
3. **Route** (`advanceRoute`) — flies to the next waypoint; expands the route when it is exhausted.
4. **Mending** (`maybeMend`) — only when a real XP source is detected.

Everything the controller does is announced through the `NotificationCenter`, which is also mirrored to
Discord (`huntNotification`) and the web dashboard.

---

## Scheduling: one owner per control

The scheduler (`src/hunt/scheduler.ts`) is the reason modules cannot fight. Every concern that touches the
player must acquire a matching resource — `movement`, `inventory`, `equipment`, `chat` — before acting and
release it after. Only one holder per resource exists at a time, and a higher priority may preempt a lower
one.

| Priority | Value | Used for |
|---|---|---|
| `CriticalSurvival` | 1 | about to die |
| `EquipmentRecovery` | 2 | elytra broke, replacement needed |
| `FlightSafety` | 3 | landing, aborting a doomed glide |
| `Inventory` | 4 | deposit/withdraw, sorting |
| `Exploration` | 5 | flying the route |
| `TargetInvestigation` | 6 | investigating a specific target |
| `Background` | 7 | idle scanning |

The hunt controller is a single owner, so it cannot deadlock itself: it releases all its leases at the top
of each tick and re-acquires what the current phase needs.

---

## Elytra management

`elytraRuntime.ts` reads the worn elytra and counts usable spares (spares are scanned only up to
`MAIN_SIZE`, so the worn chest-slot piece is never counted as its own replacement). `equipBestElytra()`
picks the healthiest elytra that clears the configured minimum durability.

The `FlightDriver` reacts automatically:

- **Deploy** — grounded + viable elytra → launch and deploy; retries with backoff, up to `maxDeployAttempts`.
- **Redeploy** — airborne but not gliding → a separate, faster retry so a momentary ground flicker does
  not strand the bot.
- **Replace** — worn elytra at/below `replaceThreshold` and a viable spare exists → swap it in.
- **Abort** — no elytra and no viable spare → stop cleanly and report, rather than pretend to fly.

Flight states (`grounded`, `airborne`, `falling`, `gliding`, `swimming`) are classified before any decision,
so the bot knows the difference between standing, falling and actually flying.

Config keys (under `flight`): `minDurability`, `replaceThreshold`, `deployDelayMs`, `maxDeployAttempts`,
`maxDeployDelayMs`, `cruiseY`, `cruiseBand`, `departDist`.

---

## Mending

`mending.ts` ranks damaged Mending items — most damaged first, ties broken by configured weight, then by
whether the item is worn. `mendingRuntime.ts` reads live candidates and holds the chosen item while XP is
collected.

The controller only mends when there is a **real** XP source: nearby `experience_orb` entities, or bottles
o' enchanting it can throw. "There are mobs around" is deliberately not treated as an XP source — a repair
must be driven by a source the bot can actually use.

Repair priority is configurable per item via `mendingWeights` (e.g. `{ elytra: 10, "*": 1 }`).

---

## End er chest management

`enderChestRuntime.ts`:

- `findEnderChest(bot, radius)` — nearest accessible ender chest in loaded chunks.
- `openEnderChest(bot, location)` — walks over and opens it through normal interaction; returns the block
  or `null` if it could not be reached.
- `readOpenContainer(bot)` — reads the container half of the open window (player slots excluded).
- `planDeposit` / `planWithdraw` — pure planners that decide what moves, honouring reserves and never
  auto-depositing precious items (elytra, armour, tools, totems, valuables, xp supplies, spare equipment).
- `executeDeposit` / `executeWithdraw` — move the planned stacks via `moveSlotItem`, honouring per-name
  counts so a reserve is never swept up by a same-named stack.

`restock()` walks to the nearest ender chest, opens it, withdraws the configured categories and deposits
the configured ones. Every operation is announced (`echest-operation`) and the window is always closed.

Categories: `elytra`, `armor`, `tools`, `fireworks`, `food`, `totems`, `xp-supplies`, `building-blocks`,
`utility`, `spare-equipment`, `valuable`, `other`. Configure `depositCategories`, `withdrawCategories` and
`autoEchest` in the hunt config.

---

## Stash detection

`scanner.ts` reads blocks in a bounded region and classifies them (`classifyBlockName`). `scoring.ts`
produces a **weighted** score from independent indicators — chests, trapped chests, barrels, shulkers,
spawners, hoppers, etc. — so a single isolated chest does not read as a confirmed stash. `meetsThreshold`
gates recording on both a minimum score and a minimum container count.

Tiers: `possible`, `small`, `medium`, `large`, `major`, `structure`, `unconfirmed`, `known`. Every record
stores coordinates, chunk, dimension, discovery time, last-seen time, confidence score, detected block
counts, the method (`scan` / `manual` / `player`) and any associated player sightings.

The fast path is `sweepStorage` — a palette-based sweep that skips sections with no storage at all, so it
covers a whole region in one cheap pass instead of reading every block.

---

## Exploration

`exploration.ts` generates routes and remembers where the bot has been:

- **grid** — evenly spaced lattice.
- **spiral** — outward spiral from the start.
- **adaptive** — spiral that expands when a region stops producing discoveries.
- **direction** — a straight line along a bearing.
- **waypoints** — a custom route you supply (see below).

The `ExploredDatabase` tracks explored and "requires review" chunks so the bot does not repeatedly fly the
same empty territory. `ExplorationPlanner` walks the route and expands it outward when exhausted.

### Custom routes

```bash
fractalbot bh route add 12,34 40,60 -8,100     # chunk coordinates
fractalbot bh route add --file route.txt       # one `x,z` per line
fractalbot bh route list
fractalbot bh route clear                      # back to spiral mode
```

Setting a route switches the mode to `waypoints`; the route is used immediately if hunting is already
active, and it is persisted per server.

---

## Survival

`survival.ts` is the single source of truth for "am I safe to keep going?". `readSurvivalSnapshot` reads
health, hunger, elytra durability, armour durability, totems, food, fireworks and free slots, then
`evaluateSurvival` compares them to thresholds:

| Threshold | Default |
|---|---|
| `minHealth` | 12 |
| `minFood` | 8 |
| `minElytraDurability` | 16 |
| `minArmorDurability` | 20 |
| `minTotems` | 1 |
| `minFoodItems` | 6 |
| `minFireworks` | 0 |
| `minFreeSlots` | 2 |
| `disconnectHealth` | 6 |

A critical verdict raises an emergency and stops flight; the AutoLog owner decides whether to disconnect.
This keeps survival and auto-log from running two competing control loops.

---

## Notifications

`notifications.ts` filters and rate-limits by event kind, then forwards survivors to the sink (Discord
mirror, web dashboard, CLI). Kinds: `stash-discovery`, `major-storage`, `interesting-structure`,
`player-sighting`, `exploration-milestone`, `elytra-replaced`, `mending-status`, `equipment-problem`,
`route-complete`, `route-interrupted`, `echest-operation`, `emergency`, `system-error`.

Urgent kinds (`emergency`, `system-error`, `equipment-problem`, `route-interrupted`) bypass the default
cooldown. A suppressed notification is dropped, not queued — the next allowed one carries current state, so
a flapping condition never produces a backlog of stale alerts.

Test delivery end to end:

```bash
fractalbot bh webhook        # or: fractalbot bh webhook test
```

---

## Persistence

`database.ts` stores everything per server under `Settings/hunt/<server>/database.json`:

- **Crash-safe writes** — temp file then rename, so a crash never leaves a partial file.
- **Versioned** — every file carries a `version` for future migration.
- **Corruption recovery** — a bad file is quarantined (`*.corrupt-<ts>`) and the store starts fresh; a
  single corrupt record never stops the addon loading.
- **De-duplication** — stashes by identity, players by username.
- **Expiration** — players (`maxPlayerAgeDays`) and stashes (`maxStashAgeDays`) are pruned.
- **Export/import**:

```bash
fractalbot bh database export Settings/hunt-export.json
fractalbot bh database import Settings/hunt-export.json
```

Hunt configuration is stored separately at `Settings/hunt/<server>/config.json` (also atomic, also
per-server) and survives restarts.

---

## Commands

### CLI — `fractalbot bh …`

```
bh start [mode]          grid | spiral | adaptive | direction | waypoints
bh stop | pause | resume
bh status
bh explore [mode|status] change mode live, or show the route status
bh restock               restock from the nearest ender chest
bh elytra status|replace|repair
bh mending               (alias: bh elytra repair)
bh survival
bh echest
bh webhook [test]
bh route add|list|clear
bh stash list|nearby
bh player list
bh database export|import
```

### Discord — `!bh …`

The same subcommands: `start`, `stop`, `pause`, `resume`, `status`, `stash`, `restock`, `elytra
[status|replace]`, `mending`, `survival`, `echest`, `route [set x,z …|list|clear]`, `webhook`.

### Web dashboard

The **Hunt** tab shows live phase/mode/flight/elytra/survival, the stash and player lists, buttons for
elytra status/replace, Mending, survival, ender-chest read and webhook test, and a custom-route editor.

### Control API

The hunt actions are exposed over the HTTP/WebSocket RPC API (see `src/api/catalog.ts`): `huntStart`,
`huntStop`, `huntPause`, `huntResume`, `huntStatus`, `huntConfig`, `huntRouteSet`, `huntRouteList`,
`huntRestock`, `elytraStatus`, `elytraReplace`, `mendingStatus`, `survivalStatus`, `echestStatus`,
`stashList`, `stashNearby`, `playerList`, `huntDatabaseExport`, `huntDatabaseImport`, `webhookTest`.

---

## Stability rules

- **Never block the tick.** Scanning is budgeted; disk writes are debounced and atomic; notifications are
  fire-and-forget.
- **Null-safe everywhere.** A tick with no bot, no world or a mid-transition dimension logs and returns.
- **Bounded work.** Scan budget, cooldowns and the debounced save bound memory and disk growth.
- **One owner per resource.** The scheduler is the arbiter; nothing moves the player without a lease.
- **Fail visible.** A failure reports a clear message (chat, Discord, `system-error`) rather than pretending
  it succeeded.

---

## Testing

```bash
npm run typecheck        # tsc --noEmit
npm test                 # node:test suite
npm run build            # typecheck (build is typecheck-only; run via tsx)
```

The suite covers flight planning, elytra replacement, deployment state transitions, durability maths,
Mending ranking, inventory classification, ender-chest planning/execution, stash scoring, chunk
de-duplication, player tracking, route interruption, persistence, database recovery, scheduler priorities
and config round-tripping.
