/**
 * Per-server hunt configuration persistence.
 *
 * Path: `Settings/hunt/<server>/config.json`. Config is keyed by the server the bot points at, so moving
 * between anarchy servers does not carry one server's route/category choices into another. Writes are
 * atomic (temp file + rename) and a corrupt file is ignored rather than blocking startup — a bad config
 * must never stop the addon loading.
 */
import fs from "node:fs";
import path from "node:path";
import { settingsDir } from "./store.ts";
import { log } from "../logger.ts";
import { DEFAULT_HUNT_CONFIG, type HuntConfig } from "../hunt/controller.ts";
import { safeServerName } from "../hunt/database.ts";

interface ConfigFile {
  version: 1;
  server: string;
  updatedAt: number;
  config: Partial<HuntConfig>;
}

function configFile(server: string, root?: string): string {
  return path.join(root ?? settingsDir(), "hunt", safeServerName(server), "config.json");
}

/** Loads a stored hunt config, merged over the defaults. Returns the defaults on any failure. */
export function loadHuntConfig(server: string, root?: string): HuntConfig {
  const file = configFile(server, root);
  try {
    if (!fs.existsSync(file)) return { ...DEFAULT_HUNT_CONFIG };
    const raw = JSON.parse(fs.readFileSync(file, "utf8")) as Partial<ConfigFile>;
    const stored = raw?.config && typeof raw.config === "object" ? raw.config : {};
    // Nested objects (survival thresholds, flight config, mending weights) are merged one level deep so a
    // partial save does not drop the fields it did not mention.
    return {
      ...DEFAULT_HUNT_CONFIG,
      ...stored,
      survival: { ...DEFAULT_HUNT_CONFIG.survival, ...(stored.survival ?? {}) },
      flight: { ...DEFAULT_HUNT_CONFIG.flight, ...(stored.flight ?? {}) },
      mendingWeights: { ...DEFAULT_HUNT_CONFIG.mendingWeights, ...(stored.mendingWeights ?? {}) },
    };
  } catch (err) {
    log.warn("loadHuntConfig failed", { server, err: err instanceof Error ? err.message : err });
    return { ...DEFAULT_HUNT_CONFIG };
  }
}

/** Writes a hunt config atomically. A failure is logged, never thrown. */
export function saveHuntConfig(server: string, config: HuntConfig, root?: string): void {
  const file = configFile(server, root);
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const doc: ConfigFile = { version: 1, server, updatedAt: Date.now(), config };
    const tmp = `${file}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), "utf8");
    fs.renameSync(tmp, file);
  } catch (err) {
    log.warn("saveHuntConfig failed", { server, err: err instanceof Error ? err.message : err });
  }
}
