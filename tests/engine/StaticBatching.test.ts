import * as THREE from 'three';
import { describe, expect, it } from 'vitest';
import { collapseStaticSubtrees, equivalentEdge, SurfaceFamily, createSurfaceBatchResolver, bindSurfaceFamilyCompile } from '../../src/engine/StaticBatching';

function countMeshes(root: THREE.Object3D): number {
  let meshes = 0;
  root.traverse((node) => {
    if ((node as THREE.Mesh).isMesh) meshes += 1;
  });
  return meshes;
}

function countTriangles(root: THREE.Object3D): number {
  let total = 0;
  root.traverse((node) => {
    const geometry = (node as THREE.Mesh).geometry;
    if (!geometry) return;
    total += (geometry.index?.count ?? geometry.attributes.position.count) / 3;
  });
  return total;
}

/** A texture pair standing in for one generated look. */
function surfacePair(): { map: THREE.DataTexture; roughnessMap: THREE.DataTexture } {
  const texture = () => {
    const data = new THREE.DataTexture(new Uint8Array([128, 128, 128, 255]), 1, 1);
    data.wrapS = THREE.RepeatWrapping;
    data.wrapT = THREE.RepeatWrapping;
    return data;
  };
  return { map: texture(), roughnessMap: texture() };
}

/** A material sampling a shared pair at its own tiling, tint and roughness. */
function member(
  shared: { map: THREE.Texture; roughnessMap: THREE.Texture },
  color: number,
  repeat: number,
): THREE.MeshStandardMaterial {
  const view = (source: THREE.Texture) => {
    const clone = source.clone();
    clone.repeat.set(repeat, repeat);
    return clone;
  };
  return new THREE.MeshStandardMaterial({
    color,
    map: view(shared.map),
    roughnessMap: view(shared.roughnessMap),
  });
}

function worldBounds(root: THREE.Object3D): THREE.Box3 {
  root.updateMatrixWorld(true);
  // Vertex-precise bounds: a merged batch has a tighter axis-aligned box than
  // the union of per-mesh boxes, even though the vertices land in the same
  // place.
  return new THREE.Box3().setFromObject(root, true);
}

function fixture(material: THREE.Material): THREE.Group {
  const root = new THREE.Group();
  for (const x of [-1, 0, 1]) {
    const slab = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), material);
    slab.position.set(x, 0.2, 0);
    slab.castShadow = true;
    root.add(slab);

    // A nested container with its own transform: the merged result has to keep
    // the accumulated placement, not just the leaf's local one.
    const holder = new THREE.Group();
    holder.position.set(x, 0.6, 0.25);
    holder.rotation.y = 0.7;
    const stud = new THREE.Mesh(new THREE.CylinderGeometry(0.05, 0.05, 0.1, 8), material);
    stud.position.set(0.1, 0, 0);
    stud.castShadow = true;
    holder.add(stud);
    root.add(holder);
  }
  return root;
}

