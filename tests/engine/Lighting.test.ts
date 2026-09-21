import { MeshStandardMaterial, Scene } from 'three';
import { describe, expect, it } from 'vitest';
import { setupLighting } from '../../src/engine/Lighting';

describe('height fog shader extension', () => {
  it('remains idempotent when another extension re-wraps an already fogged material', () => {
    const lighting = setupLighting(new Scene());
    const material = new MeshStandardMaterial();
    lighting.applyHeightFog(material);

    const foggedCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      foggedCompile(shader, renderer);
      shader.vertexShader += '\n// simulated CSM extension';
    };
    lighting.applyHeightFog(material);

    const shader = {
      uniforms: {},
      vertexShader: '#include <common>\nvoid main() {\n#include <begin_vertex>\n}',
      fragmentShader: '#include <common>\nvoid main() {\n#include <fog_fragment>\n}',
    };
    material.onBeforeCompile(shader as never, {} as never);

    expect(matches(shader.vertexShader, 'varying vec3 vNightglassWorldPosition;')).toBe(1);
    expect(matches(shader.fragmentShader, 'uniform float nightglassFogDensity;')).toBe(1);
    expect(matches(shader.fragmentShader, 'vec3 nightglassFogView =')).toBe(1);

    material.dispose();
    lighting.dispose();
  });
});

function matches(source: string, literal: string): number {
  return source.split(literal).length - 1;
}
