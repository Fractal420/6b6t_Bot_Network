# Fractal 6b Slave Bot

> Original Work: https://github.com/ClapFy/6bBotAPI

Mineflayer control system for the 6b6t anarchy server. Offline-account join, stored `/login`, two server-lobby portals, auto-rejoin, a CLI with tab completion, and an HTTP/WebSocket control API you can plug other UIs into.

## Setup

```bash
npm install
cp .env.example .env
```

Put the offline username and in-game password in `.env` (never commit that file). See `.env.example` for the full list:

```
# Minecraft server
MC_HOST=alt3.6b6t.org
MC_PORT=25565
MC_USERNAME=your_account
MC_PASSWORD=...
MC_AUTH=offline
MC_VERSION=1.21.11
MC_VIEW_DISTANCE=6

# Local control API
CONTROL_HOST=127.0.0.1
CONTROL_PORT=37637
CONTROL_TOKEN=
# CONTROL_EXPOSE=1

# Lobby / reconnect behavior
SERVER_PORTALS=2
PORTAL_RETRY_MS=60000
RECONNECT_MS=8000
```

Optionally install the CLI on your PATH:

```bash
npm link
eval "$(fractalbot completion zsh)"   # or: fractalbot completion bash
```

Start the control API and dashboard:

```bash
npm start
```

## CLI

```bash
fractalbot join              # offline join + /login from .env, then an interactive shell
fractalbot join --daemon     # same, no shell; keep using the CLI against the running bot
fractalbot status
fractalbot chat hello
fractalbot cmd home
fractalbot map               # ASCII top-down of the lobby / area
fractalbot hunt              # (re)start walking into server portals
fractalbot leave
```

`join` never asks for the password. Tab-complete works in the shell and after `eval "$(fractalbot completion zsh)"`.

If a server portal cannot be found after join, the bot stays connected and retries every 60 seconds. A full kick from the server triggers an automatic reconnect.

## Control API

While the bot is running, a local API listens on `127.0.0.1:37637` only. It always requires `CONTROL_TOKEN` (generated into `.env` on first run). The dashboard sets an HttpOnly cookie; CLI/curl send `Authorization: Bearer …`. `GET /health` stays unauthenticated (loopback-only). `GET /v1/catalog` requires the token.

```bash
TOKEN=$(grep '^CONTROL_TOKEN=' .env | cut -d= -f2-)
curl -s -H "authorization: Bearer $TOKEN" http://127.0.0.1:37637/v1/view?r=16
curl -s -X POST http://127.0.0.1:37637/v1/rpc \
  -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' \
  -d '{"action":"control","state":{"forward":true,"sprint":true}}'
```

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/v1/catalog` | all routes + RPC actions |
| GET | `/v1/status` | phase, pose, health, held movement keys |
| GET | `/v1/view?r=20` | surroundings: look target, voxels, players, entities, portals |
| GET | `/v1/voxels?r=20` | 3D surface-culled block field (same data as the dashboard viewport) |
| GET | `/v1/map?r=24` | ASCII top-down slice |
| GET | `/v1/cursor` | block / entity the bot is looking at |
| GET | `/v1/block?x&y&z` | one block |
| GET | `/v1/players` | known players |
| GET | `/v1/entities` | nearby loaded entities |
| GET | `/v1/inventory` | inventory snapshot |
| GET | `/v1/dump` | world probe |
| POST | `/v1/rpc` | JSON `{ "action": "...", ... }` — also `POST /v1/<action>` |
| WS | `/v1/events` | live chat, kicks, portal, phase |

Movement: `control`, `jump`, `stop`, `goto`, `look`, `lookAt`, `turn`.  
Viewport: `view`, `voxels`, `map`, `cursor`, `block`, `dump`, `entities`, `players`.  
Interact: `attack`, `dig`, `stopDig`, `place`, `activate`, `swing`, `inv`, `chat`, `command`.

Join credentials and Minecraft host cannot be changed over the API — only via `.env` / CLI.

```ts
import { FractalBot } from "fractalbot";
import { loadConfig } from "fractalbot/config";

