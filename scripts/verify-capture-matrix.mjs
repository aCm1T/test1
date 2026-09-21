import fs from 'node:fs';
import path from 'node:path';
import { inspectImageFile } from './lib/nightglass-binary-inspection.mjs';
import {
  CAPTURE_DEBUG_VIEWS,
  CAPTURE_RESOLUTIONS,
  CAPTURE_SCENARIOS,
  VISUAL_DEFECT_CHECKS,
  VISUAL_INSPECTION_ATTESTATION,
  captureImageFiles,
  captureSetDigest,
} from './lib/nightglass-capture-integrity.mjs';

const ROOT = path.resolve(process.env.SCREENSHOT_DIR ?? 'artifacts/screenshots');
const RESOLUTIONS = CAPTURE_RESOLUTIONS;
const SCENARIOS = CAPTURE_SCENARIOS;
const DEBUG_VIEWS = CAPTURE_DEBUG_VIEWS;
const errors = [];

for (const [resolution, dimensions] of Object.entries(RESOLUTIONS)) {
  const directory = path.join(ROOT, resolution);
  for (const scenario of SCENARIOS) {
    requirePng(path.join(directory, `${scenario}.world.png`), dimensions);
    requirePng(path.join(directory, `${scenario}.hud.png`), dimensions);
  }
  for (const view of DEBUG_VIEWS) requirePng(path.join(directory, `debug.${view}.png`), dimensions);
  const statsFile = path.join(directory, 'renderer-stats.json');
  if (!fs.existsSync(statsFile)) {
    errors.push(`${resolution}: renderer-stats.json is missing`);
    continue;
  }
  const report = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  if (
    report.resolution?.width !== dimensions.width
    || report.resolution?.height !== dimensions.height
  ) errors.push(`${resolution}: renderer report resolution does not match the capture directory`);
  const runtime = report.runtime ?? {};
  const renderer = runtime.renderer ?? {};
  const determinism = runtime.determinism ?? {};
  if (runtime.assetMode !== 'authored' || runtime.proceduralFallbackVisible !== false) {
    errors.push(`${resolution}: capture contains or cannot disprove procedural fallback`);
  }
  if (runtime.releaseGate?.enabled !== true || runtime.releaseGate?.ready !== true) {
    errors.push(`${resolution}: capture was not produced by a ready release gate`);
  }
  if (
    determinism.seededSimulation !== true
    || determinism.qaFrozen !== true
    || determinism.initialSeed !== 0x4e494748
    || !Number.isFinite(determinism.fixedStepSeconds)
    || Math.abs(determinism.fixedStepSeconds - 1 / 60) > 1e-12
    || determinism.menuTimeSecondsWhenFrozen !== 8
    || determinism.temporalEffectsFrozen !== true
  ) errors.push(`${resolution}: deterministic fixed-seed capture state is incomplete`);
  const authored = runtime.authoredPresentation ?? {};
  if (
    authored.route !== true
    || authored.viewModel !== true
    || authored.enemies !== true
    || authored.audioBuffers < 11
    || authored.staticColliders < 1
    || authored.triangleColliders !== authored.staticColliders
    || authored.physics?.staticColliders !== authored.staticColliders
    || authored.physics?.trimeshColliders !== authored.staticColliders
    || authored.physics?.characters < 1
    || authored.navigationNodes < 2
    || authored.coverSlots < 1
    || authored.heroTextures < 4
    || authored.render?.instancedMeshes < 3
    || authored.render?.instances < 6
    || authored.render?.lightmappedMaterials < 3
    || authored.render?.emissiveMaterials < 1
  ) {
    errors.push(`${resolution}: authored presentation/physics ownership is incomplete`);
  }
  const viewModel = runtime.viewModel ?? {};
  if (
    viewModel.sampleValid !== true
    || viewModel.adsReticleMarkerPresent !== true
    || !Number.isFinite(viewModel.hipFrameOccupancy)
    || viewModel.hipFrameOccupancy > 0.3
  ) errors.push(`${resolution}: hip viewmodel occupancy is invalid or exceeds 30%`);
  if (
    !Number.isFinite(viewModel.adsReticleErrorPixelsAt1080p)
    || viewModel.adsReticleErrorPixelsAt1080p > 2
  ) errors.push(`${resolution}: ADS reticle alignment is invalid or exceeds 2 px at 1080p`);
  if (!Number.isFinite(renderer.peakCalls) || renderer.peakCalls > 700) {
    errors.push(`${resolution}: peak draw calls ${renderer.peakCalls ?? 'missing'} exceed 700`);
  }
  if (!Number.isFinite(renderer.peakTriangles) || renderer.peakTriangles > 3_800_000) {
    errors.push(`${resolution}: peak triangles ${renderer.peakTriangles ?? 'missing'} exceed 3.8M`);
  }
}

