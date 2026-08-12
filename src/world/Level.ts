import * as THREE from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { createSurfaceBatchResolver, equivalentEdge } from '../engine/StaticBatching';
import { LevelTextureKit } from './Textures';

export type AABB = { min: THREE.Vector3; max: THREE.Vector3 };

type SilhouetteWindowAxis = 'acrossX' | 'acrossZ';

type SilhouetteWindowBatch = {
  mesh: THREE.InstancedMesh;
  used: number;
  capacity: number;
};

/**
 * A single piece of static world geometry waiting to be merged. `node` is a
 * placement-only Object3D so callers can keep adjusting transform and shadow
 * flags after the helper returns, exactly as they did with real meshes.
 */
type StaticBatchEntry = {
  geometry: THREE.BufferGeometry;
  node: THREE.Object3D;
  material: THREE.Material;
};

const IDENTITY_ROTATION = new THREE.Quaternion();

const ARENA = 70;
const HALF = ARENA * 0.5;
/** Beyond this half-extent the arena gives way to the distant skyline ring. */
const CORE_HALF_EXTENT = 40;
/**
 * Equivalent cube edge a staged piece must reach to keep casting. Matches the
 * hostile / StaticBatching threshold so micro dressing never pays for CSM.
 */
const LEVEL_SHADOW_EXTENT = 0.1;
/**
 * XZ radius (from arena origin) inside which static pieces may cast. Beyond
 * this, colour density is unchanged but distant arena dressing drops out of
 * the shadow map — same idea as DevelopmentPropLayer's near-field props.
 */
const LEVEL_SHADOW_NEAR_RADIUS = 16;

/**
 * Dense original urban combat arena (~70u).
 * Cross-street layout with enterable structures, alleys, cover props,
 * rooftop access, and dusk-readable silhouettes on the perimeter.
 */
export class Level {
  readonly group = new THREE.Group();
  readonly colliders: AABB[] = [];
  readonly playerSpawn = new THREE.Vector3(0, 0, 0);
  readonly enemySpawns: THREE.Vector3[] = [];
  readonly coverNodes: THREE.Vector3[] = [];

  private readonly kit: LevelTextureKit;
  /** Merged output geometry owned by this level; sources are freed on build. */
  private readonly disposables: THREE.BufferGeometry[] = [];
  /**
   * The procedural arena is authored as ~2k individual boxes, cylinders and
   * decal shapes. They are all static and share ~25 kit materials, so nothing
   * is submitted per object: every piece is staged here and merged into one
   * mesh per material/shadow/render-order/region bucket before first render.
   */
  private readonly staticBatchEntries: StaticBatchEntry[] = [];
  /** Level-local materials that are not part of the shared texture kit. */
  private readonly ownedMaterials: THREE.Material[] = [];
  /**
   * Distant lit windows used to be thousands of identical visual-only meshes.
   * Keep four small material/axis families as instanced batches instead; they
   * do not participate in raycasts, collision, cover, or authored assembly.
   */
  private readonly silhouetteWindowBatches = new Map<string, SilhouetteWindowBatch[]>();
  private readonly silhouetteWindowMatrix = new THREE.Matrix4();
  /** Placements for the street practicals' additive halos, drawn as one batch. */
  private readonly lampGlowPlacements: Array<{ position: THREE.Vector3; scale: number }> = [];

  constructor(scene: THREE.Scene) {
    this.group.name = 'UrbanCombatLevel';
    this.kit = new LevelTextureKit();
    scene.add(this.group);

    this.buildGround();
    this.buildRoadMarkings();
    this.buildCurbsAndStreetFurniture();
    this.buildPerimeterWalls();
    this.buildBuildings();
    this.buildFacadeArticulation();
    this.buildForegroundStreetscape();
    this.buildSouthShopUrbanSetPiece();
    this.buildForegroundMaterialBreakup();
    this.buildAlleysAndCover();
    this.buildVehicles();
    this.buildCratesAndDebris();
    this.buildStairsAndRooftop();
    this.buildOverheadServices();
    this.buildStreetMicroDressing();
    this.buildRooftopSilhouetteDetail();
    this.buildPerimeterSilhouettes();
    this.finalizeSilhouetteWindowBatches();
    this.finalizeLampGlowBatch();
    this.finalizeStaticBatches();
    this.placeSpawnsAndCover();
  }

  /** Development-only, opt-in PBR enhancement for the procedural route. */
  loadDevelopmentPbrMaps() {
    return this.kit.loadDevelopmentPbrMaps();
  }

