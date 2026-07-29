import {
  Color,
  DirectionalLight,
  FogExp2,
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
 */
export function setupLighting(
  scene: Scene,
  options: LightingOptions = {},
): LightingSetup {
  const mapRadius = options.mapRadius ?? 40;
  const shadowMapSize = options.shadowMapSize ?? 2048;

  const skyColor = new Color(options.skyColor ?? 0x2a3d55);
  const groundColor = new Color(options.groundColor ?? 0x141a24);
  const sunColor = new Color(options.sunColor ?? 0xff8a3d);
  const fogColor = new Color(options.fogColor ?? 0x1a2433);

  // --- Hemisphere (cool blue ambient) ---
  const hemi = new HemisphereLight(
    skyColor,
    groundColor,
    options.hemiIntensity ?? 1.25,
  );
  hemi.name = 'HemiDusk';
  scene.add(hemi);

  // --- Directional sun (low orange dusk) ---
  const sun = new DirectionalLight(sunColor, options.sunIntensity ?? 2.5);
  sun.name = 'SunDusk';
  // Low western sun — long urban shadows.
  sun.position.set(-38, 28, 18);
  sun.target.position.set(0, 0, 0);
  scene.add(sun);
  scene.add(sun.target);

  sun.castShadow = true;
  sun.shadow.mapSize.set(shadowMapSize, shadowMapSize);
  sun.shadow.bias = -0.00025;
  sun.shadow.normalBias = 0.035;
  sun.shadow.radius = 2.5;

  const cam = sun.shadow.camera;
  cam.near = 1;
  cam.far = mapRadius * 4;
  cam.left = -mapRadius;
  cam.right = mapRadius;
  cam.top = mapRadius;
  cam.bottom = -mapRadius;
  cam.updateProjectionMatrix();

  // --- Moon fill (opposite side, cool blue, no shadows) ---
  const moon = new DirectionalLight(
    0x6a9cc8,
    options.moonIntensity ?? 0.35,
  );
  moon.name = 'MoonFill';
  moon.position.set(36, 22, -20);
  moon.target.position.set(0, 0, 0);
  moon.castShadow = false;
  scene.add(moon);
  scene.add(moon.target);

  // --- Warm window / neon PointLights ---
  const windowDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(-18, 4.2, -12), color: 0xffb060, intensity: 2.8, dist: 14 },
    { pos: new Vector3(14, 5.5, 8), color: 0xff9a4a, intensity: 2.5, dist: 12 },
    { pos: new Vector3(-6, 3.8, 22), color: 0xffc070, intensity: 2.2, dist: 11 },
    { pos: new Vector3(22, 6.0, -16), color: 0xff8844, intensity: 2.4, dist: 13 },
    { pos: new Vector3(4, 2.6, -24), color: 0xffaa55, intensity: 2.0, dist: 10 },
  ];

  const windows: PointLight[] = [];
  for (let i = 0; i < windowDefs.length; i++) {
    const def = windowDefs[i];
    const pl = new PointLight(def.color, def.intensity, def.dist, 2);
    pl.position.copy(def.pos);
    pl.name = `WindowLight_${i}`;
    // Only first two cast shadows — keeps fill cheap on mid GPUs.
    if (i < 2) {
      pl.castShadow = true;
      pl.shadow.mapSize.set(512, 512);
      pl.shadow.bias = -0.001;
      pl.shadow.camera.near = 0.2;
      pl.shadow.camera.far = def.dist;
    }
    scene.add(pl);
    windows.push(pl);
  }

  // --- Cool ambient fill PointLights (lift shadowed faces out of silhouette) ---
  const fillDefs: Array<{ pos: Vector3; color: number; intensity: number; dist: number }> = [
    { pos: new Vector3(0, 8, 0), color: 0x5a7ea8, intensity: 1.6, dist: 36 },
    { pos: new Vector3(-22, 6, 10), color: 0x4a6e98, intensity: 1.2, dist: 22 },
    { pos: new Vector3(18, 7, -8), color: 0x6a88b0, intensity: 1.15, dist: 20 },
    { pos: new Vector3(2, 5, 18), color: 0x5578a0, intensity: 1.1, dist: 18 },
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

  // --- Atmospheric fog (haze at 40–60u, not a black hole) ---
  scene.fog = new FogExp2(fogColor.getHex(), options.fogDensity ?? 0.0075);
  scene.background = fogColor.clone();

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
