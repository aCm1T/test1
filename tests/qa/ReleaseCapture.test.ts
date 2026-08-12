import { describe, expect, it } from 'vitest';
import {
  assertReleaseGate,
  isReleaseCaptureRequested,
  releaseGateFailure,
  withReleaseCaptureFlag,
} from '../../scripts/lib/nightglass-release-capture.mjs';

function readyRuntime(overrides: Record<string, unknown> = {}) {
  return {
    assetMode: 'authored',
    proceduralFallbackVisible: false,
    releaseGate: { enabled: true, ready: true, reason: null },
    ...overrides,
  };
}

describe('release capture enforcement', () => {
  it('adds the release flag only when the capture requests it', () => {
    expect(isReleaseCaptureRequested('http://localhost:4173/?quality=high', undefined)).toBe(false);
    expect(isReleaseCaptureRequested('http://localhost:4173/?quality=high', '1')).toBe(true);
    expect(withReleaseCaptureFlag('http://localhost:4173/?quality=high#capture', true))
      .toBe('http://localhost:4173/?quality=high&release=1#capture');
    expect(withReleaseCaptureFlag('http://localhost:4173/?release=1', false))
      .toBe('http://localhost:4173/?release=1');
  });

  it('rejects a release capture unless the runtime reports an enabled, ready gate', () => {
    expect(releaseGateFailure({})).toContain('enabled');
    expect(releaseGateFailure({ releaseGate: { enabled: true, ready: false, reason: 'assets missing' } }))
      .toContain('assets missing');
    expect(releaseGateFailure(readyRuntime())).toBeNull();
    expect(() => assertReleaseGate({ releaseGate: { enabled: false, ready: true } }, '1080p preflight'))
      .toThrow('1080p preflight: release capture rejected');
  });

  it('rejects release captures that are not authored without procedural fallback', () => {
    expect(releaseGateFailure(readyRuntime({ assetMode: 'unloaded' }))).toContain('assetMode');
    expect(releaseGateFailure(readyRuntime({ proceduralFallbackVisible: true })))
      .toContain('proceduralFallbackVisible');
    expect(releaseGateFailure(readyRuntime({ proceduralFallbackVisible: undefined })))
      .toContain('proceduralFallbackVisible');
    expect(() => assertReleaseGate(readyRuntime({ assetMode: 'procedural' }), 'performance preflight'))
      .toThrow('performance preflight: release capture rejected');
  });
});
