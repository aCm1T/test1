import fs from 'node:fs';
import path from 'node:path';
import {
  VISUAL_DEFECT_CHECKS,
  VISUAL_INSPECTION_ATTESTATION,
  captureImageFiles,
  captureSetDigest,
} from './lib/nightglass-capture-integrity.mjs';

const ROOT = path.resolve(process.env.SCREENSHOT_DIR ?? 'artifacts/screenshots');
const OUTPUT = path.resolve(process.env.VISUAL_INSPECTION_FILE ?? path.join(ROOT, 'visual-inspection.json'));
if (fs.existsSync(OUTPUT)) {
  fail(`refusing to overwrite an existing inspection: ${OUTPUT}`);
}
let digest;
try {
  digest = captureSetDigest(ROOT);
} catch (error) {
  fail(error instanceof Error ? error.message : String(error));
}
const report = {
  schemaVersion: 1,
  captureSetDigest: digest,
  inspectorId: 'replace-with-inspector-id',
  inspectedAt: 'replace-with-ISO-8601-UTC-timestamp',
  attestation: VISUAL_INSPECTION_ATTESTATION,
  checks: Object.fromEntries(VISUAL_DEFECT_CHECKS.map((check) => [
    check,
    { status: null, notes: '' },
  ])),
  captures: Object.fromEntries(captureImageFiles().map((file) => [
    file,
    { status: null, notes: '' },
  ])),
};
fs.writeFileSync(OUTPUT, `${JSON.stringify(report, null, 2)}\n`);
console.log(`visual inspection template prepared for capture set ${digest}`);
console.log(`inspect every image at native resolution, then complete ${OUTPUT}`);

function fail(message) {
  console.error(`visual inspection preparation: BLOCKED — ${message}`);
  process.exit(1);
}
