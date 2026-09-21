import {
  BackSide,
  ClampToEdgeWrapping,
  Color,
  CylinderGeometry,
  Group,
  LinearFilter,
  LinearMipmapLinearFilter,
  Mesh,
  MeshBasicMaterial,
  SRGBColorSpace,
  Texture,
  TextureLoader,
  Vector2,
  type Object3D,
} from 'three';
import { assetUrl } from '../AssetPaths';

/**
 * Original project artwork used only to enrich the procedural development
 * fallback. It is deliberately not part of the authored asset contract.
 */
export const DEVELOPMENT_SKYLINE_BACKDROP_URL =
  assetUrl('assets/development/nightglass-dusk-skyline-v1.png');

/**
 * The source image's final quarter is a photographed rooftop/foreground.
 * Map it out rather than attempting to hide a second ground plane at runtime.
 */
export const DEVELOPMENT_SKYLINE_CROP_BOTTOM = 0.24;

/**
 * An inward-facing arc is centred on +Z, beyond the 70-unit combat arena.
 * Its arc length and cropped image height retain the plate's native aspect.
 */
export const DEVELOPMENT_SKYLINE_LAYOUT = Object.freeze({
  radius: 112,
  height: 80,
  radialSegments: 48,
  thetaStart: -1,
  thetaLength: 2,
  bottomY: 0,
  cropBottom: DEVELOPMENT_SKYLINE_CROP_BOTTOM,
});

export type DevelopmentSkylineBackdropState =
  | 'idle'
  | 'loading'
  | 'installed'
  | 'failed'
  | 'disposed';

export interface DevelopmentSkylineBackdropLoadReport {
  state: Exclude<DevelopmentSkylineBackdropState, 'idle' | 'loading'>;
  error?: unknown;
}

type TextureLoad = (url: string) => Promise<Texture>;

export interface DevelopmentSkylineBackdropOptions {
  /** Scene-only attachment: never attach this visual layer to gameplay data. */
  parent: Object3D;
  url?: string;
  /** Pass the renderer capability so the source texture does not over-request. */
  maxAnisotropy?: number;
  /** Dependency injection keeps lifecycle/crop behavior testable without WebGL. */
  loadTexture?: TextureLoad;
}

/**
 * A compact, non-colliding skyline plate for the fallback map. Its render
 * state deliberately draws before opaque route geometry, so walls, props, and
 * players retain normal depth occlusion while the plate never writes depth.
 */
export class DevelopmentSkylineBackdrop {
  private readonly parent: Object3D;
  private readonly url: string;
  private readonly maxAnisotropy: number;
  private readonly loadTexture: TextureLoad;
  private readonly root = new Group();
  private state: DevelopmentSkylineBackdropState = 'idle';
  private loadPromise: Promise<DevelopmentSkylineBackdropLoadReport> | null = null;
  private generation = 0;
  private geometry: CylinderGeometry | null = null;
  private material: MeshBasicMaterial | null = null;
  private texture: Texture | null = null;

  constructor(options: DevelopmentSkylineBackdropOptions) {
    this.parent = options.parent;
    this.url = options.url ?? DEVELOPMENT_SKYLINE_BACKDROP_URL;
    // Eight taps is visually stable for the shallow plate angle without asking
    // low-end devices for an excessive texture cost.
    this.maxAnisotropy = Math.max(1, Math.min(8, Math.floor(options.maxAnisotropy ?? 8)));
    this.loadTexture = options.loadTexture ?? defaultLoadTexture;
    this.root.name = 'DevelopmentSkylineBackdrop';
    this.root.userData.developmentOnly = true;
    this.root.userData.visualOnly = true;
    this.root.userData.authoredContract = false;
  }

  getState(): DevelopmentSkylineBackdropState {
    return this.state;
  }

