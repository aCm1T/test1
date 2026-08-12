import {
  CompressedTexture,
  DataTexture,
  Mesh,
  Scene,
  Texture,
  type BufferAttribute,
  type InterleavedBufferAttribute,
  type Material,
  type Object3D,
  type WebGLRenderer,
} from 'three';
import type { RendererStats } from './Renderer';

export interface PerformanceFrameSample {
  timestampMs: number;
  frameMs: number;
  gpuMs: number;
  mainThreadMs: number;
  drawCalls: number;
  triangles: number;
  gpuDisjoint: boolean;
}

export interface PerformanceHardwareInfo {
  vendor: string;
  device: string;
  timerQueryBits: number;
}

export interface PerformanceCaptureStatus {
  supported: boolean;
  capturing: boolean;
  pendingQueries: number;
  sampleCount: number;
}

export interface PerformanceCaptureResult extends PerformanceCaptureStatus {
  hardware: PerformanceHardwareInfo;
  gpuAssetBytes: number;
  samples: PerformanceFrameSample[];
}

type DisjointTimerQueryExtension = {
  QUERY_COUNTER_BITS_EXT: number;
  TIME_ELAPSED_EXT: number;
  GPU_DISJOINT_EXT: number;
};

type PendingSample = Omit<PerformanceFrameSample, 'gpuMs' | 'gpuDisjoint'> & {
  query: WebGLQuery;
};

/**
 * Browser-side release profiler. GPU timing is measured around the complete
 * world + viewmodel submission with WebGL2 timer queries; CPU timing covers
 * the full requestAnimationFrame callback.
 */
export class WebGLFrameProfiler {
  private readonly gl: WebGL2RenderingContext | null;
  private readonly timer: DisjointTimerQueryExtension | null;
  private readonly scenes: readonly Scene[];
  private readonly pending: PendingSample[] = [];
  private readonly samples: PerformanceFrameSample[] = [];
  private active: {
    query: WebGLQuery;
    timestampMs: number;
    frameMs: number;
  } | null = null;
  private captureStartMs = 0;
  private previousFrameMs: number | null = null;
  private capturing = false;

  constructor(
    renderer: WebGLRenderer,
    scenes: readonly Scene[],
    contextOverride?: WebGL2RenderingContext,
  ) {
    this.scenes = scenes;
    const context = contextOverride ?? renderer.getContext();
    this.gl = isWebGL2TimerContext(context) ? context : null;
    this.timer = this.gl?.getExtension('EXT_disjoint_timer_query_webgl2') ?? null;
  }

  start(): PerformanceCaptureStatus {
    if (!this.gl || !this.timer) {
      throw new Error('EXT_disjoint_timer_query_webgl2 is required for release profiling');
    }
    if (this.capturing || this.active || this.pending.length > 0) {
      throw new Error('A performance capture is already active or draining');
    }
    this.samples.length = 0;
    this.previousFrameMs = null;
    this.captureStartMs = 0;
    this.capturing = true;
    return this.status();
  }

  stop(): PerformanceCaptureStatus {
    this.capturing = false;
    return this.status();
  }

  beginFrame(timestampMs: number): void {
    this.poll();
    if (!this.capturing || !this.gl || !this.timer) return;
    if (!Number.isFinite(timestampMs)) throw new TypeError('frame timestamp must be finite');
    if (this.active) throw new Error('GPU timer query was not ended before the next frame');
    if (this.previousFrameMs === null) {
      this.captureStartMs = timestampMs;
      this.previousFrameMs = timestampMs;
      return;
    }
    const query = this.gl.createQuery();
    if (!query) throw new Error('WebGL could not allocate a timer query');
    const frameMs = timestampMs - this.previousFrameMs;
    this.previousFrameMs = timestampMs;
    if (!(frameMs > 0)) {
      this.gl.deleteQuery(query);
      throw new Error('requestAnimationFrame timestamps must increase');
    }
    this.gl.beginQuery(this.timer.TIME_ELAPSED_EXT, query);
    this.active = {
      query,
      timestampMs: timestampMs - this.captureStartMs,
      frameMs,
    };
  }

  endFrame(mainThreadMs: number, stats: RendererStats): void {
    if (this.active && this.gl && this.timer) {
      this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.pending.push({
        query: this.active.query,
        timestampMs: this.active.timestampMs,
        frameMs: this.active.frameMs,
        mainThreadMs,
        drawCalls: stats.calls,
        triangles: stats.triangles,
      });
      this.active = null;
    }
    this.poll();
  }

  status(): PerformanceCaptureStatus {
    this.poll();
    return {
      supported: Boolean(this.gl && this.timer),
      capturing: this.capturing,
      pendingQueries: this.pending.length + (this.active ? 1 : 0),
      sampleCount: this.samples.length,
    };
  }

  result(): PerformanceCaptureResult {
    const status = this.status();
    if (status.capturing || status.pendingQueries > 0) {
      throw new Error('Performance capture must stop and drain before reading results');
    }
    return {
      ...status,
      hardware: this.hardwareInfo(),
      gpuAssetBytes: estimateGpuAssetBytes(...this.scenes),
      samples: this.samples.map((sample) => ({ ...sample })),
    };
  }

