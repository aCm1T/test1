export type QualityTier = 'low' | 'medium' | 'high' | 'ultra';
export type QualityPreference = QualityTier | 'auto';

export interface QualityProfile {
  tier: QualityTier;
  maxPixelRatio: number;
  renderScale: number;
  shadowMapSize: 1024 | 2048 | 4096;
  shadowCascades: 1 | 2 | 3;
  shadowDistance: number;
  ambientOcclusion: boolean;
  bloom: boolean;
  volumetricFog: boolean;
  textureAnisotropy: number;
  particleMultiplier: number;
  maxDynamicLights: number;
  lodBias: number;
}

export interface GraphicsCapabilities {
  webgl2: boolean;
  maxTextureSize: number;
  maxSamples: number;
  maxAnisotropy: number;
  floatRenderTargets: boolean;
  hardwareConcurrency: number | null;
  deviceMemoryGB: number | null;
  devicePixelRatio: number;
  mobile: boolean;
  reducedMotion: boolean;
}

export interface RendererCapabilitySource {
  capabilities?: {
    isWebGL2?: boolean;
    maxTextureSize?: number;
    maxSamples?: number;
    getMaxAnisotropy?: () => number;
  };
  extensions?: {
    has?: (name: string) => boolean;
  };
}

export interface RuntimeCapabilitySource {
  hardwareConcurrency?: number;
  deviceMemory?: number;
  devicePixelRatio?: number;
  userAgent?: string;
  reducedMotion?: boolean;
}

export interface QualitySelectionOptions {
  /** Permit an explicit preference above the automatically recommended tier. */
  allowAboveRecommended?: boolean;
  overrides?: Partial<Omit<QualityProfile, 'tier'>>;
}

export interface QualitySelection {
  profile: QualityProfile;
  requested: QualityPreference;
  recommended: QualityTier;
  constrained: boolean;
  reasons: string[];
}

/** Parses untrusted UI/query values without allowing an arbitrary tier. */
export function normalizeQualityPreference(value: unknown): QualityPreference {
  return value === 'low' || value === 'medium' || value === 'high' || value === 'ultra'
    ? value
    : 'auto';
}

const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export const QUALITY_PROFILES: Readonly<Record<QualityTier, QualityProfile>> =
  Object.freeze({
    low: Object.freeze({
      tier: 'low',
      maxPixelRatio: 1,
      renderScale: 0.8,
      shadowMapSize: 1024,
      shadowCascades: 1,
      shadowDistance: 45,
      ambientOcclusion: false,
      bloom: true,
      volumetricFog: false,
      textureAnisotropy: 2,
      particleMultiplier: 0.45,
      maxDynamicLights: 4,
      lodBias: 1.35,
    }),
    medium: Object.freeze({
      tier: 'medium',
      maxPixelRatio: 1.25,
      renderScale: 0.9,
      shadowMapSize: 2048,
      shadowCascades: 2,
      shadowDistance: 65,
      ambientOcclusion: true,
      bloom: true,
      // Medium is the capture-common floor — needs tower falloff without Ultra.
      volumetricFog: true,
      textureAnisotropy: 4,
      particleMultiplier: 0.7,
      maxDynamicLights: 8,
      lodBias: 1,
    }),
    high: Object.freeze({
      tier: 'high',
      maxPixelRatio: 1.5,
      renderScale: 1,
      shadowMapSize: 2048,
      shadowCascades: 3,
      shadowDistance: 90,
      ambientOcclusion: true,
      bloom: true,
      volumetricFog: true,
      textureAnisotropy: 8,
      particleMultiplier: 1,
      maxDynamicLights: 12,
      lodBias: 0,
    }),
    ultra: Object.freeze({
      tier: 'ultra',
      maxPixelRatio: 2,
      renderScale: 1,
      shadowMapSize: 4096,
      shadowCascades: 3,
      shadowDistance: 120,
      ambientOcclusion: true,
      bloom: true,
      volumetricFog: true,
      textureAnisotropy: 16,
      particleMultiplier: 1.35,
      maxDynamicLights: 18,
      lodBias: -0.35,
    }),
  });

