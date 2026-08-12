import {
  BufferGeometry,
  DataTexture,
  Float32BufferAttribute,
  Mesh,
  MeshStandardMaterial,
  RGBAFormat,
  Scene,
  UnsignedByteType,
} from 'three';
import { describe, expect, it } from 'vitest';
import {
  WebGLFrameProfiler,
  estimateGpuAssetBytes,
} from '../../src/engine/PerformanceSampler.ts';

describe('performance evidence helpers', () => {
  it('counts unique scene geometry and texture payload bytes without double counting instances', () => {
    const geometry = new BufferGeometry();
    geometry.setAttribute('position', new Float32BufferAttribute([
      0, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ], 3));
    geometry.setIndex([0, 1, 2]);
    const pixels = new Uint8Array(2 * 2 * 4);
    const texture = new DataTexture(pixels, 2, 2, RGBAFormat, UnsignedByteType);
    const material = new MeshStandardMaterial({ map: texture });
    const world = new Scene();
    const viewmodel = new Scene();
    world.add(new Mesh(geometry, material));
    viewmodel.add(new Mesh(geometry, material));

    expect(estimateGpuAssetBytes(world, viewmodel)).toBe(
      geometry.getAttribute('position').array.byteLength
      + geometry.index!.array.byteLength
      + pixels.byteLength,
    );
  });

  it('binds an asynchronous WebGL2 timer result to the matching rendered frame', () => {
    const timer = {
      QUERY_COUNTER_BITS_EXT: 0x8864,
      TIME_ELAPSED_EXT: 0x88bf,
      GPU_DISJOINT_EXT: 0x8fbb,
    };
    const debug = { UNMASKED_VENDOR_WEBGL: 1, UNMASKED_RENDERER_WEBGL: 2 };
    const query = {} as WebGLQuery;
    const context = {
      QUERY_RESULT_AVAILABLE: 0x8867,
      QUERY_RESULT: 0x8866,
      VENDOR: 0x1f00,
      RENDERER: 0x1f01,
      getExtension: (name: string) => name === 'EXT_disjoint_timer_query_webgl2' ? timer : debug,
      createQuery: () => query,
      beginQuery: () => undefined,
      endQuery: () => undefined,
      deleteQuery: () => undefined,
      getQueryParameter: (_query: WebGLQuery, parameter: number) => (
        parameter === 0x8867 ? true : 10_000_000
      ),
      getParameter: (parameter: number) => {
        if (parameter === timer.GPU_DISJOINT_EXT) return false;
        if (parameter === debug.UNMASKED_VENDOR_WEBGL) return 'NVIDIA Corporation';
        if (parameter === debug.UNMASKED_RENDERER_WEBGL) return 'NVIDIA GeForce RTX 3060';
        return '';
      },
      getQuery: () => 64,
    } as unknown as WebGL2RenderingContext;
    const scene = new Scene();
    const profiler = new WebGLFrameProfiler(
      { getContext: () => context } as unknown as import('three').WebGLRenderer,
      [scene],
      context,
    );
    const stats = {
      calls: 420,
      triangles: 2_100_000,
      points: 0,
      lines: 0,
      geometries: 1,
      textures: 1,
      programs: 1,
      peakCalls: 420,
      peakTriangles: 2_100_000,
    };

    expect(profiler.start().supported).toBe(true);
    profiler.beginFrame(100);
    profiler.endFrame(4, stats);
    profiler.beginFrame(116.5);
    profiler.endFrame(6.25, stats);
    profiler.stop();
    const result = profiler.result();

    expect(result.hardware).toEqual({
      vendor: 'NVIDIA Corporation',
      device: 'NVIDIA GeForce RTX 3060',
      timerQueryBits: 64,
    });
    expect(result.samples).toEqual([{
      timestampMs: 16.5,
      frameMs: 16.5,
      gpuMs: 10,
      mainThreadMs: 6.25,
      drawCalls: 420,
      triangles: 2_100_000,
      gpuDisjoint: false,
    }]);
  });
});
