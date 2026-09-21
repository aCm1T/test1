import fs from 'node:fs';
import path from 'node:path';
import {
  inspectHeroDocument,
  inspectGpuInstanceCategories,
  inspectImageFile,
  inspectKtx2File,
  inspectPbrTextureEvidence,
  inspectRouteAnnotations,
  readGlbDocument,
  sniffAudioFile,
} from './lib/nightglass-binary-inspection.mjs';
import { NIGHTGLASS_RUNTIME_ASSET_IDS, hasSuppliedFile } from './lib/nightglass-asset-contract.mjs';

const ROOT = process.cwd();
const MANIFEST = path.join(ROOT, 'public/assets/manifest.json');
const SOURCE_ROOT = path.join(ROOT, 'assets/source');
const GROUPS = ['environment', 'viewmodel', 'characters', 'audio', 'references'];
const REQUIRED_REFERENCE_COUNT = 12;
const MAX_COMPRESSED_PAYLOAD_BYTES = 300 * 1024 * 1024;
const PUBLIC_ASSET_ROOT = path.join(ROOT, 'public/assets');
const ROUTES = [
  'route-spawn-lod0', 'route-spawn-lod1', 'route-spawn-lod2',
  'route-intersection-lod0', 'route-intersection-lod1', 'route-intersection-lod2',
  'route-warehouse-lod0', 'route-warehouse-lod1', 'route-warehouse-lod2',
  'route-props-lod0', 'route-props-lod1', 'route-props-lod2',
];
const VIEWMODEL = 'viewmodel-rifle';
const CHARACTERS = ['hostile-archetype-a', 'hostile-archetype-b'];
const TEXTURES = new Map([
  ['dusk-hdr', ['ktx2-uastc', 'hdr']],
  ['street-reflection-probe', ['ktx2-uastc', 'reflection-probe']],
  ['warehouse-reflection-probe', ['ktx2-uastc', 'reflection-probe']],
  ['hero-normal', ['ktx2-uastc', 'normal']],
  ['hero-orm', ['ktx2-uastc', 'orm']],
  ['hero-albedo', ['ktx2-etc1s', 'albedo']],
  ['hero-emissive', ['ktx2-etc1s', 'emissive']],
  ['route-spawn-lightmap', ['ktx2-etc1s', 'lightmap']],
  ['route-intersection-lightmap', ['ktx2-etc1s', 'lightmap']],
  ['route-warehouse-lightmap', ['ktx2-etc1s', 'lightmap']],
]);
const AUDIO = [
  'weapon-ar-fire', 'weapon-ar-mechanical', 'weapon-reload',
  'footsteps-concrete', 'footsteps-dirt', 'footsteps-metal',
  'impact-concrete', 'ambience-dusk', 'ui-confirm', 'indoor-tail', 'outdoor-tail',
];
const ENVIRONMENT_CAPABILITIES = [
  'street', 'intersection', 'warehouse', 'cover', 'debris', 'lamps', 'vehicles',
  'decals', 'emissive-windows', 'baked-lightmap', 'baked-ao', 'collision',
  'navigation-graph', 'cover-slots',
];
const VIEWMODEL_CAPABILITIES = [
  'rigged-rifle', 'rigged-arms', 'idle', 'fire', 'ads', 'sprint', 'reload', 'melee',
  'ads-reticle-marker',
];
const CHARACTER_CAPABILITIES = [
  'rigged', 'idle', 'locomotion', 'reaction', 'firing', 'reload', 'death', 'cover',
];
const AUDIO_CAPABILITIES = [
  'weapon-layers', 'weapon-reload', 'footsteps-concrete', 'footsteps-dirt',
  'footsteps-metal', 'impacts', 'ambience', 'ui', 'indoor-tail', 'outdoor-tail',
];
const VIEWMODEL_ANIMATIONS = {
  idle: ['idle', 'hip'],
  fire: ['fire', 'shoot'],
  ads: ['ads', 'aim'],
  sprint: ['sprint', 'run'],
  reload: ['reload'],
  melee: ['melee', 'knife'],
};
const CHARACTER_ANIMATIONS = {
  idle: ['idle'],
  locomotion: ['locomotion', 'walk', 'run'],
  reaction: ['reaction', 'alert', 'hit'],
  firing: ['firing', 'fire', 'shoot'],
  reload: ['reload'],
  death: ['death', 'die'],
  cover: ['cover'],
};

