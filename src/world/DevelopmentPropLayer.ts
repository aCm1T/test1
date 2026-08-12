import {
  Euler,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  Quaternion,
  StaticDrawUsage,
  Texture,
  Vector3,
  type Material,
  type Object3D,
} from 'three';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';

/**
 * A deliberately separate, CC0 development-only set of visual replacements.
 *
 * These props are never registered in the authored manifest, never contribute
 * collision/navigation data, and are attached below the procedural Level
 * group. Consequently they disappear with that group when an authored route
 * succeeds, and release mode never constructs this layer.
 */
export const DEVELOPMENT_BARREL_URL =
  '/assets/development/cc0-props/Barrel_01_1k.gltf';

/**
 * The complete 1K glTF package contains clean and weathered condensers as a
 * deliberately paired roof-service assembly. It is development-only like the
 * rest of this layer and is never a substitute for the authored environment.
 */
export const DEVELOPMENT_EXTERIOR_AIRCON_URL =
  '/assets/development/cc0-props/exterior_aircon_unit/exterior_aircon_unit_1k.gltf';

export interface DevelopmentPropPlacement {
  /** World-space placement relative to the procedural Level group. */
  position: readonly [number, number, number];
  rotationY?: number;
  scale?: number;
}

/** Replaces the existing blockout drums visually; their gameplay data stays put. */
export const DEVELOPMENT_BARREL_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-12, 0.008, 8], rotationY: 0, scale: 1.18 },
  { position: [-12.7, 0.008, 8.5], rotationY: 0.4, scale: 1.18 },
  { position: [8, 0.008, 14], rotationY: 0.2, scale: 1.18 },
  { position: [19, 0.008, 6], rotationY: -0.3, scale: 1.18 },
  { position: [-20, 0.008, 10], rotationY: 0.5, scale: 1.18 },
  { position: [4, 0.008, -16], rotationY: 0.1, scale: 1.18 },
  { position: [13, 0.008, -8], rotationY: 0, scale: 1.18 },
  { position: [13.7, 0.008, -7.85], rotationY: 0.3, scale: 1.18 },
  { position: [13.35, 1.04, -8], rotationY: 0.5, scale: 1.18 },
] as const;

export const DEVELOPMENT_CRATE_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [6, 0.008, 9], rotationY: 0, scale: 1.68 },
  { position: [7.1, 0.008, 9.2], rotationY: 0.4, scale: 1.48 },
  { position: [-9, 0.008, 10], rotationY: -0.2, scale: 1.62 },
  { position: [15, 0.008, 4], rotationY: 0.1, scale: 1.58 },
  { position: [15, 0.39, 4], rotationY: -0.3, scale: 1.48 },
] as const;

export const DEVELOPMENT_UTILITY_BOX_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [11.2, 0.008, -3.55], rotationY: -0.12, scale: 1 },
  { position: [-14.1, 0.008, 7.2], rotationY: 0.4, scale: 0.96 },
  { position: [24.5, 0.008, 4.4], rotationY: -0.48, scale: 0.94 },
] as const;

/**
 * South Shop (the "warehouse" QA framing) is an enterable shell at z=20.
 * Keep its centre clear: these are visual-only stock against the rear and
 * existing counter rather than new cover in the player route. The floor slab
 * ends at y=0.245, so ground instances begin just above it.
 */
const DEVELOPMENT_SOUTH_SHOP_BARREL_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-1.9, 0.252, 23.47], rotationY: -0.22, scale: 1.03 },
  { position: [-1.26, 0.252, 23.56], rotationY: 0.18, scale: 0.93 },
] as const;

const DEVELOPMENT_SOUTH_SHOP_CRATE_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-1.65, 0.252, 22.68], rotationY: 0.16, scale: 1.22 },
  // Counter top: the base is at y=1.10 and these retain an uncluttered aisle.
  { position: [2.65, 1.105, 22.03], rotationY: -0.12, scale: 1.12 },
  { position: [4.0, 1.105, 22.12], rotationY: 0.18, scale: 1.04 },
] as const;

const DEVELOPMENT_SOUTH_SHOP_UTILITY_BOX_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [3.85, 0.252, 23.53], rotationY: -0.1, scale: 0.94 },
] as const;

