/**
 * Per-profile home name lists on disk (not in the browser).
 * Path: Settings/homes/<profileId>.json
 */
import fs from "node:fs";
import path from "node:path";
import { settingsDir } from "./store.ts";
import { log } from "../logger.ts";

export interface HomesFile {
  version: 2;
  /** Stable profile id from Settings/Profiles */
  profileId: string;
  username?: string;
  homes: string[];
  updatedAt: string;
}

function homesDir(): string {
  return path.join(settingsDir(), "homes");
}

function safeStem(id: string): string {
  return String(id || "unknown")
    .trim()
    .replace(/[^\w.\-]+/g, "_")
    .slice(0, 80) || "unknown";
}

function profileFile(profileId: string): string {
  return path.join(homesDir(), `${safeStem(profileId)}.json`);
}

/** Legacy path used before homes were keyed by profile id. */
function legacyUsernameFile(username: string): string {
  return path.join(homesDir(), `${safeStem(username)}.json`);
}

function readHomesArray(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<HomesFile> & { homes?: unknown };
  if (!Array.isArray(raw.homes)) return [];
  return raw.homes
    .map((h) => String(h || "").trim())
    .filter((h) => h && !h.includes(" ") && h.length <= 48);
}

/**
 * Load homes for a profile. Falls back once to legacy username file if present.
 */
export function loadHomes(profileId: string, username?: string): string[] {
  const id = String(profileId || "").trim();
  if (!id) return [];
  try {
    const primary = profileFile(id);
    if (fs.existsSync(primary)) return readHomesArray(primary);
    // One-time migration from Settings/homes/<username>.json
    if (username) {
      const legacy = legacyUsernameFile(username);
      if (fs.existsSync(legacy) && path.resolve(legacy) !== path.resolve(primary)) {
        const list = readHomesArray(legacy);
        if (list.length) {
          saveHomes(id, list, username);
          return list;
        }
      }
    }
    return [];
  } catch (err) {
    log.warn("loadHomes failed", { id, err: err instanceof Error ? err.message : err });
    return [];
  }
}

/** Replace the full list for this profile and write to disk. */
export function saveHomes(profileId: string, homes: string[], username?: string): string[] {
  const id = String(profileId || "").trim();
  const cleaned = [...new Set(
    homes
      .map((h) => String(h || "").trim())
      .filter((h) => h && !h.includes(" ") && h.length <= 48 && !/^(cancel|close|back|exit)$/i.test(h)),
  )].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));

  if (!id) return cleaned;

  const file = profileFile(id);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
    const doc: HomesFile = {
      version: 2,
      profileId: id,
      username: username ? String(username).trim() : undefined,
      homes: cleaned,
      updatedAt: new Date().toISOString(),
    };
    fs.writeFileSync(file, JSON.stringify(doc, null, 2) + "\n", { encoding: "utf8", mode: 0o600 });
  } catch (err) {
    log.warn("saveHomes failed", { id, err: err instanceof Error ? err.message : err });
  }
  return cleaned;
}
