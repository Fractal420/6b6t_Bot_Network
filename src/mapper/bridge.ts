import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { Bot } from "mineflayer";
import { log } from "../logger.ts";

const require = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { createFractalMapperHost } = require(path.join(root, "mapper-lib/host.js")) as {
  createFractalMapperHost: (opts: Record<string, unknown>) => MapperHost;
};

export interface MapperStatus {
  active: boolean;
  mapping: Record<string, unknown>;
  recorder: Record<string, unknown> | null;
  output: {
    dir: string;
    regionsDir: string;
    regionFiles: number;
    tiles: number;
  };
  memory: { rssMb: number; heapMb: number };
  config: Record<string, unknown>;
}

export interface MapperHost {
  start: (mode?: string) => string;
  stop: () => string;
  onDeath: () => void;
  onMainServer: () => void;
  ensureBotHooks: () => boolean;
  setMappingConfig: (partial: Record<string, unknown>) => void;
  status: () => MapperStatus;
  isActive: () => boolean;
}

export interface MapperBridgeOptions {
  getBot: () => Bot | null;
  outputDir?: string;
  mapping?: Record<string, unknown>;
  onRegion?: (info: Record<string, unknown>) => void;
}

export function createMapperBridge(options: MapperBridgeOptions): MapperHost {
  const outputDir = options.outputDir || path.join(root, "output");
  const host = createFractalMapperHost({
    getBot: options.getBot,
    log: (msg: string) => log.info(String(msg)),
    outputDir,
    mapping: options.mapping || {},
    onRegion: options.onRegion,
  });
  return host;
}
