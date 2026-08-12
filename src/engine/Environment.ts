import {
  AmbientLight,
  BackSide,
  Color,
  Mesh,
  PMREMGenerator,
  Scene,
  ShaderMaterial,
  SphereGeometry,
  EquirectangularReflectionMapping,
  type Texture,
  type WebGLRenderTarget,
  type WebGLRenderer,
  type Vector3,
} from 'three';

export interface ReflectionProbeInput {
  id: string;
  position: readonly [number, number, number];
  texture: Texture;
}

export interface EnvironmentSetup {
  /** Development-only HDRI for fallback indirect light and reflections. */
  loadDevelopmentFallback(url: string): Promise<boolean>;
  setEnvironmentTexture(texture: Texture, useAsBackground?: boolean): void;
  setReflectionProbes(probes: readonly ReflectionProbeInput[]): void;
  update(position: Pick<Vector3, 'x' | 'y' | 'z'>): void;
  clearAuthoredTextures(): void;
  dispose(): void;
}
import { RGBELoader } from 'three/addons/loaders/RGBELoader.js';

/**
 * Indirect multiplier for the procedural fallback's sky+bounce probe.
 *
 * This is omnidirectional, so it buys legibility at the direct cost of form:
 * at the previous 2.9 it supplied roughly two thirds of every surface's light
 * and the street photographed as flat shaded massing with no cast shadows.
 * The route now carries its value range on a shadowed CSM key instead, and
 * this only has to keep shadow interiors off the grade's toe.
 */
const FALLBACK_ENVIRONMENT_INTENSITY = 1.75;

/**
 * The CC0 dusk HDRI is a full outdoor capture with real ground, so it needs far
 * less help than the analytic probe — but it still owns the whole indirect
 * budget once installed.
 */
const DEVELOPMENT_ENVIRONMENT_INTENSITY = 1.15;

/**
 * Install dusk IBL + sky dome so MeshStandardMaterial metals don't crush to black
 * and the horizon isn't a misleading equirect "fake ground".
 */
