import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Texture,
} from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  DevelopmentPropLayer,
  DEVELOPMENT_PROP_DESCRIPTORS,
  PROP_SHADOW_NEAR_RADIUS,
  type DevelopmentPropDescriptor,
} from '../../src/world/DevelopmentPropLayer.ts';

const root = process.cwd();

function descriptor(overrides?: Partial<DevelopmentPropDescriptor>): DevelopmentPropDescriptor {
  return {
    id: 'test-prop',
    url: '/assets/development/test.gltf',
    placements: [
      { position: [1, 0, 2], rotationY: 0.4, scale: 1.2 },
      { position: [3, 0, 4] },
    ],
    ...overrides,
  };
}

function response(): Response {
  return new Response(new ArrayBuffer(4), { status: 200 });
}

function sourceScene(
  meshCount = 1,
): { scene: Group; geometry: BoxGeometry; material: MeshStandardMaterial; texture: Texture } {
  const geometry = new BoxGeometry(1, 1, 1);
  const texture = new Texture();
  const material = new MeshStandardMaterial({ map: texture });
  const scene = new Group();
  for (let index = 0; index < meshCount; index += 1) {
    const mesh = new Mesh(
      index === 0 ? geometry : new BoxGeometry(0.25, 0.25, 0.25),
      material,
    );
    mesh.name = index === 0 ? 'body' : `extra-${index}`;
    scene.add(mesh);
  }
  return { scene, geometry, material, texture };
}

function meshesOf(root: Group): Mesh[] {
  const meshes: Mesh[] = [];
  root.traverse((node) => {
    if ((node as Mesh).isMesh) meshes.push(node as Mesh);
  });
  return meshes;
}

describe('DevelopmentPropLayer', () => {
  it('installs only visual clones and releases shared GLTF resources once', async () => {
    const parent = new Group();
    const source = sourceScene();
    const geometryDispose = vi.spyOn(source.geometry, 'dispose');
    const materialDispose = vi.spyOn(source.material, 'dispose');
    const textureDispose = vi.spyOn(source.texture, 'dispose');
    const layer = new DevelopmentPropLayer({
      parent,
      descriptors: [descriptor()],
      fetchAsset: vi.fn(async () => response()),
      parseGltf: vi.fn(async () => ({ scene: source.scene } as GLTF)),
    });

    await expect(layer.load()).resolves.toEqual({ state: 'installed', placementCount: 2 });
    expect(layer.getState()).toBe('installed');
    expect(parent.children).toHaveLength(1);
    const rootGroup = parent.children[0];
    expect(rootGroup.userData).toMatchObject({
      developmentOnly: true,
      visualOnly: true,
      authoredContract: false,
    });
    const placed = rootGroup.children[0];
    expect(placed.userData).toMatchObject({ developmentPropId: 'test-prop' });
    const visualMeshes = meshesOf(placed as Group);
    expect(visualMeshes.length).toBeGreaterThan(0);
    expect(visualMeshes.filter((mesh) => mesh.castShadow)).toHaveLength(1);
    expect(visualMeshes.every((mesh) => mesh.receiveShadow)).toBe(true);

    layer.dispose();
    expect(parent.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
    expect(textureDispose).toHaveBeenCalledOnce();
  });

  it('keeps near-field shadows and disables distant / multi-prim extras', async () => {
    const parent = new Group();
    const source = sourceScene(2);
    const far = PROP_SHADOW_NEAR_RADIUS + 4;
    const layer = new DevelopmentPropLayer({
      parent,
      descriptors: [descriptor({
        placements: [
          { position: [2, 0, 3], scale: 1.1 },
          { position: [far, 0, 0], scale: 1.1 },
          { position: [1, 0, 1], scale: 0.9 },
        ],
      })],
      fetchAsset: vi.fn(async () => response()),
      parseGltf: vi.fn(async () => ({ scene: source.scene } as GLTF)),
    });

    await expect(layer.load()).resolves.toEqual({ state: 'installed', placementCount: 3 });
    const placed = parent.children[0].children[0] as Group;
    const meshes = meshesOf(placed);
    expect(meshes.some((mesh) => mesh.castShadow)).toBe(true);
    expect(meshes.some((mesh) => !mesh.castShadow)).toBe(true);
    expect(meshes.filter((mesh) => mesh.castShadow)).toHaveLength(1);
    expect(meshes.every((mesh) => mesh.receiveShadow)).toBe(true);
    layer.dispose();
  });

  it('does not attach a late parse after disposal', async () => {
    const parent = new Group();
    const source = sourceScene();
    const geometryDispose = vi.spyOn(source.geometry, 'dispose');
    let resolveParse: ((value: GLTF) => void) | null = null;
    const parseGltf = vi.fn(() => new Promise<GLTF>((resolve) => { resolveParse = resolve; }));
    const layer = new DevelopmentPropLayer({
      parent,
      descriptors: [descriptor()],
      fetchAsset: vi.fn(async () => response()),
      parseGltf,
    });

    const loading = layer.load();
    await vi.waitFor(() => expect(parseGltf).toHaveBeenCalledOnce());
    layer.dispose();
    resolveParse?.({ scene: source.scene } as GLTF);

    await expect(loading).resolves.toEqual({ state: 'disposed', placementCount: 0 });
    expect(parent.children).toHaveLength(0);
    expect(geometryDispose).toHaveBeenCalledOnce();
  });

  it('keeps the downloaded CC0 packages and provenance outside the authored manifest', () => {
    const propRoot = path.join(root, 'public/assets/development/cc0-props');
    for (const file of [
      'Barrel_01_1k.gltf', 'Barrel_01.bin', 'textures/Barrel_01_explosive_diff_1k.jpg',
      'plastic_crate_02/plastic_crate_02_1k.gltf',
      'utility_box_01/utility_box_01_1k.gltf',
      'exterior_aircon_unit/exterior_aircon_unit_1k.gltf',
      'exterior_aircon_unit/exterior_aircon_unit.bin',
      'exterior_aircon_unit/textures/exterior_aircon_unit_rusted_01_diff_1k.jpg',
    ]) {
      expect(existsSync(path.join(propRoot, file))).toBe(true);
    }
    const provenance = readFileSync(path.join(propRoot, 'README.md'), 'utf8');
    expect(provenance).toContain('CC0');
    expect(provenance).toContain('Barrel 01');
    expect(provenance).toContain('Jorge Camacho');
    expect(provenance).toContain('Exterior Aircon Unit');
    expect(provenance).toContain('Monsta3D');
    const aircon = DEVELOPMENT_PROP_DESCRIPTORS.find(({ id }) => id === 'exterior-aircon-unit');
    expect(aircon?.url).toBe(
      '/assets/development/cc0-props/exterior_aircon_unit/exterior_aircon_unit_1k.gltf',
    );
    // The condensers dress several roofs now, so the contract worth pinning is
    // that every instance is seated above the street rather than dropped into
    // the play space as scatter — not a single hard-coded placement.
    expect(aircon?.placements).toContainEqual({
      position: [5.82, 4.08, 19.42], rotationY: 0, scale: 1.08,
    });
    for (const placement of aircon?.placements ?? []) {
      expect(placement.position[1]).toBeGreaterThan(3.5);
    }
    const manifest = readFileSync(path.join(root, 'public/assets/manifest.json'), 'utf8');
    expect(manifest).not.toContain('cc0-props');
    expect(manifest).not.toContain('Barrel_01');
    expect(manifest).not.toContain('exterior_aircon_unit');
  });
});
