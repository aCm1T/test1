import {
  Color,
  DirectionalLight,
  Fog,
  HemisphereLight,
  PointLight,
  Scene,
  Vector3,
} from 'three';

export interface LightingSetup {
  hemi: HemisphereLight;
  sun: DirectionalLight;
  moon: DirectionalLight;
  windows: PointLight[];
  fills: PointLight[];
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
  fogDensity?: number;
  fogColor?: number;
  shadowMapSize?: number;
}

/**
 * Dusk urban lighting: cool blue ambient hemisphere, warm orange sun with
 * soft shadows covering ~80u map, warm window PointLights, FogExp2.
 * Readable MW2019-style dusk — orange sun rims + cool fill, not a black void.
 *
 * Shadow darkness is intentionally dialed down (shadow.intensity) so asphalt
 * and facade albedos survive ACES + PCF without crushing into blue/black.
 */
export function setupLighting(
  scene: Scene,
  options: LightingOptions = {},
): LightingSetup {
  const mapRadius = options.mapRadius ?? 40;
  const shadowMapSize = options.shadowMapSize ?? 2048;

  // Neutral-warm hemi — cool blue crush was painting asphalt into a cyan void.
  const skyColor = new Color(options.skyColor ?? 0x5a6e88);
  const groundColor = new Color(options.groundColor ?? 0x3a3830);
  const sunColor = new Color(options.sunColor ?? 0xff9a4a);
  const fogColor = new Color(options.fogColor ?? 0x3a4450);

  // --- Hemisphere (readable dusk fill, warm ground bounce) ---
  const hemi = new HemisphereLight(
    skyColor,
    groundColor,
    options.hemiIntensity ?? 2.25,
  );
  hemi.name = 'HemiDusk';
  scene.add(hemi);

  // --- Directional sun (low orange dusk) ---
  // Intensity kept assertive for rims, but shadow.intensity softens umbra crush.
  const sun = new DirectionalLight(sunColor, options.sunIntensity ?? 2.55);
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
  // Key fix: don't let PCF umbra black-out the asphalt / lee facades.
  sun.shadow.intensity = 0.28;

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
    0x8ab0d0,
    options.moonIntensity ?? 0.55,
  );
  moon.name = 'MoonFill';
  moon.position.set(36, 26, -20);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = false;
  scene.add(moon);
  scene.add(moon.target);

  // --- Warm window / neon PointLights ---
  const windowDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(-18, 4.2, -12), color: 0xffb060, intensity: 3.4, dist: 16 },
    { pos: new Vector3(14, 5.5, 8), color: 0xff9a4a, intensity: 3.0, dist: 14 },
    { pos: new Vector3(-6, 3.8, 22), color: 0xffc070, intensity: 2.8, dist: 13 },
    { pos: new Vector3(22, 6.0, -16), color: 0xff8844, intensity: 2.9, dist: 15 },
    { pos: new Vector3(4, 2.6, -24), color: 0xffaa55, intensity: 2.5, dist: 12 },
    { pos: new Vector3(-22, 7.0, -2), color: 0xffb870, intensity: 2.6, dist: 14 },
    { pos: new Vector3(20, 4.5, 2), color: 0xff9944, intensity: 2.4, dist: 12 },
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
  const fillDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(0, 12, 0), color: 0xc8b8a0, intensity: 2.4, dist: 48 },
    { pos: new Vector3(-22, 7, 10), color: 0xa8b0c0, intensity: 1.5, dist: 26 },
    { pos: new Vector3(18, 8, -8), color: 0xc0a888, intensity: 1.55, dist: 24 },
    { pos: new Vector3(2, 6, 18), color: 0xb0a898, intensity: 1.5, dist: 22 },
    { pos: new Vector3(0, 5, -10), color: 0xd0b090, intensity: 1.6, dist: 22 },
    // Street-level warm bounce near spawn / intersection for screenshot ground read.
    { pos: new Vector3(0, 2.2, 8), color: 0xe0c8a0, intensity: 1.8, dist: 18 },
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
  scene.fog = new Fog(fogColor.getHex(), 32, 120);

  const dispose = (): void => {
    scene.remove(hemi);
    scene.remove(sun);
    scene.remove(sun.target);
    scene.remove(moon);
    scene.remove(moon.target);
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
    if (sun.shadow.map) {
      sun.shadow.map.dispose();
    }
    scene.fog = null;
  };

  return { hemi, sun, moon, windows, fills, dispose };
}