/** Collect capability facts without making a quality-policy decision. */
export function detectGraphicsCapabilities(
  renderer?: RendererCapabilitySource,
  runtime: RuntimeCapabilitySource = getBrowserRuntimeCapabilities(),
): GraphicsCapabilities {
  const capabilities = renderer?.capabilities;
  const extensions = renderer?.extensions;
  const userAgent = runtime.userAgent ?? '';

  return {
    webgl2: capabilities?.isWebGL2 ?? false,
    maxTextureSize: finiteOr(capabilities?.maxTextureSize, 2048),
    maxSamples: finiteOr(capabilities?.maxSamples, 0),
    maxAnisotropy: finiteOr(capabilities?.getMaxAnisotropy?.(), 1),
    floatRenderTargets:
      capabilities?.isWebGL2 === true ||
      extensions?.has?.('EXT_color_buffer_float') === true,
    hardwareConcurrency: nullablePositive(runtime.hardwareConcurrency),
    deviceMemoryGB: nullablePositive(runtime.deviceMemory),
    devicePixelRatio: Math.max(1, finiteOr(runtime.devicePixelRatio, 1)),
    mobile: /Android|iPhone|iPad|iPod|Mobile/i.test(userAgent),
    reducedMotion: runtime.reducedMotion ?? false,
  };
}

/** Deterministically recommend a tier from GPU and coarse device signals. */
export function recommendQualityTier(
  capabilities: GraphicsCapabilities,
): QualityTier {
  if (
    !capabilities.webgl2 ||
    capabilities.maxTextureSize < 4096 ||
    (capabilities.hardwareConcurrency !== null &&
      capabilities.hardwareConcurrency <= 2) ||
    (capabilities.deviceMemoryGB !== null && capabilities.deviceMemoryGB <= 2)
  ) {
    return 'low';
  }

  let score = 0;
  if (capabilities.maxTextureSize >= 8192) score += 1;
  if (capabilities.maxSamples >= 4) score += 1;
  if (capabilities.maxAnisotropy >= 8) score += 1;
  if (capabilities.floatRenderTargets) score += 1;
  if ((capabilities.hardwareConcurrency ?? 4) >= 8) score += 1;
  if ((capabilities.deviceMemoryGB ?? 4) >= 8) score += 1;
  if (capabilities.mobile) score -= 2;

  if (score >= 6) return 'ultra';
  if (score >= 4) return 'high';
  return 'medium';
}

/** Resolve user preference, capability ceiling, and accessibility adjustments. */
export function selectQualityProfile(
  capabilities: GraphicsCapabilities,
  preference: QualityPreference = 'auto',
  options: QualitySelectionOptions = {},
): QualitySelection {
  const recommended = recommendQualityTier(capabilities);
  const requestedTier = preference === 'auto' ? recommended : preference;
  let selectedTier = requestedTier;
  const reasons: string[] = [];

  if (
    !options.allowAboveRecommended &&
    tierIndex(requestedTier) > tierIndex(recommended)
  ) {
    selectedTier = recommended;
    reasons.push(
      `${requestedTier} was capped to ${recommended} for detected capabilities`,
    );
  }

  const base = QUALITY_PROFILES[selectedTier];
  const profile: QualityProfile = {
    ...base,
    ...options.overrides,
    tier: selectedTier,
    maxPixelRatio: Math.min(
      options.overrides?.maxPixelRatio ?? base.maxPixelRatio,
      capabilities.devicePixelRatio,
    ),
    textureAnisotropy: Math.min(
      options.overrides?.textureAnisotropy ?? base.textureAnisotropy,
      Math.max(1, capabilities.maxAnisotropy),
    ),
  };

  if (capabilities.reducedMotion) {
    profile.particleMultiplier = Math.min(profile.particleMultiplier, 0.5);
    reasons.push('particle density reduced by the operating-system motion preference');
  }
  if (!capabilities.floatRenderTargets && profile.volumetricFog) {
    profile.volumetricFog = false;
    reasons.push('volumetric fog disabled because float render targets are unavailable');
  }

  return {
    profile,
    requested: preference,
    recommended,
    constrained:
      selectedTier !== requestedTier ||
      reasons.length > 0 ||
      profile.maxPixelRatio !== base.maxPixelRatio ||
      profile.textureAnisotropy !== base.textureAnisotropy,
    reasons,
  };
}

function getBrowserRuntimeCapabilities(): RuntimeCapabilitySource {
  if (typeof navigator === 'undefined') return {};
  const extendedNavigator = navigator as Navigator & { deviceMemory?: number };
  return {
    hardwareConcurrency: navigator.hardwareConcurrency,
    deviceMemory: extendedNavigator.deviceMemory,
    devicePixelRatio:
      typeof window === 'undefined' ? 1 : window.devicePixelRatio,
    userAgent: navigator.userAgent,
    reducedMotion:
      typeof window !== 'undefined' &&
      typeof window.matchMedia === 'function' &&
      window.matchMedia('(prefers-reduced-motion: reduce)').matches,
  };
}

function tierIndex(tier: QualityTier): number {
  return TIER_ORDER.indexOf(tier);
}

function finiteOr(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? value! : fallback;
}

function nullablePositive(value: number | undefined): number | null {
  return Number.isFinite(value) && value! > 0 ? value! : null;
}
