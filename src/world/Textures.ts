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
  size = 256,
  seed = 11,
  repeat: [number, number] = [8, 8],
): THREE.CanvasTexture {
  return createAsphaltTexture(size, seed, repeat);
}

/** Procedural concrete slabs / sidewalks. */
export function makeConcrete(
  size = 256,
  seed = 23,
  repeat: [number, number] = [4, 4],
): THREE.CanvasTexture {
  return createConcreteTexture(size, seed, repeat);
}

/** Procedural brick wall. */
export function makeBrick(
  size = 256,
  seed = 57,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  return createBrickTexture(size, seed, repeat);
}

/** Procedural metal plate with rivets / rust. */
export function makeMetal(
  size = 256,
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
    let r = 78 + n * 36 + grit * 14;
    let g = 58 + n * 28 + grit * 10;
    let b = 36 + n * 18 + grit * 6;
    if (pebble > 0.92) {
      r += 22;
      g += 18;
      b += 12;
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
  size = 256,
  seed = 11,
  repeat: [number, number] = [8, 8],
): THREE.CanvasTexture {
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.045,
    octaves: 5,
    persistence: 0.55,
  };
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const grit = valueNoise2D(x * 0.35, y * 0.35, seed + 40);
    const crack =
      Math.abs(Math.sin((x + y * 0.3) * 0.08 + n * 4)) < 0.035 ? 0.12 : 0;
    const base = 28 + n * 22 + grit * 10 - crack * 40;
    const warm = grit * 4;
    return [base + warm, base + warm * 0.6, base - 2];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 16 });
}

export function createConcreteTexture(
  size = 256,
  seed = 23,
  repeat: [number, number] = [4, 4],
): THREE.CanvasTexture {
  const noiseOpts: Required<NoiseOptions> = {
    seed,
    scale: 0.03,
    octaves: 4,
    persistence: 0.5,
  };
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, noiseOpts);
    const speck = hash2(x, y, seed + 7);
    const stain = fbm2D(x * 0.5, y * 0.5, { ...noiseOpts, seed: seed + 90 });
    let v = 118 + n * 28 + speck * 14;
    if (stain > 0.62) v -= (stain - 0.62) * 70;
    // faint form lines
    const form = Math.sin(y * 0.12) * 3;
    return [v + form - 4, v + form - 2, v + form];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 12 });
}

export function createMetalPlateTexture(
  size = 256,
  seed = 41,
  repeat: [number, number] = [2, 2],
): THREE.CanvasTexture {
  const rng = mulberry32(seed);
  const rivets: Array<{ x: number; y: number }> = [];
  for (let i = 0; i < 48; i++) {
    rivets.push({ x: rng() * size, y: rng() * size });
  }
  const image = fillImageData(size, (x, y) => {
    const panelX = Math.floor(x / (size / 4));
    const panelY = Math.floor(y / (size / 3));
    const panelShade = ((panelX + panelY) % 2) * 8;
    const rust = fbm2D(x, y, {
      seed: seed + 3,
      scale: 0.04,
      octaves: 4,
      persistence: 0.55,
    });
    const scratch =
      Math.abs(Math.sin(y * 0.4 + x * 0.02)) < 0.02 ? 18 : 0;
    let r = 78 + panelShade + rust * 35 + scratch;
    let g = 62 + panelShade * 0.7 + rust * 18;
    let b = 48 + panelShade * 0.5 + rust * 8;
    if (rust > 0.58) {
      r += 40;
      g += 12;
      b -= 8;
    }
    for (const rivet of rivets) {
      const dx = x - rivet.x;
      const dy = y - rivet.y;
      if (dx * dx + dy * dy < 6.5) {
        r = 42;
        g = 40;
        b = 38;
      }
    }
    // seam lines
    if (x % Math.floor(size / 4) < 2 || y % Math.floor(size / 3) < 2) {
      r *= 0.55;
      g *= 0.55;
      b *= 0.55;
    }
    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 12 });
}

