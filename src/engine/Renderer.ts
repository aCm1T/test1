import {
  ACESFilmicToneMapping,
  Color,
  PCFSoftShadowMap,
  PerspectiveCamera,
  AmbientLight,
  DirectionalLight,
  Material,
  Mesh,
  MeshBasicMaterial,
  MeshDepthMaterial,
  MeshNormalMaterial,
  ShaderMaterial,
  Texture,
  type Object3D,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type WebGLRendererParameters,
} from 'three';
import type { QualityProfile } from './Quality';
import {
  WebGLFrameProfiler,
  type PerformanceCaptureResult,
  type PerformanceCaptureStatus,
} from './PerformanceSampler';

export interface GameRendererOptions {
  /** Mount target for the canvas. Defaults to `#app` or `document.body`. */
  container?: HTMLElement;
  /** Vertical FOV in degrees. */
  fov?: number;
  near?: number;
  far?: number;
  /** ACES exposure — ~1.35–1.5 reads cinematic for dusk combat. */
  exposure?: number;
  /** Shadow map resolution (square). */
  shadowMapSize?: number;
  /** Pixel ratio cap for high-DPI displays. */
  maxPixelRatio?: number;
  clearColor?: number | string;
  /**
   * Enables a persistent WebGL drawing buffer for explicit QA readback only.
   *
   * This has a measurable presentation cost on several drivers, and WebGL
   * context attributes cannot be changed after construction. Never enable it
   * for normal gameplay; browser-level screenshots do not require it.
   */
  captureFrameBuffer?: boolean;
  /** Advanced renderer options. Buffer preservation is intentionally owned by `captureFrameBuffer`. */
  rendererParameters?: Omit<
    WebGLRendererParameters,
    'canvas' | 'antialias' | 'preserveDrawingBuffer'
  >;
}

/** Query parameter recognised by the bootstrap before the WebGL context exists. */
export const QA_CAPTURE_BUFFER_QUERY = 'qaCaptureBuffer';

/**
 * Resolve the one explicit opt-in for pixel readback captures. Keeping this
 * pure lets capture tooling validate its URL without constructing WebGL.
 */
export function isQACaptureBufferRequested(search: string): boolean {
  const normalized = search.startsWith('?') ? search.slice(1) : search;
  return new URLSearchParams(normalized).get(QA_CAPTURE_BUFFER_QUERY) === '1';
}

export interface EngineRenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
}

export type DebugRenderView = 'beauty' | 'albedo' | 'normals' | 'orm' | 'depth';

export interface RendererStats {
  calls: number;
  triangles: number;
  points: number;
  lines: number;
  geometries: number;
  textures: number;
  programs: number;
  peakCalls: number;
  peakTriangles: number;
}

const DEFAULT_SHADOW_MAP_SIZE = 2048;
const DEFAULT_EXPOSURE = 1.4;
const DEFAULT_FOV = 75;
const DEFAULT_NEAR = 0.08;
const DEFAULT_FAR = 420;
const DEFAULT_MAX_PIXEL_RATIO = 2;
/** Lighter dusk blue-gray — readable urban twilight backdrop. */
const DEFAULT_CLEAR_COLOR = 0x1a2433;

/**
 * WebGL renderer bootstrap for BLACKOPS: FRONTLINE.
 * Antialiased, sRGB + ACES Filmic, PCF soft shadows at 2048.
 */
