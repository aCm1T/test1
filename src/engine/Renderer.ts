import {
  ACESFilmicToneMapping,
  Color,
  PCFSoftShadowMap,
  PerspectiveCamera,
  Scene,
  SRGBColorSpace,
  WebGLRenderer,
  type WebGLRendererParameters,
} from 'three';

export interface GameRendererOptions {
  /** Mount target for the canvas. Defaults to `#app` or `document.body`. */
  container?: HTMLElement;
  /** Vertical FOV in degrees. */
  fov?: number;
  near?: number;
  far?: number;
  /** ACES exposure — ~1.05–1.2 reads cinematic for dusk combat. */
  exposure?: number;
  /** Shadow map resolution (square). */
  shadowMapSize?: number;
  /** Pixel ratio cap for high-DPI displays. */
  maxPixelRatio?: number;
  clearColor?: number | string;
  rendererParameters?: Omit<WebGLRendererParameters, 'canvas' | 'antialias'>;
}

export interface EngineRenderContext {
  renderer: WebGLRenderer;
  scene: Scene;
  camera: PerspectiveCamera;
}

const DEFAULT_SHADOW_MAP_SIZE = 2048;
const DEFAULT_EXPOSURE = 1.12;
const DEFAULT_FOV = 75;
const DEFAULT_NEAR = 0.08;
const DEFAULT_FAR = 420;
const DEFAULT_MAX_PIXEL_RATIO = 2;
/** Deep charcoal-blue void — dusk backdrop before fog/lighting. */
const DEFAULT_CLEAR_COLOR = 0x0a0e14;

/**
 * WebGL renderer bootstrap for BLACKOPS: FRONTLINE.
 * Antialiased, sRGB + ACES Filmic, PCF soft shadows at 2048.
 */
export class GameRenderer {
  readonly renderer: WebGLRenderer;
  readonly scene: Scene;
  readonly camera: PerspectiveCamera;

  private readonly container: HTMLElement;
  private readonly maxPixelRatio: number;
  private readonly shadowMapSize: number;
  private resizeObserver: ResizeObserver | null = null;
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
    const pixelRatio = Math.min(window.devicePixelRatio || 1, this.maxPixelRatio);

    this.renderer.setPixelRatio(pixelRatio);
    this.renderer.setSize(w, h, true);
    this.camera.aspect = w / h;
    this.camera.updateProjectionMatrix();
  }

  /** Direct scene render — prefer PostProcessing.render when FX are active. */
  render(): void {
    this.renderer.render(this.scene, this.camera);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;

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
