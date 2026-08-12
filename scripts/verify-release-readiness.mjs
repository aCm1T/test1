/**
 * Fail-closed NIGHTGLASS release readiness check.
 *
 * Runs the asset gate for real, then documents remaining release gates from
 * docs/RELEASE-REVIEW.md without inventing capture/perf/blind passes.
 * This script never exits 0: absence of proven matrix/perf/blind evidence is a
 * release blocker even when assets eventually pass.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, 'public/assets/manifest.json');
const REQUIRED_REFERENCES = 12;

const remainingGates = [
  {
    id: 'capture-matrix',
    command: 'npm run qa:capture:matrix && npm run qa:visual:prepare && npm run qa:capture:verify',
    doc: 'docs/RELEASE-REVIEW.md',
    reason:
      'Authored no-fallback 1080p/1440p/3440×1440 capture matrix + native-resolution visual inspection must pass (skipped here: needs hardware/authored assets).',
  },
  {
    id: 'performance',
    command: 'npm run qa:performance:capture && npm run qa:performance',
    doc: 'docs/PERFORMANCE.md',
    reason:
      '10-minute High/2560×1440 RTX 3060-class Chromium capture must pass (skipped here: needs reference hardware).',
  },
  {
    id: 'blind-review',
    command: 'npm run qa:review:prepare / qa:review:score (two fresh rounds)',
    doc: 'docs/BLIND-REVIEW.md',
    reason:
      'Two consecutive three-reviewer blind rounds must pass (skipped here: needs legal references + authored captures).',
  },
];

console.log('NIGHTGLASS release readiness');
console.log('----------------------------');

const assets = runAssetsGate();
printGate('qa:assets', assets.ok ? 'PASS (subgate only)' : 'BLOCKED', assets.detail);

const references = countLegalReferences();
const prepareWouldRefuse = references < REQUIRED_REFERENCES;
printGate(
  'qa:review:prepare (preflight)',
  prepareWouldRefuse ? 'WOULD REFUSE' : 'refs present — still requires capture matrix + scoring',
  `${references} of ${REQUIRED_REFERENCES} legal matched references in manifest`,
);

console.log('');
console.log('Remaining release gates (not run by this script — must pass before release):');
for (const gate of remainingGates) {
  console.log(`- [${gate.id}] NOT EVIDENCED`);
  console.log(`  required: ${gate.command}`);
  console.log(`  why: ${gate.reason}`);
  console.log(`  see: ${gate.doc}`);
}

console.log('');
if (!assets.ok) {
  console.error('NIGHTGLASS release readiness: BLOCKED — qa:assets failed');
  process.exit(1);
}

console.error(
  'NIGHTGLASS release readiness: BLOCKED — assets gate ok, but capture/perf/blind evidence is not invented or verified here',
);
process.exit(1);

function runAssetsGate() {
  const result = spawnSync(process.execPath, [path.join('scripts', 'verify-nightglass-assets.mjs')], {
    cwd: ROOT,
    encoding: 'utf8',
    env: process.env,
  });
  const stdout = result.stdout?.trim() ?? '';
  const stderr = result.stderr?.trim() ?? '';
  if (stdout) console.log(stdout);
  if (stderr) console.error(stderr);
  return {
    ok: result.status === 0,
    detail: result.status === 0
      ? 'asset release gate passed'
      : `asset release gate exited ${result.status ?? 'null'}`,
  };
}

function countLegalReferences() {
  if (!fs.existsSync(MANIFEST)) return 0;
  try {
    const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
    const assets = Array.isArray(manifest.assets) ? manifest.assets : [];
    return assets.filter((entry) => entry?.metadata?.sourceGroup === 'references').length;
  } catch {
    return 0;
  }
}

function printGate(name, status, detail) {
  console.log(`- ${name}: ${status}`);
  if (detail) console.log(`  ${detail}`);
}
