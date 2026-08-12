export interface FixedStepSimulationOptions {
  /** Simulation quantum in seconds. Defaults to 60 Hz. */
  stepSeconds?: number;
  /** Largest render-frame delta accepted before clamping. */
  maxFrameDeltaSeconds?: number;
  /** Maximum simulation updates performed for one render frame. */
  maxSubSteps?: number;
  /** Multiplier applied to accepted frame time. Zero pauses simulation time. */
  timeScale?: number;
}

export interface FixedStepFrame {
  /** Number of fixed updates executed for this render frame. */
  steps: number;
  /** Remainder between the previous and next simulation states, in [0, 1). */
  interpolationAlpha: number;
  /** Simulation time intentionally discarded by clamping or the sub-step cap. */
  droppedSeconds: number;
  /** Accepted, scaled simulation time added by this frame. */
  acceptedSeconds: number;
  /** Total number of fixed updates since construction or reset. */
  tick: number;
  /** Total simulated time since construction or reset. */
  simulatedSeconds: number;
}

export type FixedStepUpdate = (
  fixedDeltaSeconds: number,
  tick: number,
) => void;

const DEFAULT_STEP_SECONDS = 1 / 60;
const DEFAULT_MAX_FRAME_DELTA_SECONDS = 0.25;
const DEFAULT_MAX_SUB_STEPS = 8;
const ROUNDING_EPSILON = 1e-10;

/**
 * Deterministic accumulator for decoupling simulation updates from rendering.
 *
 * The accumulator retains a fractional step for interpolation, while excess
 * whole steps are discarded once `maxSubSteps` is reached. This prevents a
 * slow frame from creating an ever-growing simulation backlog.
 */
export class FixedStepSimulation {
  readonly stepSeconds: number;
  readonly maxFrameDeltaSeconds: number;
  readonly maxSubSteps: number;

  private accumulatorSeconds = 0;
  private currentTick = 0;
  private elapsedSimulationSeconds = 0;
  private scale: number;
  private paused = false;
  /** True while inside advance/runSteps so reset() can abort leftover iterations. */
  private stepping = false;
  /** Set by reset() during stepping — hitch catch-up must not keep going. */
  private abortStepping = false;

  constructor(options: FixedStepSimulationOptions = {}) {
    this.stepSeconds = positiveFinite(
      options.stepSeconds ?? DEFAULT_STEP_SECONDS,
      'stepSeconds',
    );
    this.maxFrameDeltaSeconds = positiveFinite(
      options.maxFrameDeltaSeconds ?? DEFAULT_MAX_FRAME_DELTA_SECONDS,
      'maxFrameDeltaSeconds',
    );
    this.maxSubSteps = positiveInteger(
      options.maxSubSteps ?? DEFAULT_MAX_SUB_STEPS,
      'maxSubSteps',
    );
    this.scale = nonNegativeFinite(options.timeScale ?? 1, 'timeScale');
  }

  get tick(): number {
    return this.currentTick;
  }

  get simulatedSeconds(): number {
    return this.elapsedSimulationSeconds;
  }

  get interpolationAlpha(): number {
    return clampInterpolation(this.accumulatorSeconds / this.stepSeconds);
  }

  get timeScale(): number {
    return this.scale;
  }

  get isPaused(): boolean {
    return this.paused;
  }

  setTimeScale(timeScale: number): void {
    this.scale = nonNegativeFinite(timeScale, 'timeScale');
  }

  setPaused(paused: boolean): void {
    this.paused = paused;
    // Extract / pause can fire mid-callback. Hitch leftover substeps must not
    // keep simulating after the win overlay (same abort class as reset()).
    if (paused && this.stepping) this.abortStepping = true;
  }