  dispose(): void {
    if (!this.gl) return;
    if (this.active) {
      if (this.timer) this.gl.endQuery(this.timer.TIME_ELAPSED_EXT);
      this.gl.deleteQuery(this.active.query);
      this.active = null;
    }
    for (const sample of this.pending) this.gl.deleteQuery(sample.query);
    this.pending.length = 0;
    this.capturing = false;
  }

  private hardwareInfo(): PerformanceHardwareInfo {
    if (!this.gl || !this.timer) {
      return { vendor: 'unsupported', device: 'unsupported', timerQueryBits: 0 };
    }
    const debug = this.gl.getExtension('WEBGL_debug_renderer_info');
    const vendor = debug
      ? String(this.gl.getParameter(debug.UNMASKED_VENDOR_WEBGL))
      : String(this.gl.getParameter(this.gl.VENDOR));
    const device = debug
      ? String(this.gl.getParameter(debug.UNMASKED_RENDERER_WEBGL))
      : String(this.gl.getParameter(this.gl.RENDERER));
    return {
      vendor,
      device,
      timerQueryBits: Number(this.gl.getQuery(this.timer.TIME_ELAPSED_EXT, this.timer.QUERY_COUNTER_BITS_EXT)),
    };
  }

  private poll(): void {
    if (!this.gl || !this.timer) return;
    while (this.pending.length > 0) {
      const pending = this.pending[0];
      const available = Boolean(this.gl.getQueryParameter(pending.query, this.gl.QUERY_RESULT_AVAILABLE));
      if (!available) break;
      const gpuNanoseconds = Number(this.gl.getQueryParameter(pending.query, this.gl.QUERY_RESULT));
      const gpuDisjoint = Boolean(this.gl.getParameter(this.timer.GPU_DISJOINT_EXT));
      this.gl.deleteQuery(pending.query);
      this.pending.shift();
      this.samples.push({
        timestampMs: pending.timestampMs,
        frameMs: pending.frameMs,
        gpuMs: gpuNanoseconds / 1_000_000,
        mainThreadMs: pending.mainThreadMs,
        drawCalls: pending.drawCalls,
        triangles: pending.triangles,
        gpuDisjoint,
      });
    }
  }
}

/** Estimate resident scene asset buffers, excluding transient render targets. */
export function estimateGpuAssetBytes(...roots: readonly Object3D[]): number {
  const arrays = new Set<ArrayBufferView>();
  const textures = new Set<Texture>();
  for (const root of roots) {
    collectTexture(root instanceof Scene ? root.background : null, textures);
    collectTexture(root instanceof Scene ? root.environment : null, textures);
    root.traverse((object) => {
      const mesh = object as Mesh;
      if (!mesh.isMesh) return;
      const geometry = mesh.geometry;
      for (const attribute of Object.values(geometry.attributes)) collectAttribute(attribute, arrays);
      if (geometry.index) collectAttribute(geometry.index, arrays);
      for (const attributes of Object.values(geometry.morphAttributes)) {
        for (const attribute of attributes) collectAttribute(attribute, arrays);
      }
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) collectMaterialTextures(material, textures);
      const boneTexture = (mesh as Mesh & { skeleton?: { boneTexture?: Texture | null } }).skeleton?.boneTexture;
      collectTexture(boneTexture, textures);
    });
  }
  let bytes = 0;
  for (const array of arrays) bytes += array.byteLength;
  for (const texture of textures) bytes += estimateTextureBytes(texture);
  return bytes;
}

function collectAttribute(
  attribute: BufferAttribute | InterleavedBufferAttribute,
  arrays: Set<ArrayBufferView>,
): void {
  const source = 'data' in attribute ? attribute.data.array : attribute.array;
  if (ArrayBuffer.isView(source)) arrays.add(source);
}

function collectMaterialTextures(material: Material, textures: Set<Texture>): void {
  for (const value of Object.values(material)) collectTexture(value, textures);
}

function collectTexture(value: unknown, textures: Set<Texture>): void {
  if (value instanceof Texture) textures.add(value);
}

function estimateTextureBytes(texture: Texture): number {
  if (texture instanceof CompressedTexture) {
    return texture.mipmaps.reduce((sum, mip) => sum + byteLengthOf(mip.data), 0);
  }
  if (texture instanceof DataTexture) return byteLengthOf(texture.image?.data);
  const images = Array.isArray(texture.image) ? texture.image : [texture.image];
  return images.reduce((sum, image) => {
    const dataBytes = byteLengthOf(image?.data);
    if (dataBytes > 0) return sum + dataBytes;
    const width = Number(image?.naturalWidth ?? image?.videoWidth ?? image?.width ?? 0);
    const height = Number(image?.naturalHeight ?? image?.videoHeight ?? image?.height ?? 0);
    return sum + (width > 0 && height > 0 ? width * height * 4 : 0);
  }, 0);
}

function byteLengthOf(value: unknown): number {
  return ArrayBuffer.isView(value) ? value.byteLength : 0;
}

function isWebGL2TimerContext(
  context: WebGLRenderingContext | WebGL2RenderingContext,
): context is WebGL2RenderingContext {
  const candidate = context as Partial<WebGL2RenderingContext>;
  return typeof candidate.beginQuery === 'function'
    && typeof candidate.createQuery === 'function'
    && typeof candidate.getQueryParameter === 'function';
}
