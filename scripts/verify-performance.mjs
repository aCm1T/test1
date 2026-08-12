import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import {
  GPU_ASSET_ESTIMATION,
  PERFORMANCE_TOOL,
  derivePerformanceMetrics,
} from './lib/nightglass-performance.mjs';
import { NIGHTGLASS_RUNTIME_ASSET_IDS } from './lib/nightglass-asset-contract.mjs';

const ROOT = path.resolve(process.env.PERF_WORKSPACE_ROOT ?? process.cwd());
const FILE = path.resolve(process.env.PERF_REPORT ?? 'artifacts/performance/high-1440p.json');
const MANIFEST = path.resolve(process.env.PERF_MANIFEST ?? 'public/assets/manifest.json');
const PUBLIC_ASSET_ROOT = path.resolve(process.env.PERF_PUBLIC_ASSET_ROOT ?? 'public/assets');
if (!fs.existsSync(FILE)) fail(`missing hardware performance report ${FILE}`);
const report = readJson(FILE);
const errors = [];

requireEqual(report.schemaVersion, 1, 'schemaVersion');
requireConcrete(report.captureId, 'captureId');
requireIso(report.capturedAt, 'capturedAt');
requireEqual(report.browser, 'Chromium desktop', 'browser');
requireConcrete(report.browserVersion, 'browserVersion');
requireConcrete(report.userAgent, 'userAgent');
requireEqual(report.quality, 'high', 'quality');
requireEqual(report.resolution?.width, 2560, 'resolution.width');
requireEqual(report.resolution?.height, 1440, 'resolution.height');
if (!identifiesRtx3060(report.hardware?.gpuClass)) {
  errors.push('hardware.gpuClass must identify an RTX 3060-class device');
}
if (!identifiesRtx3060(report.hardware?.device)) {
  errors.push('hardware.device must be captured from an RTX 3060-class WebGL renderer');
}
for (const field of ['vendor', 'device', 'driver', 'cpu']) {
  requireConcrete(report.hardware?.[field], `hardware.${field}`);
}
requireEqual(report.measurement?.sampleMode, 'per-frame', 'measurement.sampleMode');
requireEqual(
  report.measurement?.gpuTimer,
  'EXT_disjoint_timer_query_webgl2',
  'measurement.gpuTimer',
);
requireEqual(report.measurement?.tool, PERFORMANCE_TOOL, 'measurement.tool');
atLeast(report.measurement?.warmupSeconds, 60, 'measurement.warmupSeconds');
requireEqual(report.evidence?.runtimeAssetMode, 'authored', 'evidence.runtimeAssetMode');
requireEqual(
  report.evidence?.proceduralFallbackVisible,
  false,
  'evidence.proceduralFallbackVisible',
);
requireEqual(
  report.evidence?.gpuAssetEstimation,
  GPU_ASSET_ESTIMATION,
  'evidence.gpuAssetEstimation',
);

const bundleFile = resolveWorkspaceFile(report.build?.bundleFile, 'dist', '.js');
if (bundleFile) {
  requireDigest(report.build?.bundleSha256, 'build.bundleSha256');
  if (fs.existsSync(bundleFile)) {
    requireEqual(sha256File(bundleFile), report.build.bundleSha256, 'build.bundleSha256');
  } else {
    errors.push(`build.bundleFile is missing: ${bundleFile}`);
  }
}

const samplesFile = resolveReportFile(report.evidence?.samplesFile);
let samples = [];
if (samplesFile && fs.existsSync(samplesFile)) {
  requireDigest(report.evidence?.samplesSha256, 'evidence.samplesSha256');
  requireEqual(sha256File(samplesFile), report.evidence.samplesSha256, 'evidence.samplesSha256');
  try {
    samples = fs.readFileSync(samplesFile, 'utf8')
      .split(/\r?\n/)
      .filter((line) => line.trim())
      .map((line, index) => {
        try {
          return JSON.parse(line);
        } catch (error) {
          throw new Error(`line ${index + 1}: ${error instanceof Error ? error.message : error}`);
        }
      });
  } catch (error) {
    errors.push(`samples file is invalid NDJSON: ${error instanceof Error ? error.message : error}`);
  }
} else if (samplesFile) {
  errors.push(`evidence.samplesFile is missing: ${samplesFile}`);
}

