import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type http from "node:http";
import type { FractalConfig } from "../config.ts";
import { upsertEnvVar } from "../config.ts";
import { log } from "../logger.ts";

export const MAX_BODY_BYTES = 256 * 1024;
export const MAX_CHAT_CHARS = 256;
export const COOKIE_NAME = "fractal_token";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "0:0:0:0:0:0:0:1"]);

export function isLoopbackHost(host: string): boolean {
  const h = host.trim().toLowerCase().replace(/^\[|\]$/g, "");
  return LOOPBACK_HOSTS.has(h);
}

export function isLoopbackAddress(addr?: string | null): boolean {
  if (!addr) return false;
  const h = addr.replace(/^::ffff:/i, "");
  return isLoopbackHost(h);
}

export function assertSafeControlBind(config: FractalConfig): void {
  const expose = process.env.FRACTAL_CONTROL_EXPOSE === "1";
  if (isLoopbackHost(config.controlHost)) return;
  if (expose) {
    log.warn(`Control API is exposed on ${config.controlHost} (FRACTAL_CONTROL_EXPOSE=1)`);
    return;
  }
  throw new Error(
    `Refusing to bind the control API on ${config.controlHost}. Keep FRACTAL_CONTROL_HOST=127.0.0.1, or set FRACTAL_CONTROL_EXPOSE=1 if you really mean it.`,
  );
}

export function ensureControlToken(config: FractalConfig): string {
  const existing = config.controlToken.trim();
  if (existing.length >= 16) return existing;
  const token = randomBytes(32).toString("hex");
  upsertEnvVar("FRACTAL_CONTROL_TOKEN", token);
  log.info("Generated FRACTAL_CONTROL_TOKEN and wrote it to .env (loopback API now requires this token)");
  return token;
}

export function hardenControlConfig(config: FractalConfig): FractalConfig {
  assertSafeControlBind(config);
  return { ...config, controlToken: ensureControlToken(config) };
}

export function tokenMatches(provided: string | undefined, expected: string): boolean {
  if (!provided || !expected) return false;
  const a = createHash("sha256").update(provided).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

export function parseCookies(header?: string | string[]): Record<string, string> {
  const raw = Array.isArray(header) ? header.join("; ") : header;
  if (!raw) return {};
  const out: Record<string, string> = {};
  for (const part of raw.split(";")) {
    const idx = part.indexOf("=");
    if (idx <= 0) continue;
    const key = part.slice(0, idx).trim();
    const value = part.slice(idx + 1).trim();
    try {
      out[key] = decodeURIComponent(value);
    } catch {
      out[key] = value;
    }
  }
  return out;
}

function headerString(value: string | string[] | undefined): string {
  if (!value) return "";
  return Array.isArray(value) ? value[0] ?? "" : value;
}

function hostName(header: string): string {
  const trimmed = header.trim().toLowerCase();
  if (trimmed.startsWith("[")) {
    const end = trimmed.indexOf("]");
    return end >= 0 ? trimmed.slice(1, end) : trimmed;
  }
  return trimmed.split(":")[0] ?? trimmed;
}

function originAllowed(origin: string, port: number): boolean {
  try {
    const url = new URL(origin);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    if (!isLoopbackHost(url.hostname)) return false;
    const originPort = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
    return originPort === port;
  } catch {
    return false;
  }
}

export function clientAllowed(req: http.IncomingMessage, port: number): boolean {
  const remote = req.socket.remoteAddress;
  if (!isLoopbackAddress(remote) && process.env.FRACTAL_CONTROL_EXPOSE !== "1") {
    return false;
  }

  const host = hostName(headerString(req.headers.host));
  if (!host || !isLoopbackHost(host)) {
    if (process.env.FRACTAL_CONTROL_EXPOSE === "1") return true;
    return false;
  }

  const origin = headerString(req.headers.origin);
  if (origin && !originAllowed(origin, port)) return false;
  return true;
}

export function authorized(req: http.IncomingMessage, token: string): boolean {
  const auth = headerString(req.headers.authorization);
  const candidates = [
    auth.startsWith("Bearer ") ? auth.slice(7) : auth || undefined,
    parseCookies(req.headers.cookie)[COOKIE_NAME],
  ];
  return candidates.some((value) => tokenMatches(value, token));
}

export function isJsonContentType(req: http.IncomingMessage): boolean {
  const raw = headerString(req.headers["content-type"]).toLowerCase();
  return raw.startsWith("application/json");
}

export function redactSecrets(text: string): string {
  return text.replace(/(^|[^\w])(\/?(?:login|register|changepassword|l))\s+\S+(?:\s+\S+)?/gi, "$1$2 ***");
}

export function stripCtl(text: string): string {
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]|\u001b\][^\u0007]*\u0007/g, "").replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "");
}

export function cookieHeader(token: string): string {
  return `${COOKIE_NAME}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=2592000`;
}

export function securityHeaders(extra: Record<string, string> = {}): Record<string, string> {
  return {
    "x-content-type-options": "nosniff",
    "x-frame-options": "DENY",
    "referrer-policy": "no-referrer",
    "cache-control": "no-store",
    "content-security-policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self' ws: wss:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'",
    ...extra,
  };
}

export function clampChat(text: string): string {
  return text.slice(0, MAX_CHAT_CHARS);
}
