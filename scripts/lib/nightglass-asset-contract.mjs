import fs from 'node:fs';
import path from 'node:path';

export const NIGHTGLASS_ROUTE_ASSET_IDS = Object.freeze([
  'route-spawn-lod0',
  'route-spawn-lod1',
  'route-spawn-lod2',
  'route-intersection-lod0',
  'route-intersection-lod1',
  'route-intersection-lod2',
  'route-warehouse-lod0',
  'route-warehouse-lod1',
  'route-warehouse-lod2',
  'route-props-lod0',
  'route-props-lod1',
  'route-props-lod2',
]);

export const NIGHTGLASS_VIEWMODEL_ASSET_ID = 'viewmodel-rifle';
export const NIGHTGLASS_CHARACTER_ASSET_IDS = Object.freeze([
  'hostile-archetype-a',
  'hostile-archetype-b',
]);
export const NIGHTGLASS_LIGHTING_ASSET_IDS = Object.freeze([
  'dusk-hdr',
  'street-reflection-probe',
  'warehouse-reflection-probe',
]);
export const NIGHTGLASS_TEXTURE_ASSET_IDS = Object.freeze([
  'hero-normal',
  'hero-orm',
  'hero-albedo',
  'hero-emissive',
]);
export const NIGHTGLASS_LIGHTMAP_ASSET_IDS = Object.freeze([
  'route-spawn-lightmap',
  'route-intersection-lightmap',
  'route-warehouse-lightmap',
]);
export const NIGHTGLASS_AUDIO_ASSET_IDS = Object.freeze([
  'weapon-ar-fire',
  'weapon-ar-mechanical',
  'weapon-reload',
  'footsteps-concrete',
  'footsteps-dirt',
  'footsteps-metal',
  'impact-concrete',
  'ambience-dusk',
  'ui-confirm',
  'indoor-tail',
  'outdoor-tail',
]);

export const NIGHTGLASS_RUNTIME_ASSET_IDS = Object.freeze([
  ...NIGHTGLASS_ROUTE_ASSET_IDS,
  NIGHTGLASS_VIEWMODEL_ASSET_ID,
  ...NIGHTGLASS_CHARACTER_ASSET_IDS,
  ...NIGHTGLASS_LIGHTING_ASSET_IDS,
  ...NIGHTGLASS_TEXTURE_ASSET_IDS,
  ...NIGHTGLASS_LIGHTMAP_ASSET_IDS,
  ...NIGHTGLASS_AUDIO_ASSET_IDS,
]);

/** Extensions that count as real source payloads (not placeholders or docs). */
export const SOURCE_PAYLOAD_EXTENSIONS = Object.freeze(new Set([
  '.glb', '.gltf', '.bin', '.fbx', '.obj', '.blend', '.dae',
  '.png', '.jpg', '.jpeg', '.webp', '.tga', '.tif', '.tiff', '.exr', '.hdr', '.ktx2', '.psd',
  '.ogg', '.wav', '.mp3', '.flac', '.aiff',
]));

function isIgnorableSourceName(name) {
  const lower = name.toLowerCase();
  return lower === '.gitkeep' || lower.startsWith('readme');
}

function isSourcePayloadFile(filePath, name) {
  if (isIgnorableSourceName(name) || name.startsWith('.')) return false;
  const ext = path.extname(name).toLowerCase();
  if (!SOURCE_PAYLOAD_EXTENSIONS.has(ext)) return false;
  try {
    return fs.statSync(filePath).size > 0;
  } catch {
    return false;
  }
}

/** True only when a source group contains a non-empty real payload file. */
export function hasSuppliedFile(directory) {
  if (!fs.existsSync(directory)) return false;
  return fs.readdirSync(directory, { withFileTypes: true }).some((entry) => {
    if (entry.name.startsWith('.') || isIgnorableSourceName(entry.name)) return false;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return hasSuppliedFile(target);
    return entry.isFile() && isSourcePayloadFile(target, entry.name);
  });
}
