import { describe, expect, it } from 'vitest';
import { AdaptiveQualityController } from '../../src/engine/AdaptiveQuality';

function sampleFor(
  controller: AdaptiveQualityController,
  seconds: number,
  frameMs: number,
  tier: 'low' | 'medium' | 'high' | 'ultra' = 'high',
) {
  let decision = null;
  const frames = Math.ceil(seconds * 1000 / frameMs);
  for (let frame = 0; frame < frames; frame += 1) {
    decision = controller.sample(frameMs, tier) ?? decision;
  }
  return decision;
}

describe('AdaptiveQualityController', () => {
  it('keeps a stable 60 fps tier unchanged', () => {
    const controller = new AdaptiveQualityController();
    expect(sampleFor(controller, 15, 1000 / 60, 'ultra')).toBeNull();
  });

  it('reduces one tier after sustained frame pressure', () => {
    const controller = new AdaptiveQualityController({
      warmupSeconds: 1,
      evaluationSeconds: 2,
    });
    const decision = sampleFor(controller, 3.2, 1000 / 30, 'ultra');
    expect(decision).toMatchObject({ nextTier: 'high' });
    expect(decision!.averageFrameMs).toBeGreaterThan(30);
    expect(decision!.slowFrameRatio).toBe(1);
  });

  it('ignores isolated hitches and suspended-tab discontinuities', () => {
    const controller = new AdaptiveQualityController({
      warmupSeconds: 0,
      evaluationSeconds: 2,
    });
    let decision = null;
    for (let frame = 0; frame < 500; frame += 1) {
      const frameMs = frame === 120 ? 500 : frame % 120 === 0 ? 48 : 1000 / 60;
      decision = controller.sample(frameMs, 'high') ?? decision;
    }
    expect(decision).toBeNull();
  });

  it('never selects below low', () => {
    const controller = new AdaptiveQualityController({
      warmupSeconds: 0,
      evaluationSeconds: 1,
    });
    expect(sampleFor(controller, 3, 40, 'low')).toBeNull();
  });
});
