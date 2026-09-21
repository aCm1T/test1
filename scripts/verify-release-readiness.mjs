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

printLine('NIGHTGLASS release readiness');
printLine('----------------------------');

const assets = await runAssetsGate();
printGate('qa:assets', assets.ok ? 'PASS (subgate only)' : 'BLOCKED', assets.detail);

const references = countLegalReferences();
const prepareWouldRefuse = references < REQUIRED_REFERENCES;
printGate(
  'qa:review:prepare (preflight)',
  prepareWouldRefuse ? 'WOULD REFUSE' : 'refs present — still requires capture matrix + scoring',
  `${references} of ${REQUIRED_REFERENCES} legal matched references in manifest`,
);

printLine('');
printLine('Remaining release gates (not run by this script — must pass before release):');
for (const gate of remainingGates) {
  printLine(`- [${gate.id}] NOT EVIDENCED`);
  printLine(`  required: ${gate.command}`);
  printLine(`  why: ${gate.reason}`);
  printLine(`  see: ${gate.doc}`);
}

printLine('');
if (!assets.ok) {
  fs.writeSync(process.stderr.fd, 'NIGHTGLASS release readiness: BLOCKED — qa:assets failed\n');
  process.exitCode = 1;
} else {
  fs.writeSync(
    process.stderr.fd,
    'NIGHTGLASS release readiness: BLOCKED — assets gate ok, but capture/perf/blind evidence is not invented or verified here\n',
  );
  process.exitCode = 1;
}

async function runAssetsGate() {
  // Run the authoritative gate in-process. Nested process creation is denied
  // by some CI/sandbox runners and previously made qa:release report an empty
  // failure with no evidence, even though qa:assets itself was healthy.
  const priorExitCode = process.exitCode;
  process.exitCode = 0;
  try {
    await import('./verify-nightglass-assets.mjs');
    const status = Number(process.exitCode ?? 0);
    return {
      ok: status === 0,
      detail: status === 0
        ? 'asset release gate passed'
        : `asset release gate exited ${status}`,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    fs.writeSync(process.stderr.fd, `NIGHTGLASS asset release gate: BLOCKED — ${detail}\n`);
    return { ok: false, detail: 'asset release gate threw while validating' };
  } finally {
    process.exitCode = priorExitCode;
  }
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
  printLine(`- ${name}: ${status}`);
  if (detail) printLine(`  ${detail}`);
}

function printLine(value) {
  fs.writeSync(process.stdout.fd, `${value}\n`);
}
