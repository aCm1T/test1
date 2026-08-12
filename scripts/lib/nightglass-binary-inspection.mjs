import fs from 'node:fs';

const GLB_MAGIC = 0x46546c67;
const JSON_CHUNK = 0x4e4f534a;
const BIN_CHUNK = 0x004e4942;
const KTX2_IDENTIFIER = Buffer.from([0xab, 0x4b, 0x54, 0x58, 0x20, 0x32, 0x30, 0xbb, 0x0d, 0x0a, 0x1a, 0x0a]);

export function readGlbDocument(file) {
  return parseGlb(fs.readFileSync(file));
}

export function parseGlb(buffer) {
  if (buffer.length < 20 || buffer.readUInt32LE(0) !== GLB_MAGIC) {
    throw new Error('not a binary glTF file');
  }
  if (buffer.readUInt32LE(4) !== 2) throw new Error('GLB version must be 2');
  if (buffer.readUInt32LE(8) !== buffer.length) throw new Error('GLB declared length does not match file');
  const chunkLength = buffer.readUInt32LE(12);
  const chunkType = buffer.readUInt32LE(16);
  if (chunkType !== JSON_CHUNK || 20 + chunkLength > buffer.length) {
    throw new Error('GLB has no valid leading JSON chunk');
  }
  const json = buffer.subarray(20, 20 + chunkLength).toString('utf8').replace(/[\u0000 ]+$/, '');
  const document = JSON.parse(json);
  let offset = 20 + chunkLength;
  let binaryLength = 0;
  while (offset + 8 <= buffer.length) {
    const length = buffer.readUInt32LE(offset);
    const type = buffer.readUInt32LE(offset + 4);
    if (offset + 8 + length > buffer.length) throw new Error('GLB chunk exceeds declared file length');
    if (type === BIN_CHUNK) binaryLength = Math.max(binaryLength, length);
    offset += 8 + length;
  }
  const embedded = (document.buffers ?? []).find((entry) => !entry.uri);
  if (embedded && (!binaryLength || binaryLength < embedded.byteLength)) {
    throw new Error('GLB embedded buffer has no complete BIN chunk');
  }
  return document;
}

export function inspectHeroDocument(document, options = {}) {
  const errors = [];
  const meshoptViews = (document.bufferViews ?? []).filter((view) => (
    view.extensions?.EXT_meshopt_compression
  ));
  if (meshoptViews.length === 0) {
    errors.push('does not contain EXT_meshopt_compression payloads');
  } else if (meshoptViews.some((view) => !validMeshoptPayload(view.extensions.EXT_meshopt_compression))) {
    errors.push('contains an invalid EXT_meshopt_compression payload');
  }
  const collisionMeshes = collisionMeshIndices(document);
  const primitives = (document.meshes ?? []).flatMap((mesh, meshIndex) => (
    collisionMeshes.has(meshIndex) ? [] : mesh.primitives ?? []
  ));
  if (primitives.length === 0) errors.push('contains no mesh primitives');
  for (const [index, primitive] of primitives.entries()) {
    const expectedTypes = {
      POSITION: 'VEC3',
      TEXCOORD_0: 'VEC2',
      TEXCOORD_1: 'VEC2',
      TANGENT: 'VEC4',
    };
    let positionCount = null;
    for (const [attribute, expectedType] of Object.entries(expectedTypes)) {
      const accessorIndex = primitive.attributes?.[attribute];
      if (!Number.isInteger(accessorIndex)) {
        errors.push(`primitive ${index} is missing ${attribute}`);
        continue;
      }
      const accessor = document.accessors?.[accessorIndex];
      if (!accessor || accessor.type !== expectedType || !Number.isInteger(accessor.count) || accessor.count < 1) {
        errors.push(`primitive ${index} has invalid ${attribute} accessor`);
        continue;
      }
      if (attribute === 'POSITION') positionCount = accessor.count;
      else if (positionCount !== null && accessor.count !== positionCount) {
        errors.push(`primitive ${index} ${attribute} count does not match POSITION`);
      }
    }
    const material = document.materials?.[primitive.material];
    if (!material?.pbrMetallicRoughness) errors.push(`primitive ${index} has no metal/rough PBR material`);
  }
  if (options.rigged && (!(document.skins?.length > 0) || !(document.nodes ?? []).some((node) => Number.isInteger(node.skin)))) {
    errors.push('contains no node-bound skin');
  }
  if (options.animationRoles) {
    const names = (document.animations ?? []).map((animation) => String(animation.name ?? '').toLowerCase());
    for (const [role, aliases] of Object.entries(options.animationRoles)) {
      if (!names.some((name) => aliases.some((alias) => name.includes(alias)))) {
        errors.push(`is missing animation role ${role}`);
      }
    }
  }
  if (options.adsMarker && !(document.nodes ?? []).some((node) => (
    String(node.name ?? '').toUpperCase() === 'ADS_RETICLE' || node.extras?.adsReticle === true
  ))) errors.push('is missing ADS_RETICLE node');
  if (options.gpuInstancing && !(document.nodes ?? []).some((node) => (
    node.extensions?.EXT_mesh_gpu_instancing
  ))) {
    errors.push('does not contain EXT_mesh_gpu_instancing');
  }
  return errors;
}

