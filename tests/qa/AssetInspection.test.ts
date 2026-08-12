import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  inspectHeroDocument,
  inspectGpuInstanceCategories,
  inspectImageFile,
  inspectKtx2File,
  inspectPbrTextureEvidence,
  inspectRouteAnnotations,
  parseGlb,
  sniffAudioFile,
} from '../../scripts/lib/nightglass-binary-inspection.mjs';
import { hasSuppliedFile } from '../../scripts/lib/nightglass-asset-contract.mjs';

describe('binary asset inspection', () => {
  it('reads GLB structure and verifies actual geometry, rig, clips, marker and instancing', () => {
    const document = validDocument();
    expect(parseGlb(glb(document))).toEqual(document);
    expect(inspectHeroDocument(document, {
      rigged: true,
      adsMarker: true,
      gpuInstancing: true,
      animationRoles: { idle: ['idle'], reload: ['reload'] },
    })).toEqual([]);
    expect(inspectGpuInstanceCategories([document])).toEqual({
      nodes: 3,
      categories: ['debris', 'lamps', 'windows'],
    });

    const invalid = structuredClone(document);
    delete invalid.meshes[0].primitives[0].attributes.TANGENT;
    expect(inspectHeroDocument(invalid)).toContain('primitive 0 is missing TANGENT');
    const declaredOnly = structuredClone(document);
    delete declaredOnly.bufferViews[0].extensions;
    expect(inspectHeroDocument(declaredOnly)).toContain(
      'does not contain EXT_meshopt_compression payloads',
    );
  });

  it('extracts collision/navigation/cover/AO/emissive evidence from GLB JSON', () => {
    expect(inspectRouteAnnotations([validDocument()])).toEqual({
      hasCollision: true,
      collisionNodeCount: 1,
      collisionMeshCount: 1,
      navigationNodeCount: 2,
      hasNavigationLinks: true,
      hasCover: true,
      hasOcclusion: true,
      hasEmissive: true,
    });
    expect(inspectPbrTextureEvidence([validDocument()])).toEqual({
      albedo: true,
      normal: true,
      orm: true,
      emissive: true,
      nonBasisuRoles: [],
    });
  });

  it('distinguishes KTX2 supercompression and supported audio headers', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-binary-'));
    const ktx = Buffer.alloc(96);
    Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]).copy(ktx);
    ktx.writeUInt32LE(256, 20);
    ktx.writeUInt32LE(256, 24);
    ktx.writeUInt32LE(1, 36);
    ktx.writeUInt32LE(8, 40);
    ktx.writeUInt32LE(1, 44);
    ktx.writeUInt32LE(80, 48);
    ktx.writeUInt32LE(16, 52);
    ktx.writeUInt32LE(16, 80);
    ktx[92] = 163;
    const ktxFile = path.join(root, 'albedo.ktx2');
    writeFileSync(ktxFile, ktx);
    expect(inspectKtx2File(ktxFile)).toMatchObject({
      pixelWidth: 256,
      pixelHeight: 256,
      levelCount: 8,
      supercompressionScheme: 1,
      colorModel: 163,
    });
    const ogg = path.join(root, 'shot.ogg');
    writeFileSync(ogg, Buffer.from('OggS-test'));
    expect(sniffAudioFile(ogg)).toBe('ogg');

    const png = Buffer.alloc(24);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1920, 16);
    png.writeUInt32BE(1080, 20);
    const pngFile = path.join(root, 'reference.png');
    writeFileSync(pngFile, png);
    expect(inspectImageFile(pngFile)).toEqual({
      format: 'png',
      width: 1920,
      height: 1080,
    });
  });
});

