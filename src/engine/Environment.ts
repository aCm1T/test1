import {
  AmbientLight,
  Color,
  DataTexture,
  EquirectangularReflectionMapping,
  FloatType,
  LinearFilter,
  LinearSRGBColorSpace,
  PMREMGenerator,
  Scene,
  Vector3,
  type WebGLRenderer,
} from 'three';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';

/**
 * Install a dusk-biased IBL environment so MeshStandardMaterial metals
 * don't crush to black without an env map.
 */
export function setupEnvironment(
  renderer: WebGLRenderer,
  scene: Scene,
): { dispose: () => void } {
  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  // Warm-dusk room env as base IBL
  const room = new RoomEnvironment();
  const envRT = pmrem.fromScene(room, 0.04);
  scene.environment = envRT.texture;
  scene.environmentIntensity = 1.05;

  // Soft warm ambient — avoid cool cyan that paints asphalt into a blue void
  const ambient = new AmbientLight(0x6a6870, 0.55);
  ambient.name = 'AmbientDusk';
  scene.add(ambient);

  // Procedural equirect gradient as background (readable dusk sky)
  const skyTex = createDuskSkyTexture();
  skyTex.mapping = EquirectangularReflectionMapping;
  scene.background = skyTex;

  const dispose = (): void => {
    scene.remove(ambient);
    ambient.dispose();
    if (scene.environment === envRT.texture) {
      scene.environment = null;
    }
    envRT.dispose();
    skyTex.dispose();
    pmrem.dispose();
    room.dispose?.();
  };

  return { dispose };
}

/** Low-res equirect dusk gradient — cool zenith, warm horizon, dark nadir. */
function createDuskSkyTexture(): DataTexture {
  const width = 512;
  const height = 256;
  const data = new Float32Array(width * height * 4);

  const zenith = new Color(0x101828);
  const horizonWarm = new Color(0xd46830);
  const horizonCool = new Color(0x4a6078);
  // Warm-dark nadir — cool blue nadir was reading as "missing ground" in screenshots.
  const nadir = new Color(0x1a1410);
  const tmp = new Color();

  for (let y = 0; y < height; y++) {
    const v = y / (height - 1); // 0 = top (zenith in equirect), 1 = bottom
    // Map so middle band is horizon
    const elev = 1 - v; // 1 zenith → 0 nadir
    for (let x = 0; x < width; x++) {
      const u = x / (width - 1);
      // Warm glow biased to -X sun direction (u ~ 0.15–0.35)
      const sunBias = Math.exp(-Math.pow((u - 0.22) * 4.2, 2));

      if (elev > 0.55) {
        const t = (elev - 0.55) / 0.45;
        tmp.copy(horizonCool).lerp(zenith, t);
      } else if (elev > 0.42) {
        const t = (elev - 0.42) / 0.13;
        tmp.copy(horizonWarm).lerp(horizonCool, t);
        tmp.lerp(horizonWarm, sunBias * 0.55);
      } else if (elev > 0.28) {
        const t = (elev - 0.28) / 0.14;
        tmp.copy(nadir).lerp(horizonWarm, t);
        tmp.lerp(horizonWarm, sunBias * 0.35 * t);
      } else {
        tmp.copy(nadir);
      }

      // Gentle noise-free banding soften via slight brightness lift
      const i = (y * width + x) * 4;
      data[i] = tmp.r;
      data[i + 1] = tmp.g;
      data[i + 2] = tmp.b;
      data[i + 3] = 1;
    }
  }

  const tex = new DataTexture(data, width, height);
  tex.type = FloatType;
  tex.colorSpace = LinearSRGBColorSpace;
  tex.minFilter = LinearFilter;
  tex.magFilter = LinearFilter;
  tex.needsUpdate = true;
  return tex;
}

export type { Vector3 };
