import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { chromium } from 'playwright';
import {
  GPU_ASSET_ESTIMATION,
  PERFORMANCE_TOOL,
  derivePerformanceMetrics,
} from './lib/nightglass-performance.mjs';
import { NIGHTGLASS_RUNTIME_ASSET_IDS } from './lib/nightglass-asset-contract.mjs';
import {
  assertReleaseGate,
  isReleaseCaptureRequested,
  withReleaseCaptureFlag,
} from './lib/nightglass-release-capture.mjs';

const ROOT = process.cwd();
const BASE_URL = process.env.GAME_URL ?? 'http://127.0.0.1:4173/';
const OUTPUT = path.resolve(process.env.PERF_OUTPUT ?? 'artifacts/performance');
const REPORT_FILE = path.join(OUTPUT, 'high-1440p.json');
const SAMPLES_FILE = path.join(OUTPUT, 'high-1440p.samples.ndjson');
const WARMUP_SECONDS = finitePositive(process.env.PERF_WARMUP_SECONDS ?? 60, 'PERF_WARMUP_SECONDS');
const SAMPLE_SECONDS = finitePositive(process.env.PERF_SAMPLE_SECONDS ?? 601, 'PERF_SAMPLE_SECONDS');
const TEST_MODE = process.env.PERF_CAPTURE_TEST_MODE === '1';
// Production performance evidence is always a release capture. Tests may opt
// into the same path with CAPTURE_RELEASE=1 without requiring real assets.
const RELEASE_CAPTURE = !TEST_MODE || isReleaseCaptureRequested(BASE_URL, process.env.CAPTURE_RELEASE);
const CAPTURE_URL = withReleaseCaptureFlag(BASE_URL, RELEASE_CAPTURE);
const DRIVER = concrete(process.env.PERF_DRIVER, 'PERF_DRIVER');
const EXECUTABLE = process.env.PERF_CHROMIUM_EXECUTABLE;
const HEADLESS = process.env.PERF_HEADLESS === '1';
const MANIFEST = path.join(ROOT, 'public/assets/manifest.json');
const PUBLIC_ASSETS = path.join(ROOT, 'public/assets');

if (!TEST_MODE && WARMUP_SECONDS < 60) fail('release warmup must be at least 60 seconds');
if (!TEST_MODE && SAMPLE_SECONDS < 601) {
  fail('release sampling must request at least 601 seconds to prove a complete 600-second interval');
}
if (fs.existsSync(REPORT_FILE) || fs.existsSync(SAMPLES_FILE)) {
  fail(`refusing to overwrite existing performance evidence in ${OUTPUT}`);
}

const bundleFile = findProductionBundle();
const compressedPayloadBytes = runtimePayloadBytes(TEST_MODE);
const browser = await chromium.launch({
  headless: HEADLESS,
  executablePath: EXECUTABLE,
  args: ['--ignore-gpu-blocklist'],
});
const page = await browser.newPage({
  viewport: { width: 2560, height: 1440 },
  deviceScaleFactor: 1,
});
const runtimeErrors = [];
page.on('pageerror', (error) => runtimeErrors.push(`page: ${error.message}`));
page.on('console', (message) => {
  if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
});
page.on('requestfailed', (request) => {
  runtimeErrors.push(`request: ${request.url()} ${request.failure()?.errorText ?? ''}`);
});

