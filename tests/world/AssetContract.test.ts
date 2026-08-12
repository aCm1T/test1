import { describe, expect, it } from 'vitest';
import {
  REQUIRED_SOURCE_GROUPS,
  MIN_REFERENCE_CAPTURES,
  NIGHTGLASS_AUDIO_ASSET_IDS,
  NIGHTGLASS_AUDIO_CAPABILITIES,
  NIGHTGLASS_CHARACTER_ASSET_IDS,
  NIGHTGLASS_CHARACTER_CAPABILITIES,
  NIGHTGLASS_ENVIRONMENT_CAPABILITIES,
  NIGHTGLASS_LIGHTING_ASSET_IDS,
  NIGHTGLASS_LIGHTMAP_ASSET_IDS,
  NIGHTGLASS_ROUTE_ASSET_IDS,
  NIGHTGLASS_TEXTURE_ASSET_IDS,
  NIGHTGLASS_VIEWMODEL_ASSET_ID,
  NIGHTGLASS_VIEWMODEL_CAPABILITIES,
  MAX_COMPRESSED_PAYLOAD_BYTES,
  validateNightglassAssetContract,
  type RequiredSourceGroup,
} from '../../src/world';
import type { AssetManifest, AssetManifestEntry } from '../../src/engine';
import { NIGHTGLASS_RUNTIME_ASSET_IDS as SCRIPT_RUNTIME_ASSET_IDS } from '../../scripts/lib/nightglass-asset-contract.mjs';
import { NIGHTGLASS_RUNTIME_ASSET_IDS } from '../../src/world/AssetContract.ts';

const LICENSE = { name: 'Licensed for browser distribution', source: 'license-record.md' };
const PROVENANCE = {
  sourceRecord: 'source-record.md',
  licenseRecord: 'license-record.md',
};
const MESH = { uv0: true, uv1: true, tangents: true, pbrMetalRough: true };

describe('NIGHTGLASS asset contract', () => {
  it('keeps browser and Node release tooling on the same runtime ID contract', () => {
    expect([...SCRIPT_RUNTIME_ASSET_IDS]).toEqual([...NIGHTGLASS_RUNTIME_ASSET_IDS]);
  });

  it('blocks release when the supplied source groups are absent', () => {
    const report = validateNightglassAssetContract({ version: '1', assets: [] });
    expect(report.valid).toBe(false);
    expect(report.missingGroups).toEqual([...REQUIRED_SOURCE_GROUPS]);
  });

  it('accepts only the complete licensed runtime and matched-reference package', () => {
    expect(validateNightglassAssetContract(validManifest())).toMatchObject({
      valid: true,
      missingGroups: [],
      invalidAssets: [],
    });
  });

  it('rejects an incomplete authored animation set', () => {
    const manifest = validManifest();
    const viewmodel = manifest.assets.find((entry) => entry.id === NIGHTGLASS_VIEWMODEL_ASSET_ID)!;
    const capabilities = (viewmodel.metadata?.capabilities as string[])
      .filter((capability) => capability !== 'melee');
    const assets = manifest.assets.map((entry) => entry.id === viewmodel.id
      ? { ...entry, metadata: { ...entry.metadata, capabilities } }
      : entry);
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.valid).toBe(false);
    expect(report.invalidAssets).toContainEqual({
      id: NIGHTGLASS_VIEWMODEL_ASSET_ID,
      reason: 'missing capability "melee"',
    });
  });

  it('rejects hero geometry without the required Meshopt and vertex contract', () => {
    const manifest = validManifest();
    const target = NIGHTGLASS_CHARACTER_ASSET_IDS[0];
    const assets = manifest.assets.map((entry) => entry.id === target
      ? {
          ...entry,
          metadata: {
            ...entry.metadata,
            compressed: 'meshopt-glb',
            mesh: { ...MESH, tangents: false },
          },
        }
      : entry);
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.valid).toBe(false);
    expect(report.invalidAssets.some(({ id, reason }) => (
      id === target && reason.includes('UV0, UV1, tangents')
    ))).toBe(true);
  });

  it('rejects placeholders and the wrong KTX2 compression family', () => {
    const manifest = validManifest();
    const assets = manifest.assets.map((entry) => entry.id === 'hero-albedo'
      ? {
          ...entry,
          license: { name: 'REPLACE_WITH_LICENSE' },
          metadata: { ...entry.metadata, compressed: 'ktx2-uastc' },
        }
      : entry);
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.valid).toBe(false);
    expect(report.invalidAssets.some(({ id, reason }) => (
      id === 'hero-albedo' && reason.includes('placeholder license')
    ))).toBe(true);
    expect(report.invalidAssets.some(({ id, reason }) => (
      id === 'hero-albedo' && reason.includes('ktx2-etc1s albedo')
    ))).toBe(true);
  });

  it('enforces the compressed full-slice payload budget', () => {
    const manifest = validManifest();
    const assets = manifest.assets.map((entry) => entry.id === NIGHTGLASS_ROUTE_ASSET_IDS[0]
      ? { ...entry, bytes: MAX_COMPRESSED_PAYLOAD_BYTES + 1 }
      : entry);
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.invalidAssets.some(({ id }) => id === 'runtime-payload')).toBe(true);
  });

  it('requires every runtime contract entry to be release-required', () => {
    const manifest = validManifest();
    const target = NIGHTGLASS_ROUTE_ASSET_IDS[0];
    const assets = manifest.assets.map((entry) => entry.id === target
      ? { ...entry, required: false }
      : entry);
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.invalidAssets).toContainEqual({
      id: target,
      reason: 'runtime asset must be marked required',
    });
  });

  it('rejects matched references that omit captureScenario', () => {
    const manifest = validManifest();
    const assets = manifest.assets.map((entry) => {
      if (entry.metadata?.sourceGroup !== 'references') return entry;
      const reference = { ...(entry.metadata.reference as Record<string, unknown>) };
      delete reference.captureScenario;
      return { ...entry, metadata: { ...entry.metadata, reference } };
    });
    const report = validateNightglassAssetContract({ ...manifest, assets });
    expect(report.valid).toBe(false);
    expect(report.invalidAssets.some(({ reason }) => (
      reason === 'reference metadata is incomplete'
    ))).toBe(true);
  });
});

