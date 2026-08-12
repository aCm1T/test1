import fs from 'node:fs';
import path from 'node:path';
import { inspectImageFile } from './lib/nightglass-binary-inspection.mjs';
import { assertReleaseGate } from './lib/nightglass-release-capture.mjs';
import {
  INDEPENDENT_REVIEW_ATTESTATION,
  REVIEW_CATEGORIES,
  captureSetDigest,
  referenceSetDigest,
  sha256File,
  validIsoTimestamp,
} from './lib/nightglass-review-integrity.mjs';

const ROOT = process.cwd();
const MANIFEST = path.resolve(process.env.REVIEW_MANIFEST ?? 'public/assets/manifest.json');
const CAPTURE_ROOT = path.resolve(process.env.REVIEW_CAPTURE_ROOT ?? 'artifacts/screenshots');
const PUBLIC_ASSET_ROOT = path.resolve(process.env.REVIEW_PUBLIC_ASSET_ROOT ?? 'public/assets');
const ROUND = process.env.REVIEW_ROUND ?? 'round-1';
const SEED = unsigned(process.env.REVIEW_SEED ?? hash(ROUND));
const OUTPUT = path.resolve(process.env.REVIEW_OUTPUT ?? `artifacts/blind-review/${ROUND}`);
const EXPECTED_FOV = Number(process.env.REVIEW_FOV ?? 90);
const EXPECTED_CAPTURE_SEED = 0x4e494748;
const CREATED_AT = process.env.REVIEW_CREATED_AT ?? new Date().toISOString();
const REQUIRED_REFERENCES = 12;
const CATEGORIES = REVIEW_CATEGORIES;

if (!validIsoTimestamp(CREATED_AT)) fail('REVIEW_CREATED_AT must be an ISO-8601 UTC timestamp');

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const references = manifest.assets
  .filter((entry) => entry.metadata?.sourceGroup === 'references')
  .sort((a, b) => a.id.localeCompare(b.id));
if (references.length < REQUIRED_REFERENCES) {
  fail(`requires ${REQUIRED_REFERENCES} legal references; found ${references.length}`);
}

if (fs.existsSync(OUTPUT) && fs.readdirSync(OUTPUT).length > 0) {
  fail(`review output must be a fresh empty directory: ${OUTPUT}`);
}

const planned = references.map((entry) => {
  const metadata = entry.metadata.reference;
  validateReference(entry.id, metadata);
  if (Math.abs(metadata.fov - EXPECTED_FOV) > 0.01) {
    fail(`${entry.id}: FOV ${metadata.fov} does not match capture FOV ${EXPECTED_FOV}`);
  }
  const resolution = resolutionLabel(metadata.width, metadata.height);
  const scenario = String(metadata.captureScenario ?? '').trim();
  if (!scenario) {
    fail(`${entry.id}: reference.captureScenario is required for blind pairing (sceneType fallback is not allowed)`);
  }
  return {
    entry,
    metadata,
    resolution,
    scenario,
    referenceFile: resolvePublicAsset(entry.url),
    captureFile: path.join(CAPTURE_ROOT, resolution, `${scenario}.hud.png`),
  };
});

for (const resolution of new Set(planned.map((item) => item.resolution))) {
  requireAuthoredCaptureStats(path.join(CAPTURE_ROOT, resolution, 'renderer-stats.json'), resolution);
}

for (const item of planned) {
  requireFile(item.referenceFile, `${item.entry.id} reference`);
  requireFile(item.captureFile, `${item.entry.id} matched target capture`);
  requireImageDimensions(
    item.referenceFile,
    item.metadata.width,
    item.metadata.height,
    `${item.entry.id} reference`,
  );
  requireImageDimensions(
    item.captureFile,
    item.metadata.width,
    item.metadata.height,
    `${item.entry.id} target`,
  );
}

