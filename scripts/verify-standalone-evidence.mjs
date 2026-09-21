import fs from 'node:fs';
import path from 'node:path';
import { sourceHash } from './lib/standalone-evidence.mjs';

const evidencePath = path.resolve(process.env.SMOKE_DIR ?? 'artifacts/standalone-smoke', 'evidence.json');
const failures = [];
if (!fs.existsSync(evidencePath)) {
  failures.push(`missing browser evidence: ${path.relative(process.cwd(), evidencePath)}`);
} else {
  const evidence = JSON.parse(fs.readFileSync(evidencePath, 'utf8'));
  if (evidence.sourceHash !== sourceHash()) failures.push('browser evidence is stale for the current source tree');
  for (const profile of ['root', 'project']) {
    const item = evidence.profiles?.[profile];
    if (!item?.passed) failures.push(`missing successful ${profile} deployment-base smoke result`);
    if (item?.viewports?.length !== 3) failures.push(`${profile} smoke evidence does not contain all three viewports`);
  }
}

if (failures.length) {
  console.error('Standalone browser evidence FAILED');
  failures.forEach((failure) => console.error(`- ${failure}`));
  process.exit(1);
}
console.log('Standalone browser evidence passed for / and /test1/ at all required viewports.');