describe('static batching', () => {
  it('preserves the rendered placement of everything it merges', () => {
    const material = new THREE.MeshStandardMaterial();
    const before = worldBounds(fixture(material));

    const root = fixture(material);
    const result = collapseStaticSubtrees(root);
    const after = worldBounds(root);

    expect(result.collapsed).toBe(6);
    expect(countMeshes(root)).toBe(1);
    expect(after.min.toArray()).toEqual(before.min.toArray().map((v) => expect.closeTo(v, 5)));
    expect(after.max.toArray()).toEqual(before.max.toArray().map((v) => expect.closeTo(v, 5)));
  });

  it('keeps one draw per render state rather than one per piece', () => {
    const root = new THREE.Group();
    const opaque = new THREE.MeshStandardMaterial();
    const glass = new THREE.MeshStandardMaterial({ transparent: true });
    for (let i = 0; i < 8; i += 1) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), i % 2 ? glass : opaque);
      mesh.position.x = i * 0.3;
      root.add(mesh);
    }

    collapseStaticSubtrees(root);
    expect(countMeshes(root)).toBe(2);
  });

  it('never folds away a pivot, a hidden part, or a marker', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const animated = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), material);
    animated.name = 'recoil';
    const hidden = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), material);
    hidden.visible = false;
    const marker = new THREE.Object3D();
    marker.name = 'ADS_RETICLE';
    marker.position.set(0, 1, -0.5);
    const filler = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), material);
    // The animated part carries static dressing that may still be merged.
    const dressing = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), material);
    dressing.position.y = 0.4;
    animated.add(dressing);
    root.add(animated, hidden, marker, filler);

    collapseStaticSubtrees(root, { isPivot: (node) => node.name === 'recoil' });

    expect(root.getObjectByName('recoil')).toBe(animated);
    expect(root.getObjectByName('ADS_RETICLE')).toBe(marker);
    expect(root.children).toContain(hidden);
    expect(root.children).not.toContain(filler);
    expect(animated.children).toHaveLength(0);
  });

  it('drops batches of small hardware from the shadow pass', () => {
    const material = new THREE.MeshStandardMaterial();
    const root = new THREE.Group();
    const body = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), material);
    body.castShadow = true;
    body.renderOrder = 0;
    const rivets = new THREE.Mesh(new THREE.BoxGeometry(0.01, 0.01, 0.01), material);
    rivets.castShadow = true;
    // A different render order keeps the rivets in their own bucket.
    rivets.renderOrder = 1;
    root.add(body, rivets);

    collapseStaticSubtrees(root, { shadowExtent: 0.1, trimExtent: 0.05, trimFlag: 'trim' });

    const batches = root.children as THREE.Mesh[];
    const rivetBatch = batches.find((mesh) => mesh.renderOrder === 1);
    const bodyBatch = batches.find((mesh) => mesh.renderOrder === 0);
    expect(bodyBatch?.castShadow).toBe(true);
    expect(rivetBatch?.castShadow).toBe(false);
    expect(rivetBatch?.userData.trim).toBe(true);
  });

  it('merges mapped pieces that share a surface family, and keeps the rest apart', () => {
    const shared = surfacePair();
    const stranger = surfacePair();
    const family = new SurfaceFamily('weave', shared);
    const root = new THREE.Group();
    const piece = (material: THREE.Material, x: number) => {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), material);
      mesh.position.x = x;
      root.add(mesh);
    };
    // Three tints at three tilings, plus one untextured piece: all four sample
    // the family and belong on one submission.
    piece(member(shared, 0x445544, 2), 0);
    piece(member(shared, 0x223322, 5), 0.4);
    piece(member(shared, 0x667766, 9), 0.8);
    piece(new THREE.MeshStandardMaterial({ color: 0x101010 }), 1.2);
    // A piece with its own texture pair cannot join, and must not be lost.
    piece(member(stranger, 0x998877, 3), 1.6);

    const before = countTriangles(root);
    collapseStaticSubtrees(root, { surfaceFamilies: [family], unifyPlainMaterials: true });

    expect(countMeshes(root)).toBe(2);
    expect(countTriangles(root)).toBe(before);
    const batches = root.children as THREE.Mesh[];
    const merged = batches.find((mesh) => mesh.material === family.materialFor(
      new THREE.MeshStandardMaterial(),
    ));
    expect(merged).toBeTruthy();
    // Tint, roughness and metalness ride along per vertex, and the tiling each
    // member used is baked into the merged UVs.
    expect(merged!.geometry.attributes.color).toBeTruthy();
    expect(merged!.geometry.attributes.aSurface.itemSize).toBe(4);
    expect(merged!.geometry.attributes.aEmissive.itemSize).toBe(3);
    const uv = merged!.geometry.attributes.uv;
    let maxU = 0;
    for (let i = 0; i < uv.count; i += 1) maxU = Math.max(maxU, uv.getX(i));
    expect(maxU).toBeCloseTo(9, 5);
  });

  it('lets a flat resolver fold untextured kit mates onto one surface', () => {
    const resolver = createSurfaceBatchResolver({ unifyPlainMaterials: true });
    const trim = new THREE.MeshStandardMaterial({ color: 0x83878b, roughness: 0.5, metalness: 0.68 });
    const paint = new THREE.MeshStandardMaterial({ color: 0xc48c38, roughness: 0.5, metalness: 0.32 });
    const mapped = new THREE.MeshStandardMaterial({
      color: 0x445544,
      map: surfacePair().map,
    });

    const a = resolver.resolve(trim);
    const b = resolver.resolve(paint);
    const c = resolver.resolve(mapped);
    expect(a.identity).toBe(b.identity);
    expect(a.material).toBe(b.material);
    expect(c.identity).toBe(mapped.uuid);
    expect(bindSurfaceFamilyCompile(a.material)).toBe(true);
    expect(bindSurfaceFamilyCompile(mapped)).toBe(false);
  });

  it('lets a family replace its albedo after its geometry has been merged', () => {
    const shared = surfacePair();
    const family = new SurfaceFamily('softgoods', shared);
    const root = new THREE.Group();
    for (const x of [0, 0.4]) {
      const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), member(shared, 0x333333, 4));
      mesh.position.x = x;
      root.add(mesh);
    }

    collapseStaticSubtrees(root, { surfaceFamilies: [family] });
    const batch = root.children[0] as THREE.Mesh;
    const original = (batch.material as THREE.MeshStandardMaterial).map;

    const replacement = new THREE.DataTexture(new Uint8Array([9, 9, 9, 255]), 1, 1);
    replacement.wrapS = THREE.RepeatWrapping;
    replacement.wrapT = THREE.RepeatWrapping;
    family.setAlbedo(replacement);
    const swapped = (batch.material as THREE.MeshStandardMaterial).map;
    expect(swapped).not.toBe(original);
    expect(swapped!.source).toBe(replacement.source);
    // The family samples untransformed, because tiling now lives in the geometry.
    expect(swapped!.repeat.toArray()).toEqual([1, 1]);

    family.setTint(0x808080);
    expect((batch.material as THREE.MeshStandardMaterial).color.getHex()).toBe(0x808080);
  });

  it('measures size by equivalent cube edge so thin panels are not oversized', () => {
    const panel = new THREE.BoxGeometry(0.5, 0.5, 0.002);
    expect(equivalentEdge(panel)).toBeLessThan(0.1);
    expect(equivalentEdge(new THREE.BoxGeometry(0.5, 0.5, 0.5))).toBeCloseTo(0.5, 5);
  });
});
