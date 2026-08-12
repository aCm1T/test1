import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import crypto from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

const CATEGORIES = ['materials', 'silhouette', 'lighting', 'composition', 'animationVfx', 'ui'];
const ATTESTATION = 'I independently scored this blinded session without access to the answer key.';

describe('blind review release scripts', () => {
  it('prepares only real dimension-matched, crop-documented reference pairs', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-prepare-'));
    const publicAssets = path.join(root, 'public-assets');
    const captures = path.join(root, 'captures');
    const output = path.join(root, 'review');
    mkdirSync(path.join(publicAssets, 'references'), { recursive: true });
    mkdirSync(path.join(captures, '1080p'), { recursive: true });
    writePngHeader(path.join(captures, '1080p', 'spawn.hud.png'), 1920, 1080);
    writeAuthoredCaptureStats(path.join(captures, '1080p', 'renderer-stats.json'));
    const assets = Array.from({ length: 12 }, (_, index) => {
      const filename = `reference-${index + 1}.png`;
      writePngHeader(path.join(publicAssets, 'references', filename), 1920, 1080);
      return {
        id: `reference-${index + 1}`,
        kind: 'image',
        url: `references/${filename}`,
        metadata: {
          sourceGroup: 'references',
          reference: {
            fov: 90,
            width: 1920,
            height: 1080,
            sceneType: 'spawn',
            captureScenario: 'spawn',
            crop: { x: 32, y: 18, width: 1920, height: 1080 },
          },
        },
      };
    });
    const manifest = path.join(root, 'manifest.json');
    json(manifest, { version: '1', assets });

    const prepared = prepare({ manifest, publicAssets, captures, output });
    expect(prepared.status).toBe(0);
    const session = JSON.parse(readFileSync(path.join(output, 'review-session.json'), 'utf8'));
    expect(session.pairs).toHaveLength(12);
    expect(session.pairs[0]).toMatchObject({
      matched: { crop: { x: 32, y: 18, width: 1920, height: 1080 } },
      digests: { A: expect.stringMatching(/^[a-f0-9]{64}$/), B: expect.stringMatching(/^[a-f0-9]{64}$/) },
    });
    expect(session).toMatchObject({
      pairCount: 12,
      captureSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      referenceSetDigest: expect.stringMatching(/^[a-f0-9]{64}$/),
      scoreTemplate: {
        sessionId: session.sessionId,
        independentReviewAttestation: ATTESTATION,
      },
    });

    const freshOutput = path.join(root, 'fresh-review');
    const freshPrepared = prepare({
      manifest,
      publicAssets,
      captures,
      output: freshOutput,
      round: 'fresh-round',
      seed: 43,
      createdAt: '2026-07-29T01:00:00.000Z',
    });
    expect(freshPrepared.status).toBe(0);
    const freshSession = JSON.parse(
      readFileSync(path.join(freshOutput, 'review-session.json'), 'utf8'),
    );
    expect(freshSession.sessionId).not.toBe(session.sessionId);
    expect(freshSession.captureSetDigest).toBe(session.captureSetDigest);
    expect(freshSession.referenceSetDigest).toBe(session.referenceSetDigest);

    writePngHeader(path.join(captures, '1080p', 'spawn.hud.png'), 1280, 720);
    const rejected = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'invalid-review'),
    });
    expect(rejected.status).toBe(1);
  });

  it('rejects blind-review preparation from fallback or non-release captures', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-prepare-fallback-'));
    const publicAssets = path.join(root, 'public-assets');
    const captures = path.join(root, 'captures');
    mkdirSync(path.join(publicAssets, 'references'), { recursive: true });
    mkdirSync(path.join(captures, '1080p'), { recursive: true });
    writePngHeader(path.join(captures, '1080p', 'spawn.hud.png'), 1920, 1080);
    const assets = Array.from({ length: 12 }, (_, index) => {
      const filename = `reference-${index + 1}.png`;
      writePngHeader(path.join(publicAssets, 'references', filename), 1920, 1080);
      return {
        id: `reference-${index + 1}`,
        kind: 'image',
        url: `references/${filename}`,
        metadata: {
          sourceGroup: 'references',
          reference: {
            fov: 90,
            width: 1920,
            height: 1080,
            sceneType: 'spawn',
            captureScenario: 'spawn',
            crop: { x: 0, y: 0, width: 1920, height: 1080 },
          },
        },
      };
    });
    const manifest = path.join(root, 'manifest.json');
    json(manifest, { version: '1', assets });

    const missingStats = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'missing-stats'),
    });
    expect(missingStats.status).toBe(1);
    expect(missingStats.stderr).toContain('renderer-stats.json is missing');

    writeAuthoredCaptureStats(path.join(captures, '1080p', 'renderer-stats.json'), {
      assetMode: 'unloaded',
      proceduralFallbackVisible: true,
    });
    const fallback = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'fallback-stats'),
    });
    expect(fallback.status).toBe(1);
    expect(fallback.stderr).toMatch(/assetMode|proceduralFallbackVisible/);

    writeAuthoredCaptureStats(path.join(captures, '1080p', 'renderer-stats.json'), {
      releaseGate: { enabled: true, ready: false, reason: 'assets missing' },
    });
    const unready = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'unready-gate'),
    });
    expect(unready.status).toBe(1);
    expect(unready.stderr).toContain('releaseGate');

    writeAuthoredCaptureStats(path.join(captures, '1080p', 'renderer-stats.json'), {
      determinism: { initialSeed: 1 },
    });
    const wrongSeed = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'wrong-seed'),
    });
    expect(wrongSeed.status).toBe(1);
    expect(wrongSeed.stderr).toContain('0x4e494748');
  });

  it('fails closed when references omit captureScenario (no sceneType fallback)', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-prepare-scenario-'));
    const publicAssets = path.join(root, 'public-assets');
    const captures = path.join(root, 'captures');
    mkdirSync(path.join(publicAssets, 'references'), { recursive: true });
    mkdirSync(path.join(captures, '1080p'), { recursive: true });
    writePngHeader(path.join(captures, '1080p', 'spawn.hud.png'), 1920, 1080);
    writeAuthoredCaptureStats(path.join(captures, '1080p', 'renderer-stats.json'));
    const assets = Array.from({ length: 12 }, (_, index) => {
      const filename = `reference-${index + 1}.png`;
      writePngHeader(path.join(publicAssets, 'references', filename), 1920, 1080);
      return {
        id: `reference-${index + 1}`,
        kind: 'image',
        url: `references/${filename}`,
        metadata: {
          sourceGroup: 'references',
          reference: {
            fov: 90,
            width: 1920,
            height: 1080,
            sceneType: 'spawn',
            crop: { x: 0, y: 0, width: 1920, height: 1080 },
          },
        },
      };
    });
    const manifest = path.join(root, 'manifest.json');
    json(manifest, { version: '1', assets });
    const rejected = prepare({
      manifest,
      publicAssets,
      captures,
      output: path.join(root, 'no-scenario'),
    });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toMatch(/captureScenario|incomplete matched reference/i);
  });

  it('requires three reviewers and two distinct consecutive passing sessions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-review-'));
    const first = path.join(root, 'round-1');
    const second = path.join(root, 'round-2');
    makePassingRound(first, {
      round: 'round-1',
      seed: 714,
      createdAt: '2026-07-29T00:00:00.000Z',
      completedAt: '2026-07-29T00:10:00.000Z',
    });
    makePassingRound(second, {
      round: 'round-2',
      seed: 8921,
      createdAt: '2026-07-29T01:00:00.000Z',
      completedAt: '2026-07-29T01:10:00.000Z',
    });

    const firstRun = score(first);
    expect(firstRun.status).toBe(1);
    expect(JSON.parse(readFileSync(path.join(first, 'summary.json'), 'utf8'))).toMatchObject({
      roundPass: true,
      releasePass: false,
    });

    const secondRun = score(second, first);
    expect(secondRun.status).toBe(0);
    expect(JSON.parse(readFileSync(path.join(second, 'summary.json'), 'utf8'))).toMatchObject({
      roundPass: true,
      consecutiveFreshRounds: true,
      releasePass: true,
    });

    writeFileSync(path.join(first, 'pairs', 'pair-01', 'A.png'), Buffer.from('tampered'));
    expect(score(second, first).status).toBe(1);
  });
});

