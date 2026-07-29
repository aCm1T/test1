import * as THREE from 'three';

export type NoiseOptions = {
  seed?: number;
  scale?: number;
  octaves?: number;
  persistence?: number;
};

function mulberry32(seed: number): () => number {
  let t = seed >>> 0;
  return () => {
    t += 0x6d2b79f5;
    let r = Math.imul(t ^ (t >>> 15), 1 | t);
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r);
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296;
  };
}

function hash2(x: number, y: number, seed: number): number {
  let n = Math.imul(x + seed * 374761393, 1274126177) ^ Math.imul(y, 1103515245);
  n = (n ^ (n >>> 13)) >>> 0;
  return (n % 10000) / 10000;
}

function valueNoise2D(x: number, y: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const sx = fx * fx * (3 - 2 * fx);
  const sy = fy * fy * (3 - 2 * fy);
  const a = hash2(x0, y0, seed);
  const b = hash2(x0 + 1, y0, seed);
  const c = hash2(x0, y0 + 1, seed);
  const d = hash2(x0 + 1, y0 + 1, seed);
  const u = a + (b - a) * sx;
  const v = c + (d - c) * sx;
  return u + (v - u) * sy;
}

function fbm2D(x: number, y: number, opts: Required<NoiseOptions>): number {
  let amp = 1;
  let freq = opts.scale;
  let sum = 0;
  let norm = 0;
  for (let i = 0; i < opts.octaves; i++) {
    sum += valueNoise2D(x * freq, y * freq, opts.seed + i * 97) * amp;
    norm += amp;
    amp *= opts.persistence;
    freq *= 2;
  }
  return sum / norm;
}

/** Ridge / crack field — high where noise crosses mid-isolines. */
function ridgeCrack(x: number, y: number, seed: number, scale: number): number {
  const n = fbm2D(x, y, {
    seed,
    scale,
    octaves: 4,
    persistence: 0.55,
  });
  const ridge = 1 - Math.abs(n * 2 - 1);
  return ridge * ridge;
}

function clampByte(v: number): number {
  return Math.max(0, Math.min(255, Math.round(v)));
}

function fillImageData(
  size: number,
  paint: (x: number, y: number, i: number) => [number, number, number, number?],
): ImageData {
  const data = new Uint8ClampedArray(size * size * 4);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const [r, g, b, a = 255] = paint(x, y, i);
      data[i] = clampByte(r);
      data[i + 1] = clampByte(g);
      data[i + 2] = clampByte(b);
      data[i + 3] = clampByte(a);
    }
  }
  return new ImageData(data, size, size);
}

function canvasFromImageData(image: ImageData): HTMLCanvasElement {
  const canvas = document.createElement('canvas');
  canvas.width = image.width;
  canvas.height = image.height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('2D canvas context unavailable');
  ctx.putImageData(image, 0, 0);
  return canvas;
}

export function configureTexture(
  texture: THREE.Texture,
  options: {
    repeat?: [number, number];
    anisotropy?: number;
    colorSpace?: THREE.ColorSpace;
    wrap?: THREE.Wrapping;
  } = {},
): THREE.Texture {
  const wrap = options.wrap ?? THREE.RepeatWrapping;
  texture.wrapS = wrap;
  texture.wrapT = wrap;
  if (options.repeat) texture.repeat.set(options.repeat[0], options.repeat[1]);
  texture.anisotropy = options.anisotropy ?? 8;
  texture.colorSpace = options.colorSpace ?? THREE.SRGBColorSpace;
  texture.needsUpdate = true;
  return texture;
}

export function makeCanvasTexture(
  image: ImageData,
  options: {
    repeat?: [number, number];
    anisotropy?: number;
    colorSpace?: THREE.ColorSpace;
    wrap?: THREE.Wrapping;
  } = {},
): THREE.CanvasTexture {
  const canvas = canvasFromImageData(image);
  const tex = new THREE.CanvasTexture(canvas);
  configureTexture(tex, options);
  tex.generateMipmaps = true;
  tex.minFilter = THREE.LinearMipmapLinearFilter;
  tex.magFilter = THREE.LinearFilter;
  return tex;
}