export class GameRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;
  readonly viewModelScene: Scene;
  readonly viewModelCamera: PerspectiveCamera;

  private readonly container: HTMLElement;
  private maxPixelRatio: number;
  private renderScale = 1;
  private readonly shadowMapSize: number;
  private resizeObserver: ResizeObserver | null = null;
  private readonly debugOriginalMaterials = new Map<Mesh, Material | Material[]>();
  private debugView: DebugRenderView = 'beauty';
  private lastFrameStats: RendererStats = emptyRendererStats();
  private readonly frameProfiler: WebGLFrameProfiler;
  private disposed = false;

  constructor(options: GameRendererOptions = {}) {
    this.container =
      options.container ??
      document.getElementById('app') ??
      document.body;
    this.maxPixelRatio = options.maxPixelRatio ?? DEFAULT_MAX_PIXEL_RATIO;
    this.shadowMapSize = Math.max(
      options.shadowMapSize ?? DEFAULT_SHADOW_MAP_SIZE,
      1024,
    );

    this.renderer = this.createRenderer(options);
    this.scene = this.createScene(options);
    this.camera = this.createCamera(options);
    this.viewModelScene = this.createViewModelScene();
    this.viewModelCamera = this.createViewModelCamera();
    this.frameProfiler = new WebGLFrameProfiler(this.renderer, [this.scene, this.viewModelScene]);

    this.attachCanvas();
    this.setSize();
    this.bindResize();
  }

  getContext(): EngineRenderContext {
    return {
      renderer: this.renderer,
      scene: this.scene,
      camera: this.camera,
    };
  }

  setExposure(exposure: number): void {
    this.renderer.toneMappingExposure = Math.max(0, exposure);
  }

  getExposure(): number {
    return this.renderer.toneMappingExposure;
  }

  getShadowMapSize(): number {
    return this.shadowMapSize;
  }

  getStats(): RendererStats {
    return { ...this.lastFrameStats };
  }

  beginFrameStats(): void {
    this.renderer.info.autoReset = false;
    this.renderer.info.reset();
  }

  endFrameStats(): void {
    const info = this.renderer.info;
    const previousPeakCalls = this.lastFrameStats.peakCalls;
    const previousPeakTriangles = this.lastFrameStats.peakTriangles;
    this.lastFrameStats = {
      calls: info.render.calls,
      triangles: info.render.triangles,
      points: info.render.points,
      lines: info.render.lines,
      geometries: info.memory.geometries,
      textures: info.memory.textures,
      programs: info.programs?.length ?? 0,
      peakCalls: Math.max(previousPeakCalls, info.render.calls),
      peakTriangles: Math.max(previousPeakTriangles, info.render.triangles),
    };
  }

  startPerformanceCapture(): PerformanceCaptureStatus {
    return this.frameProfiler.start();
  }

  stopPerformanceCapture(): PerformanceCaptureStatus {
    return this.frameProfiler.stop();
  }

  getPerformanceCaptureStatus(): PerformanceCaptureStatus {
    return this.frameProfiler.status();
  }

  getPerformanceCaptureResult(): PerformanceCaptureResult {
    return this.frameProfiler.result();
  }

  beginPerformanceFrame(timestampMs: number): void {
    this.frameProfiler.beginFrame(timestampMs);
  }

  endPerformanceFrame(mainThreadMs: number): void {
    this.frameProfiler.endFrame(mainThreadMs, this.lastFrameStats);
  }

  getDebugView(): DebugRenderView {
    return this.debugView;
  }

  /** Swap world materials for deterministic QA inspection buffers. */
  setDebugView(view: DebugRenderView): void {
    this.restoreDebugMaterials();
    this.frameProfiler.dispose();
    this.debugView = view;
    if (view === 'beauty') return;
    this.scene.traverse((node) => {
      if (!(node instanceof Mesh) || !node.material) return;
      this.debugOriginalMaterials.set(node, node.material);
      node.material = Array.isArray(node.material)
        ? node.material.map((material) => createDebugMaterial(material, view))
        : createDebugMaterial(node.material, view);
    });
  }

  /** Applies the profile to canvas resolution, texture quality and shadow maps. */
  applyQuality(profile: QualityProfile): void {
    this.renderScale = profile.renderScale;
    this.maxPixelRatio = profile.maxPixelRatio;
    this.renderer.shadowMap.enabled = profile.shadowCascades > 0;
    this.setSize();
  }

  /**
   * Resize to container (or explicit dimensions) and update camera aspect.
   */
  setSize(width?: number, height?: number): void {
    if (this.disposed) return;

    const w = Math.max(
      1,
      width ?? (this.container.clientWidth || window.innerWidth),
    );
    const h = Math.max(
      1,
      height ?? (this.container.clientHeight || window.innerHeight),
    );
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio) * this.renderScale;

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
    this.viewModelCamera.aspect = w / h;
    this.viewModelCamera.updateProjectionMatrix();
  }

  /** Direct scene render — prefer PostProcessing.render when FX are active. */
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  /**
   * Render the weapon scene after the post-processed world.
   *
   * The world composer applies ACES Filmic before reaching the screen. The
   * viewmodel must use the same output transform when it is composited
   * directly afterward, otherwise authored metal/skin values read visibly
   * flatter or hotter than the scene. The renderer state is restored before
   * the next composer frame.
   */
  renderViewModel(): void {
    const autoClear = this.renderer.autoClear;
    const toneMapping = this.renderer.toneMapping;
    try {
      this.renderer.autoClear = false;
      this.renderer.toneMapping = ACESFilmicToneMapping;
      this.renderer.clearDepth();
      this.renderer.render(this.viewModelScene, this.viewModelCamera);
    } finally {
      this.renderer.toneMapping = toneMapping;
      this.renderer.autoClear = autoClear;
    }
  }

  /** Applies anisotropy to authored PBR maps already attached to a scene. */
  applySceneQuality(scene: Scene, profile: QualityProfile): void {
    const anisotropy = Math.min(
      profile.textureAnisotropy,
      this.renderer.capabilities.getMaxAnisotropy(),
    );
    scene.traverse((node: Object3D) => {
      const mesh = node as import('three').Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        for (const value of Object.values(material)) {
          if (value instanceof Texture) value.anisotropy = anisotropy;
        }
      }
    });
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

    this.restoreDebugMaterials();
    this.unbindResize();

    const canvas = this.renderer.domElement;
    canvas.removeEventListener('webglcontextlost', this.onContextLost);
    canvas.removeEventListener('webglcontextrestored', this.onContextRestored);

    if (canvas.parentElement === this.container) {
      this.container.removeChild(canvas);
    }

    this.renderer.dispose();
    this.renderer.forceContextLoss();
  }

  private createRenderer(options: GameRendererOptions): WebGLRenderer {
    const renderer = new WebGLRenderer({
      antialias: true,
      powerPreference: 'high-performance',
      stencil: false,
      depth: true,
      alpha: false,
      logarithmicDepthBuffer: false,
      ...options.rendererParameters,
      // Browser/page screenshots and our normal QA capture path do not need
      // this. Retaining the buffer is an explicit, construction-time QA mode.
      preserveDrawingBuffer: options.captureFrameBuffer === true,
    });

    renderer.outputColorSpace = SRGBColorSpace;
    renderer.toneMapping = ACESFilmicToneMapping;
    renderer.toneMappingExposure = options.exposure ?? DEFAULT_EXPOSURE;

    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = PCFSoftShadowMap;
    renderer.shadowMap.autoUpdate = true;

    renderer.setClearColor(new Color(options.clearColor ?? DEFAULT_CLEAR_COLOR), 1);
    renderer.autoClear = true;

    renderer.domElement.addEventListener('webglcontextlost', this.onContextLost, false);
    renderer.domElement.addEventListener(
      'webglcontextrestored',
      this.onContextRestored,
      false,
    );

    return renderer;
  }

  private createScene(options: GameRendererOptions): Scene {
    const scene = new Scene();
    scene.background = new Color(options.clearColor ?? DEFAULT_CLEAR_COLOR);
    return scene;
  }

  private createCamera(options: GameRendererOptions): PerspectiveCamera {
    const camera = new PerspectiveCamera(
      options.fov ?? DEFAULT_FOV,
      1,
      options.near ?? DEFAULT_NEAR,
      options.far ?? DEFAULT_FAR,
    );
    camera.position.set(0, 1.7, 0);
    camera.rotation.order = 'YXZ';
    return camera;
  }

  /**
   * The weapon occupies roughly a quarter of every frame, so its private scene
   * is the one place a lighting mismatch is guaranteed to be seen.
   *
   * Graded to the street dusk split-tone (warm SunDusk key, cool RimSeparation
   * / MoonFill, restrained cool ambient) so nitride drinks the cool rim+env
   * while polymer stays on the warm key without lifting to the same mid-gray.
   */
  private createViewModelScene(): Scene {
    const scene = new Scene();
    scene.name = 'ViewModelScene';
    // Cool hemi-analogue only — keep underside off black without flattening metal.
    scene.add(new AmbientLight(0x6e849c, 0.26));
    const key = new DirectionalLight(0xf2b17a, 1.78);
    key.name = 'ViewModelKey';
    key.position.set(-2.4, 2.9, 1.5);
    scene.add(key);
    const rim = new DirectionalLight(0xbcd2ec, 1.08);
    rim.name = 'ViewModelRim';
    rim.position.set(1.15, 1.55, -2.85);
    scene.add(rim);
    const moon = new DirectionalLight(0x9bb8d3, 0.4);
    moon.name = 'ViewModelMoonFill';
    moon.position.set(2.5, 1.9, -1.35);
    scene.add(moon);
    return scene;
  }

  /**
   * Share the world's convolved dusk probe with the weapon.
   *
   * Without it the viewmodel's metals have nothing to reflect and read as matte
   * grey plastic against a street whose own metals reflect the sky. A slight
   * intensity bias keeps nitride specular response in the same blue-hour range
   * as route metals without inventing authored GLBs.
   */
  syncViewModelEnvironment(source: Scene): void {
    const intensity = source.environmentIntensity * 1.08;
    if (
      this.viewModelScene.environment === source.environment
      && this.viewModelScene.environmentIntensity === intensity
    ) {
      return;
    }
    this.viewModelScene.environment = source.environment;
    this.viewModelScene.environmentIntensity = intensity;
  }

  private createViewModelCamera(): PerspectiveCamera {
    const camera = new PerspectiveCamera(58, 1, 0.01, 8);
    camera.name = 'ViewModelCamera';
    return camera;
  }

  private attachCanvas(): void {
    const canvas = this.renderer.domElement;
    canvas.style.display = 'block';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.outline = 'none';
    canvas.style.touchAction = 'none';
    canvas.tabIndex = 0;
    this.container.appendChild(canvas);
  }

  private bindResize(): void {
    if (typeof ResizeObserver !== 'undefined') {
      this.resizeObserver = new ResizeObserver(() => {
        this.setSize();
      });
      this.resizeObserver.observe(this.container);
    } else {
      window.addEventListener('resize', this.onWindowResize);
    }
  }

  private unbindResize(): void {
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    window.removeEventListener('resize', this.onWindowResize);
  }

  private readonly onWindowResize = (): void => {
    this.setSize();
  };

  private readonly onContextLost = (event: Event): void => {
    event.preventDefault();
    console.warn('[GameRenderer] WebGL context lost');
  };

  private readonly onContextRestored = (): void => {
    console.info('[GameRenderer] WebGL context restored — reapply size');
    this.setSize();
  };

  private restoreDebugMaterials(): void {
    for (const [mesh, original] of this.debugOriginalMaterials) {
      const current = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of current) material.dispose();
      mesh.material = original;
    }
    this.debugOriginalMaterials.clear();
  }
}

