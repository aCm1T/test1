import {
  Color,
  DataTexture,
  HalfFloatType,
  NoToneMapping,
  RGBAFormat,
  RepeatWrapping,
  Uniform,
  UnsignedByteType,
  Vector2,
  type Camera,
  type Scene,
  type WebGLRenderer,
} from 'three';
import {
  BlendFunction,
  BloomEffect,
  ChromaticAberrationEffect,
  Effect,
  EffectComposer,
  EffectPass,
  NoiseEffect,
  RenderPass,
  SMAAEffect,
  SMAAPreset,
  SSAOEffect,
  ToneMappingEffect,
  ToneMappingMode,
  VignetteEffect,
} from 'postprocessing';
import type { QualityProfile } from './Quality';

/**
 * Linear-space split-tone grade applied immediately before ACES.
 *
 * Dusk footage reads as dusk because shadows carry the sky's blue and only
 * light-facing surfaces keep the sun's warmth. ACES alone cannot express that
 * separation, so the scene otherwise resolves to one uniform blue-grey.
 *
 * Every operation here is deliberately exposure-preserving. This pass runs on
 * scene-referred HDR, where a dusk street sits two or more stops under the
 * 0.18 mid-grey convention: any grade that subtracts, or that tints with a
 * sub-unit-luminance multiplier, drives that whole range to zero and returns a
 * black frame with floating windows. So the tints are luminance-normalised
 * (hue only) and contrast is a multiplicative gain around the pivot, which
 * cannot cross zero no matter how dark the input is.
 */
const DUSK_GRADE_FRAGMENT = `
uniform vec3 shadowTint;
uniform vec3 highlightTint;
uniform float gradeContrast;
uniform float gradeSaturation;
uniform float shadowLift;
uniform float gradePivot;

const vec3 LUMA = vec3(0.2126, 0.7152, 0.0722);

vec3 normalizeTint(const in vec3 tint) {
  return tint / max(dot(tint, LUMA), 1e-4);
}

void mainImage(const in vec4 inputColor, const in vec2 uv, out vec4 outputColor) {
  vec3 color = max(inputColor.rgb, 0.0);
  float luma = max(dot(color, LUMA), 1e-5);

  // Tone-dependent hue split. The bounds are scene-referred: the upper one
  // sits above the street's lit midtones so only practicals and sun-facing
  // planes take the warm side.
  float toneMix = smoothstep(0.006, 0.22, luma);
  color *= mix(normalizeTint(shadowTint), normalizeTint(highlightTint), toneMix);

  color = mix(vec3(luma), color, gradeSaturation);

  // Multiplicative S-curve around a dusk-range pivot. Highlights gain, shadows
  // fall off proportionally, and nothing is ever pushed below zero.
  color *= pow(luma / gradePivot, gradeContrast - 1.0);

  // A filmic toe: shadows settle into the sky's blue instead of clipping.
  color += normalizeTint(shadowTint) * shadowLift * (1.0 - toneMix);

  outputColor = vec4(max(color, 0.0), inputColor.a);
}
`;

export interface DuskGradeOptions {
  shadowTint?: number;
  highlightTint?: number;
  contrast?: number;
  saturation?: number;
  shadowLift?: number;
  /** Scene-referred luminance the contrast curve rotates around. */
  pivot?: number;
}

const DUSK_GRADE_CONTRAST = 1.12;
const DUSK_GRADE_SATURATION = 1.14;
const DUSK_GRADE_SHADOW_LIFT = 0.004;