/** Procedural asphalt road surface. */
export function makeAsphalt(
  size = 512,
  seed = 11,
  repeat: [number, number] = [8, 8],
): THREE.CanvasTexture {
  return createAsphaltTexture(size, seed, repeat);
}

/** Procedural concrete slabs / sidewalks. */
export function makeConcrete(
  size = 512,
  seed = 23,
  repeat: [number, number] = [4, 4],
): THREE.CanvasTexture {
  return createConcreteTexture(size, seed, repeat);
}

/** Procedural brick wall. */
export function makeBrick(
  size = 512,
  seed = 57,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  return createBrickTexture(size, seed, repeat);
}

/** Procedural metal plate with rivets / rust. */
export function makeMetal(
  size = 512,
  seed = 41,
  repeat: [number, number] = [2, 2],
): THREE.CanvasTexture {
  return createMetalPlateTexture(size, seed, repeat);
}

/** Procedural packed dirt / rubble soil. */
export function makeDirt(
  size = 256,
  seed = 67,
  repeat: [number, number] = [4, 4],
): THREE.CanvasTexture {
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.04,
    octaves: 5,
    persistence: 0.55,
  };
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const grit = valueNoise2D(x * 0.4, y * 0.4, seed + 12);
    const pebble = hash2(x, y, seed + 3);
    const moist = fbm2D(x * 0.7, y * 0.7, { ...noiseOpts, seed: seed + 44 });
    let r = 72 + n * 42 + grit * 18;
    let g = 52 + n * 32 + grit * 12;
    let b = 32 + n * 20 + grit * 8;
    if (pebble > 0.9) {
      r += 28;
      g += 22;
      b += 14;
    } else if (pebble < 0.06) {
      r -= 18;
      g -= 14;
      b -= 10;
    }
    if (moist > 0.62) {
      const m = (moist - 0.62) * 55;
      r -= m;
      g -= m * 0.7;
      b -= m * 0.4;
    }
    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 10 });
}

/** Generic tonal noise texture tinted by `color` (hex or CSS). */
export function makeNoise(
  color: number | string,
  size = 256,
  seed = 5,
  repeat: [number, number] = [2, 2],
): THREE.CanvasTexture {
  const c = new THREE.Color(color as THREE.ColorRepresentation);
  const br = Math.round(c.r * 255);
  const bg = Math.round(c.g * 255);
  const bb = Math.round(c.b * 255);
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.05,
    octaves: 4,
    persistence: 0.5,
  };
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const speck = hash2(x, y, seed + 9);
    const shade = 0.72 + n * 0.4 + speck * 0.08;
    return [br * shade, bg * shade, bb * shade];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 8 });
}

export function createAsphaltTexture(
  size = 512,
  seed = 11,
  repeat: [number, number] = [8, 8],
): THREE.CanvasTexture {
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.038,
    octaves: 6,
    persistence: 0.52,
  };
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const grit = valueNoise2D(x * 0.55, y * 0.55, seed + 40);
    const fine = hash2(x, y, seed + 2);
    const wear = fbm2D(x * 0.35, y * 0.35, { ...noiseOpts, seed: seed + 70 });

    // Multi-scale crack network (ridge isolines + diagonal secondary)
    const c1 = ridgeCrack(x, y, seed + 5, 0.028);
    const c2 = ridgeCrack(x + 80, y - 40, seed + 19, 0.055);
    const c3 = Math.abs(Math.sin((x * 0.7 + y * 1.3) * 0.045 + n * 3.2));
    let crack = 0;
    if (c1 > 0.78) crack = Math.max(crack, (c1 - 0.78) * 4.2);
    if (c2 > 0.82) crack = Math.max(crack, (c2 - 0.82) * 3.5);
    if (c3 < 0.04 && wear > 0.45) crack = Math.max(crack, 0.55);

    // Oil / tire stains
    const oil = fbm2D(x * 0.6, y * 0.6, {
      seed: seed + 110,
      scale: 0.022,
      octaves: 3,
      persistence: 0.6,
    });

    // Aggregate flecks
    const agg = fine > 0.93 ? 22 : fine < 0.05 ? -14 : 0;

    let base = 42 + n * 28 + grit * 14 + wear * 10 + agg;
    // Faded traffic lane polish (slightly lighter bands)
    const lane = Math.abs(((x / size) * 10) % 1 - 0.5);
    if (lane < 0.08) base += 8;

    let r = base + grit * 3;
    let g = base + grit * 2;
    let b = base - 3 + grit;

    if (oil > 0.68) {
      const o = (oil - 0.68) * 90;
      r -= o * 0.55;
      g -= o * 0.35;
      b -= o * 0.15;
    }

    if (crack > 0) {
      const k = Math.min(1, crack);
      r -= 38 * k;
      g -= 36 * k;
      b -= 32 * k;
    }

    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 16 });
}

