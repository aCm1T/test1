import {
  AudioLoader,
  LoadingManager,
  Texture,
  WebGLRenderer,
} from 'three';
import { DRACOLoader } from 'three/addons/loaders/DRACOLoader.js';
import { GLTFLoader, type GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { KTX2Loader } from 'three/addons/loaders/KTX2Loader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';
import type {
  AssetLoaderMap,
  AssetLoadContext,
  BuiltInAssetKind,
} from './AssetRegistry';

export interface ThreeAssetLoaderOptions {
  /** Public directory containing the Draco WASM/JS decoder pair. */
  dracoDecoderPath?: string;
  /** Public directory containing Basis/KTX2 transcoder assets. */
  ktx2TranscoderPath?: string;
  /** Required to choose a KTX2 GPU target. */
  renderer: WebGLRenderer;
  manager?: LoadingManager;
}

export interface ThreeAssetLoaders {
  loaders: AssetLoaderMap<BuiltInAssetKind>;
  dispose(): void;
}

/**
 * Concrete manifest loaders for authored GLB, KTX2 and audio assets.
 *
 * GLB loading always enables Meshopt and Draco so supplied hero models can use
 * either codec. KTX2 target selection is deferred until a real renderer exists.
 */
export function createThreeAssetLoaders(
  options: ThreeAssetLoaderOptions,
): ThreeAssetLoaders {
  const manager = options.manager ?? new LoadingManager();
  const draco = new DRACOLoader(manager);
  draco.setDecoderPath(options.dracoDecoderPath ?? '/assets/decoders/draco/');

  const ktx2 = new KTX2Loader(manager);
  ktx2
    .setTranscoderPath(options.ktx2TranscoderPath ?? '/assets/decoders/basis/')
    .detectSupport(options.renderer);

  const gltf = new GLTFLoader(manager)
    .setDRACOLoader(draco)
    .setKTX2Loader(ktx2)
    .setMeshoptDecoder(MeshoptDecoder);
  const audio = new AudioLoader(manager);

  const loadGltf = (context: AssetLoadContext<BuiltInAssetKind>) =>
    new Promise<GLTF>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason);
        return;
      }
      const onAbort = () => reject(context.signal.reason);
      context.signal.addEventListener('abort', onAbort, { once: true });
      gltf.load(
        context.resolvedUrl,
        (value) => {
          context.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        undefined,
        (error) => {
          context.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });

  const loadKtx2 = (context: AssetLoadContext<BuiltInAssetKind>) =>
    new Promise<Texture>((resolve, reject) => {
      if (context.signal.aborted) {
        reject(context.signal.reason);
        return;
      }
      const onAbort = () => reject(context.signal.reason);
      context.signal.addEventListener('abort', onAbort, { once: true });
      ktx2.load(
        context.resolvedUrl,
        (value) => {
          context.signal.removeEventListener('abort', onAbort);
          resolve(value);
        },
        undefined,
        (error) => {
          context.signal.removeEventListener('abort', onAbort);
          reject(error);
        },
      );
    });

  return {
    loaders: {
      gltf: {
        load: loadGltf,
        dispose: (value) => disposeGLTF(value as GLTF),
      },
      ktx2: {
        load: loadKtx2,
        dispose: (value) => (value as Texture).dispose(),
      },
      audio: {
        load: async (context) => {
          const buffer = await new Promise<AudioBuffer>((resolve, reject) => {
            audio.load(context.resolvedUrl, resolve, undefined, reject);
          });
          return buffer;
        },
      },
    },
    dispose: () => {
      draco.dispose();
      ktx2.dispose();
    },
  };
}

function disposeGLTF(gltf: GLTF): void {
  gltf.scene.traverse((node) => {
    const mesh = node as import('three').Mesh;
    if (!mesh.isMesh) return;
    mesh.geometry.dispose();
    const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
    for (const material of materials) {
      for (const value of Object.values(material)) {
        if (value instanceof Texture) value.dispose();
      }
      material.dispose();
    }
  });
}
