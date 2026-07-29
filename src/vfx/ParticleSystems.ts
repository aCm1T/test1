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

export type VFXKind = 'muzzle' | 'impact' | 'smoke' | 'blood' | 'explosion';

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

function createSoftSmokeTexture(size = 64): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;
  ctx.clearRect(0, 0, size, size);
  for (let i = 0; i < 3; i++) {
    const cx = size * (0.35 + Math.random() * 0.3);
    const cy = size * (0.35 + Math.random() * 0.3);
    const r = size * (0.25 + Math.random() * 0.2);
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
      p.life = 0;
      p.maxLife = 0.4;
      configure(p, spawned);
      spawned++;
    }
  }

  update(dt: number): void {
    const pos = this.positions;
    const col = this.colors;
    const sz = this.sizes;

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
        pos[i3 + 1] = -9999;
        col[i4 + 3] = 0;
        continue;
      }

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
      col[i4] = p.r;
      col[i4 + 1] = p.g;
      col[i4 + 2] = p.b;
      col[i4 + 3] = p.a * fade;
      sz[i] = p.size * (0.6 + fade * 0.6);
    }

    const geo = this.points.geometry;
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

  constructor() {
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

  burst(position: Vector3, direction: Vector3, count = 18): void {
    _origin.copy(position);
    this.emitter.spawn(count, _origin, (p, i) => {
      const spread = 0.35;
      p.vx = direction.x * (4 + Math.random() * 6) + (Math.random() - 0.5) * spread * 8;
      p.vy = direction.y * (4 + Math.random() * 6) + (Math.random() - 0.5) * spread * 8;
      p.vz = direction.z * (4 + Math.random() * 6) + (Math.random() - 0.5) * spread * 8;
      p.maxLife = 0.04 + Math.random() * 0.06;
      p.size = 0.08 + Math.random() * 0.22;
      p.r = 1;
      p.g = 0.75 + Math.random() * 0.25;
      p.b = 0.25 + Math.random() * 0.35;
      p.a = 1;
      p.drag = 0.86;
      p.gravity = -2;
      if (i === 0) {
        // Core flash particle
        p.size = 0.45;
        p.maxLife = 0.05;
        p.vx = direction.x * 2;
        p.vy = direction.y * 2;
        p.vz = direction.z * 2;
      }
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Bright impact sparks on hard surfaces. */
export class ImpactSparks {
  private readonly emitter: ParticleEmitter;

  constructor() {
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

  burst(position: Vector3, normal: Vector3, count = 22): void {
    _origin.copy(position).addScaledVector(normal, 0.02);
    this.emitter.spawn(count, _origin, (p) => {
      const rx = (Math.random() - 0.5) * 2;
      const ry = (Math.random() - 0.5) * 2;
      const rz = (Math.random() - 0.5) * 2;
      const speed = 3 + Math.random() * 7;
      p.vx = normal.x * speed * 0.6 + rx * speed;
      p.vy = normal.y * speed * 0.6 + ry * speed + Math.random() * 2;
      p.vz = normal.z * speed * 0.6 + rz * speed;
      p.maxLife = 0.12 + Math.random() * 0.25;
      p.size = 0.03 + Math.random() * 0.08;
      p.r = 1;
      p.g = 0.7 + Math.random() * 0.3;
      p.b = 0.2 + Math.random() * 0.3;
      p.a = 1;
      p.gravity = -18;
      p.drag = 0.94;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Soft grey smoke puff. */
export class SmokePuff {
  private readonly emitter: ParticleEmitter;

  constructor() {
    this.emitter = new ParticleEmitter({
      capacity: 128,
      size: 0.9,
      blending: NormalBlending,
      depthWrite: false,
      texture: createSoftSmokeTexture(),
      sizeAttenuation: true,
    });
    this.emitter.points.name = 'SmokePuff';
  }

  get object(): Points {
    return this.emitter.points;
  }

  burst(position: Vector3, count = 10, scale = 1): void {
    _origin.copy(position);
    this.emitter.spawn(count, _origin, (p) => {
      p.vx = (Math.random() - 0.5) * 0.8 * scale;
      p.vy = 0.4 + Math.random() * 0.9 * scale;
      p.vz = (Math.random() - 0.5) * 0.8 * scale;
      p.maxLife = 0.6 + Math.random() * 1.1;
      p.size = (0.35 + Math.random() * 0.55) * scale;
      const grey = 0.45 + Math.random() * 0.25;
      p.r = grey;
      p.g = grey * 0.98;
      p.b = grey * 0.92;
      p.a = 0.55;
      p.gravity = 0.15;
      p.drag = 0.97;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
  }

  dispose(): void {
    this.emitter.dispose();
  }
}

/** Arterial-style blood spray (dark red additive-ish particles). */
export class BloodSpray {
  private readonly emitter: ParticleEmitter;

  constructor() {
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

  burst(position: Vector3, direction: Vector3, count = 28): void {
    _origin.copy(position);
    this.emitter.spawn(count, _origin, (p) => {
      const spread = 1.4;
      p.vx = direction.x * (2 + Math.random() * 5) + (Math.random() - 0.5) * spread;
      p.vy = direction.y * (2 + Math.random() * 5) + Math.random() * 2;
      p.vz = direction.z * (2 + Math.random() * 5) + (Math.random() - 0.5) * spread;
      p.maxLife = 0.25 + Math.random() * 0.45;
      p.size = 0.04 + Math.random() * 0.1;
      _tmpColor.setRGB(0.55 + Math.random() * 0.35, 0.02 + Math.random() * 0.06, 0.02);
      p.r = _tmpColor.r;
      p.g = _tmpColor.g;
      p.b = _tmpColor.b;
      p.a = 0.95;
      p.gravity = -22;
      p.drag = 0.96;
    });
  }

  update(dt: number): void {
    this.emitter.update(dt);
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

  constructor() {
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
      texture: createSoftSmokeTexture(96),
      sizeAttenuation: true,
    });
    this.smoke.points.name = 'ExplosionSmoke';
  }

  get objects(): Points[] {
    return [this.flash.points, this.debris.points, this.smoke.points];
  }

  burst(position: Vector3, scale = 1): void {
    _origin.copy(position);

    this.flash.spawn(Math.floor(20 * scale), _origin, (p, i) => {
      const ang = Math.random() * Math.PI * 2;
      const elev = (Math.random() - 0.3) * Math.PI * 0.5;
      const speed = (2 + Math.random() * 4) * scale;
      p.vx = Math.cos(ang) * Math.cos(elev) * speed;
      p.vy = Math.sin(elev) * speed + 1;
      p.vz = Math.sin(ang) * Math.cos(elev) * speed;
      p.maxLife = 0.08 + Math.random() * 0.12;
      p.size = (0.4 + Math.random() * 0.8) * scale;
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

    this.debris.spawn(Math.floor(36 * scale), _origin, (p) => {
      const ang = Math.random() * Math.PI * 2;
      const elev = Math.random() * Math.PI - Math.PI * 0.2;
      const speed = (4 + Math.random() * 10) * scale;
      p.vx = Math.cos(ang) * Math.cos(elev) * speed;
      p.vy = Math.sin(elev) * speed;
      p.vz = Math.sin(ang) * Math.cos(elev) * speed;
      p.maxLife = 0.2 + Math.random() * 0.4;
      p.size = (0.05 + Math.random() * 0.12) * scale;
      p.r = 1;
      p.g = 0.55 + Math.random() * 0.3;
      p.b = 0.1;
      p.a = 1;
      p.gravity = -12;
      p.drag = 0.93;
    });

    this.smoke.spawn(Math.floor(18 * scale), _origin, (p) => {
      p.vx = (Math.random() - 0.5) * 1.5 * scale;
      p.vy = (0.8 + Math.random() * 1.5) * scale;
      p.vz = (Math.random() - 0.5) * 1.5 * scale;
      p.maxLife = 1.0 + Math.random() * 1.4;
      p.size = (0.7 + Math.random() * 1.2) * scale;
      const g = 0.25 + Math.random() * 0.2;
      p.r = g;
      p.g = g * 0.95;
      p.b = g * 0.85;
      p.a = 0.65;
      p.gravity = 0.1;
      p.drag = 0.98;
    });
  }

  update(dt: number): void {
    this.flash.update(dt);
    this.debris.update(dt);
    this.smoke.update(dt);
  }

  dispose(): void {
    this.flash.dispose();
    this.debris.dispose();
    this.smoke.dispose();
  }
}

/**
 * Central VFX orchestrator — owns all particle systems and mounts them in the scene.
 */
export class VFXManager {
  readonly root: Group;
  readonly muzzle: MuzzleFlash;
  readonly impact: ImpactSparks;
  readonly smoke: SmokePuff;
  readonly blood: BloodSpray;
  readonly explosion: Explosion;

  private readonly scene: Scene;
  private disposed = false;

  constructor(scene: Scene) {
    this.scene = scene;
    this.root = new Group();
    this.root.name = 'VFXRoot';

    this.muzzle = new MuzzleFlash();
    this.impact = new ImpactSparks();
    this.smoke = new SmokePuff();
    this.blood = new BloodSpray();
    this.explosion = new Explosion();

    this.root.add(this.muzzle.object);
    this.root.add(this.impact.object);
    this.root.add(this.smoke.object);
    this.root.add(this.blood.object);
    for (const o of this.explosion.objects) {
      this.root.add(o);
    }

    scene.add(this.root);
  }

  spawnMuzzleFlash(position: Vector3, direction: Vector3, count?: number): void {
    this.muzzle.burst(position, direction, count);
  }

  spawnImpact(position: Vector3, normal: Vector3, count?: number): void {
    this.impact.burst(position, normal, count);
    this.smoke.burst(position, 4, 0.45);
  }

  spawnSmoke(position: Vector3, count?: number, scale?: number): void {
    this.smoke.burst(position, count, scale);
  }

  spawnBlood(position: Vector3, direction: Vector3, count?: number): void {
    this.blood.burst(position, direction, count);
  }

  spawnExplosion(position: Vector3, scale?: number): void {
    this.explosion.burst(position, scale);
  }

  update(dt: number): void {
    if (this.disposed) return;
    this.muzzle.update(dt);
    this.impact.update(dt);
    this.smoke.update(dt);
    this.blood.update(dt);
    this.explosion.update(dt);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    this.muzzle.dispose();
    this.impact.dispose();
    this.smoke.dispose();
    this.blood.dispose();
    this.explosion.dispose();
  }
}
