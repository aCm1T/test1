export {
  GameRenderer,
  Renderer,
  createRenderContext,
  isQACaptureBufferRequested,
  QA_CAPTURE_BUFFER_QUERY,
  type GameRendererOptions,
  type EngineRenderContext,
  type DebugRenderView,
  type RendererStats,
} from './Renderer';
export {
  WebGLFrameProfiler,
  estimateGpuAssetBytes,
  type PerformanceFrameSample,
  type PerformanceHardwareInfo,
  type PerformanceCaptureStatus,
  type PerformanceCaptureResult,
} from './PerformanceSampler';

export {
  PostProcessing,
  DuskGradeEffect,
  type PostProcessingOptions,
  type DuskGradeOptions,
} from './PostProcessing';

export {
  setupLighting,
  type LightingSetup,
  type LightingOptions,
} from './Lighting';

export {
  GameClock,
  type GameClockOptions,
} from './Clock';

export {
  setupEnvironment,
  type EnvironmentSetup,
  type ReflectionProbeInput,
} from './Environment';

export {
  FixedStepSimulation,
  type FixedStepSimulationOptions,
  type FixedStepFrame,
  type FixedStepUpdate,
} from './FixedStepSimulation';

export {
  TypedEventBus,
  EventBus,
  type EventKey,
  type EventListener,
  type EventSubscriptionOptions,
  type EventBusOptions,
} from './EventBus';

export {
  QUALITY_PROFILES,
  detectGraphicsCapabilities,
  recommendQualityTier,
  normalizeQualityPreference,
  selectQualityProfile,
  type QualityTier,
  type QualityPreference,
  type QualityProfile,
  type GraphicsCapabilities,
  type RendererCapabilitySource,
  type RuntimeCapabilitySource,
  type QualitySelectionOptions,
  type QualitySelection,
} from './Quality';

export {
  AdaptiveQualityController,
  type AdaptiveQualityOptions,
  type AdaptiveQualityDecision,
  type AdaptiveQualityTelemetry,
} from './AdaptiveQuality';

export {
  AssetRegistry,
  createFetchAssetLoaders,
  validateManifest,
  type BuiltInAssetKind,
  type AssetStatus,
  type AssetLicense,
  type AssetManifestEntry,
  type AssetManifest,
  type AssetLoadContext,
  type AssetLoader,
  type AssetLoaderMap,
  type AssetSnapshot,
  type AssetProgress,
  type AssetPreloadReport,
  type AssetRegistryOptions,
} from './AssetRegistry';
