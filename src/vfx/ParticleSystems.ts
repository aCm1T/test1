import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  CanvasTexture,
  Color,
  DynamicDrawUsage,
  Group,
  NormalBlending,
  Points,
  PointsMaterial,
  Scene,
  Vector3,
} from 'three';
import { SeededRandom, type RandomSource } from '../mission';

export type VFXKind = 'muzzle' | 'impact' | 'smoke' | 'blood' | 'explosion';

/** Material a round struck, used to pick spark colour, debris and dust. */
export type ImpactSurface = 'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'default';

interface SurfaceProfile {
  /** Spark colour and how energetically they ricochet. */
  spark: readonly [number, number, number];
  sparkSpeed: number;
  sparkCount: number;
  /** Dust/chip colour thrown back along the surface normal. */
  debris: readonly [number, number, number];
  debrisCount: number;
  debrisSize: number;
  /** Lingering dust puff scale; concrete throws far more than metal. */
  dust: number;
}

/**
 * Impact response per material. Metal is nearly all sparks, concrete is nearly
 * all dust, and the mix is what tells the player what they just shot.
 */
const SURFACE_PROFILES: Record<ImpactSurface, SurfaceProfile> = {
  concrete: {
    spark: [1, 0.72, 0.34],
    sparkSpeed: 0.7,
    sparkCount: 0.55,
    debris: [0.62, 0.6, 0.57],
    debrisCount: 1.3,
    debrisSize: 1,
    dust: 1.25,
  },
  metal: {
    spark: [1, 0.93, 0.72],
    sparkSpeed: 1.45,
    sparkCount: 1.5,
    debris: [0.75, 0.76, 0.8],
    debrisCount: 0.5,
    debrisSize: 0.7,
    dust: 0.3,
  },
  wood: {
    spark: [1, 0.62, 0.22],
    sparkSpeed: 0.5,
    sparkCount: 0.3,
    debris: [0.48, 0.34, 0.19],
    debrisCount: 1.15,
    debrisSize: 1.35,
    dust: 0.7,
  },
  dirt: {
    spark: [0.9, 0.6, 0.3],
    sparkSpeed: 0.35,
    sparkCount: 0.2,
    debris: [0.36, 0.28, 0.19],
    debrisCount: 1.45,
    debrisSize: 1.5,
    dust: 1.1,
  },
  glass: {
    spark: [0.85, 0.95, 1],
    sparkSpeed: 1.2,
    sparkCount: 1.1,
    debris: [0.8, 0.88, 0.92],
    debrisCount: 1.2,
    debrisSize: 0.8,
    dust: 0.35,
  },
  default: {
    spark: [1, 0.78, 0.4],
    sparkSpeed: 1,
    sparkCount: 1,
    debris: [0.58, 0.56, 0.53],
    debrisCount: 1,
    debrisSize: 1,
    dust: 0.9,
  },
};

export function resolveImpactSurface(surface: string | null | undefined): ImpactSurface {
  switch (surface) {
    case 'concrete':
    case 'metal':
    case 'wood':
    case 'dirt':
    case 'glass':
      return surface;
    default:
      return 'default';
  }
}

function createRandom(seed: number): RandomSource {
  const random = new SeededRandom(seed);
  return () => random.next();
}

interface Particle {
  active: boolean;
  life: number;
  maxLife: number;
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  size: number;
  r: number;
  g: number;
  b: number;
  a: number;
  gravity: number;
  drag: number;
  /** Fractional size gain across the particle's life; 0 keeps legacy sizing. */
  growth: number;
  /** Fraction of life spent ramping alpha in, so puffs never pop into frame. */
  fadeIn: number;
}

interface EmitterConfig {
  capacity: number;
  size: number;
  blending: typeof AdditiveBlending | typeof NormalBlending;
  depthWrite: boolean;
  texture: CanvasTexture;
  sizeAttenuation: boolean;
}

function createRadialTexture(
  inner: string,
  mid: string,
  outer: string,
  size = 64,
): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
  g.addColorStop(0, inner);
  g.addColorStop(0.35, mid);
  g.addColorStop(1, outer);
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, size, size);
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