/**
 * The South Shop roof slab finishes at y=3.725. The source mesh's lowest
 * local point is y=-0.320, so the placement keeps the twin condensers seated
 * directly on that roof rather than floating above the service facade. It is
 * deliberately behind the front parapet and clear of the enterable shell.
 */
const DEVELOPMENT_SOUTH_SHOP_AIRCON_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [5.82, 4.08, 19.42], rotationY: 0, scale: 1.08 },
] as const;

/**
 * A deliberately small forward-route read for the development captures.
 *
 * The fallback camera starts at z=0 and then advances to z=8 while looking
 * +Z. These placements sit ahead of both views, on either outer side of the
 * open travel strip (|x| >= 5), so the scanned surfaces read against open
 * asphalt instead of being hidden by the storefront, sandbags, or the
 * matching procedural replacements. They remain purely visual instances.
 */
const DEVELOPMENT_FORWARD_ROUTE_BARREL_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [5.25, 0.008, 12.55], rotationY: -0.42, scale: 1.18 },
] as const;

const DEVELOPMENT_FORWARD_ROUTE_CRATE_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-5.2, 0.008, 12.85], rotationY: 0.28, scale: 1.68 },
] as const;

const DEVELOPMENT_FORWARD_ROUTE_UTILITY_BOX_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-5.35, 0.008, 13.75], rotationY: 0.18, scale: 0.96 },
] as const;

/**
 * Sidewalk and alley-edge stock.
 *
 * Scanned props are the densest visual detail the fallback has access to, and
 * cloning an already-parsed glTF costs no additional download or GPU upload.
 * These sit on the raised concrete strips (top face y=0.2) hard against the
 * facades, so they add near-field material variety to the street sightlines
 * without narrowing the drivable centre lanes the encounter is tuned around.
 */
const DEVELOPMENT_STREET_EDGE_BARREL_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [8.32, 0.205, 2.24], rotationY: 0.28, scale: 1.12 },
  { position: [8.68, 0.205, 3.05], rotationY: -0.34, scale: 1.04 },
  { position: [-8.36, 0.205, -1.55], rotationY: 0.52, scale: 1.1 },
  { position: [8.44, 0.205, -18.42], rotationY: -0.18, scale: 1.14 },
  { position: [-8.55, 0.205, 15.62], rotationY: 0.36, scale: 1.06 },
  { position: [-21.4, 0.008, -13.8], rotationY: 0.62, scale: 1.16 },
] as const;

const DEVELOPMENT_STREET_EDGE_CRATE_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [-8.42, 0.205, 6.85], rotationY: -0.24, scale: 1.52 },
  { position: [8.5, 0.205, -3.05], rotationY: 0.42, scale: 1.44 },
  { position: [-8.48, 0.205, -19.55], rotationY: 0.16, scale: 1.58 },
  { position: [11.65, 0.408, 4.35], rotationY: -0.3, scale: 1.36 },
  { position: [26.2, 0.008, -8.4], rotationY: 0.48, scale: 1.5 },
] as const;

const DEVELOPMENT_STREET_EDGE_UTILITY_BOX_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  { position: [8.62, 0.205, 10.35], rotationY: -0.42, scale: 0.98 },
  { position: [-8.6, 0.205, -8.65], rotationY: 0.3, scale: 0.92 },
  { position: [-15.35, 0.008, -8.9], rotationY: 0.14, scale: 0.96 },
] as const;

/**
 * Roof-mounted condensers for the two tallest playable shells. Their lowest
 * local point is y=-0.320, so each placement clears the corresponding roof
 * slab exactly. They break the flat capping edges that read as blockout.
 */
const DEVELOPMENT_ROOFTOP_AIRCON_PLACEMENTS: readonly DevelopmentPropPlacement[] = [
  // East warehouse roof slab tops out at y=5.825.
  { position: [20.4, 6.145, 1.4], rotationY: 0.24, scale: 1 },
  // West office roof slab tops out at y=9.325.
  { position: [-19.6, 9.645, 1.2], rotationY: -0.58, scale: 1 },
] as const;

export interface DevelopmentPropDescriptor {
  id: string;
  url: string;
  placements: readonly DevelopmentPropPlacement[];
}