function makePassingRound(
  directory: string,
  options: { round: string; seed: number; createdAt: string; completedAt: string },
): void {
  mkdirSync(path.join(directory, 'scores'), { recursive: true });
  const pairs = [];
  const answerKey = [];
  for (let index = 1; index <= 12; index += 1) {
    const token = `pair-${String(index).padStart(2, '0')}`;
    const pairDir = path.join(directory, 'pairs', token);
    mkdirSync(pairDir, { recursive: true });
    const fileA = path.join(pairDir, 'A.png');
    const fileB = path.join(pairDir, 'B.png');
    writeMarkedPng(fileA, index);
    writeMarkedPng(fileB, 100 + index);
    const targetLabel = index % 2 === 0 ? 'B' : 'A';
    const referenceLabel = targetLabel === 'A' ? 'B' : 'A';
    const digestA = sha256(fileA);
    const digestB = sha256(fileB);
    const matched = {
      fov: 90,
      width: 1920,
      height: 1080,
      sceneType: 'spawn',
      captureScenario: 'spawn',
      crop: { x: 0, y: 0, width: 1920, height: 1080 },
    };
    pairs.push({
      token,
      images: { A: `pairs/${token}/A.png`, B: `pairs/${token}/B.png` },
      digests: { A: digestA, B: digestB },
      matched,
    });
    answerKey.push({
      token,
      targetLabel,
      referenceLabel,
      targetAsset: `artifacts/screenshots/1080p/spawn-${index}.hud.png`,
      referenceId: `reference-${index}`,
      targetSha256: targetLabel === 'A' ? digestA : digestB,
      referenceSha256: referenceLabel === 'A' ? digestA : digestB,
      matched,
    });
  }
  const captureDigest = hashJson(answerKey.map((answer) => ({
    targetAsset: answer.targetAsset,
    targetSha256: answer.targetSha256,
    matched: answer.matched,
  })).sort(compareRecords));
  const referenceDigest = hashJson(answerKey.map((answer) => ({
    referenceId: answer.referenceId,
    referenceSha256: answer.referenceSha256,
    matched: answer.matched,
  })).sort(compareRecords));
  const sessionId = [
    options.round,
    options.seed.toString(16).padStart(8, '0'),
    captureDigest.slice(0, 12),
    referenceDigest.slice(0, 12),
  ].join('-');
  const common = {
    sessionId,
    round: options.round,
    seed: options.seed,
    createdAt: options.createdAt,
    pairCount: 12,
    captureSetDigest: captureDigest,
    referenceSetDigest: referenceDigest,
  };
  json(path.join(directory, 'review-session.json'), {
    ...common,
    categories: CATEGORIES,
    pairs,
  });
  json(path.join(directory, 'answer-key.json'), { ...common, answerKey });
  for (let index = 1; index <= 3; index += 1) {
    const scores = Object.fromEntries(CATEGORIES.map((category) => [category, 5]));
    json(path.join(directory, 'scores', `reviewer-${index}.json`), {
      sessionId,
      reviewerId: `reviewer-${index}`,
      completedAt: new Date(Date.parse(options.completedAt) + index * 1000).toISOString(),
      independentReviewAttestation: ATTESTATION,
      pairs: Object.fromEntries(pairs.map(({ token }) => [
        token,
        { A: scores, B: scores, blockers: [] },
      ])),
    });
  }
}