export function createConcreteTexture(
  size = 512,
  seed = 23,
  repeat: [number, number] = [4, 4],
): THREE.CanvasTexture {
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.028,
    octaves: 5,
    persistence: 0.5,
  };
  const slab = Math.max(48, Math.floor(size / 4));
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const speck = hash2(x, y, seed + 7);
    const stain = fbm2D(x * 0.45, y * 0.55, { ...noiseOpts, seed: seed + 90 });
    const runoff = fbm2D(x * 0.15, y * 0.9, {
      seed: seed + 140,
      scale: 0.05,
      octaves: 3,
      persistence: 0.55,
    });
    const pit = hash2(x * 3, y * 3, seed + 33);

    let v = 132 + n * 32 + speck * 16;

    // Expansion joints / slab grid
    const jx = x % slab;
    const jy = y % slab;
    if (jx < 3 || jy < 3) {
      v -= 28 + (jx === 0 || jy === 0 ? 10 : 0);
    }

    // Form-tie holes
    const fx = (x + 17) % 64;
    const fy = (y + 29) % 64;
    if (fx * fx + fy * fy < 9) v -= 35;

    // Vertical water / soot staining
    if (runoff > 0.58 && (x % 37) < 9) {
      v -= (runoff - 0.58) * 85;
    }

    // Broad dirt / moss patches
    if (stain > 0.6) {
      v -= (stain - 0.6) * 95;
    } else if (stain < 0.28) {
      v += (0.28 - stain) * 25;
    }

    // Surface pitting
    if (pit > 0.97) v -= 40;

    // Faint form lines
    const form = Math.sin(y * 0.11) * 4;
    const cool = stain > 0.55 ? 6 : 0;
    return [v + form - 6 - cool, v + form - 2 - cool * 0.4, v + form + cool * 0.3];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 12 });
}

export function createMetalPlateTexture(
  size = 512,
  seed = 41,
  repeat: [number, number] = [2, 2],
  rustHeavy = false,
): THREE.CanvasTexture {
  const rng = mulberry32(seed);
  const rivets: Array<{ x: number; y: number }> = [];
  const panelsX = 4;
  const panelsY = 3;
  const pw = size / panelsX;
  const ph = size / panelsY;
  // Grid-aligned rivets along panel seams
  for (let py = 0; py < panelsY; py++) {
    for (let px = 0; px < panelsX; px++) {
      for (let e = 0; e < 6; e++) {
        rivets.push({
          x: px * pw + 6 + rng() * (pw - 12),
          y: py * ph + 4 + (e / 5) * (ph - 8),
        });
        rivets.push({
          x: px * pw + 4 + (e / 5) * (pw - 8),
          y: py * ph + 6 + rng() * (ph - 12),
        });
      }
    }
  }
  const rustThresh = rustHeavy ? 0.42 : 0.55;
  const image = fillImageData(size, (x, y) => {
    const panelX = Math.floor(x / pw);
    const panelY = Math.floor(y / ph);
    const panelShade = ((panelX + panelY) % 2) * 10;
    const rust = fbm2D(x, y, {
      seed: seed + 3,
      scale: rustHeavy ? 0.05 : 0.036,
      octaves: 5,
      persistence: 0.58,
    });
    const bloom = fbm2D(x * 1.4, y * 1.1, {
      seed: seed + 88,
      scale: 0.07,
      octaves: 3,
      persistence: 0.5,
    });
    const scratch =
      Math.abs(Math.sin(y * 0.55 + x * 0.018 + panelX)) < 0.018 ? 22 : 0;
    const oxidation = rustHeavy ? 1.35 : 1;

    let r = (rustHeavy ? 68 : 82) + panelShade + rust * 30 * oxidation + scratch;
    let g = (rustHeavy ? 48 : 66) + panelShade * 0.7 + rust * 14;
    let b = (rustHeavy ? 36 : 52) + panelShade * 0.5 + rust * 6;

    // Galvanized cool midtone patches
    if (!rustHeavy && rust < 0.35 && bloom < 0.4) {
      r += 8;
      g += 12;
      b += 16;
    }

    if (rust > rustThresh) {
      const t = (rust - rustThresh) * (rustHeavy ? 140 : 110);
      r += t * 0.95;
      g += t * 0.28;
      b -= t * 0.2;
    }
    if (bloom > 0.7 && rust > 0.5) {
      r += 28;
      g += 8;
      b -= 6;
    }

    // Seam lines
    const sx = x % pw;
    const sy = y % ph;
    if (sx < 2.5 || sy < 2.5) {
      r *= 0.5;
      g *= 0.5;
      b *= 0.5;
    }

    for (const rivet of rivets) {
      const dx = x - rivet.x;
      const dy = y - rivet.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < 8) {
        const edge = d2 < 3.5;
        r = edge ? 38 : 95;
        g = edge ? 36 : 88;
        b = edge ? 34 : 78;
        break;
      }
    }

    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 12 });
}

