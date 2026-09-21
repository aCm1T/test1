import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  CAPTURE_DEBUG_VIEWS,
  CAPTURE_RESOLUTIONS,
  CAPTURE_SCENARIOS,
  VISUAL_DEFECT_CHECKS,
  captureImageFiles,
} from '../../scripts/lib/nightglass-capture-integrity.mjs';

describe('capture matrix release gate', () => {
  it('binds complete native-resolution manual inspection to the exact capture bytes', () => {
    const root = preparePassingCaptureRoot();
    expect(runVerifier(root).status).toBe(0);

    const changed = path.join(root, '1080p', 'spawn.hud.png');
    const bytes = readFileSync(changed);
    writeFileSync(changed, Buffer.concat([bytes, Buffer.from([1])]));
    expect(runVerifier(root).status).toBe(1);
  });

  it('rejects procedural fallback, unready release gate, and wrong determinism seed', () => {
    const cases: Array<{
      label: string;
      patch: (runtime: Record<string, unknown>) => void;
      stderr: RegExp;
    }> = [
      {
        label: 'proceduralFallbackVisible',
        patch: (runtime) => {
          runtime.proceduralFallbackVisible = true;
        },
        stderr: /procedural fallback/,
      },
      {
        label: 'releaseGate.ready',
        patch: (runtime) => {
          runtime.releaseGate = { enabled: true, ready: false, reason: 'assets missing' };
        },
        stderr: /ready release gate/,
      },
      {
        label: 'determinism.initialSeed',
        patch: (runtime) => {
          runtime.determinism = {
            ...(runtime.determinism as Record<string, unknown>),
            initialSeed: 1,
          };
        },
        stderr: /deterministic fixed-seed/,
      },
    ];

    for (const testCase of cases) {
      const root = preparePassingCaptureRoot();
      for (const resolution of Object.keys(CAPTURE_RESOLUTIONS)) {
        const statsFile = path.join(root, resolution, 'renderer-stats.json');
        const report = JSON.parse(readFileSync(statsFile, 'utf8')) as {
          runtime: Record<string, unknown>;
        };
        testCase.patch(report.runtime);
        writeJson(statsFile, report);
      }
      const result = runVerifier(root);
      expect(result.status, testCase.label).toBe(1);
      expect(result.stderr, testCase.label).toMatch(testCase.stderr);
    }
  }, 15_000);
});

function preparePassingCaptureRoot(): string {
  const root = mkdtempSync(path.join(tmpdir(), 'nightglass-captures-'));
  for (const [resolution, dimensions] of Object.entries(CAPTURE_RESOLUTIONS)) {
    const directory = path.join(root, resolution);
    mkdirSync(directory, { recursive: true });
    for (const scenario of CAPTURE_SCENARIOS) {
      writePngHeader(path.join(directory, `${scenario}.world.png`), dimensions.width, dimensions.height);
      writePngHeader(path.join(directory, `${scenario}.hud.png`), dimensions.width, dimensions.height);
    }
    for (const view of CAPTURE_DEBUG_VIEWS) {
      writePngHeader(path.join(directory, `debug.${view}.png`), dimensions.width, dimensions.height);
    }
    writeJson(path.join(directory, 'renderer-stats.json'), rendererReport(dimensions));
  }

  const prepared = spawnSync(process.execPath, ['scripts/prepare-visual-inspection.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SCREENSHOT_DIR: root },
  });
  expect(prepared.status).toBe(0);
  const inspectionFile = path.join(root, 'visual-inspection.json');
  const inspection = JSON.parse(readFileSync(inspectionFile, 'utf8'));
  inspection.inspectorId = 'visual-qa-reviewer-01';
  inspection.inspectedAt = '2026-07-29T00:00:00.000Z';
  for (const check of VISUAL_DEFECT_CHECKS) {
    inspection.checks[check] = { status: 'pass', notes: `Inspected ${check} at native resolution.` };
  }
  for (const image of captureImageFiles()) {
    inspection.captures[image] = { status: 'pass', notes: '' };
  }
  writeJson(inspectionFile, inspection);
  return root;
}

function rendererReport(resolution: { width: number; height: number }) {
  return {
    resolution,
    runtime: {
      renderer: { peakCalls: 700, peakTriangles: 3_800_000 },
      assetMode: 'authored',
      proceduralFallbackVisible: false,
      releaseGate: { enabled: true, ready: true, reason: null },
      determinism: {
        seededSimulation: true,
        qaFrozen: true,
        initialSeed: 0x4e494748,
        fixedStepSeconds: 1 / 60,
        menuTimeSecondsWhenFrozen: 8,
        temporalEffectsFrozen: true,
      },
      authoredPresentation: {
        route: true,
        viewModel: true,
        enemies: true,
        audioBuffers: 11,
        staticColliders: 1,
        triangleColliders: 1,
        physics: { staticColliders: 1, trimeshColliders: 1, characters: 1, grenades: 0 },
        navigationNodes: 2,
        coverSlots: 1,
        heroTextures: 4,
        render: {
          instancedMeshes: 3,
          instances: 6,
          lightmappedMaterials: 3,
          emissiveMaterials: 1,
        },
      },
      viewModel: {
        sampleValid: true,
        adsReticleMarkerPresent: true,
        hipFrameOccupancy: 0.3,
        adsReticleErrorPixelsAt1080p: 2,
      },
    },
  };
}

function runVerifier(root: string) {
  return spawnSync(process.execPath, ['scripts/verify-capture-matrix.mjs'], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: { ...process.env, SCREENSHOT_DIR: root },
  });
}

function writePngHeader(file: string, width: number, height: number): void {
  const buffer = Buffer.alloc(24);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(buffer);
  buffer.writeUInt32BE(width, 16);
  buffer.writeUInt32BE(height, 20);
  writeFileSync(file, buffer);
}

function writeJson(file: string, value: unknown): void {
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