  dispose(): void {
    this.group.removeFromParent();
    this.group.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (mesh.isMesh) {
        const geo = mesh.geometry;
        if (geo && !this.disposables.includes(geo)) geo.dispose();
      }
    });
    for (const g of this.disposables) g.dispose();
    for (const entry of this.staticBatchEntries) entry.geometry.dispose();
    this.staticBatchEntries.length = 0;
    for (const material of this.ownedMaterials) material.dispose();
    this.ownedMaterials.length = 0;
    this.kit.dispose();
    this.colliders.length = 0;
    this.enemySpawns.length = 0;
    this.coverNodes.length = 0;
    this.silhouetteWindowBatches.clear();
  }

  // ── static batching ──────────────────────────────────────────────────

  /**
   * Records one static surface for merging. The returned node is never added
   * to the scene: it only carries the placement and shadow/render flags that
   * are read back when the batches are baked, so existing call sites can keep
   * mutating the "mesh" they were handed.
   */
  private stage(
    geometry: THREE.BufferGeometry,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): THREE.Object3D {
    const node = new THREE.Object3D();
    node.position.set(x, y, z);
    this.staticBatchEntries.push({ geometry, node, material });
    return node;
  }

  /**
   * Distant skyline blocks keep their own bucket per approach side so three
   * quarters of the ring can still be frustum-culled, while everything inside
   * the playable arena collapses into whole-map batches.
   */
  private static regionOf(position: THREE.Vector3): string {
    const { x, z } = position;
    if (Math.abs(x) <= CORE_HALF_EXTENT && Math.abs(z) <= CORE_HALF_EXTENT) return 'core';
    if (Math.abs(x) >= Math.abs(z)) return x < 0 ? 'ring:w' : 'ring:e';
    return z < 0 ? 'ring:n' : 'ring:s';
  }

  /**
   * Bakes every staged surface into one mesh per render-state bucket.
   * Shadow casters are pruned at bake time: pieces smaller than
   * `LEVEL_SHADOW_EXTENT` or farther than `LEVEL_SHADOW_NEAR_RADIUS` still
   * draw in colour (and may join a non-casting neighbour bucket) but skip the
   * CSM pass — distant / micro dressing is not worth a shadow submission.
   */
  private finalizeStaticBatches(): void {
    type Bucket = {
      material: THREE.Material;
      castShadow: boolean;
      receiveShadow: boolean;
      renderOrder: number;
      frustumCulled: boolean;
      maxEdge: number;
      geometries: THREE.BufferGeometry[];
    };
    const buckets = new Map<string, Bucket>();
    // Plain kit mates (trim / facade paint / safety / practicals) share one
    // SurfaceFamily so colour rides in vertex data instead of splitting draws.
    // preferPlainFamily keeps those mates off mapped families like camo tarp.
    const surfaces = createSurfaceBatchResolver({
      unifyPlainMaterials: true,
      preferPlainFamily: true,
      surfaceFamilies: this.kit.surfaceFamilies,
    });

    for (const entry of this.staticBatchEntries) {
      const { node, geometry, material } = entry;
      // Size is measured on the authored primitive before world bake — after
      // applyMatrix4 the bounds swallow the placement offset and every piece
      // looks huge.
      const edge = equivalentEdge(geometry);
      const xz = Math.hypot(node.position.x, node.position.z);
      const castShadow = node.castShadow
        && edge >= LEVEL_SHADOW_EXTENT
        && xz <= LEVEL_SHADOW_NEAR_RADIUS;
      node.updateMatrix();
      // Baking the placement into the vertices is what allows unrelated props
      // to share one draw; normals are corrected by the normal matrix.
      geometry.applyMatrix4(node.matrix);
      const resolved = surfaces.resolve(material);
      resolved.bake(geometry);
      const key = [
        resolved.identity,
        castShadow ? 1 : 0,
        node.receiveShadow ? 1 : 0,
        node.renderOrder,
        node.frustumCulled ? 1 : 0,
        Level.regionOf(node.position),
      ].join('|');
      const bucket = buckets.get(key);
      if (bucket) {
        bucket.geometries.push(geometry);
        bucket.maxEdge = Math.max(bucket.maxEdge, edge);
        continue;
      }
      buckets.set(key, {
        material: resolved.material,
        castShadow,
        receiveShadow: node.receiveShadow,
        renderOrder: node.renderOrder,
        frustumCulled: node.frustumCulled,
        maxEdge: edge,
        geometries: [geometry],
      });
    }
    this.staticBatchEntries.length = 0;

    let index = 0;
    for (const bucket of buckets.values()) {
      const merged = bucket.geometries.length === 1
        ? bucket.geometries[0]
        : mergeGeometries(bucket.geometries, false);
      if (!merged) throw new Error('Level static batch could not merge its source geometry');
      if (bucket.geometries.length > 1) {
        for (const source of bucket.geometries) source.dispose();
      }
      merged.computeBoundingSphere();
      const mesh = new THREE.Mesh(merged, bucket.material);
      mesh.name = `LevelStaticBatch:${index++}`;
      // Belt-and-braces with StaticBatching: a bucket that somehow only held
      // sub-extent leftovers loses its caster flag even if keyed as casting.
      mesh.castShadow = bucket.castShadow && bucket.maxEdge >= LEVEL_SHADOW_EXTENT;
      mesh.receiveShadow = bucket.receiveShadow;
      mesh.renderOrder = bucket.renderOrder;
      mesh.frustumCulled = bucket.frustumCulled;
      mesh.matrixAutoUpdate = false;
      mesh.userData.staticBatch = true;
      this.disposables.push(merged);
      this.group.add(mesh);
    }
  }

  // ── helpers ──────────────────────────────────────────────────────────

  private box(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    opts: { collide?: boolean; cast?: boolean; receive?: boolean; rotY?: number } = {},
  ): THREE.Object3D {
    const node = this.stage(new THREE.BoxGeometry(w, h, d), mat, x, y, z);
    if (opts.rotY) node.rotation.y = opts.rotY;
    node.castShadow = opts.cast !== false;
    node.receiveShadow = opts.receive !== false;

    if (opts.collide !== false) {
      this.addCollider(w, h, d, x, y, z, opts.rotY ?? 0);
    }
    return node;
  }

  private addCollider(
    w: number,
    h: number,
    d: number,
    x: number,
    y: number,
    z: number,
    rotY = 0,
  ): void {
    // Approximate rotated boxes with axis-aligned bounds (props are mostly axis-aligned).
    const c = Math.abs(Math.cos(rotY));
    const s = Math.abs(Math.sin(rotY));
    const hw = (w * c + d * s) * 0.5;
    const hd = (w * s + d * c) * 0.5;
    const hh = h * 0.5;
    this.colliders.push({
      min: new THREE.Vector3(x - hw, y - hh, z - hd),
      max: new THREE.Vector3(x + hw, y + hh, z + hd),
    });
  }

  private coverAt(x: number, y: number, z: number): void {
    this.coverNodes.push(new THREE.Vector3(x, y, z));
  }

  // ── ground / streets ─────────────────────────────────────────────────

  private buildGround(): void {
    const asphalt = this.kit.matAsphalt;
    const concrete = this.kit.matConcrete;
    const dirt = this.kit.matDirt;

    // Thick asphalt slab (top face at y=0) — must receive shadows or dusk sun
    // crushes midtones into a cool-blue void against the sky nadir.
    const ground = this.box(ARENA, 0.45, ARENA, 0, -0.225, 0, asphalt, {
      collide: true,
      cast: false,
      receive: true,
    });
    ground.name = 'GroundAsphalt';
    ground.receiveShadow = true;

    // Screenshot-proof street deck — Lambert + mild emissive so dusk still reads warm asphalt.
    const deck = this.stage(
      new THREE.PlaneGeometry(ARENA * 2.2, ARENA * 2.2),
      this.kit.matStreetDeck,
      0,
      0.04,
      0,
    );
    deck.rotation.x = -Math.PI * 0.5;
    deck.receiveShadow = true;
    deck.castShadow = false;
    deck.frustumCulled = false;
    deck.name = 'GroundAsphaltDeck';

    // Outer MeshBasic skirt — fallback fill beyond the lit deck.
    const skirtMat = new THREE.MeshBasicMaterial({
      color: 0x5a5044,
      fog: true,
    });
    this.ownedMaterials.push(skirtMat);
    const skirt = this.stage(
      new THREE.PlaneGeometry(ARENA * 5, ARENA * 5),
      skirtMat,
      0,
      0.01,
      0,
    );
    skirt.rotation.x = -Math.PI * 0.5;
    skirt.frustumCulled = false;
    skirt.name = 'GroundAsphaltSkirt';

    // Visible road grid removed — MeshBasic deck is the readable street surface.

    // Sidewalk strips along N-S street (X corridors)
    const swH = 0.2;
    this.box(3.2, swH, 52, -7.6, swH * 0.5, 0, concrete, { cast: false, receive: true });
    this.box(3.2, swH, 52, 7.6, swH * 0.5, 0, concrete, { cast: false, receive: true });

    // E-W street sidewalks
    this.box(40, swH, 3.2, 0, swH * 0.5, -7.6, concrete, { cast: false, receive: true });
    this.box(40, swH, 3.2, 0, swH * 0.5, 7.6, concrete, { cast: false, receive: true });

    // Corner plaza pads at intersection
    this.box(3.5, swH, 3.5, -7.6, swH * 0.5, -7.6, concrete, { cast: false, receive: true });
    this.box(3.5, swH, 3.5, 7.6, swH * 0.5, -7.6, concrete, { cast: false, receive: true });
    this.box(3.5, swH, 3.5, -7.6, swH * 0.5, 7.6, concrete, { cast: false, receive: true });
    this.box(3.5, swH, 3.5, 7.6, swH * 0.5, 7.6, concrete, { cast: false, receive: true });

    // Dirt patches in alleys / broken curb — sit flush on asphalt deck
    this.box(4, 0.1, 8, -18, 0.06, 18, dirt, { collide: false, cast: false, receive: true });
    this.box(6, 0.1, 4, 20, 0.06, -16, dirt, { collide: false, cast: false, receive: true });
    this.box(5, 0.1, 5, -22, 0.06, -20, dirt, { collide: false, cast: false, receive: true });
    this.box(3.5, 0.08, 3.5, 16, 0.05, 16, dirt, { collide: false, cast: false, receive: true });
    this.box(4, 0.08, 3, -8, 0.05, -22, dirt, { collide: false, cast: false, receive: true });

    // Wet road treatment along the first-contact lanes. Each pool is ringed by
    // a broader damp sheen so the transition from standing water to dry asphalt
    // is a gradient rather than a cut-out disc. All of it is visual-only: the
    // street collider is unchanged.
    const pools: Array<[number, number, number, number, number]> = [
      [-1.8, 10.4, 1.7, 0.36, 0.35],
      [3.8, -8.8, 1.35, 0.42, -0.2],
      [-9.4, -4.7, 1.1, 0.38, 0.7],
      [12.2, 8.4, 1.6, 0.34, -0.45],
      [-15.8, 13.1, 1.25, 0.42, 0.2],
      // The spawn sightline runs +Z down the centre street; these catch the
      // shop practicals and skyline directly in the opening frame.
      [2.4, 6.2, 2.05, 0.32, -0.15],
      [-4.6, 4.1, 1.45, 0.4, 0.55],
      [5.9, 17.6, 1.9, 0.3, 0.12],
      [-2.1, 19.8, 1.55, 0.36, -0.6],
      [8.7, 2.4, 1.3, 0.44, 0.25],
      [-11.5, 7.8, 1.7, 0.33, -0.3],
      [16.4, -3.6, 1.45, 0.38, 0.48],
      [-7.2, -13.4, 1.6, 0.35, -0.12],
      [10.6, -17.2, 1.2, 0.42, 0.62],
      [-19.4, -9.1, 1.5, 0.36, 0.08],
    ];
    for (const [x, z, radius, squash, rot] of pools) {
      this.wetSheen(x, z, radius * 2.15, squash * 1.05, rot);
      this.puddle(x, z, radius, squash, rot);
    }
  }

  /**
   * A broad, low-contrast damp area. It shares the puddle's ripple normal but
   * stays much rougher, so it reads as residual wetness rather than a second
   * pool stacked on the first.
   */
  private wetSheen(x: number, z: number, radius: number, squash: number, rot = 0): void {
    const node = this.stage(
      new THREE.CircleGeometry(radius, 16),
      this.kit.matWetSheen,
      x,
      0.048,
      z,
    );
    node.rotation.set(-Math.PI * 0.5, rot, 0);
    node.scale.set(1, squash, 1);
    node.castShadow = false;
    node.receiveShadow = true;
    node.renderOrder = 1;
  }

  /**
   * Additive halo billboard for a street practical. Sprites always face the
   * camera, so one cheap quad reads as light scattering in the dusk air from
   * every approach angle without a volumetric pass.
   */
  private lampGlow(x: number, y: number, z: number, scale: number): void {
    this.lampGlowPlacements.push({ position: new THREE.Vector3(x, y, z), scale });
  }

  /**
   * One additive draw for every street practical in the arena. Three's Sprite
   * is a mesh per halo; the same view-space billboarding is done here in the
   * vertex shader so the whole set is a single instanced submission, and the
   * halo reads identically because an additive blend is order-independent.
   */
  private finalizeLampGlowBatch(): void {
    if (this.lampGlowPlacements.length === 0) return;
    const source = this.kit.matLampGlow;
    const material = new THREE.MeshBasicMaterial({
      map: source.map,
      color: source.color,
      blending: source.blending,
      transparent: true,
      depthWrite: false,
      fog: true,
    });
    material.onBeforeCompile = (shader) => {
      shader.vertexShader = shader.vertexShader.replace(
        '#include <project_vertex>',
        `vec4 mvPosition = modelViewMatrix * instanceMatrix * vec4(0.0, 0.0, 0.0, 1.0);
         mvPosition.xy += transformed.xy
           * vec2(length(instanceMatrix[0].xyz), length(instanceMatrix[1].xyz));
         gl_Position = projectionMatrix * mvPosition;`,
      );
    };
    // Distinguishes the program from an ordinary basic material's.
    material.customProgramCacheKey = () => 'nightglass-lamp-glow';
    this.ownedMaterials.push(material);

    const geometry = new THREE.PlaneGeometry(1, 1);
    this.disposables.push(geometry);
    const mesh = new THREE.InstancedMesh(geometry, material, this.lampGlowPlacements.length);
    mesh.name = 'StreetPracticalGlow';
    mesh.userData.visualOnly = true;
    mesh.userData.authoredContract = false;
    // The halos are spread across the arena, so their shared bounding sphere is
    // never a useful cull; billboarding also makes the CPU-side bounds wrong.
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.renderOrder = 2;
    const matrix = new THREE.Matrix4();
    const scale = new THREE.Vector3();
    this.lampGlowPlacements.forEach((placement, index) => {
      matrix.compose(
        placement.position,
        IDENTITY_ROTATION,
        scale.setScalar(placement.scale),
      );
      mesh.setMatrixAt(index, matrix);
    });
    mesh.instanceMatrix.needsUpdate = true;
    this.group.add(mesh);
  }

  /** Visual-only low, irregular wet patches; they break the road's flat value at dusk. */
  private puddle(x: number, z: number, radius: number, squash: number, rot = 0): void {
    const node = this.stage(
      new THREE.CircleGeometry(radius, 18),
      this.kit.matPuddle,
      x,
      0.052,
      z,
    );
    node.rotation.set(-Math.PI * 0.5, rot, 0);
    node.scale.set(1, squash, 1);
    node.castShadow = false;
    node.receiveShadow = true;
    node.renderOrder = 2;
  }

  /** Small visual-only cylinder. Gameplay collision remains owned by the existing box layout. */
  private cylinder(
    radius: number,
    height: number,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    opts: { radialSegments?: number; rotZ?: number; rotX?: number } = {},
  ): THREE.Object3D {
    const node = this.stage(
      new THREE.CylinderGeometry(radius, radius, height, opts.radialSegments ?? 8),
      mat,
      x,
      y,
      z,
    );
    node.rotation.z = opts.rotZ ?? 0;
    node.rotation.x = opts.rotX ?? 0;
    node.castShadow = true;
    node.receiveShadow = true;
    return node;
  }

  /** A low-poly service cable adds a readable construction cue without a physics body. */
  private cable(points: THREE.Vector3[], radius: number, mat: THREE.Material): void {
    const curve = new THREE.CatmullRomCurve3(points, false, 'centripetal');
    const geo = new THREE.TubeGeometry(curve, Math.max(10, (points.length - 1) * 8), radius, 5, false);
    // Tube points are already world-space, so the placement node stays at origin.
    const node = this.stage(geo, mat, 0, 0, 0);
    node.castShadow = false;
    node.receiveShadow = false;
  }

  /** Soft dark disc so props / wrecks read as grounded (cheap contact AO). */
  private contactShadow(x: number, z: number, sx: number, sz: number, _opacity = 0.38): void {
    // The presentation deck sits at y=0.04.  Keep the fake contact AO just
    // above it so the soft footprint survives the depth test, while staying
    // entirely visual-only.
    const node = this.stage(
      new THREE.PlaneGeometry(sx, sz),
      this.kit.matContactShadow,
      x,
      0.046,
      z,
    );
    node.rotation.x = -Math.PI * 0.5;
    node.receiveShadow = false;
    node.castShadow = false;
    node.renderOrder = 1;
  }

  private buildRoadMarkings(): void {
    const m = this.kit.matRoadMark;
    // Center dashed line N-S — skip intersection for clean crosswalk
    for (let z = -24; z <= 24; z += 3.5) {
      if (Math.abs(z) < 4) continue;
      this.box(0.32, 0.04, 1.9, 0, 0.035, z, m, { collide: false, cast: false });
    }
    // Center dashed line E-W
    for (let x = -20; x <= 20; x += 3.5) {
      if (Math.abs(x) < 5) continue;
      this.box(1.9, 0.04, 0.32, x, 0.035, 0, m, { collide: false, cast: false });
    }
    // Crosswalk at intersection (N-S bars) — thick + emissive for spawn screenshot read
    for (let i = -3; i <= 3; i++) {
      this.box(0.55, 0.045, 5.0, i * 1.15, 0.038, 0, m, {
        collide: false,
        cast: false,
      });
    }
    // Secondary crosswalk bars on N/S approaches
    for (const zSign of [-1, 1]) {
      for (let i = -2; i <= 2; i++) {
        this.box(4.5, 0.04, 0.45, 0, 0.036, zSign * (3.4 + i * 0.55), m, {
          collide: false,
          cast: false,
        });
      }
    }
    // Stop lines
    this.box(3.8, 0.04, 0.4, 0, 0.034, 5.4, m, { collide: false, cast: false });
    this.box(3.8, 0.04, 0.4, 0, 0.034, -5.4, m, { collide: false, cast: false });
    // Spawn-facing lane chevrons (player looks -Z from z=12)
    for (let i = 0; i < 4; i++) {
      this.box(0.9, 0.042, 0.55, 0, 0.037, 9.5 - i * 1.4, m, {
        collide: false,
        cast: false,
      });
    }
    // E-W approach lane arrows — keep clear of spawn AABB [-2.5, 2.5]
    for (let i = 0; i < 3; i++) {
      this.box(0.55, 0.042, 0.9, 6.8 + i * 1.35, 0.037, 1.6, m, {
        collide: false,
        cast: false,
      });
      this.box(0.55, 0.042, 0.9, -(6.8 + i * 1.35), 0.037, -1.6, m, {
        collide: false,
        cast: false,
      });
    }
    // Short N approach arrow stubs just outside clear zone
    this.box(0.7, 0.042, 0.5, 0, 0.037, 3.6, m, { collide: false, cast: false });
    this.box(0.7, 0.042, 0.5, 0, 0.037, -3.6, m, { collide: false, cast: false });
  }

  private buildCurbsAndStreetFurniture(): void {
    const curb = this.kit.matConcreteDark;
    const trim = this.kit.matTrim;

    // Raised curb lips along sidewalks
    const curbH = 0.28;
    this.box(0.35, curbH, 48, -5.9, curbH * 0.5, 0, curb, { cast: false });
    this.box(0.35, curbH, 48, 5.9, curbH * 0.5, 0, curb, { cast: false });
    this.box(36, curbH, 0.35, 0, curbH * 0.5, -5.9, curb, { cast: false });
    this.box(36, curbH, 0.35, 0, curbH * 0.5, 5.9, curb, { cast: false });

    // Bollards near intersection corners
    const bollards: Array<[number, number]> = [
      [-5.2, -5.2],
      [5.2, -5.2],
      [-5.2, 5.2],
      [5.2, 5.2],
      [-5.2, 12],
      [5.2, -12],
      [-12, -5.2],
      [12, 5.2],
    ];
    for (const [x, z] of bollards) {
      this.box(0.28, 0.95, 0.28, x, 0.48, z, trim);
    }

    // Street light poles (visual cover + collision) — thin poles OK
    const poles: Array<[number, number]> = [
      [-6.5, -16],
      [6.5, -16],
      [-6.5, 16],
      [6.5, 16],
      [-16, -6.5],
      [16, -6.5],
      [-16, 6.5],
      [18, 10],
    ];
    for (const [x, z] of poles) {
      this.streetLight(x, z);
    }

    // Intersection streetlights — outside spawn clear zone [-2.5, 2.5]
    this.streetLight(-5.6, -8.2);
    this.streetLight(5.6, 8.2);

    // Manhole covers on asphalt
    const covers: Array<[number, number]> = [
      [2.5, 10],
      [-3, -14],
      [12, 1],
      [-10, -2],
      [1, 22],
      // Open intersection manhole — outside spawn clear zone
      [3.4, -3.2],
    ];
    for (const [x, z] of covers) {
      this.box(1.1, 0.06, 1.1, x, 0.04, z, this.kit.matMetal, {
        collide: false,
        cast: false,
        rotY: 0.3,
      });
    }

    // Broken curb chips near intersection corners (flat debris, no collide)
    const chips: Array<[number, number, number]> = [
      [-5.5, -4.0, 0.35],
      [-4.2, -5.5, -0.5],
      [5.4, 4.1, 0.6],
      [4.0, 5.5, -0.25],
      [-5.3, 4.3, 0.15],
      [5.5, -4.2, -0.4],
    ];
    for (const [x, z, rot] of chips) {
      this.box(0.42, 0.1, 0.28, x, 0.06, z, curb, {
        collide: false,
        cast: false,
        rotY: rot,
      });
      this.box(0.28, 0.08, 0.22, x + 0.35, 0.05, z + 0.2, this.kit.matConcrete, {
        collide: false,
        cast: false,
        rotY: rot + 0.7,
      });
    }
  }

  /** Thin pole + arm + emissive bulb. Collides as a skinny cylinder approx. */
  private streetLight(x: number, z: number): void {
    const trim = this.kit.matTrim;
    this.box(0.2, 5.2, 0.2, x, 2.6, z, trim);
    this.box(1.4, 0.12, 0.35, x + 0.55, 5.1, z, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.45, 0.18, 0.45, x + 1.1, 5.0, z, this.kit.matMetalRust, {
      collide: false,
    });
    // Hot bulb under the arm for dusk bloom
    this.box(0.28, 0.16, 0.28, x + 1.05, 4.88, z, this.kit.matLampBulb, {
      collide: false,
      cast: false,
      receive: false,
    });
    this.lampGlow(x + 1.05, 4.86, z, 1.95);
    // A dim pool of light on the pavement below completes the read; the lamp
    // otherwise floats as an isolated bright dot with no effect on the street.
    this.wetSheen(x + 1.05, z, 3.4, 1, 0);
  }

  /**
   * Overhead spans between the existing light poles. Catenary cables and their
   * hanging practicals are the single cheapest way to stop an orthogonal
   * blockout from reading as a box prototype: they cut diagonals across every
   * street sightline and give the upper third of the frame occupied depth.
   * None of this participates in collision, cover, or navigation.
   */
  private buildOverheadServices(): void {
    const spans: Array<[number, number, number, number, boolean]> = [
      // [x1, z1, x2, z2, hangs a practical at mid-span]
      [-6.5, -16, 6.5, -16, true],
      [-6.5, 16, 6.5, 16, true],
      [-16, -6.5, 16, -6.5, true],
      [-16, 6.5, -6.5, 16, false],
      [6.5, 16, 18, 10, false],
      [-5.6, -8.2, -6.5, -16, false],
      [5.6, 8.2, 6.5, 16, false],
    ];
    for (const [x1, z1, x2, z2, practical] of spans) {
      const midX = (x1 + x2) * 0.5;
      const midZ = (z1 + z2) * 0.5;
      const top = 4.62;
      const sag = top - 1.05;
      this.cable(
        [
          new THREE.Vector3(x1, top, z1),
          new THREE.Vector3(midX, sag, midZ),
          new THREE.Vector3(x2, top, z2),
        ],
        0.032,
        this.kit.matMetalRust,
      );
      // A slack secondary feed runs alongside the primary on real streets.
      this.cable(
        [
          new THREE.Vector3(x1, top - 0.26, z1),
          new THREE.Vector3(midX, sag - 0.42, midZ),
          new THREE.Vector3(x2, top - 0.26, z2),
        ],
        0.022,
        this.kit.matMetal,
      );
      if (!practical) continue;
      this.cylinder(0.022, 0.52, midX, sag - 0.28, midZ, this.kit.matMetal, { radialSegments: 5 });
      this.cylinder(0.34, 0.2, midX, sag - 0.6, midZ, this.kit.matMetalRust, { radialSegments: 10 });
      this.box(0.4, 0.09, 0.4, midX, sag - 0.72, midZ, this.kit.matLampBulb, {
        collide: false,
        cast: false,
        receive: false,
      });
      this.lampGlow(midX, sag - 0.74, midZ, 2.35);
      this.wetSheen(midX, midZ, 4.1, 1, 0);
    }
  }

  /**
   * Curb-to-curb micro-dressing that collapses into the existing kit material
   * batches: litter, trash bags, low wire runs, sidewalk wear, bollard chains,
   * and lamp-adjacent wet patches. It is concentrated on the +Z spawn
   * sightline and the intersection so dusk captures stop reading as a clean
   * box prototype. Visual-only throughout.
   */
  private buildStreetMicroDressing(): void {
    const noShadow = { collide: false, cast: false, receive: true };
    const curb = this.kit.matConcreteDark;
    const concrete = this.kit.matConcrete;
    const rust = this.kit.matMetalRust;
    const metal = this.kit.matMetal;
    const trim = this.kit.matTrim;
    const dirt = this.kit.matDirt;

    // ── bollard chains — sagging links between corner posts ─────────────
    const chainPairs: Array<[number, number, number, number]> = [
      [-5.2, -5.2, 5.2, -5.2],
      [-5.2, 5.2, 5.2, 5.2],
      [-5.2, -5.2, -5.2, 5.2],
      [5.2, -5.2, 5.2, 5.2],
      [-5.2, 12, 5.2, 12],
      [-12, -5.2, -12, 5.2],
    ];
    for (const [x1, z1, x2, z2] of chainPairs) {
      const midX = (x1 + x2) * 0.5;
      const midZ = (z1 + z2) * 0.5;
      const sag = Math.min(0.42, Math.hypot(x2 - x1, z2 - z1) * 0.07);
      this.cable(
        [
          new THREE.Vector3(x1, 0.54, z1),
          new THREE.Vector3(midX, 0.54 - sag, midZ),
          new THREE.Vector3(x2, 0.54, z2),
        ],
        0.018,
        trim,
      );
      this.cable(
        [
          new THREE.Vector3(x1, 0.49, z1),
          new THREE.Vector3(midX, 0.49 - sag * 0.88, midZ),
          new THREE.Vector3(x2, 0.49, z2),
        ],
        0.013,
        metal,
      );
    }

    // ── sidewalk crack / patch decals (east + west strips, spawn corridor) ─
    const sidewalkY = 0.214;
    const patchSpecs: Array<{
      points: Array<[number, number]>;
      x: number;
      z: number;
      mat: THREE.Material;
      name: string;
    }> = [
      {
        points: [[-0.46, -0.32], [0.22, -0.38], [0.44, 0.08], [-0.06, 0.36], [-0.52, 0.06]],
        x: 7.6,
        z: 7.8,
        mat: curb,
        name: 'SidewalkCrackEastSpawn',
      },
      {
        points: [[-0.38, -0.26], [0.28, -0.34], [0.36, 0.18], [-0.24, 0.32]],
        x: 7.6,
        z: 14.6,
        mat: concrete,
        name: 'SidewalkPatchEastShop',
      },
      {
        points: [[-0.52, -0.18], [-0.08, -0.42], [0.46, -0.24], [0.34, 0.28], [-0.36, 0.22]],
        x: -7.6,
        z: 5.4,
        mat: curb,
        name: 'SidewalkCrackWestSpawn',
      },
      {
        points: [[-0.34, -0.22], [0.42, -0.28], [0.48, 0.14], [0.02, 0.38], [-0.44, 0.12]],
        x: -7.6,
        z: 11.2,
        mat: this.kit.matPuddle,
        name: 'SidewalkSeepWest',
      },
      {
        points: [[-0.62, -0.12], [0.18, -0.28], [0.58, 0.06], [0.12, 0.34], [-0.48, 0.18]],
        x: 7.6,
        z: -4.8,
        mat: curb,
        name: 'SidewalkCrackEastCross',
      },
      {
        points: [[-0.28, -0.34], [0.36, -0.28], [0.42, 0.22], [-0.18, 0.36]],
        x: -7.6,
        z: -6.2,
        mat: concrete,
        name: 'SidewalkPatchWestCross',
      },
    ];
    for (const spec of patchSpecs) {
      this.raggedDecal(spec.points, spec.x, sidewalkY, spec.z, spec.mat, 'ground', spec.name);
    }

    // ── curb litter — flat scraps along both sidewalks ──────────────────
    const litter: Array<[number, number, number, number, number]> = [
      // [x, z, w, d, rotY] — y derived from sidewalk top
      [7.35, 3.2, 0.14, 0.09, 0.35],
      [7.82, 5.6, 0.11, 0.07, -0.5],
      [7.48, 9.1, 0.16, 0.1, 1.1],
      [7.9, 12.4, 0.12, 0.08, 0.2],
      [7.55, 16.8, 0.15, 0.09, -0.65],
      [7.7, 19.2, 0.1, 0.07, 0.85],
      [-7.42, 2.8, 0.13, 0.08, -0.3],
      [-7.78, 6.5, 0.11, 0.09, 0.55],
      [-7.5, 10.2, 0.14, 0.07, -1.0],
      [-7.85, 14.0, 0.12, 0.1, 0.15],
      [-7.38, 17.5, 0.15, 0.08, -0.45],
      [6.1, 0.6, 0.09, 0.06, 0.7],
      [-6.2, 1.1, 0.1, 0.07, -0.2],
    ];
    for (const [x, z, w, d, rot] of litter) {
      const mat = (Math.abs(x * 10 + z) % 3) === 0 ? rust : curb;
      this.box(w, 0.035, d, x, 0.218, z, mat, { ...noShadow, rotY: rot });
    }
    // Crumpled paper / cup silhouettes — slightly taller cylinders
    for (const [x, z, rot] of [
      [7.62, 8.3, 0.4],
      [-7.58, 13.6, -0.6],
      [7.44, 18.6, 1.2],
    ] as Array<[number, number, number]>) {
      this.cylinder(0.045, 0.08, x, 0.24, z, dirt, { radialSegments: 6, rotZ: rot });
    }

    // ── trash bags — lumpy dark bundles at curb edges ───────────────────
    const bags: Array<[number, number, number, number]> = [
      [7.15, 11.8, 0.25, 1],
      [-7.25, 8.6, -0.4, 0.92],
      [7.35, 17.4, 0.55, 1.05],
      [-7.4, 15.2, 0.15, 0.88],
      [-6.2, -3.5, -0.8, 0.95],
      [6.4, -2.8, 0.35, 1],
    ];
    for (const [x, z, rot, scale] of bags) {
      this.trashBag(x, z, rot, scale);
    }

    // ── low street-level wire / conduit runs ────────────────────────────
    const wireSpans: Array<[number, number, number, number, number]> = [
      // [x1, z1, x2, z2, height]
      [-6.5, 4, -6.5, 14, 3.15],
      [6.5, 6, 6.5, 16, 3.22],
      [-6.5, -10, -6.5, -2, 3.08],
      [6.5, -8, 6.5, 2, 3.18],
      [8.2, 13.5, 8.2, 18.8, 2.85],
      [-8.4, 12, -8.4, 17.5, 2.78],
    ];
    for (const [x1, z1, x2, z2, height] of wireSpans) {
      const midZ = (z1 + z2) * 0.5;
      const droop = height - 0.55;
      this.cable(
        [
          new THREE.Vector3(x1, height, z1),
          new THREE.Vector3(x1 + 0.08, droop, midZ),
          new THREE.Vector3(x1, height, z2),
        ],
        0.016,
        rust,
      );
      this.cable(
        [
          new THREE.Vector3(x1 + 0.12, height - 0.08, z1),
          new THREE.Vector3(x1 + 0.18, droop - 0.12, midZ),
          new THREE.Vector3(x1 + 0.12, height - 0.08, z2),
        ],
        0.011,
        metal,
      );
    }
    // A slack power drop from the nearest pole into the south-shop canopy zone.
    this.cable(
      [
        new THREE.Vector3(6.5, 4.55, 16),
        new THREE.Vector3(5.8, 3.4, 15.2),
        new THREE.Vector3(4.9, 2.85, 14.4),
        new THREE.Vector3(4.2, 2.62, 13.9),
      ],
      0.014,
      rust,
    );

    // ── wet puddle decals hugging street practicals on the spawn route ──
    const lampPools: Array<[number, number, number, number, number]> = [
      [5.6, 8.2, 2.6, 0.34, 0.12],
      [-5.6, 8.2, 2.4, 0.38, -0.18],
      [-6.5, 16, 3.1, 0.32, 0.05],
      [6.5, 16, 2.85, 0.36, -0.08],
      [-6.5, -16, 2.5, 0.4, 0.22],
      [6.5, -16, 2.55, 0.33, -0.15],
      [3, 13.1, 1.85, 0.42, 0.28],
    ];
    for (const [x, z, radius, squash, rot] of lampPools) {
      this.wetSheen(x, z, radius * 2.05, squash * 1.02, rot);
      this.puddle(x, z, radius * 0.72, squash, rot);
    }

    // ── curb-edge scuffs where tyres clip the lip ───────────────────────
    for (const [x, z, rot] of [
      [5.75, 4.2, 0.1],
      [-5.8, -3.6, -0.25],
      [5.85, 10.8, 0.45],
      [-5.7, 9.4, -0.15],
    ] as Array<[number, number, number]>) {
      this.box(0.55, 0.06, 0.22, x, 0.16, z, dirt, { ...noShadow, rotY: rot });
      this.box(0.38, 0.04, 0.16, x + 0.22, 0.14, z + 0.12, curb, { ...noShadow, rotY: rot + 0.4 });
    }

    // ── shallow grate / cable-tray strips crossing the south apron ──────
    for (const x of [-0.8, 2.4, 5.6]) {
      this.box(0.72, 0.012, 0.28, x, 0.108, 12.55, metal, noShadow);
      for (let i = -3; i <= 3; i++) {
        this.box(0.028, 0.014, 0.24, x + i * 0.085, 0.116, 12.55, rust, noShadow);
      }
    }

    // A short messenger line tying the west office facade into the pole grid.
    this.cable(
      [
        new THREE.Vector3(-16, 3.05, -6.5),
        new THREE.Vector3(-12.5, 2.55, -6.5),
        new THREE.Vector3(-8.8, 2.35, -4.2),
      ],
      0.015,
      metal,
    );

    // Contact grounding for the larger clusters above.
    for (const [x, z] of [[7.15, 11.8], [-7.25, 8.6], [7.35, 17.4]] as Array<[number, number]>) {
      this.contactShadow(x, z, 0.62, 0.58, 0.24);
    }
  }

  /** Irregular dark bundle read as a tied trash bag from gameplay distance. */
  private trashBag(x: number, z: number, rotY: number, scale = 1): void {
    const bag = this.kit.matConcreteDark;
    const trim = this.kit.matTrim;
    const noShadow = { collide: false, cast: false, receive: true };
    this.box(0.44 * scale, 0.26 * scale, 0.38 * scale, x, 0.23, z, bag, {
      ...noShadow,
      rotY,
    });
    this.box(0.38 * scale, 0.2 * scale, 0.34 * scale, x + 0.06 * scale, 0.39, z + 0.04, bag, {
      ...noShadow,
      rotY: rotY + 0.32,
    });
    this.box(0.12 * scale, 0.08 * scale, 0.1 * scale, x - 0.08, 0.48, z - 0.02, trim, noShadow);
  }

  /**
   * Roof-line clutter for the four playable shells. Their flat capping slabs
   * met the sky as clean horizontal edges, which is the strongest single
   * tell of untreated blockout massing in a dusk skyline shot.
   */
  private buildRooftopSilhouetteDetail(): void {
    const trim = this.kit.matTrim;
    const rust = this.kit.matMetalRust;
    const metal = this.kit.matMetal;
    const noShadow = { collide: false, cast: false, receive: true };
    const visual = { collide: false, cast: true, receive: true };

    // East warehouse roof (slab top ~5.65): duct run, dishes, and a mast.
    for (let i = 0; i < 5; i += 1) {
      this.cylinder(0.26, 1.6, 14.6 + i * 2.8, 6.1, 6.2, rust, {
        radialSegments: 8,
        rotZ: Math.PI * 0.5,
      });
    }
    this.box(0.5, 1.3, 0.5, 26.4, 6.4, -3.4, trim, visual);
    this.cylinder(0.06, 3.6, 26.4, 8.8, -3.4, trim, { radialSegments: 6 });
    this.satelliteDish(23.6, 6.2, 6.4, 0.62, -0.5);
    this.satelliteDish(15.4, 6.2, -3.8, 0.48, 0.9);

    // West office roof (slab top ~9.15) carries the tallest playable mass, so
    // its silhouette gets the most vertical interest.
    this.box(2.0, 1.1, 1.4, -25.4, 9.75, 3.2, metal, visual);
    this.box(2.2, 0.14, 1.6, -25.4, 10.37, 3.2, rust, noShadow);
    for (const z of [-6.2, -4.4, 6.4]) {
      this.cylinder(0.19, 1.15, -19.2, 9.78, z, rust, { radialSegments: 8 });
      this.cylinder(0.26, 0.09, -19.2, 10.4, z, trim, { radialSegments: 8 });
    }
    this.satelliteDish(-24.8, 9.5, -6.6, 0.72, 0.6);
    this.box(4.6, 0.12, 0.12, -22, 10.6, -2, trim, noShadow);
    for (const x of [-24, -22, -20]) {
      this.cylinder(0.045, 1.5, x, 9.9, -2, trim, { radialSegments: 5 });
    }

    // North apartment roof (parapet top ~7.55): water tank and aerial forest.
    this.cylinder(0.86, 1.5, 1.1, 7.6, -22.4, rust, { radialSegments: 12 });
    for (const [dx, dz] of [[-0.6, -0.6], [0.6, -0.6], [-0.6, 0.6], [0.6, 0.6]] as Array<[number, number]>) {
      this.cylinder(0.07, 0.9, 1.1 + dx, 6.95, -22.4 + dz, trim, { radialSegments: 5 });
    }
    for (const [x, z, height] of [
      [-8.6, -22.6, 2.4],
      [-9.4, -19.4, 1.7],
      [-1.8, -23.6, 2.1],
    ] as Array<[number, number, number]>) {
      this.cylinder(0.04, height, x, 6.75 + height * 0.5, z, trim, { radialSegments: 5 });
      this.box(0.9, 0.05, 0.05, x, 6.75 + height * 0.86, z, trim, noShadow);
      this.box(0.66, 0.05, 0.05, x, 6.75 + height * 0.68, z, trim, noShadow);
    }

    // South shop roof (slab top ~3.72) is closest to the spawn camera, so it
    // gets a low, dense service cluster rather than tall masts.
    this.box(1.1, 0.52, 0.86, 7.4, 4.0, 21.6, metal, visual);
    this.box(1.24, 0.08, 0.98, 7.4, 4.3, 21.6, rust, noShadow);
    for (const [x, z] of [[0.4, 22.8], [5.2, 23.4]] as Array<[number, number]>) {
      this.cylinder(0.15, 0.62, x, 4.05, z, rust, { radialSegments: 8 });
      this.cylinder(0.21, 0.07, x, 4.4, z, trim, { radialSegments: 8 });
    }
    this.satelliteDish(-1.4, 3.9, 20.4, 0.44, 2.4);
  }

  /** Visual-only dish: a shallow cone plus mount, read entirely by silhouette. */
  private satelliteDish(x: number, y: number, z: number, radius: number, rotY: number): void {
    const dish = this.stage(
      new THREE.SphereGeometry(radius, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.42),
      this.kit.matTrim,
      x,
      y + radius * 0.72,
      z,
    );
    dish.rotation.set(-2.1, rotY, 0);
    dish.castShadow = true;
    dish.receiveShadow = true;
    this.cylinder(0.05, radius * 1.5, x, y + radius * 0.4, z, this.kit.matMetalRust, {
      radialSegments: 5,
    });
    this.box(0.26, 0.06, 0.26, x, y + 0.03, z, this.kit.matConcreteDark, {
      collide: false,
      cast: false,
    });
  }

  private buildPerimeterWalls(): void {
    const mat = this.kit.matConcreteDark;
    const t = 1.2;
    const h = 4.5;
    this.box(ARENA + 2, h, t, 0, h * 0.5, -HALF - 0.2, mat);
    this.box(ARENA + 2, h, t, 0, h * 0.5, HALF + 0.2, mat);
    this.box(t, h, ARENA + 2, -HALF - 0.2, h * 0.5, 0, mat);
    this.box(t, h, ARENA + 2, HALF + 0.2, h * 0.5, 0, mat);

    // Cap / coping on perimeter for silhouette edge
    const cap = this.kit.matConcrete;
    this.box(ARENA + 2.4, 0.25, t + 0.3, 0, h + 0.1, -HALF - 0.2, cap, {
      cast: false,
    });
    this.box(ARENA + 2.4, 0.25, t + 0.3, 0, h + 0.1, HALF + 0.2, cap, {
      cast: false,
    });
    this.box(t + 0.3, 0.25, ARENA + 2.4, -HALF - 0.2, h + 0.1, 0, cap, {
      cast: false,
    });
    this.box(t + 0.3, 0.25, ARENA + 2.4, HALF + 0.2, h + 0.1, 0, cap, {
      cast: false,
    });
  }

  // ── five buildings ───────────────────────────────────────────────────

  private buildBuildings(): void {
    this.buildNorthApartment();
    this.buildEastWarehouse();
    this.buildSouthShop();
    this.buildWestOffice();
    this.buildRuinedCorner();
  }

  /**
   * Visual facade pass layered over the collision-first shells above.  Keeping
   * this separate makes the procedural fallback read as authored architecture
   * without changing any navigation, cover, or physics bounds.
   */
  private buildFacadeArticulation(): void {
    this.buildNorthApartmentFacade();
    this.buildEastWarehouseFacade();
    this.buildSouthShopFacade();
    this.buildWestOfficeFacade();
    this.buildRuinedCornerFacade();
  }

  /** North apartment — brick shell with cornices, pilasters, balcony variation. */
  private buildNorthApartmentFacade(): void {
    const trim = this.kit.matTrim;
    const painted = this.kit.matFacadePaint;
    const rust = this.kit.matMetalRust;
    const safety = this.kit.matSafetyPaint;
    const noShadow = { collide: false, cast: false, receive: true };
    const southZ = -15.05;
    const northZ = -24.88;
    const eastX = 2.88;
    const westX = -10.88;

    // Roof cornice and floor string course break the flat brick volume.
    this.box(14.4, 0.26, 0.28, -4, 6.48, southZ, this.kit.matConcreteDark, noShadow);
    this.box(14.2, 0.14, 0.16, -4, 3.22, southZ - 0.04, trim, noShadow);
    this.box(0.22, 6.35, 10.35, westX - 0.06, 3.18, -20, trim, noShadow);
    this.box(0.22, 6.35, 10.35, eastX + 0.06, 3.18, -20, trim, noShadow);

    // Pilasters with alternating capitals and rusted spall panels.
    for (const [x, cap] of [
      [-9.6, trim],
      [-7.1, this.kit.matConcreteDark],
      [-4.6, trim],
      [-2.1, this.kit.matConcreteDark],
      [0.4, trim],
    ] as Array<[number, THREE.Material]>) {
      this.box(0.18, 6.25, 0.18, x, 3.15, southZ - 0.12, trim, noShadow);
      this.box(0.52, 0.22, 0.22, x, 6.32, southZ - 0.16, cap, noShadow);
      this.box(0.38, 1.05, 0.06, x, 1.55, southZ - 0.14, rust, noShadow);
    }

    // Balcony rail variation: solid panels alternate with open pickets.
    for (let x = -8.8; x <= 0.8; x += 0.62) {
      const segment = Math.round((x + 8.8) / 0.62) % 3;
      if (segment === 0) {
        this.box(0.48, 0.82, 0.055, x, 3.82, -13.58, painted, noShadow);
      } else {
        this.box(0.055, 0.82, 0.055, x, 3.82, -13.58, trim, noShadow);
        if (segment === 1) {
          this.box(0.04, 0.38, 0.04, x, 3.62, -13.52, rust, noShadow);
        }
      }
    }
    this.box(10.8, 0.12, 0.18, -4, 4.28, -13.58, trim, noShadow);

    // Layered sign cassette with depth — warm practical segments, no text.
    this.box(4.35, 0.82, 0.11, -4, 5.02, southZ - 0.18, painted, noShadow);
    this.box(4.05, 0.58, 0.07, -4, 5.02, southZ - 0.24, this.kit.matPlaster, noShadow);
    this.box(3.55, 0.08, 0.1, -4, 5.38, southZ - 0.28, safety, noShadow);
    for (const x of [-5.4, -4.6, -3.8, -2.95, -2.15]) {
      this.box(0.34, 0.09, 0.025, x, 5.02, southZ - 0.30, this.kit.matLampBulb, noShadow);
    }

    this.cylinder(0.07, 5.9, 2.3, 3.05, -14.82, rust, { radialSegments: 6 });

    // East/west end panels and rain grime on the street face.
    for (const [x, z, face] of [
      [eastX + 0.05, -18.5, 'east'],
      [eastX + 0.05, -21.5, 'east'],
      [westX - 0.05, -17.8, 'west'],
      [westX - 0.05, -22.2, 'west'],
    ] as Array<[number, number, 'east' | 'west']>) {
      this.box(0.08, 2.4, 1.85, x, 2.2, z, rust, noShadow);
      this.facadeGrimeBand(1.6, x, 0.55, z, face);
    }
    for (const [x, y, h, seed] of [
      [-7.4, 4.8, 1.6, 11],
      [-2.8, 3.4, 2.1, 17],
      [-5.2, 1.2, 1.4, 23],
      [0.1, 2.6, 1.9, 29],
    ] as Array<[number, number, number, number]>) {
      this.facadeRainStreak(x, y, southZ - 0.02, h, 'south', seed);
    }
    this.facadeGrimeBand(12.8, -4, 0.42, southZ - 0.02, 'south');

    // Rear alley face — soot band and patched panels.
    this.box(13.8, 0.18, 0.14, -4, 0.62, northZ + 0.08, this.kit.matConcreteDark, noShadow);
    this.raggedDecal(
      [[-2.1, -0.35], [2.0, -0.42], [2.3, 0.38], [-1.8, 0.45]],
      -6.2,
      2.4,
      northZ + 0.06,
      painted,
      'north',
      'AptAlleyPatch',
    );
  }

  /** East warehouse — corrugated rhythm, dock pilasters, rusted infill. */
  private buildEastWarehouseFacade(): void {
    const trim = this.kit.matTrim;
    const painted = this.kit.matFacadePaint;
    const rust = this.kit.matMetalRust;
    const noShadow = { collide: false, cast: false, receive: true };
    const westX = 12.18;
    const northZ = -4.88;
    const southZ = 8.88;

    // Loading-door surround and horizontal panel seams.
    this.box(4.55, 3.65, 0.11, westX - 0.04, 1.82, 2, painted, noShadow);
    this.box(4.75, 0.16, 0.08, westX - 0.06, 3.52, 2, trim, noShadow);
    this.box(4.75, 0.12, 0.08, westX - 0.06, 0.18, 2, this.kit.matConcreteDark, noShadow);
    for (let y = 0.35; y < 3.4; y += 0.32) {
      this.box(0.07, 0.07, 4.12, westX - 0.08, y, 2, trim, noShadow);
    }

    // Vertical pilasters on the dock face and alternating rust infill bays.
    for (const z of [-4.2, -1.4, 1.5, 4.5, 7.2]) {
      this.box(0.24, 5.15, 0.14, westX - 0.10, 2.55, z, rust, noShadow);
      this.box(0.12, 4.8, 0.06, westX - 0.14, 2.4, z + 0.85, painted, noShadow);
    }

    // North/south end pilasters and roof cornice.
    for (const x of [14.2, 17.2, 20.2, 23.2, 26.2]) {
      this.box(0.22, 5.1, 0.12, x, 2.55, northZ - 0.06, rust, noShadow);
      this.box(2.56, 0.18, 0.13, x + 1.25, 5.0, northZ - 0.06, trim, noShadow);
      this.box(0.22, 5.1, 0.12, x, 2.55, southZ + 0.06, trim, noShadow);
      this.box(2.56, 0.16, 0.13, x + 1.25, 5.05, southZ + 0.06, painted, noShadow);
    }
    this.box(16.4, 0.22, 0.18, 20, 5.62, northZ - 0.08, trim, noShadow);
    this.box(16.4, 0.22, 0.18, 20, 5.62, southZ + 0.08, trim, noShadow);

    for (const [x, z] of [[17, -0.5], [22.8, 4.8], [25.3, -2.8]] as Array<[number, number]>) {
      this.cylinder(0.34, 0.38, x, 5.87, z, rust, { radialSegments: 10 });
      this.box(0.95, 0.08, 0.95, x, 6.08, z, trim, noShadow);
    }

    // Dock handrails and signage depth on the approach edge.
    for (const z of [-0.25, 4.25]) {
      this.cylinder(0.055, 1.2, westX + 0.12, 0.78, z, trim, { radialSegments: 6 });
    }
    this.box(0.08, 0.08, 4.7, westX + 0.12, 1.34, 2, trim, noShadow);
    this.box(2.8, 0.55, 0.09, westX - 0.12, 4.35, 2, painted, noShadow);
    this.box(2.6, 0.08, 0.07, westX - 0.14, 4.62, 2, this.kit.matSafetyPaint, noShadow);

    // Rain streaks and grime on the concrete mass.
    for (const [z, y, h, seed] of [
      [-3.2, 3.8, 1.5, 31],
      [0.8, 2.4, 2.0, 37],
      [5.1, 4.1, 1.7, 41],
    ] as Array<[number, number, number, number]>) {
      this.facadeRainStreak(westX - 0.03, y, z, h, 'west', seed);
    }
    this.facadeGrimeBand(14.2, 20, 0.48, northZ - 0.04, 'north');
    this.raggedDecal(
      [[-1.4, -0.28], [1.2, -0.34], [1.5, 0.22], [-1.1, 0.30]],
      26.5,
      2.2,
      southZ + 0.05,
      rust,
      'south',
      'WarehousePatch',
    );
  }

  /** South shop — side-wall panels; street frontage handled in foreground passes. */
  private buildSouthShopFacade(): void {
    const trim = this.kit.matTrim;
    const painted = this.kit.matFacadePaint;
    const rust = this.kit.matMetalRust;
    const safety = this.kit.matSafetyPaint;
    const noShadow = { collide: false, cast: false, receive: true };
    const northZ = 15.62;
    const eastX = 8.92;
    const westX = -2.92;
    const southZ = 24.38;

    // Street fascia layers and pilaster rhythm on the north face.
    this.box(11.0, 0.82, 0.12, 3, 3.02, northZ + 0.04, painted, noShadow);
    this.box(10.25, 0.1, 0.14, 3, 3.34, northZ + 0.08, trim, noShadow);
    this.box(11.2, 0.16, 0.10, 3, 3.58, northZ + 0.06, this.kit.matConcreteDark, noShadow);
    for (const x of [-1.6, 0.4, 5.6, 7.6]) {
      this.box(0.12, 1.7, 0.15, x, 1.45, northZ - 0.02, trim, noShadow);
      this.box(0.34, 0.08, 0.06, x, 2.28, northZ - 0.04, rust, noShadow);
    }
    for (const x of [-1.25, -0.85, 6.85, 7.25]) {
      this.box(0.09, 0.5, 0.12, x, 3.02, northZ + 0.12, safety, noShadow);
    }

    // East/west flank panels visible from the intersection.
    for (const [x, z, face] of [
      [eastX + 0.05, 18.4, 'east'],
      [eastX + 0.05, 21.6, 'east'],
      [westX - 0.05, 17.8, 'west'],
      [westX - 0.05, 22.1, 'west'],
    ] as Array<[number, number, 'east' | 'west']>) {
      this.box(0.10, 2.55, 2.2, x, 1.72, z, painted, noShadow);
      this.box(0.06, 0.12, 2.0, x, 3.02, z, trim, noShadow);
      this.facadeGrimeBand(1.8, x, 0.38, z, face);
    }

    // Rear service wall — rust louvers and soot band.
    this.box(11.4, 0.14, 0.12, 3, 0.55, southZ - 0.06, this.kit.matConcreteDark, noShadow);
    for (const x of [-0.8, 2.4, 6.0]) {
      this.box(1.45, 0.85, 0.08, x, 1.55, southZ - 0.08, rust, noShadow);
      for (let i = 0; i < 4; i += 1) {
        this.box(1.35, 0.04, 0.04, x, 1.25 + i * 0.18, southZ - 0.10, trim, noShadow);
      }
    }
    this.facadeRainStreak(5.2, 2.1, southZ - 0.04, 1.5, 'north', 43);
    this.facadeRainStreak(1.0, 2.6, southZ - 0.04, 1.8, 'north', 47);
  }

  /** West office — tiered cornices, recessed bays, service core depth. */
  private buildWestOfficeFacade(): void {
    const trim = this.kit.matTrim;
    const painted = this.kit.matFacadePaint;
    const rust = this.kit.matMetalRust;
    const noShadow = { collide: false, cast: false, receive: true };
    const eastX = -16.12;
    const northZ = -9.88;
    const southZ = 5.88;

    // Per-floor string courses and roof parapet on the east entrance face.
    for (const y of [3.05, 6.05, 9.05]) {
      this.box(12.3, 0.12, 0.14, -22, y, eastX + 0.04, trim, noShadow);
    }
    this.box(12.5, 0.28, 0.22, -22, 9.38, eastX + 0.06, this.kit.matConcreteDark, noShadow);

    // Pilasters and alternating recessed panel inserts.
    for (const z of [-6.8, -2.0, 2.8, 6.4]) {
      this.box(0.16, 8.8, 0.16, eastX - 0.08, 4.4, z, trim, noShadow);
      this.box(0.08, 2.4, 0.08, eastX - 0.12, 2.2, z + 1.1, painted, noShadow);
      this.box(0.08, 2.2, 0.08, eastX - 0.12, 6.8, z - 0.9, rust, noShadow);
    }

    // Recessed service core with conduit ladder and staggered panels.
    this.box(0.12, 6.4, 4.0, eastX - 0.14, 4.4, -2, painted, noShadow);
    this.box(0.08, 6.2, 3.7, eastX - 0.20, 4.4, -2, this.kit.matPlaster, noShadow);
    for (let z = -4.6; z <= 0.6; z += 0.72) {
      this.box(0.15, 0.07, 0.44, eastX - 0.22, 1.1 + (z + 4.6) * 0.72, z, trim, noShadow);
    }

    // North/south end cornices and rust patch panels.
    this.box(0.18, 9.1, 16.2, -22, 4.55, northZ - 0.06, trim, noShadow);
    this.box(0.18, 9.1, 16.2, -22, 4.55, southZ + 0.06, trim, noShadow);
    for (const z of [-5.5, 0.5, 5.5]) {
      this.box(0.10, 2.6, 2.4, eastX - 0.10, 2.0, z, rust, noShadow);
      this.facadeRainStreak(eastX - 0.04, 5.5, z, 2.2, 'west', 51 + Math.round(z));
    }

    this.cylinder(0.1, 4.5, -22, 11.25, -2, trim, { radialSegments: 6 });
    this.cylinder(0.05, 3.2, -22, 14.7, -2, trim, { radialSegments: 6, rotZ: 0.42 });
    this.cylinder(0.05, 3.2, -22, 14.7, -2, trim, { radialSegments: 6, rotZ: -0.42 });

    this.facadeGrimeBand(11.8, -22, 0.42, eastX - 0.02, 'west');
    this.raggedDecal(
      [[-2.0, -0.32], [1.8, -0.38], [2.1, 0.28], [-1.6, 0.36]],
      -24.5,
      5.2,
      northZ + 0.05,
      painted,
      'north',
      'OfficeAlleyPatch',
    );
  }

  /** Ruined corner — exposed reinforcement and patched infill on standing shells. */
  private buildRuinedCornerFacade(): void {
    const noShadow = { collide: false, cast: false, receive: true };
    const painted = this.kit.matFacadePaint;
    const rust = this.kit.matMetalRust;
    const southFaceZ = 15.12;

    this.box(9.6, 0.16, 0.12, -20, 4.65, southFaceZ, this.kit.matTrim, noShadow);
    for (const x of [-23.8, -20.2, -16.5]) {
      this.box(0.14, 3.2, 0.10, x, 2.4, southFaceZ - 0.06, rust, noShadow);
      this.facadeRainStreak(x, 3.8, southFaceZ - 0.02, 1.6, 'south', Math.round(x * 3));
    }
    this.raggedDecal(
      [[-0.8, -0.40], [0.9, -0.35], [0.7, 0.45], [-0.6, 0.38]],
      -18.2,
      3.1,
      southFaceZ - 0.04,
      painted,
      'south',
      'RuinPatch',
    );
    this.box(0.12, 4.8, 0.12, -14.88, 2.8, 20, rust, noShadow);
    this.facadeGrimeBand(8.5, -20, 0.38, southFaceZ - 0.02, 'south');
  }

  /** Low soot/grime band hugging the base of a facade face. */
  private facadeGrimeBand(
    width: number,
    x: number,
    y: number,
    z: number,
    face: 'north' | 'south' | 'east' | 'west',
  ): void {
    this.raggedDecal(
      [[-width * 0.5, -0.12], [width * 0.5, -0.10], [width * 0.48, 0.14], [-width * 0.46, 0.16]],
      x,
      y,
      z,
      this.kit.matConcreteDark,
      face,
      `GrimeBand:${face}:${Math.round(x * 10)}:${Math.round(z * 10)}`,
    );
  }

  /** Vertical rain-run decal using existing plaster/concrete materials. */
  private facadeRainStreak(
    x: number,
    y: number,
    z: number,
    height: number,
    face: 'north' | 'south' | 'east' | 'west',
    seed: number,
  ): void {
    const w = 0.06 + (seed % 4) * 0.012;
    const taper = 0.55 + (seed % 3) * 0.08;
    this.raggedDecal(
      [
        [-w, -height * 0.5],
        [w * taper, -height * 0.46],
        [w, height * 0.5],
        [-w * 0.7, height * 0.48],
      ],
      x,
      y,
      z,
      seed % 2 === 0 ? this.kit.matConcreteDark : this.kit.matFacadePaint,
      face,
      `RainStreak:${seed}`,
    );
  }

  /**
   * Capture-facing construction pass for the south approach.  It deliberately
   * treats the shop as one small, lived-in business (glazing, sign cassette,
   * canopy hardware and services), instead of hiding the blockout behind
   * unrelated prop scatter.  All geometry is presentation-only.
   */
  private buildForegroundStreetscape(): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const facadeZ = 15.20;

    // A dark plinth and aluminium head rail split the broad plaster shell into
    // a plausible storefront assembly.  These sit in front of, but never
    // replace, the existing door gap and collision shell.
    this.box(11.82, 0.46, 0.09, 3, 0.39, facadeZ, this.kit.matConcreteDark, noShadow);
    this.box(11.72, 0.09, 0.11, 3, 2.52, facadeZ - 0.015, this.kit.matMetal, noShadow);
    this.box(11.68, 0.07, 0.10, 3, 3.36, facadeZ, this.kit.matMetalRust, noShadow);

    // Inset brandless sign cassette: the warm segments read as bespoke
    // typography at gameplay distance without introducing trademarked text.
    this.box(6.45, 0.66, 0.07, 3, 3.03, facadeZ - 0.02, this.kit.matFacadePaint, noShadow);
    this.box(6.66, 0.08, 0.10, 3, 3.39, facadeZ - 0.04, this.kit.matMetal, noShadow);
    this.box(6.66, 0.08, 0.10, 3, 2.67, facadeZ - 0.04, this.kit.matMetal, noShadow);
    for (const x of [0.82, 1.55, 2.28, 3.72, 4.45, 5.18]) {
      this.box(0.40, 0.10, 0.025, x, 3.03, facadeZ - 0.075, this.kit.matLampBulb, noShadow);
    }
    // One broad halo over the cassette rather than six competing sprites: the
    // sign should read as a single illuminated element from the spawn view.
    this.lampGlow(3, 3.03, facadeZ - 0.6, 2.55);

    // Two glazed display bays deliberately leave the central entrance open.
    this.buildSouthShopDisplayBay(-0.38, 4.25, facadeZ);
    this.buildSouthShopDisplayBay(6.38, 4.25, facadeZ);

    // Asymmetric service door and meter bank stop the frontage reading as a
    // mirrored prop wall.  The shallow elements have no tactical ownership.
    this.box(0.64, 1.86, 0.075, -2.43, 1.26, facadeZ - 0.035, this.kit.matMetalRust, visual);
    for (let y = 0.48; y < 2.05; y += 0.25) {
      this.box(0.53, 0.036, 0.095, -2.43, y, facadeZ - 0.09, this.kit.matMetal, noShadow);
    }
    this.box(0.46, 0.68, 0.15, 8.28, 1.05, facadeZ - 0.03, this.kit.matMetal, visual);
    this.box(0.30, 0.10, 0.025, 8.28, 1.21, facadeZ - 0.12, this.kit.matWindowLitCool, noShadow);
    this.cylinder(0.048, 2.02, 8.62, 1.82, facadeZ - 0.06, this.kit.matMetalRust, {
      radialSegments: 6,
    });

    // Canopy edge, ribs and tension hardware create a clear near-field
    // silhouette in spawn/street captures while sharing the existing awning.
    this.box(10.42, 0.12, 0.18, 3, 2.59, 13.76, this.kit.matMetal, noShadow);
    for (const x of [-1.3, 0.6, 3.0, 5.4, 7.3]) {
      this.box(0.055, 0.055, 1.82, x, 2.66, 14.62, this.kit.matMetalRust, noShadow);
      this.cable(
        [
          new THREE.Vector3(x, 2.67, 13.80),
          new THREE.Vector3(x, 2.15, 14.52),
          new THREE.Vector3(x, 2.76, 15.16),
        ],
        0.026,
        this.kit.matMetal,
      );
    }

    // A pair of rain chains / utility feeds makes the facade feel attached to
    // the street rather than floating over its painted road surface.
    for (const x of [-1.72, 7.72]) {
      this.cylinder(0.05, 2.62, x, 1.31, 15.11, this.kit.matMetalRust, { radialSegments: 6 });
      this.box(0.28, 0.06, 0.34, x, 0.09, 15.11, this.kit.matConcreteDark, noShadow);
    }

    // Purposeful curb drainage on the south approach; grates make the street
    // plane materially legible but do not alter movement or cover.
    for (const x of [-1.45, 7.40]) this.buildStreetDrain(x, 13.78);
  }

  /**
   * A deliberately small, coherent street set-piece for the first approach to
   * the south shop.  It gives the shallow shop a believable construction
   * order—pavement, plinth, glazing, canopy, roof services—rather than trying
   * to camouflage the original shell with a field of unrelated props.  Every
   * element here is visual-only: the original hollow-building shell remains
   * the sole owner of collision, route, and cover data.
   */
  private buildSouthShopUrbanSetPiece(): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const frontZ = 15.14;

    // ── street threshold ──────────────────────────────────────────────
    // A single repaired loading apron establishes why the storefront is set
    // back from the road.  Expansion joints and a worn curb keep the first
    // ground plane from reading as one large, repeated asphalt card.
    this.box(12.72, 0.045, 2.76, 3.0, 0.070, 13.98, this.kit.matConcrete, noShadow);
    this.box(12.96, 0.082, 0.18, 3.0, 0.092, 12.67, this.kit.matConcreteDark, noShadow);
    this.box(12.66, 0.035, 0.075, 3.0, 0.104, 13.03, this.kit.matMetalRust, noShadow);
    for (const x of [-2.16, 0.28, 5.04, 7.76]) {
      this.box(0.038, 0.012, 2.48, x, 0.105, 13.93, this.kit.matConcreteDark, noShadow);
    }
    // Two service bollards are tied to the loading edge—not dropped into the
    // road as generic cover. They stay deliberately low and non-blocking.
    for (const x of [-1.54, 7.50]) {
      this.cylinder(0.105, 0.74, x, 0.43, 12.79, this.kit.matTrim, { radialSegments: 10 });
      this.cylinder(0.114, 0.055, x, 0.82, 12.79, this.kit.matSafetyPaint, { radialSegments: 10 });
      this.contactShadow(x, 12.79, 0.34, 0.34, 0.22);
    }

    // ── facade frame ──────────────────────────────────────────────────
    // Raise a shallow parapet rather than a second fake story. The staggered
    // panel inserts give the skyline-facing edge a useful silhouette while
    // preserving the small one-storey business read.
    this.box(12.24, 0.68, 0.24, 3.0, 3.74, frontZ + 0.10, this.kit.matConcreteDark, noShadow);
    this.box(11.72, 0.46, 0.050, 3.0, 3.74, frontZ - 0.032, this.kit.matFacadePaint, noShadow);
    this.box(12.52, 0.105, 0.30, 3.0, 4.11, frontZ + 0.08, this.kit.matTrim, noShadow);
    this.box(12.44, 0.085, 0.26, 3.0, 3.35, frontZ + 0.06, this.kit.matMetalRust, noShadow);
    for (const x of [-2.48, -0.08, 2.02, 4.78, 7.92]) {
      this.box(0.135, 0.82, 0.14, x, 3.74, frontZ - 0.010, this.kit.matTrim, noShadow);
      this.box(0.38, 0.065, 0.18, x, 4.18, frontZ + 0.04, this.kit.matConcrete, noShadow);
    }
    // Subtle, asymmetric service bands prevent a showroom-perfect sign wall
    // while avoiding text, logos, or a new authored asset requirement.
    this.box(2.10, 0.090, 0.028, -1.18, 3.72, frontZ - 0.075, this.kit.matLampBulb, noShadow);
    this.box(1.12, 0.090, 0.028, 6.22, 3.72, frontZ - 0.075, this.kit.matLampBulb, noShadow);

    // A blackened kickplate, sill returns, and a full-height central portal
    // create an actual storefront assembly. The opening itself remains empty
    // so the player never walks through a visual-only glass door.
    this.box(11.86, 0.22, 0.085, 3.0, 0.48, frontZ - 0.030, this.kit.matMetalRust, noShadow);
    for (const x of [1.72, 4.28]) {
      this.box(0.12, 2.06, 0.16, x, 1.45, frontZ - 0.08, this.kit.matTrim, visual);
    }
    this.box(2.74, 0.13, 0.16, 3.0, 2.46, frontZ - 0.08, this.kit.matTrim, visual);
    this.box(2.50, 0.065, 0.075, 3.0, 0.47, frontZ - 0.09, this.kit.matMetal, noShadow);
    this.box(0.074, 0.28, 0.075, 2.42, 1.42, frontZ - 0.13, this.kit.matMetal, noShadow);
    this.box(0.074, 0.28, 0.075, 3.58, 1.42, frontZ - 0.13, this.kit.matMetal, noShadow);

    // ── canopy / storefront construction rhythm ───────────────────────
    // The original slab canopy gets a pitched skin, a visible front valance,
    // and evenly spaced support ribs.  These intentionally follow the facade
    // bays instead of creating a second, unrelated rhythm.
    const canopy = this.box(10.88, 0.115, 2.28, 3.0, 2.70, 14.28, this.kit.matFacadePaint, visual);
    canopy.rotation.x = -0.065;
    this.box(10.98, 0.18, 0.105, 3.0, 2.56, 13.18, this.kit.matMetalRust, visual);
    this.box(10.68, 0.055, 0.060, 3.0, 2.42, 13.12, this.kit.matTrim, noShadow);
    for (const x of [-1.56, 0.04, 1.72, 4.30, 5.98, 7.56]) {
      const rib = this.box(0.060, 0.060, 2.06, x, 2.68, 14.22, this.kit.matTrim, noShadow);
      rib.rotation.x = -0.065;
      this.cable(
        [
          new THREE.Vector3(x, 2.54, 13.20),
          new THREE.Vector3(x, 2.17, 14.18),
          new THREE.Vector3(x, 2.60, frontZ - 0.03),
        ],
        0.018,
        this.kit.matMetal,
      );
    }
    // Warm pockets, tucked into the valance rather than spread across the
    // facade, make the feature read as practical illumination at dusk.
    for (const x of [-0.80, 0.66, 5.34, 6.82]) {
      this.box(0.52, 0.050, 0.09, x, 2.49, 13.11, this.kit.matLampBulb, noShadow);
      this.lampGlow(x, 2.46, 12.98, 1.05);
    }
    // Spill on the loading apron underneath ties the canopy to the ground.
    this.wetSheen(3.0, 13.4, 6.4, 0.5, 0);

    // ── attached utilities ────────────────────────────────────────────
    // A ladder, condenser, flue, and meter stack all belong to the same small
    // building.  They introduce diagonal / circular breakup without adding
    // free-standing objects or changing tactical space.
    for (const x of [-2.66, -2.30]) {
      this.box(0.055, 2.78, 0.060, x, 2.62, 15.02, this.kit.matMetalRust, noShadow);
    }
    for (let y = 1.46; y <= 3.76; y += 0.28) {
      this.box(0.47, 0.048, 0.058, -2.48, y, 14.99, this.kit.matTrim, noShadow);
    }
    this.box(1.64, 0.77, 1.06, -0.66, 3.79, 18.34, this.kit.matMetal, visual);
    this.box(1.82, 0.10, 1.24, -0.66, 4.22, 18.34, this.kit.matMetalRust, noShadow);
    for (const x of [-1.17, -0.82, -0.47, -0.12]) {
      this.box(0.055, 0.42, 0.045, x, 3.79, 17.80, this.kit.matTrim, noShadow);
    }
    this.cylinder(0.18, 0.56, 0.92, 4.37, 18.48, this.kit.matMetalRust, { radialSegments: 10 });
    this.cylinder(0.27, 0.075, 0.92, 4.69, 18.48, this.kit.matTrim, { radialSegments: 10 });
    this.cable(
      [
        new THREE.Vector3(-1.40, 3.50, 17.90),
        new THREE.Vector3(-1.72, 3.10, 16.78),
        new THREE.Vector3(-2.34, 2.62, 15.18),
      ],
      0.028,
      this.kit.matMetal,
    );

    // East-side service panel has depth, an isolator, and two bundled
    // conduits. It stays against the shop wall so it cannot read as scatter.
    this.box(0.075, 0.92, 0.68, 8.54, 1.36, 17.08, this.kit.matMetalRust, visual);
    this.box(0.035, 0.62, 0.46, 8.485, 1.36, 17.08, this.kit.matMetal, noShadow);
    this.box(0.045, 0.14, 0.16, 8.455, 1.54, 17.08, this.kit.matSafetyPaint, noShadow);
    for (const z of [16.84, 17.31]) {
      this.cylinder(0.038, 1.34, 8.43, 0.74, z, this.kit.matMetal, { radialSegments: 6 });
      this.cable(
        [
          new THREE.Vector3(8.42, 0.10, z),
          new THREE.Vector3(8.46, 0.72, z),
          new THREE.Vector3(8.42, 1.17, z),
        ],
        0.018,
        this.kit.matMetalRust,
      );
    }
  }

  /**
   * Low-frequency visual breakup for the route the player sees first.  This is
   * deliberately a handful of attached construction decisions rather than
   * generic prop scatter: roller housings, patched facade plates, and worn
   * pavement repairs explain the same storefront at multiple distances.  It
   * has no collision, cover, spawn, or authored-asset ownership.
   */
  private buildForegroundMaterialBreakup(): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const facadeZ = 15.065;

    // Two differently weathered shutter drums make the window bays read as
    // real openings with security hardware, rather than a single long glass
    // card. Their placement follows the existing display-bay centres.
    for (const [x, width, bracketOffset] of [
      [-0.38, 3.94, -0.46],
      [6.38, 3.86, 0.34],
    ] as Array<[number, number, number]>) {
      this.cylinder(0.105, width, x, 2.47, facadeZ, this.kit.matMetalRust, {
        radialSegments: 12,
        rotZ: Math.PI * 0.5,
      });
      this.box(width + 0.20, 0.055, 0.075, x, 2.58, facadeZ, this.kit.matTrim, noShadow);
      this.box(0.16, 0.22, 0.10, x + bracketOffset, 2.46, facadeZ - 0.024, this.kit.matMetal, visual);
      this.box(0.11, 1.74, 0.065, x - width * 0.5 + 0.07, 1.47, facadeZ, this.kit.matMetalRust, noShadow);
      this.box(0.11, 1.74, 0.065, x + width * 0.5 - 0.07, 1.47, facadeZ, this.kit.matMetalRust, noShadow);
    }

    // A few irregular, thin repair plates give the structural piers specific
    // history without adding signage, logos, or a new texture dependency.
    // They sit forward of the collision shell and remain visual-only.
    this.raggedDecal(
      [[-0.26, -0.62], [0.22, -0.55], [0.30, -0.08], [0.15, 0.50], [-0.22, 0.57], [-0.31, 0.04]],
      -2.35,
      1.36,
      facadeZ - 0.015,
      this.kit.matFacadePaint,
      'north',
      'ShopPierRepairLeft',
    );
    this.raggedDecal(
      [[-0.34, -0.42], [0.27, -0.49], [0.36, 0.16], [0.17, 0.43], [-0.29, 0.34]],
      8.17,
      1.72,
      facadeZ - 0.017,
      this.kit.matConcreteDark,
      'north',
      'ShopPierRepairRight',
    );
    this.raggedDecal(
      [[-0.54, -0.15], [-0.12, -0.28], [0.42, -0.16], [0.52, 0.16], [0.03, 0.26], [-0.47, 0.12]],
      6.82,
      3.78,
      facadeZ - 0.020,
      this.kit.matSafetyPaint,
      'north',
      'ShopParapetPatch',
    );

    // A service receiver and its short, offset conduit give the right-hand
    // edge a readable termination instead of another uninterrupted plaster
    // slab. Keep it attached above the loading apron, not in the play lane.
    this.box(0.34, 0.48, 0.105, 8.62, 2.97, facadeZ, this.kit.matMetalRust, visual);
    this.box(0.19, 0.045, 0.035, 8.62, 3.04, facadeZ - 0.065, this.kit.matLampBulb, noShadow);
    this.cable(
      [
        new THREE.Vector3(8.58, 2.78, facadeZ - 0.015),
        new THREE.Vector3(8.42, 2.52, facadeZ - 0.09),
        new THREE.Vector3(8.50, 2.28, facadeZ - 0.03),
      ],
      0.020,
      this.kit.matMetal,
    );

    // Broken polygon inlays avoid a decal-card silhouette on the apron. The
    // varied shape and non-parallel orientation are intentional: one old
    // trench repair, one sealed crack, and one utility access plate.
    this.raggedDecal(
      [[-1.45, -0.46], [-0.35, -0.62], [1.23, -0.35], [1.46, 0.14], [0.56, 0.48], [-0.86, 0.39], [-1.58, 0.04]],
      -0.54,
      0.111,
      13.64,
      this.kit.matConcreteDark,
      'ground',
      'ApronTrenchRepair',
    );
    this.raggedDecal(
      [[-1.04, -0.22], [-0.30, -0.46], [0.89, -0.31], [1.18, 0.09], [0.36, 0.31], [-0.72, 0.22]],
      6.10,
      0.112,
      14.34,
      this.kit.matPuddle,
      'ground',
      'ApronSealedCrack',
    );
    this.raggedDecal(
      [[-0.38, -0.28], [0.31, -0.33], [0.43, 0.18], [-0.20, 0.36], [-0.47, 0.06]],
      7.60,
      0.113,
      13.22,
      this.kit.matMetalRust,
      'ground',
      'ApronUtilityPlate',
    );
    for (const [x, z] of [[7.40, 13.02], [7.80, 13.02], [7.40, 13.42], [7.80, 13.42]] as Array<[number, number]>) {
      this.cylinder(0.038, 0.022, x, 0.126, z, this.kit.matTrim, { radialSegments: 8 });
    }

    // A deliberately sparse gutter line catches a thin highlight across the
    // nearest road surface. It gives the asphalt a composed foreground edge
    // without turning the whole street into repeated painted stripes.
    this.raggedDecal(
      [[-2.50, -0.10], [-1.26, -0.17], [0.06, -0.08], [1.42, -0.15], [2.34, 0.08], [0.72, 0.18], [-1.74, 0.12]],
      1.34,
      0.057,
      11.78,
      this.kit.matPuddle,
      'ground',
      'SouthGutterWetBreakup',
    );
  }

  /**
   * Tiny deterministic polygon overlays provide non-rectangular repair and
   * wear silhouettes with existing procedural materials. This is intentionally
   * separate from `box`: decals never become collision or cover geometry.
   */
  private raggedDecal(
    points: Array<[number, number]>,
    x: number,
    y: number,
    z: number,
    mat: THREE.Material,
    surface: 'ground' | 'north' | 'south' | 'east' | 'west',
    name: string,
  ): THREE.Object3D {
    const shape = new THREE.Shape();
    const [firstX, firstY] = points[0];
    shape.moveTo(firstX, firstY);
    for (let index = 1; index < points.length; index += 1) {
      shape.lineTo(points[index][0], points[index][1]);
    }
    shape.closePath();
    const node = this.stage(new THREE.ShapeGeometry(shape), mat, x, y, z);
    node.name = name;
    // ShapeGeometry faces +Z. Orient each overlay toward its outward normal.
    if (surface === 'ground') node.rotation.x = -Math.PI * 0.5;
    else if (surface === 'north') node.rotation.y = Math.PI;
    else if (surface === 'east') node.rotation.y = -Math.PI * 0.5;
    else if (surface === 'west') node.rotation.y = Math.PI * 0.5;
    node.castShadow = false;
    node.receiveShadow = surface === 'ground';
    node.renderOrder = 3;
    return node;
  }

  /** Shallow glass bay with enough internal hierarchy to avoid opaque window cards. */
  private buildSouthShopDisplayBay(x: number, width: number, z: number): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const left = x - width * 0.5;
    const right = x + width * 0.5;

    this.box(width, 2.02, 0.034, x, 1.47, z - 0.006, this.kit.matGlassBroken, noShadow);
    this.box(width + 0.12, 0.075, 0.12, x, 2.48, z - 0.045, this.kit.matTrim, noShadow);
    this.box(width + 0.12, 0.075, 0.12, x, 0.46, z - 0.045, this.kit.matTrim, noShadow);
    for (const mx of [left, x, right]) {
      this.box(0.075, 2.12, 0.12, mx, 1.47, z - 0.045, this.kit.matTrim, noShadow);
    }

    // Back-set shelves and product silhouettes keep the glass from becoming a
    // uniformly bright plane.  They are contained inside each bay's width.
    for (const y of [0.87, 1.50, 2.12]) {
      this.box(width - 0.24, 0.065, 0.18, x, y, z + 0.19, this.kit.matMetalRust, visual);
    }
    for (const [offset, y, w, h, mat] of [
      [-0.88, 0.68, 0.36, 0.30, this.kit.matFacadePaint],
      [-0.34, 0.69, 0.28, 0.42, this.kit.matWood],
      [0.31, 0.69, 0.38, 0.32, this.kit.matSafetyPaint],
      [0.86, 0.69, 0.28, 0.40, this.kit.matWood],
      [-0.72, 1.30, 0.34, 0.38, this.kit.matWood],
      [-0.10, 1.30, 0.42, 0.30, this.kit.matFacadePaint],
      [0.56, 1.30, 0.30, 0.43, this.kit.matSafetyPaint],
    ] as Array<[number, number, number, number, THREE.Material]>) {
      const clamped = THREE.MathUtils.clamp(offset, -width * 0.5 + 0.26, width * 0.5 - 0.26);
      this.box(w, h, 0.19, x + clamped, y, z + 0.12, mat, visual);
    }
  }

  /** Repeated engineered drainage beats the approach, rather than scatter clutter. */
  private buildStreetDrain(x: number, z: number): void {
    const noShadow = { collide: false, cast: false, receive: true };
    this.box(1.20, 0.018, 0.34, x, 0.058, z, this.kit.matConcreteDark, noShadow);
    this.box(1.08, 0.012, 0.24, x, 0.067, z, this.kit.matMetal, noShadow);
    for (let i = -4; i <= 4; i++) {
      this.box(0.035, 0.014, 0.22, x + i * 0.105, 0.074, z, this.kit.matMetalRust, noShadow);
    }
  }

  /** Hollow shell: exterior walls with door gap; optional interior divider. */
  private hollowBuilding(opts: {
    cx: number;
    cz: number;
    w: number;
    d: number;
    floors: number;
    floorH: number;
    wall: number;
    mat: THREE.Material;
    roofMat?: THREE.Material;
    doorFace: 'n' | 's' | 'e' | 'w';
    doorW?: number;
    doorH?: number;
    windows?: boolean;
  }): void {
    const {
      cx,
      cz,
      w,
      d,
      floors,
      floorH,
      wall,
      mat,
      doorFace,
      doorW = 1.6,
      doorH = 2.2,
    } = opts;
    const roofMat = opts.roofMat ?? this.kit.matConcreteDark;
    const totalH = floors * floorH;
    const hw = w * 0.5;
    const hd = d * 0.5;

    // Floor slab
    this.box(w - 0.2, 0.25, d - 0.2, cx, 0.12, cz, this.kit.matConcrete, {
      cast: false,
    });

    // Roof
    this.box(w + 0.4, 0.35, d + 0.4, cx, totalH + 0.15, cz, roofMat);

    // Intermediate floors (ceilings)
    for (let f = 1; f < floors; f++) {
      this.box(w - wall * 2, 0.2, d - wall * 2, cx, f * floorH, cz, this.kit.matConcrete, {
        cast: false,
      });
    }

    const makeWallSeg = (
      ww: number,
      wh: number,
      wd: number,
      x: number,
      y: number,
      z: number,
    ) => this.box(ww, wh, wd, x, y, z, mat);

    // North wall
    {
      const z = cz - hd + wall * 0.5;
      if (doorFace === 'n') {
        const side = (w - doorW) * 0.5;
        makeWallSeg(side, totalH, wall, cx - (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(side, totalH, wall, cx + (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(doorW, totalH - doorH, wall, cx, doorH + (totalH - doorH) * 0.5, z);
        this.doorFrame(cx, z, doorW, doorH, 'n');
      } else {
        makeWallSeg(w, totalH, wall, cx, totalH * 0.5, z);
      }
    }
    // South wall
    {
      const z = cz + hd - wall * 0.5;
      if (doorFace === 's') {
        const side = (w - doorW) * 0.5;
        makeWallSeg(side, totalH, wall, cx - (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(side, totalH, wall, cx + (doorW * 0.5 + side * 0.5), totalH * 0.5, z);
        makeWallSeg(doorW, totalH - doorH, wall, cx, doorH + (totalH - doorH) * 0.5, z);
        this.doorFrame(cx, z, doorW, doorH, 's');
      } else {
        makeWallSeg(w, totalH, wall, cx, totalH * 0.5, z);
      }
    }
    // West wall
    {
      const x = cx - hw + wall * 0.5;
      if (doorFace === 'w') {
        const side = (d - doorW) * 0.5;
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz - (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz + (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH - doorH, doorW, x, doorH + (totalH - doorH) * 0.5, cz);
        this.doorFrame(x, cz, doorW, doorH, 'w');
      } else {
        makeWallSeg(wall, totalH, d, x, totalH * 0.5, cz);
      }
    }
    // East wall
    {
      const x = cx + hw - wall * 0.5;
      if (doorFace === 'e') {
        const side = (d - doorW) * 0.5;
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz - (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH, side, x, totalH * 0.5, cz + (doorW * 0.5 + side * 0.5));
        makeWallSeg(wall, totalH - doorH, doorW, x, doorH + (totalH - doorH) * 0.5, cz);
        this.doorFrame(x, cz, doorW, doorH, 'e');
      } else {
        makeWallSeg(wall, totalH, d, x, totalH * 0.5, cz);
      }
    }

    if (opts.windows) {
      this.addWindowRow(cx, cz, w, d, floors, floorH, wall);
    }
  }

  private doorFrame(
    a: number,
    b: number,
    doorW: number,
    doorH: number,
    face: 'n' | 's' | 'e' | 'w',
  ): void {
    const trim = this.kit.matTrim;
    const t = 0.12;
    if (face === 'n' || face === 's') {
      const z = b + (face === 's' ? 0.08 : -0.08);
      this.box(doorW + 0.25, t, t, a, doorH + 0.05, z, trim, { collide: false });
      this.box(t, doorH, t, a - doorW * 0.5 - 0.05, doorH * 0.5, z, trim, {
        collide: false,
      });
      this.box(t, doorH, t, a + doorW * 0.5 + 0.05, doorH * 0.5, z, trim, {
        collide: false,
      });
    } else {
      const x = a + (face === 'e' ? 0.08 : -0.08);
      this.box(t, t, doorW + 0.25, x, doorH + 0.05, b, trim, { collide: false });
      this.box(t, doorH, t, x, doorH * 0.5, b - doorW * 0.5 - 0.05, trim, {
        collide: false,
      });
      this.box(t, doorH, t, x, doorH * 0.5, b + doorW * 0.5 + 0.05, trim, {
        collide: false,
      });
    }
  }

  private addWindowRow(
    cx: number,
    cz: number,
    w: number,
    d: number,
    floors: number,
    floorH: number,
    wall: number,
  ): void {
    const glass = this.kit.matGlassBroken;
    const lit = this.kit.matWindowLit;
    const litCool = this.kit.matWindowLitCool;
    const trim = this.kit.matTrim;
    const hw = w * 0.5;
    const hd = d * 0.5;

    const placeWindow = (
      wx: number,
      wy: number,
      wz: number,
      ww: number,
      wh: number,
      wd: number,
      litMat: THREE.Material,
      skipLit: boolean,
    ) => {
      // Emissive pane behind glass — dusk facade readability
      if (!skipLit) {
        this.box(ww * 0.92, wh * 0.92, Math.max(0.04, wd * 0.6), wx, wy, wz, litMat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
      this.box(ww, wh, wd, wx, wy, wz, glass, {
        collide: false,
        cast: false,
        receive: false,
      });
      // Frame
      const ft = 0.08;
      if (wd >= ww) {
        // Facing ±X (vertical wall along Z)
        this.box(wd + 0.04, ft, ww + 0.12, wx, wy + wh * 0.5 + 0.02, wz, trim, {
          collide: false,
          cast: false,
        });
        this.box(wd + 0.04, ft, ww + 0.12, wx, wy - wh * 0.5 - 0.02, wz, trim, {
          collide: false,
          cast: false,
        });
      } else {
        this.box(ww + 0.12, ft, wd + 0.04, wx, wy + wh * 0.5 + 0.02, wz, trim, {
          collide: false,
          cast: false,
        });
        this.box(ww + 0.12, ft, wd + 0.04, wx, wy - wh * 0.5 - 0.02, wz, trim, {
          collide: false,
          cast: false,
        });
        this.box(ft, wh + 0.08, wd + 0.04, wx - ww * 0.5, wy, wz, trim, {
          collide: false,
          cast: false,
        });
        this.box(ft, wh + 0.08, wd + 0.04, wx + ww * 0.5, wy, wz, trim, {
          collide: false,
          cast: false,
        });
      }
    };

    const board = this.kit.matWood;
    const sill = this.kit.matConcreteDark ?? this.kit.matConcrete;
    const acMat = this.kit.matMetalRust;

    for (let f = 0; f < floors; f++) {
      const y = f * floorH + floorH * 0.55;
      const warm = (f + Math.round(cx + cz)) % 3 !== 0;
      const pane = warm ? lit : litCool;

      // South + north faces — irregular columns, mixed sizes, boarded panes,
      // and occasional AC units so the grid stops reading as a repeated stamp.
      const xCount = Math.max(2, Math.min(4, Math.floor(w / 3.2)));
      const xStep = Math.min(2.1, w / (xCount * 2 + 1));
      for (let i = -xCount; i <= xCount; i++) {
        if (i === 0 && f === 0) continue; // door clearance
        const hash = Math.abs((i * 17 + f * 31 + Math.round(cx * 3 + cz * 5)) % 11);
        const ww = 1.05 + (hash % 3) * 0.12;
        const wh = 1.15 + ((hash + 2) % 3) * 0.1;
        const wx = cx + i * xStep + ((hash % 2) - 0.5) * 0.08;
        const zs = cz + hd - wall * 0.15;
        const zn = cz - hd + wall * 0.15;
        const skipLitS = hash === 0 || hash === 7;
        const skipLitN = hash === 3 || hash === 9;
        placeWindow(wx, y, zs, ww, wh, 0.1, pane, skipLitS);
        placeWindow(wx, y, zn, ww, wh, 0.1, pane, skipLitN);
        // Sill ledge
        this.box(ww + 0.18, 0.06, 0.14, wx, y - wh * 0.5 - 0.04, zs + 0.04, sill, {
          collide: false,
          cast: false,
        });
        this.box(ww + 0.18, 0.06, 0.14, wx, y - wh * 0.5 - 0.04, zn - 0.04, sill, {
          collide: false,
          cast: false,
        });
        // Boarded / dark panes
        if (skipLitS && hash % 2 === 0) {
          this.box(ww * 0.88, wh * 0.88, 0.05, wx, y, zs + 0.02, board, {
            collide: false,
            cast: false,
          });
        }
        // Window AC under a subset of south panes
        if (hash === 2 || hash === 5) {
          this.box(0.55, 0.38, 0.48, wx, y - wh * 0.5 - 0.28, zs + 0.28, acMat, {
            collide: false,
            cast: false,
          });
        }
        // Vertical mullion on larger panes
        if (ww > 1.15) {
          this.box(0.05, wh * 0.92, 0.06, wx, y, zs + 0.02, trim, {
            collide: false,
            cast: false,
          });
          this.box(0.05, wh * 0.92, 0.06, wx, y, zn - 0.02, trim, {
            collide: false,
            cast: false,
          });
        }
      }

      // East + west faces
      const zCount = Math.max(2, Math.min(4, Math.floor(d / 3.2)));
      const zStep = Math.min(2.0, d / (zCount * 2 + 1));
      for (let i = -zCount; i <= zCount; i++) {
        if (i === 0 && f === 0 && floors <= 1) continue;
        const hash = Math.abs((i * 13 + f * 41 + Math.round(cx * 7 - cz * 3)) % 11);
        const wd = 1.0 + (hash % 3) * 0.1;
        const wh = 1.1 + ((hash + 1) % 3) * 0.08;
        const wz = cz + i * zStep + ((hash % 2) - 0.5) * 0.06;
        const xe = cx + hw - wall * 0.15;
        const xw = cx - hw + wall * 0.15;
        placeWindow(xe, y, wz, 0.1, wh, wd, pane, hash === 1 || hash === 8);
        placeWindow(xw, y, wz, 0.1, wh, wd, pane, hash === 4 || hash === 6);
        if (hash === 2) {
          this.box(0.42, 0.34, 0.5, xe + 0.26, y - wh * 0.5 - 0.24, wz, acMat, {
            collide: false,
            cast: false,
          });
        }
      }
    }
  }

  private buildNorthApartment(): void {
    this.hollowBuilding({
      cx: -4,
      cz: -20,
      w: 14,
      d: 10,
      floors: 2,
      floorH: 3.2,
      wall: 0.45,
      mat: this.kit.matBrick,
      doorFace: 's',
      doorW: 2.0,
      windows: true,
    });
    // Interior cover pillar + clutter
    this.box(1.2, 3.0, 1.2, -4, 1.5, -20, this.kit.matConcrete);
    this.box(0.9, 1.1, 0.9, -1.5, 0.55, -21, this.kit.matWood, { rotY: 0.4 });
    this.box(1.6, 0.9, 0.7, -7, 0.45, -18.5, this.kit.matMetalRust);
    this.coverAt(-1, 0, -16.5);
    this.coverAt(-7, 0, -16.5);
    // Balcony ledge on south face floor 2
    this.box(10, 0.25, 1.4, -4, 3.3, -14.4, this.kit.matConcrete);
    this.box(10, 1.0, 0.15, -4, 3.9, -13.75, this.kit.matMetal);
    // AC units on balcony
    this.box(1.2, 0.7, 0.8, -7, 3.75, -14.2, this.kit.matMetal, { collide: false });
    this.box(1.2, 0.7, 0.8, -1, 3.75, -14.2, this.kit.matMetalRust, { collide: false });
    // Facade drainpipe
    this.box(0.18, 6.2, 0.18, 2.6, 3.1, -14.7, this.kit.matMetalRust, {
      collide: false,
    });
    // Signboard
    this.box(3.5, 1.0, 0.12, -4, 4.8, -14.5, this.kit.matTrim, { collide: false });
  }

  private buildEastWarehouse(): void {
    this.hollowBuilding({
      cx: 20,
      cz: 2,
      w: 16,
      d: 14,
      floors: 1,
      floorH: 5.5,
      wall: 0.5,
      mat: this.kit.matConcrete,
      roofMat: this.kit.matMetalRust,
      doorFace: 'w',
      doorW: 4.5,
      doorH: 3.8,
      windows: true,
    });
    // High industrial lit clerestory windows (N/S/E) — denser for dusk skyline
    const lit = this.kit.matWindowLit;
    const cool = this.kit.matWindowLitCool;
    for (let i = -3; i <= 3; i++) {
      if (i === 0) continue;
      this.box(1.5, 1.2, 0.12, 20 + i * 2.1, 4.2, 2 + 7 - 0.3, i % 2 ? lit : cool, {
        collide: false,
        cast: false,
      });
      this.box(1.5, 1.2, 0.12, 20 + i * 2.1, 4.2, 2 - 7 + 0.3, i % 2 ? cool : lit, {
        collide: false,
        cast: false,
      });
    }
    for (let i = -3; i <= 3; i++) {
      this.box(0.12, 1.15, 1.4, 20 + 8 - 0.3, 3.9, 2 + i * 1.85, i % 2 ? lit : cool, {
        collide: false,
        cast: false,
      });
    }
    // Painted facade stripe — breaks flat concrete mass
    this.box(16.2, 0.9, 0.08, 20, 2.4, 2 + 7 - 0.2, this.kit.matTrim, {
      collide: false,
      cast: false,
    });
    this.box(0.08, 0.9, 14.2, 20 + 8 - 0.2, 2.4, 2, this.kit.matMetalRust, {
      collide: false,
      cast: false,
    });
    // Loading dock ramp lip
    this.box(3, 0.4, 5, 11.2, 0.2, 2, this.kit.matConcrete);
    // Interior racking / cover
    this.box(1.5, 2.2, 6, 24, 1.1, 0, this.kit.matMetal);
    this.box(1.5, 2.2, 4, 24, 1.1, 5, this.kit.matMetalRust);
    this.box(1.2, 1.8, 3, 17, 0.9, -3, this.kit.matMetal);
    this.box(2.2, 1.4, 1.2, 22, 0.7, -4, this.kit.matWood, { rotY: 0.2 });
    // Exterior corrugated lean-to — posts plant on ground
    this.box(4, 0.15, 6, 27.5, 3.2, 2, this.kit.matMetalRust, { collide: false });
    this.box(0.3, 3.2, 0.3, 27.5, 1.6, -0.5, this.kit.matMetal, { collide: false });
    this.box(0.3, 3.2, 0.3, 27.5, 1.6, 4.5, this.kit.matMetal, { collide: false });
    this.contactShadow(27.5, 2, 4.5, 6.5, 0.22);
    // Pallet stack outside
    this.box(1.6, 0.2, 1.2, 12, 0.12, -4, this.kit.matWood, { collide: false });
    this.box(1.6, 0.2, 1.2, 12, 0.32, -4, this.kit.matWood, {
      collide: false,
      rotY: 0.15,
    });
    this.contactShadow(12, -4, 2.2, 1.8, 0.3);
    this.coverAt(13, 0, 2);
    this.coverAt(18, 0, -3);
    this.coverAt(22, 0, 5);
  }

  private buildSouthShop(): void {
    this.hollowBuilding({
      cx: 3,
      cz: 20,
      w: 12,
      d: 9,
      floors: 1,
      floorH: 3.4,
      wall: 0.4,
      mat: this.kit.matPlaster,
      doorFace: 'n',
      doorW: 2.2,
      windows: true,
    });
    // Shop counter interior
    this.box(6, 1.1, 1.0, 3, 0.55, 22, this.kit.matWood);
    this.box(1.0, 1.6, 0.8, 6, 0.8, 23, this.kit.matMetal);
    this.coverAt(3, 0, 16.2);
    this.coverAt(-1, 0, 18);
    // Awning + supports
    this.box(10, 0.12, 2.2, 3, 2.6, 14.8, this.kit.matMetalRust, { collide: false });
    this.box(0.12, 2.4, 0.12, -1.5, 1.2, 14.2, this.kit.matMetal, { collide: false });
    this.box(0.12, 2.4, 0.12, 7.5, 1.2, 14.2, this.kit.matMetal, { collide: false });
    // Storefront display ledge
    this.box(8, 0.35, 0.6, 3, 0.9, 15.2, this.kit.matConcrete, { collide: false });

    // Everything below is a presentation layer. The shell, counter, and
    // existing cover above retain the only South Shop collision ownership.
    this.buildSouthShopDressing();
  }

  /**
   * Breaks the fallback shop's single-plaster-box read into an intentionally
   * shallow, non-blocking retail interior. These meshes have no collider,
   * cover, or navigation ownership: the play route remains exactly as built
   * by `hollowBuilding` and the original counter.
   */
  private buildSouthShopDressing(): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };

    // The concrete floor was reading nearly the same value as the broad rear
    // plaster plane. A thin, worn service runner anchors the stock wall while
    // retaining the original floor and its physics underneath.
    this.box(8.85, 0.01, 2.26, 3.0, 0.253, 23.08, this.kit.matConcreteDark, noShadow);
    this.box(8.96, 0.024, 0.075, 3.0, 0.272, 21.99, this.kit.matMetalRust, noShadow);
    this.box(8.96, 0.024, 0.075, 3.0, 0.272, 24.12, this.kit.matMetalRust, noShadow);

    // Rear wainscot and a faded inventory band give the wall a grounded base
    // and a second material/value plane instead of an uninterrupted olive slab.
    this.box(11.52, 0.78, 0.065, 3.0, 0.65, 24.065, this.kit.matConcreteDark, noShadow);
    this.box(11.56, 0.10, 0.07, 3.0, 1.06, 24.025, this.kit.matMetal, noShadow);
    this.box(11.42, 0.20, 0.052, 3.0, 2.79, 24.052, this.kit.matFacadePaint, noShadow);
    for (const x of [-1.58, 0.78, 5.22, 7.58]) {
      this.box(0.075, 2.05, 0.06, x, 1.92, 24.015, this.kit.matMetalRust, noShadow);
    }

    // Two shallow rear units frame the existing CC0 stock without closing the
    // aisle. Their open shelves make a readable parallax stack in the QA view.
    this.buildSouthShopRetailShelf(-1.22, 23.82, 2.55);
    this.buildSouthShopRetailShelf(7.08, 23.82, 2.35);

    // A recessed chilled-display silhouette makes the central rear wall read
    // as a room-within-a-room rather than another procedural box face.
    this.buildSouthShopCooler();

    // Existing counter geometry is intentionally untouched; these thin face
    // overlays merely give it a kickplate, top rail, and a small register cue.
    this.box(5.72, 0.44, 0.048, 3.0, 0.31, 21.474, this.kit.matConcreteDark, noShadow);
    this.box(5.96, 0.075, 0.085, 3.0, 1.075, 21.455, this.kit.matMetal, noShadow);
    this.box(0.07, 0.64, 0.064, 0.35, 0.55, 21.445, this.kit.matMetalRust, noShadow);
    this.box(0.07, 0.64, 0.064, 5.65, 0.55, 21.445, this.kit.matMetalRust, noShadow);
    this.box(0.46, 0.26, 0.34, 5.15, 1.235, 21.94, this.kit.matMetal, visual);
    this.box(0.30, 0.12, 0.028, 5.15, 1.30, 21.75, this.kit.matWindowLitCool, noShadow);

    // Practical housings and dim emissive strips give the roof a deliberate
    // purpose in first-person without adding runtime lights or shadow cost.
    for (const [x, z, width] of [
      [0.0, 18.2, 2.2],
      [5.8, 19.6, 2.0],
      [2.9, 23.1, 2.5],
    ] as Array<[number, number, number]>) {
      this.box(width + 0.22, 0.075, 0.34, x, 3.23, z, this.kit.matMetalRust, visual);
      this.box(width, 0.042, 0.12, x, 3.17, z, this.kit.matLampBulb, noShadow);
    }

    // Side-wall uprights and floating display rails finish the visible right
    // edge in the warehouse capture. Their tiny depth preserves the interior
    // volume and does not become new tactical cover.
    for (const z of [17.28, 20.62, 23.62]) {
      this.box(0.06, 2.46, 0.10, 8.55, 1.48, z, this.kit.matMetalRust, noShadow);
    }
    for (const y of [1.22, 2.02]) {
      this.box(0.065, 0.07, 2.55, 8.515, y, 21.05, this.kit.matMetal, noShadow);
    }
    this.box(0.052, 1.45, 1.72, 8.49, 1.85, 21.08, this.kit.matFacadePaint, noShadow);
    this.box(0.04, 0.66, 1.48, 8.455, 1.84, 21.08, this.kit.matGlassBroken, noShadow);
  }

  /** A frame-first shelf avoids a single opaque block in the rear-wall shot. */
  private buildSouthShopRetailShelf(x: number, z: number, width: number): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const half = width * 0.5;
    const backZ = z + 0.205;

    this.box(width, 2.34, 0.055, x, 1.52, backZ, this.kit.matConcreteDark, noShadow);
    for (const dx of [-half + 0.06, half - 0.06]) {
      this.box(0.10, 2.56, 0.15, x + dx, 1.53, z, this.kit.matMetal, visual);
    }
    for (const y of [0.42, 1.05, 1.67, 2.29]) {
      this.box(width + 0.12, 0.085, 0.48, x, y, z, this.kit.matMetalRust, visual);
      this.box(width - 0.10, 0.038, 0.12, x, y + 0.065, z - 0.18, this.kit.matTrim, noShadow);
    }

    const stock = [
      [-0.72, 0.67, 0.46, 0.34, this.kit.matWood],
      [-0.18, 0.68, 0.36, 0.42, this.kit.matSafetyPaint],
      [0.46, 0.68, 0.42, 0.30, this.kit.matWood],
      [-0.52, 1.30, 0.38, 0.44, this.kit.matFacadePaint],
      [0.02, 1.29, 0.46, 0.32, this.kit.matWood],
      [0.61, 1.30, 0.30, 0.42, this.kit.matSafetyPaint],
      [-0.70, 1.92, 0.36, 0.34, this.kit.matWood],
      [-0.22, 1.91, 0.42, 0.40, this.kit.matFacadePaint],
      [0.40, 1.92, 0.50, 0.32, this.kit.matWood],
    ] as Array<[number, number, number, number, THREE.Material]>;
    for (const [offsetX, y, itemWidth, itemHeight, material] of stock) {
      // Clamp bespoke stock rows to each shelf's actual width, so the narrower
      // unit retains asymmetry without boxes hanging through its frame.
      const clampedOffset = THREE.MathUtils.clamp(offsetX, -half + 0.26, half - 0.26);
      this.box(itemWidth, itemHeight, 0.26, x + clampedOffset, y, z - 0.075, material, visual);
    }
  }

  /** Centrepiece display with a cool glass plane, warm shelf lights, and depth. */
  private buildSouthShopCooler(): void {
    const visual = { collide: false, cast: true, receive: true };
    const noShadow = { collide: false, cast: false, receive: true };
    const x = 3.06;
    const z = 23.86;

    this.box(2.46, 2.56, 0.34, x, 1.55, z + 0.09, this.kit.matConcreteDark, visual);
    this.box(2.22, 2.26, 0.045, x, 1.59, z - 0.10, this.kit.matWindowLitCool, noShadow);
    for (const y of [0.72, 1.35, 1.98]) {
      this.box(2.12, 0.07, 0.26, x, y, z - 0.15, this.kit.matMetal, visual);
      this.box(1.94, 0.032, 0.065, x, y + 0.055, z - 0.285, this.kit.matLampBulb, noShadow);
    }
    for (const offsetX of [-1.12, 1.12]) {
      this.box(0.10, 2.46, 0.14, x + offsetX, 1.55, z - 0.16, this.kit.matTrim, visual);
    }
    this.box(2.36, 0.09, 0.15, x, 2.76, z - 0.16, this.kit.matTrim, visual);
    this.box(2.36, 0.09, 0.15, x, 0.34, z - 0.16, this.kit.matTrim, visual);
    // Slightly forward glass preserves a visible highlight and the inset
    // product layers beneath it, rather than closing the display as a panel.
    this.box(2.16, 2.20, 0.035, x, 1.56, z - 0.315, this.kit.matGlassBroken, noShadow);
  }

  private buildWestOffice(): void {
    this.hollowBuilding({
      cx: -22,
      cz: -2,
      w: 12,
      d: 16,
      floors: 3,
      floorH: 3.0,
      wall: 0.45,
      mat: this.kit.matConcrete,
      doorFace: 'e',
      doorW: 2.0,
      windows: true,
    });
    // Lobby desk
    this.box(1.2, 1.0, 3.5, -18, 0.5, -2, this.kit.matWood);
    this.box(0.8, 1.2, 0.8, -17, 0.6, 1, this.kit.matMetal);
    this.coverAt(-15.5, 0, -2);
    this.coverAt(-17, 0, 4);
    // Exterior HVAC / pipe runs
    this.box(2.4, 1.5, 1.8, -22, 9.6, -2, this.kit.matMetal, { collide: false });
    this.box(0.25, 0.25, 8, -16.2, 5.5, -2, this.kit.matMetalRust, {
      collide: false,
    });
    this.box(0.25, 0.25, 6, -16.2, 7.2, 1, this.kit.matMetal, { collide: false });
    // Planter / low wall cover near entrance
    this.box(1.4, 0.7, 3.0, -15.2, 0.35, -6, this.kit.matConcreteDark);
  }

  private buildRuinedCorner(): void {
    const mat = this.kit.matBrick;
    const cx = -20;
    const cz = 20;
    this.box(10, 4.5, 0.5, cx, 2.25, cz - 5, mat);
    this.box(0.5, 5.5, 9, cx - 5, 2.75, cz, mat);
    this.box(8, 2.2, 0.5, cx + 1, 1.1, cz + 4.5, mat);
    // Jagged upper ruin teeth
    this.box(2.5, 1.8, 0.45, cx - 2, 5.2, cz - 5, mat);
    this.box(1.8, 2.4, 0.45, cx + 3, 5.5, cz - 5, mat);
    // Collapsed slab
    this.box(5, 0.4, 4, cx + 1, 1.8, cz - 1, this.kit.matConcrete, {
      rotY: 0.35,
    });
    this.box(3, 0.35, 3, cx - 2, 0.4, cz + 1, this.kit.matConcreteDark, {
      rotY: -0.5,
    });
    this.box(2.2, 0.3, 2.5, cx + 2, 0.55, cz + 2.5, this.kit.matConcrete, {
      rotY: 0.8,
    });
    // Standing rebar-ish metal posts
    this.box(0.2, 3.5, 0.2, cx + 3, 1.75, cz - 3, this.kit.matMetalRust);
    this.box(0.2, 2.8, 0.2, cx - 1, 1.4, cz - 2, this.kit.matMetal);
    this.box(0.18, 4.0, 0.18, cx - 3, 2.0, cz - 1, this.kit.matMetalRust);
    this.box(0.18, 2.2, 0.18, cx + 4, 1.1, cz + 1, this.kit.matMetal);
    // Scaffold remnant
    this.box(0.15, 4.5, 0.15, cx + 4.5, 2.25, cz - 4, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 4.5, 0.15, cx + 4.5, 2.25, cz - 1, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 0.15, 3.2, cx + 4.5, 4.4, cz - 2.5, this.kit.matMetal, {
      collide: false,
    });
    this.coverAt(cx, 0, cz);
    this.coverAt(cx + 3, 0, cz - 3);
  }

  // ── alleys, sandbags, barriers ───────────────────────────────────────

  private buildAlleysAndCover(): void {
    this.sandbagWall(-5, 6, 5, 0);
    this.sandbagWall(5, 5.5, 4, Math.PI * 0.5);
    this.sandbagWall(-6, -8, 4.5, 0.2);
    this.sandbagWall(8, -6, 3.5, -0.4);
    this.sandbagWall(14, 12, 4, 0.1);
    this.sandbagWall(-14, 12, 5, -0.15);
    this.sandbagWall(-10, -10, 3.5, 0.6);
    this.sandbagWall(10, 8, 3.2, -0.7);

    // Concrete jersey barriers
    this.barrier(6, 0, 14, 0);
    this.barrier(-2.5, 0, -11, 0.1);
    this.barrier(10, 0, -12, Math.PI * 0.5);
    this.barrier(-11, 0, 8, Math.PI * 0.48);
    this.barrier(16, 0, -4, 0.3);
    this.barrier(-8, 0, 4, Math.PI * 0.5);
    this.barrier(6, 0, -18, 0.15);
    this.barrier(-18, 0, -6, Math.PI * 0.52);

    // Metal dumpsters
    this.dumpster(-10, 14, 0.2);
    this.dumpster(11, -14, -0.3);
    this.dumpster(-15, -16, 0.5);
    this.dumpster(15, 16, -0.2);
    this.dumpster(24, -6, 0.1);

    // Alley fence panels
    this.box(0.12, 2.2, 6, -14.5, 1.1, -14, this.kit.matMetal);
    this.box(6, 2.2, 0.12, 14, 1.1, 14.5, this.kit.matMetalRust);
    this.box(0.12, 2.0, 4, 26, 1.0, -12, this.kit.matMetalRust);
    this.box(5, 2.0, 0.12, -24, 1.0, 12, this.kit.matMetal);

    // Oil drums
    this.barrel(-12, 8, 0);
    this.barrel(-12.7, 8.5, 0.4);
    this.barrel(8, 14, 0.2);
    this.barrel(19, 6, -0.3);
    this.barrel(-20, 10, 0.5);
    this.barrel(4, -16, 0.1);
    this.barrelStack(13, -8);

    // Camo tarp cover lean
    this.box(3.5, 0.08, 2.2, -7, 1.6, 10, this.kit.matCamo, {
      collide: false,
      rotY: 0.25,
    });
    this.box(0.15, 1.5, 0.15, -8.2, 0.75, 10.5, this.kit.matMetal, {
      collide: false,
    });
    this.box(0.15, 1.5, 0.15, -5.8, 0.75, 9.5, this.kit.matMetal, {
      collide: false,
    });
  }

  private dumpster(x: number, z: number, rotY: number): void {
    this.box(1.9, 1.45, 1.25, x, 0.72, z, this.kit.matMetalRust, { rotY });
    this.box(1.85, 0.12, 1.2, x, 1.5, z, this.kit.matMetal, {
      rotY: rotY + 0.08,
      collide: false,
    });
    this.contactShadow(x, z, 2.4, 1.8, 0.4);
    this.coverAt(x, 0, z - Math.cos(rotY) * 1.4);
  }

  private barrel(x: number, z: number, rotY: number): void {
    this.box(0.65, 1.05, 0.65, x, 0.52, z, this.kit.matBarrel, { rotY });
    this.contactShadow(x, z, 0.95, 0.95, 0.35);
    this.coverAt(x, 0, z);
  }

  private barrelStack(x: number, z: number): void {
    this.box(0.65, 1.05, 0.65, x, 0.52, z, this.kit.matBarrel);
    this.box(0.65, 1.05, 0.65, x + 0.7, 0.52, z + 0.15, this.kit.matMetalRust, {
      rotY: 0.3,
    });
    this.box(0.65, 1.05, 0.65, x + 0.35, 1.55, z, this.kit.matBarrel, {
      rotY: 0.5,
    });
    this.coverAt(x + 0.3, 0, z);
  }

  private sandbagWall(x: number, z: number, length: number, rotY: number): void {
    const mat = this.kit.matSandbag;
    const rows = 2;
    const bagW = 0.9;
    const bagH = 0.45;
    const bagD = 0.55;
    const count = Math.max(2, Math.floor(length / bagW));
    for (let row = 0; row < rows; row++) {
      for (let i = 0; i < count; i++) {
        const offset = (i - (count - 1) * 0.5) * bagW;
        const lx = Math.cos(rotY) * offset;
        const lz = Math.sin(rotY) * offset;
        // Slight stagger on top row for less grid-like look
        const jitter = row === 1 ? bagW * 0.12 : 0;
        this.box(
          bagW * 0.95,
          bagH,
          bagD,
          x + lx + Math.cos(rotY) * jitter,
          bagH * 0.5 + row * bagH,
          z + lz + Math.sin(rotY) * jitter,
          mat,
          { rotY: rotY + (i % 2) * 0.04 },
        );
      }
    }
    this.contactShadow(x, z, length * 1.05, 1.1, 0.36);
    this.coverAt(x, 0, z);
  }

  private barrier(x: number, y: number, z: number, rotY: number): void {
    this.box(2.4, 1.05, 0.55, x, y + 0.52, z, this.kit.matConcrete, { rotY });
    // Top chamfer lip for read
    this.box(2.35, 0.12, 0.35, x, y + 1.1, z, this.kit.matConcreteDark, {
      rotY,
      collide: false,
    });
    this.contactShadow(x, z, 2.8, 1.1, 0.32);
    this.coverAt(x, 0, z);
  }

  // ── wrecked cars ─────────────────────────────────────────────────────

  private buildVehicles(): void {
    this.wreckedCar(10, 16, 0.4);
    this.wreckedCar(-8, -4, -0.9);
    this.wreckedCar(18, -10, 1.2);
    this.wreckedCar(-16, 6, 0.25);
    this.wreckedCar(8, -20, -0.5);
  }

  private wreckedCar(x: number, z: number, rotY: number): void {
    const body = this.kit.matMetalRust;
    const dark = this.kit.matMetal;
    this.contactShadow(x, z, 5.0, 2.6, 0.45);
    this.box(4.2, 0.7, 1.9, x, 0.55, z, body, { rotY });
    this.box(2.0, 0.85, 1.75, x + Math.cos(rotY) * 0.2, 1.25, z + Math.sin(rotY) * 0.2, dark, {
      rotY,
    });
    this.box(1.3, 0.35, 1.7, x + Math.cos(rotY) * 1.4, 0.85, z + Math.sin(rotY) * 1.4, body, {
      rotY: rotY + 0.15,
    });
    // Broken windshield
    this.box(
      1.6,
      0.55,
      0.08,
      x + Math.cos(rotY) * 0.1,
      1.45,
      z + Math.sin(rotY) * 0.1,
      this.kit.matGlassBroken,
      { rotY, collide: false, cast: false },
    );
    const wx = Math.cos(rotY + Math.PI * 0.5) * 0.95;
    const wz = Math.sin(rotY + Math.PI * 0.5) * 0.95;
    for (const along of [-1.3, 1.2]) {
      const ax = Math.cos(rotY) * along;
      const az = Math.sin(rotY) * along;
      this.box(0.55, 0.55, 0.35, x + ax + wx, 0.28, z + az + wz, dark, {
        collide: false,
        rotY,
      });
      this.box(0.55, 0.55, 0.35, x + ax - wx, 0.28, z + az - wz, dark, {
        collide: false,
        rotY,
      });
    }
    this.coverAt(x, 0, z);
  }

  // ── crates / debris ──────────────────────────────────────────────────

  private buildCratesAndDebris(): void {
    const wood = this.kit.matWood;
    const positions: Array<[number, number, number, number]> = [
      [6, 9, 0.9, 0],
      [7.1, 9.2, 0.7, 0.4],
      [-9, 10, 0.9, -0.2],
      [15, 4, 0.9, 0.1],
      [15.9, 4.3, 0.7, 0.6],
      [-18, -8, 0.9, 0],
      [22, 8, 0.9, 0.3],
      [-3, 17, 0.9, -0.5],
      [9, -18, 0.9, 0.2],
      [-12, -18, 0.8, 0.7],
      [2, 14, 0.75, 0.3],
      [-17, 14, 0.85, -0.4],
      [25, 0, 0.9, 0.15],
      [-6, -14, 0.7, 0.9],
      [17, 12, 0.8, -0.25],
      [-22, 4, 0.75, 0.55],
    ];
    for (const [x, z, s, r] of positions) {
      this.box(s, s, s, x, s * 0.5, z, wood, { rotY: r });
      this.contactShadow(x, z, s * 1.35, s * 1.35, 0.32);
      this.coverAt(x, 0, z);
    }
    // Stacked crate tower
    this.box(1.0, 1.0, 1.0, -6, 0.5, 11, wood);
    this.box(0.9, 0.9, 0.9, -6, 1.4, 11, wood, { rotY: 0.3 });
    this.box(0.8, 0.8, 0.8, -6, 2.2, 11, wood, { rotY: -0.2 });
    this.coverAt(-6, 0, 11);

    // Second stack near warehouse
    this.box(1.0, 1.0, 1.0, 14, 0.5, -2, wood);
    this.box(0.85, 0.85, 0.85, 14, 1.35, -2, wood, { rotY: -0.4 });
    this.coverAt(14, 0, -2);

    // Debris scatter
    const rubble = this.kit.matConcreteDark;
    const brick = this.kit.matBrick;
    for (let i = 0; i < 42; i++) {
      const ang = i * 2.15;
      const rad = 7 + (i % 9) * 2.8;
      const x = Math.cos(ang) * rad + ((i * 17) % 5) - 2;
      const z = Math.sin(ang) * rad + ((i * 13) % 5) - 2;
      // Keep clear of player spawn pocket (~0, 28)
      if (z > 24 && Math.abs(x) < 4) continue;
      const s = 0.22 + (i % 5) * 0.11;
      const mat = i % 5 === 0 ? brick : rubble;
      this.box(s, s * 0.5, s * 0.85, x, s * 0.25, z, mat, {
        collide: i % 3 === 0,
        cast: false,
        rotY: i * 0.7,
      });
    }

    // Concentrated rubble near ruined SW
    for (let i = 0; i < 12; i++) {
      const x = -20 + (i % 4) * 1.4 - 1;
      const z = 18 + Math.floor(i / 4) * 1.5;
      const s = 0.35 + (i % 3) * 0.15;
      this.box(s, s * 0.4, s * 0.7, x, s * 0.2, z, i % 2 ? brick : rubble, {
        collide: false,
        cast: false,
        rotY: i * 0.9,
      });
    }

    // Tire stacks
    this.tireStack(12, 8);
    this.tireStack(-14, -8);
    this.tireStack(20, 14);
  }

  private tireStack(x: number, z: number): void {
    const dark = this.kit.matMetal;
    this.box(0.72, 0.32, 0.72, x, 0.16, z, dark, { collide: false });
    this.box(0.72, 0.32, 0.72, x, 0.48, z, dark, { collide: false, rotY: 0.2 });
    this.box(0.72, 0.32, 0.72, x, 0.8, z, dark, { rotY: -0.15 });
    this.coverAt(x, 0, z);
  }

  // ── stairs to north apartment roof ───────────────────────────────────

  private buildStairsAndRooftop(): void {
    const mat = this.kit.matConcrete;
    const baseX = -12.2;
    const baseZ = -20;
    const steps = 14;
    const stepH = 0.46;
    const stepD = 0.55;
    for (let i = 0; i < steps; i++) {
      this.box(2.2, stepH, stepD, baseX, stepH * 0.5 + i * stepH, baseZ + 4.5 - i * stepD, mat);
    }
    // Stair rail
    this.box(0.1, 0.9, steps * stepD, baseX - 1.15, 1.2, baseZ + 4.5 - (steps * stepD) * 0.5, this.kit.matMetal, {
      collide: false,
    });
    // Landing
    this.box(3.2, 0.3, 3.2, baseX, steps * stepH + 0.1, baseZ - 3.2, mat);
    // Roof parapet access walkway onto apartment roof (roof at ~6.55)
    this.box(4, 0.3, 2, -8, 6.55, -20, mat);
    // Parapet walls on roof
    this.box(14.5, 0.9, 0.25, -4, 7.1, -15.1, this.kit.matBrick);
    this.box(14.5, 0.9, 0.25, -4, 7.1, -24.9, this.kit.matBrick);
    this.box(0.25, 0.9, 10, 2.9, 7.1, -20, this.kit.matBrick);
    this.box(0.25, 0.9, 6, -10.9, 7.1, -22, this.kit.matBrick);

    // Rooftop AC / vents / sandbags
    this.box(2.5, 1.4, 1.8, -2, 7.3, -19, this.kit.matMetal);
    this.box(1.2, 0.9, 1.2, 0.5, 7.15, -22, this.kit.matMetalRust, {
      collide: false,
    });
    this.box(0.8, 1.1, 0.8, -7, 7.25, -21, this.kit.matMetal, { collide: false });
    const roofY = 6.7;
    const bagMat = this.kit.matSandbag;
    for (let row = 0; row < 2; row++) {
      for (let i = 0; i < 4; i++) {
        this.box(
          0.85,
          0.45,
          0.5,
          -6.4 + (i - 1.5) * 0.9,
          roofY + 0.22 + row * 0.45,
          -18,
          bagMat,
        );
      }
    }
    this.coverNodes.push(new THREE.Vector3(-6, roofY, -18));
    this.coverNodes.push(new THREE.Vector3(-2, roofY, -19));
    this.enemySpawns.push(new THREE.Vector3(-4, roofY, -21));
  }

  // ── distant skyline silhouettes ──────────────────────────────────────

  private buildPerimeterSilhouettes(): void {
    const mat = this.kit.matSilhouette;
    const ring = HALF + 18;

    type SilSpec = {
      x: number;
      z: number;
      w: number;
      h: number;
      d: number;
      tiers?: number;
      antenna?: boolean;
      waterTower?: boolean;
    };

    const specs: SilSpec[] = [
      { x: -ring, z: -10, w: 9, h: 24, d: 7, tiers: 3, antenna: true },
      { x: -ring, z: 12, w: 11, h: 17, d: 8, tiers: 2 },
      { x: -ring, z: 28, w: 7, h: 30, d: 6, tiers: 4, antenna: true },
      { x: -ring - 6, z: -28, w: 6, h: 14, d: 5, tiers: 2 },
      { x: ring, z: -8, w: 10, h: 22, d: 7, tiers: 3, antenna: true },
      { x: ring, z: 15, w: 8, h: 28, d: 6, tiers: 3, antenna: true },
      { x: ring, z: -25, w: 12, h: 15, d: 9, tiers: 2, waterTower: true },
      { x: ring + 5, z: 30, w: 6, h: 20, d: 5, tiers: 2 },
      { x: -15, z: -ring, w: 13, h: 19, d: 8, tiers: 3 },
      { x: 8, z: -ring, w: 9, h: 26, d: 7, tiers: 4, antenna: true },
      { x: 25, z: -ring, w: 11, h: 16, d: 8, tiers: 2 },
      { x: -28, z: -ring - 4, w: 7, h: 12, d: 6 },
      { x: -20, z: ring, w: 10, h: 20, d: 7, tiers: 3 },
      { x: 5, z: ring, w: 15, h: 13, d: 9, tiers: 2, waterTower: true },
      { x: 22, z: ring, w: 8, h: 29, d: 6, tiers: 4, antenna: true },
      { x: -30, z: -30, w: 7, h: 18, d: 7, tiers: 2 },
      { x: 32, z: 32, w: 9, h: 23, d: 7, tiers: 3, antenna: true },
      { x: -32, z: 32, w: 8, h: 15, d: 6, tiers: 2 },
      { x: 32, z: -32, w: 6, h: 21, d: 5, tiers: 3 },
    ];

    for (const s of specs) {
      const tiers = s.tiers ?? 1;
      // Alternate facade materials so skyline isn't a single black value.
      const matPick =
        Math.abs(Math.round(s.x + s.z)) % 3 === 0
          ? this.kit.matBrick
          : Math.abs(Math.round(s.x * 0.5)) % 2 === 0
            ? this.kit.matConcreteDark
            : mat;
      // Soft contact disc so distant blocks read as planted on asphalt.
      this.contactShadow(s.x, s.z, s.w * 1.2, s.d * 1.2, 0.28);
      // Stepped massing for readable dusk skyline — sit ON the ground (yBase=0).
      for (let t = 0; t < tiers; t++) {
        const shrink = t * 0.12;
        const tw = s.w * (1 - shrink);
        const td = s.d * (1 - shrink * 0.8);
        const th = s.h / tiers;
        const yBase = t * th;
        this.box(tw, th, td, s.x, yBase + th * 0.5, s.z, matPick, {
          collide: false,
          cast: true,
          receive: true,
        });
        // Side wing on mid tiers for irregular silhouette
        if (t === 1 && tiers >= 3) {
          this.box(
            tw * 0.45,
            th * 0.85,
            td * 1.25,
            s.x + tw * 0.4,
            yBase + th * 0.425,
            s.z,
            matPick,
            {
              collide: false,
              cast: true,
              receive: true,
            },
          );
        }
        // Lit window grid on facade facing arena — kills pure-black skyline
        this.addSilhouetteWindows(s.x, s.z, tw, td, yBase, th, t + s.x + s.z);
      }
      if (s.antenna) {
        this.box(0.35, 5.5, 0.35, s.x, s.h + 2.75, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(1.8, 0.2, 0.2, s.x, s.h + 5.0, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
      if (s.waterTower) {
        this.box(2.2, 1.8, 2.2, s.x, s.h + 1.9, s.z, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(0.25, 2.2, 0.25, s.x - 0.7, s.h + 0.5, s.z - 0.7, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
        this.box(0.25, 2.2, 0.25, s.x + 0.7, s.h + 0.5, s.z + 0.7, mat, {
          collide: false,
          cast: false,
          receive: false,
        });
      }
    }
  }

  /** Dense emissive panes on distant blocks — warm/cool mix so skyline isn't black Legos. */
  private addSilhouetteWindows(
    cx: number,
    cz: number,
    w: number,
    d: number,
    yBase: number,
    th: number,
    seed: number,
  ): void {
    const warm = this.kit.matWindowLit;
    const cool = this.kit.matWindowLitCool;
    const cols = Math.max(3, Math.floor(w / 1.7));
    const rows = Math.max(3, Math.floor(th / 2.2));
    const towardOrigin = Math.atan2(-cx, -cz);

    // Prefer the face looking toward the playable arena
    const faces: Array<'n' | 's' | 'e' | 'w'> = ['n', 's', 'e', 'w'];
    // Pick three most inward-facing walls for denser facade read
    const scored = faces
      .map((f) => {
        const ang =
          f === 'n' ? Math.PI : f === 's' ? 0 : f === 'e' ? -Math.PI * 0.5 : Math.PI * 0.5;
        let diff = ang - towardOrigin;
        while (diff > Math.PI) diff -= Math.PI * 2;
        while (diff < -Math.PI) diff += Math.PI * 2;
        return { f, score: Math.abs(diff) };
      })
      .sort((a, b) => a.score - b.score);

    for (const { f } of scored.slice(0, 3)) {
      for (let row = 0; row < rows; row++) {
        for (let col = 0; col < cols; col++) {
          const h = Math.abs(Math.sin(seed * 12.9898 + row * 78.233 + col * 37.719));
          if (h < 0.22) continue; // denser occupancy than before
          const litMat = h > 0.62 ? warm : cool;
          const wy = yBase + 0.7 + row * (th / (rows + 0.35));
          if (wy > yBase + th - 0.45) continue;
          const u = (col - (cols - 1) * 0.5) * (w / (cols + 0.35));
          const v = (col - (cols - 1) * 0.5) * (d / (cols + 0.35));
          if (f === 's') {
            this.addSilhouetteWindow('acrossX', litMat, cx + u, wy, cz + d * 0.5 + 0.05);
          } else if (f === 'n') {
            this.addSilhouetteWindow('acrossX', litMat, cx + u, wy, cz - d * 0.5 - 0.05);
          } else if (f === 'e') {
            this.addSilhouetteWindow('acrossZ', litMat, cx + w * 0.5 + 0.05, wy, cz + v);
          } else {
            this.addSilhouetteWindow('acrossZ', litMat, cx - w * 0.5 - 0.05, wy, cz + v);
          }
        }
      }
    }

    // Horizontal ledge bands break pure massing on tall silhouettes
    if (th > 8) {
      const bandY = yBase + th * 0.55;
      this.box(w * 1.02, 0.35, d * 1.02, cx, bandY, cz, this.kit.matConcreteDark, {
        collide: false,
        cast: false,
        receive: true,
      });
    }
  }

  /**
   * Adds one distant window to a material/axis-compatible instance batch.
   * The source boxes were fixed-size, unrotated, non-shadowed presentation
   * meshes, so this preserves their rendered transform while eliminating the
   * per-window geometry and draw submission cost.
   */
  private addSilhouetteWindow(
    axis: SilhouetteWindowAxis,
    material: THREE.Material,
    x: number,
    y: number,
    z: number,
  ): void {
    const tone = material === this.kit.matWindowLit ? 'warm' : 'cool';
    const key = `${axis}:${tone}`;
    const batches = this.silhouetteWindowBatches.get(key) ?? [];
    let batch = batches.at(-1);

    if (!batch || batch.used === batch.capacity) {
      const geometry = new THREE.BoxGeometry(
        axis === 'acrossX' ? 0.95 : 0.1,
        1.15,
        axis === 'acrossZ' ? 0.95 : 0.1,
      );
      this.disposables.push(geometry);
      const capacity = 1024;
      const mesh = new THREE.InstancedMesh(geometry, material, capacity);
      mesh.name = `SilhouetteWindowBatch-${key}-${batches.length}`;
      mesh.count = 0;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      // One batch spans the perimeter ring. Leaving it unculled avoids a
      // bounding-sphere pop while retaining a handful of submissions instead
      // of thousands of tiny independent frustum-tested windows.
      mesh.frustumCulled = false;
      mesh.instanceMatrix.setUsage(THREE.StaticDrawUsage);
      mesh.userData.visualOnly = true;
      mesh.userData.authoredContract = false;
      this.group.add(mesh);
      batch = { mesh, used: 0, capacity };
      batches.push(batch);
      this.silhouetteWindowBatches.set(key, batches);
    }

    this.silhouetteWindowMatrix.makeTranslation(x, y, z);
    batch.mesh.setMatrixAt(batch.used, this.silhouetteWindowMatrix);
    batch.used += 1;
  }

  /** Uploads static transforms once after all silhouette building passes. */
  private finalizeSilhouetteWindowBatches(): void {
    for (const batches of this.silhouetteWindowBatches.values()) {
      for (const batch of batches) {
        batch.mesh.count = batch.used;
        batch.mesh.instanceMatrix.needsUpdate = true;
      }
    }
  }

  private placeSpawnsAndCover(): void {
    // Player already at south street — keep enemy spawn positions unchanged
    const spawns: Array<[number, number, number]> = [
      [-4, 0, -18],
      [20, 0, 2],
      [3, 0, 18],
      [-20, 0, -2],
      [-18, 0, 18],
      [8, 0, -8],
      [-10, 0, 8],
      [14, 0, 10],
      [-14, 0, -12],
      [0, 0, -6],
      [22, 0, -8],
      [-8, 0, 20],
    ];
    for (const [x, y, z] of spawns) {
      this.enemySpawns.push(new THREE.Vector3(x, y, z));
    }

    const extras: Array<[number, number]> = [
      [0, 8],
      [0, -8],
      [8, 0],
      [-8, 0],
      [5, -14],
      [-5, 14],
    ];
    for (const [x, z] of extras) this.coverAt(x, 0, z);
  }
}