describe('source payload supply detection', () => {
  it('ignores README, .gitkeep, empty files, and non-payload extensions', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-source-'));
    writeFileSync(path.join(root, 'README.md'), '# placeholder docs');
    writeFileSync(path.join(root, 'readme.txt'), 'notes');
    writeFileSync(path.join(root, '.gitkeep'), '');
    writeFileSync(path.join(root, 'empty.png'), Buffer.alloc(0));
    writeFileSync(path.join(root, 'notes.txt'), 'not a payload');
    expect(hasSuppliedFile(root)).toBe(false);

    writeFileSync(path.join(root, 'hero.glb'), Buffer.from('mesh'));
    expect(hasSuppliedFile(root)).toBe(true);
  });

  it('does not treat sidecar .json as a supplied media payload', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'nightglass-source-json-'));
    writeFileSync(path.join(root, 'meta.json'), JSON.stringify({ note: 'not media' }));
    expect(hasSuppliedFile(root)).toBe(false);

    writeFileSync(path.join(root, 'hero.ktx2'), Buffer.from('ktx2'));
    expect(hasSuppliedFile(root)).toBe(true);
  });
});

function validDocument(): Record<string, any> {
  return {
    asset: { version: '2.0' },
    extensionsUsed: ['EXT_meshopt_compression', 'EXT_mesh_gpu_instancing'],
    meshes: [
      { primitives: [{
        attributes: { POSITION: 0, TEXCOORD_0: 1, TEXCOORD_1: 2, TANGENT: 3 },
        material: 0,
        extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } },
      }] },
      { primitives: [{ attributes: { POSITION: 0 } }] },
    ],
    materials: [{
      pbrMetallicRoughness: {
        baseColorTexture: { index: 0 },
        metallicRoughnessTexture: { index: 2 },
      },
      normalTexture: { index: 1 },
      occlusionTexture: { index: 2, texCoord: 1 },
      emissiveTexture: { index: 3 },
      emissiveFactor: [1, 0.5, 0.1],
    }],
    textures: [0, 1, 2, 3].map((source) => ({
      extensions: { KHR_texture_basisu: { source } },
    })),
    images: [0, 1, 2, 3].map((index) => ({ uri: `texture-${index}.ktx2` })),
    skins: [{ joints: [0] }],
    accessors: [
      { type: 'VEC3', count: 3 },
      { type: 'VEC2', count: 3 },
      { type: 'VEC2', count: 3 },
      { type: 'VEC4', count: 3 },
    ],
    nodes: [
      { name: 'Armature', skin: 0 },
      { name: 'ADS_RETICLE' },
      { name: 'COLLIDER_wall', mesh: 1, extras: { collision: true } },
      { name: 'NAV_south', extras: { navigationNode: 'south', links: ['north'] } },
      { name: 'NAV_north', extras: { navigationNode: 'north' } },
      { name: 'COVER_crate', extras: { coverSlot: 'crate' } },
      { name: 'LAMP_instances', extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } },
      { name: 'WINDOW_instances', extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } },
      { name: 'DEBRIS_instances', extensions: { EXT_mesh_gpu_instancing: { attributes: { TRANSLATION: 4 } } } },
    ],
    animations: [{ name: 'idle' }, { name: 'reload' }],
    buffers: [{ byteLength: 16 }],
    bufferViews: [{ extensions: { EXT_meshopt_compression: {
      buffer: 0,
      byteLength: 16,
      byteStride: 12,
      count: 3,
      mode: 'ATTRIBUTES',
    } } }],
  };
}

function glb(document: unknown): Buffer {
  const source = Buffer.from(JSON.stringify(document));
  const paddedLength = Math.ceil(source.length / 4) * 4;
  const binaryLength = 16;
  const buffer = Buffer.alloc(20 + paddedLength + 8 + binaryLength, 0x20);
  buffer.writeUInt32LE(0x46546c67, 0);
  buffer.writeUInt32LE(2, 4);
  buffer.writeUInt32LE(buffer.length, 8);
  buffer.writeUInt32LE(paddedLength, 12);
  buffer.writeUInt32LE(0x4e4f534a, 16);
  source.copy(buffer, 20);
  const binaryOffset = 20 + paddedLength;
  buffer.writeUInt32LE(binaryLength, binaryOffset);
  buffer.writeUInt32LE(0x004e4942, binaryOffset + 4);
  buffer.fill(0, binaryOffset + 8);
  return buffer;
}
