import type { AssetManifest, AssetManifestEntry } from '../engine';

export const REQUIRED_SOURCE_GROUPS = [
  'environment',
  'viewmodel',
  'characters',
  'audio',
  'references',
] as const;

export const MIN_REFERENCE_CAPTURES = 12;
export const MAX_COMPRESSED_PAYLOAD_BYTES = 300 * 1024 * 1024;

export const NIGHTGLASS_ROUTE_ASSET_IDS = [
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
] as const;

export const NIGHTGLASS_VIEWMODEL_ASSET_ID = 'viewmodel-rifle';
export const NIGHTGLASS_CHARACTER_ASSET_IDS = [
  'hostile-archetype-a',
  'hostile-archetype-b',
] as const;
export const NIGHTGLASS_LIGHTING_ASSET_IDS = [
  'dusk-hdr',
  'street-reflection-probe',
  'warehouse-reflection-probe',
] as const;
export const NIGHTGLASS_TEXTURE_ASSET_IDS = [
  'hero-normal',
  'hero-orm',
  'hero-albedo',
  'hero-emissive',
] as const;
export const NIGHTGLASS_LIGHTMAP_ASSET_IDS = [
  'route-spawn-lightmap',
  'route-intersection-lightmap',
  'route-warehouse-lightmap',
] as const;
export const NIGHTGLASS_AUDIO_ASSET_IDS = [
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
] as const;

export const NIGHTGLASS_RUNTIME_ASSET_IDS = [
  ...NIGHTGLASS_ROUTE_ASSET_IDS,
  NIGHTGLASS_VIEWMODEL_ASSET_ID,
  ...NIGHTGLASS_CHARACTER_ASSET_IDS,
  ...NIGHTGLASS_LIGHTING_ASSET_IDS,
  ...NIGHTGLASS_TEXTURE_ASSET_IDS,
  ...NIGHTGLASS_LIGHTMAP_ASSET_IDS,
  ...NIGHTGLASS_AUDIO_ASSET_IDS,
] as const;

export const NIGHTGLASS_ENVIRONMENT_CAPABILITIES = [
  'street',
  'intersection',
  'warehouse',
  'cover',
  'debris',
  'lamps',
  'vehicles',
  'decals',
  'emissive-windows',
  'baked-lightmap',
  'baked-ao',
  'collision',
  'navigation-graph',
  'cover-slots',
] as const;

export const NIGHTGLASS_VIEWMODEL_CAPABILITIES = [
  'rigged-rifle',
  'rigged-arms',
  'idle',
  'fire',
  'ads',
  'sprint',
  'reload',
  'melee',
  'ads-reticle-marker',
] as const;

export const NIGHTGLASS_CHARACTER_CAPABILITIES = [
  'rigged',
  'idle',
  'locomotion',
  'reaction',
  'firing',
  'reload',
  'death',
  'cover',
] as const;

export const NIGHTGLASS_AUDIO_CAPABILITIES = [
  'weapon-layers',
  'weapon-reload',
  'footsteps-concrete',
  'footsteps-dirt',
  'footsteps-metal',
  'impacts',
  'ambience',
  'ui',
  'indoor-tail',
  'outdoor-tail',
] as const;

export type RequiredSourceGroup = (typeof REQUIRED_SOURCE_GROUPS)[number];

export interface SourceAssetMetadata {
  sourceGroup: RequiredSourceGroup;
  sourceRecord: string;
  licenseRecord: string;
  compressed?: 'meshopt-glb' | 'ktx2-uastc' | 'ktx2-etc1s' | 'audio';
  capabilities?: readonly string[];
  mesh?: {
    uv0: boolean;
    uv1: boolean;
    tangents: boolean;
    pbrMetalRough: boolean;
  };
  textureSemantic?: 'normal' | 'orm' | 'albedo' | 'emissive' | 'lightmap' | 'hdr' | 'reflection-probe';
  reference?: {
    fov: number;
    width: number;
    height: number;
    sceneType: string;
    /** Exact capture-matrix scenario name used for blind pairing (no sceneType fallback). */
    captureScenario: string;
    /** Crop provenance from the legally supplied source before matched export. */
    crop: { x: number; y: number; width: number; height: number };
  };
}

export interface AssetContractReport {
  valid: boolean;
  suppliedGroups: RequiredSourceGroup[];
  missingGroups: RequiredSourceGroup[];
  invalidAssets: Array<{ id: string; reason: string }>;
}

/**
 * Strict release contract for the authored vertical slice. It validates not
 * only provenance, but every runtime ID and authored capability needed to keep
 * camera-visible procedural fallbacks out of a release capture.
 */