export function createBrickTexture(
  size = 512,
  seed = 57,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  const brickW = 36;
  const brickH = 16;
  const mortar = 4;
  const image = fillImageData(size, (x, y) => {
    const row = Math.floor(y / (brickH + mortar));
    const offset = (row % 2) * Math.floor(brickW * 0.5);
    const cell = brickW + mortar;
    // Positive modulo so wrap stays stable at texture edges
    const localX = (((x + offset) % cell) + cell) % cell;
    const localY = ((y % (brickH + mortar)) + (brickH + mortar)) % (brickH + mortar);
    const isMortar = localX < mortar || localY < mortar;
    if (isMortar) {
      const grit = hash2(x, y, seed);
      const m = 78 + grit * 28;
      // Dirtier mortar in streaks
      const dirty = fbm2D(x, y, {
        seed: seed + 4,
        scale: 0.06,
        octaves: 2,
        persistence: 0.5,
      });
      const d = dirty > 0.55 ? (dirty - 0.55) * 40 : 0;
      return [m - d, m - 4 - d, m - 10 - d];
    }
    const bx = Math.floor((x + offset) / cell);
    const by = row;
    const variation = hash2(bx, by, seed);
    const hueShift = hash2(bx, by, seed + 5);
    const chip = hash2(x, y, seed + 11);
    const damage = fbm2D(x, y, {
      seed: seed + 20,
      scale: 0.045,
      octaves: 4,
      persistence: 0.52,
    });
    const soot = fbm2D(bx * 3 + x * 0.02, y * 0.08, {
      seed: seed + 60,
      scale: 0.04,
      octaves: 3,
      persistence: 0.55,
    });

    // Per-brick palette: red clay → brown → scorched
    let r = 118 + variation * 55 + hueShift * 12;
    let g = 62 + variation * 28 + hueShift * 6;
    let b = 48 + variation * 18;

    if (hueShift > 0.72) {
      // Browner brick
      r -= 10;
      g += 8;
      b -= 4;
    } else if (hueShift < 0.2) {
      // Deeper red
      r += 18;
      g -= 8;
      b -= 6;
    }

    // Edge bevel darkening
    const edgeX = Math.min(localX - mortar, brickW - (localX - mortar));
    const edgeY = Math.min(localY - mortar, brickH - (localY - mortar));
    const edge = Math.min(edgeX, edgeY);
    if (edge < 2) {
      const e = (2 - edge) * 14;
      r -= e;
      g -= e;
      b -= e;
    }

    // War-torn plaster / whitewash patches
    if (damage > 0.66) {
      r = 172 + chip * 22;
      g = 162 + chip * 18;
      b = 148 + chip * 12;
    } else if (damage < 0.26) {
      r *= 0.68;
      g *= 0.64;
      b *= 0.6;
    }

    // Vertical soot wash
    if (soot > 0.58) {
      const s = (soot - 0.58) * 70;
      r -= s;
      g -= s * 0.9;
      b -= s * 0.75;
    }

    // Chip / spall
    if (chip > 0.945) {
      r -= 36;
      g -= 30;
      b -= 24;
    } else if (chip > 0.88 && chip < 0.9) {
      r += 20;
      g += 14;
      b += 8;
    }

    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 10 });
}