/** CC0 variety for the fallback only; all packages stay outside the manifest. */
export const DEVELOPMENT_PROP_DESCRIPTORS: readonly DevelopmentPropDescriptor[] = [
  {
    id: 'barrel-01',
    url: DEVELOPMENT_BARREL_URL,
    placements: [
      ...DEVELOPMENT_BARREL_PLACEMENTS,
      ...DEVELOPMENT_FORWARD_ROUTE_BARREL_PLACEMENTS,
      ...DEVELOPMENT_SOUTH_SHOP_BARREL_PLACEMENTS,
      ...DEVELOPMENT_STREET_EDGE_BARREL_PLACEMENTS,
    ],
  },
  {
    id: 'plastic-crate-02',
    url: '/assets/development/cc0-props/plastic_crate_02/plastic_crate_02_1k.gltf',
    placements: [
      ...DEVELOPMENT_CRATE_PLACEMENTS,
      ...DEVELOPMENT_FORWARD_ROUTE_CRATE_PLACEMENTS,
      ...DEVELOPMENT_SOUTH_SHOP_CRATE_PLACEMENTS,
      ...DEVELOPMENT_STREET_EDGE_CRATE_PLACEMENTS,
    ],
  },
  {
    id: 'utility-box-01',
    url: '/assets/development/cc0-props/utility_box_01/utility_box_01_1k.gltf',
    placements: [
      ...DEVELOPMENT_UTILITY_BOX_PLACEMENTS,
      ...DEVELOPMENT_FORWARD_ROUTE_UTILITY_BOX_PLACEMENTS,
      ...DEVELOPMENT_SOUTH_SHOP_UTILITY_BOX_PLACEMENTS,
      ...DEVELOPMENT_STREET_EDGE_UTILITY_BOX_PLACEMENTS,
    ],
  },
  {
    id: 'exterior-aircon-unit',
    url: DEVELOPMENT_EXTERIOR_AIRCON_URL,
    placements: [
      ...DEVELOPMENT_SOUTH_SHOP_AIRCON_PLACEMENTS,
      ...DEVELOPMENT_ROOFTOP_AIRCON_PLACEMENTS,
    ],
  },
] as const;

export type DevelopmentPropLayerState = 'idle' | 'loading' | 'installed' | 'failed' | 'disposed';

export interface DevelopmentPropLoadReport {
  state: Exclude<DevelopmentPropLayerState, 'idle' | 'loading'>;
  placementCount: number;
  error?: unknown;
}

type AssetFetch = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type GltfParser = (data: ArrayBuffer, resourcePath: string) => Promise<GLTF>;

export interface DevelopmentPropLayerOptions {
  /** Attach to Level.group, not the scene: authored presentation hides it atomically. */
  parent: Group;
  descriptors?: readonly DevelopmentPropDescriptor[];
  /** Injection seams keep disposal/error behavior testable without a browser. */
  fetchAsset?: AssetFetch;
  parseGltf?: GltfParser;
}

/**
 * Asynchronously stages a small CC0 prop set without taking ownership of any
 * gameplay systems. Source surfaces become InstancedMeshes (near/far shadow
 * buckets); this layer owns and releases those shared GPU resources once.
 */
export class DevelopmentPropLayer {
  private readonly parent: Group;
  private readonly descriptors: readonly DevelopmentPropDescriptor[];
  private readonly fetchAsset: AssetFetch;
  private readonly parseGltf: GltfParser;
  private readonly root = new Group();
  private abortController: AbortController | null = null;
  private loadPromise: Promise<DevelopmentPropLoadReport> | null = null;
  private generation = 0;
  private state: DevelopmentPropLayerState = 'idle';

  constructor(options: DevelopmentPropLayerOptions) {
    this.parent = options.parent;
    this.descriptors = options.descriptors ?? DEVELOPMENT_PROP_DESCRIPTORS;
    // Keep the browser's native `fetch` receiver intact. Calling a saved
    // native fetch as `this.fetchAsset(...)` otherwise throws "Illegal
    // invocation", which silently removed this development-only layer.
    this.fetchAsset = options.fetchAsset ?? ((input, init) => fetch(input, init));
    this.parseGltf = options.parseGltf ?? defaultParseGltf;
    this.root.name = 'DevelopmentCcoBarrelLayer';
    this.root.userData.developmentOnly = true;
    this.root.userData.visualOnly = true;
    this.root.userData.authoredContract = false;
  }