  /**
   * Consume one render-frame delta and run zero or more deterministic updates.
   * Invalid and negative deltas are treated as zero to keep browser lifecycle
   * edge cases from poisoning the accumulator.
   */
  advance(frameDeltaSeconds: number, update: FixedStepUpdate): FixedStepFrame {
    const rawDelta = sanitizeDelta(frameDeltaSeconds);
    if (this.paused || this.scale === 0) {
      return this.createFrame(0, 0, 0);
    }

    const clampedDelta = Math.min(rawDelta, this.maxFrameDeltaSeconds);
    const acceptedSeconds = clampedDelta * this.scale;
    let droppedSeconds = (rawDelta - clampedDelta) * this.scale;
    this.accumulatorSeconds += acceptedSeconds;

    const availableSteps = Math.floor(
      (this.accumulatorSeconds + ROUNDING_EPSILON) / this.stepSeconds,
    );
    const steps = Math.min(availableSteps, this.maxSubSteps);

    // Death restore (and any other mid-callback rewind) must stop leftover
    // catch-up iterations: advance() precomputes `steps`, and a blur hitch
    // after an unpaused death delay can otherwise keep stepping the restored
    // world — hitch size would change post-restore ticks / AI fork salts.
    let ran = 0;
    this.stepping = true;
    this.abortStepping = false;
    try {
      for (let index = 0; index < steps; index += 1) {
        this.accumulatorSeconds = Math.max(
          0,
          this.accumulatorSeconds - this.stepSeconds,
        );
        this.currentTick += 1;
        this.elapsedSimulationSeconds = this.currentTick * this.stepSeconds;
        update(this.stepSeconds, this.currentTick);
        ran += 1;
        if (this.abortStepping) break;
      }
    } finally {
      this.stepping = false;
      this.abortStepping = false;
    }

    // Preserve only the sub-step remainder when the catch-up budget is spent.
    // Cap math still uses the planned `steps` budget so a mid-loop abort does
    // not re-admit backlog that maxSubSteps already decided to drop.
    const overflowSteps = availableSteps - steps;
    if (overflowSteps > 0) {
      const overflowSeconds = overflowSteps * this.stepSeconds;
      this.accumulatorSeconds = Math.max(
        0,
        this.accumulatorSeconds - overflowSeconds,
      );
      droppedSeconds += overflowSeconds;
    }

    // Eliminate harmless floating-point values infinitesimally above one step.
    if (this.accumulatorSeconds + ROUNDING_EPSILON >= this.stepSeconds) {
      this.accumulatorSeconds %= this.stepSeconds;
    }

    return this.createFrame(ran, acceptedSeconds, droppedSeconds);
  }

  /** Run an exact number of fixed updates, independent of the accumulator. */
  runSteps(count: number, update: FixedStepUpdate): void {
    const steps = nonNegativeInteger(count, 'count');
    this.stepping = true;
    this.abortStepping = false;
    try {
      for (let index = 0; index < steps; index += 1) {
        this.currentTick += 1;
        this.elapsedSimulationSeconds = this.currentTick * this.stepSeconds;
        update(this.stepSeconds, this.currentTick);
        if (this.abortStepping) break;
      }
    } finally {
      this.stepping = false;
      this.abortStepping = false;
    }
  }

  reset(tick = 0): void {
    this.currentTick = nonNegativeInteger(tick, 'tick');
    this.elapsedSimulationSeconds = this.currentTick * this.stepSeconds;
    this.accumulatorSeconds = 0;
    if (this.stepping) this.abortStepping = true;
  }

  private createFrame(
    steps: number,
    acceptedSeconds: number,
    droppedSeconds: number,
  ): FixedStepFrame {
    return {
      steps,
      interpolationAlpha: this.interpolationAlpha,
      droppedSeconds,
      acceptedSeconds,
      tick: this.currentTick,
      simulatedSeconds: this.elapsedSimulationSeconds,
    };
  }
}

function sanitizeDelta(value: number): number {
  return Number.isFinite(value) && value > 0 ? value : 0;
}

function positiveFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive finite number`);
  }
  return value;
}

function nonNegativeFinite(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative finite number`);
  }
  return value;
}

function positiveInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value <= 0) {
    throw new RangeError(`${name} must be a positive integer`);
  }
  return value;
}

function nonNegativeInteger(value: number, name: string): number {
  if (!Number.isInteger(value) || value < 0) {
    throw new RangeError(`${name} must be a non-negative integer`);
  }
  return value;
}

function clampInterpolation(value: number): number {
  return Math.min(1 - Number.EPSILON, Math.max(0, value));
}
