import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { GameClock } from '../../src/engine/Clock';

describe('GameClock', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it('clamps hitches and resumes without counting stopped time', () => {
    const clock = new GameClock({ maxDelta: 0.05 });
    clock.start();

    vi.advanceTimersByTime(16);
    expect(clock.getDelta()).toBeCloseTo(0.016, 5);
    vi.advanceTimersByTime(500);
    expect(clock.getDelta()).toBe(0.05);

    clock.stop();
    vi.advanceTimersByTime(1000);
    expect(clock.getDelta()).toBe(0);
    clock.start();
    vi.advanceTimersByTime(10);
    expect(clock.getDelta()).toBeCloseTo(0.01, 5);
    clock.dispose();
  });

  it('drains fixed steps from the clamped accumulator', () => {
    const clock = new GameClock({ maxDelta: 1, fixedStep: 0.1 });
    clock.start();
    vi.advanceTimersByTime(250);
    clock.getDelta();
    const steps: number[] = [];
    expect(clock.stepFixed((dt) => steps.push(dt))).toBeCloseTo(0.5, 5);
    expect(steps).toEqual([0.1, 0.1]);
    clock.dispose();
  });
});