export function validateNightglassAssetContract(
  manifest: AssetManifest,
): AssetContractReport {
  const supplied = new Set<RequiredSourceGroup>();
  const invalidAssets: AssetContractReport['invalidAssets'] = [];
  const entries = new Map(manifest.assets.map((entry) => [entry.id, entry]));

  for (const entry of manifest.assets) {
    const metadata = entry.metadata as SourceAssetMetadata | undefined;
    if (!metadata?.sourceGroup) continue;
    if (!REQUIRED_SOURCE_GROUPS.includes(metadata.sourceGroup)) {
      invalidAssets.push({ id: entry.id, reason: 'unknown source group' });
      continue;
    }
    supplied.add(metadata.sourceGroup);
    validateEntry(entry, metadata, invalidAssets);
  }

  for (const id of NIGHTGLASS_RUNTIME_ASSET_IDS) {
    const entry = entries.get(id);
    if (!entry) invalidAssets.push({ id, reason: 'required runtime asset is missing' });
    else if (entry.required !== true) {
      invalidAssets.push({ id, reason: 'runtime asset must be marked required' });
    }
  }
  let compressedPayloadBytes = 0;
  for (const id of NIGHTGLASS_RUNTIME_ASSET_IDS) {
    const entry = entries.get(id);
    if (!entry) continue;
    if (!entry.bytes || entry.bytes <= 0) {
      invalidAssets.push({ id, reason: 'required runtime asset must declare a positive compressed byte size' });
    } else {
      compressedPayloadBytes += entry.bytes;
    }
  }
  if (compressedPayloadBytes > MAX_COMPRESSED_PAYLOAD_BYTES) {
    invalidAssets.push({
      id: 'runtime-payload',
      reason: `compressed payload ${compressedPayloadBytes} exceeds ${MAX_COMPRESSED_PAYLOAD_BYTES} bytes`,
    });
  }

  for (const id of NIGHTGLASS_ROUTE_ASSET_IDS) {
    validateHeroModel(entries.get(id), id, 'environment', invalidAssets);
  }
  validateHeroModel(
    entries.get(NIGHTGLASS_VIEWMODEL_ASSET_ID),
    NIGHTGLASS_VIEWMODEL_ASSET_ID,
    'viewmodel',
    invalidAssets,
  );
  for (const id of NIGHTGLASS_CHARACTER_ASSET_IDS) {
    validateHeroModel(entries.get(id), id, 'characters', invalidAssets);
  }

  requireCapabilities(
    manifest.assets.filter((entry) => sourceGroup(entry) === 'environment'),
    NIGHTGLASS_ENVIRONMENT_CAPABILITIES,
    'environment',
    invalidAssets,
  );
  requireEntryCapabilities(
    entries.get(NIGHTGLASS_VIEWMODEL_ASSET_ID),
    NIGHTGLASS_VIEWMODEL_CAPABILITIES,
    invalidAssets,
  );
  for (const id of NIGHTGLASS_CHARACTER_ASSET_IDS) {
    requireEntryCapabilities(entries.get(id), NIGHTGLASS_CHARACTER_CAPABILITIES, invalidAssets);
  }
  requireCapabilities(
    manifest.assets.filter((entry) => sourceGroup(entry) === 'audio'),
    NIGHTGLASS_AUDIO_CAPABILITIES,
    'audio',
    invalidAssets,
  );

  validateTexture(entries.get('dusk-hdr'), 'dusk-hdr', 'ktx2-uastc', 'hdr', invalidAssets);
  validateTexture(
    entries.get('street-reflection-probe'),
    'street-reflection-probe',
    'ktx2-uastc',
    'reflection-probe',
    invalidAssets,
  );
  validateTexture(
    entries.get('warehouse-reflection-probe'),
    'warehouse-reflection-probe',
    'ktx2-uastc',
    'reflection-probe',
    invalidAssets,
  );
  validateTexture(entries.get('hero-normal'), 'hero-normal', 'ktx2-uastc', 'normal', invalidAssets);
  validateTexture(entries.get('hero-orm'), 'hero-orm', 'ktx2-uastc', 'orm', invalidAssets);
  validateTexture(entries.get('hero-albedo'), 'hero-albedo', 'ktx2-etc1s', 'albedo', invalidAssets);
  validateTexture(entries.get('hero-emissive'), 'hero-emissive', 'ktx2-etc1s', 'emissive', invalidAssets);
  for (const id of NIGHTGLASS_LIGHTMAP_ASSET_IDS) {
    validateTexture(entries.get(id), id, 'ktx2-etc1s', 'lightmap', invalidAssets);
  }

  for (const id of NIGHTGLASS_AUDIO_ASSET_IDS) {
    const entry = entries.get(id);
    if (entry && (entry.kind !== 'audio' || sourceGroup(entry) !== 'audio')) {
      invalidAssets.push({ id, reason: 'required audio asset must use kind/audio source group' });
    }
  }

  const references = manifest.assets.filter((entry) => sourceGroup(entry) === 'references');
  if (references.length < MIN_REFERENCE_CAPTURES) {
    invalidAssets.push({
      id: 'references',
      reason: `requires ${MIN_REFERENCE_CAPTURES} matched captures; received ${references.length}`,
    });
  }

  const suppliedGroups = REQUIRED_SOURCE_GROUPS.filter((group) => supplied.has(group));
  const missingGroups = REQUIRED_SOURCE_GROUPS.filter((group) => !supplied.has(group));
  return {
    valid: missingGroups.length === 0 && invalidAssets.length === 0,
    suppliedGroups: [...suppliedGroups],
    missingGroups: [...missingGroups],
    invalidAssets,
  };
}

