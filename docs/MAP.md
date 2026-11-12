# Map (Elytra terrain survey)

The Map module flies the bot with an elytra and records the terrain it sees into **Xaero-compatible region files** (and optional tiles). It is the same flight/recording stack used for spawn mapping on anarchy servers, wired into FractalBot so it shares the already-connected account.

It **cannot** run at the same time as base hunting: both own elytra flight. Starting one stops the other.

---

## What it does

- Plans a waypoint grid for a mode (spawn box, highway direction, ring, custom box, etc.).
- Deploys elytra, firework-boosts, and lawnmower-sweeps the area.
- Records loaded chunks and writes Xaero region data under the mapper output directory.
- Optionally prunes far chunks to keep memory stable on long runs.
- Can auto-start when the bot reaches the main server (`mapAutoStart`).

Output lives under the configured map output dir (default project `output/`, or per-profile `mapOutputDir`): region files, status, and optional tiles.

---

## Modes

| Mode | Behaviour |
|------|-----------|
| `spawn` | Grid around 0,0 within ±5000 blocks. |
| `north` / `south` / `east` / `west` | Highway-style strip in that direction (keeps out of a spawn keep-out circle). |
| `ne` / `nw` / `se` / `sw` | Diagonal highway directions. |
| `ring` / `ring-nw` … | Cover a ±10k box around spawn while excluding the inner keep-out (~5.3k). |
| `box` | Single rectangle from config (`map.box` / profile `mapBox`). |
| `box:x1,z1,x2,z2` | One-shot custom rectangle. |
| `boxes` | Multiple rectangles from config (`mapping.boxes`). |
| `needed` | Plan from regions still missing on disk (coverage fill). |
| `rotate` | Cycle clockwise through the eight direction modes, one full run each. |

CLI: `fractalbot map-start <mode>`.

---

## Quick start

```bash
fractalbot join
fractalbot map-start spawn    # or box, ring, north, ...
fractalbot map-status
fractalbot map-stop
```

Dashboard: open the **Map** module. Discord (if enabled): `!map on <mode>`, `!map off`, `!map status`.

---

## Config

Global defaults live in `Settings/settings.json` / process config; per-profile overrides in `Settings/Profiles/<id>.json`:

| Key | Meaning |
|-----|---------|
| `mapMode` | Default mode when starting without an argument. |
| `mapHomeName` | `/home` name used as launch base (default often `spawn`). |
| `mapBox` | `{ x1, z1, x2, z2 }` for box mode. |
| `mapOutputDir` | Where region files are written for this bot. |
| `mapAutoStart` | If true, start mapping after the bot is on the main server. |

Mapper internals also use home cooldown, skip-spawn-regions, memory prune settings, and Xaero dimension (`overworld` by default). See `mapper-lib/host.js` for the full host defaults.

---

## Design notes

- Flight uses mineflayer’s own elytra API plus firework boosts (not a third-party elytra plugin).
- A **far base** (bed + ender chest of elytras outside the no-`/home` radius) and a **launch** `/home` keep long runs resilient if spawn beds are griefed.
- Render radius and grid step are tuned so adjacent sweeps overlap without freezing the event loop.
- Region writes are incremental; status exposes active flag, mode, output paths, region/tile counts, and memory.

For implementation detail, start at `src/mapper/bridge.ts` and `mapper-lib/mapper.js`.