/** Cheap ALU-only grade; it shares the existing grading EffectPass. */
export class DuskGradeEffect extends Effect {
  constructor(options: DuskGradeOptions = {}) {
    super('DuskGradeEffect', DUSK_GRADE_FRAGMENT, {
      blendFunction: BlendFunction.NORMAL,
      uniforms: new Map<string, Uniform>([
        ['shadowTint', new Uniform(new Color(options.shadowTint ?? 0x8fa6c6))],
        ['highlightTint', new Uniform(new Color(options.highlightTint ?? 0xffd0a2))],
        ['gradeContrast', new Uniform(options.contrast ?? DUSK_GRADE_CONTRAST)],
        ['gradeSaturation', new Uniform(options.saturation ?? DUSK_GRADE_SATURATION)],
        ['shadowLift', new Uniform(options.shadowLift ?? DUSK_GRADE_SHADOW_LIFT)],
        // The blue-hour street's lit midtones, not the 0.18 stills convention.
        // It tracks the route's actual exposure: set above the scene's real
        // midtones the S-curve rotates the whole frame into its shadow side.
        ['gradePivot', new Uniform(options.pivot ?? 0.05)],
      ]),
    });
  }

  /** Low tier keeps the hue split but drops the extra contrast/saturation. */
  setStrength(strength: number): void {
    const clamped = Math.min(1, Math.max(0, strength));
    this.uniforms.get('gradeContrast')!.value = 1 + (DUSK_GRADE_CONTRAST - 1) * clamped;
    this.uniforms.get('gradeSaturation')!.value = 1 + (DUSK_GRADE_SATURATION - 1) * clamped;
    this.uniforms.get('shadowLift')!.value = DUSK_GRADE_SHADOW_LIFT * clamped;
  }
}

export interface PostProcessingOptions {
  /** Bloom intensity at rest (muzzle flashes push this higher via gameplay). */
  bloomIntensity?: number;
  /** Base vignette darkness before damage feedback. */
  vignetteDarkness?: number;
  /** Base chromatic offset in UV units. */
  chromaticOffset?: number;
  /** Film grain opacity via blend opacity. */
  noiseOpacity?: number;
  /**
   * Composer/viewmodel exposure. The fallback uses a slightly lower value to
   * keep its direct-lit geometry in the dusk range without crushing shadow
   * detail; authored routes can retain their calibrated exposure.
   */
  exposure?: number;
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
  private readonly ssao: SSAOEffect;
  private readonly ssaoNoise: DataTexture;
  private readonly duskGrade: DuskGradeEffect;
  private readonly toneMapping: ToneMappingEffect;
  private readonly bloomPass: EffectPass;
  private readonly ssaoPass: EffectPass;
  private readonly chromaticPass: EffectPass;
  private readonly gradingPass: EffectPass;
  private readonly renderPass: RenderPass;
  private readonly effectPasses: EffectPass[];

  private readonly baseBloom: number;
  private readonly baseVignette: number;
  private readonly baseChromatic: number;
  private readonly chromaticOffset = new Vector2();

  private damageIntensity = 0;
  private deterministicCapture = false;
  private qualityNoiseOpacity: number;
  private disposed = false;

