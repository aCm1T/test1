import {
  BoxGeometry,
  Group,
  InstancedMesh,
  LOD,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshStandardMaterial,
  Object3D,
  Scene,
  Texture,
  Vector3,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import type { AssetRegistry } from '../../src/engine';
import { EnvironmentAssembler } from '../../src/world';

function registryFor(scene: Group): AssetRegistry {
  return {
    load: vi.fn(async () => ({ scene } as GLTF)),
  } as unknown as AssetRegistry;
}

describe('EnvironmentAssembler', () => {
  it('applies quality LOD bias without taking ownership of registry assets', async () => {
    const source = new Group();
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: registryFor(source),
      lodBias: 1,
      modules: [{
        id: 'lamps',
        kind: 'prop',
        position: [0, 0, 0],
        assets: ['lamp-lod0', 'lamp-lod1', 'lamp-lod2'],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });

    const result = await assembler.load();
    const lod = result.group.children[0] as LOD;
    expect(result.mode).toBe('authored');
    expect(lod.levels.map((level) => level.distance)).toEqual([0, 10, 27.5]);

    assembler.setLodBias(-1);
    expect(lod.levels.map((level) => level.distance)).toEqual([0, 40, 110]);
    assembler.dispose();
    expect(source.parent).toBeNull();
  });

  it('uses the explicit fallback when authored loading fails', async () => {
    const dispose = vi.fn();
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: {
        load: vi.fn(async () => { throw new Error('missing licensed asset'); }),
      } as unknown as AssetRegistry,
      modules: [{
        id: 'warehouse',
        kind: 'building',
        position: [0, 0, 0],
        assets: ['a', 'b', 'c'],
      }],
      buildFallback: () => ({ dispose }),
    });

    expect((await assembler.load()).mode).toBe('fallback');
    assembler.dispose();
    expect(dispose).toHaveBeenCalledOnce();
  });

  it('extracts LOD0 authored collision, navigation links and cover annotations', async () => {
    const source = new Group();
    const wall = new Mesh(new BoxGeometry(2, 4, 0.5), new MeshBasicMaterial());
    wall.name = 'COLLIDER_wall';
    wall.position.set(2, 2, 0);
    wall.userData.surface = 'concrete';
    source.add(wall);
    const south = new Object3D();
    south.name = 'NAV_south';
    south.userData.navigationNode = 'south';
    south.userData.links = ['north'];
    source.add(south);
    const north = new Object3D();
    north.name = 'NAV_north';
    north.userData.navigationNode = 'north';
    north.position.z = 5;
    source.add(north);
    const cover = new Object3D();
    cover.name = 'COVER_crate';
    cover.userData.coverSlot = 'crate';
    cover.position.set(1, 0, 3);
    source.add(cover);

    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: registryFor(source),
      modules: [{
        id: 'street',
        kind: 'building',
        position: [10, 0, 0],
        assets: ['a', 'b', 'c'],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });
    await assembler.load();

    const colliders = assembler.getStaticColliders();
    expect(colliders).toHaveLength(1);
    expect(colliders[0]).toMatchObject({
      id: 'authored:wall',
      center: { x: 12, y: 2, z: 0 },
      halfExtents: { x: 1, y: 2, z: 0.25 },
      surface: 'concrete',
    });
    expect(colliders[0].mesh.indices).toHaveLength(36);
    expect(colliders[0].mesh.vertices).toHaveLength(72);
    const xs = colliders[0].mesh.vertices.filter((_, index) => index % 3 === 0);
    expect(Math.min(...xs)).toBeCloseTo(11);
    expect(Math.max(...xs)).toBeCloseTo(13);
    expect(assembler.getNavigationAnnotations()).toEqual({
      nodes: [
        { id: 'north', position: { x: 10, y: 0, z: 5 } },
        { id: 'south', position: { x: 10, y: 0, z: 0 } },
      ],
      links: [
        { from: 'north', to: 'south' },
        { from: 'south', to: 'north' },
      ],
      coverSlots: [{ id: 'crate', position: { x: 11, y: 0, z: 3 } }],
    });
    assembler.dispose();
  });

  it('preserves rotated authored collision geometry instead of filling its AABB', async () => {
    const source = new Group();
    const ramp = new Mesh(new BoxGeometry(4, 0.2, 2), new MeshBasicMaterial());
    ramp.name = 'COLLIDER_ramp';
    ramp.rotation.z = Math.PI / 6;
    ramp.position.y = 1;
    source.add(ramp);
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: registryFor(source),
      modules: [{
        id: 'ramp-module',
        kind: 'building',
        position: [5, 0, 0],
        rotationY: Math.PI / 4,
        assets: ['a', 'b', 'c'],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });
    await assembler.load();

    const [collider] = assembler.getStaticColliders();
    expect(collider.mesh.indices).toHaveLength(36);
    const uniqueY = new Set(collider.mesh.vertices
      .filter((_, index) => index % 3 === 1)
      .map((value) => value.toFixed(4)));
    expect(uniqueY.size).toBeGreaterThan(2);
    expect(collider.halfExtents.y).toBeGreaterThan(0.9);
    assembler.dispose();
  });

  it('binds UV1 baked lightmaps and emits measurable GPU instance evidence', async () => {
    const source = new Group();
    source.add(new Mesh(
      new BoxGeometry(1, 2, 1),
      new MeshStandardMaterial({ emissive: 0xff8800, emissiveIntensity: 1 }),
    ));
    const lightMap = new Texture();
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: {
        load: vi.fn(async (id: string) => id === 'street-lightmap'
          ? lightMap
          : { scene: source } as GLTF),
      } as unknown as AssetRegistry,
      modules: [{
        id: 'street-props',
        kind: 'prop',
        position: [0, 0, 0],
        assets: ['a', 'b', 'c'],
        lightMapAsset: 'street-lightmap',
        instances: [
          { position: [0, 0, 0] },
          { position: [4, 0, 0] },
          { position: [8, 0, 0] },
        ],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });
    await assembler.load();

    expect(lightMap.channel).toBe(1);
    expect(assembler.getRenderStats()).toEqual({
      instancedMeshes: 3,
      instances: 9,
      lightmappedMaterials: 3,
      emissiveMaterials: 3,
    });
    assembler.dispose();
  });

  it('instances every visual mesh in a nested source hierarchy at its authored transform', async () => {
    const source = new Group();
    const housing = new Group();
    housing.position.set(2, 0, 3);
    housing.rotation.y = Math.PI / 2;
    const body = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    const trim = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), new MeshStandardMaterial());
    trim.position.set(1, 0, 0);
    housing.add(body, trim);
    source.add(housing);
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry: registryFor(source),
      modules: [{
        id: 'lamp-cluster',
        kind: 'prop',
        position: [0, 0, 0],
        assets: ['a', 'b', 'c'],
        instances: [
          { position: [10, 0, 0] },
          { position: [20, 0, 0], rotationY: Math.PI / 2, scale: 2 },
        ],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });

    const result = await assembler.load();
    const level0 = (result.group.children[0] as LOD).levels[0].object;
    const meshes: InstancedMesh[] = [];
    level0.traverse((node) => {
      if (node instanceof InstancedMesh) meshes.push(node);
    });
    expect(meshes).toHaveLength(2);
    expect(meshes.every((mesh) => mesh.count === 2)).toBe(true);

    const trimMesh = meshes.find((mesh) => mesh.userData.instancedSource === trim.uuid);
    expect(trimMesh).toBeDefined();
    const matrix = new Matrix4();
    trimMesh!.getMatrixAt(0, matrix);
    expect(new Vector3().setFromMatrixPosition(matrix)).toEqual(new Vector3(12, 0, 2));
    assembler.dispose();
  });

  it('can show LOD0 while deferred LOD upgrades stream in', async () => {
    const source = new Group();
    source.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    const deferred = new Map<string, (value: GLTF) => void>();
    const registry = {
      load: vi.fn((id: string) => {
        if (id === 'lod0') return Promise.resolve({ scene: source } as GLTF);
        return new Promise<GLTF>((resolve) => deferred.set(id, resolve));
      }),
    } as unknown as AssetRegistry;
    const assembler = new EnvironmentAssembler({
      scene: new Scene(),
      registry,
      deferLodUpgrades: true,
      modules: [{
        id: 'street',
        kind: 'prop',
        position: [0, 0, 0],
        assets: ['lod0', 'lod1', 'lod2'],
      }],
      buildFallback: () => ({ dispose: () => {} }),
    });

    const result = await assembler.load();
    const lod = result.group.children[0] as LOD;
    expect(lod.levels).toHaveLength(1);
    deferred.get('lod2')!({ scene: source } as GLTF);
    deferred.get('lod1')!({ scene: source } as GLTF);
    expect(await assembler.waitForLodUpgrades()).toEqual([]);
    expect(lod.levels.map((level) => level.distance)).toEqual([0, 20, 55]);
    assembler.dispose();
  });
});
