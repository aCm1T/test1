import crypto from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { NIGHTGLASS_RUNTIME_ASSET_IDS } from '../../scripts/lib/nightglass-asset-contract.mjs';

describe('hardware performance release gate', () => {
  it('recomputes every threshold from hashed 10-minute per-frame evidence', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-performance-'));
    const reportDir = path.join(root, 'artifacts', 'performance');
    const publicAssets = path.join(root, 'public-assets');
    const bundle = path.join(root, 'dist', 'assets', 'index-test.js');
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(path.dirname(bundle), { recursive: true });
    mkdirSync(path.join(publicAssets, 'runtime'), { recursive: true });
    writeFileSync(bundle, 'export const verifiedBuild = true;\n');
    for (const id of NIGHTGLASS_RUNTIME_ASSET_IDS) {
      writeFileSync(path.join(publicAssets, 'runtime', `${id}.bin`), Buffer.alloc(32, 7));
    }
    const manifest = path.join(root, 'manifest.json');
    writeJson(manifest, {
      version: '1',
      assets: NIGHTGLASS_RUNTIME_ASSET_IDS.map((id) => ({
        id,
        required: true,
        url: `runtime/${id}.bin`,
      })),
    });

    const samplesFile = path.join(reportDir, 'high-1440p.samples.ndjson');
    const samples = Array.from({ length: 36_001 }, (_, index) => ({
      timestampMs: index * (1000 / 60),
      frameMs: 16,
      gpuMs: 10,
      mainThreadMs: 6,
      drawCalls: 400,
      triangles: 2_000_000,
      gpuDisjoint: false,
    }));
    writeFileSync(samplesFile, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
    const reportFile = path.join(reportDir, 'high-1440p.json');
    const report = {
      schemaVersion: 1,
      captureId: 'nightglass-rtx3060-run-001',
      capturedAt: '2026-07-29T00:00:00.000Z',
      browser: 'Chromium desktop',
      browserVersion: 'Chromium 142.0.1',
      userAgent: 'Mozilla/5.0 Chromium/142.0.1',
      quality: 'high',
      resolution: { width: 2560, height: 1440 },
      hardware: {
        gpuClass: 'RTX 3060-class',
        vendor: 'NVIDIA Corporation',
        device: 'NVIDIA GeForce RTX 3060',
        driver: '590.01',
        cpu: 'Test 8-core CPU',
      },
      build: {
        bundleFile: 'dist/assets/index-test.js',
        bundleSha256: sha256(bundle),
      },
      measurement: {
        tool: 'NIGHTGLASS built-in WebGL2 sampler v1',
        sampleMode: 'per-frame',
        gpuTimer: 'EXT_disjoint_timer_query_webgl2',
        warmupSeconds: 60,
      },
      evidence: {
        samplesFile: 'high-1440p.samples.ndjson',
        samplesSha256: sha256(samplesFile),
        frameSampleCount: samples.length,
        gpuAssetBytes: 512 * 1024 * 1024,
        gpuAssetEstimation: 'unique scene buffer and texture payload bytes',
        runtimeAssetMode: 'authored',
        proceduralFallbackVisible: false,
      },
      sampleDurationSeconds: 600,
      metrics: {
        sustainedFps: 60,
        p95FrameMs: 16,
        gpuMs: 10,
        mainThreadMs: 6,
        onePercentLowFps: 62.5,
        typicalDrawCalls: 400,
        peakDrawCalls: 400,
        typicalTriangles: 2_000_000,
        peakTriangles: 2_000_000,
        gpuAssetBytes: 512 * 1024 * 1024,
        compressedPayloadBytes: NIGHTGLASS_RUNTIME_ASSET_IDS.length * 32,
      },
    };
    writeJson(reportFile, report);
    expect(runGate({ root, reportFile, manifest, publicAssets }).status).toBe(0);

    const manifestData = JSON.parse(readFileSync(manifest, 'utf8'));
    manifestData.assets[0].required = false;
    writeJson(manifest, manifestData);
    expect(runGate({ root, reportFile, manifest, publicAssets }).status).toBe(1);
    manifestData.assets[0].required = true;
    writeJson(manifest, manifestData);

    report.evidence.proceduralFallbackVisible = true;
    writeJson(reportFile, report);
    expect(runGate({ root, reportFile, manifest, publicAssets }).status).toBe(1);
    report.evidence.proceduralFallbackVisible = false;

    report.metrics.p95FrameMs = 1;
    writeJson(reportFile, report);
    const rejected = runGate({ root, reportFile, manifest, publicAssets });
    expect(rejected.status).toBe(1);
  }, 15_000);

  it('rejects GPU strings that only substring-match or negate RTX 3060', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-performance-gpu-'));
    const reportDir = path.join(root, 'artifacts', 'performance');
    const publicAssets = path.join(root, 'public-assets');
    const bundle = path.join(root, 'dist', 'assets', 'index-test.js');
    mkdirSync(reportDir, { recursive: true });
    mkdirSync(path.dirname(bundle), { recursive: true });
    mkdirSync(path.join(publicAssets, 'runtime'), { recursive: true });
    writeFileSync(bundle, 'export const verifiedBuild = true;\n');
    for (const id of NIGHTGLASS_RUNTIME_ASSET_IDS) {
      writeFileSync(path.join(publicAssets, 'runtime', `${id}.bin`), Buffer.alloc(32, 7));
    }
    const manifest = path.join(root, 'manifest.json');
    writeJson(manifest, {
      version: '1',
      assets: NIGHTGLASS_RUNTIME_ASSET_IDS.map((id) => ({
        id,
        required: true,
        url: `runtime/${id}.bin`,
      })),
    });

    const samplesFile = path.join(reportDir, 'high-1440p.samples.ndjson');
    const samples = Array.from({ length: 36_001 }, (_, index) => ({
      timestampMs: index * (1000 / 60),
      frameMs: 16,
      gpuMs: 10,
      mainThreadMs: 6,
      drawCalls: 400,
      triangles: 2_000_000,
      gpuDisjoint: false,
    }));
    writeFileSync(samplesFile, `${samples.map((sample) => JSON.stringify(sample)).join('\n')}\n`);
    const reportFile = path.join(reportDir, 'high-1440p.json');
    const report = {
      schemaVersion: 1,
      captureId: 'nightglass-rtx3060-run-gpu-reject',
      capturedAt: '2026-07-29T00:00:00.000Z',
      browser: 'Chromium desktop',
      browserVersion: 'Chromium 142.0.1',
      userAgent: 'Mozilla/5.0 Chromium/142.0.1',
      quality: 'high',
      resolution: { width: 2560, height: 1440 },
      hardware: {
        gpuClass: 'not an RTX 3060',
        vendor: 'NVIDIA Corporation',
        device: 'not an RTX 3060',
        driver: '590.01',
        cpu: 'Test 8-core CPU',
      },
      build: {
        bundleFile: 'dist/assets/index-test.js',
        bundleSha256: sha256(bundle),
      },
      measurement: {
        tool: 'NIGHTGLASS built-in WebGL2 sampler v1',
        sampleMode: 'per-frame',
        gpuTimer: 'EXT_disjoint_timer_query_webgl2',
        warmupSeconds: 60,
      },
      evidence: {
        samplesFile: 'high-1440p.samples.ndjson',
        samplesSha256: sha256(samplesFile),
        frameSampleCount: samples.length,
        gpuAssetBytes: 512 * 1024 * 1024,
        gpuAssetEstimation: 'unique scene buffer and texture payload bytes',
        runtimeAssetMode: 'authored',
        proceduralFallbackVisible: false,
      },
      sampleDurationSeconds: 600,
      metrics: {
        sustainedFps: 60,
        p95FrameMs: 16,
        gpuMs: 10,
        mainThreadMs: 6,
        onePercentLowFps: 62.5,
        typicalDrawCalls: 400,
        peakDrawCalls: 400,
        typicalTriangles: 2_000_000,
        peakTriangles: 2_000_000,
        gpuAssetBytes: 512 * 1024 * 1024,
        compressedPayloadBytes: NIGHTGLASS_RUNTIME_ASSET_IDS.length * 32,
      },
    };
    writeJson(reportFile, report);
    const rejected = runGate({ root, reportFile, manifest, publicAssets });
    expect(rejected.status).toBe(1);
    expect(rejected.stderr).toContain('hardware.gpuClass must identify an RTX 3060-class device');
    expect(rejected.stderr).toContain(
      'hardware.device must be captured from an RTX 3060-class WebGL renderer',
    );

    report.hardware.gpuClass = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)';
    report.hardware.device = 'ANGLE (NVIDIA, NVIDIA GeForce RTX 3060 Direct3D11)';
    writeJson(reportFile, report);
    expect(runGate({ root, reportFile, manifest, publicAssets }).status).toBe(0);
  });
});

function runGate(options: {
  root: string;
  reportFile: string;
  manifest: string;
  publicAssets: string;
}) {
  return spawnSync(process.execPath, ['scripts/verify-performance.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      PERF_WORKSPACE_ROOT: options.root,
      PERF_REPORT: options.reportFile,
      PERF_MANIFEST: options.manifest,
      PERF_PUBLIC_ASSET_ROOT: options.publicAssets,
    },
  });
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function sha256(file: string): string {
  return crypto.createHash('sha256').update(readFileSync(file)).digest('hex');
}