let derived = null;
try {
  derived = derivePerformanceMetrics(samples);
} catch (error) {
  errors.push(error instanceof Error ? error.message : String(error));
}
if (derived) {
  requireEqual(report.evidence?.frameSampleCount, samples.length, 'evidence.frameSampleCount');
  near(report.sampleDurationSeconds, derived.durationSeconds, 0.05, 'sampleDurationSeconds');
  atLeast(derived.durationSeconds, 600, 'derived.sampleDurationSeconds');
  atLeast(derived.sustainedFps, 60, 'derived.sustainedFps');
  atMost(derived.p95FrameMs, 16.7, 'derived.p95FrameMs');
  atMost(derived.gpuMs, 13, 'derived.gpuMs');
  atMost(derived.mainThreadMs, 8, 'derived.mainThreadMs');
  atLeast(derived.onePercentLowFps, 50, 'derived.onePercentLowFps');
  atMost(derived.typicalDrawCalls, 450, 'derived.typicalDrawCalls');
  atMost(derived.peakDrawCalls, 700, 'derived.peakDrawCalls');
  atMost(derived.typicalTriangles, 2_200_000, 'derived.typicalTriangles');
  atMost(derived.peakTriangles, 3_800_000, 'derived.peakTriangles');
  for (const [metric, value] of Object.entries(derived)) {
    if (metric === 'durationSeconds') continue;
    const tolerance = Number.isInteger(value) ? 0 : 0.001;
    near(report.metrics?.[metric], value, tolerance, `metrics.${metric}`);
  }
}

const gpuAssetBytes = report.evidence?.gpuAssetBytes;
atLeast(gpuAssetBytes, 1, 'evidence.gpuAssetBytes');
atMost(gpuAssetBytes, 1024 ** 3, 'evidence.gpuAssetBytes');
requireEqual(report.metrics?.gpuAssetBytes, gpuAssetBytes, 'metrics.gpuAssetBytes');
const compressedPayloadBytes = computeRuntimePayloadBytes();
if (compressedPayloadBytes !== null) {
  atMost(compressedPayloadBytes, 300 * 1024 ** 2, 'derived.compressedPayloadBytes');
  requireEqual(
    report.metrics?.compressedPayloadBytes,
    compressedPayloadBytes,
    'metrics.compressedPayloadBytes',
  );
}

if (errors.length > 0) {
  console.error('NIGHTGLASS hardware performance gate: BLOCKED');
  for (const error of errors) console.error(`- ${error}`);
  process.exit(1);
}
console.log(
  `NIGHTGLASS hardware performance gate: PASS (${samples.length} raw frames, ${derived.durationSeconds.toFixed(1)}s)`,
);

function computeRuntimePayloadBytes() {
  if (!fs.existsSync(MANIFEST)) {
    errors.push(`performance asset manifest is missing: ${MANIFEST}`);
    return null;
  }
  const manifest = readJson(MANIFEST);
  const entries = Array.isArray(manifest.assets) ? manifest.assets : [];
  const byId = new Map(entries.map((entry) => [entry.id, entry]));
  const required = NIGHTGLASS_RUNTIME_ASSET_IDS.map((id) => byId.get(id));
  if (required.some((entry) => !entry)) {
    errors.push('performance asset manifest does not contain the complete runtime contract');
    return null;
  }
  let total = 0;
  for (const entry of required) {
    if (entry.required !== true) {
      errors.push(`${entry.id}: runtime asset must be marked required`);
    }
    const file = resolvePublicAsset(entry.url);
    if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
      errors.push(`${entry.id ?? 'runtime asset'}: payload file is missing`);
      continue;
    }
    total += fs.statSync(file).size;
  }
  return total;
}