function createSoftSmokeTexture(size = 64, random: RandomSource = createRandom(0x534d4f4b)): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 3; i++) {
    const cx = size * (0.35 + random() * 0.3);
    const cy = size * (0.35 + random() * 0.3);
    const r = size * (0.25 + random() * 0.2);
    const g = ctx.createRadialGradient(cx, cy, 0, cx, cy, r);
    g.addColorStop(0, 'rgba(200,200,200,0.55)');
    g.addColorStop(1, 'rgba(200,200,200,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, size, size);
  }
  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * GPU-friendly Points particle pool. Positions / colors / sizes updated each frame.
 */
class ParticleEmitter {
  readonly points: Points<BufferGeometry, PointsMaterial>;
  private readonly particles: Particle[];
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly capacity: number;
  /**
   * An idle emitter still costs a draw submission and a full buffer upload, so
   * the pool tracks occupancy and stops submitting once it drains.
   */
  private activeCount = 0;

  constructor(config: EmitterConfig) {
    this.capacity = config.capacity;
    this.particles = new Array(this.capacity);
    for (let i = 0; i < this.capacity; i++) {
      this.particles[i] = {
        active: false,
        life: 0,
        maxLife: 1,
        x: 0,
        y: 0,
        z: 0,
        vx: 0,
        vy: 0,
        vz: 0,
        size: 1,
        r: 1,
        g: 1,
        b: 1,
        a: 1,
        gravity: 0,
        drag: 1,
        growth: 0,
        fadeIn: 0,
      };
    }

    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 4);
    this.sizes = new Float32Array(this.capacity);

    const geo = new BufferGeometry();
    const posAttr = new BufferAttribute(this.positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    const colAttr = new BufferAttribute(this.colors, 4);
    colAttr.setUsage(DynamicDrawUsage);
    const sizeAttr = new BufferAttribute(this.sizes, 1);
    sizeAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', colAttr);
    geo.setAttribute('size', sizeAttr);
    // Hide inactive by parking far away / zero alpha
    geo.setDrawRange(0, this.capacity);

    const mat = new PointsMaterial({
      map: config.texture,
      size: config.size,
      transparent: true,
      depthWrite: config.depthWrite,
      blending: config.blending,
      vertexColors: true,
      sizeAttenuation: config.sizeAttenuation,
      opacity: 1,
    });

    // Per-particle size via onBeforeCompile
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace(
          'uniform float size;',
          'attribute float size;',
        );
    };

    this.points = new Points(geo, mat);
    this.points.frustumCulled = false;
    this.points.visible = false;
    this.points.name = 'ParticleEmitter';
  }

  spawn(
    count: number,
    origin: Vector3,
    configure: (p: Particle, i: number) => void,
  ): void {
    let spawned = 0;
    for (let i = 0; i < this.capacity && spawned < count; i++) {
      const p = this.particles[i];
      if (p.active) continue;
      p.active = true;
      this.activeCount += 1;
      this.points.visible = true;
      p.x = origin.x;
      p.y = origin.y;
      p.z = origin.z;
      p.vx = 0;
      p.vy = 0;
      p.vz = 0;
      p.size = 1;
      p.r = 1;
      p.g = 1;
      p.b = 1;
      p.a = 1;
      p.gravity = 0;
      p.drag = 0.98;
      p.growth = 0;
      p.fadeIn = 0;
      p.life = 0;
      p.maxLife = 0.4;
      configure(p, spawned);
      spawned++;
    }
  }

  update(dt: number): void {
    if (this.activeCount === 0) {
      // Nothing to simulate and nothing to submit until the next burst.
      this.points.visible = false;
      this.points.geometry.setDrawRange(0, 0);
      return;
    }

    const pos = this.positions;
    const col = this.colors;
    const sz = this.sizes;
    let highest = -1;

    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      const i3 = i * 3;
      const i4 = i * 4;

      if (!p.active) {
        pos[i3] = 0;
        pos[i3 + 1] = -9999;
        pos[i3 + 2] = 0;
        col[i4 + 3] = 0;
        sz[i] = 0;
        continue;
      }

      p.life += dt;
      if (p.life >= p.maxLife) {
        p.active = false;
        this.activeCount -= 1;
        pos[i3 + 1] = -9999;
        col[i4 + 3] = 0;
        sz[i] = 0;
        continue;
      }
      highest = i;

      const t = p.life / p.maxLife;
      p.vy += p.gravity * dt;
      p.vx *= p.drag;
      p.vy *= p.drag;
      p.vz *= p.drag;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;

      pos[i3] = p.x;
      pos[i3 + 1] = p.y;
      pos[i3 + 2] = p.z;

      const fade = 1 - t;
      const rampIn = p.fadeIn > 0 ? Math.min(1, t / p.fadeIn) : 1;
      col[i4] = p.r;
      col[i4 + 1] = p.g;
      col[i4 + 2] = p.b;
      col[i4 + 3] = p.a * fade * rampIn;
      // Growth-driven particles (smoke, dust) expand as they dissipate; sparks
      // and flash keep the original shrink-with-alpha curve.
      sz[i] = p.growth > 0
        ? p.size * (1 + p.growth * t)
        : p.size * (0.6 + fade * 0.6);
    }

    const geo = this.points.geometry;
    // Everything past the last live particle is dead pool tail; skipping it
    // keeps a mostly-idle emitter from submitting its whole capacity.
    geo.setDrawRange(0, highest + 1);
    this.points.visible = highest >= 0;
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  /**
   * Kill every live particle immediately. Restore / rematch / QA rewind do not
   * own this pool, so a paused fight would otherwise keep muzzle sparks, blood,
   * and blast smoke on the restored timeline.
   */
  clear(): void {
    if (this.activeCount === 0) {
      this.points.visible = false;
      this.points.geometry.setDrawRange(0, 0);
      return;
    }
    const pos = this.positions;
    const col = this.colors;
    const sz = this.sizes;
    for (let i = 0; i < this.capacity; i++) {
      const p = this.particles[i];
      if (!p.active) continue;
      p.active = false;
      p.life = 0;
      const i3 = i * 3;
      pos[i3 + 1] = -9999;
      col[i * 4 + 3] = 0;
      sz[i] = 0;
    }
    this.activeCount = 0;
    this.points.visible = false;
    const geo = this.points.geometry;
    geo.setDrawRange(0, 0);
    geo.attributes.position.needsUpdate = true;
    geo.attributes.color.needsUpdate = true;
    geo.attributes.size.needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.map?.dispose();
    this.points.material.dispose();
  }
}