  getState(): DevelopmentPropLayerState {
    return this.state;
  }

  /** Starts network/parse work but never throws into the game bootstrap. */
  load(): Promise<DevelopmentPropLoadReport> {
    if (this.state === 'disposed') {
      return Promise.resolve({ state: 'disposed', placementCount: 0 });
    }
    if (this.loadPromise) return this.loadPromise;
    this.state = 'loading';
    const generation = this.generation;
    const controller = new AbortController();
    this.abortController = controller;
    this.loadPromise = this.loadInternal(generation, controller);
    return this.loadPromise;
  }

  /**
   * Detaches all visual content and releases the GLTF's shared geometry,
   * materials and textures. It is safe while a request or parse is pending.
   */
  dispose(): void {
    if (this.state === 'disposed') return;
    this.generation += 1;
    this.state = 'disposed';
    this.abortController?.abort();
    this.abortController = null;
    this.root.removeFromParent();
    disposeObjectResources(this.root);
    this.root.clear();
  }

  private async loadInternal(
    generation: number,
    controller: AbortController,
  ): Promise<DevelopmentPropLoadReport> {
    let sources: Object3D[] = [];
    try {
      const loaded = await Promise.allSettled(this.descriptors.map(async (descriptor) => {
        const response = await this.fetchAsset(descriptor.url, { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`${descriptor.id} request failed (${response.status})`);
        }
        const gltf = await this.parseGltf(
          await response.arrayBuffer(),
          resourcePathFor(descriptor.url),
        );
        return gltf.scene;
      }));
      const failure = loaded.find((outcome) => outcome.status === 'rejected');
      if (failure?.status === 'rejected') {
        for (const outcome of loaded) {
          if (outcome.status === 'fulfilled') disposeObjectResources(outcome.value);
        }
        throw failure.reason;
      }
      sources = loaded.map((outcome) => {
        if (outcome.status !== 'fulfilled') throw new Error('Unexpected development prop load state');
        return outcome.value;
      });
      if (!this.isCurrent(generation)) {
        for (const source of sources) disposeObjectResources(source);
        return { state: 'disposed', placementCount: 0 };
      }

      for (const [index, descriptor] of this.descriptors.entries()) {
        const group = instancePlacements(sources[index], descriptor);
        configureVisualOnly(group);
        group.userData.developmentPropId = descriptor.id;
        this.root.add(group);
      }

      if (!this.isCurrent(generation)) {
        disposeObjectResources(this.root);
        this.root.clear();
        return { state: 'disposed', placementCount: 0 };
      }
      this.parent.add(this.root);
      this.abortController = null;
      this.state = 'installed';
      return {
        state: 'installed',
        placementCount: this.descriptors.reduce((count, descriptor) => count + descriptor.placements.length, 0),
      };
    } catch (error) {
      if (!this.isCurrent(generation)) {
        if (this.root.children.length > 0) {
          disposeObjectResources(this.root);
          this.root.clear();
        } else {
          for (const source of sources) disposeObjectResources(source);
        }
        return { state: 'disposed', placementCount: 0 };
      }
      this.abortController = null;
      this.state = 'failed';
      return { state: 'failed', placementCount: 0, error };
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state !== 'disposed' && generation === this.generation;
  }
}

function defaultParseGltf(data: ArrayBuffer, resourcePath: string): Promise<GLTF> {
  return new GLTFLoader().parseAsync(data, resourcePath);
}

function resourcePathFor(url: string): string {
  const base = typeof window === 'undefined' ? 'http://localhost/' : window.location.href;
  return new URL('.', new URL(url, base)).href;
}

/**
 * Spawn / capture near-field radius (XZ). Props beyond this stay lit and
 * receive shadows but skip the shadow map — CSM multiplies every caster.
 */
export const PROP_SHADOW_NEAR_RADIUS = 16;
/** Sub-metre scatter adds cost without a readable contact blob. */
export const PROP_SHADOW_MIN_SCALE = 0.98;

/**
 * Turns one CC0 source scene into a single colour InstancedMesh per surface
 * (every placement, no near/far colour split) plus one near-only caster from
 * the dominant opaque prim. Splitting colour by shadow bucket doubled draws
 * and would blow DrawBudget if the shipped aircon (4 GLTF prims) entered the
 * near radius.
 */
function instancePlacements(source: Object3D, descriptor: DevelopmentPropDescriptor): Group {
  const group = new Group();
  group.name = `DevelopmentCcoProp:${descriptor.id}`;
  const casting: Matrix4[] = [];
  const silent: Matrix4[] = [];
  for (const placement of descriptor.placements) {
    const matrix = new Matrix4().compose(
      new Vector3().fromArray(placement.position),
      new Quaternion().setFromEuler(new Euler(0, placement.rotationY ?? 0, 0)),
      new Vector3().setScalar(placement.scale ?? 1),
    );
    if (placementCastsShadow(placement)) casting.push(matrix);
    else silent.push(matrix);
  }
  const colour = [...casting, ...silent];
  if (colour.length === 0) return group;

  source.updateMatrixWorld(true);
  appendInstancedSurfaces(group, source, colour, false, 'colour');
  if (casting.length > 0) appendDominantCaster(group, source, casting);
  return group;
}

function placementCastsShadow(placement: DevelopmentPropPlacement): boolean {
  if ((placement.scale ?? 1) < PROP_SHADOW_MIN_SCALE) return false;
  const [x, , z] = placement.position;
  return (x * x + z * z) <= PROP_SHADOW_NEAR_RADIUS * PROP_SHADOW_NEAR_RADIUS;
}

function appendInstancedSurfaces(
  group: Group,
  source: Object3D,
  placements: readonly Matrix4[],
  castShadow: boolean,
  suffix: string,
): void {
  if (placements.length === 0) return;
  source.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    appendInstancedMesh(group, mesh, placements, castShadow, suffix);
  });
}

