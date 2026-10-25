import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer, type WebSocket } from "ws";
import type { FractalBot } from "./FractalBot.ts";
import type { ControlRequest, ControlResponse, JoinOptions } from "./types.ts";
import { apiCatalog } from "./catalog.ts";
import { log } from "../logger.ts";
import type { FleetManager } from "../fleet/FleetManager.ts";
import {
  MAX_BODY_BYTES,
  authorized,
  clampChat,
  clientAllowed,
  cookieHeader,
  isJsonContentType,
  securityHeaders,
} from "./security.ts";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../web");
const DASHBOARD: Record<string, { file: string; type: string }> = {
  "/": { file: "index.html", type: "text/html; charset=utf-8" },
  "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
  "/app.css": { file: "app.css", type: "text/css; charset=utf-8" },
  "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
  "/survey.js": { file: "survey.js", type: "text/javascript; charset=utf-8" },
  "/sw.js": { file: "sw.js", type: "text/javascript; charset=utf-8" },
  "/manifest.webmanifest": { file: "manifest.webmanifest", type: "application/manifest+json; charset=utf-8" },
};

export interface ControlServer {
  url: string;
  close(): Promise<void>;
}

export function startControlServer(
  fleet: FleetManager,
  host: string,
  port: number,
  token: string,
): Promise<ControlServer> {
  const sockets = new Set<WebSocket>();

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}:${port}`);
    if (!clientAllowed(req, port)) {
      res.writeHead(403, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "forbidden" }));
      return;
    }
    if (req.method === "GET" && serveDashboard(url.pathname, res, token)) return;
    if (req.method === "GET" && url.pathname === "/health") {
      return json(res, { ok: true, data: { status: "up" } });
    }

    if (!authorized(req, token)) {
      res.writeHead(401, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "unauthorized" }));
      return;
    }

    if (req.method === "GET" && (url.pathname === "/v1" || url.pathname === "/v1/catalog")) {
      return json(res, { ok: true, data: apiCatalog() });
    }

    if (req.method === "GET" && url.pathname === "/v1/status") {
      const primary = fleet.resolveBot(null);
      return json(res, {
        ok: true,
        data: primary ? primary.getStatus() : { phase: "idle", connected: false, fleet: fleet.getFleetStatus() },
      });
    }
    if (req.method === "GET" && url.pathname === "/v1/fleet") {
      return json(res, { ok: true, data: fleet.getFleetStatus() });
    }
    const getBot = () => fleet.resolveBot(url.searchParams.get("botId"));
    if (req.method === "GET" && url.pathname === "/v1/players") {
      return json(res, wrap(() => getBot()!.getPlayers()));
    }
    if (req.method === "GET" && url.pathname === "/v1/inventory") {
      return json(res, wrap(() => getBot()!.getInventory()));
    }
    if (req.method === "GET" && url.pathname === "/v1/dump") {
      return json(res, wrap(() => getBot()!.dump()));
    }
    if (req.method === "GET" && url.pathname === "/v1/voxels") {
      return json(res, wrap(() => getBot()!.getVoxels(Number(url.searchParams.get("r") ?? "20"))));
    }
    if (req.method === "GET" && url.pathname === "/v1/view") {
      return json(
        res,
        wrap(() =>
          getBot()!.getView(Number(url.searchParams.get("r") ?? "20"), truthy(url.searchParams.get("map"))),
        ),
      );
    }
    if (req.method === "GET" && url.pathname === "/v1/map") {
      return json(res, wrap(() => getBot()!.getMap(Number(url.searchParams.get("r") ?? "24"))));
    }
    if (req.method === "GET" && url.pathname === "/v1/block") {
      const x = Number(url.searchParams.get("x"));
      const y = Number(url.searchParams.get("y"));
      const z = Number(url.searchParams.get("z"));
      if (![x, y, z].every(Number.isFinite)) return json(res, { ok: false, error: "block needs x y z" }, 400);
      return json(res, wrap(() => getBot()!.getBlock(x, y, z)));
    }
    if (req.method === "GET" && url.pathname === "/v1/cursor") {
      return json(res, wrap(() => getBot()!.getLook()));
    }
    if (req.method === "GET" && url.pathname === "/v1/entities") {
      return json(res, wrap(() => getBot()!.getEntities()));
    }

    if (req.method !== "POST") {
      res.writeHead(404, securityHeaders({ "content-type": "application/json" }));
      res.end(JSON.stringify({ ok: false, error: "not found" }));
      return;
    }

    if (!isJsonContentType(req)) {
      return json(res, { ok: false, error: "content-type must be application/json" }, 415);
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch (error) {
      const tooLarge = error instanceof Error && error.message === "payload too large";
      return json(res, { ok: false, error: tooLarge ? "payload too large" : "bad request" }, tooLarge ? 413 : 400);
    }
    let payload: ControlRequest | undefined;
    try {
      payload = body ? (JSON.parse(body) as ControlRequest) : undefined;
    } catch {
      return json(res, { ok: false, error: "invalid json" }, 400);
    }

    if (url.pathname === "/v1/rpc") {
      const result = await dispatch(fleet, payload);
      return json(res, result, result.ok ? 200 : 400);
    }

    const action = url.pathname.replace(/^\/v1\//, "") as ControlRequest["action"];
    const merged = { ...(payload ?? {}), action } as ControlRequest;
    const result = await dispatch(fleet, merged);
    return json(res, result, result.ok ? 200 : 400);
  });

  const wss = new WebSocketServer({ server, path: "/v1/events" });
  wss.on("connection", (socket, req) => {
    if (!clientAllowed(req, port) || !authorized(req, token)) {
      socket.close(1008, "unauthorized");
      return;
    }
    sockets.add(socket);
    const primary = fleet.resolveBot(null);
    socket.send(JSON.stringify({ event: "fleet", data: fleet.getFleetStatus() }));
    if (primary) socket.send(JSON.stringify({ event: "status", data: primary.getStatus() }));
    socket.on("close", () => sockets.delete(socket));
  });

  const forward = (event: string, data: unknown) => {
    const message = JSON.stringify({ event, data });
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(message);
    }
  };

  fleet.on("fleet", (data) => forward("fleet", data));
  fleet.on("botEvent", (payload: { id: string; event: string; args: unknown[] }) => {
    const data = payload.args[0];
    if (payload.event === "error") {
      const err = data as Error;
      forward(payload.event, {
        botId: payload.id,
        message: err?.message,
      });
      return;
    }
    if (payload.event === "kicked" && data && typeof data === "object") {
      forward("kicked", { botId: payload.id, ...(data as object) });
      return;
    }
    if (payload.event === "status") {
      forward("status", data);
      forward("fleet", fleet.getFleetStatus());
      return;
    }
    forward(payload.event, data);
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const url = `http://${host}:${port}`;
      log.info(`Dashboard ${url}  ·  API POST /v1/rpc  GET /v1/status  WS /v1/events`);
      resolve({
        url,
        close() {
          return new Promise((resClose) => {
            for (const socket of sockets) socket.close();
            wss.close();
            server.close(() => resClose());
          });
        },
      });
    });
  });
}

