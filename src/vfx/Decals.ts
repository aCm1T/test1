import {
  CanvasTexture,
  CircleGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  MeshBasicMaterial,
  Object3D,
  Quaternion,
  Scene,
  Vector3,
} from 'three';
import { SeededRandom, type RandomSource } from '../mission';

/** Decal families. Impacts pick one so holes match what was actually shot. */
export type DecalSurface = 'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'default';

export interface DecalHit {
  position: Vector3;
  normal: Vector3;
  size?: number;
  surface?: DecalSurface;
}

interface PooledDecal {
  /** Which surface batch currently owns this slot, if any. */
  surface: DecalSurface | null;
  alive: boolean;
  age: number;
  maxAge: number;
  /** Peak opacity for this placement, including the brief hot-rim boost. */
  peakOpacity: number;
  /** Seconds of extra brightness while the crater is still glowing. */
  glow: number;
}

/**
 * One instanced draw per bullet-hole family. Each pool slot keeps the same
 * instance index in whichever batch currently owns it, so recycling a hole
 * never has to compact or re-pack the buffers.
 */
interface DecalBatch {
  mesh: InstancedMesh;
  opacity: InstancedBufferAttribute;
  alive: number;
}

export function resolveDecalSurface(surface: string | null | undefined): DecalSurface {
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

const UP = new Vector3(0, 0, 1);
const _quat = new Quaternion();
const _spin = new Quaternion();
const _n = new Vector3();
const _position = new Vector3();
const _scale = new Vector3();
const _matrix = new Matrix4();
const _color = new Color();
const HIDDEN = new Matrix4().makeScale(0, 0, 0);

/**
 * Adds a per-instance opacity attribute to a basic material. Decals fade
 * individually, which instancing cannot express through the shared uniform.
 */
function useInstanceOpacity(material: MeshBasicMaterial): void {
  material.onBeforeCompile = (shader) => {
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nattribute float instanceOpacity;\nvarying float vDecalOpacity;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvDecalOpacity = instanceOpacity;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', '#include <common>\nvarying float vDecalOpacity;')
      .replace('#include <map_fragment>', '#include <map_fragment>\ndiffuseColor.a *= vDecalOpacity;');
  };
  material.customProgramCacheKey = () => 'decal-instance-opacity';
}

interface DecalStyle {
  /** Colour multiplier applied to the pooled material. */
  tint: number;
  /** Relative hole size for this material. */
  scale: number;
  /** Chipped/torn rim colour drawn outside the crater. */
  rim: string;
  /** Number of radial cracks; glass and concrete crack, dirt does not. */
  cracks: number;
  /** Splinter streaks, used by wood. */
  splinters: number;
  /** Soft outer dust ring opacity. */
  dust: number;
}

const DECAL_STYLES: Record<DecalSurface, DecalStyle> = {
  concrete: { tint: 0xd8d4cc, scale: 1.15, rim: 'rgba(216,212,202,0.85)', cracks: 7, splinters: 0, dust: 0.5 },
  metal: { tint: 0xf0f2f5, scale: 0.8, rim: 'rgba(228,236,245,0.95)', cracks: 3, splinters: 0, dust: 0.12 },
  wood: { tint: 0xb08a58, scale: 1.05, rim: 'rgba(150,110,66,0.8)', cracks: 2, splinters: 7, dust: 0.3 },
  dirt: { tint: 0x9a8266, scale: 1.35, rim: 'rgba(120,98,72,0.6)', cracks: 0, splinters: 0, dust: 0.75 },
  glass: { tint: 0xe6f2f8, scale: 1.1, rim: 'rgba(226,242,250,0.9)', cracks: 12, splinters: 0, dust: 0.1 },
  default: { tint: 0xffffff, scale: 1, rim: 'rgba(150,140,126,0.55)', cracks: 7, splinters: 0, dust: 0.35 },
};

/**
 * Draws one bullet-hole family. Every surface shares the dark crater core, and
 * the rim treatment (chipped, torn, splintered, cracked) is what distinguishes
 * concrete from metal from wood at a glance.
 */
function createBulletHoleTexture(
  random: RandomSource,
  surface: DecalSurface = 'default',
  size = 128,
): CanvasTexture {
  const style = DECAL_STYLES[surface];
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

  // Chipped/torn rim: the bright ring of exposed material around the hole.
  ctx.strokeStyle = style.rim;
  ctx.lineWidth = surface === 'metal' ? 3.2 : 2;
  ctx.beginPath();
  for (let i = 0; i <= 26; i++) {
    const ang = (i / 26) * Math.PI * 2;
    const jitter = 1 + (random() - 0.5) * (surface === 'metal' ? 0.32 : 0.24);
    const r = size * 0.2 * jitter;
    const px = cx + Math.cos(ang) * r;
    const py = cy + Math.sin(ang) * r;
    if (i === 0) ctx.moveTo(px, py);
    else ctx.lineTo(px, py);
  }
  ctx.closePath();
  ctx.stroke();

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
  ctx.strokeStyle = surface === 'glass' ? 'rgba(226,240,250,0.6)' : 'rgba(8,6,4,0.55)';
  ctx.lineWidth = 1.2;
  for (let i = 0; i < style.cracks; i++) {
    const ang = (i / Math.max(1, style.cracks)) * Math.PI * 2 + random() * 0.4;
    const len = size * (0.12 + random() * (surface === 'glass' ? 0.34 : 0.22));
    ctx.beginPath();
    ctx.moveTo(cx + Math.cos(ang) * size * 0.04, cy + Math.sin(ang) * size * 0.04);
    ctx.lineTo(cx + Math.cos(ang) * len, cy + Math.sin(ang) * len);
    ctx.stroke();
  }

  // Wood tears along the grain rather than cracking radially.
  if (style.splinters > 0) {
    ctx.strokeStyle = 'rgba(96,68,38,0.7)';
    ctx.lineWidth = 1.6;
    for (let i = 0; i < style.splinters; i++) {
      const offset = (random() - 0.5) * size * 0.34;
      const len = size * (0.1 + random() * 0.26);
      ctx.beginPath();
      ctx.moveTo(cx - len, cy + offset);
      ctx.lineTo(cx + len, cy + offset * 0.8);
      ctx.stroke();
    }
  }

  // Soft dust halo — heavy on concrete and dirt, nearly absent on metal.
  if (style.dust > 0.02) {
    g = ctx.createRadialGradient(cx, cy, size * 0.18, cx, cy, size * 0.5);
    g.addColorStop(0, `rgba(200,194,182,${0.3 * style.dust})`);
    g.addColorStop(1, 'rgba(200,194,182,0)');
    ctx.fillStyle = g;
    ctx.beginPath();
    ctx.arc(cx, cy, size * 0.5, 0, Math.PI * 2);
    ctx.fill();
  }

  // Speckled debris ring
  for (let i = 0; i < 28; i++) {
    const ang = random() * Math.PI * 2;
    const r = size * (0.1 + random() * 0.28);
    const s = 0.5 + random() * 1.8;
    ctx.fillStyle = `rgba(15,12,8,${0.25 + random() * 0.45})`;
    ctx.beginPath();
    ctx.arc(cx + Math.cos(ang) * r, cy + Math.sin(ang) * r, s, 0, Math.PI * 2);
    ctx.fill();
  }

  const tex = new CanvasTexture(canvas);
  tex.name = `BulletHole_${surface}`;
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
  private readonly textures = new Map<DecalSurface, CanvasTexture>();
  private readonly batches = new Map<DecalSurface, DecalBatch>();
  private readonly materials: MeshBasicMaterial[] = [];
  private readonly batchGeometries: CircleGeometry[] = [];
  private readonly geometry: CircleGeometry;
  private readonly material: MeshBasicMaterial;
  private readonly maxDecals: number;
  private readonly lifetime: number;
  private readonly random: RandomSource;
  private cursor = 0;
  private disposed = false;

  constructor(
    scene: Scene,
    options: { maxDecals?: number; lifetime?: number; random?: RandomSource } = {},
  ) {
    this.scene = scene;
    this.maxDecals = options.maxDecals ?? 96;
    this.lifetime = options.lifetime ?? 45;
    const fallbackRandom = new SeededRandom(0x44454341);
    this.random = options.random ?? (() => fallbackRandom.next());

    this.root = new Object3D();
    this.root.name = 'DecalRoot';
    scene.add(this.root);

    for (const surface of ['concrete', 'metal', 'wood', 'dirt', 'glass', 'default'] as const) {
      this.textures.set(surface, createBulletHoleTexture(this.random, surface));
    }
    this.texture = this.textures.get('default')!;
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

    for (const [surface, texture] of this.textures) {
      const material = this.material.clone();
      material.map = texture;
      useInstanceOpacity(material);
      this.materials.push(material);

      // Each batch owns its geometry because the per-instance opacity buffer
      // is stored on the geometry, not on the mesh.
      const geometry = this.geometry.clone();
      this.batchGeometries.push(geometry);
      const mesh = new InstancedMesh(geometry, material, this.maxDecals);
      mesh.name = `DecalBatch:${surface}`;
      mesh.count = 0;
      mesh.renderOrder = 2;
      // Holes are scattered across the whole level and rewritten constantly,
      // so an instance-aware bounding sphere would have to be rebuilt every
      // impact for no benefit over these few submissions.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(DynamicDrawUsage);
      for (let i = 0; i < this.maxDecals; i++) mesh.setMatrixAt(i, HIDDEN);

      const opacity = new InstancedBufferAttribute(new Float32Array(this.maxDecals), 1);
      opacity.setUsage(DynamicDrawUsage);
      mesh.geometry.setAttribute('instanceOpacity', opacity);
      this.root.add(mesh);
      this.batches.set(surface, { mesh, opacity, alive: 0 });
    }

    for (let i = 0; i < this.maxDecals; i++) {
      this.pool.push({
        surface: null,
        alive: false,
        age: 0,
        maxAge: this.lifetime,
        peakOpacity: 0.92,
        glow: 0,
      });
    }
  }

  /**
   * Place a bullet hole aligned to surface normal, slightly offset to avoid z-fight.
   */
  spawn(hit: DecalHit): boolean {
    if (this.disposed) return false;

    const surface = hit.surface ?? 'default';
    const style = DECAL_STYLES[surface];
    const index = this.acquire();
    const slot = this.pool[index];
    const size = (hit.size ?? 0.08 + this.random() * 0.06) * style.scale;

    // A recycled slot may still be drawn by another family's batch.
    if (slot.surface && slot.surface !== surface) this.release(slot, index);

    _n.copy(hit.normal).normalize();
    _position.copy(hit.position).addScaledVector(_n, 0.012);
    _quat.setFromUnitVectors(UP, _n);
    _quat.multiply(_spin.setFromAxisAngle(UP, this.random() * Math.PI * 2));
    _scale.setScalar(size);
    _matrix.compose(_position, _quat, _scale);

    const batch = this.batches.get(surface) ?? this.batches.get('default')!;
    slot.surface = surface;
    batch.mesh.setMatrixAt(index, _matrix);
    batch.mesh.instanceMatrix.needsUpdate = true;
    batch.mesh.setColorAt(index, _color.setHex(style.tint));
    if (batch.mesh.instanceColor) batch.mesh.instanceColor.needsUpdate = true;

    slot.peakOpacity = 0.92;
    // A fresh hole is briefly hotter and more opaque than a settled one, which
    // gives every impact a short "just happened" read before it becomes scenery.
    slot.glow = 0.16;
    this.setOpacity(batch, index, 1);

    if (!slot.alive) batch.alive += 1;
    slot.alive = true;
    slot.age = 0;
    slot.maxAge = this.lifetime * (0.85 + this.random() * 0.3);
    batch.mesh.count = this.maxDecals;

    return true;
  }

  spawnAt(
    position: Vector3,
    normal: Vector3,
    size?: number,
    surface: DecalSurface = 'default',
  ): boolean {
    return this.spawn({ position, normal, size, surface });
  }

  update(dt: number): void {
    if (this.disposed) return;

    for (let index = 0; index < this.pool.length; index += 1) {
      const slot = this.pool[index];
      if (!slot.alive || !slot.surface) continue;
      const batch = this.batches.get(slot.surface);
      if (!batch) continue;
      slot.age += dt;

      if (slot.glow > 0) {
        slot.glow = Math.max(0, slot.glow - dt);
        this.setOpacity(
          batch,
          index,
          slot.peakOpacity + (1 - slot.peakOpacity) * (slot.glow / 0.16),
        );
      }

      const fadeStart = slot.maxAge * 0.72;
      if (slot.age > fadeStart) {
        const t = (slot.age - fadeStart) / (slot.maxAge - fadeStart);
        this.setOpacity(batch, index, slot.peakOpacity * (1 - t));
      }

      if (slot.age >= slot.maxAge) this.release(slot, index);
    }
  }

  clear(): void {
    for (let index = 0; index < this.pool.length; index += 1) {
      this.release(this.pool[index], index);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.scene.remove(this.root);
    for (const batch of this.batches.values()) batch.mesh.dispose();
    this.batches.clear();
    for (const geometry of this.batchGeometries) geometry.dispose();
    this.batchGeometries.length = 0;
    for (const material of this.materials) material.dispose();
    this.materials.length = 0;
    this.geometry.dispose();
    this.material.dispose();
    for (const texture of this.textures.values()) texture.dispose();
    this.textures.clear();
  }

  /** Stops drawing one slot and frees the batch it was assigned to. */
  private release(slot: PooledDecal, index: number): void {
    const batch = slot.surface ? this.batches.get(slot.surface) : undefined;
    if (batch) {
      batch.mesh.setMatrixAt(index, HIDDEN);
      batch.mesh.instanceMatrix.needsUpdate = true;
      this.setOpacity(batch, index, 0);
      if (slot.alive) batch.alive = Math.max(0, batch.alive - 1);
      // An empty family is skipped entirely rather than submitting a batch of
      // collapsed instances every frame.
      if (batch.alive === 0) batch.mesh.count = 0;
    }
    slot.alive = false;
    slot.surface = null;
  }

  private setOpacity(batch: DecalBatch, index: number, value: number): void {
    batch.opacity.setX(index, value);
    batch.opacity.needsUpdate = true;
  }

  private acquire(): number {
    // Prefer inactive; otherwise recycle oldest via ring cursor.
    for (let i = 0; i < this.maxDecals; i++) {
      const idx = (this.cursor + i) % this.maxDecals;
      if (!this.pool[idx].alive) {
        this.cursor = (idx + 1) % this.maxDecals;
        return idx;
      }
    }
    const forced = this.cursor;
    this.cursor = (this.cursor + 1) % this.maxDecals;
    return forced;
  }
}