function validManifest(): AssetManifest {
  const environmentCapabilities = [...NIGHTGLASS_ENVIRONMENT_CAPABILITIES];
  const route = NIGHTGLASS_ROUTE_ASSET_IDS.map((id, index) => gltfEntry(
    id,
    'environment',
    index === 0 ? environmentCapabilities : [],
  ));
  const viewmodel = gltfEntry(
    NIGHTGLASS_VIEWMODEL_ASSET_ID,
    'viewmodel',
    NIGHTGLASS_VIEWMODEL_CAPABILITIES,
  );
  const characters = NIGHTGLASS_CHARACTER_ASSET_IDS.map((id) => gltfEntry(
    id,
    'characters',
    NIGHTGLASS_CHARACTER_CAPABILITIES,
  ));
  const textureRules = new Map<string, ['ktx2-uastc' | 'ktx2-etc1s', string]>([
    [NIGHTGLASS_LIGHTING_ASSET_IDS[0], ['ktx2-uastc', 'hdr']],
    [NIGHTGLASS_LIGHTING_ASSET_IDS[1], ['ktx2-uastc', 'reflection-probe']],
    [NIGHTGLASS_LIGHTING_ASSET_IDS[2], ['ktx2-uastc', 'reflection-probe']],
    [NIGHTGLASS_TEXTURE_ASSET_IDS[0], ['ktx2-uastc', 'normal']],
    [NIGHTGLASS_TEXTURE_ASSET_IDS[1], ['ktx2-uastc', 'orm']],
    [NIGHTGLASS_TEXTURE_ASSET_IDS[2], ['ktx2-etc1s', 'albedo']],
    [NIGHTGLASS_TEXTURE_ASSET_IDS[3], ['ktx2-etc1s', 'emissive']],
    ...NIGHTGLASS_LIGHTMAP_ASSET_IDS.map((id) => [id, ['ktx2-etc1s', 'lightmap']] as const),
  ]);
  const textures = [...textureRules].map(([id, [compressed, textureSemantic]]) => ({
    id,
    kind: 'ktx2' as const,
    required: true,
    url: `environment/${id}.ktx2`,
    bytes: 1024,
    license: LICENSE,
    metadata: {
      sourceGroup: 'environment',
      ...PROVENANCE,
      compressed,
      textureSemantic,
    },
  }));
  const audioCapabilities = new Map<string, string[]>([
    ['weapon-ar-fire', ['weapon-layers']],
    ['weapon-ar-mechanical', ['weapon-layers']],
    ['weapon-reload', ['weapon-reload']],
    ['footsteps-concrete', ['footsteps-concrete']],
    ['footsteps-dirt', ['footsteps-dirt']],
    ['footsteps-metal', ['footsteps-metal']],
    ['impact-concrete', ['impacts']],
    ['ambience-dusk', ['ambience']],
    ['ui-confirm', ['ui']],
    ['indoor-tail', ['indoor-tail']],
    ['outdoor-tail', ['outdoor-tail']],
  ]);
  const audio = NIGHTGLASS_AUDIO_ASSET_IDS.map((id) => ({
    id,
    kind: 'audio' as const,
    required: true,
    url: `audio/${id}.ogg`,
    bytes: 1024,
    license: LICENSE,
    metadata: {
      sourceGroup: 'audio',
      ...PROVENANCE,
      compressed: 'audio',
      capabilities: audioCapabilities.get(id),
    },
  }));
  expect(new Set(audio.flatMap((entry) => entry.metadata.capabilities))).toEqual(
    new Set(NIGHTGLASS_AUDIO_CAPABILITIES),
  );
  const references = Array.from({ length: MIN_REFERENCE_CAPTURES }, (_, index) => ({
    id: `reference-${index + 1}`,
    kind: 'image' as const,
    url: `references/reference-${index + 1}.png`,
    license: LICENSE,
    metadata: {
      sourceGroup: 'references',
      ...PROVENANCE,
      reference: {
        fov: 90,
        width: 1920,
        height: 1080,
        sceneType: 'intersection',
        captureScenario: 'intersection',
        crop: { x: 0, y: 0, width: 1920, height: 1080 },
      },
    },
  }));
  return {
    version: '1',
    assets: [...route, viewmodel, ...characters, ...textures, ...audio, ...references],
  };
}

function gltfEntry(
  id: string,
  sourceGroup: RequiredSourceGroup,
  capabilities: readonly string[],
): AssetManifestEntry {
  return {
    id,
    kind: 'gltf',
    required: true,
    url: `${sourceGroup}/${id}.meshopt.glb`,
    bytes: 1024,
    license: LICENSE,
    metadata: {
      sourceGroup,
      ...PROVENANCE,
      compressed: 'meshopt-glb',
      capabilities: [...capabilities],
      mesh: MESH,
    },
  };
}