export function createBrickTexture(
  size = 256,
  seed = 57,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  const brickW = 32;
  const brickH = 14;
  const mortar = 3;
  const image = fillImageData(size, (x, y) => {
    const row = Math.floor(y / (brickH + mortar));
    const offset = (row % 2) * Math.floor(brickW * 0.5);
    const localX = (x + offset) % (brickW + mortar);
    const localY = y % (brickH + mortar);
    const isMortar = localX < mortar || localY < mortar;
    if (isMortar) {
      const m = 92 + hash2(x, y, seed) * 18;
      return [m, m - 2, m - 6];
    }
    const bx = Math.floor((x + offset) / (brickW + mortar));
    const by = row;
    const variation = hash2(bx, by, seed);
    const chip = hash2(x, y, seed + 11);
    const damage = fbm2D(x, y, {
      seed: seed + 20,
      scale: 0.05,
      octaves: 3,
      persistence: 0.5,
    });
    let r = 132 + variation * 40;
    let g = 78 + variation * 22;
    let b = 58 + variation * 16;
    // war-torn plaster patches
    if (damage > 0.68) {
      r = 168 + chip * 20;
      g = 158 + chip * 16;
      b = 142 + chip * 12;
    } else if (damage < 0.28) {
      r *= 0.72;
      g *= 0.68;
      b *= 0.65;
    }
    if (chip > 0.94) {
      r -= 30;
      g -= 25;
      b -= 20;
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
    const weave = ((x + y) % 4 === 0 ? -6 : 0) + ((x * 3 + y) % 7 === 0 ? 4 : 0);
    return [r + weave, g + weave, b + weave * 0.5];
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
  size = 256,
  seed = 31,
  repeat: [number, number] = [3, 3],
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const n = fbm2D(x, y, {
      seed,
      scale: 0.04,
      octaves: 4,
      persistence: 0.52,
    });
    const crackNoise = fbm2D(x, y, {
      seed: seed + 50,
      scale: 0.08,
      octaves: 2,
      persistence: 0.5,
    });
    let v = 150 + n * 35;
    if (Math.abs(crackNoise - 0.5) < 0.018) v -= 45;
    const soot = fbm2D(x * 0.6, y * 0.6, {
      seed: seed + 8,
      scale: 0.02,
      octaves: 3,
      persistence: 0.6,
    });
    if (soot > 0.65) v -= (soot - 0.65) * 90;
    return [v + 4, v, v - 6];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 10 });
}

export function createWoodCrateTexture(
  size = 128,
  seed = 19,
  repeat: [number, number] = [1, 1],
): THREE.CanvasTexture {
  const image = fillImageData(size, (x, y) => {
    const grain = Math.sin(y * 0.35 + Math.sin(x * 0.08) * 2) * 10;
    const n = valueNoise2D(x * 0.2, y * 0.05, seed);
    const band = x % 42 < 3 || y % 42 < 3 ? -25 : 0;
    const r = 118 + grain + n * 20 + band;
    const g = 86 + grain * 0.7 + n * 12 + band;
    const b = 48 + grain * 0.4 + n * 8 + band;
    return [r, g, b];
  });
  return makeCanvasTexture(image, { repeat, anisotropy: 8 });
}

/** Shared material/texture kit used by the combat level. */
export class LevelTextureKit {
  readonly asphalt: THREE.CanvasTexture;
  readonly concrete: THREE.CanvasTexture;
  readonly metal: THREE.CanvasTexture;
  readonly brick: THREE.CanvasTexture;
  readonly dirt: THREE.CanvasTexture;
  readonly camo: THREE.CanvasTexture;
  readonly blood: THREE.CanvasTexture;
  readonly plaster: THREE.CanvasTexture;
  readonly wood: THREE.CanvasTexture;

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
  readonly matSilhouette: THREE.MeshStandardMaterial;

  constructor(anisotropy = 8) {
    this.asphalt = makeAsphalt(256, 11, [10, 10]);
    this.concrete = makeConcrete(256, 23, [3, 3]);
    this.metal = makeMetal(256, 41, [2, 2]);
    this.brick = makeBrick(256, 57, [2.5, 2.5]);
    this.dirt = makeDirt(256, 67, [5, 5]);
    this.camo = createCamoTarpTexture(256, 73, [1.5, 1.5]);
    this.blood = createBloodSplatTexture(128, 99);
    this.plaster = createPlasterTexture(256, 31, [2.5, 2.5]);
    this.wood = createWoodCrateTexture(128, 19, [1, 1]);

    for (const t of [
      this.asphalt,
      this.concrete,
      this.metal,
      this.brick,
      this.dirt,
      this.camo,
      this.plaster,
      this.wood,
    ]) {
      t.anisotropy = anisotropy;
    }

    this.matAsphalt = new THREE.MeshStandardMaterial({
      map: this.asphalt,
      color: 0x3a3a3c,
      roughness: 0.92,
      metalness: 0.02,
    });
    this.matConcrete = new THREE.MeshStandardMaterial({
      map: this.concrete,
      color: 0xb0b0ae,
      roughness: 0.88,
      metalness: 0.04,
    });
    this.matConcreteDark = new THREE.MeshStandardMaterial({
      map: this.concrete,
      color: 0x6e6e6a,
      roughness: 0.9,
      metalness: 0.05,
    });
    this.matBrick = new THREE.MeshStandardMaterial({
      map: this.brick,
      color: 0xd0c4b4,
      roughness: 0.86,
      metalness: 0.02,
    });
    this.matPlaster = new THREE.MeshStandardMaterial({
      map: this.plaster,
      color: 0xc8c2b4,
      roughness: 0.9,
      metalness: 0.01,
    });
    this.matMetal = new THREE.MeshStandardMaterial({
      map: this.metal,
      color: 0x9a9088,
      roughness: 0.45,
      metalness: 0.75,
    });
    this.matMetalRust = new THREE.MeshStandardMaterial({
      map: this.metal,
      color: 0x8a6a48,
      roughness: 0.72,
      metalness: 0.55,
    });
    this.matSandbag = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0xb8a878,
      roughness: 0.95,
      metalness: 0.0,
    });
    this.matCamo = new THREE.MeshStandardMaterial({
      map: this.camo,
      color: 0xa8a070,
      roughness: 0.88,
      metalness: 0.05,
    });
    this.matWood = new THREE.MeshStandardMaterial({
      map: this.wood,
      color: 0xc4a882,
      roughness: 0.82,
      metalness: 0.02,
    });
    this.matDirt = new THREE.MeshStandardMaterial({
      map: this.dirt,
      color: 0x8a7355,
      roughness: 0.96,
      metalness: 0.0,
    });
    this.matGlassBroken = new THREE.MeshStandardMaterial({
      color: 0x6a8aaa,
      roughness: 0.15,
      metalness: 0.2,
      transparent: true,
      opacity: 0.28,
      side: THREE.DoubleSide,
    });
    this.matRoadMark = new THREE.MeshStandardMaterial({
      color: 0xd8d0b8,
      roughness: 0.85,
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
    this.matSilhouette = new THREE.MeshStandardMaterial({
      color: 0x12161c,
      roughness: 1,
      metalness: 0,
      flatShading: true,
    });
  }

  dispose(): void {
    const textures = [
      this.asphalt,
      this.concrete,
      this.metal,
      this.brick,
      this.dirt,
      this.camo,
      this.blood,
      this.plaster,
      this.wood,
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
    ];
    for (const m of mats) m.dispose();
    for (const t of textures) t.dispose();
  }
}
