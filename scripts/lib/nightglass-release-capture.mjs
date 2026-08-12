/**
 * Release captures must opt into the application's fail-closed authored-asset
 * path. Keeping URL construction and validation here makes that requirement
 * testable without launching a browser.
 */
export function isReleaseCaptureRequested(baseUrl, environmentValue) {
  if (environmentValue === '1') return true;
  try {
    return new URL(baseUrl).searchParams.get('release') === '1';
  } catch {
    throw new Error(`release capture URL is invalid: ${baseUrl}`);
  }
}

export function withReleaseCaptureFlag(baseUrl, requested) {
  let url;
  try {
    url = new URL(baseUrl);
  } catch {
    throw new Error(`release capture URL is invalid: ${baseUrl}`);
  }
  if (requested) url.searchParams.set('release', '1');
  return url.toString();
}

/** Returns a precise failure reason, or null only for a release-ready runtime. */
export function releaseGateFailure(runtime) {
  const gate = runtime?.releaseGate;
  if (!gate || gate.enabled !== true) return 'runtime releaseGate.enabled is not true';
  if (gate.ready !== true) {
    const reason = typeof gate.reason === 'string' && gate.reason.trim()
      ? `: ${gate.reason.trim()}`
      : '';
    return `runtime releaseGate.ready is not true${reason}`;
  }
  if (runtime.assetMode !== 'authored') {
    return `runtime assetMode is ${JSON.stringify(runtime.assetMode)}; expected "authored"`;
  }
  if (runtime.proceduralFallbackVisible !== false) {
    return 'runtime proceduralFallbackVisible is not false';
  }
  return null;
}

export function assertReleaseGate(runtime, label = 'capture') {
  const failure = releaseGateFailure(runtime);
  if (failure) throw new Error(`${label}: release capture rejected — ${failure}`);
}
