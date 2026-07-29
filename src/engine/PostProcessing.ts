import {
  HalfFloatType,
  NoToneMapping,
  Vector2,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';

export interface PostProcessingOptions {
  /** Bloom intensity at rest (muzzle flashes push this higher via gameplay). */
  bloomIntensity?: number;
  /** Base vignette darkness before damage feedback. */
  vignetteDarkness?: number;
  /** Base chromatic offset in UV units. */
  chromaticOffset?: number;
  /** Film grain opacity via blend opacity. */
  noiseOpacity?: number;
}

/**
 * Full-screen post stack for BLACKOPS: FRONTLINE.
 * Bloom + vignette + chromatic aberration + SMAA + subtle grain.
 * Damage intensity ramps vignette / aberration for hit feedback.
 */
export class PostProcessing {
  readonly composer: EffectComposer;

  private readonly bloom: BloomEffect;
  private readonly vignette: VignetteEffect;
  private readonly chromatic: ChromaticAberrationEffect;
  private readonly noise: NoiseEffect;
  private readonly smaa: SMAAEffect;
  private readonly toneMapping: ToneMappingEffect;
  private readonly bloomPass: EffectPass;
  private readonly chromaticPass: EffectPass;
  private readonly gradingPass: EffectPass;
  private readonly renderPass: RenderPass;
  private readonly effectPasses: EffectPass[];

  private readonly baseBloom: number;
  private readonly baseVignette: number;
  private readonly baseChromatic: number;
  private readonly chromaticOffset = new Vector2();

  private damageIntensity = 0;
  private disposed = false;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    options: PostProcessingOptions = {},
  ) {
    this.baseBloom = options.bloomIntensity ?? 0.35;
    this.baseVignette = options.vignetteDarkness ?? 0.25;
    this.baseChromatic = options.chromaticOffset ?? 0.0008;

    // Tone mapping is handled by the composer so the HDR bloom path stays linear.
    renderer.toneMapping = NoToneMapping;

    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    this.bloom = new BloomEffect({
      intensity: this.baseBloom,
      luminanceThreshold: 0.55,
      luminanceSmoothing: 0.2,
      mipmapBlur: true,
      radius: 0.55,
    });

    this.vignette = new VignetteEffect({
      offset: 0.35,
      darkness: this.baseVignette,
    });

    this.chromaticOffset.set(this.baseChromatic, this.baseChromatic * 0.6);
    this.chromatic = new ChromaticAberrationEffect({
      offset: this.chromaticOffset.clone(),
      radialModulation: true,
      modulationOffset: 0.22,
    });

    this.noise = new NoiseEffect({
      blendFunction: BlendFunction.SOFT_LIGHT,
      premultiply: true,
    });
    this.noise.blendMode.opacity.value = options.noiseOpacity ?? 0.045;

    this.smaa = new SMAAEffect({
      preset: SMAAPreset.HIGH,
    });

    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
    });

    // Convolution effects (Bloom, ChromaticAberration) cannot share an EffectPass.
    this.bloomPass = new EffectPass(camera, this.bloom);
    this.chromaticPass = new EffectPass(camera, this.chromatic);
    this.gradingPass = new EffectPass(
      camera,
      this.vignette,
      this.noise,
      this.smaa,
      this.toneMapping,
    );
    this.effectPasses = [this.bloomPass, this.chromaticPass, this.gradingPass];
    for (const pass of this.effectPasses) {
      this.composer.addPass(pass);
    }

    this.setSize(
      renderer.domElement.clientWidth || window.innerWidth,
      renderer.domElement.clientHeight || window.innerHeight,
    );
  }

  /**
   * Swap the active camera (e.g. menu cam → player cam) without rebuilding the stack.
   */
  setCamera(camera: Camera): void {
    this.renderPass.mainCamera = camera;
    for (const pass of this.effectPasses) {
      pass.mainCamera = camera;
    }
  }

  setScene(scene: Scene): void {
    this.renderPass.mainScene = scene;
  }

  setSize(width: number, height: number): void {
    if (this.disposed) return;
    this.composer.setSize(Math.max(1, width), Math.max(1, height));
  }

  /**
   * 0 = healthy, 1 = near-death. Drives vignette darkness + chromatic bleed.
   */
  setDamageIntensity(intensity: number): void {
    this.damageIntensity = Math.min(1, Math.max(0, intensity));
    this.applyDamageLook();
  }

  getDamageIntensity(): number {
    return this.damageIntensity;
  }

  /** Transient muzzle / explosion bloom punch. */
  pulseBloom(amount = 0.55, decay = 0.85): void {
    this.bloom.intensity = Math.min(2.2, this.baseBloom + amount);
    // Soft decay happens in render() toward base + damage contribution.
    void decay;
  }

  render(delta: number): void {
    if (this.disposed) return;

    // Ease bloom back toward base after pulses.
    const targetBloom = this.baseBloom + this.damageIntensity * 0.25;
    this.bloom.intensity += (targetBloom - this.bloom.intensity) * Math.min(1, delta * 6);

    this.composer.render(delta);
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    this.composer.dispose();
  }

  private applyDamageLook(): void {
    const d = this.damageIntensity;
    this.vignette.darkness = this.baseVignette + d * 0.55;
    this.vignette.offset = 0.35 - d * 0.12;

    const c = this.baseChromatic + d * 0.0045;
    this.chromatic.offset.set(c, c * 0.65);

    this.noise.blendMode.opacity.value = 0.045 + d * 0.08;
  }
}