const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8'));
const entries = Array.isArray(manifest.assets) ? manifest.assets : [];
const byId = new Map(entries.map((entry) => [entry.id, entry]));
const errors = [];

for (const group of GROUPS) {
  if (!fs.existsSync(path.join(SOURCE_ROOT, group))) {
    errors.push(`assets/source/${group}/ is missing`);
  } else if (!hasSuppliedFile(path.join(SOURCE_ROOT, group))) {
    errors.push(`assets/source/${group}/ contains no supplied source files`);
  }
  const groupEntries = entries.filter((entry) => entry.metadata?.sourceGroup === group);
  if (groupEntries.length === 0) {
    errors.push(`manifest has no supplied ${group} assets`);
    continue;
  }
  for (const entry of groupEntries) validateProvenance(entry);
}

for (const id of NIGHTGLASS_RUNTIME_ASSET_IDS) {
  const entry = byId.get(id);
  if (!entry) errors.push(`${id}: required runtime asset is missing`);
  else if (entry.required !== true) errors.push(`${id}: runtime asset must be marked required`);
}
let compressedPayloadBytes = 0;
for (const id of [...ROUTES, VIEWMODEL, ...CHARACTERS, ...TEXTURES.keys(), ...AUDIO]) {
  const entry = byId.get(id);
  if (!entry) continue;
  const file = resolvePublicAsset(entry.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${id}: runtime file is missing at ${entry.url}`);
    continue;
  }
  const actualBytes = fs.statSync(file).size;
  compressedPayloadBytes += actualBytes;
  if (!Number.isFinite(entry.bytes) || entry.bytes <= 0) {
    errors.push(`${id}: manifest must declare a positive compressed byte size`);
  } else if (entry.bytes !== actualBytes) {
    errors.push(`${id}: declared ${entry.bytes} bytes but runtime file is ${actualBytes} bytes`);
  }
}
if (compressedPayloadBytes > MAX_COMPRESSED_PAYLOAD_BYTES) {
  errors.push(`runtime payload is ${compressedPayloadBytes} bytes; limit is ${MAX_COMPRESSED_PAYLOAD_BYTES}`);
}
const glbDocuments = new Map();
for (const id of [...ROUTES, VIEWMODEL, ...CHARACTERS]) {
  const entry = byId.get(id);
  const file = entry ? resolvePublicAsset(entry.url) : null;
  if (!file || !fs.existsSync(file)) continue;
  try {
    const document = readGlbDocument(file);
    glbDocuments.set(id, document);
    const inspection = inspectHeroDocument(document, {
      rigged: id === VIEWMODEL || CHARACTERS.includes(id),
      animationRoles: id === VIEWMODEL
        ? VIEWMODEL_ANIMATIONS
        : CHARACTERS.includes(id)
          ? CHARACTER_ANIMATIONS
          : undefined,
      adsMarker: id === VIEWMODEL,
      gpuInstancing: id.startsWith('route-props-'),
    });
    for (const problem of inspection) errors.push(`${id}: ${problem}`);
  } catch (error) {
    errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}
const annotationEvidence = inspectRouteAnnotations(
  ['route-spawn-lod0', 'route-intersection-lod0', 'route-warehouse-lod0', 'route-props-lod0']
    .map((id) => glbDocuments.get(id))
    .filter(Boolean),
);
if (glbDocuments.size > 0) {
  if (!annotationEvidence.hasCollision) errors.push('environment GLBs contain no authored collision nodes');
  if (
    annotationEvidence.collisionNodeCount < 1
    || annotationEvidence.collisionMeshCount !== annotationEvidence.collisionNodeCount
  ) errors.push('every authored collision node must contain triangle mesh geometry');
  if (annotationEvidence.navigationNodeCount < 2 || !annotationEvidence.hasNavigationLinks) {
    errors.push('environment GLBs contain no linked authored navigation graph');
  }
  if (!annotationEvidence.hasCover) errors.push('environment GLBs contain no authored cover slots');
  if (!annotationEvidence.hasOcclusion) errors.push('environment GLBs contain no baked occlusion textures');
  if (!annotationEvidence.hasEmissive) errors.push('environment GLBs contain no emissive window/card material');
  const textureEvidence = inspectPbrTextureEvidence([...glbDocuments.values()]);
  for (const role of ['albedo', 'normal', 'orm', 'emissive']) {
    if (!textureEvidence[role]) errors.push(`hero GLBs contain no authored ${role} texture binding`);
  }
  if (textureEvidence.nonBasisuRoles.length > 0) {
    errors.push(
      `hero GLB texture roles are not backed by KHR_texture_basisu KTX2 images: ${textureEvidence.nonBasisuRoles.join(', ')}`,
    );
  }
  const gpuInstances = inspectGpuInstanceCategories(
    ['route-props-lod0', 'route-props-lod1', 'route-props-lod2']
      .map((id) => glbDocuments.get(id))
      .filter(Boolean),
  );
  for (const category of ['debris', 'lamps', 'windows']) {
    if (!gpuInstances.categories.includes(category)) {
      errors.push(`route props contain no GPU-instanced ${category} nodes`);
    }
  }
}
for (const id of ROUTES) validateHeroModel(id, 'environment');
validateHeroModel(VIEWMODEL, 'viewmodel');
for (const id of CHARACTERS) validateHeroModel(id, 'characters');

requireAggregateCapabilities('environment', ENVIRONMENT_CAPABILITIES);
requireEntryCapabilities(VIEWMODEL, VIEWMODEL_CAPABILITIES);
for (const id of CHARACTERS) requireEntryCapabilities(id, CHARACTER_CAPABILITIES);
requireAggregateCapabilities('audio', AUDIO_CAPABILITIES);

for (const [id, [compression, semantic]] of TEXTURES) {
  const entry = byId.get(id);
  if (!entry) continue;
  if (entry.kind !== 'ktx2' || !/\.ktx2(?:$|[?#])/i.test(entry.url)) {
    errors.push(`${id}: required texture must be a KTX2 asset`);
  }
  if (entry.metadata?.compressed !== compression || entry.metadata?.textureSemantic !== semantic) {
    errors.push(`${id}: requires ${compression} ${semantic} metadata`);
  }
  const file = resolvePublicAsset(entry.url);
  if (file && fs.existsSync(file)) {
    try {
      const header = inspectKtx2File(file);
      if (header.pixelWidth <= 0 || header.pixelHeight <= 0 || header.levelCount <= 0) {
        errors.push(`${id}: KTX2 has invalid dimensions or mip levels`);
      }
      if (compression === 'ktx2-etc1s' && header.supercompressionScheme !== 1) {
        errors.push(`${id}: KTX2 payload is not ETC1S/BasisLZ`);
      }
      if (compression === 'ktx2-etc1s' && header.colorModel !== 163) {
        errors.push(`${id}: KTX2 data-format descriptor is not ETC1S`);
      }
      if (compression === 'ktx2-uastc' && (header.supercompressionScheme === 1 || header.colorModel !== 166)) {
        errors.push(`${id}: KTX2 data-format descriptor is not UASTC`);
      }
    } catch (error) {
      errors.push(`${id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
for (const id of AUDIO) {
  const entry = byId.get(id);
  if (entry && (entry.kind !== 'audio' || entry.metadata?.sourceGroup !== 'audio')) {
    errors.push(`${id}: required audio asset must use kind/audio source group`);
  }
  const file = entry ? resolvePublicAsset(entry.url) : null;
  if (file && fs.existsSync(file) && !sniffAudioFile(file)) {
    errors.push(`${id}: audio payload is not OGG, WAV, or MP3`);
  }
}

const references = entries.filter((entry) => entry.metadata?.sourceGroup === 'references');
if (references.length < REQUIRED_REFERENCE_COUNT) {
  errors.push(`requires ${REQUIRED_REFERENCE_COUNT} legal matched reference captures; found ${references.length}`);
}
for (const entry of references) {
  const reference = entry.metadata?.reference;
  if (
    !reference
    || reference.fov <= 0
    || reference.width <= 0
    || reference.height <= 0
    || !reference.sceneType
    || !String(reference.captureScenario ?? '').trim()
    || !validCrop(reference.crop)
  ) {
    errors.push(`${entry.id}: missing reference FOV/resolution/scene/captureScenario/crop metadata`);
  }
  const file = resolvePublicAsset(entry.url);
  if (!file || !fs.existsSync(file) || !fs.statSync(file).isFile()) {
    errors.push(`${entry.id}: reference file is missing at ${entry.url}`);
    continue;
  }
  try {
    const image = inspectImageFile(file);
    if (reference && (image.width !== reference.width || image.height !== reference.height)) {
      errors.push(
        `${entry.id}: reference is ${image.width}x${image.height}; metadata declares ${reference.width}x${reference.height}`,
      );
    }
  } catch (error) {
    errors.push(`${entry.id}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

if (errors.length > 0) {
  fs.writeSync(
    process.stderr.fd,
    `NIGHTGLASS asset release gate: BLOCKED\n${errors.map((error) => `- ${error}`).join('\n')}\n`,
  );
  process.exitCode = 1;
} else {
  console.log(`NIGHTGLASS asset release gate: PASS (${entries.length} manifest assets)`);
}

function validateProvenance(entry) {
  if (isPlaceholder(entry.metadata?.sourceRecord)) errors.push(`${entry.id}: missing source record`);
  if (isPlaceholder(entry.metadata?.licenseRecord)) errors.push(`${entry.id}: missing license record`);
  if (isPlaceholder(entry.license?.name)) errors.push(`${entry.id}: missing distribution license name`);
}

function validateHeroModel(id, sourceGroup) {
  const entry = byId.get(id);
  if (!entry) return;
  if (entry.kind !== 'gltf' || !/\.glb(?:$|[?#])/i.test(entry.url)) {
    errors.push(`${id}: hero model must be a GLB loaded as gltf`);
  }
  if (entry.metadata?.sourceGroup !== sourceGroup || entry.metadata?.compressed !== 'meshopt-glb') {
    errors.push(`${id}: hero model must be ${sourceGroup} Meshopt GLB`);
  }
  const mesh = entry.metadata?.mesh;
  if (!mesh?.uv0 || !mesh.uv1 || !mesh.tangents || !mesh.pbrMetalRough) {
    errors.push(`${id}: hero model must preserve UV0, UV1, tangents and metal/rough PBR`);
  }
}

function requireEntryCapabilities(id, required) {
  const entry = byId.get(id);
  if (!entry) return;
  const capabilities = new Set(Array.isArray(entry.metadata?.capabilities) ? entry.metadata.capabilities : []);
  for (const capability of required) {
    if (!capabilities.has(capability)) errors.push(`${id}: missing capability "${capability}"`);
  }
}

function requireAggregateCapabilities(group, required) {
  const capabilities = new Set(entries
    .filter((entry) => entry.metadata?.sourceGroup === group)
    .flatMap((entry) => Array.isArray(entry.metadata?.capabilities) ? entry.metadata.capabilities : []));
  for (const capability of required) {
    if (!capabilities.has(capability)) errors.push(`${group}: missing capability "${capability}"`);
  }
}

function isPlaceholder(value) {
  return !String(value ?? '').trim() || /replace_|placeholder|\btodo\b|\btbd\b/i.test(String(value));
}

function resolvePublicAsset(url) {
  if (typeof url !== 'string' || /^(?:[a-z]+:)?\/\//i.test(url)) return null;
  const resolved = path.resolve(PUBLIC_ASSET_ROOT, url.replace(/^\/+/, ''));
  return resolved.startsWith(`${PUBLIC_ASSET_ROOT}${path.sep}`) ? resolved : null;
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