validateVisualInspection();

if (errors.length > 0) {
  fs.writeSync(
    process.stderr.fd,
    `NIGHTGLASS capture matrix gate: BLOCKED\n${errors.map((error) => `- ${error}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  console.log(`NIGHTGLASS capture matrix gate: PASS (${Object.keys(RESOLUTIONS).length} resolutions)`);
}

function validateVisualInspection() {
  const file = path.join(ROOT, 'visual-inspection.json');
  if (!fs.existsSync(file)) {
    errors.push('visual-inspection.json is missing');
    return;
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch (error) {
    errors.push(`visual-inspection.json is invalid: ${error instanceof Error ? error.message : error}`);
    return;
  }
  if (report.schemaVersion !== 1) errors.push('visual inspection schemaVersion must be 1');
  const inspectorId = String(report.inspectorId ?? '').trim();
  if (!inspectorId || /replace|placeholder|unknown|todo|tbd/i.test(inspectorId)) {
    errors.push('visual inspection requires a concrete inspectorId');
  }
  if (
    typeof report.inspectedAt !== 'string'
    || !Number.isFinite(Date.parse(report.inspectedAt))
    || new Date(report.inspectedAt).toISOString() !== report.inspectedAt
    || Date.parse(report.inspectedAt) > Date.now() + 5 * 60 * 1000
  ) errors.push('visual inspection requires a non-future ISO-8601 UTC inspectedAt');
  if (report.attestation !== VISUAL_INSPECTION_ATTESTATION) {
    errors.push('visual inspection attestation is missing or altered');
  }
  let digest = null;
  try {
    digest = captureSetDigest(ROOT);
  } catch (error) {
    errors.push(`visual inspection capture set is incomplete: ${error instanceof Error ? error.message : error}`);
  }
  if (digest && report.captureSetDigest !== digest) {
    errors.push('visual inspection does not cover the current capture set');
  }
  if (!sameKeys(report.checks, VISUAL_DEFECT_CHECKS)) {
    errors.push('visual inspection defect checklist is incomplete');
  } else {
    for (const check of VISUAL_DEFECT_CHECKS) {
      const result = report.checks[check];
      if (result?.status !== 'pass' || !String(result.notes ?? '').trim()) {
        errors.push(`visual inspection check ${check} must pass with concrete notes`);
      }
    }
  }
  const images = captureImageFiles();
  if (!sameKeys(report.captures, images)) {
    errors.push('visual inspection per-capture coverage is incomplete');
  } else {
    for (const image of images) {
      if (report.captures[image]?.status !== 'pass') {
        errors.push(`visual inspection did not pass ${image}`);
      }
    }
  }
}

function sameKeys(value, expected) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return actual.length === sortedExpected.length
    && actual.every((entry, index) => entry === sortedExpected[index]);
}

function requirePng(file, expected) {
  if (!fs.existsSync(file) || fs.statSync(file).size < 8) {
    errors.push(`${path.relative(ROOT, file)} is missing`);
    return;
  }
  const header = Buffer.alloc(8);
  const descriptor = fs.openSync(file, 'r');
  fs.readSync(descriptor, header, 0, 8, 0);
  fs.closeSync(descriptor);
  if (!header.equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    errors.push(`${path.relative(ROOT, file)} is not a PNG`);
    return;
  }
  try {
    const image = inspectImageFile(file);
    if (image.width !== expected.width || image.height !== expected.height) {
      errors.push(
        `${path.relative(ROOT, file)} is ${image.width}x${image.height}; expected ${expected.width}x${expected.height}`,
      );
    }
  } catch (error) {
    errors.push(`${path.relative(ROOT, file)} is unreadable: ${error instanceof Error ? error.message : error}`);
  }
}