const bot = new FractalBot(loadConfig());
await bot.join();
bot.on("chat", (event) => console.log(event.raw));
bot.chat("hello");
```

RPC actions: see `GET /v1/catalog`. Common ones include `join`, `leave`, `control`, `goto`, `look`, `view`, `voxels`, `inv`, `chat`, `command`, `attack`, `dig`, `place`, `hunt`.

## How join works

1. Connect offline to `alt3.6b6t.org` as Minecraft **1.21.11**.
2. Send AnarchyMod `anarchymod:join`.
3. `/login` with the stored password when the server asks.
4. Offline accounts are sent to an End lobby island, then must walk **two server nether portals** (End island, then overworld sky lobby). The first lobby portal is a normal vanilla nether portal (2×3 interior). Decorative portal walls are ignored. Real nether portals in survival are ignored.
5. Lobby portal transfers go through Velocity; the bot pauses physics during that configuration phase so it is not kicked.
6. If kicked, reconnect with smart backoff. If a lobby portal is missing, wait a minute and scan again.

## Captcha / anti-bot kicks

When the server kicks the bot with an anti-bot or captcha message:

- The full kick reason is logged and emitted on the `kicked` event / WebSocket.
- Any `http://` or `https://` links found in the message are extracted and printed clearly so you can open them.
- The bot **never** tries to solve captchas itself.
- Default behaviour: wait `CAPTCHA_COOLDOWN_MS` (1 hour) then retry. Set it to `0` to stop reconnecting until you manually restart after solving the captcha with a normal Minecraft client.

Rate-limit / “logging in too fast” kicks use a shorter floor delay (`RATE_LIMIT_COOLDOWN_MS`).

Normal kicks use exponential backoff up to `RECONNECT_MAX_MS`. Backoff only resets after the bot has stayed on the main world for ~90 seconds (avoids hammering on crash loops).

## Connection robustness (best of both bots)

| Feature | Behaviour |
|---------|-----------|
| Login | Smart `/login` + `/register`, title/window detection, AnarchyMod payload |
| Portals | Vanilla 2×3 detection, pathfinder walk-in, two-portal flow, decorative walls ignored |
| Velocity transfer | Movement packets blocked during configuration phase |
| Captcha | Classified, links extracted, long cooldown / optional halt |
| Rate-limit | Separate floor delay |
| Backoff | Exponential + jitter, resets only after 90 s stable on main |
| Corrupt chunks | Recoverable parse errors are skipped; bot stays connected |
| Auth | Offline (default) or Microsoft (`MC_AUTH=microsoft`) |
| Elytra mapping | Argus/Elytra mapper: Xaero regions, box/ring/highway modes |

## Elytra terrain mapping

Embedded **Mineflayer-Elytra-Mapper** flight + Xaero region writer (uses Fractal’s connection for login/portals/captcha).

**In-game setup (once):**
1. Far base outside the no-`/home` radius (~5k on 6b6t): bed (respawn) + ender chest full of elytras.
2. Launch platform near the area to map; `/sethome <name>` (default home name `spawn`).
3. Put that name in `MAP_HOME_NAME`.

**Configure** box / mode in `.env` (`MAP_MODE`, `MAP_BOX_*`, `MAP_OUTPUT_DIR`).

**Run:**
```bash
fractalbot join --daemon
fractalbot map-start box          # or spawn, ring, north, ...
fractalbot map-status
fractalbot map-stop
```

Dashboard: **map start** / **map stop** buttons.  
RPC: `mapStart`, `mapStop`, `mapStatus`, `mapConfig`.

Regions land in `MAP_OUTPUT_DIR/regions/overworld/*.zip` (Xaero World Map compatible).

## Discord remote control

Optional. Install the dependency and set env:

```bash
npm install discord.js
# .env
DISCORD_ENABLED=1
DISCORD_TOKEN=your_bot_token
DISCORD_CHANNEL_ID=123456789012345678
DISCORD_MIRROR_LOGS=1
```

Enable **Message Content Intent** for the bot in the Discord Developer Portal. Invite it to a private channel.

| Command | Action |
|---------|--------|
| `!help` | List commands |
| `!status` | Bot + mapper status |
| `!join` / `!leave` / `!reconnect` | Session |
| `!chat <msg>` / `!cmd <command>` | In-game chat / command |
| `!hunt` / `!unhunt` | Lobby portal hunt |
| `!map on [mode]` | Start elytra mapping |
| `!map on box:x1,z1,x2,z2` | Map a box |
| `!map off` / `!map status` | Stop / status |
| `!captcha` | Last kick reason + captcha links |

Captcha kicks are posted to the channel when mirror logs are on.

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Code of Conducts](docs/CODE_OF_CONDUCT.md)

## Multi-account fleet

Accounts live in `accounts.json` (next to `.env`). Web **Fleet** panel: add accounts, assign tasks (`join` / `hunt` / `map` / `idle` / `leave`), start/stop each bot. Env `MC_USERNAME` seeds the first account on first run.

RPC: `fleetStatus`, `fleetAddAccount`, `fleetStart`, `fleetSetTask`, `fleetStartAll`, …
