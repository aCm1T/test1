import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { Enemy, EnemyManager } from '../../src/enemies';
import { QUALITY_PROFILES } from '../../src/engine/Quality';
import { ViewModel } from '../../src/weapons';
import { Level } from '../../src/world';
import {
  DEVELOPMENT_PROP_DESCRIPTORS,
  DevelopmentPropLayer,
} from '../../src/world/DevelopmentPropLayer';

/** Mirrors EnemyManager's global full-dress cap (nearest first). */
const MAX_DETAILED_HOSTILES = 4;

/**
 * Release budgets are 700 peak / 450 typical draw calls, and `info.render.calls`
 * counts the shadow pass as well as the colour pass. The procedural fallback is
 * what has to fit inside that, so the two things that are on screen constantly —
 * the first-person weapon and the hostile squad — are pinned here. Ceilings sit
 * just above measured counts so regressions fail early without flaking on
 * harmless authoring churn (measured AR ~21, hostile near ~25 / far ~9).
 */
const AR_SUBMISSION_CEILING = 25;
const HOSTILE_SUBMISSION_CEILING = 27;
const HOSTILE_SHADOW_CEILING = 8;
const HOSTILE_DISTANT_CEILING = 12;

/**
 * Arena static baking must stay collapsed: one mesh per material/shadow/region
 * bucket, a thin caster set, and a handful of instanced window/glow batches
 * instead of thousands of lit panes. Measured ~61 batches / ~10 casters / 5
 * instanced window+glow after shadowExtent + near-radius prune; ceilings stay
 * at 80/25/5 for authoring headroom.
 */
const LEVEL_STATIC_BATCH_CEILING = 80;
const LEVEL_CASTER_CEILING = 25;
const LEVEL_INSTANCED_WINDOW_GLOW_CEILING = 5;

/**
 * DevelopmentPropLayer uses one colour InstancedMesh per source surface plus
 * one near-only dominant caster. Aircon's shipped 1K package is 4 primitives.
 * Measured with that mock: colour+caster stays ≤12 / ≤4.
 */
const PROP_INSTANCED_COLOUR_CEILING = 12;
const PROP_CASTER_CEILING = 4;

/** Mesh counts mirror the shipped 1K packages (aircon is 2 nodes × 2 prims). */
const PROP_SOURCE_MESH_COUNTS: Record<string, number> = {
  'barrel-01': 1,
  'plastic-crate-02': 1,
  'utility-box-01': 1,
  'exterior-aircon-unit': 4,
};

/**
 * Merged surfaces are what makes those ceilings reachable, and they are the part
 * that quietly regresses: give one fallback material its own texture pair and
 * its pieces silently split back onto their own submissions while every count
 * above still passes. So the number of distinct materials among the generated
 * batches is pinned too — a hostile's dressing shares two (hard and soft goods),
 * and the weapon shares one per finish plus the untextured trim.
 */
const HOSTILE_BATCH_SURFACE_CEILING = 2;
const AR_BATCH_SURFACE_CEILING = 6;

/**
 * LevelTextureKit paints procedural canvases via ImageData. Vitest's default
 * Node environment has neither, so the arena pin installs a tiny stub that only
 * needs to survive construction and material attach — not pixel-accurate reads.
 */
function installLevelTexturePolyfill(): void {
  const scope = globalThis as typeof globalThis & {
    ImageData?: typeof ImageData;
    document?: Document;
  };
  if (typeof scope.ImageData === 'undefined') {
    scope.ImageData = class ImageDataStub {
      readonly data: Uint8ClampedArray;
      readonly width: number;
      readonly height: number;
      constructor(
        dataOrWidth: Uint8ClampedArray | number,
        widthOrHeight?: number,
        height?: number,
      ) {
        if (typeof dataOrWidth === 'number') {
          this.width = dataOrWidth;
          this.height = widthOrHeight ?? dataOrWidth;
          this.data = new Uint8ClampedArray(this.width * this.height * 4);
        } else {
          this.data = dataOrWidth;
          this.width = widthOrHeight ?? 0;
          this.height = height ?? 0;
        }
      }
    } as typeof ImageData;
  }
  if (typeof scope.document?.createElement !== 'function') {
    const canvases = new WeakMap<object, { width: number; height: number; pixels: Uint8ClampedArray | null }>();
    scope.document = {
      createElement(tag: string) {
        if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
        const canvas = {
          width: 0,
          height: 0,
          getContext(type: string) {
            if (type !== '2d') return null;
            return {
              putImageData(image: ImageData) {
                canvases.set(canvas, {
                  width: image.width,
                  height: image.height,
                  pixels: image.data,
                });
              },
              getImageData(sx: number, sy: number, sw: number, sh: number) {
                const stored = canvases.get(canvas);
                const data = stored?.pixels
                  ?? new Uint8ClampedArray(Math.max(1, sw) * Math.max(1, sh) * 4);
                return new scope.ImageData!(data, sw, sh);
              },
            };
          },
        };
        return canvas as unknown as HTMLCanvasElement;
      },
    } as Document;
  }
}

