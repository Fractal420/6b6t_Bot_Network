(() => {
  const stub = {
    setField() {},
    setBot() {},
    setPlayers() {},
    isFlying() {
      return false;
    },
    ownsKeys() {
      return false;
    },
    radius: 20,
  };
  const canvas = document.getElementById("world3d");
  const root = document.getElementById("survey");
  const metaEl = document.getElementById("survey-meta");
  const hudEl = document.getElementById("survey-hud");
  const compassEl = document.getElementById("survey-compass");
  if (!canvas || !(canvas instanceof HTMLCanvasElement)) {
    window.fractalSurvey = stub;
    return;
  }

  const gl = canvas.getContext("webgl2", { antialias: true, alpha: false });
  if (!gl) {
    if (metaEl) metaEl.textContent = "webgl2 missing";
    window.fractalSurvey = stub;
    return;
  }

  try {

  const DYES = {
    white: [0.92, 0.93, 0.94],
    orange: [0.9, 0.48, 0.12],
    magenta: [0.72, 0.28, 0.72],
    light_blue: [0.42, 0.68, 0.85],
    yellow: [0.94, 0.78, 0.16],
    lime: [0.52, 0.78, 0.12],
    pink: [0.9, 0.55, 0.66],
    gray: [0.38, 0.38, 0.4],
    light_gray: [0.62, 0.62, 0.64],
    cyan: [0.16, 0.58, 0.62],
    purple: [0.48, 0.22, 0.62],
    blue: [0.22, 0.28, 0.68],
    brown: [0.45, 0.28, 0.16],
    green: [0.32, 0.48, 0.14],
    red: [0.72, 0.18, 0.16],
    black: [0.12, 0.12, 0.14],
  };
  const BLOCKS = {
    stone: [0.56, 0.56, 0.56],
    cobblestone: [0.52, 0.52, 0.52],
    deepslate: [0.23, 0.23, 0.25],
    cobbled_deepslate: [0.26, 0.26, 0.28],
    obsidian: [0.06, 0.03, 0.1],
    crying_obsidian: [0.07, 0.02, 0.11],
    bedrock: [0.16, 0.16, 0.18],
    netherrack: [0.7, 0.28, 0.27],
    nether_bricks: [0.31, 0.11, 0.11],
    end_stone: [0.87, 0.84, 0.58],
    grass_block: [0.36, 0.66, 0.19],
    dirt: [0.54, 0.36, 0.2],
    sand: [0.87, 0.81, 0.49],
    sandstone: [0.78, 0.72, 0.5],
    gravel: [0.5, 0.48, 0.46],
    water: [0.18, 0.38, 0.72],
    lava: [0.92, 0.32, 0.08],
    magma_block: [0.72, 0.22, 0.1],
    nether_portal: [0.62, 0.22, 0.92],
    end_portal: [0.04, 0.02, 0.07],
    glowstone: [0.95, 0.78, 0.35],
    glass: [0.7, 0.82, 0.86],
    oak_planks: [0.62, 0.48, 0.26],
    oak_log: [0.4, 0.3, 0.16],
    oak_leaves: [0.28, 0.5, 0.18],
    chest: [0.58, 0.4, 0.16],
    barrel: [0.45, 0.32, 0.18],
    tuff: [0.42, 0.42, 0.38],
    calcite: [0.88, 0.86, 0.82],
    amethyst_block: [0.52, 0.32, 0.72],
    andesite: [0.52, 0.52, 0.52],
    diorite: [0.74, 0.74, 0.74],
    granite: [0.58, 0.4, 0.34],
    basalt: [0.3, 0.3, 0.32],
    blackstone: [0.18, 0.16, 0.18],
    soul_sand: [0.32, 0.25, 0.2],
    ice: [0.62, 0.78, 0.9],
    snow_block: [0.92, 0.94, 0.96],
    bricks: [0.58, 0.32, 0.24],
    moss_block: [0.35, 0.52, 0.22],
    sculk: [0.05, 0.18, 0.2],
    quartz_block: [0.92, 0.9, 0.86],
    gold_block: [0.95, 0.78, 0.22],
    iron_block: [0.82, 0.82, 0.84],
    diamond_block: [0.32, 0.82, 0.78],
    ancient_debris: [0.32, 0.22, 0.18],
    scaffolding: [0.78, 0.64, 0.32],
  };

  function colorOf(name) {
    if (BLOCKS[name]) return BLOCKS[name];
    for (const dye of Object.keys(DYES)) {
      if (name.startsWith(`${dye}_`)) return DYES[dye];
    }
    if (name.includes("log") || name.includes("wood") || name.includes("plank")) return [0.55, 0.4, 0.2];
    if (name.includes("leaves")) return [0.3, 0.52, 0.2];
    if (name.includes("ore")) return [0.42, 0.44, 0.48];
    if (name.includes("water")) return BLOCKS.water;
    if (name.includes("lava")) return BLOCKS.lava;
    if (name.includes("glass")) return BLOCKS.glass;
    if (name.includes("portal")) return BLOCKS.nether_portal;
    let h = 2166136261;
    for (let i = 0; i < name.length; i++) h = Math.imul(h ^ name.charCodeAt(i), 16777619);
    const t = (h >>> 0) / 4294967296;
    return [0.3 + t * 0.38, 0.2 + ((t * 7) % 1) * 0.22, 0.14 + ((t * 13) % 1) * 0.18];
  }

  const ATLAS_COLS = 8;
  const TILE_PX = 16;
  const WOOL_TILE = 31;

  function rgb(r, g, b) {
    return [Math.max(0, Math.min(255, r | 0)), Math.max(0, Math.min(255, g | 0)), Math.max(0, Math.min(255, b | 0))];
  }

  function generateAtlas() {
    const size = ATLAS_COLS * TILE_PX;
    const data = new Uint8Array(size * size * 4);
    const put = (id, x, y, c) => {
      if (x < 0 || y < 0 || x >= TILE_PX || y >= TILE_PX) return;
      const tx = (id % ATLAS_COLS) * TILE_PX + x;
      const ty = Math.floor(id / ATLAS_COLS) * TILE_PX + y;
      const i = (ty * size + tx) * 4;
      data[i] = c[0];
      data[i + 1] = c[1];
      data[i + 2] = c[2];
      data[i + 3] = 255;
    };
    const fill = (id, c) => {
      for (let y = 0; y < TILE_PX; y++) {
        for (let x = 0; x < TILE_PX; x++) put(id, x, y, c);
      }
    };
    const rect = (id, x, y, w, h, c) => {
      for (let j = 0; j < h; j++) {
        for (let i = 0; i < w; i++) put(id, x + i, y + j, c);
      }
    };
    const border = (id, c) => {
      rect(id, 0, 0, TILE_PX, 1, c);
      rect(id, 0, TILE_PX - 1, TILE_PX, 1, c);
      rect(id, 0, 0, 1, TILE_PX, c);
      rect(id, TILE_PX - 1, 0, 1, TILE_PX, c);
    };
    const metal = (id, base, shine) => {
      fill(id, base);
      rect(id, 1, 1, 5, 1, shine);
      rect(id, 1, 1, 1, 5, shine);
      rect(id, 2, 2, 2, 2, shine);
    };
    const bricks = (id, face, grout) => {
      fill(id, face);
      for (let y = 0; y < TILE_PX; y++) {
        if (y % 4 === 3) rect(id, 0, y, TILE_PX, 1, grout);
      }
      for (let row = 0; row < 4; row++) {
        const y0 = row * 4;
        const shift = row % 2 === 0 ? 0 : 4;
        for (let x = shift; x < TILE_PX; x += 8) rect(id, x, y0, 1, 3, grout);
      }
    };
    fill(0, rgb(232, 228, 220));
    border(0, rgb(196, 190, 178));

    fill(1, rgb(142, 142, 142));
    rect(1, 11, 3, 3, 2, rgb(126, 126, 126));
    rect(1, 3, 10, 4, 2, rgb(126, 126, 126));

    fill(2, rgb(92, 92, 92));
    rect(2, 1, 1, 6, 6, rgb(150, 150, 150));
    rect(2, 9, 1, 6, 6, rgb(132, 132, 132));
    rect(2, 1, 9, 6, 6, rgb(138, 138, 138));
    rect(2, 9, 9, 6, 6, rgb(158, 158, 158));

    fill(3, rgb(58, 58, 64));
    rect(3, 0, 4, TILE_PX, 3, rgb(72, 72, 80));
    rect(3, 0, 11, TILE_PX, 2, rgb(46, 46, 52));

    fill(4, rgb(48, 22, 78));

    fill(5, rgb(58, 24, 96));
    put(5, 5, 4, rgb(236, 98, 255));
    put(5, 5, 5, rgb(236, 98, 255));
    put(5, 10, 9, rgb(214, 72, 236));
    put(5, 4, 12, rgb(196, 56, 220));

    fill(6, rgb(178, 72, 68));
    rect(6, 3, 4, 3, 3, rgb(118, 36, 36));
    rect(6, 10, 9, 3, 3, rgb(118, 36, 36));

    fill(7, rgb(138, 92, 52));

    fill(8, rgb(91, 168, 48));

    fill(9, rgb(138, 92, 52));
    rect(9, 0, 0, TILE_PX, 5, rgb(91, 168, 48));
    rect(9, 0, 5, TILE_PX, 1, rgb(110, 128, 48));

    fill(10, rgb(222, 206, 126));

    fill(11, rgb(178, 132, 68));
    rect(11, 0, 3, TILE_PX, 1, rgb(148, 102, 48));
    rect(11, 0, 7, TILE_PX, 1, rgb(148, 102, 48));
    rect(11, 0, 11, TILE_PX, 1, rgb(148, 102, 48));
    rect(11, 0, 15, TILE_PX, 1, rgb(148, 102, 48));

    fill(12, rgb(158, 114, 58));
    rect(12, 5, 5, 6, 6, rgb(112, 76, 36));
    rect(12, 7, 7, 2, 2, rgb(86, 56, 26));
    border(12, rgb(86, 56, 26));
    rect(12, 2, 2, 12, 1, rgb(132, 92, 44));
    rect(12, 2, 13, 12, 1, rgb(132, 92, 44));
    rect(12, 2, 2, 1, 12, rgb(132, 92, 44));
    rect(12, 13, 2, 1, 12, rgb(132, 92, 44));

    fill(13, rgb(112, 76, 36));
    rect(13, 0, 0, 3, TILE_PX, rgb(78, 50, 22));
    rect(13, 13, 0, 3, TILE_PX, rgb(78, 50, 22));
    rect(13, 6, 0, 2, TILE_PX, rgb(92, 62, 28));

    fill(14, rgb(62, 138, 42));
    rect(14, 3, 3, 3, 3, rgb(36, 88, 24));
    rect(14, 10, 9, 3, 3, rgb(36, 88, 24));

    fill(15, rgb(42, 110, 196));
    rect(15, 3, 3, 10, 10, rgb(62, 138, 216));

    fill(16, rgb(214, 62, 18));
    rect(16, 3, 3, 10, 10, rgb(236, 122, 22));
    rect(16, 6, 6, 4, 4, rgb(255, 214, 64));

    fill(17, rgb(52, 46, 48));
    rect(17, 3, 4, 4, 3, rgb(92, 64, 48));
    rect(17, 9, 9, 4, 3, rgb(92, 64, 48));

    fill(18, rgb(92, 58, 18));
    rect(18, 1, 1, 6, 6, rgb(236, 186, 64));
    rect(18, 9, 1, 6, 6, rgb(246, 206, 82));
    rect(18, 1, 9, 6, 6, rgb(246, 206, 82));
    rect(18, 9, 9, 6, 6, rgb(236, 186, 64));

    metal(19, rgb(246, 196, 42), rgb(255, 236, 140));
    metal(20, rgb(198, 198, 206), rgb(236, 236, 242));
    metal(21, rgb(48, 214, 198), rgb(186, 255, 246));

    fill(22, rgb(168, 214, 226));
    border(22, rgb(214, 240, 246));
    rect(22, 6, 6, 4, 4, rgb(214, 240, 246));

    fill(23, rgb(242, 246, 250));

    bricks(24, rgb(168, 86, 68), rgb(72, 42, 34));
    bricks(25, rgb(78, 28, 28), rgb(32, 10, 10));

    fill(26, rgb(222, 214, 148));
    rect(26, 4, 5, 2, 2, rgb(186, 176, 110));
    rect(26, 11, 10, 2, 2, rgb(186, 176, 110));

    fill(27, rgb(132, 86, 32));
    border(27, rgb(78, 50, 18));
    rect(27, 6, 7, 4, 2, rgb(226, 186, 48));

    fill(28, rgb(92, 28, 168));
    rect(28, 3, 3, 10, 10, rgb(148, 62, 214));
    rect(28, 6, 6, 4, 4, rgb(196, 118, 246));

    fill(29, rgb(42, 42, 46));
    rect(29, 2, 2, 4, 4, rgb(22, 22, 24));
    rect(29, 10, 3, 3, 3, rgb(72, 72, 78));
    rect(29, 4, 10, 4, 3, rgb(22, 22, 24));
    rect(29, 11, 11, 3, 3, rgb(72, 72, 78));

    fill(30, rgb(92, 24, 18));
    rect(30, 0, 7, TILE_PX, 2, rgb(255, 132, 28));
    rect(30, 7, 0, 2, TILE_PX, rgb(255, 132, 28));
    rect(30, 6, 6, 4, 4, rgb(255, 196, 64));

    fill(31, rgb(236, 236, 236));

    return { data, size };
  }

  function uploadAtlas() {
    const { data, size } = generateAtlas();
    const tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, size, size, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    return tex;
  }

  function tilesFor(name) {
    const same = (id) => [id, id, id];
    if (name === "grass_block") return [8, 9, 7];
    if (name === "oak_log" || name.endsWith("_log")) return [12, 13, 12];
    if (name.includes("leaves")) return same(14);
    if (name === "cobblestone" || name === "mossy_cobblestone") return same(2);
    if (name.includes("deepslate")) return same(3);
    if (name === "crying_obsidian") return same(5);
    if (name === "obsidian") return same(4);
    if (name === "netherrack") return same(6);
    if (name === "dirt" || name === "coarse_dirt") return same(7);
    if (name === "sand" || name === "red_sand") return same(10);
    if (name.includes("plank")) return same(11);
    if (name === "water" || name === "bubble_column") return same(15);
    if (name === "lava") return same(16);
    if (name.includes("netherite")) return same(17);
    if (name === "glowstone") return same(18);
    if (name === "gold_block") return same(19);
    if (name === "iron_block") return same(20);
    if (name === "diamond_block") return same(21);
    if (name.includes("glass")) return same(22);
    if (name.includes("snow")) return same(23);
    if (name === "bricks") return same(24);
    if (name.includes("nether_brick")) return same(25);
    if (name.includes("end_stone")) return same(26);
    if (name.includes("chest") || name === "ender_chest" || name === "barrel") return same(27);
    if (name.includes("portal")) return same(28);
    if (name === "bedrock") return same(29);
    if (name === "magma_block") return same(30);
    if (name === "stone" || name === "andesite" || name === "diorite" || name === "tuff") return same(1);
    if (name === "gravel") return same(2);
    if (name === "basalt" || name === "blackstone" || name.includes("basalt")) return same(3);
    if (name.includes("sandstone")) return same(10);
    if (name === "ice" || name.includes("ice")) return same(22);
    if (name.includes("moss")) return same(14);
    if (name === "sculk" || name.includes("sculk")) return same(4);
    if (name.includes("quartz") || name === "calcite") return same(23);
    if (name.includes("amethyst")) return same(5);
    if (name === "soul_sand" || name === "soul_soil") return same(7);
    if (name.includes("scaffolding")) return same(11);
    if (name === "ancient_debris") return same(17);
    if (name === "granite") return same(1);
    if (
      name.includes("wool") ||
      name.includes("concrete") ||
      name.includes("terracotta") ||
      name.includes("carpet")
    ) {
      return same(WOOL_TILE);
    }
    return same(0);
  }

  function compile(type, src) {
    const sh = gl.createShader(type);
    if (!sh) throw new Error("could not create shader");
    gl.shaderSource(sh, src.trimStart().replace(/\r/g, ""));
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
      throw new Error(gl.getShaderInfoLog(sh) || "shader");
    }
    return sh;
  }

  function program(vs, fs) {
    const p = gl.createProgram();
    gl.attachShader(p, compile(gl.VERTEX_SHADER, vs));
    gl.attachShader(p, compile(gl.FRAGMENT_SHADER, fs));
    gl.linkProgram(p);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
      throw new Error(gl.getProgramInfoLog(p) || "program");
    }
    return p;
  }

  function makeCube() {
    const pos = [];
    const nrm = [];
    const uv = [];
    const idx = [];
    const faces = [
      { n: [1, 0, 0], v: [[0.5, -0.5, -0.5], [0.5, -0.5, 0.5], [0.5, 0.5, 0.5], [0.5, 0.5, -0.5]] },
      { n: [-1, 0, 0], v: [[-0.5, -0.5, 0.5], [-0.5, -0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, 0.5, 0.5]] },
      { n: [0, 1, 0], v: [[-0.5, 0.5, -0.5], [0.5, 0.5, -0.5], [0.5, 0.5, 0.5], [-0.5, 0.5, 0.5]] },
      { n: [0, -1, 0], v: [[-0.5, -0.5, 0.5], [0.5, -0.5, 0.5], [0.5, -0.5, -0.5], [-0.5, -0.5, -0.5]] },
      { n: [0, 0, 1], v: [[-0.5, -0.5, 0.5], [-0.5, 0.5, 0.5], [0.5, 0.5, 0.5], [0.5, -0.5, 0.5]] },
      { n: [0, 0, -1], v: [[0.5, -0.5, -0.5], [0.5, 0.5, -0.5], [-0.5, 0.5, -0.5], [-0.5, -0.5, -0.5]] },
    ];
    const faceUv = [[0, 0], [1, 0], [1, 1], [0, 1]];
    let base = 0;
    for (const face of faces) {
      for (let i = 0; i < face.v.length; i++) {
        pos.push(...face.v[i]);
        nrm.push(...face.n);
        uv.push(...faceUv[i]);
      }
      idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
      base += 4;
    }
    return {
      pos: new Float32Array(pos),
      nrm: new Float32Array(nrm),
      uv: new Float32Array(uv),
      idx: new Uint16Array(idx),
    };
  }

  function perspective(fovy, aspect, near, far) {
    const f = 1 / Math.tan(fovy / 2);
    const nf = 1 / (near - far);
    const o = new Float32Array(16);
    o[0] = f / aspect;
    o[5] = f;
    o[10] = (far + near) * nf;
    o[11] = -1;
    o[14] = 2 * far * near * nf;
    return o;
  }

  function lookAt(eye, center, up) {
    let zx = eye[0] - center[0];
    let zy = eye[1] - center[1];
    let zz = eye[2] - center[2];
    const zl = Math.hypot(zx, zy, zz) || 1;
    zx /= zl;
    zy /= zl;
    zz /= zl;
    let xx = up[1] * zz - up[2] * zy;
    let xy = up[2] * zx - up[0] * zz;
    let xz = up[0] * zy - up[1] * zx;
    const xl = Math.hypot(xx, xy, xz) || 1;
    xx /= xl;
    xy /= xl;
    xz /= xl;
    const yx = zy * xz - zz * xy;
    const yy = zz * xx - zx * xz;
    const yz = zx * xy - zy * xx;
    const o = new Float32Array(16);
    o[0] = xx;
    o[1] = yx;
    o[2] = zx;
    o[4] = xy;
    o[5] = yy;
    o[6] = zy;
    o[8] = xz;
    o[9] = yz;
    o[10] = zz;
    o[12] = -(xx * eye[0] + xy * eye[1] + xz * eye[2]);
    o[13] = -(yx * eye[0] + yy * eye[1] + yz * eye[2]);
    o[14] = -(zx * eye[0] + zy * eye[1] + zz * eye[2]);
    o[15] = 1;
    return o;
  }

  function mul(a, b) {
    const o = new Float32Array(16);
    for (let c = 0; c < 4; c++) {
      for (let r = 0; r < 4; r++) {
        o[c * 4 + r] =
          a[r] * b[c * 4] + a[4 + r] * b[c * 4 + 1] + a[8 + r] * b[c * 4 + 2] + a[12 + r] * b[c * 4 + 3];
      }
    }
    return o;
  }

  const cubeVS = `#version 300 es
in vec3 aPos;
in vec3 aNrm;
in vec2 aUv;
in vec3 aOff;
in vec3 aCol;
in vec3 aScl;
in vec3 aTile;
uniform mat4 uViewProj;
uniform vec3 uLight;
out vec3 vCol;
out vec3 vWorld;
out vec2 vUv;
out float vTile;
out float vLit;
void main() {
  vec3 world = aOff + aPos * aScl;
  gl_Position = uViewProj * vec4(world, 1.0);
  float ndl = max(dot(normalize(aNrm), normalize(uLight)), 0.0);
  vLit = 0.42 + 0.58 * ndl;
  vCol = aCol;
  vUv = aUv;
  float tile = aTile.y;
  if (aNrm.y > 0.5) tile = aTile.x;
  else if (aNrm.y < -0.5) tile = aTile.z;
  vTile = tile;
  vWorld = world;
}`;

  const cubeFS = `#version 300 es
precision mediump float;
in vec3 vCol;
in vec3 vWorld;
in vec2 vUv;
in float vTile;
in float vLit;
uniform vec3 uCam;
uniform vec3 uFog;
uniform float uFogFar;
uniform sampler2D uAtlas;
uniform float uAtlasCols;
out vec4 frag;
void main() {
  vec3 tex;
  if (vTile < 0.0) {
    tex = vCol;
  } else {
    float cols = max(uAtlasCols, 1.0);
    float id = floor(vTile + 0.5);
    float col = mod(id, cols);
    float row = floor(id / cols);
    vec2 local = vec2(vUv.x, 1.0 - vUv.y);
    local = clamp(local, vec2(0.02), vec2(0.98));
    vec2 uv = (vec2(col, row) + local) / cols;
    tex = texture(uAtlas, uv).rgb;
    if (abs(id - 31.0) < 0.5 || id < 0.5) tex *= vCol;
  }
  tex *= vLit;
  float d = length(vWorld - uCam);
  float fog = smoothstep(uFogFar * 0.38, uFogFar, d);
  frag = vec4(mix(tex, uFog, fog), 1.0);
}`;

  const gridVS = `#version 300 es
in vec2 aUv;
uniform mat4 uViewProj;
uniform vec3 uOrigin;
uniform float uSize;
out vec3 vWorld;
void main() {
  vWorld = vec3(uOrigin.x + aUv.x * uSize, uOrigin.y, uOrigin.z + aUv.y * uSize);
  gl_Position = uViewProj * vec4(vWorld, 1.0);
}`;

  const gridFS = `#version 300 es
precision mediump float;
in vec3 vWorld;
uniform vec3 uCam;
out vec4 frag;
void main() {
  vec2 p = vWorld.xz;
  float ax = abs(p.x - floor(p.x + 0.5));
  float az = abs(p.y - floor(p.y + 0.5));
  float line = 1.0 - smoothstep(0.0, 0.06, min(ax, az));
  if (line < 0.08) discard;
  float major = 0.4;
  if (ax < 0.06 && abs(mod(p.x, 8.0)) < 0.12) major = 1.0;
  if (az < 0.06 && abs(mod(p.y, 8.0)) < 0.12) major = 1.0;
  float d = length(vWorld - uCam);
  float fade = 1.0 - smoothstep(18.0, 72.0, d);
  frag = vec4(0.88, 0.69, 0.26, 0.28 * line * major * fade);
}`;

  const cubeProg = program(cubeVS, cubeFS);
  const gridProg = program(gridVS, gridFS);
  const cube = makeCube();
  const atlasTex = uploadAtlas();
  const instBuf = gl.createBuffer();
  const entBuf = gl.createBuffer();
  const loc = {
    pos: gl.getAttribLocation(cubeProg, "aPos"),
    nrm: gl.getAttribLocation(cubeProg, "aNrm"),
    uv: gl.getAttribLocation(cubeProg, "aUv"),
    off: gl.getAttribLocation(cubeProg, "aOff"),
    col: gl.getAttribLocation(cubeProg, "aCol"),
    scl: gl.getAttribLocation(cubeProg, "aScl"),
    tile: gl.getAttribLocation(cubeProg, "aTile"),
    viewProj: gl.getUniformLocation(cubeProg, "uViewProj"),
    light: gl.getUniformLocation(cubeProg, "uLight"),
    cam: gl.getUniformLocation(cubeProg, "uCam"),
    fog: gl.getUniformLocation(cubeProg, "uFog"),
    fogFar: gl.getUniformLocation(cubeProg, "uFogFar"),
    atlas: gl.getUniformLocation(cubeProg, "uAtlas"),
    atlasCols: gl.getUniformLocation(cubeProg, "uAtlasCols"),
  };

  const voxelVao = gl.createVertexArray();
  const entityVao = gl.createVertexArray();

  function setupVao(vao, buffer) {
    gl.bindVertexArray(vao);
    const posBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, posBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cube.pos, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.pos);
    gl.vertexAttribPointer(loc.pos, 3, gl.FLOAT, false, 0, 0);
    const nrmBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, nrmBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cube.nrm, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.nrm);
    gl.vertexAttribPointer(loc.nrm, 3, gl.FLOAT, false, 0, 0);
    const uvBuf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, uvBuf);
    gl.bufferData(gl.ARRAY_BUFFER, cube.uv, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(loc.uv);
    gl.vertexAttribPointer(loc.uv, 2, gl.FLOAT, false, 0, 0);
    gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, gl.createBuffer());
    gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, cube.idx, gl.STATIC_DRAW);
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    const stride = 48;
    gl.enableVertexAttribArray(loc.off);
    gl.vertexAttribPointer(loc.off, 3, gl.FLOAT, false, stride, 0);
    gl.vertexAttribDivisor(loc.off, 1);
    gl.enableVertexAttribArray(loc.col);
    gl.vertexAttribPointer(loc.col, 3, gl.FLOAT, false, stride, 12);
    gl.vertexAttribDivisor(loc.col, 1);
    gl.enableVertexAttribArray(loc.scl);
    gl.vertexAttribPointer(loc.scl, 3, gl.FLOAT, false, stride, 24);
    gl.vertexAttribDivisor(loc.scl, 1);
    gl.enableVertexAttribArray(loc.tile);
    gl.vertexAttribPointer(loc.tile, 3, gl.FLOAT, false, stride, 36);
    gl.vertexAttribDivisor(loc.tile, 1);
  }

  setupVao(voxelVao, instBuf);
  setupVao(entityVao, entBuf);

  const gridVao = gl.createVertexArray();
  gl.bindVertexArray(gridVao);
  const gridBuf = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, gridBuf);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
  const gridUv = gl.getAttribLocation(gridProg, "aUv");
  gl.enableVertexAttribArray(gridUv);
  gl.vertexAttribPointer(gridUv, 2, gl.FLOAT, false, 0, 0);

  let voxelCount = 0;
  let occupancy = new Map();
  let field = null;
  let bot = null;
  let others = [];
  // Default follow so gamepad forward always matches what you see on screen
  let mode = "follow";
  let orbitAngle = 0.7;
  let radius = 20;
  /** Camera in *local* space (relative to origin). */
  let eye = [0, 80, 0];
  let yaw = 0;
  let pitch = -0.45;
  // Predicted yaw/pitch while the user is holding look buttons (smoother than waiting for status)
  let predYaw = null;
  let predPitch = null;
  let flying = false;
  let dragging = false;
  let seeded = false;
  /**
   * World-space origin for GPU. Absolute coords near 6b6t highways (~1e7)
   * destroy float32 precision; everything is drawn relative to this.
   */
  let origin = [0, 0, 0];
  /** When false, skip GPU draw + keep last frame dark (saves CPU/GPU; fetches gated in app.js). */
  let enabled = true;
  let rafPending = false;
  const flyKeys = new Set();
  const FLY_CODES = new Set(["KeyW", "KeyA", "KeyS", "KeyD", "Space", "KeyC", "KeyQ", "KeyE", "ShiftLeft", "KeyR"]);
  let lastT = performance.now();
  let picked = null;

  function writeInstances(buffer, rows) {
    const stride = 12;
    const data = new Float32Array(rows.length * stride);
    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const o = i * stride;
      for (let j = 0; j < stride; j++) data[o + j] = row[j] ?? (j >= 9 ? -1 : 0);
    }
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
    return rows.length;
  }

  function lx(x) {
    return x - origin[0];
  }
  function ly(y) {
    return y - origin[1];
  }
  function lz(z) {
    return z - origin[2];
  }

  /** Snap GPU origin near the bot (or field center). Rebuild voxels when origin moves a lot. */
  function setOriginNear(x, y, z) {
    const nx = Math.floor(x);
    const ny = Math.floor(y);
    const nz = Math.floor(z);
    const jump =
      Math.abs(nx - origin[0]) > 48 || Math.abs(ny - origin[1]) > 48 || Math.abs(nz - origin[2]) > 48;
    if (!jump && seeded) return false;
    origin = [nx, ny, nz];
    return true;
  }

  function rebuildVoxelInstances() {
    if (!field) {
      voxelCount = writeInstances(instBuf, []);
      return;
    }
    const rows = [];
    const cells = field.cells || [];
    const palette = field.palette || [];
    for (let i = 0; i + 3 < cells.length; i += 4) {
      const name = palette[cells[i + 3]] || "stone";
      const wx = field.ox + cells[i];
      const wy = field.oy + cells[i + 1];
      const wz = field.oz + cells[i + 2];
      const rgb = colorOf(name);
      const tiles = tilesFor(name);
      const tint = tiles[0] === 0 || tiles[0] === WOOL_TILE;
      const col = tint ? rgb : [1, 1, 1];
      rows.push([
        lx(wx) + 0.5,
        ly(wy) + 0.5,
        lz(wz) + 0.5,
        col[0],
        col[1],
        col[2],
        0.94,
        0.94,
        0.94,
        tiles[0],
        tiles[1],
        tiles[2],
      ]);
    }
    voxelCount = writeInstances(instBuf, rows);
  }

  function setField(next) {
    field = next;
    occupancy = new Map();
    const cells = next?.cells || [];
    const palette = next?.palette || [];
    for (let i = 0; i + 3 < cells.length; i += 4) {
      const name = palette[cells[i + 3]] || "stone";
      const wx = next.ox + cells[i];
      const wy = next.oy + cells[i + 1];
      const wz = next.oz + cells[i + 2];
      occupancy.set(`${wx},${wy},${wz}`, name);
    }
    if (next?.entities) {
      const self = next.entities.find((e) => e.kind === "bot");
      if (self) bot = self;
      others = next.entities.filter((e) => e.kind === "player");
    }
    // Anchor origin on bot (or field center) so highway coords stay precise
    if (bot) setOriginNear(bot.x, bot.y, bot.z);
    else if (next)
      setOriginNear(next.ox + (next.sx || 0) / 2, next.oy + (next.sy || 0) / 2, next.oz + (next.sz || 0) / 2);
    rebuildVoxelInstances();
    const n = occupancy.size;
    if (metaEl) {
      metaEl.textContent = n
        ? `${n} cells · ${next.sx}×${next.sy}×${next.sz} @ ${next.ox} ${next.oy} ${next.oz}`
        : "no solid blocks in range";
    }
    if (!seeded && bot) {
      seedCamera();
      seeded = true;
    }
  }

  function setBot(pos, heading, name, botPitch) {
    if (!pos) return;
    const prev = bot;
    const jump =
      prev &&
      Math.hypot(pos.x - prev.x, pos.y - prev.y, pos.z - prev.z) > 32;
    const pitchVal = typeof botPitch === "number" && Number.isFinite(botPitch) ? botPitch : prev?.pitch ?? 0;
    bot = {
      name: name || bot?.name || "unknown",
      kind: "bot",
      x: pos.x,
      y: pos.y,
      z: pos.z,
      yaw: heading,
      pitch: pitchVal,
    };
    // If prediction is close to the real heading, snap prediction to it so we don't drift
    if (predYaw != null && typeof heading === "number") {
      let d = predYaw - heading;
      while (d > Math.PI) d -= Math.PI * 2;
      while (d < -Math.PI) d += Math.PI * 2;
      if (Math.abs(d) < 0.35) predYaw = heading;
    }
    if (predPitch != null && typeof pitchVal === "number") {
      if (Math.abs(predPitch - pitchVal) < 0.25) predPitch = pitchVal;
    }
    if (setOriginNear(pos.x, pos.y, pos.z) && field) rebuildVoxelInstances();
    if (!seeded || jump) {
      seedCamera();
      seeded = true;
    }
    scheduleDraw();
  }

  /** Instant local camera turn while look buttons are held (prediction). */
  function nudgeLook(dyaw, dpitch) {
    if (mode !== "follow") return;
    if (predYaw == null) predYaw = bot?.yaw ?? 0;
    if (predPitch == null) predPitch = bot?.pitch ?? 0;
    predYaw += dyaw;
    predPitch = Math.max(-1.45, Math.min(1.45, predPitch + dpitch));
    scheduleDraw();
  }

  /** Clear prediction (e.g. when look buttons released). */
  function clearLookPrediction() {
    predYaw = null;
    predPitch = null;
  }

  /** Force follow mode so gamepad movement matches the screen. */
  function ensureFollow() {
    if (mode === "follow") return;
    mode = "follow";
    flying = false;
    flyKeys.clear();
    root?.classList.remove("flying");
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    syncModeButtons();
    notifyKeyOwner();
    scheduleDraw();
  }

  /**
   * Current view facing (radians), matching mineflayer yaw/pitch.
   * Prefer local look prediction while the user is turning so Move
   * forward/left/right/back always match what is on screen.
   */
  function getLook() {
    const yaw = predYaw != null ? predYaw : bot?.yaw ?? 0;
    const pitch = predPitch != null ? predPitch : bot?.pitch ?? 0;
    return { yaw, pitch, mode };
  }

  function setPlayers(list) {
    others = (list || [])
      .filter((p) => p.position && p.username !== bot?.name)
      .map((p) => ({
        name: p.username,
        kind: "player",
        x: p.position.x,
        y: p.position.y,
        z: p.position.z,
        yaw: p.yaw,
      }));
  }

  function seedCamera() {
    if (!bot) return;
    // Local-space orbit start
    eye = [14, 9, 14];
    lookToward(lx(bot.x), ly(bot.y) + 1, lz(bot.z));
  }

  function lookToward(x, y, z) {
    const dx = x - eye[0];
    const dy = y - eye[1];
    const dz = z - eye[2];
    yaw = Math.atan2(dx, -dz);
    pitch = Math.atan2(dy, Math.hypot(dx, dz));
  }

  function forward() {
    const cp = Math.cos(pitch);
    return [Math.sin(yaw) * cp, Math.sin(pitch), -Math.cos(yaw) * cp];
  }

  function rightVec() {
    return [Math.cos(yaw), 0, Math.sin(yaw)];
  }

  function viewportActive() {
    return flying || document.activeElement === canvas || document.pointerLockElement === canvas;
  }

  function ownsKeys() {
    return mode !== "follow" && viewportActive();
  }

  function isFlying() {
    return ownsKeys();
  }

  function syncModeButtons() {
    document.getElementById("survey-follow")?.classList.toggle("on", mode === "follow");
    document.getElementById("survey-orbit")?.classList.toggle("on", mode === "orbit");
  }

  let lastOwns = false;
  function notifyKeyOwner() {
    const owns = ownsKeys();
    if (owns === lastOwns) return;
    lastOwns = owns;
    window.dispatchEvent(new CustomEvent("survey-keys", { detail: { owns } }));
  }

  function captureViewport() {
    if (mode === "follow") {
      notifyKeyOwner();
      return;
    }
    flying = true;
    if (mode === "orbit") mode = "free";
    root?.classList.add("flying");
    syncModeButtons();
    notifyKeyOwner();
  }

  function enterFly() {
    captureViewport();
    canvas.focus();
    canvas.requestPointerLock?.();
  }

  function exitFly() {
    flying = false;
    flyKeys.clear();
    root?.classList.remove("flying");
    if (document.pointerLockElement === canvas) document.exitPointerLock?.();
    if (mode === "free") mode = "orbit";
    syncModeButtons();
    notifyKeyOwner();
  }

  function resize() {
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const rect = canvas.getBoundingClientRect();
    const w = Math.max(1, Math.floor(rect.width * dpr));
    const h = Math.max(1, Math.floor(rect.height * dpr));
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    gl.viewport(0, 0, canvas.width, canvas.height);
  }

  function entityRows() {
    const rows = [];
    if (bot) {
      rows.push([
        lx(bot.x),
        ly(bot.y) + 0.9,
        lz(bot.z),
        0.88,
        0.69,
        0.26,
        0.55,
        1.8,
        0.55,
        -1,
        -1,
        -1,
      ]);
    }
    for (const p of others) {
      rows.push([
        lx(p.x),
        ly(p.y) + 0.9,
        lz(p.z),
        0.89,
        0.29,
        0.07,
        0.5,
        1.7,
        0.5,
        -1,
        -1,
        -1,
      ]);
    }
    return rows;
  }

  function pickBlock() {
    if (!occupancy.size) return null;
    const f = forward();
    // Ray in local space, occupancy keys are world coords
    const pos = [eye[0] + origin[0], eye[1] + origin[1], eye[2] + origin[2]];
    let x = Math.floor(pos[0]);
    let y = Math.floor(pos[1]);
    let z = Math.floor(pos[2]);
    const stepX = f[0] > 0 ? 1 : -1;
    const stepY = f[1] > 0 ? 1 : -1;
    const stepZ = f[2] > 0 ? 1 : -1;
    const tDeltaX = Math.abs(1 / (f[0] || 1e-8));
    const tDeltaY = Math.abs(1 / (f[1] || 1e-8));
    const tDeltaZ = Math.abs(1 / (f[2] || 1e-8));
    let tMaxX = (stepX > 0 ? x + 1 - pos[0] : pos[0] - x) * tDeltaX;
    let tMaxY = (stepY > 0 ? y + 1 - pos[1] : pos[1] - y) * tDeltaY;
    let tMaxZ = (stepZ > 0 ? z + 1 - pos[2] : pos[2] - z) * tDeltaZ;
    for (let i = 0; i < 80; i++) {
      const name = occupancy.get(`${x},${y},${z}`);
      if (name) return { x, y, z, name };
      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        tMaxX += tDeltaX;
        x += stepX;
      } else if (tMaxY < tMaxZ) {
        tMaxY += tDeltaY;
        y += stepY;
      } else {
        tMaxZ += tDeltaZ;
        z += stepZ;
      }
    }
    return null;
  }

  function applyLook(dx, dy) {
    yaw += dx * 0.0024;
    pitch = Math.max(-1.45, Math.min(1.45, pitch - dy * 0.0024));
  }

  canvas.addEventListener("click", () => {
    if (mode === "follow") {
      canvas.focus();
      if (picked) {
        const form = document.getElementById("goto");
        if (form) {
          form.x.value = String(picked.x);
          form.y.value = String(picked.y);
          form.z.value = String(picked.z);
        }
      }
      return;
    }
    if (!flying) enterFly();
    else if (picked) {
      const form = document.getElementById("goto");
      if (form) {
        form.x.value = String(picked.x);
        form.y.value = String(picked.y);
        form.z.value = String(picked.z);
      }
    }
  });
  canvas.addEventListener("dblclick", () => {
    if (!picked) return;
    canvas.dispatchEvent(new CustomEvent("survey-goto", { bubbles: true, detail: picked }));
  });
  canvas.addEventListener("mousedown", (event) => {
    if (event.button === 0 && mode !== "follow" && document.pointerLockElement !== canvas) dragging = true;
  });
  window.addEventListener("mouseup", () => {
    dragging = false;
  });
  window.addEventListener("mousemove", (event) => {
    if (document.pointerLockElement === canvas) applyLook(event.movementX, event.movementY);
    else if (dragging && mode !== "follow") {
      applyLook(event.movementX, event.movementY);
      if (mode === "orbit") {
        mode = "free";
        syncModeButtons();
      }
    }
  });
  document.addEventListener("pointerlockchange", () => {
    if (document.pointerLockElement === canvas) {
      captureViewport();
    } else if (flying && document.activeElement !== canvas) {
      exitFly();
    } else {
      notifyKeyOwner();
    }
  });
  canvas.addEventListener("focus", () => {
    if (mode === "follow") {
      notifyKeyOwner();
      return;
    }
    captureViewport();
  });
  canvas.addEventListener("keydown", (event) => {
    if (event.code === "Escape") {
      exitFly();
      return;
    }
    if (!ownsKeys()) return;
    if (FLY_CODES.has(event.code)) {
      event.preventDefault();
      flyKeys.add(event.code);
    }
  });
  canvas.addEventListener("keyup", (event) => flyKeys.delete(event.code));
  window.addEventListener("keydown", (event) => {
    if (!ownsKeys()) return;
    if (event.target instanceof HTMLInputElement) return;
    if (FLY_CODES.has(event.code)) {
      event.preventDefault();
      flyKeys.add(event.code);
    }
    if (event.code === "Escape") exitFly();
  });
  window.addEventListener("keyup", (event) => {
    if (FLY_CODES.has(event.code)) flyKeys.delete(event.code);
  });
  canvas.addEventListener("blur", () => {
    flyKeys.clear();
    if (document.pointerLockElement !== canvas) {
      flying = false;
      root?.classList.remove("flying");
      if (mode === "free") mode = "orbit";
      syncModeButtons();
    }
    notifyKeyOwner();
  });

  document.getElementById("survey-follow")?.addEventListener("click", () => {
    mode = "follow";
    exitFly();
    canvas.focus();
  });
  document.getElementById("survey-orbit")?.addEventListener("click", () => {
    mode = "orbit";
    exitFly();
    if (document.activeElement === canvas) canvas.blur();
  });
  document.querySelectorAll(".rad").forEach((btn) => {
    btn.addEventListener("click", () => {
      radius = Number(btn.getAttribute("data-r")) || 20;
      document.querySelectorAll(".rad").forEach((b) => b.classList.toggle("on", b === btn));
      window.dispatchEvent(new CustomEvent("survey-radius", { detail: radius }));
    });
  });

  function stepFly(dt) {
    if (!ownsKeys()) return;
    const f = forward();
    const r = rightVec();
    let speed = flyKeys.has("ShiftLeft") ? 6 : flyKeys.has("KeyR") ? 38 : 16;
    speed *= dt;
    if (flyKeys.has("KeyW")) {
      eye[0] += f[0] * speed;
      eye[1] += f[1] * speed;
      eye[2] += f[2] * speed;
    }
    if (flyKeys.has("KeyS")) {
      eye[0] -= f[0] * speed;
      eye[1] -= f[1] * speed;
      eye[2] -= f[2] * speed;
    }
    if (flyKeys.has("KeyD")) {
      eye[0] += r[0] * speed;
      eye[2] += r[2] * speed;
    }
    if (flyKeys.has("KeyA")) {
      eye[0] -= r[0] * speed;
      eye[2] -= r[2] * speed;
    }
    if (flyKeys.has("Space") || flyKeys.has("KeyE")) eye[1] += speed;
    if (flyKeys.has("KeyC") || flyKeys.has("KeyQ")) eye[1] -= speed;
  }

  function placeCamera(dt) {
    if (!bot) return;
    const bx = lx(bot.x);
    const by = ly(bot.y);
    const bz = lz(bot.z);
    if (mode === "orbit" && !ownsKeys()) {
      // Slow continuous orbit around the bot (camera only)
      orbitAngle += dt * 0.18;
      const dist = Math.max(12, radius * 0.7);
      eye = [bx + Math.cos(orbitAngle) * dist, by + 8, bz + Math.sin(orbitAngle) * dist];
      lookToward(bx, by + 1.2, bz);
    } else if (mode === "follow") {
      // Prefer predicted look while the user is actively turning (instant feel)
      const useYaw = predYaw != null ? predYaw : bot.yaw || 0;
      // Minecraft pitch: negative = look up, positive = look down
      const usePitch = predPitch != null ? predPitch : bot.pitch || 0;
      // Mineflayer / prismarine yaw: 0 = north (-Z), π/2 = west (-X).
      // Forward unit vector must match setControlState("forward"):
      //   fx = -sin(yaw), fz = -cos(yaw)
      // (Previously fz = +cos(yaw) which pointed the camera south when the bot
      // faced north — so Move ▲ walked opposite to the view.)
      const fx = -Math.sin(useYaw);
      const fz = -Math.cos(useYaw);
      // Over-the-shoulder: camera behind bot, looking the same way the bot looks
      // so look-up / look-down actually tilts the view
      const dist = 8;
      const baseHeight = 3.6;
      // Raise camera a bit when looking down, lower when looking up (keeps subject framed)
      const pitchLift = usePitch * 2.2;
      const targetEye = [
        bx - fx * dist,
        by + baseHeight + pitchLift,
        bz - fz * dist,
      ];
      const k = Math.min(1, dt * 14);
      eye[0] += (targetEye[0] - eye[0]) * k;
      eye[1] += (targetEye[1] - eye[1]) * k;
      eye[2] += (targetEye[2] - eye[2]) * k;

      // Aim a point in front of the bot along its look direction
      const lookAhead = 14;
      const cp = Math.cos(usePitch);
      const sp = Math.sin(usePitch);
      // forward horizontal * cos(pitch), vertical = -sin(pitch) in MC coords
      const tx = bx + fx * lookAhead * cp;
      const ty = by + 1.4 - sp * lookAhead;
      const tz = bz + fz * lookAhead * cp;
      lookToward(tx, ty, tz);
    }
  }

  function scheduleDraw() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      draw();
    });
  }

  function draw() {
    try {
    if (!enabled) {
      // Idle: no continuous rAF while 3D is off (saves battery / GPU)
      const fog = [0.04, 0.03, 0.025];
      gl.clearColor(fog[0], fog[1], fog[2], 1);
      gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
      if (metaEl) metaEl.textContent = "3D view off";
      return;
    }
    const now = performance.now();
    const dt = Math.min(0.05, (now - lastT) / 1000);
    lastT = now;
    resize();
    stepFly(dt);
    placeCamera(dt);
    picked = pickBlock();
    if (hudEl) {
      hudEl.textContent = picked
        ? `${picked.name}  ${picked.x} ${picked.y} ${picked.z}`
        : mode === "follow"
          ? "follow · WASD steers the bot"
          : flying
            ? "survey flight"
            : "click stage to fly · WASD is camera";
    }
    if (compassEl) {
      let deg = ((yaw * 180) / Math.PI) % 360;
      if (deg < 0) deg += 360;
      const dirs = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"];
      compassEl.textContent = dirs[Math.round(deg / 45) % 8];
    }

    const fog = [0.062, 0.047, 0.035];
    gl.clearColor(fog[0], fog[1], fog[2], 1);
    gl.clear(gl.COLOR_BUFFER_BIT | gl.DEPTH_BUFFER_BIT);
    gl.enable(gl.DEPTH_TEST);
    gl.enable(gl.CULL_FACE);

    const aspect = canvas.width / Math.max(1, canvas.height);
    const f = forward();
    const target = [eye[0] + f[0], eye[1] + f[1], eye[2] + f[2]];
    const viewProj = mul(perspective(1.05, aspect, 0.08, 220), lookAt(eye, target, [0, 1, 0]));
    const fogFar = Math.max(40, radius * 2.4);

    gl.useProgram(cubeProg);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, atlasTex);
    gl.uniform1i(loc.atlas, 0);
    gl.uniform1f(loc.atlasCols, ATLAS_COLS);
    gl.uniformMatrix4fv(loc.viewProj, false, viewProj);
    gl.uniform3f(loc.light, -0.35, 0.9, 0.28);
    gl.uniform3f(loc.cam, eye[0], eye[1], eye[2]);
    gl.uniform3f(loc.fog, fog[0], fog[1], fog[2]);
    gl.uniform1f(loc.fogFar, fogFar);

    if (voxelCount) {
      gl.bindVertexArray(voxelVao);
      gl.drawElementsInstanced(gl.TRIANGLES, cube.idx.length, gl.UNSIGNED_SHORT, 0, voxelCount);
    }

    const ents = entityRows();
    if (ents.length) {
      writeInstances(entBuf, ents);
      gl.bindVertexArray(entityVao);
      gl.drawElementsInstanced(gl.TRIANGLES, cube.idx.length, gl.UNSIGNED_SHORT, 0, ents.length);
    }

    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);
    gl.depthMask(false);
    gl.useProgram(gridProg);
    gl.uniformMatrix4fv(gl.getUniformLocation(gridProg, "uViewProj"), false, viewProj);
    gl.uniform3f(
      gl.getUniformLocation(gridProg, "uOrigin"),
      bot ? lx(bot.x) : 0,
      Math.floor(bot ? ly(bot.y) : 0) + 0.02,
      bot ? lz(bot.z) : 0,
    );
    gl.uniform1f(gl.getUniformLocation(gridProg, "uSize"), Math.max(24, radius + 8));
    gl.uniform3f(gl.getUniformLocation(gridProg, "uCam"), eye[0], eye[1], eye[2]);
    gl.bindVertexArray(gridVao);
    gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
    gl.depthMask(true);
    gl.disable(gl.BLEND);

    scheduleDraw();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (metaEl) metaEl.textContent = `draw: ${message}`;
      console.error(err);
      if (enabled) scheduleDraw();
    }
  }

  function setEnabled(on) {
    const next = Boolean(on);
    if (enabled === next) return;
    enabled = next;
    if (!enabled) {
      // Drop terrain so memory is free and next enable starts clean
      field = null;
      occupancy = new Map();
      voxelCount = writeInstances(instBuf, []);
      others = [];
      if (metaEl) metaEl.textContent = "3D view off";
      // one clear frame
      scheduleDraw();
    } else {
      lastT = performance.now();
      scheduleDraw();
    }
  }

  if (typeof ResizeObserver !== "undefined") {
    new ResizeObserver(() => resize()).observe(canvas.parentElement || canvas);
  }
  window.addEventListener("resize", resize);

  syncModeButtons();

  window.fractalSurvey = {
    setField,
    setBot,
    setPlayers,
    setEnabled,
    isFlying,
    ownsKeys,
    nudgeLook,
    clearLookPrediction,
    ensureFollow,
    getLook,
    get enabled() {
      return enabled;
    },
    get radius() {
      return radius;
    },
    get mode() {
      return mode;
    },
    resize,
  };

  scheduleDraw();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (metaEl) metaEl.textContent = message;
    console.error(err);
    window.fractalSurvey = stub;
  }
})();