function score(directory: string, previous?: string) {
  return spawnSync(process.execPath, ['scripts/score-blind-review.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_OUTPUT: directory,
      ...(previous ? { PREVIOUS_REVIEW_OUTPUT: previous } : {}),
    },
  });
}

function prepare(options: {
  manifest: string;
  publicAssets: string;
  captures: string;
  output: string;
  round?: string;
  seed?: number;
  createdAt?: string;
}) {
  return spawnSync(process.execPath, ['scripts/prepare-blind-review.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      REVIEW_MANIFEST: options.manifest,
      REVIEW_PUBLIC_ASSET_ROOT: options.publicAssets,
      REVIEW_CAPTURE_ROOT: options.captures,
      REVIEW_OUTPUT: options.output,
      REVIEW_ROUND: options.round ?? 'test-round',
      REVIEW_SEED: String(options.seed ?? 42),
      REVIEW_CREATED_AT: options.createdAt ?? '2026-07-29T00:00:00.000Z',
    },
  });
}

function json(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function writeAuthoredCaptureStats(
  file: string,
  overrides: Record<string, unknown> = {},
): void {
  json(file, {
    resolution: { width: 1920, height: 1080 },
    runtime: {
      assetMode: 'authored',
      proceduralFallbackVisible: false,
      releaseGate: { enabled: true, ready: true, reason: null },
      determinism: { initialSeed: 0x4e494748 },
      ...overrides,
    },
  });
}

function writePngHeader(file: string, width: number, height: number): void {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  writeFileSync(file, buffer);
}

function writeMarkedPng(file: string, marker: number): void {
  const buffer = Buffer.alloc(25);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(1920, 16);
  buffer.writeUInt32BE(1080, 20);
  buffer[24] = marker & 0xff;
  writeFileSync(file, buffer);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}

function hashJson(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function compareRecords(left: unknown, right: unknown): number {
  return JSON.stringify(left).localeCompare(JSON.stringify(right));
}
