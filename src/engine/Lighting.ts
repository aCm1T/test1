import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  MeshStandardMaterial,
  PointLight,
  Scene,
  Vector3,
} from 'three';
import type { QualityProfile } from './Quality';

export interface LightingSetup {
  hemi: HemisphereLight;
  sun: DirectionalLight;
  moon: DirectionalLight;
  /** Shadowless cool backlight that separates silhouettes from the facades. */
  rim: DirectionalLight;
  windows: PointLight[];
  fills: PointLight[];
  applyQuality: (profile: QualityProfile) => void;
  applyHeightFog: (material: MeshStandardMaterial) => void;
  dispose: () => void;
}

export interface LightingOptions {
  /** Approximate playable map half-extent for sun shadow frustum. */
  mapRadius?: number;
  /** Cool sky / ground hemisphere colors. */
  skyColor?: number;
  groundColor?: number;
  sunColor?: number;
  sunIntensity?: number;
  hemiIntensity?: number;
  moonIntensity?: number;
  /** Cool separation backlight aimed down the playable street. */
  rimIntensity?: number;
  fogDensity?: number;
  fogColor?: number;
  shadowMapSize?: number;
  /**
   * Applies the restrained blue-hour calibration used by the procedural
   * development route. Authored environments retain their supplied lighting
   * response, while the fallback avoids reading as a brightly studio-lit set
   * in front of its dusk skyline plate.
   */
  developmentFallback?: boolean;
}

/**
 * Dusk urban lighting: cool blue ambient hemisphere, warm orange sun with
 * soft shadows covering ~80u map, warm window PointLights, and world-height fog.
 * Readable MW2019-style dusk — orange sun rims + cool fill, not a black void.
 *
 * Shadow darkness is dialed for readable key contrast (shadow.intensity ~0.4)
 * so asphalt and facade albedos survive ACES + PCF without crushing into a
 * black void or washing out under soft fill.
 */