interface Submissions {
  drawn: number;
  casters: number;
}

function submissions(root: THREE.Object3D): Submissions {
  let drawn = 0;
  let casters = 0;
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh && !(node as THREE.Sprite).isSprite) return;
    if (!visibleThrough(node, root)) return;
    drawn += 1;
    if (mesh.castShadow) casters += 1;
  });
  return { drawn, casters };
}

/** Distinct materials across the meshes the batching pass generated. */
function batchedSurfaces(root: THREE.Object3D, prefix: string): Set<string> {
  const surfaces = new Set<string>();
  root.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (!mesh.isMesh || !node.name.startsWith(prefix)) return;
    for (const material of Array.isArray(mesh.material) ? mesh.material : [mesh.material]) {
      surfaces.add(material.uuid);
    }
  });
  return surfaces;
}

function visibleThrough(node: THREE.Object3D, root: THREE.Object3D): boolean {
  let current: THREE.Object3D | null = node;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return true;
}

describe('procedural fallback draw budget', () => {
  it('keeps the carried weapon inside its submission ceiling', () => {
    const viewModel = new ViewModel(new THREE.PerspectiveCamera());
    const rifle = viewModel.root.getObjectByName('ViewAR');
    expect(rifle).toBeTruthy();

    const { drawn, casters } = submissions(rifle!);
    expect(drawn).toBeLessThanOrEqual(AR_SUBMISSION_CEILING);
    // The viewmodel is lit by the dedicated scene directionals/env and never
    // renders into the sun's shadow map.
    expect(casters).toBe(0);

    const surfaces = batchedSurfaces(rifle!, 'ViewModelBatch');
    expect(surfaces.size).toBeGreaterThan(0);
    expect(surfaces.size).toBeLessThanOrEqual(AR_BATCH_SURFACE_CEILING);
    viewModel.dispose();
  });

  it('keeps every named part addressable after the weapon is batched', () => {
    const viewModel = new ViewModel(new THREE.PerspectiveCamera());
    for (const name of [
      'magazine',
      'FallbackReloadMagazine',
      'FallbackOpenMagwell',
      'FallbackSupportHand',
      'FallbackFiringHand',
      'FallbackTriggerFinger',
      'FallbackChargingHandle',
      'FallbackBoltCarrier',
    ]) {
      expect(viewModel.root.getObjectByName(name), name).toBeTruthy();
    }
    expect(viewModel.getPresentationMetrics().adsReticleMarkerPresent).toBe(true);
    viewModel.dispose();
  });

  it('keeps one hostile inside its submission ceiling and thins out at range', () => {
    const enemy = new Enemy({ id: 'hostile:budget', position: new THREE.Vector3(0, 0, 0) });

    const near = submissions(enemy.mesh);
    expect(near.drawn).toBeLessThanOrEqual(HOSTILE_SUBMISSION_CEILING);
    expect(near.casters).toBeLessThanOrEqual(HOSTILE_SHADOW_CEILING);

    // Webbing, pouches, rail hardware and helmet fittings all reach the frame
    // through the two shared surfaces rather than a material each.
    const surfaces = batchedSurfaces(enemy.mesh, 'HostileBatch');
    expect(surfaces.size).toBeGreaterThan(0);
    expect(surfaces.size).toBeLessThanOrEqual(HOSTILE_BATCH_SURFACE_CEILING);

    // Past the silhouette range only the articulated parts are drawn, and the
    // hostile leaves the shadow map entirely.
    enemy.update(1 / 60, new THREE.Vector3(0, 0, 120));
    const far = submissions(enemy.mesh);
    expect(far.drawn).toBeLessThanOrEqual(HOSTILE_DISTANT_CEILING);
    expect(far.drawn).toBeLessThan(near.drawn);
    expect(far.casters).toBe(0);

    // Detail comes back intact when the player closes the distance again.
    enemy.update(1 / 60, new THREE.Vector3(0, 0, 1));
    expect(submissions(enemy.mesh)).toEqual(near);
    enemy.dispose();
  });

  it('lets the squad budget thin a hostile the player is not engaging', () => {
    const enemy = new Enemy({ id: 'hostile:budgeted', position: new THREE.Vector3(0, 0, 0) });
    const camera = new THREE.Vector3(0, 0, 12);
    enemy.update(1 / 60, camera);
    const engaged = submissions(enemy.mesh);
    expect(engaged.casters).toBeGreaterThan(0);

    // Four times the range puts the hostile past the silhouette threshold even
    // though it has not moved. Budget-thinned silhouettes also leave CSM.
    enemy.setDetailBias(4);
    enemy.update(1 / 60, camera);
    const thinned = submissions(enemy.mesh);
    expect(thinned.drawn).toBeLessThanOrEqual(HOSTILE_DISTANT_CEILING);
    expect(thinned.casters).toBe(0);

    enemy.setDetailBias(1);
    enemy.update(1 / 60, camera);
    expect(submissions(enemy.mesh)).toEqual(engaged);
    enemy.dispose();
  });

  it('thins hostile dressing earlier under Low/Medium quality lodBias', () => {
    const enemy = new Enemy({ id: 'hostile:lod-bias', position: new THREE.Vector3(0, 0, 0) });
    // Mid-engagement range that still keeps full dress on High (lodBias 0).
    const camera = new THREE.Vector3(0, 0, 14);
    enemy.setLodBias(QUALITY_PROFILES.high.lodBias);
    enemy.update(1 / 60, camera);
    const highDress = submissions(enemy.mesh).drawn;

    enemy.setLodBias(QUALITY_PROFILES.medium.lodBias);
    enemy.update(1 / 60, camera);
    const mediumDress = submissions(enemy.mesh).drawn;
    expect(mediumDress).toBeLessThan(highDress);

    enemy.setLodBias(QUALITY_PROFILES.low.lodBias);
    enemy.update(1 / 60, camera);
    expect(submissions(enemy.mesh).drawn).toBeLessThanOrEqual(mediumDress);
    enemy.dispose();
  });

  it('keeps the procedural arena inside its static-batch ceilings', { timeout: 15_000 }, () => {
    installLevelTexturePolyfill();
    const scene = new THREE.Scene();
    const level = new Level(scene);

    let batches = 0;
    let casters = 0;
    let instancedWindowGlow = 0;
    level.group.traverse((node) => {
      if (node.name.startsWith('LevelStaticBatch')) {
        batches += 1;
        if ((node as THREE.Mesh).castShadow) casters += 1;
      }
      if (
        (node as THREE.InstancedMesh).isInstancedMesh
        && (node.name.startsWith('SilhouetteWindowBatch') || node.name === 'StreetPracticalGlow')
      ) {
        instancedWindowGlow += 1;
      }
    });

    expect(batches).toBeGreaterThan(0);
    expect(batches).toBeLessThanOrEqual(LEVEL_STATIC_BATCH_CEILING);
    expect(casters).toBeLessThanOrEqual(LEVEL_CASTER_CEILING);
    expect(instancedWindowGlow).toBeGreaterThan(0);
    expect(instancedWindowGlow).toBeLessThanOrEqual(LEVEL_INSTANCED_WINDOW_GLOW_CEILING);

    level.dispose();
  });

  it('keeps the development prop layer inside its InstancedMesh ceilings', async () => {
    const parent = new THREE.Group();
    const layer = new DevelopmentPropLayer({
      parent,
      descriptors: DEVELOPMENT_PROP_DESCRIPTORS,
      fetchAsset: vi.fn(async () => new Response(new ArrayBuffer(4), { status: 200 })),
      parseGltf: vi.fn(async (_data, resourcePath) => {
        // resourcePath is the package directory. Mesh counts mirror the shipped
        // 1K packages; only exterior_aircon_unit is multi-prim.
        const id = resourcePath.includes('exterior_aircon_unit')
          ? 'exterior-aircon-unit'
          : resourcePath.includes('plastic_crate_02')
            ? 'plastic-crate-02'
            : resourcePath.includes('utility_box_01')
              ? 'utility-box-01'
              : 'barrel-01';
        const scene = new THREE.Group();
        const meshCount = PROP_SOURCE_MESH_COUNTS[id] ?? 1;
        for (let index = 0; index < meshCount; index += 1) {
          // Larger prim first so appendDominantCaster keeps a stable opaque body.
          scene.add(new THREE.Mesh(
            new THREE.BoxGeometry(1 + index * 0.5, 1 + index * 0.5, 1 + index * 0.5),
            new THREE.MeshStandardMaterial(),
          ));
        }
        return { scene } as GLTF;
      }),
    });

    await expect(layer.load()).resolves.toMatchObject({ state: 'installed' });

    let colourDraws = 0;
    let casters = 0;
    parent.traverse((node) => {
      const mesh = node as THREE.InstancedMesh;
      if (!mesh.isInstancedMesh) return;
      colourDraws += 1;
      if (mesh.castShadow) casters += 1;
    });

    expect(colourDraws).toBeGreaterThan(0);
    expect(colourDraws).toBeLessThanOrEqual(PROP_INSTANCED_COLOUR_CEILING);
    expect(casters).toBeGreaterThan(0);
    expect(casters).toBeLessThanOrEqual(PROP_CASTER_CEILING);

    layer.dispose();
  });

  it('caps full-dress hostiles globally even when the whole squad is inside 10m', () => {
    const scene = new THREE.Scene();
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(0, 0, 0),
      enemySpawns: [],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene, level, {
      maxAlive: 8,
      seed: 17,
      lineOfSight: () => false,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });

    // Opening roster is two; pack the rest inside engagement range.
    while (manager.getAlive().length < 8) {
      const index = manager.getAlive().length;
      manager.spawnAt(new THREE.Vector3((index % 2 === 0 ? 1 : -1) * 0.5, 0, 2 + index));
    }
    const alive = manager.getAlive();
    expect(alive).toHaveLength(8);
    // Nearest four stay close; the rest sit just inside 10 m so DETAIL_BUDGET_BIAS
    // pushes their effective LOD past the silhouette threshold.
    const park = [1.5, 2.5, 3.5, 4.5, 7.5, 8.0, 8.5, 9.0];
    for (let index = 0; index < alive.length; index += 1) {
      alive[index].position.set((index % 2 === 0 ? 0.4 : -0.4), 0, park[index]);
      alive[index].mesh.position.copy(alive[index].position);
    }

    const player = new THREE.Vector3(0, 0, 0);
    manager.update(1 / 60, player);

    const ranked = [...alive].sort(
      (a, b) => a.mesh.position.distanceToSquared(player) - b.mesh.position.distanceToSquared(player),
    );
    const draws = ranked.map((enemy) => submissions(enemy.mesh).drawn);
    const fullDress = Math.max(...draws);
    const dressed = draws.filter((drawn) => drawn === fullDress).length;
    expect(dressed).toBe(MAX_DETAILED_HOSTILES);
    expect(dressed).toBeLessThan(alive.length);

    for (let index = 0; index < MAX_DETAILED_HOSTILES; index += 1) {
      expect(draws[index]).toBe(fullDress);
    }
    for (let index = MAX_DETAILED_HOSTILES; index < draws.length; index += 1) {
      expect(draws[index]).toBeLessThan(fullDress);
    }

    // Presentation-only: sim identity and alive count are untouched.
    expect(manager.getAlive()).toHaveLength(8);
    expect(manager.snapshotState().enemies).toHaveLength(8);
    manager.dispose();
  });
});