  /** Starts the optional load and always reports failure instead of throwing into bootstrap. */
  load(): Promise<DevelopmentSkylineBackdropLoadReport> {
    if (this.state === 'disposed') return Promise.resolve({ state: 'disposed' });
    if (this.loadPromise) return this.loadPromise;
    this.state = 'loading';
    this.loadPromise = this.loadInternal(this.generation);
    return this.loadPromise;
  }

  /** Idempotently releases the one texture, material, and geometry this layer owns. */
  dispose(): void {
    if (this.state === 'disposed') return;
    this.generation += 1;
    this.state = 'disposed';
    this.root.removeFromParent();
    this.root.clear();
    this.geometry?.dispose();
    this.geometry = null;
    this.material?.dispose();
    this.material = null;
    this.texture?.dispose();
    this.texture = null;
  }

  private async loadInternal(generation: number): Promise<DevelopmentSkylineBackdropLoadReport> {
    let texture: Texture | null = null;
    let geometry: CylinderGeometry | null = null;
    let material: MeshBasicMaterial | null = null;
    try {
      texture = await this.loadTexture(this.url);
      if (!this.isCurrent(generation)) {
        texture.dispose();
        return { state: 'disposed' };
      }

      configureBackdropTexture(texture, this.maxAnisotropy);
      geometry = createSkylineArcGeometry();
      material = new MeshBasicMaterial({
        map: texture,
        side: BackSide,
        depthTest: true,
        depthWrite: false,
        fog: false,
        toneMapped: false,
        // The haze pass dissolves the plate's top edge into the sky dome.
        transparent: true,
      });
      applyAtmosphericHaze(material);
      const mesh = new Mesh(geometry, material);
      mesh.name = 'DevelopmentSkylineArc';
      mesh.position.y = DEVELOPMENT_SKYLINE_LAYOUT.bottomY + DEVELOPMENT_SKYLINE_LAYOUT.height * 0.5;
      mesh.castShadow = false;
      mesh.receiveShadow = false;
      mesh.frustumCulled = false;
      // The sky dome is -1000. This plate follows it, then every opaque route
      // mesh overwrites it at normal depth without the plate ever occluding.
      mesh.renderOrder = -900;
      mesh.userData.developmentOnly = true;
      mesh.userData.visualOnly = true;
      mesh.userData.authoredContract = false;

      if (!this.isCurrent(generation)) {
        geometry.dispose();
        material.dispose();
        texture.dispose();
        return { state: 'disposed' };
      }
      this.texture = texture;
      this.geometry = geometry;
      this.material = material;
      texture = null;
      geometry = null;
      material = null;
      this.root.add(mesh);
      this.parent.add(this.root);
      this.state = 'installed';
      return { state: 'installed' };
    } catch (error) {
      texture?.dispose();
      geometry?.dispose();
      material?.dispose();
      if (!this.isCurrent(generation)) return { state: 'disposed' };
      this.state = 'failed';
      return { state: 'failed', error };
    }
  }

  private isCurrent(generation: number): boolean {
    return this.state !== 'disposed' && generation === this.generation;
  }
}

function defaultLoadTexture(url: string): Promise<Texture> {
  return new TextureLoader().loadAsync(url);
}

/** Exported for focused tests; it has no authored/gameplay dependencies. */
export function createSkylineArcGeometry(): CylinderGeometry {
  const layout = DEVELOPMENT_SKYLINE_LAYOUT;
  const geometry = new CylinderGeometry(
    layout.radius,
    layout.radius,
    layout.height,
    layout.radialSegments,
    1,
    true,
    layout.thetaStart,
    layout.thetaLength,
  );
  // Cylinder UV v=0 maps to the source's lower edge. Remap it to the bottom
  // of the skyline crop, preserving both the source aspect and its lighting.
  const uv = geometry.getAttribute('uv');
  for (let index = 0; index < uv.count; index += 1) {
    uv.setY(index, layout.cropBottom + uv.getY(index) * (1 - layout.cropBottom));
  }
  uv.needsUpdate = true;
  return geometry;
}