export function createCamoTarpTexture(
  size = 256,
  seed = 73,
  repeat: [number, number] = [2, 2],
): THREE.CanvasTexture {
  const palette = [
    [62, 78, 48],
    [92, 86, 54],
    [40, 52, 36],
    [110, 98, 62],
    [48, 58, 42],
    [76, 68, 44],
  ];
  const image = fillImageData(size, (x, y) => {
    const n1 = fbm2D(x, y, {
      seed,
      scale: 0.035,
      octaves: 4,
      persistence: 0.5,
    });
    const n2 = fbm2D(x + 40, y - 20, {
      seed: seed + 15,
      scale: 0.06,
      octaves: 3,
      persistence: 0.55,
    });
    const idx = Math.min(
      palette.length - 1,
      Math.floor((n1 * 0.7 + n2 * 0.3) * palette.length),
    );
    const [r, g, b] = palette[idx];
    const weave = ((x + y) % 4 === 0 ? -8 : 0) + ((x * 3 + y) % 7 === 0 ? 5 : 0);
    const fold = Math.sin(x * 0.04 + y * 0.02) * 6;
    return [r + weave + fold, g + weave + fold * 0.8, b + weave * 0.5 + fold * 0.4];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 8 });
}

export function createBloodSplatTexture(
  size = 128,
  seed = 99,
): THREE.CanvasTexture {
  const rng = mulberry32(seed);
  const blobs: Array<{ x: number; y: number; r: number; a: number }> = [];
  for (let i = 0; i < 18; i++) {
    blobs.push({
      x: size * (0.25 + rng() * 0.5),
      y: size * (0.25 + rng() * 0.5),
      r: 8 + rng() * 28,
      a: 140 + rng() * 90,
    });
  }
  for (let i = 0; i < 30; i++) {
    blobs.push({
      x: size * rng(),
      y: size * rng(),
      r: 1.5 + rng() * 4,
      a: 100 + rng() * 100,
    });
  }
  const image = fillImageData(size, (x, y) => {
    let a = 0;
    let r = 0;
    let g = 0;
    let b = 0;
    for (const blob of blobs) {
      const dx = x - blob.x;
      const dy = y - blob.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < blob.r) {
        const falloff = 1 - d / blob.r;
        const edge = falloff * falloff * (0.7 + hash2(x, y, seed) * 0.3);
        const contrib = blob.a * edge;
        if (contrib > a) {
          a = contrib;
          r = 110 + hash2(x, y, seed + 1) * 40;
          g = 8 + hash2(x, y, seed + 2) * 14;
          b = 8 + hash2(x, y, seed + 3) * 10;
        }
      }
    }
    return [r, g, b, a];
  });
  return makeCanvasTexture(image, {
    wrap: THREE.ClampToEdgeWrapping,
    anisotropy: 4,
  });
}

export function createPlasterTexture(
  size = 512,
  seed = 31,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, {
      seed,
      scale: 0.04,
      octaves: 5,
      persistence: 0.52,
    });
    const crackNoise = ridgeCrack(x, y, seed + 50, 0.06);
    const hair = ridgeCrack(x + 30, y, seed + 77, 0.11);
    let v = 158 + n * 38;
    if (crackNoise > 0.82) v -= (crackNoise - 0.82) * 160;
    if (hair > 0.88) v -= 28;
    const soot = fbm2D(x * 0.6, y * 0.6, {
      seed: seed + 8,
      scale: 0.02,
      octaves: 3,
      persistence: 0.6,
    });
    if (soot > 0.62) v -= (soot - 0.62) * 100;
    // Peeling underlayer (warmer)
    const peel = fbm2D(x, y, {
      seed: seed + 120,
      scale: 0.03,
      octaves: 3,
      persistence: 0.5,
    });
    let r = v + 6;
    let g = v;
    let b = v - 8;
    if (peel > 0.72) {
      r = 140 + n * 20;
      g = 118 + n * 16;
      b = 92 + n * 12;
    }
    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 10 });
}

