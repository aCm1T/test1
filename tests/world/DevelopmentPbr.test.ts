import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { NoColorSpace, RepeatWrapping, SRGBColorSpace, Texture } from 'three';
import { expect, test } from 'vitest';
import { configureTexture } from '../../src/world/Textures.ts';

const root = process.cwd();
const pbrRoot = path.join(root, 'public/assets/development/polyhaven');

test('development PBR source set and its CC0 provenance stay together', () => {
  for (const filename of [
    'asphalt_01_diff_1k.jpg', 'asphalt_01_nor_gl_1k.jpg', 'asphalt_01_arm_1k.jpg',
    'concrete_floor_diff_1k.jpg', 'concrete_floor_nor_gl_1k.jpg', 'concrete_floor_arm_1k.jpg',
    'yellow_plaster_diff_1k.jpg', 'yellow_plaster_nor_gl_1k.jpg', 'yellow_plaster_arm_1k.jpg',
  ]) {
    expect(existsSync(path.join(pbrRoot, filename))).toBe(true);
  }
  expect(readFileSync(path.join(pbrRoot, 'README.md'), 'utf8')).toContain('CC0');
});

test('color and non-color PBR maps retain their required texture semantics', () => {
  const albedo = configureTexture(new Texture(), {
    repeat: [12, 12], anisotropy: 8, colorSpace: SRGBColorSpace,
  });
  const data = configureTexture(new Texture(), {
    repeat: [12, 12], anisotropy: 8, colorSpace: NoColorSpace,
  });

  expect(albedo.wrapS).toBe(RepeatWrapping);
  expect(albedo.wrapT).toBe(RepeatWrapping);
  expect(albedo.repeat.toArray()).toEqual([12, 12]);
  expect(albedo.colorSpace).toBe(SRGBColorSpace);
  expect(data.colorSpace).toBe(NoColorSpace);
});