/**
 * Aerial perspective for the plate.
 *
 * The unmodified image meets the ground plane as a hard, fully saturated line,
 * which is the clearest sign that a distant city has been pasted behind the
 * arena. Real haze removes contrast and saturation with depth, and it removes
 * the most near the horizon. Fading the plate's lower band into the scene's
 * dusk haze colour therefore seats it behind the playable street instead of
 * stacking it on top. Exported for focused tests; it owns no scene state.
 */
export const DEVELOPMENT_SKYLINE_HAZE = Object.freeze({
  color: 0x4a5f78,
  /** Fraction of the cropped plate height fully dissolved into haze. */
  span: 0.34,
  strength: 0.82,
  /** Residual desaturation applied across the whole plate. */
  desaturation: 0.22,
  /**
   * The plate is a finite 80-unit band, so anything above its top edge falls
   * back to the sky dome. The photographed sky and the analytic dome never
   * match exactly, and an abrupt cut-off draws a hard curved seam straight
   * across the upper frame. Dissolving the plate's top band into the dome
   * hides the transition. Values are plate UV.
   */
  topFadeStart: 0.74,
  topFadeEnd: 0.99,
});

export function applyAtmosphericHaze(material: MeshBasicMaterial): void {
  const haze = new Color(DEVELOPMENT_SKYLINE_HAZE.color);
  const cropBottom = DEVELOPMENT_SKYLINE_LAYOUT.cropBottom;
  material.onBeforeCompile = (shader) => {
    shader.uniforms.nightglassHazeColor = { value: haze };
    shader.uniforms.nightglassHazeRange = {
      value: new Vector2(cropBottom, cropBottom + DEVELOPMENT_SKYLINE_HAZE.span),
    };
    shader.uniforms.nightglassHazeStrength = { value: DEVELOPMENT_SKYLINE_HAZE.strength };
    shader.uniforms.nightglassHazeDesaturation = {
      value: DEVELOPMENT_SKYLINE_HAZE.desaturation,
    };
    shader.uniforms.nightglassTopFade = {
      value: new Vector2(
        DEVELOPMENT_SKYLINE_HAZE.topFadeStart,
        DEVELOPMENT_SKYLINE_HAZE.topFadeEnd,
      ),
    };
    shader.vertexShader = shader.vertexShader
      .replace(
        '#include <common>',
        '#include <common>\nvarying vec2 vNightglassPlateUv;',
      )
      .replace(
        '#include <begin_vertex>',
        '#include <begin_vertex>\nvNightglassPlateUv = uv;',
      );
    shader.fragmentShader = shader.fragmentShader
      .replace(
        '#include <common>',
        `#include <common>
varying vec2 vNightglassPlateUv;
uniform vec3 nightglassHazeColor;
uniform vec2 nightglassHazeRange;
uniform float nightglassHazeStrength;
uniform float nightglassHazeDesaturation;
uniform vec2 nightglassTopFade;`,
      )
      .replace(
        '#include <dithering_fragment>',
        `#include <dithering_fragment>
float nightglassPlateLuma = dot(gl_FragColor.rgb, vec3(0.2126, 0.7152, 0.0722));
gl_FragColor.rgb = mix(gl_FragColor.rgb, vec3(nightglassPlateLuma), nightglassHazeDesaturation);
float nightglassHaze = 1.0 - smoothstep(nightglassHazeRange.x, nightglassHazeRange.y, vNightglassPlateUv.y);
gl_FragColor.rgb = mix(gl_FragColor.rgb, nightglassHazeColor, nightglassHaze * nightglassHazeStrength);
gl_FragColor.a *= 1.0 - smoothstep(nightglassTopFade.x, nightglassTopFade.y, vNightglassPlateUv.y);`,
      );
  };
  material.customProgramCacheKey = () => 'nightglass-skyline-haze-v2';
  material.needsUpdate = true;
}

function configureBackdropTexture(texture: Texture, maxAnisotropy: number): void {
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.generateMipmaps = true;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.magFilter = LinearFilter;
  texture.anisotropy = maxAnisotropy;
  texture.needsUpdate = true;
}
