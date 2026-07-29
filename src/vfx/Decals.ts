import {
  CanvasTexture,
  CircleGeometry,
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three';

export interface DecalHit {
  position: Vector3;
  normal: Vector3;
  size?: number;
}

interface PooledDecal {
  mesh: Mesh;
  alive: boolean;
  age: number;
  maxAge: number;
}

const UP = new Vector3(0, 0, 1);
const _quat = new Quaternion();
const _n = new Vector3();

function createBulletHoleTexture(size = 128): CanvasTexture {
  const canvas = document.createElement('canvas');
  canvas.width = size;
  canvas.height = size;
  const ctx = canvas.getContext('2d')!;

  ctx.clearRect(0, 0, size, size);

  const cx = size / 2;
  const cy = size / 2;

  // Outer soft scorch
  let g = ctx.createRadialGradient(cx, cy, size * 0.08, cx, cy, size * 0.48);
  g.addColorStop(0, 'rgba(12,10,8,0.95)');
  g.addColorStop(0.35, 'rgba(28,22,16,0.75)');
  g.addColorStop(0.7, 'rgba(40,32,24,0.25)');
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.48, 0, Math.PI * 2);
  ctx.fill();

  // Inner crater
  g = ctx.createRadialGradient(cx, cy, 0, cx, cy, size * 0.16);
  g.addColorStop(0, 'rgba(0,0,0,1)');
  g.addColorStop(0.6, 'rgba(18,14,10,0.95)');
  g.addColorStop(1, 'rgba(30,24,18,0)');
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(cx, cy, size * 0.16, 0, Math.PI * 2);
  ctx.fill();

  // Radial micro-cracks
  ctx.strokeStyle = 'rgba(8,6,4,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < 7; i++) {
    const ang = (i / 7) * Math.PI * 2 + Math.random() * 0.4;
    const len = size * (0.12 + Math.random() * 0.22);
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * size * 0.04, cy + Math.sin(ang) * size * 0.04);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }

  // Speckled debris ring
  for (let i = 0; i < 28; i++) {
    const ang = Math.random() * Math.PI * 2;
    const r = size * (0.1 + Math.random() * 0.28);
    const s = 0.5 + Math.random() * 1.8;
    ctx.fillStyle = `rgba(15,12,8,${0.25 + Math.random() * 0.45})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, s, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new CanvasTexture(canvas);
  tex.needsUpdate = true;
  return tex;
}

/**
 * Pooled circular bullet-hole decals projected onto hit surfaces.
 */
export class DecalManager {
  readonly root: Object3D;

  private readonly pool: PooledDecal[] = [];
  private readonly scene: Scene;
  private readonly texture: CanvasTexture;
  private readonly geometry: CircleGeometry;
  private readonly material: MeshBasicMaterial;
  private readonly maxDecals: number;
  private readonly lifetime: number;
  private cursor = 0;
  private disposed = false;

  constructor(
    scene: Scene,
    options: { maxDecals?: number; lifetime?: number } = {},
  ) {
    this.scene = scene;
    this.maxDecals = options.maxDecals ?? 96;
    this.lifetime = options.lifetime ?? 45;

    this.root = new Object3D();
    this.root.name = 'DecalRoot';
    scene.add(this.root);

    this.texture = createBulletHoleTexture();
    this.geometry = new CircleGeometry(0.5, 20);
    this.material = new MeshBasicMaterial({
      map: this.texture,
      transparent: true,
      depthWrite: false,
      side: DoubleSide,
      polygonOffset: true,
      polygonOffsetFactor: -2,
      polygonOffsetUnits: -2,
      opacity: 0.92,
    });

    for (let i = 0; i < this.maxDecals; i++) {
      const mat = this.material.clone();
      mat.map = this.texture;
      const mesh = new Mesh(this.geometry, mat);
      mesh.visible = false;
      mesh.renderOrder = 2;
      mesh.frustumCulled = true;
      this.root.add(mesh);
      this.pool.push({
        mesh,
        alive: false,
        age: 0,
        maxAge: this.lifetime,
      });
    }
  }

  /**
   * Place a bullet hole aligned to surface normal, slightly offset to avoid z-fight.
   */
  spawn(hit: DecalHit): Mesh | null {
    if (this.disposed) return null;

    const slot = this.acquire();
    const mesh = slot.mesh;
    const size = hit.size ?? 0.08 + Math.random() * 0.06;

    _n.copy(hit.normal).normalize();
    mesh.position.copy(hit.position).addScaledVector(_n, 0.012);
    _quat.setFromUnitVectors(UP, _n);
    mesh.quaternion.copy(_quat);
    mesh.rotateZ(Math.random() * Math.PI * 2);
    mesh.scale.setScalar(size);

    const mat = mesh.material as MeshBasicMaterial;
    mat.opacity = 0.92;

    slot.alive = true;
    slot.age = 0;
    slot.maxAge = this.lifetime * (0.85 + Math.random() * 0.3);
    mesh.visible = true;

    return mesh;
  }

  spawnAt(position: Vector3, normal: Vector3, size?: number): Mesh | null {
    return this.spawn({ position, normal, size });
  }

  update(dt: number): void {
    if (this.disposed) return;

    for (const slot of this.pool) {
      if (!slot.alive) continue;
      slot.age += dt;

      const fadeStart = slot.maxAge * 0.72;
      if (slot.age > fadeStart) {
        const t = (slot.age - fadeStart) / (slot.maxAge - fadeStart);
        (slot.mesh.material as MeshBasicMaterial).opacity = 0.92 * (1 - t);
      }

      if (slot.age >= slot.maxAge) {
        slot.alive = false;
        slot.mesh.visible = false;
      }
    }
  }

  clear(): void {
    for (const slot of this.pool) {
      slot.alive = false;
      slot.mesh.visible = false;
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    for (const slot of this.pool) {
      (slot.mesh.material as MeshBasicMaterial).dispose();
    }
    this.geometry.dispose();
    this.material.dispose();
    this.texture.dispose();
  }

  private acquire(): PooledDecal {
    // Prefer inactive; otherwise recycle oldest via ring cursor.
    for (let i = 0; i < this.maxDecals; i++) {
      const idx = (this.cursor + i) % this.maxDecals;
      if (!this.pool[idx].alive) {
        this.cursor = (idx + 1) % this.maxDecals;
        return this.pool[idx];
      }
    }
    const forced = this.pool[this.cursor];
    this.cursor = (this.cursor + 1) % this.maxDecals;
    return forced;
  }
}
