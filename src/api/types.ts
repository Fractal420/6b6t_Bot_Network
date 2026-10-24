import type { Bot } from "mineflayer";
import type { Vec3 } from "vec3";

export type BotPhase =
  | "idle"
  | "connecting"
  | "authenticating"
  | "lobby"
  | "in_game"
  | "reconnecting"
  | "disconnected";

export type WorldKind = "unknown" | "auth" | "lobby" | "overworld" | "nether" | "end";

export type PortalKind = "server" | "nether" | "end" | "unknown";

export interface Vec3Like {
  x: number;
  y: number;
  z: number;
}

export interface JoinOptions {
  host?: string;
  port?: number;
  username?: string;
  password?: string;
  version?: string;
  autoReconnect?: boolean;
  autoLobby?: boolean;
}

export interface ControlState {
  forward: boolean;
  back: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  sneak: boolean;
  sprint: boolean;
}

export interface InventorySlot {
  slot: number;
  name: string;
  count: number;
  displayName: string;
  stackSize?: number;
  durabilityUsed?: number;
  maxDurability?: number;
  customName?: string | null;
}

export type EquipmentDest = "hand" | "off-hand" | "head" | "torso" | "legs" | "feet";

export type InvOp = "hold" | "drop" | "dropStack" | "equip" | "unequip" | "use" | "swap";

export interface InventoryView {
  quickBarSlot: number;
  held: InventorySlot | null;
  slots: InventorySlot[];
}

export interface InvCommand {
  op: InvOp;
  slot?: number;
  to?: number;
  dest?: EquipmentDest;
  count?: number;
}

export interface PlayerInfo {
  username: string;
  uuid?: string;
  ping?: number;
  gamemode?: string;
  distance?: number;
  position?: Vec3Like;
  yaw?: number;
}

export interface BotStatus {
  phase: BotPhase;
  connected: boolean;
  username: string;
  host: string;
  port: number;
  version?: string;
  dimension?: string;
  worldKind: WorldKind;
  authenticated: boolean;
  serverPortalsEntered: number;
  requiredServerPortals: number;
  position?: Vec3Like;
  yaw?: number;
  pitch?: number;
  onGround?: boolean;
  gameMode?: string;
  control: ControlState;
  health?: number;
  food?: number;
  ping?: number;
  players: number;
  uptimeMs: number;
  lastKick?: string;
  lastError: BotErrorInfo | null;
  lastChat?: string;
  autoReconnect: boolean;
  autoLobby: boolean;
  huntingPortal: boolean;
}

export type BotErrorSource = "connect" | "kick" | "disconnect" | "socket";

export interface BotErrorInfo {
  at: string;
  source: BotErrorSource;
  message: string;
  code?: string;
}

export interface PortalTarget {
  kind: PortalKind;
  position: Vec3Like;
  distance: number;
  blockName: string;
}

export interface WorldDump {
  at: string;
  dimension?: string;
  worldKind: WorldKind;
  gameMode?: string;
  position?: Vec3Like;
  yaw?: number;
  pitch?: number;
  worldBorderDiameter?: number | null;
  nearbyCounts: Record<string, number>;
  portals: PortalTarget[];
  island?: {
    solid: number;
    water: number;
    airish: number;
    looksLikeIsland: boolean;
  };
  asciiMap: string;
}

export interface BlockInfo {
  x: number;
  y: number;
  z: number;
  name: string;
}

export interface EntityInfo {
  id?: number;
  name: string;
  kind: string;
  position: Vec3Like;
  yaw?: number;
  pitch?: number;
  distance?: number;
}

export interface LookInfo {
  yaw: number;
  pitch: number;
  target: BlockInfo | null;
  entity: EntityInfo | null;
}

export type PlaceFace = "up" | "down" | "north" | "south" | "east" | "west";

export interface Surroundings {
  at: string;
  status: BotStatus;
  look: LookInfo;
  held: InventorySlot | null;
  players: PlayerInfo[];
  entities: EntityInfo[];
  portals: PortalTarget[];
  voxels: VoxelField;
  map?: string;
}

export interface ApiRoute {
  method: "GET" | "POST" | "WS";
  path: string;
  auth: boolean;
  action?: string;
  desc: string;
  body?: Record<string, unknown>;
}

export interface VoxelEntity {
  name: string;
  kind: "bot" | "player";
  x: number;
  y: number;
  z: number;
  yaw?: number;
}

export interface VoxelField {
  at: string;
  ox: number;
  oy: number;
  oz: number;
  sx: number;
  sy: number;
  sz: number;
  palette: string[];
  cells: number[];
  entities: VoxelEntity[];
}

export interface ChatEvent {
  raw: string;
  ansi?: string;
  json?: unknown;
  timestamp: number;
}

export interface FractalBotEvents {
  phase: (phase: BotPhase) => void;
  connecting: (info: { host: string; port: number; username: string }) => void;
  connected: () => void;
  spawned: (dump: WorldDump) => void;
  authenticated: () => void;
  chat: (event: ChatEvent) => void;
  kicked: (reason: string) => void;
  disconnected: (reason?: string) => void;
  error: (error: Error) => void;
  status: (status: BotStatus) => void;
  portalFound: (portal: PortalTarget) => void;
  portalEntered: (info: { kind: PortalKind; count: number }) => void;
  lobbyRetry: (info: { inMs: number; reason: string }) => void;
  worldKind: (kind: WorldKind) => void;
}

export type ControlRequest =
  | { action: "join"; options?: JoinOptions }
  | { action: "leave"; reason?: string }
  | { action: "reconnect" }
  | { action: "chat"; message: string }
  | { action: "command"; command: string }
  | { action: "goto"; x: number; y: number; z: number; range?: number }
  | { action: "lookAt"; x: number; y: number; z: number }
  | { action: "look"; yaw?: number; pitch?: number; x?: number; y?: number; z?: number; force?: boolean }
  | { action: "turn"; yaw?: number; pitch?: number }
  | { action: "control"; state: Partial<ControlState> }
  | { action: "jump" }
  | { action: "stop" }
  | { action: "attack"; username?: string }
  | { action: "dig"; x?: number; y?: number; z?: number }
  | { action: "stopDig" }
  | { action: "place"; x?: number; y?: number; z?: number; face?: PlaceFace }
  | { action: "activate"; x?: number; y?: number; z?: number }
  | { action: "swing" }
  | { action: "respawn" }
  | { action: "status" }
  | { action: "players" }
  | { action: "entities" }
  | { action: "inventory" }
  | ({ action: "inv" } & InvCommand)
  | { action: "dump" }
  | { action: "view"; radius?: number; map?: boolean }
  | { action: "voxels"; radius?: number }
  | { action: "map"; radius?: number }
  | { action: "block"; x: number; y: number; z: number }
  | { action: "cursor" }
  | { action: "hunt" }
  | { action: "unhunt" }
  | { action: "set"; autoReconnect?: boolean; autoLobby?: boolean }
  | { action: "catalog" };

export interface ControlResponse {
  ok: boolean;
  error?: string;
  data?: unknown;
}

export interface LiveBot {
  raw: Bot;
  position(): Vec3 | undefined;
}
