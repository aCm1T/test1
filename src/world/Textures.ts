import * as THREE from 'three';
import { assetUrl } from '../AssetPaths';
import { SurfaceFamily } from '../engine/StaticBatching';

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

/**
 * The development fallback intentionally has no authored normal/ORM package.
 * Derive a restrained response pair from its existing procedural albedo so the
 * near field still receives grazing-light and roughness breakup. This remains
 * entirely local/deterministic: it neither fetches assets nor participates in
 * the authored release contract.
 */
type SurfaceDetailMaps = {
  normal: THREE.CanvasTexture;
  roughness: THREE.CanvasTexture;
};

function createSurfaceDetailMaps(
  source: THREE.CanvasTexture,
  options: {
    name: string;
    normalStrength: number;
    roughnessVariation: number;
    size?: number;
    /**
     * Carves broad damp patches into the derived roughness. Dusk streets read
     * as prototype boxes largely because a uniformly rough plane returns no
     * specular; these low-frequency wet areas give the key and the practicals
     * something to graze across without needing an authored gloss map.
     */
    wetness?: number;
    wetSeed?: number;
  },
): SurfaceDetailMaps {
  const size = options.size ?? 256;
  const canvas = source.image;
  const context = canvas.getContext('2d', { willReadFrequently: true });
  if (!context) throw new Error(`Unable to derive ${options.name} material response`);
  const sourceWidth = canvas.width;
  const sourceHeight = canvas.height;
  const pixels = context.getImageData(0, 0, sourceWidth, sourceHeight).data;
  const normalPixels = new Uint8ClampedArray(size * size * 4);
  const roughnessPixels = new Uint8ClampedArray(size * size * 4);

  const sampleLuminance = (outputX: number, outputY: number): number => {
    const x = ((Math.floor((outputX / size) * sourceWidth) % sourceWidth) + sourceWidth) % sourceWidth;
    const y = ((Math.floor((outputY / size) * sourceHeight) % sourceHeight) + sourceHeight) % sourceHeight;
    const index = (y * sourceWidth + x) * 4;
    // Rec. 709 luminance keeps colorful rust/paint from becoming an exaggerated bump.
    return (pixels[index] * 0.2126 + pixels[index + 1] * 0.7152 + pixels[index + 2] * 0.0722) / 255;
  };

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const index = (y * size + x) * 4;
      const center = sampleLuminance(x, y);
      const dx = sampleLuminance(x + 1, y) - sampleLuminance(x - 1, y);
      const dy = sampleLuminance(x, y + 1) - sampleLuminance(x, y - 1);
      const localContrast = Math.min(1, (Math.abs(dx) + Math.abs(dy)) * 0.5);

      normalPixels[index] = clampByte(128 - dx * options.normalStrength * 126);
      normalPixels[index + 1] = clampByte(128 - dy * options.normalStrength * 126);
      normalPixels[index + 2] = 255;
      normalPixels[index + 3] = 255;

      // Bright worn surfaces read slightly smoother while dark porous detail
      // stays rough. Keep the multiplier close to one so material parameters
      // remain the dominant physical control.
      let response = Math.max(
        0.72,
        Math.min(
          1,
          1 - (center - 0.5) * options.roughnessVariation * 1.35
            - localContrast * options.roughnessVariation * 0.55,
        ),
      );

      if (options.wetness) {
        // Damp areas pool in the low-frequency depressions of the surface, so
        // the same noise band drives both the patch shape and its softness.
        const damp = fbm2D(x, y, {
          seed: options.wetSeed ?? 0x5745,
          scale: 0.012,
          octaves: 3,
          persistence: 0.55,
        });
        const pooled = Math.max(0, Math.min(1, (damp - 0.44) * 3.1));
        response *= 1 - pooled * options.wetness;
      }

      roughnessPixels[index] = 255;
      roughnessPixels[index + 1] = clampByte(response * 255);
      roughnessPixels[index + 2] = 255;
      roughnessPixels[index + 3] = 255;
    }
  }

  const repeat: [number, number] = [source.repeat.x, source.repeat.y];
  const normal = makeCanvasTexture(new ImageData(normalPixels, size, size), {
    repeat,
    anisotropy: source.anisotropy,
    colorSpace: THREE.NoColorSpace,
  });
  normal.name = `${options.name}DetailNormal`;
  const roughness = makeCanvasTexture(new ImageData(roughnessPixels, size, size), {
    repeat,
    anisotropy: source.anisotropy,
    colorSpace: THREE.NoColorSpace,
  });
  roughness.name = `${options.name}DetailRoughness`;
  return { normal, roughness };
}

/**
 * Shallow standing-water normal. The ripples are low-amplitude and irregular
 * so a puddle distorts the reflected skyline and window practicals instead of
 * mirroring them as a hard, obviously flat cutout.
 */