function appendDominantCaster(
  group: Group,
  source: Object3D,
  placements: readonly Matrix4[],
): void {
  let dominant: Mesh | null = null;
  let bestEdge = -1;
  source.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh || !mesh.geometry || isTransparentMesh(mesh)) return;
    const sphere = mesh.geometry.boundingSphere
      ?? (mesh.geometry.computeBoundingSphere(), mesh.geometry.boundingSphere);
    const edge = sphere ? sphere.radius * 2 : 0;
    if (edge > bestEdge) {
      bestEdge = edge;
      dominant = mesh;
    }
  });
  const caster = dominant;
  if (!caster) return;
  appendInstancedMesh(group, caster, placements, true, 'caster');
}

function appendInstancedMesh(
  group: Group,
  mesh: Mesh,
  placements: readonly Matrix4[],
  castShadow: boolean,
  suffix: string,
): void {
  const world = new Matrix4();
  const batch = new InstancedMesh(mesh.geometry, mesh.material, placements.length);
  batch.name = `${group.name}:${mesh.name || 'surface'}:${suffix}`;
  batch.instanceMatrix.setUsage(StaticDrawUsage);
  for (const [index, placement] of placements.entries()) {
    // The source mesh may sit inside its own hierarchy, so its local place in
    // the GLTF has to survive the move onto the placement transform.
    batch.setMatrixAt(index, world.copy(placement).multiply(mesh.matrixWorld));
  }
  batch.instanceMatrix.needsUpdate = true;
  batch.computeBoundingSphere();
  batch.castShadow = castShadow;
  batch.receiveShadow = true;
  group.add(batch);
}

function isTransparentMesh(mesh: Mesh): boolean {
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
  return materials.some((material) => material.transparent === true || material.opacity < 1);
}

function configureVisualOnly(root: Object3D): void {
  root.traverse((node) => {
    node.userData.developmentOnly = true;
    node.userData.visualOnly = true;
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    mesh.receiveShadow = true;
  });
}

function disposeObjectResources(root: Object3D): void {
  const geometries = new Set<import('three').BufferGeometry>();
  const materials = new Set<Material>();
  const textures = new Set<Texture>();
  root.traverse((node) => {
    const mesh = node as Mesh;
    if (!mesh.isMesh) return;
    geometries.add(mesh.geometry);
    const meshMaterials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of meshMaterials) {
      materials.add(material);
      for (const value of Object.values(material as unknown as Record<string, unknown>)) {
        if (value instanceof Texture) textures.add(value);
      }
    }
  });
  for (const geometry of geometries) geometry.dispose();
  for (const material of materials) material.dispose();
  for (const texture of textures) texture.dispose();
}
