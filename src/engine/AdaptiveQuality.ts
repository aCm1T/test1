import type { QualityTier } from './Quality';

const TIER_ORDER: readonly QualityTier[] = ['low', 'medium', 'high', 'ultra'];

export interface AdaptiveQualityOptions {
  /** Active gameplay time ignored while shaders/assets settle. */
  warmupSeconds?: number;
  /** Length of one sustained frame-pressure window. */
  evaluationSeconds?: number;
  /** Minimum time between tier reductions. */
  cooldownSeconds?: number;
  /** Frames above this duration count as visibly late. */
  slowFrameMs?: number;
}

export interface AdaptiveQualityDecision {
  nextTier: QualityTier;
  averageFrameMs: number;
  slowFrameRatio: number;
  severeFrameRatio: number;
  sampleCount: number;
}

export interface AdaptiveQualityTelemetry {
  averageFrameMs: number;
  slowFrameRatio: number;
  sampleCount: number;
  warmingUp: boolean;
  coolingDown: boolean;
}

/**
 * Hysteretic AUTO-quality governor.
 *
 * Capability detection is only a starting guess: integrated GPUs often report
 * the same WebGL limits as discrete cards. This controller observes active
 * gameplay and only ratchets down after a sustained bad window. It never
 * upgrades in-session, so combat cannot oscillate between expensive profiles.
 */
export class AdaptiveQualityController {
  private readonly warmupSeconds: number;
  private readonly evaluationSeconds: number;
  private readonly cooldownSeconds: number;
  private readonly slowFrameMs: number;
  private warmupRemaining: number;
  private cooldownRemaining = 0;
  private windowSeconds = 0;
  private frameMsTotal = 0;
  private sampleCount = 0;
  private slowFrameCount = 0;
  private severeFrameCount = 0;

  constructor(options: AdaptiveQualityOptions = {}) {
    this.warmupSeconds = finiteNonNegative(options.warmupSeconds, 4);
    this.evaluationSeconds = Math.max(1, finiteNonNegative(options.evaluationSeconds, 3));
    this.cooldownSeconds = Math.max(1, finiteNonNegative(options.cooldownSeconds, 8));
    this.slowFrameMs = Math.max(17, finiteNonNegative(options.slowFrameMs, 24));
    this.warmupRemaining = this.warmupSeconds;
  }

  sample(frameMs: number, currentTier: QualityTier): AdaptiveQualityDecision | null {
    // A tab switch, debugger pause or OS suspend is not evidence that the GPU
    // cannot render the selected tier. Drop that discontinuity completely.
    if (!Number.isFinite(frameMs) || frameMs <= 0 || frameMs > 100) {
      this.clearWindow();
      return null;
    }

    const seconds = frameMs / 1000;
    if (this.warmupRemaining > 0) {
      this.warmupRemaining = Math.max(0, this.warmupRemaining - seconds);
      return null;
    }
    if (this.cooldownRemaining > 0) {
      this.cooldownRemaining = Math.max(0, this.cooldownRemaining - seconds);
      return null;
    }

    this.windowSeconds += seconds;
    this.frameMsTotal += frameMs;
    this.sampleCount += 1;
    if (frameMs >= this.slowFrameMs) this.slowFrameCount += 1;
    if (frameMs >= 34) this.severeFrameCount += 1;
    if (this.windowSeconds < this.evaluationSeconds) return null;

    const averageFrameMs = this.frameMsTotal / Math.max(1, this.sampleCount);
    const slowFrameRatio = this.slowFrameCount / Math.max(1, this.sampleCount);
    const severeFrameRatio = this.severeFrameCount / Math.max(1, this.sampleCount);
    const sampleCount = this.sampleCount;
    const pressured = averageFrameMs >= 20.5
      || slowFrameRatio >= 0.2
      || severeFrameRatio >= 0.08;
    this.clearWindow();

    const currentIndex = TIER_ORDER.indexOf(currentTier);
    if (!pressured || currentIndex <= 0) return null;
    this.cooldownRemaining = this.cooldownSeconds;
    return {
      nextTier: TIER_ORDER[currentIndex - 1],
      averageFrameMs,
      slowFrameRatio,
      severeFrameRatio,
      sampleCount,
    };
  }

  /** Re-arm the startup grace period after the player changes graphics mode. */
  reset(): void {
    this.warmupRemaining = this.warmupSeconds;
    this.cooldownRemaining = 0;
    this.clearWindow();
  }

  getTelemetry(): AdaptiveQualityTelemetry {
    return {
      averageFrameMs: this.sampleCount > 0 ? this.frameMsTotal / this.sampleCount : 0,
      slowFrameRatio: this.sampleCount > 0 ? this.slowFrameCount / this.sampleCount : 0,
      sampleCount: this.sampleCount,
      warmingUp: this.warmupRemaining > 0,
      coolingDown: this.cooldownRemaining > 0,
    };
  }

  private clearWindow(): void {
    this.windowSeconds = 0;
    this.frameMsTotal = 0;
    this.sampleCount = 0;
    this.slowFrameCount = 0;
    this.severeFrameCount = 0;
  }
}

function finiteNonNegative(value: number | undefined, fallback: number): number {
  return Number.isFinite(value) ? Math.max(0, value!) : fallback;
}