function createWetRippleNormalTexture(size = 256, seed = 0x5741): THREE.CanvasTexture {
  const height = (x: number, y: number): number => {
    const broad = fbm2D(x, y, { seed, scale: 0.021, octaves: 3, persistence: 0.55 });
    const ring = Math.sin((x * 0.09 + y * 0.055) + broad * 6.2) * 0.5 + 0.5;
    const fine = fbm2D(x, y, { seed: seed + 17, scale: 0.085, octaves: 2, persistence: 0.5 });
    return broad * 0.55 + ring * 0.28 + fine * 0.17;
  };
  const image = fillImageData(size, (x, y) => {
    const dx = height(x + 1, y) - height(x - 1, y);
    const dy = height(x, y + 1) - height(x, y - 1);
    return [128 - dx * 210, 128 - dy * 210, 255];
  });
  const texture = makeCanvasTexture(image, {
    repeat: [1, 1],
    anisotropy: 8,
    colorSpace: THREE.NoColorSpace,
  });
  texture.name = 'NightglassWetRippleNormal';
  return texture;
}

/**
 * Soft additive halo for street practicals. A dusk city reads as atmospheric
 * because lamps scatter in the air around them; a two-triangle billboard is
 * far cheaper than volumetrics and survives every quality tier.
 */
function createLampGlowTexture(size = 128): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const nx = (x + 0.5) / size * 2 - 1;
    const ny = (y + 0.5) / size * 2 - 1;
    const radius = Math.min(1, Math.sqrt(nx * nx + ny * ny));
    // Tight core for the source; short, weak skirt so bloom doesn't turn
    // every practical into a soft circular card.
    const core = Math.exp(-radius * radius * 34) * 0.9;
    const skirt = Math.pow(Math.max(0, 1 - radius), 3.4) * 0.22;
    const falloff = Math.min(1, core + skirt);
    return [255, 214 - radius * 52, 158 - radius * 74, falloff * 255];
  });
  const texture = makeCanvasTexture(image, {
    wrap: THREE.ClampToEdgeWrapping,
    anisotropy: 2,
  });
  texture.name = 'NightglassLampGlow';
  return texture;
}

/**
 * Radial falloff for the damp-road sheen discs.
 *
 * `alphaMap` samples the green channel, so the mask is written as greyscale
 * rather than alpha. Without it the discs terminate on their tessellated
 * outline and the street gains a ring of hard-edged polygons wherever a
 * practical spills onto it; wetness has no edge, so neither should these.
 */
function createWetSheenMaskTexture(size = 128, seed = 0x7d31): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const nx = (x + 0.5) / size * 2 - 1;
    const ny = (y + 0.5) / size * 2 - 1;
    const radius = Math.sqrt(nx * nx + ny * ny);
    // Breaking the boundary with noise keeps the damp area from reading as a
    // stencilled circle once several of them overlap.
    const edge = fbm2D(x, y, { seed, scale: 0.05, octaves: 3, persistence: 0.5 });
    const feather = Math.max(0, Math.min(1, (0.92 - radius + (edge - 0.5) * 0.26) / 0.55));
    const mask = feather * feather * (3 - 2 * feather);
    return [mask * 255, mask * 255, mask * 255];
  });
  const texture = makeCanvasTexture(image, {
    wrap: THREE.ClampToEdgeWrapping,
    anisotropy: 2,
    colorSpace: THREE.NoColorSpace,
  });
  texture.name = 'NightglassWetSheenMask';
  return texture;
}

/** A cheap soft mask for visual-only prop contact shadows. */
function createSoftContactShadowTexture(size = 128): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const nx = (x + 0.5) / size * 2 - 1;
    const ny = (y + 0.5) / size * 2 - 1;
    const radius = Math.sqrt(nx * nx + ny * ny);
    const feather = Math.max(0, Math.min(1, (0.98 - radius) / 0.42));
    const alpha = feather * feather * (3 - 2 * feather);
    return [0, 0, 0, alpha * 235];
  });
  const texture = makeCanvasTexture(image, {
    wrap: THREE.ClampToEdgeWrapping,
    anisotropy: 4,
    colorSpace: THREE.NoColorSpace,
  });
  texture.name = 'NightglassSoftContactShadow';
  return texture;
}

type DevelopmentPbrSurface = 'asphalt' | 'concrete' | 'plaster';

export type DevelopmentPbrLoadReport = {
  installed: DevelopmentPbrSurface[];
  failed: DevelopmentPbrSurface[];
};

type DevelopmentPbrMaps = {
  color: THREE.Texture;
  normal: THREE.Texture;
  arm: THREE.Texture;
};

const DEVELOPMENT_PBR_ROOT = assetUrl('assets/development/polyhaven').replace(/\/$/, '');

