import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Procedural content in this project is authored as deep hierarchies of small
 * meshes, which reads well but submits one draw per piece. These helpers bake
 * the static parts of such a hierarchy into merged geometry while leaving every
 * node that is animated, toggled, or otherwise addressed at runtime untouched.
 */
export interface StaticBatchOptions {
  /**
   * Nodes that must keep their own transform. Callers use this for anything an
   * update loop animates; named nodes are the usual convention.
   */
  isPivot?: (node: THREE.Object3D) => boolean;
  /**
   * Equivalent cube edge under which a merged piece counts as trim. Batches
   * made entirely of trim are tagged so a caller can drop them at distance.
   */
  trimExtent?: number;
  /** userData key written on trim-only batches. */
  trimFlag?: string;
  /**
   * Equivalent cube edge a batch's largest piece must reach to keep rendering
   * into the shadow map. The shadow pass costs one submission per caster, and
   * small hardware sits inside a silhouette something else already casts.
   */
  shadowExtent?: number;
  /** Prefix for generated batch mesh names. */
  namePrefix?: string;
  /**
   * Merges pieces that differ only by flat colour, roughness and metalness into
   * one batch. Those three values are baked per vertex and read back in the
   * shader, so the merged surface shades exactly as the separate materials did
   * while costing a single submission. Only untextured standard materials
   * qualify this way; textured ones need a {@link SurfaceFamily}.
   */
  unifyPlainMaterials?: boolean;
  /**
   * Texture sets whose members merge together. A mapped surface cannot bake its
   * albedo into vertex data, so the only way it shares a submission with its
   * neighbours is to share their textures; a family declares one such set and
   * absorbs every material that samples it. Untextured pieces join the first
   * family listed, because a family member can mix its maps out per vertex.
   */
  surfaceFamilies?: readonly SurfaceFamily[];
}

export interface StaticBatchResult {
  /** Meshes that no longer exist as independent draw submissions. */
  collapsed: number;
  /** Merged meshes created to replace them. */
  batches: THREE.Mesh[];
}

interface Bucket {
  material: THREE.Material;
  castShadow: boolean;
  receiveShadow: boolean;
  renderOrder: number;
  frustumCulled: boolean;
  trim: boolean;
  /** Largest equivalent edge among this bucket's pieces. */
  maxEdge: number;
  /** True once anything other than the pivot's own geometry lands here. */
  merged: boolean;
  geometries: THREE.BufferGeometry[];
}

const _size = new THREE.Vector3();

/**
 * Texture slots a shared surface cannot account for. Any of these keeps a
 * material on its own batch.
 */
const UNSHAREABLE_MAPS = [
  'alphaMap',
  'aoMap',
  'bumpMap',
  'displacementMap',
  'emissiveMap',
  'envMap',
  'lightMap',
  'metalnessMap',
] as const;

/** Pixel store two textures share when one is a view of the other. */
type TextureSource = THREE.Texture['source'];

/** Texture sets a family shares with its members. */
export interface SurfaceFamilyTextures {
  map?: THREE.Texture | null;
  roughnessMap?: THREE.Texture | null;
  normalMap?: THREE.Texture | null;
  /** Required alongside `normalMap`; a member must match it exactly. */
  normalScale?: THREE.Vector2 | null;
}

/** What a member contributes that the shared material cannot hold. */
interface SurfaceMember {
  color: THREE.Color;
  /** Emissive radiance, intensity already folded in as the uniform would. */
  emissive: THREE.Color;
  roughness: number;
  metalness: number;
  /** 1 when the member sampled the family albedo, 0 when it was flat. */
  albedoMix: number;
  /** 1 when the member sampled the family roughness, 0 when it was flat. */
  roughnessMix: number;
  /** Tiles per UV unit, which the merge bakes into the geometry. */
  repeatX: number;
  repeatY: number;
}

function isUnifiableStandard(
  material: THREE.Material,
): material is THREE.MeshStandardMaterial {
  const standard = material as THREE.MeshStandardMaterial & { isMeshPhysicalMaterial?: boolean };
  if (!standard.isMeshStandardMaterial || standard.isMeshPhysicalMaterial) return false;
  if (standard.vertexColors || standard.wireframe) return false;
  return UNSHAREABLE_MAPS.every((slot) => !standard[slot]);
}