export function createWoodCrateTexture(
  size = 256,
  seed = 19,
  repeat: [number, number] = [1, 1],
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const grain = Math.sin(y * 0.32 + Math.sin(x * 0.07) * 2.4) * 12;
    const n = valueNoise2D(x * 0.2, y * 0.05, seed);
    const knot = hash2(Math.floor(x / 18), Math.floor(y / 18), seed + 4);
    const band = x % 42 < 3 || y % 42 < 3 ? -28 : 0;
    let r = 122 + grain + n * 22 + band;
    let g = 88 + grain * 0.7 + n * 14 + band;
    let b = 50 + grain * 0.4 + n * 8 + band;
    if (knot > 0.86) {
      const k = (knot - 0.86) * 80;
      r -= k;
      g -= k * 0.8;
      b -= k * 0.5;
    }
    // Nail heads at plank corners
    const nx = x % 42;
    const ny = y % 42;
    if ((nx < 5 || nx > 37) && (ny < 5 || ny > 37) && hash2(x, y, seed) > 0.7) {
      r = 48;
      g = 46;
      b = 44;
    }
    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 8 });
}

/** Worn road paint / stencil markings. */
export function createRoadMarkTexture(
  size = 128,
  seed = 13,
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const n = valueNoise2D(x * 0.25, y * 0.25, seed);
    const wear = hash2(x, y, seed + 2);
    let v = 210 + n * 30;
    if (wear > 0.82) v -= 50;
    if (wear < 0.08) v -= 25;
    return [v, v - 4, v - 18];
  });
  return makeCanvasTexture(image, { repeat: [1, 1], anisotropy: 4 });
}

/** Shared material/texture kit used by the combat level. */
export class LevelTextureKit {
  readonly asphalt: THREE.CanvasTexture;
  readonly concrete: THREE.CanvasTexture;
  readonly metal: THREE.CanvasTexture;
  readonly metalRustMap: THREE.CanvasTexture;
  readonly brick: THREE.CanvasTexture;
  readonly dirt: THREE.CanvasTexture;
  readonly camo: THREE.CanvasTexture;
  readonly blood: THREE.CanvasTexture;
  readonly plaster: THREE.CanvasTexture;
  readonly wood: THREE.CanvasTexture;
  readonly roadMark: THREE.CanvasTexture;

  readonly matAsphalt: THREE.MeshStandardMaterial;
  readonly matConcrete: THREE.MeshStandardMaterial;
  readonly matConcreteDark: THREE.MeshStandardMaterial;
  readonly matBrick: THREE.MeshStandardMaterial;
  readonly matPlaster: THREE.MeshStandardMaterial;
  readonly matMetal: THREE.MeshStandardMaterial;
  readonly matMetalRust: THREE.MeshStandardMaterial;
  readonly matSandbag: THREE.MeshStandardMaterial;
  readonly matCamo: THREE.MeshStandardMaterial;
  readonly matWood: THREE.MeshStandardMaterial;
  readonly matDirt: THREE.MeshStandardMaterial;
  readonly matGlassBroken: THREE.MeshStandardMaterial;
  readonly matRoadMark: THREE.MeshStandardMaterial;
  readonly matBlood: THREE.MeshStandardMaterial;
  readonly matSilhouette: THREE.MeshBasicMaterial;
  readonly matTrim: THREE.MeshStandardMaterial;
  readonly matBarrel: THREE.MeshStandardMaterial;