function validateEntry(
  entry: AssetManifestEntry,
  metadata: SourceAssetMetadata,
  invalidAssets: Array<{ id: string; reason: string }>,
): void {
  if (isPlaceholder(metadata.sourceRecord)) {
    invalidAssets.push({ id: entry.id, reason: 'missing or placeholder source record' });
  }
  if (isPlaceholder(metadata.licenseRecord) || isPlaceholder(entry.license?.name)) {
    invalidAssets.push({ id: entry.id, reason: 'missing or placeholder license record' });
  }
  if (metadata.sourceGroup === 'references') {
    const ref = metadata.reference;
    if (
      !ref
      || ref.fov <= 0
      || ref.width <= 0
      || ref.height <= 0
      || !ref.sceneType?.trim()
      || !ref.captureScenario?.trim()
      || !validCrop(ref.crop)
    ) {
      invalidAssets.push({ id: entry.id, reason: 'reference metadata is incomplete' });
    }
  }
}

function validCrop(
  crop: NonNullable<SourceAssetMetadata['reference']>['crop'] | undefined,
): boolean {
  return Boolean(
    crop
    && Number.isInteger(crop.x)
    && Number.isInteger(crop.y)
    && crop.x >= 0
    && crop.y >= 0
    && Number.isInteger(crop.width)
    && Number.isInteger(crop.height)
    && crop.width > 0
    && crop.height > 0,
  );
}

function validateHeroModel(
  entry: AssetManifestEntry | undefined,
  id: string,
  group: RequiredSourceGroup,
  invalidAssets: Array<{ id: string; reason: string }>,
): void {
  if (!entry) return;
  const metadata = entry.metadata as SourceAssetMetadata | undefined;
  if (entry.kind !== 'gltf' || !/\.glb(?:$|[?#])/i.test(entry.url)) {
    invalidAssets.push({ id, reason: 'hero model must be a GLB loaded as gltf' });
  }
  if (metadata?.sourceGroup !== group || metadata.compressed !== 'meshopt-glb') {
    invalidAssets.push({ id, reason: `hero model must be ${group} Meshopt GLB` });
  }
  const mesh = metadata?.mesh;
  if (!mesh?.uv0 || !mesh.uv1 || !mesh.tangents || !mesh.pbrMetalRough) {
    invalidAssets.push({ id, reason: 'hero model must preserve UV0, UV1, tangents and metal/rough PBR' });
  }
}

function validateTexture(
  entry: AssetManifestEntry | undefined,
  id: string,
  compression: SourceAssetMetadata['compressed'],
  semantic: SourceAssetMetadata['textureSemantic'],
  invalidAssets: Array<{ id: string; reason: string }>,
): void {
  if (!entry) return;
  const metadata = entry.metadata as SourceAssetMetadata | undefined;
  if (entry.kind !== 'ktx2' || !/\.ktx2(?:$|[?#])/i.test(entry.url)) {
    invalidAssets.push({ id, reason: 'required texture must be a KTX2 asset' });
  }
  if (metadata?.compressed !== compression || metadata?.textureSemantic !== semantic) {
    invalidAssets.push({ id, reason: `requires ${compression} ${semantic} metadata` });
  }
}

function requireEntryCapabilities(
  entry: AssetManifestEntry | undefined,
  required: readonly string[],
  invalidAssets: Array<{ id: string; reason: string }>,
): void {
  if (!entry) return;
  const capabilities = new Set(metadataCapabilities(entry));
  for (const capability of required) {
    if (!capabilities.has(capability)) {
      invalidAssets.push({ id: entry.id, reason: `missing capability "${capability}"` });
    }
  }
}

function requireCapabilities(
  entries: readonly AssetManifestEntry[],
  required: readonly string[],
  group: RequiredSourceGroup,
  invalidAssets: Array<{ id: string; reason: string }>,
): void {
  const capabilities = new Set(entries.flatMap(metadataCapabilities));
  for (const capability of required) {
    if (!capabilities.has(capability)) {
      invalidAssets.push({ id: group, reason: `missing capability "${capability}"` });
    }
  }
}

function metadataCapabilities(entry: AssetManifestEntry): string[] {
  const capabilities = (entry.metadata as SourceAssetMetadata | undefined)?.capabilities;
  return Array.isArray(capabilities)
    ? capabilities.filter((value): value is string => typeof value === 'string')
    : [];
}

function sourceGroup(entry: AssetManifestEntry): RequiredSourceGroup | undefined {
  return (entry.metadata as SourceAssetMetadata | undefined)?.sourceGroup;
}

function isPlaceholder(value: string | undefined): boolean {
  return !value?.trim() || /replace_|placeholder|\btodo\b|\btbd\b/i.test(value);
}
