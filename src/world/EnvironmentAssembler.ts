import {
  Box3,
  Group,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Scene,
  SRGBColorSpace,
  Vector3,
  type Material,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';
import type { AssetRegistry } from '../engine';

export type EnvironmentModuleKind = 'building' | 'prop';

export interface EnvironmentModulePlacement {
  id: string;
  kind: EnvironmentModuleKind;
  position: readonly [number, number, number];
  rotationY?: number;
  scale?: number;
  /** Manifest IDs in LOD0 → LOD2 order. */
  assets: readonly [string, string, string];
  /** UV1-authored baked irradiance map shared by the module's LODs. */
  lightMapAsset?: string;
  /** Repeated source props such as lamps, window cards and debris. */
  instances?: readonly EnvironmentInstancePlacement[];
}

export interface EnvironmentInstancePlacement {
  position: readonly [number, number, number];
  rotationY?: number;
  scale?: number;
}

export interface EnvironmentAssemblyOptions {
  scene: Scene;
  registry: AssetRegistry;
  modules: readonly EnvironmentModulePlacement[];
  /** Called only when authored content cannot be loaded. */
  buildFallback: (scene: Scene) => { dispose(): void };
  lodBias?: number;
  /**
   * Present LOD0 as soon as the route's critical geometry is ready, then add
   * lower-detail levels as their requests settle. This is opt-in so callers
   * that validate a complete asset package keep the all-or-nothing behavior.
   */
  deferLodUpgrades?: boolean;
}

export interface EnvironmentAssemblyResult {
  mode: 'authored' | 'fallback';
  group: Group;
  error?: unknown;
}

export interface AuthoredStaticCollider {
  id: string;
  center: { x: number; y: number; z: number };
  halfExtents: { x: number; y: number; z: number };
  surface: 'asphalt' | 'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'default';
  /** World-space authored triangle data used by Rapier in release mode. */
  mesh: { vertices: number[]; indices: number[] };
}

export interface AuthoredNavigationAnnotations {
  nodes: Array<{ id: string; position: { x: number; y: number; z: number } }>;
  links: Array<{ from: string; to: string }>;
  coverSlots: Array<{ id: string; position: { x: number; y: number; z: number } }>;
}

export interface AuthoredEnvironmentRenderStats {
  instancedMeshes: number;
  instances: number;
  lightmappedMaterials: number;
  emissiveMaterials: number;
}

const PROP_LOD_DISTANCES: readonly [number, number, number] = [0, 20, 55];
const BUILDING_LOD_DISTANCES: readonly [number, number, number] = [0, 35, 85];

/**
 * Assembles only authored GLTF route modules in camera-visible space. The
 * previous procedural level is deliberately reachable only via the explicit
 * load-error path, so QA can reject any fallback capture.
 */
export class EnvironmentAssembler {
  private readonly scene: Scene;
  private readonly registry: AssetRegistry;
  private readonly modules: readonly EnvironmentModulePlacement[];
  private readonly buildFallback: EnvironmentAssemblyOptions['buildFallback'];
  private fallback: { dispose(): void } | null = null;
  private group: Group | null = null;
  private mode: 'unloaded' | 'authored' | 'fallback' = 'unloaded';
  private lodBias: number;
  private readonly deferLodUpgrades: boolean;
  private readonly ownedMaterials = new Set<Material>();
  private pendingLodUpgrades: Promise<void>[] = [];
  private lodUpgradeErrors: unknown[] = [];
  private loadGeneration = 0;

  constructor(options: EnvironmentAssemblyOptions) {
    this.scene = options.scene;
    this.registry = options.registry;
    this.modules = options.modules;
    this.buildFallback = options.buildFallback;
    this.lodBias = finite(options.lodBias ?? 0);
    this.deferLodUpgrades = options.deferLodUpgrades === true;
  }

  async load(): Promise<EnvironmentAssemblyResult> {
    this.dispose();
    const generation = ++this.loadGeneration;
    const group = new Group();
    group.name = 'NightglassAuthoredRoute';
    try {
      await Promise.all(this.modules.map(async (module) => {
        const lod = await this.createLOD(module, generation);
        group.add(lod);
      }));
      this.scene.add(group);
      this.group = group;
      this.mode = 'authored';
      return { mode: 'authored', group };
    } catch (error) {
      group.removeFromParent();
      this.fallback = this.buildFallback(this.scene);
      this.mode = 'fallback';
      return { mode: 'fallback', group, error };
    }
  }

  update(camera: PerspectiveCamera): void {
    this.group?.updateMatrixWorld();
    this.group?.traverse((node) => {
      if (node instanceof LOD) node.update(camera);
    });
  }

  setLodBias(lodBias: number): void {
    this.lodBias = finite(lodBias);
    this.group?.traverse((node) => {
      if (!(node instanceof LOD)) return;
      const kind = node.userData.kind as EnvironmentModuleKind | undefined;
      const distances = kind === 'building' ? BUILDING_LOD_DISTANCES : PROP_LOD_DISTANCES;
      node.levels.forEach((level, index) => {
        level.distance = this.adjustDistance(distances[index] ?? level.distance);
      });
    });
  }

  getMode(): 'unloaded' | 'authored' | 'fallback' {
    return this.mode;
  }

  /** Wait for optional deferred LOD requests without failing the visible LOD0 route. */
  async waitForLodUpgrades(): Promise<readonly unknown[]> {
    await Promise.all(this.pendingLodUpgrades);
    return [...this.lodUpgradeErrors];
  }

  getStaticColliders(): AuthoredStaticCollider[] {
    if (!this.group) return [];
    this.group.updateMatrixWorld(true);
    const colliders: AuthoredStaticCollider[] = [];
    const bounds = new Box3();
    const center = new Vector3();
    const size = new Vector3();
    this.group.traverse((node) => {
      if (node.userData.nightglassCollision !== true) return;
      if (hasCollisionAncestor(node, this.group!)) return;
      bounds.setFromObject(node);
      if (bounds.isEmpty()) return;
      bounds.getCenter(center);
      bounds.getSize(size);
      if (Math.min(size.x, size.y, size.z) <= 0.001) return;
      const mesh = extractCollisionMesh(node);
      if (!mesh) return;
      colliders.push({
        id: `authored:${String(node.userData.annotationId)}`,
        center: { x: center.x, y: center.y, z: center.z },
        halfExtents: { x: size.x * 0.5, y: size.y * 0.5, z: size.z * 0.5 },
        surface: surfaceTag(node.userData.surface),
        mesh,
      });
    });
    return colliders;
  }

  getNavigationAnnotations(): AuthoredNavigationAnnotations {
    const annotations: AuthoredNavigationAnnotations = { nodes: [], links: [], coverSlots: [] };
    if (!this.group) return annotations;
    this.group.updateMatrixWorld(true);
    const position = new Vector3();
    const nodeIds = new Set<string>();
    const coverIds = new Set<string>();
    this.group.traverse((node) => {
      const kind = node.userData.nightglassAnnotation as string | undefined;
      if (kind !== 'navigation' && kind !== 'cover') return;
      const id = String(node.userData.annotationId);
      node.getWorldPosition(position);
      if (kind === 'navigation' && !nodeIds.has(id)) {
        nodeIds.add(id);
        annotations.nodes.push({ id, position: vectorRecord(position) });
        for (const target of annotationLinks(node.userData.navigationLinks)) {
          annotations.links.push({ from: id, to: target });
          if (node.userData.bidirectional !== false) annotations.links.push({ from: target, to: id });
        }
      } else if (kind === 'cover' && !coverIds.has(id)) {
        coverIds.add(id);
        annotations.coverSlots.push({ id, position: vectorRecord(position) });
      }
    });
    annotations.nodes.sort((a, b) => a.id.localeCompare(b.id));
    annotations.links = annotations.links
      .filter((link, index, links) => (
        nodeIds.has(link.from)
        && nodeIds.has(link.to)
        && links.findIndex((candidate) => candidate.from === link.from && candidate.to === link.to) === index
      ))
      .sort((a, b) => a.from.localeCompare(b.from) || a.to.localeCompare(b.to));
    annotations.coverSlots.sort((a, b) => a.id.localeCompare(b.id));
    return annotations;
  }

  getRenderStats(): AuthoredEnvironmentRenderStats {
    const stats: AuthoredEnvironmentRenderStats = {
      instancedMeshes: 0,
      instances: 0,
      lightmappedMaterials: 0,
      emissiveMaterials: 0,
    };
    this.group?.traverse((node) => {
      if (node instanceof InstancedMesh) {
        stats.instancedMeshes += 1;
        stats.instances += node.count;
      }
      const mesh = node as import('three').Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (!(material instanceof MeshStandardMaterial)) continue;
        if (material.lightMap) stats.lightmappedMaterials += 1;
        if (
          material.emissiveMap
          || (material.emissiveIntensity > 0 && material.emissive.getHex() !== 0)
        ) stats.emissiveMaterials += 1;
      }
    });
    return stats;
  }

  dispose(): void {
    this.loadGeneration += 1;
    this.group?.removeFromParent();
    // Geometry and textures remain AssetRegistry-owned. UV1 lightmap binding
    // creates module-local material clones, which are disposed here.
    this.group = null;
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.clear();
    this.pendingLodUpgrades = [];
    this.lodUpgradeErrors = [];
    this.fallback?.dispose();
    this.fallback = null;
    this.mode = 'unloaded';
  }

  private async createLOD(module: EnvironmentModulePlacement, generation: number): Promise<LOD> {
    const [lod0, lightMap] = await Promise.all([
      this.registry.load<GLTF>(module.assets[0]),
      module.lightMapAsset
        ? this.registry.load<Texture>(module.lightMapAsset)
        : Promise.resolve(null),
    ]);
    if (lightMap) {
      lightMap.channel = 1;
      lightMap.colorSpace = SRGBColorSpace;
      lightMap.needsUpdate = true;
    }
    const lod = new LOD();
    lod.name = `RouteModule:${module.id}`;
    lod.userData.kind = module.kind;
    lod.position.fromArray(module.position);
    lod.rotation.y = module.rotationY ?? 0;
    lod.scale.setScalar(module.scale ?? 1);
    const distances = module.kind === 'building'
      ? BUILDING_LOD_DISTANCES
      : PROP_LOD_DISTANCES;
    lod.addLevel(this.createLevelObject(module, lod0, 0, lightMap), this.adjustDistance(distances[0]));

    if (!this.deferLodUpgrades) {
      const upgrades = await Promise.all(module.assets.slice(1).map((id) => this.registry.load<GLTF>(id)));
      upgrades.forEach((asset, offset) => {
        const index = offset + 1;
        lod.addLevel(
          this.createLevelObject(module, asset, index, lightMap),
          this.adjustDistance(distances[index]),
        );
      });
      return lod;
    }

    module.assets.slice(1).forEach((assetId, offset) => {
      const index = offset + 1;
      const upgrade = this.registry.load<GLTF>(assetId)
        .then((asset) => {
          // A disposed/reloaded route must never receive a late scene mutation.
          if (generation !== this.loadGeneration) return;
          lod.addLevel(
            this.createLevelObject(module, asset, index, lightMap),
            this.adjustDistance(distances[index]),
          );
        })
        .catch((error: unknown) => {
          if (generation === this.loadGeneration) this.lodUpgradeErrors.push(error);
        });
      this.pendingLodUpgrades.push(upgrade);
    });
    return lod;
  }

  private createLevelObject(
    module: EnvironmentModulePlacement,
    gltf: GLTF,
    lodIndex: number,
    lightMap: Texture | null,
  ): Object3D {
    const instances = module.instances;
    if (instances && instances.length > 1) {
      const instancedHierarchy = this.createInstancedHierarchy(
        module,
        gltf.scene,
        lodIndex,
        lightMap,
        instances,
      );
      if (instancedHierarchy.children.length > 0) return instancedHierarchy;
    }

    const scene = cloneSkinned(gltf.scene);
    scene.name = `${module.id}:lod${lodIndex}`;
    scene.traverse((node) => {
      node.castShadow = true;
      node.receiveShadow = true;
      const mesh = node as import('three').Mesh;
      if (mesh.isMesh && lightMap) mesh.material = this.cloneWithLightMap(mesh.material, lightMap);
    });
    if (lodIndex === 0) this.annotateAuthoredNodes(scene, module.id);
    return scene;
  }

  /**
   * An authored prop is frequently a hierarchy (body, glass, trim, decals),
   * not one mesh. Flattening its already-composed local transforms lets each
   * source mesh retain its placement while still batching equivalent draws.
   */
  private createInstancedHierarchy(
    module: EnvironmentModulePlacement,
    source: Object3D,
    lodIndex: number,
    lightMap: Texture | null,
    instances: readonly EnvironmentInstancePlacement[],
  ): Group {
    source.updateMatrixWorld(true);
    const group = new Group();
    group.name = `${module.id}:lod${lodIndex}:instances`;
    const placement = new Object3D();
    const matrix = new Matrix4();
    source.traverse((node) => {
      const sourceMesh = node as Mesh;
      if (!sourceMesh.isMesh || !sourceMesh.geometry || !sourceMesh.material || isCollisionMarker(sourceMesh)) return;
      const mesh = new InstancedMesh(
        sourceMesh.geometry,
        this.cloneWithLightMap(sourceMesh.material, lightMap),
        instances.length,
      );
      mesh.name = `${module.id}:lod${lodIndex}:${sourceMesh.name || sourceMesh.uuid}:instances`;
      mesh.castShadow = sourceMesh.castShadow || true;
      mesh.receiveShadow = sourceMesh.receiveShadow || true;
      mesh.renderOrder = sourceMesh.renderOrder;
      mesh.frustumCulled = sourceMesh.frustumCulled;
      mesh.userData = { ...sourceMesh.userData, instancedSource: sourceMesh.name || sourceMesh.uuid };
      instances.forEach((instance, index) => {
        placement.position.fromArray(instance.position);
        placement.rotation.set(0, instance.rotationY ?? 0, 0);
        placement.scale.setScalar(instance.scale ?? 1);
        placement.updateMatrix();
        matrix.multiplyMatrices(placement.matrix, sourceMesh.matrixWorld);
        mesh.setMatrixAt(index, matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      group.add(mesh);
    });
    return group;
  }

  private cloneWithLightMap<T extends Material | Material[]>(material: T, lightMap: Texture | null): T {
    if (!lightMap) return material;
    const cloneOne = (source: Material): Material => {
      const clone = source.clone();
      this.ownedMaterials.add(clone);
      if (clone instanceof MeshStandardMaterial) {
        clone.lightMap = lightMap;
        clone.lightMapIntensity = 1;
        clone.needsUpdate = true;
      }
      return clone;
    };
    return (Array.isArray(material)
      ? material.map(cloneOne)
      : cloneOne(material)) as T;
  }

  private annotateAuthoredNodes(scene: Object3D, moduleId: string): void {
    scene.traverse((node) => {
      const name = node.name.trim();
      const collision = node.userData.collision === true || /^COLLIDER(?:[_:-]|$)/i.test(name);
      const navValue = node.userData.navigationNode;
      const navigation = navValue === true
        || typeof navValue === 'string'
        || /^NAV(?:[_:-]|$)/i.test(name);
      const coverValue = node.userData.coverSlot;
      const cover = coverValue === true
        || typeof coverValue === 'string'
        || /^COVER(?:[_:-]|$)/i.test(name);
      if (collision) {
        node.userData.nightglassCollision = true;
        node.userData.annotationId = annotationId(moduleId, node, node.userData.collisionId);
        node.visible = false;
      }
      if (navigation) {
        node.userData.nightglassAnnotation = 'navigation';
        node.userData.annotationId = annotationId(moduleId, node, navValue);
        node.userData.navigationLinks = node.userData.links ?? node.userData.navigationLinks;
        node.visible = false;
      } else if (cover) {
        node.userData.nightglassAnnotation = 'cover';
        node.userData.annotationId = annotationId(moduleId, node, coverValue);
        node.visible = false;
      }
    });
  }

  private adjustDistance(distance: number): number {
    if (distance === 0) return 0;
    return distance * Math.pow(2, -this.lodBias);
  }
}

function annotationId(moduleId: string, node: Object3D, authored: unknown): string {
  const id = typeof authored === 'string' && authored.trim()
    ? authored.trim()
    : node.name.replace(/^(?:COLLIDER|NAV|COVER)[_:-]?/i, '').trim();
  return id || `${moduleId}:${node.id}`;
}

function annotationLinks(value: unknown): string[] {
  if (typeof value === 'string') return value.split(',').map((part) => part.trim()).filter(Boolean);
  if (Array.isArray(value)) return value.filter((part): part is string => typeof part === 'string' && !!part.trim());
  return [];
}

function vectorRecord(value: Vector3): { x: number; y: number; z: number } {
  return { x: value.x, y: value.y, z: value.z };
}

function hasCollisionAncestor(node: Object3D, route: Object3D): boolean {
  let parent = node.parent;
  while (parent && parent !== route) {
    if (parent.userData.nightglassCollision === true) return true;
    parent = parent.parent;
  }
  return false;
}

function isCollisionMarker(node: Object3D): boolean {
  let current: Object3D | null = node;
  while (current) {
    if (
      current.userData.collision === true
      || /^COLLIDER(?:[_:-]|$)/i.test(current.name.trim())
    ) return true;
    current = current.parent;
  }
  return false;
}

function extractCollisionMesh(root: Object3D): AuthoredStaticCollider['mesh'] | null {
  const vertices: number[] = [];
  const indices: number[] = [];
  const vertex = new Vector3();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    const position = mesh.geometry.getAttribute('position');
    if (!position || position.itemSize < 3 || position.count < 3) return;
    const baseIndex = vertices.length / 3;
    for (let index = 0; index < position.count; index += 1) {
      vertex.fromBufferAttribute(position, index).applyMatrix4(mesh.matrixWorld);
      vertices.push(vertex.x, vertex.y, vertex.z);
    }
    const geometryIndex = mesh.geometry.getIndex();
    if (geometryIndex) {
      const triangleIndexCount = geometryIndex.count - geometryIndex.count % 3;
      for (let index = 0; index < triangleIndexCount; index += 1) {
        indices.push(baseIndex + geometryIndex.getX(index));
      }
    } else {
      const triangleVertexCount = position.count - position.count % 3;
      for (let index = 0; index < triangleVertexCount; index += 1) {
        indices.push(baseIndex + index);
      }
    }
  });
  return vertices.length >= 9 && indices.length >= 3 ? { vertices, indices } : null;
}

function surfaceTag(value: unknown): AuthoredStaticCollider['surface'] {
  return value === 'asphalt'
    || value === 'concrete'
    || value === 'metal'
    || value === 'wood'
    || value === 'dirt'
    || value === 'glass'
    ? value
    : 'default';
}

function finite(value: number): number {
  if (!Number.isFinite(value)) throw new TypeError('lodBias must be finite');
  return value;
}
