'use strict';
/**
 * Fractal host for the Argus/Elytra spawn mapper.
 * Uses Fractal's already-connected mineflayer bot instead of the standalone connection manager.
 */
const path = require('path');
const fs = require('fs');
const { createSpawnMapper } = require('./mapper');
const { createRecorder } = require('./recorder');
const { createWriter } = require('./xaero-writer');
const { createOutput } = require('./output');
const { attachChunkPrune } = require('./chunk-prune');
const { blockAllowed } = require('./regions');
const Vec3 = require('vec3');

const RENDER_RADIUS_BLOCKS = 56;

/**
 * @param {object} opts
 * @param {() => import('mineflayer').Bot | null} opts.getBot
 * @param {(msg: string) => void} opts.log
 * @param {string} opts.outputDir
 * @param {object} [opts.mapping]
 * @param {object} [opts.limits]
 * @param {object} [opts.output]
 * @param {object} [opts.memory]
 * @param {(info: object) => void} [opts.onRegion]
 * @param {(status: object) => void} [opts.onStatus]
 */
function createFractalMapperHost(opts) {
  const log = opts.log || console.log;
  const outputDir = path.resolve(opts.outputDir || './output');
  fs.mkdirSync(outputDir, { recursive: true });

  const mapping = {
    mode: 'box',
    homeName: 'spawn',
    noHomeRadius: 5000,
    homeCooldownSec: 315,
    skipSpawnRegions: true,
    box: { x1: 20000, z1: 20000, x2: 24000, z2: 24000 },
    boxes: [],
    ...(opts.mapping || {}),
  };
  const limits = { maxAbsBlock: 150000, ...(opts.limits || {}) };
  const outputCfg = {
    dimension: 'overworld',
    regions: true,
    tiles: false,
    flushIdleSec: 60,
    evictIdleSec: 300,
    ...(opts.output || {}),
  };
  const memory = {
    pruneChunks: true,
    keepChunks: 18,
    pruneEverySec: 5,
    ...(opts.memory || {}),
  };

  const guard = {
    skipSpawnRegions: mapping.skipSpawnRegions,
    maxAbsBlock: limits.maxAbsBlock,
  };

  const output = createOutput(outputDir, {
    tiles: outputCfg.tiles,
    dimension: outputCfg.dimension,
  });
  const writer = outputCfg.regions
    ? createWriter({ outDir: output.regionsDir, dimension: outputCfg.dimension })
    : null;

  let pruneAttached = false;
  let recorderAttachedBot = null;

  const recorder = writer
    ? createRecorder({
        writer,
        guard,
        dimension: outputCfg.dimension,
        log,
        canRecord: () => {
          const bot = opts.getBot();
          return !!(bot && bot.entity && bot.hp && bot.hp.isOnMainServer);
        },
        flushIdleMs: (outputCfg.flushIdleSec || 60) * 1000,
        evictIdleMs: (outputCfg.evictIdleSec || 300) * 1000,
        onRegion: (r) => {
          if (opts.onRegion) opts.onRegion(r);
        },
      })
    : null;

  const getTargetBoxes = () => {
    if (mapping.boxes && mapping.boxes.length) return mapping.boxes;
    if (mapping.box) return [mapping.box];
    return [];
  };

  const mapper = createSpawnMapper({
    getBot: () => opts.getBot(),
    sendLog: log,
    debugLog: (m) => log(`[mapper-debug] ${m}`),
    Vec3,
    renderMappingPng: (bot, radius) => {
      const p = bot.entity.position;
      const cx = Math.round(p.x);
      const cz = Math.round(p.z);
      if (outputCfg.tiles) {
        return require('./render').generateMappingRender(bot, cx, cz, radius);
      }
      const c0x = (cx - radius) >> 4;
      const c1x = (cx + radius) >> 4;
      const c0z = (cz - radius) >> 4;
      const c1z = (cz + radius) >> 4;
      let found = 0;
      let total = 0;
      for (let x = c0x; x <= c1x; x++) {
        for (let z = c0z; z <= c1z; z++) {
          total++;
          if (bot.world.getColumn(x, z)) found++;
        }
      }
      return {
        pngBuffer: null,
        centerX: cx,
        centerZ: cz,
        radius,
        span: radius * 2 + 1,
        pixelSize: 0,
        found,
        total,
      };
    },
    saveTile: output.saveTile,
    loadCoveredCells: output.loadCoveredCells,
    canRun: () => true,
    stateFile: path.join(outputDir, 'mapper-state.json'),
    getTargetBoxes,
    waypointFilter: (x, z) => blockAllowed(x, z, guard),
    mapConfig: {
      homeName: mapping.homeName,
      noHomeRadius: mapping.noHomeRadius,
      homeCooldownSec: mapping.homeCooldownSec,
    },
  });

  function ensureBotHooks() {
    const bot = opts.getBot();
    if (!bot) return false;
    // Mapper expects bot.hp.isOnMainServer (from Elytra connection manager)
    if (!bot.hp) bot.hp = {};
    bot.hp.isOnMainServer = true;

    if (recorder && recorderAttachedBot !== bot) {
      try {
        recorder.attach(bot);
        recorderAttachedBot = bot;
      } catch (e) {
        log(`recorder attach failed: ${e.message}`);
      }
    }
    if (memory.pruneChunks && !pruneAttached) {
      try {
        attachChunkPrune(bot, log, {
          keep: memory.keepChunks,
          everyMs: (memory.pruneEverySec || 5) * 1000,
        });
        pruneAttached = true;
      } catch (e) {
        log(`chunk prune attach failed: ${e.message}`);
      }
    }
    return true;
  }

  function start(mode) {
    ensureBotHooks();
    const m = String(mode || mapping.mode || 'box').toLowerCase();
    if ((m === 'box' || m === 'boxes') && !getTargetBoxes().length && !String(m).startsWith('box:')) {
      // box mode with default box still works via mapping.box
    }
    const res = mapper.start(m);
    log(`mapper start (${m}): ${res}`);
    return res;
  }

  function stop() {
    const res = mapper.stop();
    log(`mapper stop: ${res}`);
    return res;
  }

  function onDeath() {
    try {
      mapper.onDeath();
    } catch {
      /* ignore */
    }
  }

  function onMainServer() {
    ensureBotHooks();
    if (mapper.isActive()) return;
    const persisted = mapper.wasEnabled();
    if (persisted && persisted.enabled) {
      const mode = persisted.rotating ? 'rotate' : persisted.mode;
      log(`resuming previous mapping run: ${start(mode)}`);
    }
  }

  function setMappingConfig(partial) {
    Object.assign(mapping, partial || {});
  }

  function status() {
    const mem = process.memoryUsage();
    return {
      active: mapper.isActive(),
      mapping: mapper.status(),
      recorder: recorder ? recorder.stats() : null,
      output: {
        dir: outputDir,
        regionsDir: output.regionsDir,
        regionFiles: output.regionFileCount(),
        tiles: outputCfg.tiles ? output.count() : 0,
      },
      memory: {
        rssMb: Math.round(mem.rss / 1048576),
        heapMb: Math.round(mem.heapUsed / 1048576),
      },
      config: {
        mode: mapping.mode,
        homeName: mapping.homeName,
        box: mapping.box,
        boxes: mapping.boxes,
      },
    };
  }

  return {
    start,
    stop,
    onDeath,
    onMainServer,
    ensureBotHooks,
    setMappingConfig,
    status,
    isActive: () => mapper.isActive(),
  };
}

module.exports = { createFractalMapperHost, RENDER_RADIUS_BLOCKS };