function validMeshoptPayload(payload) {
  return payload
    && Number.isInteger(payload.buffer)
    && payload.buffer >= 0
    && Number.isInteger(payload.byteLength)
    && payload.byteLength > 0
    && Number.isInteger(payload.byteStride)
    && payload.byteStride > 0
    && Number.isInteger(payload.count)
    && payload.count > 0
    && ['ATTRIBUTES', 'TRIANGLES', 'INDICES'].includes(payload.mode);
}

export function inspectGpuInstanceCategories(documents) {
  const categories = new Set();
  let nodes = 0;
  for (const document of documents) {
    for (const node of document.nodes ?? []) {
      if (!node.extensions?.EXT_mesh_gpu_instancing) continue;
      nodes += 1;
      const name = String(node.name ?? '').toLowerCase();
      if (/lamp|light/.test(name)) categories.add('lamps');
      if (/window|emissive/.test(name)) categories.add('windows');
      if (/debris|rubble|trash/.test(name)) categories.add('debris');
    }
  }
  return { nodes, categories: [...categories].sort() };
}

export function inspectRouteAnnotations(documents) {
  const nodes = documents.flatMap((document) => document.nodes ?? []);
  let collisionNodeCount = 0;
  let collisionMeshCount = 0;
  for (const document of documents) {
    const documentNodes = document.nodes ?? [];
    documentNodes.forEach((node, index) => {
      if (!(/^COLLIDER(?:[_:-]|$)/i.test(String(node.name ?? '')) || node.extras?.collision === true)) return;
      collisionNodeCount += 1;
      const meshIndices = nodeMeshIndices(documentNodes, index, new Set());
      if ([...meshIndices].some((meshIndex) => (
        (document.meshes?.[meshIndex]?.primitives ?? []).some((primitive) => (
          Number.isInteger(primitive.attributes?.POSITION)
        ))
      ))) collisionMeshCount += 1;
    });
  }
  const hasCollision = collisionNodeCount > 0;
  const navNodes = nodes.filter((node) => (
    /^NAV(?:[_:-]|$)/i.test(String(node.name ?? ''))
    || node.extras?.navigationNode === true
    || typeof node.extras?.navigationNode === 'string'
  ));
  const hasCover = nodes.some((node) => (
    /^COVER(?:[_:-]|$)/i.test(String(node.name ?? ''))
    || node.extras?.coverSlot === true
    || typeof node.extras?.coverSlot === 'string'
  ));
  const hasLinks = navNodes.some((node) => {
    const links = node.extras?.links ?? node.extras?.navigationLinks;
    return (Array.isArray(links) && links.length > 0) || (typeof links === 'string' && links.trim());
  });
  const materials = documents.flatMap((document) => document.materials ?? []);
  return {
    hasCollision,
    collisionNodeCount,
    collisionMeshCount,
    navigationNodeCount: navNodes.length,
    hasNavigationLinks: Boolean(hasLinks),
    hasCover,
    hasOcclusion: materials.some((material) => material.occlusionTexture),
    hasEmissive: materials.some((material) => (
      material.emissiveTexture
      || (material.emissiveFactor ?? []).some((value) => Number(value) > 0)
    )),
  };
}

function nodeMeshIndices(nodes, index, visited) {
  if (visited.has(index)) return new Set();
  visited.add(index);
  const node = nodes[index];
  const result = new Set();
  if (!node) return result;
  if (Number.isInteger(node.mesh)) result.add(node.mesh);
  for (const child of node.children ?? []) {
    if (!Number.isInteger(child)) continue;
    for (const meshIndex of nodeMeshIndices(nodes, child, visited)) result.add(meshIndex);
  }
  return result;
}

function collisionMeshIndices(document) {
  const result = new Set();
  const nodes = document.nodes ?? [];
  nodes.forEach((node, index) => {
    if (!(/^COLLIDER(?:[_:-]|$)/i.test(String(node.name ?? '')) || node.extras?.collision === true)) return;
    for (const meshIndex of nodeMeshIndices(nodes, index, new Set())) result.add(meshIndex);
  });
  return result;
}