try {
  await page.goto(CAPTURE_URL, { waitUntil: 'networkidle', timeout: 120_000 });
  if (TEST_MODE) {
    await page.waitForFunction(() => Boolean(window.__BLACKOPS__), undefined, { timeout: 120_000 });
  } else {
    await page.waitForFunction(() => {
      const runtime = window.__BLACKOPS__?.stats();
      return runtime?.assetMode === 'authored'
        && runtime?.proceduralFallbackVisible === false
        && runtime?.releaseGate?.enabled === true
        && runtime?.releaseGate?.ready === true;
    }, undefined, { timeout: 120_000 });
  }
  await page.evaluate(async () => {
    if (!window.__BLACKOPS__) throw new Error('NIGHTGLASS QA API is unavailable');
    await window.__BLACKOPS__.start();
    window.__BLACKOPS__.state('defense');
    window.__BLACKOPS__.freeze(false);
  });
  const preflight = await page.evaluate(() => ({
    width: window.innerWidth,
    height: window.innerHeight,
    userAgent: navigator.userAgent,
    runtime: window.__BLACKOPS__?.stats(),
    profiler: window.__BLACKOPS__?.performanceCapture.status(),
  }));
  if (preflight.width !== 2560 || preflight.height !== 1440) {
    fail(`browser viewport is ${preflight.width}x${preflight.height}; expected 2560x1440`);
  }
  if (RELEASE_CAPTURE) assertReleaseGate(preflight.runtime, 'performance preflight');
  if (preflight.runtime?.quality?.tier !== 'high') fail('runtime quality profile is not High');
  if (!preflight.profiler?.supported) fail('EXT_disjoint_timer_query_webgl2 is unavailable');

  console.log(`warming NIGHTGLASS for ${WARMUP_SECONDS}s on ${BASE_URL}`);
  await page.waitForTimeout(WARMUP_SECONDS * 1000);
  const capturedAt = new Date().toISOString();
  await page.evaluate(() => window.__BLACKOPS__?.performanceCapture.start());
  console.log(`recording every frame for ${SAMPLE_SECONDS}s`);
  await page.waitForTimeout(SAMPLE_SECONDS * 1000);
  await page.evaluate(() => window.__BLACKOPS__?.performanceCapture.stop());
  await page.waitForFunction(() => (
    window.__BLACKOPS__?.performanceCapture.status().pendingQueries === 0
  ), undefined, { timeout: 30_000 });
  const result = await page.evaluate(() => window.__BLACKOPS__?.performanceCapture.result());
  if (!result) fail('browser returned no performance capture');
  if (result.hardware.timerQueryBits <= 0) fail('GPU timer query counter has zero bits');
  if (!TEST_MODE && !/rtx\s*3060/i.test(result.hardware.device)) {
    fail(`WebGL renderer is not RTX 3060-class: ${result.hardware.device}`);
  }
  if (!(result.gpuAssetBytes > 0)) fail('runtime GPU asset estimate is empty');
  const metrics = derivePerformanceMetrics(result.samples);
  if (!TEST_MODE && metrics.durationSeconds < 600) {
    fail(`captured only ${metrics.durationSeconds.toFixed(3)}s; at least 600s is required`);
  }
  if (runtimeErrors.length > 0) fail(`runtime errors:\n${runtimeErrors.join('\n')}`);

  fs.mkdirSync(OUTPUT, { recursive: true });
  fs.writeFileSync(
    SAMPLES_FILE,
    `${result.samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`,
  );
  const samplesSha256 = sha256File(SAMPLES_FILE);
  const report = {
    schemaVersion: 1,
    captureId: `nightglass-${capturedAt.replaceAll(/[^0-9]/g, '').slice(0, 14)}-${samplesSha256.slice(0, 12)}`,
    capturedAt,
    browser: 'Chromium desktop',
    browserVersion: browser.version(),
    userAgent: preflight.userAgent,
    quality: 'high',
    resolution: { width: 2560, height: 1440 },
    hardware: {
      gpuClass: result.hardware.device,
      vendor: result.hardware.vendor,
      device: result.hardware.device,
      driver: DRIVER,
      cpu: os.cpus()[0]?.model ?? 'unavailable CPU model',
    },
    build: {
      bundleFile: normalize(path.relative(ROOT, bundleFile)),
      bundleSha256: sha256File(bundleFile),
    },
    measurement: {
      tool: PERFORMANCE_TOOL,
      sampleMode: 'per-frame',
      gpuTimer: 'EXT_disjoint_timer_query_webgl2',
      warmupSeconds: WARMUP_SECONDS,
    },
    evidence: {
      samplesFile: path.basename(SAMPLES_FILE),
      samplesSha256,
      frameSampleCount: result.samples.length,
      gpuAssetBytes: result.gpuAssetBytes,
      gpuAssetEstimation: GPU_ASSET_ESTIMATION,
      runtimeAssetMode: preflight.runtime.assetMode,
      proceduralFallbackVisible: preflight.runtime.proceduralFallbackVisible,
    },
    sampleDurationSeconds: metrics.durationSeconds,
    metrics: {
      sustainedFps: metrics.sustainedFps,
      p95FrameMs: metrics.p95FrameMs,
      gpuMs: metrics.gpuMs,
      mainThreadMs: metrics.mainThreadMs,
      onePercentLowFps: metrics.onePercentLowFps,
      typicalDrawCalls: metrics.typicalDrawCalls,
      peakDrawCalls: metrics.peakDrawCalls,
      typicalTriangles: metrics.typicalTriangles,
      peakTriangles: metrics.peakTriangles,
      gpuAssetBytes: result.gpuAssetBytes,
      compressedPayloadBytes,
    },
  };
  fs.writeFileSync(REPORT_FILE, `${JSON.stringify(report, null, 2)}\n`);
  console.log(`performance evidence captured: ${result.samples.length} frames`);
  console.log(REPORT_FILE);
} finally {
  await browser.close();
}

function findProductionBundle() {
  const directory = path.join(ROOT, 'dist/assets');
  if (!fs.existsSync(directory)) fail('dist/assets is missing; run npm run build first');
  const candidates = fs.readdirSync(directory)
    .filter((file) => /^index-[^/]+\.js$/.test(file))
    .sort();
  if (candidates.length !== 1) {
    fail(`expected one production index bundle; found ${candidates.length}`);
  }
  return path.join(directory, candidates[0]);
}

function runtimePayloadBytes(allowEmpty) {
  if (!fs.existsSync(MANIFEST)) fail('public asset manifest is missing');
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
  const entries = Array.isArray(manifest.assets) ? manifest.assets : [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const required = NIGHTGLASS_RUNTIME_ASSET_IDS.map((id) => byId.get(id));
  if (required.some((entry) => !entry)) {
    if (allowEmpty) return 0;
    fail('asset manifest does not contain the complete runtime contract');
  }
  let total = 0;
  for (const entry of required) {
    if (entry.required !== true) fail(`${entry.id}: runtime asset must be marked required`);
    const file = resolvePublicAsset(entry.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      fail(`${entry.id ?? 'runtime asset'} is missing from the production payload`);
    }
    total += fs.statSync(file).size;
  }
  return total;
}

function resolvePublicAsset(url) {
  if (typeof url !== 'string' || /^(?:[a-z]+:)?\/\//i.test(url)) return null;
  const file = path.resolve(PUBLIC_ASSETS, url.replace(/^\/+/, ''));
  return file.startsWith(`${PUBLIC_ASSETS}${path.sep}`) ? file : null;
}

function concrete(value, name) {
  const normalized = String(value ?? '').trim();
  if (!normalized || /replace|placeholder|unknown|todo|tbd/i.test(normalized)) {
    fail(`${name} must contain the installed GPU driver version`);
  }
  return normalized;
}

function finitePositive(value, name) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) fail(`${name} must be positive`);
  return number;
}

function normalize(file) {
  return file.replaceAll('\\', '/');
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function fail(message) {
  throw new Error(`NIGHTGLASS performance capture: BLOCKED — ${message}`);
}
