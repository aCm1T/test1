import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export const CAPTURE_RESOLUTIONS = Object.freeze({
  '1080p': { width: 1920, height: 1080 },
  '1440p': { width: 2560, height: 1440 },
  ultrawide: { width: 3440, height: 1440 },
});

/** Gameplay capture poses shared by capture-screens and the release matrix. */
export const CAPTURE_SCENARIO_DEFS = Object.freeze([
  { name: 'spawn', position: [0, 0, 0], look: [Math.PI, -0.18], state: 'hip' },
  { name: 'street', position: [0, 0, 8], look: [Math.PI, -0.1], state: 'hip' },
  { name: 'alley', position: [-8, 0, 5], look: [2.2, -0.05], state: 'hip' },
  { name: 'warehouse', position: [0, 0, 21], look: [Math.PI, -0.08], state: 'hip' },
  { name: 'hip-fire', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'hip' },
  { name: 'ads', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'ads' },
  { name: 'reload', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'reload' },
  { name: 'reload-eject', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'reload-eject' },
  { name: 'reload-insert', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'reload-insert' },
  { name: 'reload-chamber', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'reload-chamber' },
  { name: 'enemy-5m', position: [0, 0, 6], look: [Math.PI, -0.08], state: 'hip', enemyDistance: 5 },
  { name: 'enemy-15m', position: [0, 0, 2], look: [Math.PI, -0.08], state: 'hip', enemyDistance: 15 },
  { name: 'enemy-30m', position: [0, 0, -8], look: [Math.PI, -0.08], state: 'hip', enemyDistance: 30 },
  { name: 'muzzle', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'muzzle' },
  { name: 'impacts', position: [0, 0, 10], look: [Math.PI, -0.12], state: 'impact' },
  { name: 'defense', position: [0, 0, 21], look: [Math.PI, -0.08], state: 'defense' },
  { name: 'damage', position: [0, 0, 14], look: [Math.PI, -0.08], state: 'damage' },
  { name: 'extraction', position: [0, 0, 29], look: [Math.PI, -0.05], state: 'extraction' },
  { name: 'death', position: [0, 0, 14], look: [Math.PI, -0.08], state: 'death' },
]);

/** Artifact scenario names: menu (pre-start) + every gameplay capture pose. */
export const CAPTURE_SCENARIOS = Object.freeze([
  'menu',
  ...CAPTURE_SCENARIO_DEFS.map((scenario) => scenario.name),
]);

export const CAPTURE_DEBUG_VIEWS = Object.freeze([
  'albedo', 'normals', 'orm', 'depth', 'shadow-cascades',
]);

export const VISUAL_DEFECT_CHECKS = Object.freeze([
  'primitiveFallback',
  'uvSeams',
  'closeRangeTextureTiling',
  'lightLeaks',
  'zFighting',
  'floatingProps',
  'lodPopWithin15m',
  'clippedNonLightHighlights',
  'crushedCriticalSubjects',
  'alphaSortFailures',
]);

export const VISUAL_INSPECTION_ATTESTATION =
  'I inspected every listed capture at native resolution and found no release-blocking visual defect.';

export function captureArtifactFiles() {
  const files = [];
  for (const resolution of Object.keys(CAPTURE_RESOLUTIONS)) {
    for (const scenario of CAPTURE_SCENARIOS) {
      files.push(`${resolution}/${scenario}.world.png`, `${resolution}/${scenario}.hud.png`);
    }
    for (const view of CAPTURE_DEBUG_VIEWS) files.push(`${resolution}/debug.${view}.png`);
    files.push(`${resolution}/renderer-stats.json`);
  }
  return files;
}

export function captureImageFiles() {
  return captureArtifactFiles().filter((file) => file.endsWith('.png'));
}

export function captureSetDigest(root) {
  const records = captureArtifactFiles().map((relative) => {
    const file = path.join(root, relative);
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) {
      throw new Error(`capture artifact is missing: ${relative}`);
    }
    const bytes = fs.readFileSync(file);
    return {
      file: relative,
      bytes: bytes.length,
      sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    };
  });
  return crypto.createHash('sha256').update(JSON.stringify(records)).digest('hex');
}