fs.mkdirSync(path.join(OUTPUT, 'pairs'), { recursive: true });
const random = seeded(SEED);
const answerKey = [];
const pairs = planned.map((item, index) => {
  const { entry, metadata, scenario, referenceFile, captureFile } = item;

  const token = `pair-${String(index + 1).padStart(2, '0')}-${tokenFrom(random)}`;
  const targetLabel = random() < 0.5 ? 'A' : 'B';
  const referenceLabel = targetLabel === 'A' ? 'B' : 'A';
  const directory = path.join(OUTPUT, 'pairs', token);
  fs.mkdirSync(directory, { recursive: true });
  fs.copyFileSync(captureFile, path.join(directory, `${targetLabel}.png`));
  fs.copyFileSync(referenceFile, path.join(directory, `${referenceLabel}.png`));
  const matched = {
    fov: metadata.fov,
    width: metadata.width,
    height: metadata.height,
    sceneType: metadata.sceneType,
    captureScenario: scenario,
    crop: metadata.crop,
  };
  const targetSha256 = sha256File(captureFile);
  const referenceSha256 = sha256File(referenceFile);
  answerKey.push({
    token,
    targetLabel,
    referenceLabel,
    targetAsset: path.relative(ROOT, captureFile),
    referenceId: entry.id,
    targetSha256,
    referenceSha256,
    matched,
  });
  return {
    token,
    images: { A: `pairs/${token}/A.png`, B: `pairs/${token}/B.png` },
    digests: {
      A: targetLabel === 'A' ? targetSha256 : referenceSha256,
      B: targetLabel === 'B' ? targetSha256 : referenceSha256,
    },
    matched,
  };
});
const captureDigest = captureSetDigest(answerKey);
const referenceDigest = referenceSetDigest(answerKey);
const sessionId = [
  ROUND,
  SEED.toString(16).padStart(8, '0'),
  captureDigest.slice(0, 12),
  referenceDigest.slice(0, 12),
].join('-');
writeJson(path.join(OUTPUT, 'review-session.json'), {
  sessionId,
  round: ROUND,
  seed: SEED,
  createdAt: CREATED_AT,
  pairCount: pairs.length,
  captureSetDigest: captureDigest,
  referenceSetDigest: referenceDigest,
  categories: CATEGORIES,
  instructions: 'Score both A and B independently from 1 to 5. Do not identify products or infer which image is the target. Report concrete blockers separately.',
  scoreTemplate: {
    sessionId,
    reviewerId: 'replace-with-independent-reviewer-id',
    completedAt: 'replace-with-ISO-8601-UTC-timestamp',
    independentReviewAttestation: INDEPENDENT_REVIEW_ATTESTATION,
    pairs: Object.fromEntries(pairs.map(({ token }) => [token, {
      A: Object.fromEntries(CATEGORIES.map((category) => [category, null])),
      B: Object.fromEntries(CATEGORIES.map((category) => [category, null])),
      blockers: [],
    }])),
  },
  pairs,
});
writeJson(path.join(OUTPUT, 'answer-key.json'), {
  sessionId,
  round: ROUND,
  seed: SEED,
  createdAt: CREATED_AT,
  pairCount: pairs.length,
  captureSetDigest: captureDigest,
  referenceSetDigest: referenceDigest,
  answerKey,
});
fs.mkdirSync(path.join(OUTPUT, 'scores'), { recursive: true });
console.log(`blind review prepared: ${pairs.length} pairs, session ${sessionId}`);
console.log(`keep ${path.join(OUTPUT, 'answer-key.json')} hidden from reviewers`);

function validateReference(id, metadata) {
  if (
    !metadata
    || !Number.isFinite(metadata.fov)
    || !Number.isInteger(metadata.width)
    || !Number.isInteger(metadata.height)
    || !String(metadata.sceneType ?? '').trim()
    || !String(metadata.captureScenario ?? '').trim()
    || !validCrop(metadata.crop)
  ) fail(`${id}: incomplete matched reference metadata`);
}

function validCrop(crop) {
  return crop
    && Number.isInteger(crop.x)
    && Number.isInteger(crop.y)
    && crop.x >= 0
    && crop.y >= 0
    && Number.isInteger(crop.width)
    && Number.isInteger(crop.height)
    && crop.width > 0
    && crop.height > 0;
}

function resolutionLabel(width, height) {
  if (width === 1920 && height === 1080) return '1080p';
  if (width === 2560 && height === 1440) return '1440p';
  if (width === 3440 && height === 1440) return 'ultrawide';
  fail(`unsupported matched resolution ${width}x${height}`);
}

function resolvePublicAsset(url) {
  const file = path.resolve(PUBLIC_ASSET_ROOT, String(url).replace(/^\/+/, ''));
  if (!file.startsWith(`${PUBLIC_ASSET_ROOT}${path.sep}`)) fail(`reference URL escapes public assets: ${url}`);
  return file;
}

function requireAuthoredCaptureStats(statsFile, resolution) {
  if (!fs.existsSync(statsFile) || !fs.statSync(statsFile).isFile()) {
    fail(`${resolution}: sibling renderer-stats.json is missing`);
  }
  let report;
  try {
    report = JSON.parse(fs.readFileSync(statsFile, 'utf8'));
  } catch (error) {
    fail(`${resolution}: renderer-stats.json is unreadable: ${error instanceof Error ? error.message : error}`);
  }
  const runtime = report?.runtime ?? {};
  try {
    assertReleaseGate(runtime, `${resolution} capture stats`);
  } catch (error) {
    fail(error instanceof Error ? error.message : String(error));
  }
  if (runtime.determinism?.initialSeed !== EXPECTED_CAPTURE_SEED) {
    fail(`${resolution}: capture seed is not 0x4e494748`);
  }
}

function requireFile(file, label) {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`${label} is missing: ${file}`);
}

function requireImageDimensions(file, width, height, label) {
  let image;
  try {
    image = inspectImageFile(file);
  } catch (error) {
    fail(`${label} is not a readable PNG/JPEG: ${error instanceof Error ? error.message : error}`);
  }
  if (image.width !== width || image.height !== height) {
    fail(`${label} is ${image.width}x${image.height}; expected ${width}x${height}`);
  }
}

function writeJson(file, value) {
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function seeded(seed) {
  let state = seed || 0x6d2b79f5;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 0x100000000;
  };
}

function tokenFrom(random) {
  return Math.floor(random() * 0xffffffff).toString(16).padStart(8, '0');
}

function hash(value) {
  let result = 2166136261;
  for (const character of String(value)) {
    result ^= character.charCodeAt(0);
    result = Math.imul(result, 16777619);
  }
  return result >>> 0;
}

function unsigned(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number >>> 0 : hash(value);
}

function fail(message) {
  console.error(`blind review preparation: BLOCKED — ${message}`);
  process.exit(1);
}