  constructor(anisotropy = 8) {
    this.asphalt = makeAsphalt(512, 11, [12, 12]);
    this.concrete = makeConcrete(512, 23, [3.5, 3.5]);
    this.metal = makeMetal(512, 41, [2.2, 2.2]);
    this.metalRustMap = createMetalPlateTexture(512, 91, [2, 2], true);
    this.brick = makeBrick(512, 57, [2.8, 2.8]);
    this.dirt = makeDirt(256, 67, [5, 5]);
    this.camo = createCamoTarpTexture(256, 73, [1.5, 1.5]);
    this.blood = createBloodSplatTexture(128, 99);
    this.plaster = createPlasterTexture(512, 31, [2.5, 2.5]);
    this.wood = createWoodCrateTexture(256, 19, [1, 1]);
    this.roadMark = createRoadMarkTexture(128, 13);

    for (const t of [
      this.asphalt,
      this.concrete,
      this.metal,
      this.metalRustMap,
      this.brick,
      this.dirt,
      this.camo,
      this.plaster,
      this.wood,
      this.roadMark,
    ]) {
      t.anisotropy = anisotropy;
    }

    // Near-white tint multipliers so procedural maps read with full contrast.
    this.matAsphalt = new THREE.MeshStandardMaterial({
      map: this.asphalt,
      color: 0xb4b4b6,
      roughness: 0.94,
      metalness: 0.02,
    });
    this.matConcrete = new THREE.MeshStandardMaterial({
      map: this.concrete,
      color: 0xd2d0ca,
      roughness: 0.9,
      metalness: 0.03,
    });
    this.matConcreteDark = new THREE.MeshStandardMaterial({
      map: this.concrete,
      color: 0x7a7872,
      roughness: 0.92,
      metalness: 0.05,
    });
    this.matBrick = new THREE.MeshStandardMaterial({
      map: this.brick,
      color: 0xe8dcd0,
      roughness: 0.88,
      metalness: 0.02,
    });
    this.matPlaster = new THREE.MeshStandardMaterial({
      map: this.plaster,
      color: 0xe4ddd0,
      roughness: 0.91,
      metalness: 0.01,
    });
    this.matMetal = new THREE.MeshStandardMaterial({
      map: this.metal,
      color: 0xc4bbb2,
      roughness: 0.42,
      metalness: 0.82,
    });
    this.matMetalRust = new THREE.MeshStandardMaterial({
      map: this.metalRustMap,
      color: 0xc49a6a,
      roughness: 0.78,
      metalness: 0.42,
    });
    this.matSandbag = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0xc4b888,
      roughness: 0.96,
      metalness: 0.0,
    });
    this.matCamo = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0xb0a878,
      roughness: 0.9,
      metalness: 0.04,
    });
    this.matWood = new THREE.MeshStandardMaterial({
      map: this.wood,
      color: 0xd2b48c,
      roughness: 0.84,
      metalness: 0.02,
    });
    this.matDirt = new THREE.MeshStandardMaterial({
      map: this.dirt,
      color: 0x9a8060,
      roughness: 0.97,
      metalness: 0.0,
    });
    this.matGlassBroken = new THREE.MeshStandardMaterial({
      color: 0x7aa0b8,
      roughness: 0.12,
      metalness: 0.35,
      transparent: true,
      opacity: 0.32,
      side: THREE.DoubleSide,
      envMapIntensity: 0.6,
    });
    this.matRoadMark = new THREE.MeshStandardMaterial({
      map: this.roadMark,
      color: 0xf0e8d0,
      roughness: 0.88,
      metalness: 0.0,
    });
    this.matBlood = new THREE.MeshStandardMaterial({
      map: this.blood,
      transparent: true,
      depthWrite: false,
      roughness: 0.7,
      metalness: 0.0,
      side: THREE.DoubleSide,
    });
    // Unlit near-black so dusk skyline stays readable against sky/fog.
    this.matSilhouette = new THREE.MeshBasicMaterial({
      color: 0x06080e,
    });
    this.matTrim = new THREE.MeshStandardMaterial({
      map: this.metal,
      color: 0x3a3c40,
      roughness: 0.55,
      metalness: 0.65,
    });
    this.matBarrel = new THREE.MeshStandardMaterial({
      map: this.metalRustMap,
      color: 0x4a6a48,
      roughness: 0.7,
      metalness: 0.5,
    });
  }

  dispose(): void {
    const textures = [
      this.asphalt,
      this.concrete,
      this.metal,
      this.metalRustMap,
      this.brick,
      this.dirt,
      this.camo,
      this.blood,
      this.plaster,
      this.wood,
      this.roadMark,
    ];
    const mats = [
      this.matAsphalt,
      this.matConcrete,
      this.matConcreteDark,
      this.matBrick,
      this.matPlaster,
      this.matMetal,
      this.matMetalRust,
      this.matSandbag,
      this.matCamo,
      this.matWood,
      this.matDirt,
      this.matGlassBroken,
      this.matRoadMark,
      this.matBlood,
      this.matSilhouette,
      this.matTrim,
      this.matBarrel,
    ];
    for (const m of mats) m.dispose();
    for (const t of textures) t.dispose();
  }
}
