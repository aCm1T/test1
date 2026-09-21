import { test, assert } from 'vitest';
import {
  detectGraphicsCapabilities,
  normalizeQualityPreference,
  recommendQualityTier,
  selectQualityProfile,
  type GraphicsCapabilities,
} from '../../src/engine/Quality.ts';

const capableDesktop: GraphicsCapabilities = {
  webgl2: true,
  maxTextureSize: 16384,
  maxSamples: 8,
  maxAnisotropy: 16,
  floatRenderTargets: true,
  hardwareConcurrency: 16,
  deviceMemoryGB: 16,
  devicePixelRatio: 2,
  mobile: false,
  reducedMotion: false,
};

test('quality recommendation is deterministic from capability facts', () => {
  assert.equal(recommendQualityTier(capableDesktop), 'ultra');
  assert.equal(
    recommendQualityTier({ ...capableDesktop, webgl2: false }),
    'low',
  );
  assert.equal(
    recommendQualityTier({ ...capableDesktop, mobile: true }),
    'high',
  );
});

test('selection caps unsafe explicit tiers and applies accessibility policy', () => {
  const limited = {
    ...capableDesktop,
    hardwareConcurrency: 2,
    devicePixelRatio: 1,
    maxAnisotropy: 2,
    floatRenderTargets: false,
    reducedMotion: true,
  };
  const selection = selectQualityProfile(limited, 'ultra');

  assert.equal(selection.profile.tier, 'low');
  assert.equal(selection.profile.maxPixelRatio, 1);
  assert.equal(selection.profile.textureAnisotropy, 2);
  assert.ok(selection.profile.particleMultiplier <= 0.5);
  assert.equal(selection.constrained, true);
});

test('medium profile enables volumetric fog for capture-common depth', () => {
  const selection = selectQualityProfile(capableDesktop, 'medium', {
    allowAboveRecommended: true,
  });
  assert.equal(selection.profile.tier, 'medium');
  assert.equal(selection.profile.volumetricFog, true);
});

test('auto starts at high when capability limits alone suggest ultra', () => {
  const selection = selectQualityProfile(capableDesktop, 'auto');
  assert.equal(selection.recommended, 'ultra');
  assert.equal(selection.profile.tier, 'high');
  assert.equal(selection.constrained, true);
  assert.match(selection.reasons.join(' '), /fill-rate/);

  const explicit = selectQualityProfile(capableDesktop, 'ultra');
  assert.equal(explicit.profile.tier, 'ultra');
});

test('capability detection accepts a renderer-shaped object for testability', () => {
  const detected = detectGraphicsCapabilities(
    {
      capabilities: {
        isWebGL2: true,
        maxTextureSize: 8192,
        maxSamples: 4,
        getMaxAnisotropy: () => 8,
      },
    },
    {
      hardwareConcurrency: 8,
      deviceMemory: 8,
      devicePixelRatio: 1.5,
      userAgent: 'Desktop Browser',
    },
  );
  assert.equal(detected.maxAnisotropy, 8);
  assert.equal(detected.deviceMemoryGB, 8);
  assert.equal(detected.mobile, false);
});

test('graphics preference parsing never permits an invalid user-facing tier', () => {
  assert.equal(normalizeQualityPreference('ultra'), 'ultra');
  assert.equal(normalizeQualityPreference('AUTO'), 'auto');
  assert.equal(normalizeQualityPreference('cinematic'), 'auto');
  assert.equal(normalizeQualityPreference(null), 'auto');
});