type PbrLikeMaterial = Material & {
  color?: Color;
  map?: Texture | null;
  aoMap?: Texture | null;
  roughnessMap?: Texture | null;
  metalnessMap?: Texture | null;
  aoMapIntensity?: number;
  roughness?: number;
  metalness?: number;
};

function createDebugMaterial(source: Material, view: Exclude<DebugRenderView, 'beauty'>): Material {
  if (view === 'normals') return new MeshNormalMaterial();
  if (view === 'depth') return new MeshDepthMaterial();
  const pbr = source as PbrLikeMaterial;
  if (view === 'albedo') {
    return new MeshBasicMaterial({
      color: pbr.color?.clone() ?? new Color(0xffffff),
      map: pbr.map ?? null,
    });
  }
  return new ShaderMaterial({
    uniforms: {
      aoMap: { value: pbr.aoMap ?? null },
      roughnessMap: { value: pbr.roughnessMap ?? null },
      metalnessMap: { value: pbr.metalnessMap ?? null },
      hasAoMap: { value: pbr.aoMap ? 1 : 0 },
      hasRoughnessMap: { value: pbr.roughnessMap ? 1 : 0 },
      hasMetalnessMap: { value: pbr.metalnessMap ? 1 : 0 },
      ao: { value: pbr.aoMapIntensity ?? 1 },
      roughness: { value: pbr.roughness ?? 1 },
      metalness: { value: pbr.metalness ?? 0 },
    },
    vertexShader: `
      varying vec2 vUv;
      void main() {
        vUv = uv;
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `,
    fragmentShader: `
      uniform sampler2D aoMap;
      uniform sampler2D roughnessMap;
      uniform sampler2D metalnessMap;
      uniform float hasAoMap;
      uniform float hasRoughnessMap;
      uniform float hasMetalnessMap;
      uniform float ao;
      uniform float roughness;
      uniform float metalness;
      varying vec2 vUv;
      void main() {
        float o = hasAoMap > 0.5 ? texture2D(aoMap, vUv).r * ao : ao;
        float r = hasRoughnessMap > 0.5 ? texture2D(roughnessMap, vUv).g * roughness : roughness;
        float m = hasMetalnessMap > 0.5 ? texture2D(metalnessMap, vUv).b * metalness : metalness;
        gl_FragColor = vec4(o, r, m, 1.0);
      }
    `,
  });
}

function emptyRendererStats(): RendererStats {
  return {
    calls: 0,
    triangles: 0,
    points: 0,
    lines: 0,
    geometries: 0,
    textures: 0,
    programs: 0,
    peakCalls: 0,
    peakTriangles: 0,
  };
}

/** @deprecated Prefer GameRenderer — kept for transitional imports. */
export { GameRenderer as Renderer };

export function createRenderContext(
  options?: GameRendererOptions,
): EngineRenderContext & { engine: GameRenderer } {
  const engine = new GameRenderer(options);
  return {
    ...engine.getContext(),
    engine,
  };
}