function serveDashboard(pathname: string, res: http.ServerResponse, token: string): boolean {
  const asset = DASHBOARD[pathname];
  if (!asset) return false;
  const webRoot = path.resolve(WEB_DIR);
  const full = path.resolve(webRoot, asset.file);
  const rel = path.relative(webRoot, full);
  if (rel.startsWith("..") || path.isAbsolute(rel)) return false;
  try {
    const body = fs.readFileSync(full);
    const headers: Record<string, string> = {
      ...securityHeaders({ "content-type": asset.type }),
    };
    if (asset.file === "index.html") headers["set-cookie"] = cookieHeader(token);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    res.writeHead(404, securityHeaders({ "content-type": "text/plain; charset=utf-8" }));
    res.end("dashboard file missing");
  }
  return true;
}

function json(res: http.ServerResponse, body: ControlResponse, status = 200): void {
  res.writeHead(status, securityHeaders({ "content-type": "application/json" }));
  res.end(JSON.stringify(body));
}

function wrap<T>(fn: () => T): ControlResponse {
  try {
    return { ok: true, data: fn() };
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function truthy(value: string | null): boolean {
  if (!value) return false;
  return value === "1" || value === "true" || value === "yes";
}

async function dispatch(fleet: FleetManager, request?: ControlRequest): Promise<ControlResponse> {
  if (!request?.action) return { ok: false, error: "missing action" };
  try {
    // Fleet management
    if (request.action === "fleetStatus") {
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetAccounts") {
      return { ok: true, data: { accounts: fleet.listAccounts(), path: fleet.getFleetStatus().accountsPath } };
    }
    if (request.action === "fleetAddAccount") {
      const acc = fleet.addOrUpdateAccount(request.account);
      return { ok: true, data: acc };
    }
    if (request.action === "fleetRemoveAccount") {
      fleet.deleteAccount(request.id);
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetStart") {
      const msg = await fleet.startBot(request.id);
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetStop") {
      const msg = await fleet.stopBot(request.id);
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetStartAll") {
      const results = await fleet.startAllEnabled();
      return { ok: true, data: { results, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetStopAll") {
      await fleet.stopAll();
      return { ok: true, data: fleet.getFleetStatus() };
    }
    if (request.action === "fleetSetTask") {
      const msg = await fleet.setTask(request.id, request.task, request.taskOptions);
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetSetFeatures") {
      const msg = await fleet.setFeatures(request.id, request.features || {});
      return { ok: true, data: { result: msg, fleet: fleet.getFleetStatus() } };
    }
    if (request.action === "fleetSetAnnouncements") {
      fleet.setDefaultAnnouncements(request.announcements || []);
      return { ok: true, data: { defaultAnnouncements: fleet.getDefaultAnnouncements() } };
    }

    const botId = (request as { botId?: string }).botId || fleet.defaultBotId();
    const bot = fleet.resolveBot(botId);
    if (!bot) {
      return {
        ok: false,
        error: "No bot running. Add an account and fleetStart it, or fleetStartAll.",
      };
    }

    switch (request.action) {
      case "join":
        await bot.join(safeJoinOptions(request.options));
        return { ok: true, data: bot.getStatus() };
      case "leave":
        await bot.leave(request.reason);
        return { ok: true, data: bot.getStatus() };
      case "reconnect":
        await bot.reconnect();
        return { ok: true, data: bot.getStatus() };
      case "chat":
        bot.chat(clampChat(request.message ?? ""));
        return { ok: true };
      case "command":
        bot.runCommand(clampChat(request.command ?? ""));
        return { ok: true };
      case "goto":
        bot.goto(request.x, request.y, request.z, request.range);
        return { ok: true };
      case "lookAt":
        await bot.lookAt(request.x, request.y, request.z);
        return { ok: true, data: bot.getLook() };
      case "look":
        return {
          ok: true,
          data: await bot.look({
            yaw: request.yaw,
            pitch: request.pitch,
            x: request.x,
            y: request.y,
            z: request.z,
            force: request.force,
          }),
        };
      case "turn":
        return { ok: true, data: await bot.turn(request.yaw ?? 0, request.pitch ?? 0) };
      case "control":
        bot.setControl(request.state);
        return { ok: true, data: bot.getStatus().control };
      case "jump":
        bot.jump();
        return { ok: true };
      case "stop":
        bot.stopMovement();
        return { ok: true };
      case "attack":
        bot.attack(request.username);
        return { ok: true };
      case "dig":
        return { ok: true, data: await bot.dig(request.x, request.y, request.z) };
      case "stopDig":
        bot.stopDig();
        return { ok: true };
      case "place":
        await bot.place(request.x, request.y, request.z, request.face);
        return { ok: true };
      case "activate":
        await bot.activate(request.x, request.y, request.z);
        return { ok: true };
      case "swing":
        bot.swing();
        return { ok: true };
      case "respawn":
        bot.respawn();
        return { ok: true };
      case "status":
        return { ok: true, data: bot.getStatus() };
      case "players":
        return { ok: true, data: bot.getPlayers() };
      case "entities":
        return { ok: true, data: bot.getEntities() };
      case "inventory":
        return { ok: true, data: bot.getInventory() };
      case "inv":
        return { ok: true, data: await bot.manageInventory(request) };
      case "dump":
        return { ok: true, data: bot.dump() };
      case "view":
        return { ok: true, data: bot.getView(request.radius, request.map) };
      case "voxels":
        return { ok: true, data: bot.getVoxels(request.radius) };
      case "map":
        return { ok: true, data: bot.getMap(request.radius) };
      case "block":
        return { ok: true, data: bot.getBlock(request.x, request.y, request.z) };
      case "cursor":
        return { ok: true, data: bot.getLook() };
      case "hunt":
        bot.startPortalHunt();
        return { ok: true, data: bot.getStatus() };
      case "unhunt":
        bot.stopPortalHunt();
        return { ok: true, data: bot.getStatus() };
      case "mapStart": {
        const result = bot.startMapping(request.mode);
        return { ok: true, data: { result, status: bot.getMappingStatus() } };
      }
      case "mapStop": {
        const result = bot.stopMapping();
        return { ok: true, data: { result, status: bot.getMappingStatus() } };
      }
      case "mapStatus":
        return { ok: true, data: bot.getMappingStatus() };
      case "mapConfig":
        if (request.mapping) bot.setMappingConfig(request.mapping);
        return { ok: true, data: bot.getMappingStatus() };
      case "getSettings": {
        const { getSettingsSnapshot } = await import("../config.ts");
        return { ok: true, data: getSettingsSnapshot() };
      }
      case "saveSettings": {
        const { saveSettingsValues, reloadConfigFromEnv, getSettingsSnapshot, SETTINGS_FIELDS } = await import(
          "../config.ts"
        );
        const values = (request as { values?: Record<string, string> }).values || {};
        const result = saveSettingsValues(values);
        const next = reloadConfigFromEnv();
        fleet.applyBaseConfig(next);
        const restartKeys = SETTINGS_FIELDS.filter((f) => f.restart && result.saved.includes(f.key)).map((f) => f.key);
        return {
          ok: true,
          data: {
            ...result,
            restartRequired: restartKeys.length > 0,
            restartKeys,
            settings: getSettingsSnapshot(),
          },
        };
      }
      case "set":
        bot.setFlags({ autoReconnect: request.autoReconnect, autoLobby: request.autoLobby });
        return { ok: true, data: bot.getStatus() };
      case "catalog":
        return { ok: true, data: apiCatalog() };
      default:
        return { ok: false, error: `unknown action ${(request as { action: string }).action}` };
    }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) };
  }
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      if (err) reject(err);
      else resolve(Buffer.concat(chunks).toString("utf8"));
    };
    req.on("data", (chunk) => {
      const buf = Buffer.from(chunk);
      size += buf.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        finish(new Error("payload too large"));
        return;
      }
      chunks.push(buf);
    });
    req.on("end", () => finish());
    req.on("error", (err) => finish(err instanceof Error ? err : new Error(String(err))));
  });
}

function safeJoinOptions(options?: JoinOptions): JoinOptions {
  return {
    autoLobby: options?.autoLobby,
    autoReconnect: options?.autoReconnect,
  };
}