/**
 * Tiling is the only texture transform a merge can bake into UVs, so a rotated
 * or offset map has to keep its own material.
 */
function isTiledIdentity(texture: THREE.Texture): boolean {
  return texture.offset.x === 0
    && texture.offset.y === 0
    && texture.rotation === 0
    && texture.center.x === 0
    && texture.center.y === 0
    && texture.wrapS === THREE.RepeatWrapping
    && texture.wrapT === THREE.RepeatWrapping;
}

/**
 * A member's tiling lives in the merged UVs, so the shared material has to
 * sample the texture untransformed or the tiling would apply twice.
 */
function identityView(texture: THREE.Texture | null | undefined): THREE.Texture | null {
  if (!texture) return null;
  const view = texture.clone();
  view.name = `${texture.name || 'Surface'}:Shared`;
  view.repeat.set(1, 1);
  view.offset.set(0, 0);
  view.center.set(0, 0);
  view.rotation = 0;
  return view;
}

/** Everything a shared surface cannot bake into vertex data. */
function surfaceStateKey(material: THREE.MeshStandardMaterial): string {
  return [
    material.side,
    material.shadowSide ?? -1,
    material.transparent ? 1 : 0,
    material.opacity,
    material.depthWrite ? 1 : 0,
    material.depthTest ? 1 : 0,
    material.blending,
    material.flatShading ? 1 : 0,
    material.alphaTest,
    material.toneMapped ? 1 : 0,
    material.fog ? 1 : 0,
    material.envMapIntensity,
    material.aoMapIntensity,
    material.dithering ? 1 : 0,
  ].join('~');
}

/**
 * Patches the standard shader to read the three baked channels instead of the
 * material's own uniforms, and to mix each map out where a member had none.
 * Every guard the stock chunks carry is preserved, so a family works the same
 * whether or not it declares a given texture.
 */