export function setupLighting(
  scene: Scene,
  options: LightingOptions = {},
): LightingSetup {
  const mapRadius = options.mapRadius ?? 40;
  const shadowMapSize = options.shadowMapSize ?? 2048;
  const developmentFallback = options.developmentFallback === true;
  // The fallback has no baked lightmaps or calibrated reflection probes. Keep
  // the key/fill relationship slightly cooler and lower-keyed so its rough
  // procedural surfaces sit in the same blue-hour range as the skyline plate.
  const fallbackKeyScale = developmentFallback ? 0.82 : 1;
  const fallbackHemiScale = developmentFallback ? 0.9 : 1;
  const fallbackMoonScale = developmentFallback ? 1.28 : 1;

  // Desaturated blue sky fill and charcoal ground bounce preserve material
  // read without turning the entire route cyan. The sun remains warm enough
  // for a dusk rim, but no longer paints every facade a flat orange-beige.
  const skyColor = new Color(options.skyColor ?? 0x5d7897);
  const groundColor = new Color(options.groundColor ?? 0x363b40);
  const sunColor = new Color(options.sunColor ?? 0xf2b17a);
  const suppliedFogColor = new Color(options.fogColor ?? 0x3a4450);
  // Draw the procedural route progressively into the same blue-gray value
  // family as the distant plate. This is intentionally a small shift rather
  // than a dense full-screen haze.
  const fogColor = developmentFallback
    ? suppliedFogColor.clone().lerp(new Color(0x536b84), 0.38)
    : suppliedFogColor;

  // --- Hemisphere (readable dusk fill, warm ground bounce) ---
  // Slightly restrained so key/CSM modelling stays visible without crushing
  // midtones into a black void — dusk remains warm-gray, not night.
  const hemi = new HemisphereLight(
    skyColor,
    groundColor,
    (options.hemiIntensity ?? 1.95) * fallbackHemiScale,
  );
  hemi.name = 'HemiDusk';
  scene.add(hemi);

  // --- Directional sun (low orange dusk) ---
  // Intensity kept assertive for rims; shadow.intensity restores key contrast
  // without returning to full-black PCF umbras.
  const sun = new DirectionalLight(
    sunColor,
    (options.sunIntensity ?? 2.55) * fallbackKeyScale,
  );
  sun.name = 'SunDusk';
  // Low western sun — long urban shadows.
  sun.position.set(-38, 36, 18);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.0002;
  sun.shadow.normalBias = 0.045;
  sun.shadow.radius = 3.8;
  // Restored key/shadow contrast (was 0.28); still soft enough for asphalt read.
  sun.shadow.intensity = 0.4;

  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = mapRadius * 4;
  cam.left = -mapRadius;
  cam.right = mapRadius;
  cam.top = mapRadius;
  cam.bottom = -mapRadius;
  cam.updateProjectionMatrix();

  // --- Moon fill (soft cool opposite, dialed down so streets stay warm-gray) ---
  const moon = new DirectionalLight(
    0x9bb8d3,
    (options.moonIntensity ?? 0.46) * fallbackMoonScale,
  );
  moon.name = 'MoonFill';
  moon.position.set(36, 26, -20);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = false;
  scene.add(moon);
  scene.add(moon.target);

  // --- Rim / separation backlight ---
  // The playable route runs north down +Z, so a light sitting behind the far
  // end of the street traces a cool edge along every prop, wreck and hostile
  // facing the player. Without it the blockout's flat faces merge into the
  // facades behind them and the frame reads as untextured massing.
  const rim = new DirectionalLight(
    0xbcd2ec,
    (options.rimIntensity ?? 0.52) * (developmentFallback ? 1.1 : 1),
  );
  rim.name = 'RimSeparation';
  rim.position.set(10, 20, 52);
  rim.target.position.set(0, 1.5, 0);
  rim.castShadow = false;
  scene.add(rim);
  scene.add(rim.target);

  // --- Warm window / neon PointLights ---
  // Trimmed count/energy so maxDynamicLights keeps key shadows readable.
  const windowDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(-18, 4.2, -12), color: 0xffb060, intensity: 0.82, dist: 16 },
    { pos: new Vector3(14, 5.5, 8), color: 0xff9a4a, intensity: 0.7, dist: 14 },
    { pos: new Vector3(-6, 3.8, 22), color: 0xffc070, intensity: 0.66, dist: 13 },
    { pos: new Vector3(22, 6.0, -16), color: 0xff8844, intensity: 0.68, dist: 15 },
    { pos: new Vector3(4, 2.6, -24), color: 0xffaa55, intensity: 0.58, dist: 12 },
    { pos: new Vector3(-22, 7.0, -2), color: 0xffb870, intensity: 0.6, dist: 14 },
  ];

  const windows: PointLight[] = [];
  for (let i = 0; i < windowDefs.length; i++) {
    const def = windowDefs[i];
    const pl = new PointLight(def.color, def.intensity, def.dist, 2);
    pl.position.copy(def.pos);
    pl.name = `WindowLight_${i}`;
    // Point lights stay shadowless — multiple shadow maps crush midtones on WebGL.
    pl.castShadow = false;
    scene.add(pl);
    windows.push(pl);
  }

  // --- Soft fill (neutral / warm — cool cyan fills were crushing streets) ---
  // Fewer, quieter fills so quality tiers under maxDynamicLights preserve
  // key/shadow contrast instead of flooding umbras.
  const fillDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(0, 12, 0), color: 0xc8b8a0, intensity: 0.36, dist: 48 },
    { pos: new Vector3(-22, 7, 10), color: 0xa8b0c0, intensity: 0.26, dist: 26 },
    { pos: new Vector3(18, 8, -8), color: 0xc0a888, intensity: 0.28, dist: 24 },
    // Street-level warm bounce near spawn / intersection for screenshot ground read.
    { pos: new Vector3(0, 2.2, 8), color: 0xe0c8a0, intensity: 0.32, dist: 18 },
  ];

  const fills: PointLight[] = [];
  for (let i = 0; i < fillDefs.length; i++) {
    const def = fillDefs[i];
    const pl = new PointLight(def.color, def.intensity, def.dist, 2);
    pl.position.copy(def.pos);
    pl.name = `CoolFill_${i}`;
    pl.castShadow = false;
    scene.add(pl);
    fills.push(pl);
  }

  // --- Atmospheric fog: linear so mid-range street stays readable ---
  // Background is owned by setupEnvironment dusk sky texture.
  scene.fog = new Fog(
    fogColor.getHex(),
    developmentFallback ? 18 : 32,
    developmentFallback ? 104 : 120,
  );
  const heightFogDensity = { value: options.fogDensity ?? 0.012 };
  const heightFogBase = { value: 0.2 };
  const heightFogFalloff = { value: 0.18 };
  const heightFogColor = { value: fogColor.clone() };
  // Haze looking toward the setting sun scatters warm; haze looking away stays
  // blue. Encoding that in the fog is the cheapest available depth cue and is
  // what keeps receding facades from all resolving to the same flat grey.
  const heightFogSunColor = { value: sunColor.clone().lerp(new Color(0xffc08a), 0.45) };
  const heightFogSunDirection = { value: sun.position.clone().normalize() };
  // CSM replaces onBeforeCompile when cascades are reconfigured. Remember the
  // exact wrapper (rather than merely the material) so quality changes can
  // safely re-apply height fog without stacking shader injections.
  const fogCompileCallbacks = new WeakMap<
    MeshStandardMaterial,
    MeshStandardMaterial['onBeforeCompile']
  >();
  const fogBaseProgramKeys = new WeakMap<MeshStandardMaterial, () => string>();

  const applyHeightFog = (material: MeshStandardMaterial): void => {
    if (fogCompileCallbacks.get(material) === material.onBeforeCompile) return;
    const previousCompile = material.onBeforeCompile;
    let baseProgramKey = fogBaseProgramKeys.get(material);
    if (!baseProgramKey) {
      baseProgramKey = material.customProgramCacheKey.bind(material);
      fogBaseProgramKeys.set(material, baseProgramKey);
    }
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile(shader, renderer);
      shader.uniforms.nightglassFogDensity = heightFogDensity;
      shader.uniforms.nightglassFogBase = heightFogBase;
      shader.uniforms.nightglassFogFalloff = heightFogFalloff;
      shader.uniforms.nightglassFogColor = heightFogColor;
      shader.uniforms.nightglassFogSunColor = heightFogSunColor;
      shader.uniforms.nightglassFogSunDirection = heightFogSunDirection;
      shader.vertexShader = shader.vertexShader
        .replace(
          '#include <common>',
          '#include <common>\nvarying vec3 vNightglassWorldPosition;',
        )
        .replace(
          '#include <begin_vertex>',
          '#include <begin_vertex>\nvNightglassWorldPosition = (modelMatrix * vec4(position, 1.0)).xyz;',
        );
      shader.fragmentShader = shader.fragmentShader
        .replace(
          '#include <common>',
          `#include <common>
varying vec3 vNightglassWorldPosition;
uniform float nightglassFogDensity;
uniform float nightglassFogBase;
uniform float nightglassFogFalloff;
uniform vec3 nightglassFogColor;
uniform vec3 nightglassFogSunColor;
uniform vec3 nightglassFogSunDirection;`,
        )
        .replace(
          '#include <fog_fragment>',
          `#include <fog_fragment>
vec3 nightglassFogView = vNightglassWorldPosition - cameraPosition;
float nightglassFogDistance = length(nightglassFogView.xz);
float nightglassFogHeight = exp(-max(vNightglassWorldPosition.y - nightglassFogBase, 0.0) * nightglassFogFalloff);
float nightglassFogFactor = 1.0 - exp(-nightglassFogDistance * nightglassFogDensity * nightglassFogHeight);
float nightglassFogSun = max(dot(normalize(nightglassFogView + vec3(0.0, 0.0001, 0.0)), nightglassFogSunDirection), 0.0);
vec3 nightglassHaze = mix(nightglassFogColor, nightglassFogSunColor, pow(nightglassFogSun, 3.0) * 0.55);
gl_FragColor.rgb = mix(gl_FragColor.rgb, nightglassHaze, clamp(nightglassFogFactor, 0.0, 0.68));`,
        );
    };
    material.customProgramCacheKey = () => `${baseProgramKey()}|nightglass-height-fog-v2`;
    fogCompileCallbacks.set(material, material.onBeforeCompile);
    material.needsUpdate = true;
  };

  const dispose = (): void => {
    scene.remove(hemi);
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(moon);
    scene.remove(moon.target);
    scene.remove(rim);
    scene.remove(rim.target);
    for (const pl of windows) {
      scene.remove(pl);
      pl.dispose();
    }
    for (const pl of fills) {
      scene.remove(pl);
      pl.dispose();
    }
    hemi.dispose();
    sun.dispose();
    moon.dispose();
    rim.dispose();
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
    }
    scene.fog = null;
  };

  const applyQuality = (profile: QualityProfile): void => {
    sun.shadow.mapSize.set(profile.shadowMapSize, profile.shadowMapSize);
    sun.shadow.camera.far = profile.shadowDistance * 2;
    sun.shadow.camera.left = -profile.shadowDistance * 0.5;
    sun.shadow.camera.right = profile.shadowDistance * 0.5;
    sun.shadow.camera.top = profile.shadowDistance * 0.5;
    sun.shadow.camera.bottom = -profile.shadowDistance * 0.5;
    sun.shadow.camera.updateProjectionMatrix();
    const dynamic = [...windows, ...fills];
    for (let index = 0; index < dynamic.length; index += 1) {
      dynamic[index].visible = index < profile.maxDynamicLights;
    }
    // Medium+ (and volumetricFog) get tower falloff. Low stays soft so the
    // near street does not crush to black. Tier check covers float-RT clamps
    // that force volumetricFog off on otherwise capable Medium profiles.
    const useDepthFog = profile.volumetricFog || profile.tier !== 'low';
    if (scene.fog instanceof Fog) {
      scene.fog.near = useDepthFog
        ? developmentFallback ? 18 : 28
        : developmentFallback ? 32 : 42;
      scene.fog.far = useDepthFog
        ? developmentFallback ? 104 : 125
        : developmentFallback ? 128 : 150;
    }
    heightFogDensity.value = useDepthFog
      ? options.fogDensity ?? 0.012
      : 0.0045;
  };

  return { hemi, sun, moon, rim, windows, fills, applyQuality, applyHeightFog, dispose };
}