export function setupEnvironment(
  renderer: WebGLRenderer,
  scene: Scene,
): EnvironmentSetup {
  const pmrem = new PMREMGenerator(renderer);
  pmrem.compileEquirectangularShader();

  let authoredEnvironment: WebGLRenderTarget | null = null;
  let authoredBackground: Texture | null = null;
  let developmentEnvironment: WebGLRenderTarget | null = null;
  let developmentSource: Texture | null = null;
  let disposed = false;
  let activeProbeId: string | null = null;
  const probes = new Map<string, {
    position: readonly [number, number, number];
    target: WebGLRenderTarget;
  }>();
  const ambient = new AmbientLight(0x3d536c, 0.13);
  ambient.name = 'AmbientDusk';
  scene.add(ambient);

  renderer.setClearColor(0x132335, 1);
  scene.background = new Color(0x15283b);

  const skyGeo = new SphereGeometry(380, 48, 24);

  const SKY_VERTEX_SHADER = `
      varying vec3 vWorld;
      void main() {
        vec4 world = modelMatrix * vec4(position, 1.0);
        vWorld = normalize(world.xyz - cameraPosition);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
      }
    `;

  /**
   * `IRRADIANCE_MODE` compiles the same gradient into the probe variant used for
   * the fallback IBL.
   *
   * A sky dome alone is not an environment: everything below the horizon is
   * empty, so convolving the visible dome yields almost no downward or lateral
   * irradiance and every unlit surface collapses to black. Real streets are lit
   * as much by asphalt bounce and the facades' own spill as by the sky, so the
   * probe variant substitutes an urban ground/practical response below the
   * horizon that the visible dome never shows.
   */
  const createSkyMaterial = (irradianceMode: boolean): ShaderMaterial => new ShaderMaterial({
    side: BackSide,
    depthWrite: false,
    fog: false,
    defines: irradianceMode ? { IRRADIANCE_MODE: '1' } : {},
    uniforms: {
      // The zenith is the only thing an upward-facing reflective surface can
      // see, so it stays a readable deep blue rather than the near-black a
      // late-dusk photograph would show.
      topColor: { value: new Color(0x101d38) },
      midColor: { value: new Color(0x1e3a58) },
      botColor: { value: new Color(0x2b4459) },
      horizonColor: { value: new Color(0x6d5a63) },
      sunColor: { value: new Color(0xff8f4e) },
      // Bounce off wet asphalt and lamp-lit facades: warm, dim, and the only
      // reason downward-facing normals resolve as anything but black.
      bounceColor: { value: new Color(0x4a4038) },
      practicalColor: { value: new Color(0xff9d55) },
      irradianceGain: { value: 1 },
    },
    vertexShader: SKY_VERTEX_SHADER,
    fragmentShader: `
      uniform vec3 topColor;
      uniform vec3 midColor;
      uniform vec3 botColor;
      uniform vec3 horizonColor;
      uniform vec3 sunColor;
      uniform vec3 bounceColor;
      uniform vec3 practicalColor;
      uniform float irradianceGain;
      varying vec3 vWorld;

      // Cheap value noise; only ever sampled a handful of times per fragment.
      float hash(vec2 p) {
        return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453);
      }
      float noise(vec2 p) {
        vec2 i = floor(p);
        vec2 f = fract(p);
        f = f * f * (3.0 - 2.0 * f);
        return mix(
          mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x),
          mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x),
          f.y
        );
      }

      void main() {
        vec3 dir = normalize(vWorld);
        float h = dir.y;

        vec3 col = mix(botColor, midColor, smoothstep(-0.25, 0.10, h));
        col = mix(col, topColor, smoothstep(0.08, 0.75, h));

        // A tight warm band hugging the horizon is what makes the hour read as
        // dusk rather than a generic blue night gradient.
        float band = exp(-pow(h * 7.5, 2.0));
        vec3 sunDir = normalize(vec3(-0.86, 0.06, 0.24));
        float azimuth = max(0.0, dot(normalize(vec3(dir.x, 0.0, dir.z)), normalize(vec3(sunDir.x, 0.0, sunDir.z))));
        col = mix(col, horizonColor, band * (0.28 + 0.55 * azimuth));

        // Residual sun glow, well below the bloom threshold so the sky never
        // competes with the practicals for the viewer's eye.
        float sun = exp(-pow(length(dir - sunDir) * 2.4, 2.0));
        col += sunColor * sun * 0.30;
        col += sunColor * pow(azimuth, 6.0) * band * 0.12;

        // Slow stratus banding breaks the gradient's obvious vertical ramp.
        float cloud = noise(vec2(atan(dir.z, dir.x) * 2.4, h * 9.0));
        cloud = smoothstep(0.52, 0.95, cloud) * smoothstep(0.62, 0.06, abs(h));
        col = mix(col, col * 1.22 + horizonColor * 0.10, cloud * 0.45);

      #ifdef IRRADIANCE_MODE
        // Ground/facade bounce fills the lower hemisphere the dome leaves empty.
        float ground = smoothstep(0.03, -0.42, h);
        col = mix(col, bounceColor * (0.72 + 0.5 * azimuth), ground * 0.9);
        // Street practicals ring the horizon; without them lateral irradiance
        // stays uniformly blue and every facade reads as moonlit concrete.
        col += practicalColor * exp(-pow((h + 0.03) * 8.0, 2.0)) * 0.34;
        col *= irradianceGain;
      #endif

        gl_FragColor = vec4(col, 1.0);
      }
    `,
  });

  const skyMat = createSkyMaterial(false);
  const sky = new Mesh(skyGeo, skyMat);
  sky.name = 'DuskSkyDome';
  sky.frustumCulled = false;
  sky.renderOrder = -1000;
  scene.add(sky);

  // Convolve the dusk dome itself into the fallback IBL. A neutral
  // RoomEnvironment previously supplied every reflection, so wet asphalt,
  // glass and metal all reported a bright studio interior that contradicted
  // the sky directly above them. Reflecting the actual sky is what gives the
  // procedural route a coherent blue-hour response.
  const skyProbeScene = new Scene();
  const skyProbeMat = createSkyMaterial(true);
  const skyProbe = new Mesh(skyGeo, skyProbeMat);
  skyProbe.frustumCulled = false;
  skyProbeScene.add(skyProbe);
  // The dome sits at radius 380, well past PMREMGenerator's default 100-unit
  // far plane; without an explicit far the probe would capture only clipped
  // background and the whole scene would lose its indirect light.
  const envRT = pmrem.fromScene(skyProbeScene, 0.06, 0.1, 1000);
  skyProbeScene.remove(skyProbe);
  skyProbeMat.dispose();

  scene.environment = envRT.texture;
  // A dusk sky plus street bounce carries far less radiance than the studio
  // room it replaced, so the multiplier is what restores the scene's indirect
  // budget. Lowering it does not "tone the scene down" — it black-crushes it.
  scene.environmentIntensity = FALLBACK_ENVIRONMENT_INTENSITY;

  const fallbackEnvironmentTexture = (): Texture => developmentEnvironment?.texture ?? envRT.texture;

  const setEnvironmentTexture = (texture: Texture, useAsBackground = true): void => {
    authoredEnvironment?.dispose();
    texture.mapping = EquirectangularReflectionMapping;
    authoredEnvironment = pmrem.fromEquirectangular(texture);
    scene.environment = authoredEnvironment.texture;
    // Authored probes/lightmaps own the final route's indirect balance and are
    // calibrated HDR captures, so they need none of the analytic probe's gain.
    scene.environmentIntensity = 0.52;
    if (useAsBackground) {
      authoredBackground = texture;
      scene.background = texture;
    }
  };

  const loadDevelopmentFallback = async (url: string): Promise<boolean> => {
    // Author-provided lighting owns the environment immediately on install.
    // This can enrich only the procedural fallback, never replace that path.
    if (disposed || authoredEnvironment) return false;

    let texture: Texture | null = null;
    let target: WebGLRenderTarget | null = null;
    try {
      texture = await new RGBELoader().loadAsync(url);
      if (disposed || authoredEnvironment) {
        texture.dispose();
        return false;
      }

      texture.mapping = EquirectangularReflectionMapping;
      target = pmrem.fromEquirectangular(texture);
      if (disposed || authoredEnvironment) {
        target.dispose();
        texture.dispose();
        return false;
      }

      developmentEnvironment?.dispose();
      developmentSource?.dispose();
      developmentEnvironment = target;
      developmentSource = texture;
      target = null;
      texture = null;
      // The procedural sky remains visible: HDRI data is indirect light only.
      scene.environment = developmentEnvironment.texture;
      // The CC0 dusk plate is intentionally warmer than NIGHTGLASS' blue-hour
      // key, so it stays below the analytic probe's multiplier — but it still
      // has to carry the scene's entire indirect budget once it replaces it.
      scene.environmentIntensity = DEVELOPMENT_ENVIRONMENT_INTENSITY;
      return true;
    } catch (error) {
      target?.dispose();
      texture?.dispose();
      console.warn('[environment] development HDRI unavailable; retaining fallback environment', error);
      return false;
    }
  };

  const setReflectionProbes = (inputs: readonly ReflectionProbeInput[]): void => {
    for (const probe of probes.values()) probe.target.dispose();
    probes.clear();
    activeProbeId = null;
    for (const input of inputs) {
      input.texture.mapping = EquirectangularReflectionMapping;
      probes.set(input.id, {
        position: input.position,
        target: pmrem.fromEquirectangular(input.texture),
      });
    }
  };

  const update = (position: Pick<Vector3, 'x' | 'y' | 'z'>): void => {
    let nearest: { id: string; distanceSq: number; target: WebGLRenderTarget } | null = null;
    for (const [id, probe] of probes) {
      const dx = position.x - probe.position[0];
      const dy = position.y - probe.position[1];
      const dz = position.z - probe.position[2];
      const distanceSq = dx * dx + dy * dy + dz * dz;
      if (!nearest || distanceSq < nearest.distanceSq) {
        nearest = { id, distanceSq, target: probe.target };
      }
    }
    if (!nearest || nearest.id === activeProbeId) return;
    activeProbeId = nearest.id;
    scene.environment = nearest.target.texture;
  };

  const clearAuthoredTextures = (): void => {
    authoredEnvironment?.dispose();
    authoredEnvironment = null;
    for (const probe of probes.values()) probe.target.dispose();
    probes.clear();
    activeProbeId = null;
    scene.environment = fallbackEnvironmentTexture();
    scene.environmentIntensity = developmentEnvironment
      ? DEVELOPMENT_ENVIRONMENT_INTENSITY
      : FALLBACK_ENVIRONMENT_INTENSITY;
    if (authoredBackground && scene.background === authoredBackground) {
      scene.background = new Color(0x15283b);
    }
    authoredBackground = null;
  };

  const dispose = (): void => {
    disposed = true;
    scene.remove(ambient);
    ambient.dispose();
    scene.remove(sky);
    skyGeo.dispose();
    skyMat.dispose();
    const developmentTexture = developmentEnvironment?.texture;
    clearAuthoredTextures();
    if (scene.environment === envRT.texture || scene.environment === developmentTexture) {
      scene.environment = null;
    }
    developmentEnvironment?.dispose();
    developmentEnvironment = null;
    developmentSource?.dispose();
    developmentSource = null;
    envRT.dispose();
    pmrem.dispose();
  };

  return {
    loadDevelopmentFallback,
    setEnvironmentTexture,
    setReflectionProbes,
    update,
    clearAuthoredTextures,
    dispose,
  };
}
