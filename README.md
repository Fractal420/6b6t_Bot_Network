# Fractal42O Bot Network

Mineflayer control system for the **6b6t** anarchy server.

Offline join with stored `/login`, dual-portal lobby navigation, auto-rejoin with captcha handling, multi-account fleet, elytra mapping (Xaero), CLI, web dashboard, and HTTP/WebSocket control API.

> Made by **Fractal42O** for the **6b6t** community.

**Changelog:** [CHANGELOG.md](CHANGELOG.md)

---

## Features

### Top bar

| Control | Role |
|---------|------|
| **Profile switcher** | Select the active account. **Manage** opens Fleet: add/remove profiles, start/stop bots, per-bot flags (online, hunt, map, announcements, anti-AFK). Profiles live in `Settings/Profiles/`. |
| **Home (Play)** | Connection toggles (Online, Anti-AFK, Captcha notify, Auto lobby), live status (world, XYZ, ping, HP/food), nearby players, homes, inventory, 3D view, goto/wire. |
| **Settings** | Process (control API host/port/token) and Connection overrides for the selected profile (host, auth, reconnect, captcha cooldown, etc.). Module options stay on their own tabs. |
| **Log** | Activity feed: joins, kicks, captcha, hunt/kit events, errors. |

### Modules

Sidebar modules (CLI and Discord expose the same surfaces). Details live in `docs/`:

| Module | Summary | Docs |
|--------|---------|------|
| **Map** | Elytra terrain survey; writes Xaero regions (box / spawn / ring / direction). | [docs/MAP.md](docs/MAP.md) |
| **Detect** | Players, crystals, combat events, optional browser alerts. | [docs/DETECT.md](docs/DETECT.md) |
| **Announce** | Timed chat messages from `Settings/announcements.json`. | [docs/ANNOUNCE.md](docs/ANNOUNCE.md) |
| **Hunt** | Autonomous base hunting: routes, stash scan, restock, Mending, survival. | [docs/BASE_HUNTING.md](docs/BASE_HUNTING.md) |
| **Kit Bot** | Serve real inventory kits on a chat prefix (`!kit`). | [docs/KIT_BOT.md](docs/KIT_BOT.md) |

### Core platform

- Offline (or Microsoft) join; credentials never prompted at runtime
- Dual-portal lobby navigation and auto-reconnect with captcha handling
- CLI with tab completion; control API (`POST /v1/rpc`, `WS /v1/events`)
- Optional Discord remote control and log mirror

---

## Requirements

- **Node.js ≥ 20**
- Offline Minecraft account that can join 6b6t (or Microsoft auth)

---

## Setup

```bash
npm install
```

| Path | Purpose |
|------|---------|
| `Settings/settings.json` | Global options (host, control API, reconnect, Discord, …) |
| `Settings/Profiles/<id>.json` | Per-account credentials, features, overrides |
| `Settings/announcements.json` | Default timed chat messages |
| `Settings/hunt/<server>/` | Hunt config + database |

Legacy `.env` / `accounts.json` migrate on first run.

Minimal `Settings/settings.json`:

```json
{
  "version": 1,
  "values": {
    "MC_HOST": "alt3.6b6t.org",
    "MC_PORT": "25565",
    "MC_USERNAME": "your_account",
    "MC_PASSWORD": "...",
    "MC_AUTH": "offline",
    "CONTROL_HOST": "127.0.0.1",
    "CONTROL_PORT": "20972",
    "SERVER_PORTALS": "2"
  }
}
```

Optional CLI on PATH:

```bash
npm link
eval "$(fractalbot completion zsh)"   # or bash
```

---

## Usage

```bash
npm start                 # dashboard + API → http://127.0.0.1:20972
fractalbot join           # join + shell
fractalbot join --daemon  # background

fractalbot status
fractalbot chat hello
fractalbot map-start box | map-status | map-stop
fractalbot bh start spiral | bh status | bh stop
fractalbot kibot start | kibot status | kibot stop
```

Other commands: `goto`, `look`, `walk`, `inv`, `players`, `view`, `shell`, `completion`.

**Discord (optional):** `npm install discord.js`, set `DISCORD_*` in settings, enable Message Content Intent. Commands: `!status`, `!chat`, `!map`, `!bh …`, `!kibot …`, etc.

**API:** `POST /v1/rpc` with `{ "action": "...", ... }` (token if `CONTROL_TOKEN` is set); events on `WS /v1/events`.

```bash
npm run typecheck && npm test
```

---

## Credits & Inspiration

**Made by [Fractal42O](https://github.com/Fractal42O) for the 6b6t community.**

| Project | Link |
|---------|------|
| Original 6bBotAPI | https://github.com/ClapFy/6bBotAPI |
| GaBaus Sky Logo Builder | https://github.com/RealGaBaus/GaBaus-Sky-Logo-Builder |
| Mineflayer Elytra Mapper | https://github.com/fpvwraith/Mineflayer-Elytra-Mapper |
| Mineflayer Mapart Bot | https://github.com/ComicSquid74273/mineflayer-Mapart-Bot |
| THC Announcements Bot | https://github.com/stubbledbannana/THC-Anouncements-Bot |
| 6b6t Join Bot | https://github.com/NOSLEEPSMOKE/6b6t-join-bot |

License: MIT — see [LICENSE](LICENSE).
