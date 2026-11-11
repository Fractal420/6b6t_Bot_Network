import type { ApiRoute } from "./types.ts";

export const API_ROUTES: ApiRoute[] = [
  { method: "GET", path: "/health", auth: false, desc: "process liveness" },
  { method: "GET", path: "/v1/catalog", auth: true, desc: "this list of routes and RPC actions" },
  { method: "GET", path: "/v1/status", auth: true, action: "status", desc: "phase, pose, health, movement keys" },
  { method: "GET", path: "/v1/view?r=20", auth: true, action: "view", desc: "one-shot surroundings: look target, voxels, players, entities, portals, held item" },
  { method: "GET", path: "/v1/voxels?r=20", auth: true, action: "voxels", desc: "surface-culled 3D block field around the bot" },
  { method: "GET", path: "/v1/map?r=24", auth: true, action: "map", desc: "ASCII top-down slice" },
  { method: "GET", path: "/v1/block?x&y&z", auth: true, action: "block", desc: "single block at world coords" },
  { method: "GET", path: "/v1/cursor", auth: true, action: "cursor", desc: "block and entity the bot is looking at" },
  { method: "GET", path: "/v1/players", auth: true, action: "players", desc: "tab list / known players" },
  { method: "GET", path: "/v1/entities", auth: true, action: "entities", desc: "nearby loaded entities" },
  { method: "GET", path: "/v1/inventory", auth: true, action: "inventory", desc: "full inventory snapshot" },
  { method: "GET", path: "/v1/dump", auth: true, action: "dump", desc: "world probe (counts, portals, map)" },
  { method: "POST", path: "/v1/rpc", auth: true, desc: "JSON { action, ...fields }. Also POST /v1/<action>" },
  { method: "WS", path: "/v1/events", auth: true, desc: "live status, chat, kicks, portals, phase" },

  { method: "POST", path: "/v1/rpc", auth: true, action: "control", desc: "hold/release movement keys", body: { state: { forward: true } } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "jump", desc: "tap jump" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "stop", desc: "clear keys and pathfinder goal" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "goto", desc: "pathfind to a block", body: { x: 0, y: 64, z: 0, range: 1 } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "lookAt", desc: "look at world coords", body: { x: 0, y: 64, z: 0 } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "look", desc: "look by yaw/pitch radians, or x y z", body: { yaw: 0, pitch: 0 } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "turn", desc: "add radians to current look", body: { yaw: 0.2, pitch: 0 } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "attack", desc: "attack looked-at entity, or a username", body: { username: "Steve" } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "dig", desc: "dig looked-at block, or x y z" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "stopDig", desc: "cancel digging" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "place", desc: "place held block against a face", body: { face: "up" } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "activate", desc: "right-click a block (chest, door, lever)" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "swing", desc: "swing the arm" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "inv", desc: "hold | drop | dropStack | equip | unequip | use | swap | windowClick | windowClose", body: { op: "hold", slot: 36 } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "tabComplete", desc: "server tab-complete for partial command (e.g. home names)", body: { partial: "home " } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "chat", desc: "send chat", body: { message: "hi" } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "command", desc: "slash command without /", body: { command: "home" } },
  { method: "POST", path: "/v1/rpc", auth: true, action: "join", desc: "connect / rejoin" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "leave", desc: "disconnect" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "reconnect", desc: "force reconnect" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "respawn", desc: "press respawn" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "hunt", desc: "walk server portals" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "unhunt", desc: "stop portal hunting" },
  { method: "POST", path: "/v1/rpc", auth: true, action: "set", desc: "autoReconnect / autoLobby flags", body: { autoReconnect: true } },
];

export function apiCatalog() {
  const rpc = [...new Set(API_ROUTES.map((r) => r.action).filter(Boolean))];
  return {
    rpc,
    routes: API_ROUTES,
    movement: ["control", "jump", "stop", "goto", "look", "lookAt", "turn"],
    viewport: ["view", "voxels", "map", "block", "cursor", "dump", "entities", "players"],
    inventory: ["inventory", "inv", "tabComplete"],
    session: ["join", "leave", "reconnect", "respawn", "status", "set", "hunt", "unhunt"],
    interact: ["attack", "dig", "stopDig", "place", "activate", "swing", "chat", "command", "tabComplete"],
  };
}
