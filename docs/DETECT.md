# Detect (players, crystals, combat)

The Detect module watches the live world for nearby players and combat-related entities, keeps a short event log, and can raise **browser push notifications** (and optional Discord mirrors) when something interesting happens.

It does not move the bot or change inventory. It only observes and reports.

---

## What it does

- Tracks players entering and leaving render range (with a leave **grace period** so brief chunk flicker does not spam leave/enter).
- Optionally watches end crystals, TNT, explosions, and combat (attacked / hurt / death).
- Maintains a ring buffer of recent events (dashboard **Detect** tab + API).
- Optional **packet listener** for low-level server/client traffic (debugging).
- Per-profile **notify prefs** so each account can choose which kinds of events alert this browser.

---

## Event kinds

| Kind | When |
|------|------|
| `player_enter` | A player appears in range (or after grace ends without return). |
| `player_leave` | Player gone from range longer than the leave grace. |
| `crystal_spawn` / `crystal_gone` | End crystal appears or despawns. |
| `tnt_spawn` / `tnt_gone` | TNT entity appears or despawns. |
| `explosion` | Explosion observed. |
| `attacked` / `hurt` / `death` | Combat against the bot (when combat detection is on). |

Each event carries a timestamp, label, optional username/skin, position, distance, and world kind (lobby vs main).

---

## Quick start

1. Join with a profile.
2. Open the **Detect** module in the dashboard.
3. Enable the categories you care about (players, crystals, TNT, explosions, combat).
4. Optionally enable browser notifications and tune prefs (enter/leave, combat only when tab hidden, ignore lobby, etc.).

API: `getDetection` returns `{ events, nearby }`; `clearDetection` wipes the log and re-emits enter for everyone currently in range.

---

## Config (per profile)

Stored under `Settings/Profiles/<id>.json` (and mirrored in the dashboard):

| Key | Meaning |
|-----|---------|
| `detectionPlayers` | Track player enter/leave (default on). |
| `detectionCrystals` | Track end crystals. |
| `detectionTnt` | Track TNT entities. |
| `detectionExplosions` | Track explosions. |
| `detectionCombat` | Track attacked / hurt / death. |
| `detectionPlayerLeaveGraceMs` | Wait this long after leave before emitting `player_leave` (default ~60s). |
| `detectionRecheckMs` | Periodic rescan of loaded players (teleport / missed `entityGone`). |
| `serverListener` | Enable packet listener. |
| `serverListenerOutbound` | Include client→server packets when listening. |
| `notifyPrefs` | Browser push toggles: `playerEnter`, `playerLeave`, `combat`, `crystals`, `tnt`, `explosions`, `onlyHidden`, `lobby`. |

---

## Design notes

- Detection is passive: no movement leases, no inventory use.
- Leave grace suppresses spam when players flicker at the edge of render distance.
- Events are capped (recent ring buffer) and pushed over the control WebSocket as `detection`.
- Lobby/auth worlds can be filtered out of notifications so portal noise does not alert you.

Implementation: detection helpers and log live on `FractalBot` in `src/api/FractalBot.ts`; types in `src/api/types.ts` (`DetectionEvent`, `DetectionKind`).