export function inspectPbrTextureEvidence(documents) {
  const evidence = {
    albedo: false,
    normal: false,
    orm: false,
    emissive: false,
    nonBasisuRoles: [],
  };
  for (const document of documents) {
    for (const material of document.materials ?? []) {
      recordTextureRole(evidence, 'albedo', document, material.pbrMetallicRoughness?.baseColorTexture?.index);
      recordTextureRole(evidence, 'normal', document, material.normalTexture?.index);
      recordTextureRole(evidence, 'emissive', document, material.emissiveTexture?.index);
      const metalRough = material.pbrMetallicRoughness?.metallicRoughnessTexture?.index;
      const occlusion = material.occlusionTexture?.index;
      if (Number.isInteger(metalRough) && metalRough === occlusion) {
        recordTextureRole(evidence, 'orm', document, metalRough);
      }
    }
  }
  evidence.nonBasisuRoles = [...new Set(evidence.nonBasisuRoles)].sort();
  return evidence;
}

function recordTextureRole(evidence, role, document, textureIndex) {
  if (!Number.isInteger(textureIndex)) return;
  evidence[role] = true;
  const texture = document.textures?.[textureIndex];
  const source = texture?.extensions?.KHR_texture_basisu?.source;
  const image = Number.isInteger(source) ? document.images?.[source] : undefined;
  if (
    !Number.isInteger(source)
    || (!/\.ktx2(?:$|[?#])/i.test(String(image?.uri ?? '')) && image?.mimeType !== 'image/ktx2')
  ) evidence.nonBasisuRoles.push(role);
}

export function inspectKtx2File(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.length < 80 || !buffer.subarray(0, 12).equals(KTX2_IDENTIFIER)) {
    throw new Error('not a KTX2 file');
  }
  const dfdByteOffset = buffer.readUInt32LE(48);
  const dfdByteLength = buffer.readUInt32LE(52);
  if (dfdByteLength < 16 || dfdByteOffset + dfdByteLength > buffer.length) {
    throw new Error('KTX2 has no valid data-format descriptor');
  }
  return {
    vkFormat: buffer.readUInt32LE(12),
    pixelWidth: buffer.readUInt32LE(20),
    pixelHeight: buffer.readUInt32LE(24),
    faceCount: buffer.readUInt32LE(36),
    levelCount: buffer.readUInt32LE(40),
    supercompressionScheme: buffer.readUInt32LE(44),
    colorModel: buffer[dfdByteOffset + 12],
  };
}

export function sniffAudioFile(file) {
  const buffer = fs.readFileSync(file);
  if (buffer.subarray(0, 4).toString('ascii') === 'OggS') return 'ogg';
  if (buffer.subarray(0, 4).toString('ascii') === 'RIFF') return 'wav';
  if (buffer.subarray(0, 3).toString('ascii') === 'ID3') return 'mp3';
  if (buffer.length >= 2 && buffer[0] === 0xff && (buffer[1] & 0xe0) === 0xe0) return 'mp3';
  return null;
}

export function inspectImageFile(file) {
  const buffer = fs.readFileSync(file);
  const png = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  if (buffer.length >= 24 && buffer.subarray(0, 8).equals(png)) {
    return {
      format: 'png',
      width: buffer.readUInt32BE(16),
      height: buffer.readUInt32BE(20),
    };
  }
  if (buffer.length >= 4 && buffer[0] === 0xff && buffer[1] === 0xd8) {
    let offset = 2;
    while (offset + 3 < buffer.length) {
      if (buffer[offset] !== 0xff) {
        offset += 1;
        continue;
      }
      while (buffer[offset] === 0xff) offset += 1;
      const marker = buffer[offset];
      offset += 1;
      if (marker === 0xd8 || marker === 0xd9 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        continue;
      }
      if (offset + 1 >= buffer.length) break;
      const length = buffer.readUInt16BE(offset);
      if (length < 2 || offset + length > buffer.length) break;
      if (isJpegStartOfFrame(marker) && length >= 7) {
        return {
          format: 'jpeg',
          width: buffer.readUInt16BE(offset + 5),
          height: buffer.readUInt16BE(offset + 3),
        };
      }
      offset += length;
    }
    throw new Error('JPEG has no supported start-of-frame dimensions');
  }
  throw new Error('not a PNG or JPEG image');
}

function isJpegStartOfFrame(marker) {
  return marker >= 0xc0 && marker <= 0xcf
    && ![0xc4, 0xc8, 0xcc].includes(marker);
}