const DEVELOPMENT_PBR_FILES: Record<DevelopmentPbrSurface, {
  color: string;
  normal: string;
  arm: string;
  repeat: [number, number];
}> = {
  asphalt: {
    color: 'asphalt_01_diff_1k.jpg',
    normal: 'asphalt_01_nor_gl_1k.jpg',
    arm: 'asphalt_01_arm_1k.jpg',
    repeat: [24, 24],
  },
  concrete: {
    color: 'concrete_floor_diff_1k.jpg',
    normal: 'concrete_floor_nor_gl_1k.jpg',
    arm: 'concrete_floor_arm_1k.jpg',
    repeat: [6, 6],
  },
  plaster: {
    color: 'yellow_plaster_diff_1k.jpg',
    normal: 'yellow_plaster_nor_gl_1k.jpg',
    arm: 'yellow_plaster_arm_1k.jpg',
    repeat: [3.5, 3.5],
  },
};

function loadTexture(loader: THREE.TextureLoader, url: string): Promise<THREE.Texture> {
  return new Promise((resolve, reject) => {
    loader.load(url, resolve, undefined, () => reject(new Error(`Failed to load ${url}`)));
  });
}

function configureDevelopmentPbrTexture(
  texture: THREE.Texture,
  repeat: [number, number],
  anisotropy: number,
  colorSpace: THREE.ColorSpace,
): THREE.Texture {
  configureTexture(texture, { repeat, anisotropy, colorSpace });
  texture.minFilter = THREE.LinearMipmapLinearFilter;
  texture.magFilter = THREE.LinearFilter;
  return texture;
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
    let r = 98 + n * 38 + grit * 16;
    let g = 72 + n * 28 + grit * 12;
    let b = 48 + n * 18 + grit * 8;
    if (pebble > 0.9) {
      r += 28;
      g += 22;
      b += 14;
    } else if (pebble < 0.06) {
      r -= 14;
      g -= 10;
      b -= 8;
    }
    if (moist > 0.62) {
      const m = (moist - 0.62) * 40;
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

/**
 * Painted facade cladding: faded municipal blue, rain streaks, and small areas
 * of exposed primer.  It is deliberately subdued so it reads as a material,
 * not a repeating graphic, at first-person distances.
 */
export function createFacadePanelTexture(
  size = 512,
  seed = 137,
  repeat: [number, number] = [2, 2],
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const broad = fbm2D(x, y, { seed, scale: 0.013, octaves: 4, persistence: 0.55 });
    const fine = fbm2D(x, y, { seed: seed + 31, scale: 0.09, octaves: 3, persistence: 0.5 });
    const panel = Math.abs(((x + 9) % 104) - 52) < 1.5;
    const seam = panel ? -24 : 0;
    const streak = valueNoise2D(Math.floor(x / 13), Math.floor(y / 67), seed + 71);
    const rain = streak > 0.86 && (y % 67) > 11 ? -16 * (streak - 0.86) * 7 : 0;
    const flake = hash2(x, y, seed + 103) > 0.996 ? 28 : 0;
    return [54 + broad * 36 + fine * 10 + seam + rain + flake, 83 + broad * 40 + fine * 8 + seam + rain, 91 + broad * 44 + fine * 8 + seam + rain];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 10 });
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
    const agg = fine > 0.93 ? 22 : fine < 0.05 ? -10 : 0;

    // Hot mid asphalt (~0.62–0.78 luminance, warm bias) — cool hemi + ACES
    // previously crushed this into a featureless blue void in screenshots.
    let base = 158 + n * 42 + grit * 22 + wear * 16 + agg;
    // Faded traffic lane polish (slightly lighter bands)
    const lane = Math.abs(((x / size) * 10) % 1 - 0.5);
    if (lane < 0.08) base += 18;

    // Warm gray (extra R, pull B) so sky fill can't paint the street cyan.
    let r = base + grit * 6 + 10;
    let g = base + grit * 4 + 2;
    let b = base + grit * 2 - 14;

    if (oil > 0.68) {
      const o = (oil - 0.68) * 55;
      r -= o * 0.35;
      g -= o * 0.28;
      b -= o * 0.2;
    }

    if (crack > 0) {
      const k = Math.min(1, crack);
      r -= 18 * k;
      g -= 16 * k;
      b -= 14 * k;
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

    let v = 168 + n * 36 + speck * 18;

    // Expansion joints / slab grid
    const jx = x % slab;
    const jy = y % slab;
    if (jx < 3 || jy < 3) {
      v -= 24 + (jx === 0 || jy === 0 ? 8 : 0);
    }

    // Form-tie holes
    const fx = (x + 17) % 64;
    const fy = (y + 29) % 64;
    if (fx * fx + fy * fy < 9) v -= 28;

    // Vertical water / soot staining
    if (runoff > 0.58 && (x % 37) < 9) {
      v -= (runoff - 0.58) * 70;
    }

    // Broad dirt / moss patches
    if (stain > 0.6) {
      v -= (stain - 0.6) * 75;
    } else if (stain < 0.28) {
      v += (0.28 - stain) * 28;
    }

    // Surface pitting
    if (pit > 0.97) v -= 32;

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

    let r = (rustHeavy ? 82 : 98) + panelShade + rust * 30 * oxidation + scratch;
    let g = (rustHeavy ? 60 : 80) + panelShade * 0.7 + rust * 14;
    let b = (rustHeavy ? 46 : 66) + panelShade * 0.5 + rust * 6;

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
      const m = 98 + grit * 28;
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

    // Per-brick palette: red clay → brown → scorched (mid luminance for dusk)
    let r = 138 + variation * 50 + hueShift * 12;
    let g = 78 + variation * 28 + hueShift * 6;
    let b = 60 + variation * 18;

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
    [78, 92, 58],
    [108, 100, 64],
    [58, 68, 48],
    [122, 108, 72],
    [64, 74, 54],
    [90, 80, 56],
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
    let v = 172 + n * 38;
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
  readonly facadePanel: THREE.CanvasTexture;

  private readonly asphaltDetail: SurfaceDetailMaps;
  private readonly concreteDetail: SurfaceDetailMaps;
  private readonly metalDetail: SurfaceDetailMaps;
  private readonly metalRustDetail: SurfaceDetailMaps;
  private readonly brickDetail: SurfaceDetailMaps;
  private readonly plasterDetail: SurfaceDetailMaps;
  private readonly woodDetail: SurfaceDetailMaps;
  private readonly facadeDetail: SurfaceDetailMaps;
  private readonly contactShadowTexture: THREE.CanvasTexture;
  private readonly wetRippleNormal: THREE.CanvasTexture;
  private readonly wetSheenMask: THREE.CanvasTexture;
  private readonly lampGlowTexture: THREE.CanvasTexture;

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
  readonly matWindowLit: THREE.MeshStandardMaterial;
  readonly matWindowLitCool: THREE.MeshStandardMaterial;
  readonly matLampBulb: THREE.MeshStandardMaterial;
  readonly matStreetDeck: THREE.MeshStandardMaterial;
  readonly matRoadMark: THREE.MeshStandardMaterial;
  readonly matBlood: THREE.MeshStandardMaterial;
  readonly matSilhouette: THREE.MeshStandardMaterial;
  readonly matContactShadow: THREE.MeshBasicMaterial;
  readonly matTrim: THREE.MeshStandardMaterial;
  readonly matBarrel: THREE.MeshStandardMaterial;
  readonly matFacadePaint: THREE.MeshStandardMaterial;
  readonly matSafetyPaint: THREE.MeshStandardMaterial;
  readonly matPuddle: THREE.MeshStandardMaterial;
  /** Broad damp sheen for road areas that are wet but not standing water. */
  readonly matWetSheen: THREE.MeshStandardMaterial;
  /** Additive halo billboard shared by every street practical. */
  readonly matLampGlow: THREE.SpriteMaterial;
  /** Mapped kit sets that Level merges across colour variants (e.g. camo tarp). */
  readonly surfaceFamilies: readonly SurfaceFamily[];

  /** External development textures, separate from the procedural baseline. */
  private readonly developmentPbrTextures: THREE.Texture[] = [];
  private developmentPbrPromise: Promise<DevelopmentPbrLoadReport> | null = null;
  private disposed = false;

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
    this.facadePanel = createFacadePanelTexture(512, 137, [2.2, 2.2]);

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
      this.facadePanel,
    ]) {
      t.anisotropy = anisotropy;
    }

    // Fallback-only response maps make the close playable route react to the
    // same directional/IBL lighting as imported PBR props. Source albedo
    // remains untouched and supplied PBR maps still replace these on install.
    this.asphaltDetail = createSurfaceDetailMaps(this.asphalt, {
      name: 'Asphalt', normalStrength: 0.86, roughnessVariation: 0.24,
      // Cap wet pooling — prior dusk captures still showed a greasy white disc
      // under practicals when wetness pushed roughness too far toward mirror.
      wetness: 0.22, wetSeed: 0x41535048,
    });
    this.concreteDetail = createSurfaceDetailMaps(this.concrete, {
      name: 'Concrete', normalStrength: 0.68, roughnessVariation: 0.2,
      wetness: 0.18, wetSeed: 0x434f4e43,
    });
    this.metalDetail = createSurfaceDetailMaps(this.metal, {
      name: 'Metal', normalStrength: 0.9, roughnessVariation: 0.3,
    });
    this.metalRustDetail = createSurfaceDetailMaps(this.metalRustMap, {
      name: 'Rust', normalStrength: 0.82, roughnessVariation: 0.24,
    });
    this.brickDetail = createSurfaceDetailMaps(this.brick, {
      name: 'Brick', normalStrength: 0.62, roughnessVariation: 0.16,
    });
    this.plasterDetail = createSurfaceDetailMaps(this.plaster, {
      name: 'Plaster', normalStrength: 0.48, roughnessVariation: 0.14,
    });
    this.woodDetail = createSurfaceDetailMaps(this.wood, {
      name: 'Wood', normalStrength: 0.6, roughnessVariation: 0.18,
    });
    this.facadeDetail = createSurfaceDetailMaps(this.facadePanel, {
      name: 'Facade', normalStrength: 0.42, roughnessVariation: 0.15,
    });
    this.contactShadowTexture = createSoftContactShadowTexture();
    this.wetRippleNormal = createWetRippleNormalTexture();
    this.wetSheenMask = createWetSheenMaskTexture();
    this.lampGlowTexture = createLampGlowTexture();

    // Physically restrained albedo multipliers; lighting supplies the dusk value range.
    //
    // These multipliers carry the frame's value pyramid. A dusk street photograph
    // is ordered sky and practicals brightest, facades mid, road darkest; if the
    // ground and the barricades return more light than the sky behind them the
    // result reads as a brightly lit daytime blockout no matter how the grade
    // and the tone curve are tuned afterwards.
    // A dusk street is never bone dry. Practicals should graze the road, not
    // mint a near-white specular disc in the lower third of the frame.
    this.matAsphalt = new THREE.MeshStandardMaterial({
      map: this.asphalt,
      normalMap: this.asphaltDetail.normal,
      normalScale: new THREE.Vector2(0.62, 0.62),
      roughnessMap: this.asphaltDetail.roughness,
      color: 0x3a3733,
      roughness: 0.88,
      metalness: 0.04,
      envMapIntensity: 0.55,
      // Ground stays lit by key/hemi — no self-glow toe that lifts umbras.
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    this.matConcrete = new THREE.MeshStandardMaterial({
      map: this.concrete,
      normalMap: this.concreteDetail.normal,
      normalScale: new THREE.Vector2(0.34, 0.34),
      roughnessMap: this.concreteDetail.roughness,
      color: 0x5d5b56,
      roughness: 0.92,
      metalness: 0.03,
      envMapIntensity: 0.5,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    this.matConcreteDark = new THREE.MeshStandardMaterial({
      map: this.concrete,
      normalMap: this.concreteDetail.normal,
      normalScale: new THREE.Vector2(0.28, 0.28),
      roughnessMap: this.concreteDetail.roughness,
      color: 0x424039,
      roughness: 0.94,
      metalness: 0.05,
      envMapIntensity: 0.4,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    this.matBrick = new THREE.MeshStandardMaterial({
      map: this.brick,
      normalMap: this.brickDetail.normal,
      normalScale: new THREE.Vector2(0.36, 0.36),
      roughnessMap: this.brickDetail.roughness,
      color: 0x6a5750,
      roughness: 0.91,
      metalness: 0.02,
      emissive: 0x1a0e0a,
      emissiveIntensity: 0.015,
    });
    this.matPlaster = new THREE.MeshStandardMaterial({
      map: this.plaster,
      normalMap: this.plasterDetail.normal,
      normalScale: new THREE.Vector2(0.26, 0.26),
      roughnessMap: this.plasterDetail.roughness,
      color: 0x605c55,
      roughness: 0.94,
      metalness: 0.01,
      emissive: 0x141210,
      emissiveIntensity: 0.015,
    });
    // Weathered urban steel, not showroom chrome. A near-mirror metal has no
    // diffuse term at all, so under a dusk sky its horizontal faces — road
    // plates, hatches, deck grating — reflect only the near-black zenith and
    // read as holes cut through the street. Broadening the lobe averages in the
    // horizon band and the lamp spill instead, which is what makes the metal
    // read as metal at this hour.
    this.matMetal = new THREE.MeshStandardMaterial({
      map: this.metal,
      normalMap: this.metalDetail.normal,
      normalScale: new THREE.Vector2(0.46, 0.46),
      roughnessMap: this.metalDetail.roughness,
      color: 0x6a6e73,
      roughness: 0.55,
      metalness: 0.72,
      envMapIntensity: 1.35,
    });
    this.matMetalRust = new THREE.MeshStandardMaterial({
      map: this.metalRustMap,
      normalMap: this.metalRustDetail.normal,
      normalScale: new THREE.Vector2(0.42, 0.42),
      roughnessMap: this.metalRustDetail.roughness,
      color: 0x655c54,
      roughness: 0.78,
      metalness: 0.42,
    });
    this.matSandbag = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0x6b6659,
      roughness: 0.96,
      metalness: 0.0,
    });
    this.matCamo = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0x7b806e,
      roughness: 0.9,
      metalness: 0.04,
    });
    this.matWood = new THREE.MeshStandardMaterial({
      map: this.wood,
      normalMap: this.woodDetail.normal,
      normalScale: new THREE.Vector2(0.3, 0.3),
      roughnessMap: this.woodDetail.roughness,
      color: 0x6f6050,
      roughness: 0.9,
      metalness: 0.02,
    });
    this.matDirt = new THREE.MeshStandardMaterial({
      map: this.dirt,
      color: 0x897660,
      roughness: 0.97,
      metalness: 0.0,
    });
    this.matGlassBroken = new THREE.MeshStandardMaterial({
      color: 0x8ab0c8,
      roughness: 0.12,
      metalness: 0.24,
      transparent: true,
      opacity: 0.42,
      side: THREE.DoubleSide,
      envMapIntensity: 1.35,
      emissive: 0x1a2838,
      emissiveIntensity: 0.55,
    });
    // Practicals are the only surfaces authored above 1.0 scene-referred, so
    // the bloom threshold isolates them from lit geometry. Below the previous
    // values every window resolved under the threshold and the dusk skyline
    // photographed as unlit grey massing.
    this.matWindowLit = new THREE.MeshStandardMaterial({
      color: 0xb88458,
      roughness: 0.4,
      metalness: 0.04,
      emissive: 0xc56e28,
      // Hot enough to clear the bloom threshold; below the prior 4.x values
      // so panes light the facade without blooming into soft circular discs.
      emissiveIntensity: 2.55,
    });
    this.matWindowLitCool = new THREE.MeshStandardMaterial({
      color: 0x7192a8,
      roughness: 0.35,
      metalness: 0.06,
      emissive: 0x426b88,
      emissiveIntensity: 2.05,
    });
    // Streetlamp bulb — small hot point for dusk bloom.
    this.matLampBulb = new THREE.MeshStandardMaterial({
      color: 0xc9a777,
      roughness: 0.35,
      metalness: 0.05,
      emissive: 0xffcc66,
      emissiveIntensity: 2.45,
    });
    // The player spends most of the match looking at this surface. Keep the
    // old readable value, but let it receive CSM, IBL, normal and roughness
    // response instead of rendering as a flat Lambert overlay.
    this.matStreetDeck = new THREE.MeshStandardMaterial({
      map: this.asphalt,
      normalMap: this.asphaltDetail.normal,
      normalScale: new THREE.Vector2(0.52, 0.52),
      roughnessMap: this.asphaltDetail.roughness,
      color: 0x3d3a36,
      roughness: 0.86,
      metalness: 0.04,
      envMapIntensity: 0.58,
      emissive: 0x000000,
      emissiveIntensity: 0,
    });
    // Weathered road paint. It only has to stay legible against asphalt; pushed
    // any brighter it becomes the lightest mass in the lower frame and the warm
    // bias in its noise starts reading as timber decking rather than paint.
    this.matRoadMark = new THREE.MeshStandardMaterial({
      map: this.roadMark,
      color: 0x5c594f,
      roughness: 0.86,
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
    // Mid charcoal skyline (NOT pure black) + slight warm so dusk sun rims catch.
    this.matSilhouette = new THREE.MeshStandardMaterial({
      map: this.concrete,
      color: 0x6a7382,
      roughness: 0.88,
      metalness: 0.06,
      envMapIntensity: 0.35,
      emissive: 0x141820,
      emissiveIntensity: 0.1,
    });
    // Soft blob under props / vehicles so they don't float over asphalt.
    // Keep this restrained — higher values read as black discs under hostiles.
    this.matContactShadow = new THREE.MeshBasicMaterial({
      color: 0x000000,
      map: this.contactShadowTexture,
      transparent: true,
      opacity: 0.52,
      depthWrite: false,
    });
    // Trim / facade paint / safety paint are deliberately untextured kit mates:
    // colour, roughness and metalness bake into the Level static batches so the
    // three reads share submissions without dropping any of the dressing.
    this.matTrim = new THREE.MeshStandardMaterial({
      color: 0x83878b,
      roughness: 0.5,
      metalness: 0.68,
      envMapIntensity: 0.7,
    });
    this.matBarrel = new THREE.MeshStandardMaterial({
      map: this.metalRustMap,
      color: 0x8aaa78,
      roughness: 0.7,
      metalness: 0.5,
    });
    this.matFacadePaint = new THREE.MeshStandardMaterial({
      color: 0x4b6167,
      roughness: 0.74,
      metalness: 0.2,
      envMapIntensity: 0.7,
    });
    this.matSafetyPaint = new THREE.MeshStandardMaterial({
      color: 0xc48c38,
      roughness: 0.5,
      metalness: 0.32,
      emissive: 0x331b06,
      emissiveIntensity: 0.08,
      envMapIntensity: 0.7,
    });
    // Standing water behaves as a smooth dielectric: nearly no reflection when
    // looked straight down at, a strong one at the grazing angles that dominate
    // a first-person view. Letting Fresnel do that work is what stops puddles
    // from reading as the flat grey wedges the previous rough setup produced.
    this.matPuddle = new THREE.MeshStandardMaterial({
      color: 0x1d242c,
      normalMap: this.wetRippleNormal,
      normalScale: new THREE.Vector2(0.22, 0.22),
      roughness: 0.075,
      metalness: 0.0,
      transparent: true,
      // Partial coverage keeps the asphalt's grain reading through the water.
      // At full strength the pool becomes an opaque black hole in the road,
      // because a smooth dielectric viewed near-normal reflects almost nothing.
      opacity: 0.55,
      depthWrite: false,
      // Grazing Fresnel still catches skyline/practicals; the prior 2.4 read as
      // orphan specular foil under dusk IBL.
      envMapIntensity: 1.35,
    });
    // The transition ring around standing water; damp but not pooled.
    //
    // Purely additive specular: black albedo contributes no diffuse, so this
    // layer can only ever add the sky's and the practicals' reflection to
    // whatever road, kerb or deck it lies on. An alpha-blended version of the
    // same idea darkens instead — these discs sit under every practical and
    // around every pool, so they overlap several deep, and each one replaces a
    // slice of the surface beneath with a dimmer value until the street reads
    // as black patches. Wetness brightens under lamps; it never punches holes.
    this.matWetSheen = new THREE.MeshStandardMaterial({
      color: 0x000000,
      normalMap: this.wetRippleNormal,
      normalScale: new THREE.Vector2(0.1, 0.1),
      alphaMap: this.wetSheenMask,
      roughness: 0.26,
      metalness: 0.0,
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
      // Enough sheen to read damp under lamps without plastic-foil specular.
      envMapIntensity: 1.05,
    });
    this.matLampGlow = new THREE.SpriteMaterial({
      map: this.lampGlowTexture,
      // Mildly super-unity so the halo still clears bloom, but far below the
      // prior ~2.3 HDR card that bloomed into huge soft discs.
      color: new THREE.Color(1.35, 0.98, 0.62),
      blending: THREE.AdditiveBlending,
      transparent: true,
      depthWrite: false,
      fog: true,
    });

    // Camo tarp / sandbag share one albedo; Level folds them with preferPlainFamily
    // so untextured trim never inherits this USE_MAP program.
    this.surfaceFamilies = [
      new SurfaceFamily('level-camo', { map: this.camo }),
    ];
  }

  /**
   * Opt-in visual uplift for the procedural development route. These CC0 maps
   * are intentionally not part of the authored asset registry or release
   * contract. Each surface is all-or-nothing so a failed normal/ARM request
   * leaves its original procedural material untouched.
   */
  loadDevelopmentPbrMaps(): Promise<DevelopmentPbrLoadReport> {
    if (this.developmentPbrPromise) return this.developmentPbrPromise;

    this.developmentPbrPromise = this.loadDevelopmentPbrMapsInternal();
    return this.developmentPbrPromise;
  }

  private async loadDevelopmentPbrMapsInternal(): Promise<DevelopmentPbrLoadReport> {
    const loader = new THREE.TextureLoader();
    const surfaces = Object.entries(DEVELOPMENT_PBR_FILES) as Array<[
      DevelopmentPbrSurface,
      (typeof DEVELOPMENT_PBR_FILES)[DevelopmentPbrSurface],
    ]>;
    const outcomes = await Promise.all(surfaces.map(async ([surface, files]) => {
      try {
        const loaded = await Promise.allSettled([
          loadTexture(loader, `${DEVELOPMENT_PBR_ROOT}/${files.color}`),
          loadTexture(loader, `${DEVELOPMENT_PBR_ROOT}/${files.normal}`),
          loadTexture(loader, `${DEVELOPMENT_PBR_ROOT}/${files.arm}`),
        ]);
        if (loaded.some((result) => result.status === 'rejected')) {
          for (const result of loaded) {
            if (result.status === 'fulfilled') result.value.dispose();
          }
          throw new Error(`One or more ${surface} PBR maps failed to load`);
        }
        const [color, normal, arm] = loaded.map((result) => {
          if (result.status !== 'fulfilled') throw new Error(`Unexpected ${surface} PBR load state`);
          return result.value;
        });
        const maps: DevelopmentPbrMaps = { color, normal, arm };
        if (this.disposed) {
          color.dispose();
          normal.dispose();
          arm.dispose();
          return { surface, installed: false };
        }
        this.configureDevelopmentSurface(surface, maps, files.repeat);
        this.developmentPbrTextures.push(color, normal, arm);
        return { surface, installed: true };
      } catch (error) {
        // This path is deliberately quiet for play: the procedural map remains
        // installed. Keep a useful diagnostic for local asset troubleshooting.
        console.warn(`[development-pbr] ${surface} maps unavailable; keeping procedural fallback`, error);
        return { surface, installed: false };
      }
    }));

    return {
      installed: outcomes.filter((outcome) => outcome.installed).map((outcome) => outcome.surface),
      failed: outcomes.filter((outcome) => !outcome.installed).map((outcome) => outcome.surface),
    };
  }

  private configureDevelopmentSurface(
    surface: DevelopmentPbrSurface,
    maps: DevelopmentPbrMaps,
    repeat: [number, number],
  ): void {
    configureDevelopmentPbrTexture(maps.color, repeat, this.asphalt.anisotropy, THREE.SRGBColorSpace);
    configureDevelopmentPbrTexture(maps.normal, repeat, this.asphalt.anisotropy, THREE.NoColorSpace);
    configureDevelopmentPbrTexture(maps.arm, repeat, this.asphalt.anisotropy, THREE.NoColorSpace);

    const apply = (material: THREE.MeshStandardMaterial) => {
      material.map = maps.color;
      material.normalMap = maps.normal;
      // Poly Haven's ARM convention is occlusion/roughness/metallic in RGB.
      // Three reads roughness from G and metalness from B, so one texture can
      // safely serve both maps without a shader fork. We avoid aoMap because
      // the blockout's BoxGeometry does not provide a UV2 channel.
      material.roughnessMap = maps.arm;
      material.metalnessMap = maps.arm;
      material.needsUpdate = true;
    };

    if (surface === 'asphalt') {
      apply(this.matAsphalt);
      apply(this.matStreetDeck);
      // Poly Haven's ARM roughness is authored for a dry studio reference.
      // Scaling it down preserves the map's variation while keeping the same
      // damp dusk finish the procedural route was tuned around.
      for (const material of [this.matAsphalt, this.matStreetDeck]) {
        // Asphalt reflects under a tenth of the light that falls on it. Near
        // unity the road returned more than the sky above it, which inverts
        // the frame's value pyramid and is the single loudest prototype tell.
        material.color.setRGB(0.34, 0.33, 0.32);
        material.roughness = 0.88;
        material.envMapIntensity = 0.55;
        // A 1k tile stretched over metres of road turns this map's macro
        // variation into fist-sized relief; the street reads as crumpled foil
        // rather than as grain sitting below the pixel.
        material.normalScale.set(0.42, 0.42);
      }
      return;
    }
    if (surface === 'concrete') {
      apply(this.matConcrete);
      apply(this.matConcreteDark);
      this.matConcrete.color.setRGB(0.52, 0.51, 0.49);
      // Preserve the intentionally darker curb/trim variant while replacing
      // its flat procedural pattern with the same physically based surface.
      this.matConcreteDark.color.setRGB(0.34, 0.34, 0.33);
      for (const material of [this.matConcrete, this.matConcreteDark]) {
        material.normalScale.set(0.6, 0.6);
      }
      return;
    }
    apply(this.matPlaster);
    this.matPlaster.color.setRGB(0.44, 0.43, 0.41);
    this.matPlaster.normalScale.set(0.5, 0.5);
  }

  dispose(): void {
    this.disposed = true;
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
      this.facadePanel,
      this.asphaltDetail.normal,
      this.asphaltDetail.roughness,
      this.concreteDetail.normal,
      this.concreteDetail.roughness,
      this.metalDetail.normal,
      this.metalDetail.roughness,
      this.metalRustDetail.normal,
      this.metalRustDetail.roughness,
      this.brickDetail.normal,
      this.brickDetail.roughness,
      this.plasterDetail.normal,
      this.plasterDetail.roughness,
      this.woodDetail.normal,
      this.woodDetail.roughness,
      this.facadeDetail.normal,
      this.facadeDetail.roughness,
      this.contactShadowTexture,
      this.wetRippleNormal,
      this.wetSheenMask,
      this.lampGlowTexture,
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
      this.matWindowLit,
      this.matWindowLitCool,
      this.matLampBulb,
      this.matStreetDeck,
      this.matRoadMark,
      this.matBlood,
      this.matSilhouette,
      this.matContactShadow,
      this.matTrim,
      this.matBarrel,
      this.matFacadePaint,
      this.matSafetyPaint,
      this.matPuddle,
      this.matWetSheen,
      this.matLampGlow,
    ];
    for (const m of mats) m.dispose();
    for (const t of textures) t.dispose();
    for (const t of this.developmentPbrTextures) t.dispose();
    this.developmentPbrTextures.length = 0;
  }
}
