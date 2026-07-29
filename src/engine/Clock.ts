import { Clock } from 'three';

export interface GameClockOptions {
  /** Maximum delta in seconds — prevents spiral-of-death after tab blur. */
  maxDelta?: number;
  /** Optional fixed timestep for physics consumers (seconds). */
  fixedStep?: number;
}

/**
 * Frame clock with clamped getDelta for stable FPS simulation.
 */
export class GameClock {
  private readonly clock: Clock;
  private readonly maxDelta: number;
  readonly fixedStep: number;

  private lastDelta = 0;
  private accumulator = 0;
  private elapsed = 0;
  private running = true;

  constructor(options: GameClockOptions = {}) {
    this.clock = new Clock(false);
    this.maxDelta = options.maxDelta ?? 0.05; // 20 FPS floor
    this.fixedStep = options.fixedStep ?? 1 / 60;
  }

  start(): void {
    this.running = true;
    this.clock.start();
  }

  stop(): void {
    this.running = false;
    this.clock.stop();
  }

  /**
   * Returns clamped seconds since last call. Safe to call once per frame.
   */
  getDelta(): number {
    if (!this.running) {
      this.lastDelta = 0;
      return 0;
    }

    const raw = this.clock.getDelta();
    const dt = Math.min(Math.max(raw, 0), this.maxDelta);
    this.lastDelta = dt;
    this.elapsed += dt;
    this.accumulator += dt;
    return dt;
  }

  /** Most recent clamped delta without advancing the clock. */
  getLastDelta(): number {
    return this.lastDelta;
  }

  getElapsed(): number {
    return this.elapsed;
  }

  /**
   * Drain fixed-timestep accumulator. Invokes `fn(fixedStep)` once per step.
   * Returns leftover accumulator for interpolation.
   */
  stepFixed(fn: (dt: number) => void, maxSteps = 5): number {
    let steps = 0;
    while (this.accumulator >= this.fixedStep && steps < maxSteps) {
      fn(this.fixedStep);
      this.accumulator -= this.fixedStep;
      steps++;
    }
    if (steps === maxSteps) {
      this.accumulator = 0;
    }
    return this.accumulator / this.fixedStep;
  }

  reset(): void {
    this.clock.stop();
    this.clock.start();
    this.lastDelta = 0;
    this.accumulator = 0;
    this.elapsed = 0;
    this.running = true;
  }
}