const _origin = new Vector3();
const _tmpColor = new Color();

/** High-intensity orange/white muzzle flash burst. */
export class MuzzleFlash {
  private readonly emitter: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x4d555a5a)) {
    this.random = random;
    this.emitter = new ParticleEmitter({
      capacity: 96,
      size: 0.35,
      blending: AdditiveBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(255,255,240,1)',
        'rgba(255,160,40,0.85)',
        'rgba(255,60,0,0)',
      ),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'MuzzleFlash';
  }

  get object(): Points {
    return this.emitter.points;
  }

  burst(position: Vector3, direction: Vector3, count = 12): void {
    _origin.copy(position);
    this.emitter.spawn(count, _origin, (p, i) => {
      const spread = 0.35;
      p.vx = direction.x * (4 + this.random() * 6) + (this.random() - 0.5) * spread * 8;
      p.vy = direction.y * (4 + this.random() * 6) + (this.random() - 0.5) * spread * 8;
      p.vz = direction.z * (4 + this.random() * 6) + (this.random() - 0.5) * spread * 8;
      // Point sizes are perspective-scaled.  These values keep a first-person
      // flash readable at the barrel without turning a near-camera QA flash
      // into an opaque, screen-filling additive disc.
      p.maxLife = 0.028 + this.random() * 0.036;
      p.size = 0.006 + this.random() * 0.016;
      p.r = 1;
      p.g = 0.75 + this.random() * 0.25;
      p.b = 0.25 + this.random() * 0.35;
      p.a = 1;
      p.drag = 0.86;
      p.gravity = -2;
      if (i === 0) {
        // Core flash particle
        p.size = 0.028;
        p.maxLife = 0.042;
        p.vx = direction.x * 2;
        p.vy = direction.y * 2;
        p.vz = direction.z * 2;
      }
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Bright impact sparks on hard surfaces. */
export class ImpactSparks {
  private readonly emitter: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x494d5041)) {
    this.random = random;
    this.emitter = new ParticleEmitter({
      capacity: 160,
      size: 0.12,
      blending: AdditiveBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(255,255,220,1)',
        'rgba(255,180,60,0.9)',
        'rgba(200,80,0,0)',
        32,
      ),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'ImpactSparks';
  }

  get object(): Points {
    return this.emitter.points;
  }

  burst(
    position: Vector3,
    normal: Vector3,
    count = 22,
    surface: ImpactSurface = 'default',
  ): void {
    const profile = SURFACE_PROFILES[surface];
    const scaled = Math.max(1, Math.round(count * profile.sparkCount));
    _origin.copy(position).addScaledVector(normal, 0.02);
    this.emitter.spawn(scaled, _origin, (p) => {
      const rx = (this.random() - 0.5) * 2;
      const ry = (this.random() - 0.5) * 2;
      const rz = (this.random() - 0.5) * 2;
      const speed = (3 + this.random() * 7) * profile.sparkSpeed;
      p.vx = normal.x * speed * 0.6 + rx * speed;
      p.vy = normal.y * speed * 0.6 + ry * speed + this.random() * 2;
      p.vz = normal.z * speed * 0.6 + rz * speed;
      p.maxLife = 0.12 + this.random() * 0.25;
      p.size = 0.03 + this.random() * 0.08;
      p.r = profile.spark[0];
      p.g = profile.spark[1] * (0.85 + this.random() * 0.3);
      p.b = profile.spark[2] * (0.8 + this.random() * 0.4);
      p.a = 1;
      p.gravity = -18;
      p.drag = 0.94;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/**
 * Opaque chips and dust thrown back off a struck surface. Sparks alone read as
 * "shot something metal" everywhere; this layer is what makes concrete, wood and
 * dirt distinguishable at a glance.
 */
export class SurfaceDebris {
  private readonly emitter: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x44454252)) {
    this.random = random;
    this.emitter = new ParticleEmitter({
      capacity: 192,
      size: 0.1,
      blending: NormalBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(220,214,205,1)',
        'rgba(150,144,134,0.9)',
        'rgba(90,85,78,0)',
        32,
      ),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'SurfaceDebris';
  }

  get object(): Points {
    return this.emitter.points;
  }

  burst(
    position: Vector3,
    normal: Vector3,
    count = 14,
    surface: ImpactSurface = 'default',
  ): void {
    const profile = SURFACE_PROFILES[surface];
    const scaled = Math.max(1, Math.round(count * profile.debrisCount));
    _origin.copy(position).addScaledVector(normal, 0.015);
    this.emitter.spawn(scaled, _origin, (p) => {
      const speed = 1.6 + this.random() * 4.2;
      p.vx = normal.x * speed + (this.random() - 0.5) * speed * 0.9;
      p.vy = normal.y * speed + (this.random() - 0.5) * speed * 0.9 + this.random() * 1.2;
      p.vz = normal.z * speed + (this.random() - 0.5) * speed * 0.9;
      p.maxLife = 0.28 + this.random() * 0.5;
      p.size = (0.012 + this.random() * 0.03) * profile.debrisSize;
      const shade = 0.8 + this.random() * 0.4;
      p.r = profile.debris[0] * shade;
      p.g = profile.debris[1] * shade;
      p.b = profile.debris[2] * shade;
      p.a = 0.9;
      p.gravity = -20;
      p.drag = 0.95;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Soft grey smoke puff. */
export class SmokePuff {
  private readonly emitter: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x534d4f4b)) {
    this.random = random;
    this.emitter = new ParticleEmitter({
      capacity: 128,
      size: 0.9,
      blending: NormalBlending,
      depthWrite: false,
      texture: createSoftSmokeTexture(64, random),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'SmokePuff';
  }

  get object(): Points {
    return this.emitter.points;
  }

  /**
   * @param tint Optional RGB multiplier so surface dust can be sandy or grey.
   */
  burst(
    position: Vector3,
    count = 10,
    scale = 1,
    tint?: readonly [number, number, number],
  ): void {
    _origin.copy(position);
    this.emitter.spawn(count, _origin, (p) => {
      p.vx = (this.random() - 0.5) * 0.8 * scale;
      p.vy = 0.4 + this.random() * 0.9 * scale;
      p.vz = (this.random() - 0.5) * 0.8 * scale;
      p.maxLife = 0.6 + this.random() * 1.1;
      p.size = (0.35 + this.random() * 0.55) * scale;
      const grey = 0.45 + this.random() * 0.25;
      p.r = grey * (tint?.[0] ?? 1);
      p.g = grey * 0.98 * (tint?.[1] ?? 1);
      p.b = grey * 0.92 * (tint?.[2] ?? 1);
      p.a = 0.55;
      p.gravity = 0.15;
      p.drag = 0.97;
      // Real smoke billows outward while it thins, and it never appears at full
      // opacity on its first frame.
      p.growth = 1.5 + this.random() * 1.2;
      p.fadeIn = 0.12;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Arterial-style blood spray (dark red additive-ish particles). */
export class BloodSpray {
  private readonly emitter: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x424c4f4f)) {
    this.random = random;
    this.emitter = new ParticleEmitter({
      capacity: 192,
      size: 0.14,
      blending: NormalBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(180,20,20,1)',
        'rgba(90,8,8,0.85)',
        'rgba(40,0,0,0)',
        32,
      ),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'BloodSpray';
  }

  get object(): Points {
    return this.emitter.points;
  }

  /**
   * @param headshot Adds a faster, finer mist on top of the heavy droplets,
   *   which is the read that confirms a headshot without a HUD popup.
   */
  burst(position: Vector3, direction: Vector3, count = 28, headshot = false): void {
    _origin.copy(position);
    const spread = headshot ? 2.1 : 1.4;
    this.emitter.spawn(count, _origin, (p, i) => {
      const mist = headshot && i % 2 === 0;
      const speed = mist ? 4 + this.random() * 7 : 2 + this.random() * 5;
      p.vx = direction.x * speed + (this.random() - 0.5) * spread;
      p.vy = direction.y * speed + this.random() * 2;
      p.vz = direction.z * speed + (this.random() - 0.5) * spread;
      p.maxLife = mist ? 0.18 + this.random() * 0.3 : 0.25 + this.random() * 0.45;
      p.size = mist ? 0.018 + this.random() * 0.04 : 0.04 + this.random() * 0.1;
      _tmpColor.setRGB(0.55 + this.random() * 0.35, 0.02 + this.random() * 0.06, 0.02);
      p.r = _tmpColor.r;
      p.g = _tmpColor.g;
      p.b = _tmpColor.b;
      p.a = mist ? 0.7 : 0.95;
      p.gravity = mist ? -12 : -22;
      p.drag = 0.96;
      if (mist) p.growth = 1.1;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  clear(): void {
    this.emitter.clear();
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Multi-layer explosion: flash core + sparks + smoke. */
export class Explosion {
  private readonly flash: ParticleEmitter;
  private readonly debris: ParticleEmitter;
  private readonly smoke: ParticleEmitter;
  private readonly random: RandomSource;

  constructor(random: RandomSource = createRandom(0x4558504c)) {
    this.random = random;
    this.flash = new ParticleEmitter({
      capacity: 64,
      size: 1.2,
      blending: AdditiveBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(255,255,200,1)',
        'rgba(255,120,20,0.8)',
        'rgba(255,40,0,0)',
      ),
      sizeAttenuation: true,
    });
    this.flash.points.name = 'ExplosionFlash';

    this.debris = new ParticleEmitter({
      capacity: 96,
      size: 0.2,
      blending: AdditiveBlending,
      depthWrite: false,
      texture: createRadialTexture(
        'rgba(255,220,120,1)',
        'rgba(255,100,20,0.9)',
        'rgba(80,20,0,0)',
        32,
      ),
      sizeAttenuation: true,
    });
    this.debris.points.name = 'ExplosionDebris';

    this.smoke = new ParticleEmitter({
      capacity: 80,
      size: 1.4,
      blending: NormalBlending,
      depthWrite: false,
      texture: createSoftSmokeTexture(96, random),
      sizeAttenuation: true,
    });
    this.smoke.points.name = 'ExplosionSmoke';
  }

  get objects(): Points[] {
    return [this.flash.points, this.debris.points, this.smoke.points];
  }

  burst(position: Vector3, scale = 1, density = 1): void {
    _origin.copy(position);
    const countScale = Math.max(0.1, density);

    this.flash.spawn(Math.max(1, Math.floor(20 * scale * countScale)), _origin, (p, i) => {
      const ang = this.random() * Math.PI * 2;
      const elev = (this.random() - 0.3) * Math.PI * 0.5;
      const speed = (2 + this.random() * 4) * scale;
      p.vx = Math.cos(ang) * Math.cos(elev) * speed;
      p.vy = Math.sin(elev) * speed + 1;
      p.vz = Math.sin(ang) * Math.cos(elev) * speed;
      p.maxLife = 0.08 + this.random() * 0.12;
      p.size = (0.4 + this.random() * 0.8) * scale;
      p.r = 1;
      p.g = 0.85;
      p.b = 0.4;
      p.a = 1;
      p.drag = 0.9;
      if (i < 3) {
        p.size = 1.6 * scale;
        p.maxLife = 0.1;
      }
    });

    this.debris.spawn(Math.max(1, Math.floor(36 * scale * countScale)), _origin, (p) => {
      const ang = this.random() * Math.PI * 2;
      const elev = this.random() * Math.PI - Math.PI * 0.2;
      const speed = (4 + this.random() * 10) * scale;
      p.vx = Math.cos(ang) * Math.cos(elev) * speed;
      p.vy = Math.sin(elev) * speed;
      p.vz = Math.sin(ang) * Math.cos(elev) * speed;
      p.maxLife = 0.2 + this.random() * 0.4;
      p.size = (0.05 + this.random() * 0.12) * scale;
      p.r = 1;
      p.g = 0.55 + this.random() * 0.3;
      p.b = 0.1;
      p.a = 1;
      p.gravity = -12;
      p.drag = 0.93;
    });

    this.smoke.spawn(Math.max(1, Math.floor(18 * scale * countScale)), _origin, (p) => {
      p.vx = (this.random() - 0.5) * 1.5 * scale;
      p.vy = (0.8 + this.random() * 1.5) * scale;
      p.vz = (this.random() - 0.5) * 1.5 * scale;
      p.maxLife = 1.0 + this.random() * 1.4;
      p.size = (0.7 + this.random() * 1.2) * scale;
      const g = 0.25 + this.random() * 0.2;
      p.r = g;
      p.g = g * 0.95;
      p.b = g * 0.85;
      p.a = 0.65;
      p.gravity = 0.1;
      p.drag = 0.98;
      // The blast cloud has to keep expanding after the flash is gone, or the
      // explosion reads as a flat sprite that simply fades out.
      p.growth = 2.2 + this.random() * 1.6;
      p.fadeIn = 0.08;
    });
  }

  update(dt: number): void {
    this.flash.update(dt);
    this.debris.update(dt);
    this.smoke.update(dt);
  }

  clear(): void {
    this.flash.clear();
    this.debris.clear();
    this.smoke.clear();
  }

  dispose(): void {
    this.flash.dispose();
    this.debris.dispose();
    this.smoke.dispose();
  }
}

/**
 * Persistent airborne motes drifting through the playable volume.
 *
 * Nothing else in the scene occupies the space *between* the camera and the
 * geometry, so the frame reads as a set of clean surfaces suspended in vacuum.
 * A slow field of lit dust gives that volume a material presence and makes the
 * lamp and window practicals feel like they are illuminating actual air.
 *
 * The field wraps around a moving focus rather than respawning, so it costs a
 * fixed buffer update per frame and never allocates during play.
 */
export class AtmosphericMotes {
  readonly points: Points<BufferGeometry, PointsMaterial>;

  private readonly capacity: number;
  private readonly positions: Float32Array;
  private readonly colors: Float32Array;
  private readonly sizes: Float32Array;
  private readonly drift: Float32Array;
  private readonly phase: Float32Array;
  private readonly texture: CanvasTexture;
  private readonly focus = new Vector3(0, 0, 0);
  private readonly half = new Vector3(16, 5.5, 16);
  private readonly baseHeight = 3.4;
  private elapsed = 0;
  private active: number;

  constructor(random: RandomSource = createRandom(0x44555354), capacity = 420) {
    this.capacity = Math.max(1, Math.floor(capacity));
    this.active = this.capacity;
    this.positions = new Float32Array(this.capacity * 3);
    this.colors = new Float32Array(this.capacity * 4);
    this.sizes = new Float32Array(this.capacity);
    this.drift = new Float32Array(this.capacity * 3);
    this.phase = new Float32Array(this.capacity);

    for (let i = 0; i < this.capacity; i += 1) {
      this.positions[i * 3] = (random() * 2 - 1) * this.half.x;
      this.positions[i * 3 + 1] = this.baseHeight + (random() * 2 - 1) * this.half.y;
      this.positions[i * 3 + 2] = (random() * 2 - 1) * this.half.z;
      this.drift[i * 3] = 0.12 + random() * 0.34;
      this.drift[i * 3 + 1] = (random() * 2 - 1) * 0.06;
      this.drift[i * 3 + 2] = -0.2 + random() * 0.4;
      this.phase[i] = random() * Math.PI * 2;
      // A dusk-warm mote with a cool minority; the mix keeps the field from
      // reading as a single tinted overlay across the whole frame.
      const warm = random() > 0.28;
      this.colors[i * 4] = warm ? 0.72 : 0.44;
      this.colors[i * 4 + 1] = warm ? 0.58 : 0.52;
      this.colors[i * 4 + 2] = warm ? 0.38 : 0.62;
      this.colors[i * 4 + 3] = 0.1 + random() * 0.24;
      this.sizes[i] = 0.024 + random() * 0.05;
    }

    const geo = new BufferGeometry();
    const posAttr = new BufferAttribute(this.positions, 3);
    posAttr.setUsage(DynamicDrawUsage);
    geo.setAttribute('position', posAttr);
    geo.setAttribute('color', new BufferAttribute(this.colors, 4));
    geo.setAttribute('size', new BufferAttribute(this.sizes, 1));
    geo.setDrawRange(0, this.active);

    this.texture = createRadialTexture(
      'rgba(255,244,226,0.95)',
      'rgba(255,226,186,0.35)',
      'rgba(255,214,170,0)',
      32,
    );

    const mat = new PointsMaterial({
      map: this.texture,
      size: 1,
      transparent: true,
      depthWrite: false,
      blending: AdditiveBlending,
      vertexColors: true,
      sizeAttenuation: true,
      opacity: 1,
    });
    mat.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader
        .replace('uniform float size;', 'attribute float size;');
    };

    this.points = new Points(geo, mat);
    this.points.name = 'AtmosphericMotes';
    this.points.frustumCulled = false;
    this.points.renderOrder = 4;
  }

  /** Recentres the field so the player always walks through occupied air. */
  setFocus(x: number, y: number, z: number): void {
    this.focus.set(x, y, z);
  }

  /** Quality tiers thin the field by drawing fewer motes, not smaller ones. */
  setDensity(multiplier: number): void {
    const clamped = Math.max(0.1, Math.min(1.5, multiplier));
    this.active = Math.max(1, Math.min(this.capacity, Math.round(this.capacity * clamped)));
    this.points.geometry.setDrawRange(0, this.active);
  }

  update(dt: number): void {
    if (dt <= 0) return;
    this.elapsed += dt;
    const minX = this.focus.x - this.half.x;
    const spanX = this.half.x * 2;
    const minZ = this.focus.z - this.half.z;
    const spanZ = this.half.z * 2;
    const minY = this.focus.y + this.baseHeight - this.half.y;
    const spanY = this.half.y * 2;

    for (let i = 0; i < this.active; i += 1) {
      const base = i * 3;
      // A shared low-frequency sway reads as one air current rather than
      // hundreds of independently wandering specks.
      const sway = Math.sin(this.elapsed * 0.42 + this.phase[i]) * 0.11;
      this.positions[base] += (this.drift[base] + sway) * dt;
      this.positions[base + 1] += (this.drift[base + 1] + sway * 0.35) * dt;
      this.positions[base + 2] += this.drift[base + 2] * dt;

      this.positions[base] = minX + wrap(this.positions[base] - minX, spanX);
      this.positions[base + 1] = minY + wrap(this.positions[base + 1] - minY, spanY);
      this.positions[base + 2] = minZ + wrap(this.positions[base + 2] - minZ, spanZ);
    }
    this.points.geometry.getAttribute('position').needsUpdate = true;
  }

  dispose(): void {
    this.points.geometry.dispose();
    this.points.material.dispose();
    this.texture.dispose();
  }
}

function wrap(value: number, span: number): number {
  return ((value % span) + span) % span;
}

/**
 * Central VFX orchestrator — owns all particle systems and mounts them in the scene.
 */
export class VFXManager {
  readonly root: Group;
  readonly muzzle: MuzzleFlash;
  readonly impact: ImpactSparks;
  readonly debris: SurfaceDebris;
  readonly smoke: SmokePuff;
  readonly blood: BloodSpray;
  readonly explosion: Explosion;
  readonly motes: AtmosphericMotes;

  private readonly scene: Scene;
  private particleMultiplier: number;
  private disposed = false;

  constructor(
    scene: Scene,
    random: RandomSource = createRandom(0x56465821),
    particleMultiplier = 1,
  ) {
    this.scene = scene;
    this.particleMultiplier = Math.max(0.1, particleMultiplier);
    this.root = new Group();
    this.root.name = 'VFXRoot';

    this.muzzle = new MuzzleFlash(random);
    this.impact = new ImpactSparks(random);
    this.debris = new SurfaceDebris(random);
    this.smoke = new SmokePuff(random);
    this.blood = new BloodSpray(random);
    this.explosion = new Explosion(random);
    this.motes = new AtmosphericMotes(random);
    this.motes.setDensity(this.particleMultiplier);

    this.root.add(this.muzzle.object);
    this.root.add(this.impact.object);
    this.root.add(this.debris.object);
    this.root.add(this.smoke.object);
    this.root.add(this.blood.object);
    this.root.add(this.motes.points);
    for (const o of this.explosion.objects) {
      this.root.add(o);
    }

    scene.add(this.root);
  }

  /** Keeps the ambient mote field centred on whoever is being rendered. */
  setAmbientFocus(position: { x: number; y: number; z: number }): void {
    this.motes.setFocus(position.x, position.y, position.z);
  }

  spawnMuzzleFlash(position: Vector3, direction: Vector3, count?: number): void {
    this.muzzle.burst(position, direction, this.scaledCount(count ?? 18));
  }

  /**
   * Lingering barrel smoke. Called with the shooter's accumulated heat so a long
   * burst leaves a visible haze at the muzzle instead of nothing.
   */
  spawnMuzzleSmoke(position: Vector3, direction: Vector3, heat = 1): void {
    if (heat <= 0.05) return;
    _origin.copy(position).addScaledVector(direction, 0.12);
    this.smoke.burst(_origin, this.scaledCount(Math.round(1 + heat * 4)), 0.2 + heat * 0.22);
  }

  /**
   * Full impact response: material-tinted sparks, chips and a dust puff whose
   * volume is driven by the surface rather than a single generic burst.
   */
  spawnImpact(
    position: Vector3,
    normal: Vector3,
    surface: ImpactSurface = 'default',
    count?: number,
  ): void {
    const profile = SURFACE_PROFILES[surface];
    this.impact.burst(position, normal, this.scaledCount(count ?? 22), surface);
    this.debris.burst(position, normal, this.scaledCount(12), surface);
    if (profile.dust > 0.05) {
      this.smoke.burst(
        position,
        this.scaledCount(Math.max(2, Math.round(5 * profile.dust))),
        0.35 * profile.dust,
        profile.debris,
      );
    }
  }

  spawnSmoke(position: Vector3, count?: number, scale?: number): void {
    this.smoke.burst(position, this.scaledCount(count ?? 10), scale);
  }

  spawnBlood(position: Vector3, direction: Vector3, count?: number, headshot = false): void {
    this.blood.burst(
      position,
      direction,
      this.scaledCount(count ?? (headshot ? 38 : 28)),
      headshot,
    );
  }

  spawnExplosion(position: Vector3, scale?: number): void {
    this.explosion.burst(position, scale, this.particleMultiplier);
  }

  /**
   * Drop muzzle / impact / blood / explosion / smoke. Ambient motes stay —
   * they are environment, not combat telemetry. Pause and QA freeze these
   * pools, so rematch and session restore would otherwise keep the previous
   * timeline's sparks, blood, and blast cloud.
   */
  clearCombat(): void {
    this.muzzle.clear();
    this.impact.clear();
    this.debris.clear();
    this.smoke.clear();
    this.blood.clear();
    this.explosion.clear();
  }

  setParticleMultiplier(multiplier: number): void {
    this.particleMultiplier = Math.max(0.1, multiplier);
    this.motes.setDensity(this.particleMultiplier);
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.muzzle.update(dt);
    this.impact.update(dt);
    this.debris.update(dt);
    this.smoke.update(dt);
    this.blood.update(dt);
    this.explosion.update(dt);
    this.motes.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.muzzle.dispose();
    this.impact.dispose();
    this.debris.dispose();
    this.smoke.dispose();
    this.blood.dispose();
    this.explosion.dispose();
    this.motes.dispose();
  }

  private scaledCount(count: number): number {
    return Math.max(1, Math.floor(count * this.particleMultiplier));
  }
}