  constructor(
    renderer: WebGLRenderer,
    scene: Scene,
    camera: Camera,
    options: PostProcessingOptions = {},
  ) {
    this.baseBloom = options.bloomIntensity ?? 0.34;
    this.baseVignette = options.vignetteDarkness ?? 0.24;
    // No persistent chromatic aberration; damage is the sole trigger.
    this.baseChromatic = options.chromaticOffset ?? 0;
    this.qualityNoiseOpacity = options.noiseOpacity ?? 0.028;

    // Tone mapping is handled by the composer so the HDR bloom path stays linear.
    // The native viewmodel pass is composited immediately afterward, so it
    // deliberately shares this exposure through the renderer state.
    renderer.toneMappingExposure = options.exposure ?? renderer.toneMappingExposure;
    renderer.toneMapping = NoToneMapping;

    this.composer = new EffectComposer(renderer, {
      frameBufferType: HalfFloatType,
      multisampling: 0,
    });

    this.renderPass = new RenderPass(scene, camera);
    this.composer.addPass(this.renderPass);

    // Practicals (windows, lamps, sign strips) are authored above 1.0 linear so
    // they are the only surfaces that bloom. Keep radius tight enough that
    // sprites/panes read as light sources, not soft circular glow cards.
    this.bloom = new BloomEffect({
      intensity: this.baseBloom,
      luminanceThreshold: 0.82,
      luminanceSmoothing: 0.18,
      mipmapBlur: true,
      radius: 0.48,
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
    this.noise.blendMode.opacity.value = this.qualityNoiseOpacity;

    this.smaa = new SMAAEffect({
      preset: SMAAPreset.MEDIUM,
    });

    // Depth-aware contact AO. The procedural route has no baked occlusion, so
    // this pass is the only thing seating props, curbs and facade returns onto
    // their surfaces; a wider radius restores creases the blockout cannot bake.
    this.ssao = new SSAOEffect(camera, undefined, {
      blendFunction: BlendFunction.MULTIPLY,
      samples: 12,
      rings: 7,
      radius: 0.32,
      // The blockout bakes no occlusion at all, so this pass is solely
      // responsible for seating props, kerbs and facade returns. At the
      // previous strength it was invisible in captures and every object
      // floated on the surface it was standing on.
      intensity: 1.15,
      bias: 0.025,
      fade: 0.035,
      resolutionScale: 0.8,
    });
    const generatedNoise = this.ssao.ssaoMaterial.uniforms.noiseTexture?.value as
      | import('three').Texture
      | undefined;
    this.ssaoNoise = createDeterministicNoiseTexture(64, 0x4e47414f);
    this.ssao.ssaoMaterial.noiseTexture = this.ssaoNoise;
    generatedNoise?.dispose();

    this.duskGrade = new DuskGradeEffect();

    this.toneMapping = new ToneMappingEffect({
      mode: ToneMappingMode.ACES_FILMIC,
    });

    // Convolution effects (Bloom, ChromaticAberration) cannot share an EffectPass.
    this.bloomPass = new EffectPass(camera, this.bloom);
    this.ssaoPass = new EffectPass(camera, this.ssao);
    this.chromaticPass = new EffectPass(camera, this.chromatic);
    // The grade runs on scene-referred HDR values; tone mapping stays last.
    this.gradingPass = new EffectPass(
      camera,
      this.duskGrade,
      this.vignette,
      this.noise,
      this.smaa,
      this.toneMapping,
    );
    this.effectPasses = [this.bloomPass, this.ssaoPass, this.chromaticPass, this.gradingPass];
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

  applyQuality(profile: QualityProfile): void {
    this.bloomPass.enabled = profile.bloom;
    // Medium explicitly advertises ambient occlusion in its quality profile;
    // retaining this pass there restores the intended small-scale grounding
    // without enabling it on the low profile.
    this.ssaoPass.enabled = profile.ambientOcclusion;
    this.gradingPass.enabled = true;
    this.smaa.blendMode.opacity.value = profile.tier === 'low' ? 0.55 : 1;
    this.duskGrade.setStrength(profile.tier === 'low' ? 0.6 : 1);
    this.qualityNoiseOpacity = profile.tier === 'low' ? 0.015 : 0.028;
    this.applyDamageLook();
  }

  /** Disable wall-clock-driven grain while deterministic QA frames are captured. */
  setDeterministicCapture(enabled: boolean): void {
    this.deterministicCapture = enabled;
    this.applyDamageLook();
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
    this.ssaoNoise.dispose();
  }

  private applyDamageLook(): void {
    const d = this.damageIntensity;
    this.vignette.darkness = this.baseVignette + d * 0.55;
    this.vignette.offset = 0.35 - d * 0.12;

    const c = this.baseChromatic + d * 0.0045;
    this.chromatic.offset.set(c, c * 0.65);

    this.noise.blendMode.opacity.value = this.deterministicCapture
      ? 0
      : this.qualityNoiseOpacity + d * 0.08;
  }
}

function createDeterministicNoiseTexture(size: number, seed: number): DataTexture {
  const data = new Uint8Array(size * size * 4);
  let state = seed >>> 0;
  for (let index = 0; index < data.length; index += 1) {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    data[index] = state & 0xff;
  }
  const texture = new DataTexture(data, size, size, RGBAFormat, UnsignedByteType);
  texture.name = 'NightglassDeterministicSSAONoise';
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.needsUpdate = true;
  return texture;
}
