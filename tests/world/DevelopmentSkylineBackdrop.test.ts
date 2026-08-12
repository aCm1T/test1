import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { Group, Mesh, Texture } from 'three';
import { describe, expect, it, vi } from 'vitest';
import {
  DEVELOPMENT_SKYLINE_CROP_BOTTOM,
  DEVELOPMENT_SKYLINE_LAYOUT,
  DevelopmentSkylineBackdrop,
  createSkylineArcGeometry,
} from '../../src/world/DevelopmentSkylineBackdrop.ts';

const root = process.cwd();

describe('DevelopmentSkylineBackdrop', () => {
  it('crops the source foreground and releases its owned GPU resources exactly once', async () => {
    const parent = new Group();
    const texture = new Texture();
    const textureDispose = vi.spyOn(texture, 'dispose');
    const layer = new DevelopmentSkylineBackdrop({
      parent,
      maxAnisotropy: 6,
      loadTexture: vi.fn(async () => texture),
    });

    await expect(layer.load()).resolves.toEqual({ state: 'installed' });
    expect(parent.children).toHaveLength(1);
    const mesh = parent.getObjectByName('DevelopmentSkylineArc') as Mesh;
    expect(mesh).toBeTruthy();
    expect(mesh.renderOrder).toBe(-900);
    expect(mesh.castShadow).toBe(false);
    expect(mesh.receiveShadow).toBe(false);
    expect(texture.anisotropy).toBe(6);
    expect(texture.generateMipmaps).toBe(true);
    expect((mesh.material as { depthWrite: boolean }).depthWrite).toBe(false);

    const geometryDispose = vi.spyOn(mesh.geometry, 'dispose');
    const materialDispose = vi.spyOn(mesh.material as { dispose(): void }, 'dispose');
    layer.dispose();
    layer.dispose();
    expect(parent.children).toHaveLength(0);
    expect(textureDispose).toHaveBeenCalledOnce();
    expect(geometryDispose).toHaveBeenCalledOnce();
    expect(materialDispose).toHaveBeenCalledOnce();
  });

  it('maps no UVs into the plate foreground', () => {
    const geometry = createSkylineArcGeometry();
    const uv = geometry.getAttribute('uv');
    let lowestV = 1;
    let highestV = 0;
    for (let index = 0; index < uv.count; index += 1) {
      lowestV = Math.min(lowestV, uv.getY(index));
      highestV = Math.max(highestV, uv.getY(index));
    }
    expect(lowestV).toBeCloseTo(DEVELOPMENT_SKYLINE_CROP_BOTTOM);
    expect(highestV).toBeCloseTo(1);
    // The forward arc stays beyond the 35-unit half-arena even at its ends.
    expect(DEVELOPMENT_SKYLINE_LAYOUT.radius * Math.cos(DEVELOPMENT_SKYLINE_LAYOUT.thetaLength * 0.5))
      .toBeGreaterThan(35);
    geometry.dispose();
  });

  it('keeps the original skyline plate documented and outside the authored manifest', () => {
    const plate = path.join(root, 'public/assets/development/nightglass-dusk-skyline-v1.png');
    expect(existsSync(plate)).toBe(true);
    const licenses = readFileSync(path.join(root, 'public/assets/ASSET-LICENSES.md'), 'utf8');
    expect(licenses).toContain('nightglass-dusk-skyline-v1.png');
    expect(licenses).toContain('OpenAI built-in image generation');
    const manifest = readFileSync(path.join(root, 'public/assets/manifest.json'), 'utf8');
    expect(manifest).not.toContain('nightglass-dusk-skyline-v1.png');
  });
});