function resolveReportFile(relative) {
  if (typeof relative !== 'string' || !relative.trim() || path.isAbsolute(relative)) {
    errors.push('evidence.samplesFile must be a relative path beside the report');
    return null;
  }
  const directory = path.dirname(FILE);
  const file = path.resolve(directory, relative);
  if (!file.startsWith(`${directory}${path.sep}`)) {
    errors.push('evidence.samplesFile escapes the report directory');
    return null;
  }
  return file;
}

function resolveWorkspaceFile(relative, requiredDirectory, extension) {
  if (typeof relative !== 'string' || path.isAbsolute(relative)) {
    errors.push('build.bundleFile must be a workspace-relative path');
    return null;
  }
  const normalized = relative.replaceAll('\\', '/');
  if (!normalized.startsWith(`${requiredDirectory}/`) || !normalized.endsWith(extension)) {
    errors.push(`build.bundleFile must identify a ${requiredDirectory}/*${extension} artifact`);
    return null;
  }
  const file = path.resolve(ROOT, relative);
  if (!file.startsWith(`${ROOT}${path.sep}`)) {
    errors.push('build.bundleFile escapes the workspace');
    return null;
  }
  return file;
}

function resolvePublicAsset(url) {
  if (typeof url !== 'string' || /^(?:[a-z]+:)?\/\//i.test(url)) return null;
  const file = path.resolve(PUBLIC_ASSET_ROOT, url.replace(/^\/+/, ''));
  return file.startsWith(`${PUBLIC_ASSET_ROOT}${path.sep}`) ? file : null;
}

/** Match collector: `/rtx\\s*3060/i`, but reject obvious negations like "not an rtx 3060". */
function identifiesRtx3060(value) {
  const text = String(value ?? '');
  if (!/rtx\s*3060/i.test(text)) return false;
  if (/\bnot\b[\s\w-]{0,32}rtx\s*3060/i.test(text)) return false;
  return true;
}

function requireEqual(actual, expected, label) {
  if (actual !== expected) errors.push(`${label} must be ${expected}; received ${actual ?? 'missing'}`);
}

function requireConcrete(actual, label) {
  const value = String(actual ?? '').trim();
  if (!value || /replace|placeholder|unknown|todo|tbd/i.test(value)) {
    errors.push(`${label} must be a concrete captured value`);
  }
}

function requireIso(actual, label) {
  if (
    typeof actual !== 'string'
    || !Number.isFinite(Date.parse(actual))
    || new Date(actual).toISOString() !== actual
    || Date.parse(actual) > Date.now() + 5 * 60 * 1000
  ) errors.push(`${label} must be a non-future ISO-8601 UTC timestamp`);
}

function requireDigest(actual, label) {
  if (!/^[a-f0-9]{64}$/.test(String(actual ?? ''))) errors.push(`${label} must be a SHA-256 digest`);
}

function atMost(actual, limit, label) {
  if (!Number.isFinite(actual) || actual > limit) errors.push(`${label} must be ≤${limit}; received ${actual ?? 'missing'}`);
}

function atLeast(actual, limit, label) {
  if (!Number.isFinite(actual) || actual < limit) errors.push(`${label} must be ≥${limit}; received ${actual ?? 'missing'}`);
}

function near(actual, expected, tolerance, label) {
  if (!Number.isFinite(actual) || Math.abs(actual - expected) > tolerance) {
    errors.push(`${label} must match raw evidence ${expected}; received ${actual ?? 'missing'}`);
  }
}

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    fail(`invalid JSON ${file}: ${error instanceof Error ? error.message : error}`);
  }
}

function fail(message) {
  console.error(`NIGHTGLASS hardware performance gate: BLOCKED — ${message}`);
  process.exit(1);
}
