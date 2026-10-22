# 6bBotAPI

> Original Work: https://github.com/ClapFy/6bBotAPI

Mineflayer control system for the 6b6t anarchy server. Offline-account join, stored `/login`, two server-lobby portals, auto-rejoin, a CLI with tab completion, and an HTTP/WebSocket control API you can plug other UIs into.

## Setup

```bash
npm install
cp .env.example .env
```

Put the offline username and in-game password in `.env` (never commit that file):

```
KRYNBOT_HOST=alt3.6b6t.org
KRYNBOT_USERNAME=your_account
KRYNBOT_PASSWORD=...
KRYNBOT_AUTH=offline
KRYNBOT_VERSION=1.21.11
```

Optionally install the CLI on your PATH:

```bash
npm link
eval "$(krynbot completion zsh)"   # or: krynbot completion bash
```

Start the control API and dashboard:

```bash
npm start
```

## CLI

```bash
krynbot join              # offline join + /login from .env, then an interactive shell
krynbot join --daemon     # same, no shell; keep using the CLI against the running bot
krynbot status
krynbot chat hello
krynbot cmd home
krynbot map               # ASCII top-down of the lobby / area
krynbot hunt              # (re)start walking into server portals
krynbot leave
```

`join` never asks for the password. Tab-complete works in the shell and after `eval "$(krynbot completion zsh)"`.

If a server portal cannot be found after join, the bot stays connected and retries every 60 seconds. A full kick from the server triggers an automatic reconnect.

## Control API

While the bot is running, a local API listens on `127.0.0.1:37637` only. It always requires `KRYNBOT_CONTROL_TOKEN` (generated into `.env` on first run). The dashboard sets an HttpOnly cookie; CLI/curl send `Authorization: Bearer …`. `GET /health` stays unauthenticated (loopback-only). `GET /v1/catalog` requires the token.

```bash
TOKEN=$(grep '^KRYNBOT_CONTROL_TOKEN=' .env | cut -d= -f2-)
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
import { KrynBot } from "krynbot";
import { loadConfig } from "krynbot/config";

const bot = new KrynBot(loadConfig());
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
6. If kicked, reconnect. If a lobby portal is missing, wait a minute and scan again.

## Documentation

- [Contributing](CONTRIBUTING.md)
- [Code of Conducts](docs/CODE_OF_CONDUCT.md)