function bindBakedSurface(shader: { vertexShader: string; fragmentShader: string }): void {
  shader.vertexShader = `attribute vec4 aSurface;\nattribute vec3 aEmissive;\nvarying vec4 vSurface;\nvarying vec3 vEmissive;\n${
    shader.vertexShader.replace(
      '#include <begin_vertex>',
      '#include <begin_vertex>\n  vSurface = aSurface;\n  vEmissive = aEmissive;',
    )
  }`;
  shader.fragmentShader = `varying vec4 vSurface;\nvarying vec3 vEmissive;\n${
    shader.fragmentShader
      .replace('#include <emissivemap_fragment>', 'totalEmissiveRadiance = vEmissive;')
      .replace(
        '#include <map_fragment>',
        `#ifdef USE_MAP
  diffuseColor *= mix( vec4( 1.0 ), texture2D( map, vMapUv ), vSurface.z );
#endif`,
      )
      .replace(
        '#include <roughnessmap_fragment>',
        `float roughnessFactor = vSurface.x;
#ifdef USE_ROUGHNESSMAP
  roughnessFactor *= mix( 1.0, texture2D( roughnessMap, vRoughnessMapUv ).g, vSurface.w );
#endif`,
      )
      .replace('#include <metalnessmap_fragment>', 'float metalnessFactor = vSurface.y;')
  }`;
}

/** Compile hooks owned by {@link SurfaceFamily.materialFor}, keyed by material. */
const surfaceCompileHooks = new WeakMap<
  THREE.Material,
  {
    compile: typeof bindBakedSurface;
    cacheKey: () => string;
  }
>();

/**
 * A texture set several materials share so their geometry can merge into one
 * submission.
 *
 * Batching mapped surfaces is otherwise impossible: flat colour, roughness and
 * metalness bake into vertex attributes, but an albedo map cannot, so two
 * pieces can only share a draw if they sample the same textures. A family
 * declares one such set and absorbs every material that samples it, keeping
 * each member's own tint, roughness, metalness and tiling. Members that carry
 * no maps join too and mix the family's textures out per vertex.
 */
export class SurfaceFamily {
  readonly name: string;
  /** Untransformed views the shared materials sample. */
  map: THREE.Texture | null;
  readonly roughnessMap: THREE.Texture | null;
  readonly normalMap: THREE.Texture | null;
  readonly normalScale: THREE.Vector2 | null;

  private readonly albedoSource: TextureSource | null;
  private readonly roughnessSource: TextureSource | null;
  private readonly normalSource: TextureSource | null;
  private readonly shared = new Map<string, THREE.MeshStandardMaterial>();

  constructor(name: string, textures: SurfaceFamilyTextures = {}) {
    this.name = name;
    this.map = identityView(textures.map);
    this.roughnessMap = identityView(textures.roughnessMap);
    this.normalMap = identityView(textures.normalMap);
    this.normalScale = textures.normalScale ? textures.normalScale.clone() : null;
    this.albedoSource = textures.map?.source ?? null;
    this.roughnessSource = textures.roughnessMap?.source ?? null;
    this.normalSource = textures.normalMap?.source ?? null;
  }

  /** True when membership depends on the merged geometry carrying UVs. */
  get textured(): boolean {
    return this.map !== null || this.roughnessMap !== null || this.normalMap !== null;
  }

  /**
   * Replaces the shared albedo on the family and every batch already built from
   * it. This is how an optional albedo installed after the geometry was merged
   * still reaches its surfaces.
   */
  setAlbedo(texture: THREE.Texture | null): void {
    this.map = identityView(texture);
    for (const material of this.shared.values()) {
      material.map = this.map;
      material.needsUpdate = true;
    }
  }

  /**
   * Tints every batch of the family on top of its members' baked colours. A
   * replacement albedo needs this: the baked colours were measured against the
   * generated one, so a source with a different overall level has to be lifted
   * or dropped back to where the family reads correctly.
   */
  setTint(color: THREE.ColorRepresentation): void {
    for (const material of this.shared.values()) material.color.set(color);
  }

  /** Shading values `material` contributes, or null when it cannot join. */
  member(material: THREE.Material): SurfaceMember | null {
    if (!isUnifiableStandard(material)) return null;
    let repeatX = 1;
    let repeatY = 1;
    let tiled = false;
    // Returns the per-vertex mix for one slot: 1 when the member samples the
    // family's texture there, 0 when it is flat, null when it cannot join.
    const slot = (
      texture: THREE.Texture | null,
      source: TextureSource | null,
    ): number | null => {
      if (!texture) return 0;
      if (!source || texture.source !== source || !isTiledIdentity(texture)) return null;
      if (tiled && (texture.repeat.x !== repeatX || texture.repeat.y !== repeatY)) return null;
      repeatX = texture.repeat.x;
      repeatY = texture.repeat.y;
      tiled = true;
      return 1;
    };

    const albedoMix = slot(material.map, this.albedoSource);
    if (albedoMix === null) return null;
    const roughnessMix = slot(material.roughnessMap, this.roughnessSource);
    if (roughnessMix === null) return null;
    // Normals perturb the shading frame itself, which no per-vertex mix can
    // undo, so a family and its members have to agree on them exactly.
    const normalMix = slot(material.normalMap, this.normalSource);
    if (normalMix === null || (this.normalMap !== null) !== (normalMix === 1)) return null;
    if (this.normalScale && !this.normalScale.equals(material.normalScale)) return null;

    return {
      color: material.color,
      emissive: material.emissive.clone().multiplyScalar(material.emissiveIntensity),
      roughness: material.roughness,
      metalness: material.metalness,
      albedoMix,
      roughnessMix,
      repeatX,
      repeatY,
    };
  }

  /** Identity of the batch a member belongs to, including its render state. */
  bucketKey(material: THREE.MeshStandardMaterial): string {
    return `${this.name}~${surfaceStateKey(material)}`;
  }

  /** The shared material for a member's render state, created on first use. */
  materialFor(source: THREE.MeshStandardMaterial): THREE.MeshStandardMaterial {
    const key = this.bucketKey(source);
    const cached = this.shared.get(key);
    if (cached) return cached;

    const material = new THREE.MeshStandardMaterial({
      color: 0xffffff,
      vertexColors: true,
      roughness: 1,
      metalness: 0,
      side: source.side,
      transparent: source.transparent,
      opacity: source.opacity,
      depthWrite: source.depthWrite,
      depthTest: source.depthTest,
      blending: source.blending,
      flatShading: source.flatShading,
      alphaTest: source.alphaTest,
      toneMapped: source.toneMapped,
      fog: source.fog,
      envMapIntensity: source.envMapIntensity,
      dithering: source.dithering,
    });
    material.shadowSide = source.shadowSide;
    material.map = this.map;
    material.roughnessMap = this.roughnessMap;
    material.normalMap = this.normalMap;
    if (this.normalScale) material.normalScale.copy(this.normalScale);
    material.name = `BatchedSurface:${this.name}`;
    // Remember the bake hook so CSM / fog wrappers that replace onBeforeCompile
    // (Three's CSM does not chain) can restore it before re-wrapping.
    const cacheKey = () => `nightglass-batched-surface-${key}`;
    material.onBeforeCompile = bindBakedSurface;
    material.customProgramCacheKey = cacheKey;
    surfaceCompileHooks.set(material, { compile: bindBakedSurface, cacheKey });
    this.shared.set(key, material);
    return material;
  }
}

/**
 * Fallback for callers that only want untextured pieces merged. It is shared
 * process-wide because a flat surface carries nothing a caller could own.
 */
const PLAIN_FAMILY = new SurfaceFamily('plain');

/**
 * Restores a batched surface's bake shader after CSM (or anything else) wiped
 * `onBeforeCompile`. Returns false when the material is not a family batch.
 */
export function bindSurfaceFamilyCompile(material: THREE.Material): boolean {
  const hook = surfaceCompileHooks.get(material);
  if (!hook) return false;
  material.onBeforeCompile = hook.compile;
  material.customProgramCacheKey = hook.cacheKey;
  return true;
}

/**
 * Resolves the shared material + bake step a static piece should use. Callers
 * that stage geometry flat (the procedural arena) use this instead of
 * {@link collapseStaticSubtrees}; both paths share the same family rules.
 */
export function createSurfaceBatchResolver(options: {
  unifyPlainMaterials?: boolean;
  surfaceFamilies?: readonly SurfaceFamily[];
  /**
   * When set, untextured pieces stay on the plain family instead of joining the
   * first mapped family. The arena wants that so trim/paint do not inherit a
   * tarp/camo shader; characters want the opposite so kit trim folds into cloth.
   */
  preferPlainFamily?: boolean;
} = {}): {
  resolve: (material: THREE.Material) => {
    material: THREE.Material;
    identity: string;
    bake: (geometry: THREE.BufferGeometry) => void;
  };
} {
  const mapped = [...(options.surfaceFamilies ?? [])];
  const families = options.unifyPlainMaterials
    ? (options.preferPlainFamily ? [PLAIN_FAMILY, ...mapped] : [...mapped, PLAIN_FAMILY])
    : mapped;

  return {
    resolve(material: THREE.Material) {
      for (const family of families) {
        const member = family.member(material);
        if (!member) continue;
        const standard = material as THREE.MeshStandardMaterial;
        return {
          material: family.materialFor(standard),
          identity: family.bucketKey(standard),
          bake: (geometry: THREE.BufferGeometry) => bakeSurface(geometry, member, family),
        };
      }
      return {
        material,
        identity: material.uuid,
        bake: () => undefined,
      };
    },
  };
}

/** Writes a member's shading values into vertex attributes and its tiling into UVs. */
function bakeSurface(
  geometry: THREE.BufferGeometry,
  member: SurfaceMember,
  family: SurfaceFamily,
): void {
  const count = geometry.attributes.position.count;
  const colors = new Float32Array(count * 3);
  const emissive = new Float32Array(count * 3);
  const surface = new Float32Array(count * 4);
  const { r, g, b } = member.color;
  for (let i = 0; i < count; i += 1) {
    colors[i * 3] = r;
    colors[i * 3 + 1] = g;
    colors[i * 3 + 2] = b;
    emissive[i * 3] = member.emissive.r;
    emissive[i * 3 + 1] = member.emissive.g;
    emissive[i * 3 + 2] = member.emissive.b;
    surface[i * 4] = member.roughness;
    surface[i * 4 + 1] = member.metalness;
    surface[i * 4 + 2] = member.albedoMix;
    surface[i * 4 + 3] = member.roughnessMix;
  }
  geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
  geometry.setAttribute('aEmissive', new THREE.BufferAttribute(emissive, 3));
  geometry.setAttribute('aSurface', new THREE.BufferAttribute(surface, 4));
  if (!family.textured) return;

  const uv = geometry.attributes.uv as THREE.BufferAttribute | undefined;
  if (!uv) {
    // The family samples textures, so every member of it has to agree on a UV
    // layout even where the source geometry had none.
    geometry.setAttribute('uv', new THREE.BufferAttribute(new Float32Array(count * 2), 2));
    return;
  }
  if (member.repeatX === 1 && member.repeatY === 1) return;
  for (let i = 0; i < count; i += 1) {
    uv.setXY(i, uv.getX(i) * member.repeatX, uv.getY(i) * member.repeatY);
  }
  uv.needsUpdate = true;
}

/** Merging needs one consistent vertex layout across a bucket. */
function flatten(geometry: THREE.BufferGeometry): THREE.BufferGeometry {
  const flat = geometry.index ? geometry.toNonIndexed() : geometry.clone();
  for (const name of Object.keys(flat.attributes)) {
    if (name !== 'position' && name !== 'normal' && name !== 'uv') flat.deleteAttribute(name);
  }
  flat.clearGroups();
  flat.morphAttributes = {};
  return flat;
}

/**
 * Edge length of the cube with the same volume as the geometry's bounds. It is
 * a better "how big does this read" measure than any single axis, which flat
 * panels and thin rails would otherwise fail.
 */
export function equivalentEdge(geometry: THREE.BufferGeometry): number {
  geometry.computeBoundingBox();
  if (!geometry.boundingBox) return Infinity;
  geometry.boundingBox.getSize(_size);
  return Math.cbrt(
    Math.max(_size.x, 1e-4) * Math.max(_size.y, 1e-4) * Math.max(_size.z, 1e-4),
  );
}

/**
 * Plain meshes and grouping nodes can be folded away. A bare Object3D is left
 * alone because those are used as markers whose world transform is read back.
 */
function isMergeable(node: THREE.Object3D): boolean {
  const mesh = node as THREE.Mesh & { isSkinnedMesh?: boolean; isInstancedMesh?: boolean };
  if (mesh.isMesh) {
    return !mesh.isSkinnedMesh && !mesh.isInstancedMesh && !Array.isArray(mesh.material);
  }
  return node.type === 'Group';
}

function stateKey(mesh: THREE.Mesh, materialKey: string): string {
  return [
    materialKey,
    mesh.castShadow ? 1 : 0,
    mesh.receiveShadow ? 1 : 0,
    mesh.renderOrder,
    mesh.frustumCulled ? 1 : 0,
  ].join('|');
}

/**
 * Merges the static shell of every preserved node in `root`.
 *
 * A node is preserved when it is the root, is hidden, cannot be merged (lights,
 * sprites, skinned or instanced meshes, multi-material meshes), is reported as a
 * pivot, or has a preserved descendant. Preserved nodes keep their exact place
 * in the hierarchy and their local transform, so animation, visibility toggles,
 * and name lookups behave exactly as before.
 */
export function collapseStaticSubtrees(
  root: THREE.Object3D,
  options: StaticBatchOptions = {},
): StaticBatchResult {
  const families = [...(options.surfaceFamilies ?? [])];
  // The plain family is last so a mapped family gets first refusal on the
  // untextured pieces: joining one of those merges them with mapped neighbours
  // instead of leaving them on a batch of their own.
  if (options.unifyPlainMaterials) families.push(PLAIN_FAMILY);
  const settings: BatchSettings = {
    trimExtent: options.trimExtent ?? 0,
    trimFlag: options.trimFlag ?? 'staticBatchTrim',
    shadowExtent: options.shadowExtent ?? 0,
    prefix: options.namePrefix ?? 'StaticBatch',
    families,
  };
  const preserved = new Set<THREE.Object3D>();

  const mark = (node: THREE.Object3D): boolean => {
    let keep = node === root
      || !node.visible
      || !isMergeable(node)
      || (options.isPivot?.(node) ?? false);
    for (const child of node.children) {
      if (mark(child)) keep = true;
    }
    if (keep) preserved.add(node);
    return keep;
  };
  mark(root);

  root.updateWorldMatrix(false, true);
  const result: StaticBatchResult = { collapsed: 0, batches: [] };
  for (const node of preserved) {
    collapseNode(node, preserved, settings, result);
  }
  return result;
}

interface BatchSettings {
  trimExtent: number;
  trimFlag: string;
  shadowExtent: number;
  prefix: string;
  families: readonly SurfaceFamily[];
}

function collapseNode(
  pivot: THREE.Object3D,
  preserved: ReadonlySet<THREE.Object3D>,
  settings: BatchSettings,
  result: StaticBatchResult,
): void {
  const inverse = pivot.matrixWorld.clone().invert();
  const buckets = new Map<string, Bucket>();
  const absorbed: THREE.Mesh[] = [];
  const pivotMesh = pivot as THREE.Mesh;
  const ownKey = pivotMesh.isMesh && !Array.isArray(pivotMesh.material)
    ? stateKey(pivotMesh, (pivotMesh.material as THREE.Material).uuid)
    : null;

  const add = (mesh: THREE.Mesh, own: boolean): void => {
    const geometry = flatten(mesh.geometry);
    if (!own) geometry.applyMatrix4(inverse.clone().multiply(mesh.matrixWorld));
    const source = mesh.material as THREE.Material;
    const edge = equivalentEdge(geometry);
    // A pivot keeps its own material so callers can still address it; only the
    // geometry being absorbed is eligible for a shared surface.
    let family: SurfaceFamily | null = null;
    let member: SurfaceMember | null = null;
    if (!own) {
      for (const candidate of settings.families) {
        member = candidate.member(source);
        if (member) {
          family = candidate;
          break;
        }
      }
    }
    let material = source;
    let identity = source.uuid;
    if (family && member) {
      material = family.materialFor(source as THREE.MeshStandardMaterial);
      identity = family.bucketKey(source as THREE.MeshStandardMaterial);
      bakeSurface(geometry, member, family);
    }
    const key = stateKey(mesh, identity);
    const trim = !own && settings.trimExtent > 0 && edge < settings.trimExtent;
    const bucket = buckets.get(key);
    if (bucket) {
      bucket.geometries.push(geometry);
      bucket.trim = bucket.trim && trim;
      bucket.maxEdge = Math.max(bucket.maxEdge, edge);
      bucket.merged = true;
      return;
    }
    buckets.set(key, {
      material,
      castShadow: mesh.castShadow,
      receiveShadow: mesh.receiveShadow,
      renderOrder: mesh.renderOrder,
      frustumCulled: mesh.frustumCulled,
      trim,
      maxEdge: edge,
      merged: !own,
      geometries: [geometry],
    });
  };

  const absorb = (node: THREE.Object3D): void => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh) {
      add(mesh, false);
      absorbed.push(mesh);
    }
    for (const child of node.children) absorb(child);
  };

  const keep: THREE.Object3D[] = [];
  for (const child of pivot.children) {
    if (preserved.has(child)) keep.push(child);
    else absorb(child);
  }
  if (absorbed.length === 0) return;
  if (ownKey) add(pivotMesh, true);

  for (const mesh of absorbed) mesh.geometry.dispose();
  pivot.clear();
  for (const child of keep) pivot.add(child);
  result.collapsed += absorbed.length;

  let index = 0;
  for (const [key, bucket] of buckets) {
    if (key === ownKey && !bucket.merged) {
      // Nothing joined the pivot's own surface; leave its geometry alone.
      bucket.geometries[0].dispose();
      continue;
    }
    const merged = bucket.geometries.length === 1
      ? bucket.geometries[0]
      : mergeGeometries(bucket.geometries, false);
    if (!merged) throw new Error('static batch could not merge its source geometry');
    if (bucket.geometries.length > 1) {
      for (const source of bucket.geometries) source.dispose();
    }
    merged.computeBoundingSphere();

    if (key === ownKey) {
      pivotMesh.geometry.dispose();
      pivotMesh.geometry = merged;
      continue;
    }
    const batch = new THREE.Mesh(merged, bucket.material);
    batch.name = `${settings.prefix}:${pivot.name || pivot.type}:${index}`;
    batch.castShadow = bucket.castShadow && bucket.maxEdge >= settings.shadowExtent;
    batch.receiveShadow = bucket.receiveShadow;
    batch.renderOrder = bucket.renderOrder;
    batch.frustumCulled = bucket.frustumCulled;
    batch.matrixAutoUpdate = false;
    batch.userData[settings.trimFlag] = bucket.trim;
    // Largest piece in the batch: how big this reads on screen, which is what a
    // caller needs to decide when the batch stops being worth a submission.
    batch.userData.batchExtent = bucket.maxEdge;
    pivot.add(batch);
    result.batches.push(batch);
    index += 1;
  }
}
