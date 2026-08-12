import './style.css';

import {
  LinearFilter,
  LinearMipmapLinearFilter,
  MeshStandardMaterial,
  RepeatWrapping,
  SRGBColorSpace,
  TextureLoader,
  Vector3,
  type Texture,
} from 'three';
import { CSM } from 'three/addons/csm/CSM.js';
import { CSMHelper } from 'three/addons/csm/CSMHelper.js';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  GameRenderer,
  PostProcessing,
  setupLighting,
  setupEnvironment,
  GameClock,
  FixedStepSimulation,
  AssetRegistry,
  createFetchAssetLoaders,
  detectGraphicsCapabilities,
  isQACaptureBufferRequested,
  selectQualityProfile,
  type DebugRenderView,
  type GraphicsCapabilities,
  type QualityPreference,
  type QualityProfile,
} from './engine';
import { bindSurfaceFamilyCompile } from './engine/StaticBatching';
import {
  EnvironmentAssembler,
  DevelopmentPropLayer,
  DevelopmentSkylineBackdrop,
  Level,
  NIGHTGLASS_AUDIO_ASSET_IDS,
  NIGHTGLASS_CHARACTER_ASSET_IDS,
  NIGHTGLASS_LIGHTING_ASSET_IDS,
  NIGHTGLASS_RUNTIME_ASSET_IDS,
  NIGHTGLASS_TEXTURE_ASSET_IDS,
  NIGHTGLASS_VIEWMODEL_ASSET_ID,
  validateNightglassAssetContract,
  type AuthoredNavigationAnnotations,
  type AuthoredEnvironmentRenderStats,
  type AuthoredStaticCollider,
  type EnvironmentModulePlacement,
} from './world';
import { PlayerController, CameraFeel, type WorldCollider } from './player';
import { GrenadeSystem, WeaponSystem } from './weapons';
import { Enemy, EnemyManager, type EnemyMovementAuthority, type HitPart } from './enemies';
import { VFXManager, DecalManager, resolveImpactSurface, resolveDecalSurface } from './vfx';
import { AudioManager } from './audio';
import { HUD, MainMenu, resolveDeathRestoreSubtitle, resolveMissionInteractPrompt, type MainMenuSettings } from './ui';
import {
  MissionDirector,
  SeededRandom,
  shouldApplyCombatDamage,
  type MissionBeat,
  type MissionEvent,
} from './mission';
import {
  GameSession,
  type GameEvent,
  type GameSnapshot,
  type GameWorldSnapshot,
  type InputFrame,
} from './simulation/GameSession';
import { CoverSlots, NavigationGraph, SquadDirector } from './simulation/Navigation';
import type {
  CapsuleSweep,
  CharacterId,
  CharacterIntent,
  CharacterMoveResult,
  InteractionQuery,
  NavPath,
  PathOptions,
  PhysicsWorld,
  RapierPhysicsWorld,
  RayHit,
  RayQuery,
  SurfaceTag,
  SweepHit,
  Vec3,
} from './simulation/PhysicsWorld';
// Value import of RapierPhysicsWorld is intentionally dynamic in
// initializePhysics() so the WASM payload stays out of the startup chunk.

type RuntimeCheckpoint = {
  /** GameSession / FixedStepSimulation tick at the jammer checkpoint. */
  tick: number;
  player: ReturnType<PlayerController['snapshotState']>;
  weapons: ReturnType<WeaponSystem['snapshotState']>;
  grenades: ReturnType<GrenadeSystem['snapshotState']>;
  mission: ReturnType<MissionDirector['snapshot']>;
  enemies: ReturnType<EnemyManager['snapshotState']>;
  randomState: number;
  hostileKills: number;
};

type QACaptureState =
  | 'hip'
  | 'ads'
  | 'reload'
  | 'reload-eject'
  | 'reload-insert'
  | 'reload-chamber'
  | 'muzzle'
  | 'impact'
  | 'damage'
  | 'death'
  | 'jammer'
  | 'defense'
  | 'extraction';

/** Original project art for procedural fallback soft goods only; never a release asset. */
const DEVELOPMENT_RIPSTOP_URL =
  '/assets/development/original-materials/nightglass-charcoal-ripstop-v1.png';

function configureDevelopmentRipstopSource(texture: Texture, maxAnisotropy: number): void {
  texture.name = 'DevelopmentFallbackRipstopSource';
  texture.colorSpace = SRGBColorSpace;
  texture.wrapS = RepeatWrapping;
  texture.wrapT = RepeatWrapping;
  texture.magFilter = LinearFilter;
  texture.minFilter = LinearMipmapLinearFilter;
  texture.generateMipmaps = true;
  texture.anisotropy = Math.max(1, Math.min(8, Math.floor(maxAnisotropy)));
  texture.needsUpdate = true;
}

const EMPTY_QA_INPUT: InputFrame = {
  moveX: 0,
  moveY: 0,
  lookX: 0,
  lookY: 0,
  fire: false,
  firePressed: false,
  aim: false,
  aimPressed: false,
  reload: false,
  grenade: false,
  interact: false,
  jump: false,
  crouch: false,
  sprint: false,
  weaponCycle: 0,
};

const JAMMER_INTERACTION_TARGET: Readonly<Vec3> = Object.freeze({ x: 0, y: 1.2, z: 19 });
const JAMMER_INTERACTION_DISTANCE = 4.5;

/** Keeps GameSession's fixed pipeline live while Rapier finishes async setup. */
class BrowserPhysicsStage implements PhysicsWorld {
  constructor(private readonly getWorld: () => RapierPhysicsWorld | null) {}
  step(dt: number): void { this.getWorld()?.step(dt); }
  moveCharacter(body: CharacterId, intent: CharacterIntent): CharacterMoveResult {
    const world = this.getWorld();
    if (!world) throw new Error('PhysicsWorld is still initializing');
    return world.moveCharacter(body, intent);
  }
  castRay(query: RayQuery): RayHit | null { return this.getWorld()?.castRay(query) ?? null; }
  sweepCapsule(query: CapsuleSweep): SweepHit | null { return this.getWorld()?.sweepCapsule(query) ?? null; }
  queryNavigation(from: Vec3, to: Vec3, options?: PathOptions): NavPath | null {
    return this.getWorld()?.queryNavigation(from, to, options) ?? null;
  }
  queryInteraction(query: InteractionQuery): boolean {
    return this.getWorld()?.queryInteraction(query) ?? false;
  }
  getSurfaceAt(position: Vec3): SurfaceTag { return this.getWorld()?.getSurfaceAt(position) ?? 'default'; }
}

/**
 * BLACKOPS: FRONTLINE — urban dusk FPS bootstrap.
 * Wires renderer, level, player, weapons, AI, VFX, audio, and HUD.
 */
class Game {
  private readonly app: HTMLElement;
  private readonly renderer: GameRenderer;
  private readonly post: PostProcessing;
  private readonly clock: GameClock;
  private readonly simulation: FixedStepSimulation;
  private readonly gameSession: GameSession;
  /** The only runtime authority that may alter graphics quality. */
  private quality: QualityProfile;
  private readonly graphicsCapabilities: GraphicsCapabilities;
  /** `?release=1` is used by capture/release automation and rejects fallback art. */
  private readonly releaseMode = new URLSearchParams(window.location.search).get('release') === '1';
  private releaseAssetGate: string | null = null;
  private readonly lighting;
  private readonly environment;
  private readonly level: Level;
  /** CC0 fallback dressing, intentionally absent from authored/release paths. */
  private developmentPropLayer: DevelopmentPropLayer | null = null;
  /** Original skyline plate for the procedural fallback; never part of a release route. */
  private developmentSkylineBackdrop: DevelopmentSkylineBackdrop | null = null;
  /** Bootstrap-owned source texture; fallback consumers own only configured clones. */
  private developmentRipstopTexture: Texture | null = null;
  private developmentRipstopLoad: Promise<void> | null = null;
  private developmentRipstopGeneration = 0;
  private routeColliders: WorldCollider[] = [];
  private assetRegistry: AssetRegistry | null = null;
  private environmentAssembler: EnvironmentAssembler | null = null;
  private threeAssetLoadersDispose: (() => void) | null = null;
  private physics: RapierPhysicsWorld | null = null;
  private readonly physicsReady: Promise<void>;
  private authoredStaticColliders: AuthoredStaticCollider[] | null = null;
  private authoredNavigation: AuthoredNavigationAnnotations | null = null;
  private authoredRenderStats: AuthoredEnvironmentRenderStats | null = null;
  private authoredHeroTextureCount = 0;
  private readonly player: PlayerController;
  private readonly cameraFeel: CameraFeel;
  private readonly weapons: WeaponSystem;
  private readonly grenades: GrenadeSystem;
  private readonly enemies: EnemyManager;
  private readonly vfx: VFXManager;
  private readonly decals: DecalManager;
  private readonly audio: AudioManager;
  private readonly hud: HUD;
  private readonly menu: MainMenu;
  private readonly mission: MissionDirector;
  private csm: CSM;
  private csmHelper: CSMHelper;
  private readonly simulationSeed = 0x4e494748;
  private readonly simulationRandom = new SeededRandom(this.simulationSeed);
  private readonly viewModelRandom = new SeededRandom(0x56494557);
  private readonly vfxRandom = new SeededRandom(0x56465821);
  private readonly decalRandom = new SeededRandom(0x44454341);
  private readonly audioRandom = new SeededRandom(0x41554449);
  private readonly enemyPhysicsBodies = new Map<Enemy, string>();
  private enemyPhysicsSerial = 0;
  private qaFrozen = false;
  private qaPlayerBaseline: ReturnType<PlayerController['snapshotState']> | null = null;
  private qaWeaponBaseline: ReturnType<WeaponSystem['snapshotState']> | null = null;
  private qaGrenadeBaseline: ReturnType<GrenadeSystem['snapshotState']> | null = null;
  private qaEnemyBaseline: ReturnType<EnemyManager['snapshotState']> | null = null;
  private qaSimulationRandomBaseline: number | null = null;
  private qaTickBaseline: number | null = null;

  private playing = false;
  private paused = false;
  private footstepTimer = 0;
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  private readonly tmp = new Vector3();
  private readonly losRayDir = new Vector3();
  private lastWeaponName = '';
  private animId = 0;
  private lastAliveCount = -1;
  private waveToastTimer = 0;
  private hostileKills = 0;
  /** Weapon credited on the next onEnemyDeath (Frag during splash, else active gun). */
  private killCreditWeapon = 'Assault Rifle';
  /** Forked AI stream for the current navigation tick; null outside that phase. */
  private navigationRandom: SeededRandom | null = null;
  private runtimeCheckpoint: RuntimeCheckpoint | null = null;
  private deathRestoreRemaining: number | null = null;
  private currentSessionInput: Readonly<InputFrame> = EMPTY_QA_INPUT;
  private readonly pendingSessionEvents: GameEvent[] = [];
  /** Squad barks captured during the AI phase, stamped with the tick on drain. */
  private readonly pendingSquadEvents: Array<{ event: string; agentId: string }> = [];

  constructor() {
    const app = document.getElementById('app');
    if (!app) throw new Error('#app mount missing');
    this.app = app;
    // A module can survive hot reloads. Clear any former development-only
    // shared fallback clones before a release bootstrap constructs enemies.
    if (this.releaseMode) Enemy.clearDevelopmentRipstop();

    this.renderer = new GameRenderer({
      container: app,
      exposure: 1.0,
      shadowMapSize: 1536,
      clearColor: 0x1a2433,
      maxPixelRatio: 1.75,
      // Deterministic browser capture can explicitly retain the WebGL buffer
      // for canvas readback. This is intentionally unavailable to the
      // fail-closed release route and absent from normal play.
      captureFrameBuffer: !this.releaseMode
        && isQACaptureBufferRequested(window.location.search),
    });
    this.graphicsCapabilities = detectGraphicsCapabilities(this.renderer.renderer);
    // Headless visual QA may request a lower deterministic tier for a software
    // renderer. It is deliberately ignored by the fail-closed release path and
    // normal launches retain automatic hardware selection.
    const qaQualityParam = this.releaseMode
      ? null
      : new URLSearchParams(window.location.search).get('qaQuality');
    const qaQuality: QualityPreference = qaQualityParam === 'low'
      || qaQualityParam === 'medium'
      || qaQualityParam === 'high'
      || qaQualityParam === 'ultra'
      ? qaQualityParam
      : 'auto';
    const quality = selectQualityProfile(this.graphicsCapabilities, qaQuality).profile;
    this.quality = quality;
    this.renderer.applyQuality(quality);

    this.environment = setupEnvironment(
      this.renderer.renderer,
      this.renderer.scene,
    );
    // The scanned HDRI is retained as an opt-in lighting experiment. The
    // default fallback keeps the authored cool blue-hour balance; a warm
    // location plate must not globally recolor it before visual approval.
    if (!this.releaseMode && new URLSearchParams(window.location.search).get('devHdri') === '1') {
      void this.environment.loadDevelopmentFallback(
        '/assets/development/polyhaven/sunset_jhbcentral_2k.hdr',
      );
    }

    this.lighting = setupLighting(this.renderer.scene, {
      mapRadius: 40,
      shadowMapSize: 1536,
      fogColor: 0x3a4450,
      // Cut hemi/fill energy so CSM key modelling reads; dusk stays lit, not black.
      hemiIntensity: 0.4,
      // `SunDusk` is shadowless once CSM takes over the key, so any meaningful
      // intensity here refills every cascade shadow from the key's own
      // direction and erases it. Keep only a sliver to soften the umbra.
      sunIntensity: 0.12,
      moonIntensity: 0.16,
      developmentFallback: !this.releaseMode,
    });
    this.lighting.applyQuality(quality);

    this.level = new Level(this.renderer.scene);
    this.routeColliders = this.level.colliders;
    // A scene-only skyline layer: it has no Level, physics, collision, or nav
    // ownership and is deliberately skipped by the release bootstrap.
    if (!this.releaseMode) {
      this.developmentSkylineBackdrop = new DevelopmentSkylineBackdrop({
        parent: this.renderer.scene,
        maxAnisotropy: this.renderer.renderer.capabilities.getMaxAnisotropy(),
      });
      void this.developmentSkylineBackdrop.load().then((report) => {
        if (report.state === 'installed') {
          console.info('[development-skyline] installed original visual backdrop');
        } else if (report.state === 'failed') {
          console.warn('[development-skyline] backdrop unavailable; retaining procedural sky', report.error);
        }
      });
    }
    // Isolated CC0 fallback dressing: this does not alter Level colliders,
    // navigation, encounter placement, manifests, or release eligibility.
    if (!this.releaseMode) {
      this.developmentPropLayer = new DevelopmentPropLayer({ parent: this.level.group });
      void this.developmentPropLayer.load().then((report) => {
        if (report.state === 'installed') {
          // Imported PBR materials arrive after the initial scene traversal.
          // Give them the same quality/CSM/fog treatment as route content.
          this.renderer.applySceneQuality(this.renderer.scene, this.quality);
          this.configureScenePbrMaterials();
          console.info(`[development-props] installed ${report.placementCount} CC0 visual props`);
        } else if (report.state === 'failed') {
          console.warn('[development-props] CC0 fallback props unavailable; retaining procedural dressing', report.error);
        }
      });
    }
    // Clear intersection spawn — avoid prop/car overlap that flings the player.
    this.level.playerSpawn.set(0, 0, 0);
    // Opening hostiles ahead on +Z (player yaw = PI looks down +Z).
    this.level.enemySpawns.unshift(new Vector3(4.0, 0, 11));
    this.level.enemySpawns.unshift(new Vector3(-3.5, 0, 9));

    this.player = new PlayerController({
      position: this.level.playerSpawn.clone(),
      sensitivity: 0.00215,
    });
    // Look north down the street with slight dip so asphalt fills the frame.
    this.player.setLook(Math.PI, -0.18);
    this.renderer.scene.add(this.player.pivot);
    // Three near-to-far cascades cover the authored street route. CSM hooks all
    // standard PBR materials before the first world render.
    this.lighting.sun.castShadow = false;
    this.csm = this.createCSM(quality);
    this.csmHelper = this.createCSMHelper(this.csm);
    this.configureScenePbrMaterials();
    // CC0 maps improve only the visible procedural development fallback. They
    // never participate in release mode or in the authored asset contract.
    if (!this.releaseMode) {
      void this.level.loadDevelopmentPbrMaps().then((report) => {
        if (report.installed.length > 0) {
          console.info(`[development-pbr] installed ${report.installed.join(', ')} maps`);
        }
      });
    }

    // Gameplay uses the player camera; keep renderer camera as unused fallback.
    this.post = new PostProcessing(
      this.renderer.renderer,
      this.renderer.scene,
      this.player.camera,
      {
        // Match the development fallback's lower-key blue-hour calibration.
        // Authored production assets retain their supplied exposure path.
        exposure: this.releaseMode ? 1 : 0.9,
      },
    );
    this.post.applyQuality(quality);

    this.cameraFeel = new CameraFeel(this.player.camera, this.player);

    this.weapons = new WeaponSystem({
      player: this.player,
      camera: this.player.camera,
      viewModelCamera: this.renderer.viewModelCamera,
      colliders: this.routeColliders,
      viewModelScene: this.renderer.viewModelScene,
      random: this.simulationRandom,
      presentationRandom: () => this.viewModelRandom.next(),
      // PlayerController samples InputFrames; weapons must not bind duplicate DOM.
      captureDomInput: false,
      callbacks: {
        onFire: (weapon, hit) => this.handleFire(weapon, hit),
        onHit: (_enemy, bodyPart) => {
          this.hud.showHitmarker(bodyPart === 'head');
          this.audio.playHitMarker(bodyPart === 'head');
        },
        onKill: () => {
          /* Hostile kill credit is owned by EnemyManager.onEnemyDeath so
           * firearm and grenade kills share one accounting path. */
        },
        onReload: (_weapon, empty) => this.audio.playReload(empty),
        // Aim punch is applied to the player inside WeaponSystem; this is the
        // separate transient view kick that presentation owns.
        onViewPunch: (pitch, yaw, roll) => this.cameraFeel.addViewPunch(pitch, yaw, roll),
        onDryFire: () => this.audio.playDryFire(),
        onShot: (record) => this.pendingSessionEvents.push({
          type: 'shot',
          tick: record.tick,
          weapon: record.weapon,
          seed: record.seed,
          origin: record.origin,
          direction: record.direction,
          hit: record.hit,
        }),
      },
    });

    this.enemies = new EnemyManager(this.renderer.scene, this.level, {
      maxAlive: 8,
      waveDelay: 7,
      waveSize: 4,
      onEnemyShoot: (ev) => this.handleEnemyShot(ev),
      onEnemyDeath: (_enemy, part) => this.registerHostileKill(part),
      onEnemyCallout: (callout, enemy) => {
        this.pendingSquadEvents.push({ event: callout, agentId: enemy.id });
      },
    });
    this.enemies.setLodBias(quality.lodBias);
    // This original source is intentionally outside the authored registry. It
    // is fetched exactly once for the procedural development fallback and is
    // never requested by a release bootstrap.
    if (!this.releaseMode) this.loadDevelopmentRipstop();

    this.vfx = new VFXManager(
      this.renderer.scene,
      () => this.vfxRandom.next(),
      quality.particleMultiplier,
    );
    this.decals = new DecalManager(this.renderer.scene, {
      random: () => this.decalRandom.next(),
    });
    this.audio = new AudioManager({ random: () => this.audioRandom.next() });
    this.hud = new HUD(this.app);
    this.grenades = new GrenadeSystem({
      scene: this.renderer.scene,
      camera: this.player.camera,
      colliders: this.routeColliders,
      getPlayerPosition: () => this.player.getPositionRef(),
      onPlayerDamage: (amount) => this.applyFragSplashToPlayer(amount),
      onThrow: (remaining) => this.hud.showInteract(`FRAG OUT — ${remaining} REMAINING`),
      onExplode: ({ position, radius, distanceToCamera }) => {
        this.vfx.spawnExplosion(position, 1.15);
        this.audio.playExplosion(distanceToCamera, radius);
        this.post.pulseBloom(0.9);
        this.cameraFeel.notifyExplosion(distanceToCamera, radius, 1);
        // Blast pressure pins survivors even when the frag does not kill them.
        this.enemies.notifyExplosion(
          new Vector3(position.x, position.y, position.z),
          radius * 1.6,
        );
      },
      onBounce: ({ speed }) => this.audio.playGrenadeBounce(speed / 9),
      onTrail: (position) => this.vfx.spawnSmoke(position, 1, 0.16),
    });
    this.mission = new MissionDirector({
      insertionLineZ: 6,
      intersectionLineZ: 17,
      extraction: { x: 0, z: 30, radius: 4.5 },
      defenseDuration: 90,
      onEvent: (event) => this.handleMissionEvent(event),
    });
    this.clock = new GameClock();
    this.simulation = new FixedStepSimulation({
      stepSeconds: 1 / 60,
      maxFrameDeltaSeconds: 0.2,
      maxSubSteps: 6,
    });
    this.gameSession = new GameSession({
      fixedDelta: 1 / 60,
      random: this.simulationRandom,
      systems: {
        applyInput: (input, _tick, dt) => {
          this.currentSessionInput = input;
          this.player.setSessionInput(input);
          this.weapons.setSessionInput(input);
          this.applyPlayerIntent(dt);
        },
        physics: new BrowserPhysicsStage(() => this.physics),
        updateNavigationAndAI: (tick, dt, random) => this.updateNavigationAndAI(dt, tick, random),
        updateCombat: (tick, dt) => this.updateCombat(dt, tick),
        updateMission: (_tick, dt) => this.updateMissionAndPresentation(dt),
        snapshotWorld: () => this.snapshotSessionWorld(),
        restoreWorld: (snapshot) => this.restoreSessionWorld(snapshot),
      },
      onEvent: (event) => this.handleSessionEvent(event),
    });

    this.menu = new MainMenu(
      {
        onPlay: (settings) => this.startGame(settings),
        onSettingsChange: (settings) => this.applySettings(settings),
      },
      this.app,
    );
    if (this.releaseMode) {
      this.setReleaseAssetGate('Validating the authored NIGHTGLASS asset package.');
    }

    this.renderer.applySceneQuality(this.renderer.scene, quality);
    this.renderer.applySceneQuality(this.renderer.viewModelScene, quality);

    this.player.attach(this.renderer.renderer.domElement);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLock);
    window.addEventListener('keydown', this.onKeyDown);

    // Prevent context menu on canvas during ADS
    this.renderer.renderer.domElement.addEventListener('contextmenu', (e) =>
      e.preventDefault(),
    );

    this.syncPostSize();
    this.clock.start();
    this.physicsReady = this.initializePhysics();
    void this.initializeAuthoredEnvironment();
    this.loop();
  }

  private applySettings(settings: MainMenuSettings): void {
    this.player.sensitivity = 0.00215 * settings.sensitivity;
    this.player.setBaseFov(settings.fieldOfView ?? 90);
    this.player.setAdsSensitivityMultiplier(settings.adsMultiplier ?? 0.8);
    this.cameraFeel.hipFov = settings.fieldOfView ?? 90;
    this.cameraFeel.adsFov = Math.max(48, (settings.fieldOfView ?? 90) * 0.68);
    this.cameraFeel.setReducedMotion(settings.reducedMotion ?? false);
    this.weapons.setToggleADS(settings.toggleADS ?? false);
    this.audio.setVolume('master', settings.masterVolume);
    this.audio.setVolume('sfx', settings.sfxVolume);
    this.hud.setCrosshairVisible(settings.showCrosshair ?? true);
    this.hud.setReducedMotion(settings.reducedMotion ?? false);
    this.applyGraphicsQuality(settings.graphicsTier ?? 'auto');
  }

  /**
   * Atomically applies a capability-capped tier across every visual subsystem.
   * This is deliberately owned by Game rather than distributed among UI and
   * loaders, so a settings change cannot leave quality subsystems disagreeing.
   */
  private applyGraphicsQuality(preference: QualityPreference): void {
    const next = selectQualityProfile(this.graphicsCapabilities, preference).profile;
    const csmChanged = next.shadowCascades !== this.quality.shadowCascades
      || next.shadowDistance !== this.quality.shadowDistance
      || next.shadowMapSize !== this.quality.shadowMapSize;
    this.quality = next;
    this.renderer.applyQuality(next);
    this.post.applyQuality(next);
    this.lighting.applyQuality(next);
    this.vfx.setParticleMultiplier(next.particleMultiplier);
    this.environmentAssembler?.setLodBias(next.lodBias);
    this.enemies.setLodBias(next.lodBias);
    this.renderer.applySceneQuality(this.renderer.scene, next);
    this.renderer.applySceneQuality(this.renderer.viewModelScene, next);
    if (csmChanged) this.recreateCSM(next);
    this.syncPostSize();
  }

  private createCSM(profile: QualityProfile): CSM {
    // CSM owns the key: `SunDusk` is deliberately left shadowless (see below),
    // so the cascade direction must be the sun's own travel direction. When the
    // two disagree the scene is lit from one azimuth and shadowed from the
    // other, the two keys cancel each other's modelling, and the street
    // photographs as flat untextured massing.
    const csm = new CSM({
      camera: this.player.camera,
      parent: this.renderer.scene,
      cascades: profile.shadowCascades,
      maxFar: profile.shadowDistance,
      shadowMapSize: profile.shadowMapSize,
      lightDirection: this.lighting.sun.position.clone().negate().normalize(),
      lightIntensity: 2.15,
      shadowBias: -0.00018,
      mode: 'practical',
    });
    // CSM cascade lights default to full umbra; match the restored key contrast
    // from Lighting (above the old 0.28 soft floor, still shy of crushing black).
    for (const light of csm.lights) {
      light.shadow.intensity = 0.4;
    }
    return csm;
  }

  private createCSMHelper(csm: CSM): CSMHelper {
    const helper = new CSMHelper(csm);
    helper.name = 'CSMQualityAssuranceHelper';
    helper.visible = false;
    this.renderer.scene.add(helper);
    return helper;
  }

  private recreateCSM(profile: QualityProfile): void {
    const helperVisible = this.csmHelper.visible;
    this.csmHelper.removeFromParent();
    this.csmHelper.dispose();
    this.csm.dispose();
    this.csm = this.createCSM(profile);
    this.csmHelper = this.createCSMHelper(this.csm);
    this.csmHelper.visible = helperVisible;
    this.configureScenePbrMaterials();
  }

  private configureScenePbrMaterials(): void {
    this.renderer.scene.traverse((node) => {
      const mesh = node as import('three').Mesh;
      if (!mesh.isMesh) return;
      const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
      for (const material of materials) {
        if (material instanceof MeshStandardMaterial) {
          this.setupCascadedShadowsAndFog(material);
        }
      }
    });
  }

  /**
   * CSM's setupMaterial replaces onBeforeCompile without chaining. Restore any
   * SurfaceFamily bake hook first, then wrap CSM around it, then let height fog
   * wrap the pair — same stacking order fog already assumes.
   */
  private setupCascadedShadowsAndFog(material: MeshStandardMaterial): void {
    bindSurfaceFamilyCompile(material);
    const previousCompile = material.onBeforeCompile.bind(material);
    const previousKey = material.customProgramCacheKey.bind(material);
    this.csm.setupMaterial(material);
    const csmCompile = material.onBeforeCompile;
    material.onBeforeCompile = (shader, renderer) => {
      previousCompile(shader, renderer);
      csmCompile(shader, renderer);
    };
    material.customProgramCacheKey = () => `${previousKey()}|csm-${this.csm.cascades}`;
    this.lighting.applyHeightFog(material);
  }

  private async startGame(settings: MainMenuSettings): Promise<void> {
    this.applySettings(settings);
    if (!this.canLaunchRelease()) {
      this.menu.show();
      return;
    }
    if (this.mission.getBeat() === 'complete') {
      this.resetRunToOpening();
      this.hud.clearMissionResult();
      // Rematch rewinds hostileKills / roster like death restore — drop prior-run
      // killfeed rows so the opening does not carry spent-run combat telemetry.
      this.hud.clearKillfeed();
      this.hud.clearHitmarker();
      this.post.setDamageIntensity(0);
      this.hud.clearDamage();
    }
    await this.audio.unlock();
    // Rapier bind (or explicit init failure → AABB fallback) must settle before
    // play so movement never swaps AABB→Rapier authority mid-run.
    await this.physicsReady;
    this.menu.hide();
    this.hud.setVisible(true);
    this.playing = true;
    this.paused = false;
    // Pause unlock uses beginInputSuspend so still-held WASD survive clearInput
    // (same stuck-keys class as death restore). Fresh Play just clears.
    this.player.endInputSuspend();
    this.weapons.setSessionInput(EMPTY_QA_INPUT);
    this.currentSessionInput = EMPTY_QA_INPUT;

    if (this.player.isDead()) {
      this.deathRestoreRemaining = null;
      this.player.revive(true);
      this.player.setPosition(
        this.level.playerSpawn.x,
        this.level.playerSpawn.y,
        this.level.playerSpawn.z,
      );
    }

    this.hud.setWeaponName(this.weapons.getActiveDef().name);
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.syncAmmoHud();
    this.syncMissionHud();

    // Pointer lock after user gesture (Play click)
    this.player.requestPointerLock(this.renderer.renderer.domElement);
  }

  private handleFire(
    weapon: string,
    hit: import('./combat').HitscanHit | null,
  ): void {
    this.audio.playGunshot(weapon === 'pistol' ? 0.75 : weapon === 'knife' ? 0.35 : 1);
    this.post.pulseBloom(weapon === 'ar' ? 0.4 : 0.25);

    this.player.camera.getWorldPosition(this.muzzlePos);
    this.player.camera.getWorldDirection(this.muzzleDir);
    this.muzzlePos.addScaledVector(this.muzzleDir, 0.55);
    if (weapon !== 'knife') {
      this.vfx.spawnMuzzleFlash(this.muzzlePos, this.muzzleDir);
      // Barrel haze and falling brass both scale with how hard the weapon has
      // been worked, so a long burst leaves visible and audible residue.
      const heat = this.weapons.viewModel.getHeat();
      if (heat > 0.35) this.vfx.spawnMuzzleSmoke(this.muzzlePos, this.muzzleDir, heat);
      this.audio.playShellDrop();
    }

    if (!hit) return;

    if (hit.enemy && !hit.hitWorld) {
      this.vfx.spawnBlood(hit.point, this.muzzleDir, undefined, hit.bodyPart === 'head');
    } else if (hit.hitWorld) {
      const surface = this.physics?.getSurfaceAt(hit.point) ?? 'default';
      this.vfx.spawnImpact(hit.point, hit.normal, resolveImpactSurface(surface));
      this.decals.spawnAt(hit.point, hit.normal, undefined, resolveDecalSurface(surface));
      this.audio.playImpact(surface);
    }
  }

  private registerHostileKill(part: HitPart): void {
    const headshot = part === 'head';
    this.hostileKills += 1;
    this.hud.showHitmarker(headshot);
    this.hud.pushKillfeed({
      killer: 'You',
      victim: 'Hostile',
      weapon: this.killCreditWeapon,
      headshot,
    });
    // Light combat sustain — small heal/armor on eliminate
    this.player.heal(headshot ? 18 : 10);
    this.player.addArmor(headshot ? 8 : 4);
    this.audio.playHitMarker(true);
  }

  private handleEnemyShot(ev: {
    origin: Vector3;
    direction: Vector3;
    damage: number;
  }): void {
    // Simple accuracy: chance to hit based on distance + randomness
    const toPlayer = this.tmp.copy(this.player.getEyePosition()).sub(ev.origin);
    const dist = toPlayer.length();
    toPlayer.normalize();
    const align = toPlayer.dot(ev.direction);
    const hitChance = Math.max(0, align) * MathUtilsClamp(1.15 - dist / 55, 0.15, 0.85);

    this.vfx.spawnMuzzleFlash(ev.origin, ev.direction, 10);

    // Enemy hit rolls must consume the GameSession AI fork, never the weapon stream.
    const random = this.navigationRandom;
    if (!random || !this.combatDamageLive()) return;
    if (random.chance(hitChance)) {
      const dmg = ev.damage * (0.7 + random.next() * 0.5);
      this.applyPlayerCombatDamage(dmg);
    }
  }

  /** Deterministic frag self-splash — same falloff curve as enemy splash in GrenadeSystem. */
  private applyFragSplashToPlayer(amount: number): void {
    if (amount <= 0 || !this.combatDamageLive()) return;
    this.applyPlayerCombatDamage(amount);
  }

  private combatDamageLive(): boolean {
    return shouldApplyCombatDamage({
      playing: this.playing,
      paused: this.paused,
      playerDead: this.player.isDead(),
      beat: this.mission.getBeat(),
    });
  }

  private applyPlayerCombatDamage(dmg: number): void {
    if (!this.combatDamageLive()) return;
    this.player.takeDamage(dmg);
    this.hud.setDamage(1 - this.player.health / this.player.maxHealth, true);
    this.post.setDamageIntensity(
      MathUtilsClamp(1 - this.player.health / this.player.maxHealth, 0, 1),
    );
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.cameraFeel.triggerDamageShake(0.55 + dmg / 80);

    if (this.player.isDead()) {
      this.onPlayerDeath();
    }
  }

  private onPlayerDeath(): void {
    if (this.deathRestoreRemaining !== null) return;
    this.mission.markFailed();
    this.hud.showMissionResult({
      kind: 'failed',
      title: 'Operator down',
      subtitle: resolveDeathRestoreSubtitle(!!this.runtimeCheckpoint),
    });
    this.hud.setDamage(1, true);
    this.hud.pushKillfeed({
      killer: 'Hostile',
      victim: 'You',
      weapon: 'Rifle',
    });
    this.deathRestoreRemaining = 2.2;
  }

  private updateDeathRestore(dt: number): void {
    if (this.deathRestoreRemaining === null) return;
    this.deathRestoreRemaining = Math.max(0, this.deathRestoreRemaining - dt);
    if (this.deathRestoreRemaining > 0) return;
    this.deathRestoreRemaining = null;
    if (!this.playing) return;
    // Capture before restore/clearInput: held keys get no fresh keydown until
    // release+repress, so post-death WASD would otherwise feel stuck.
    // Blur during the death delay suspends into suspendedHeldKeys while
    // onPointerLock skips pause while dead — drain that snapshot here.
    const heldKeys = this.player.consumeHeldKeysForRestore();
    const checkpoint = this.runtimeCheckpoint;
    if (checkpoint) {
      // restoreCheckpoint() is the mission authority on death: it reapplies the
      // jammer pose and grants the encounter lull. Do not also restore(snapshot),
      // which would overwrite that lull with the frozen checkpoint timing.
      this.mission.restoreCheckpoint();
      this.player.restoreState(checkpoint.player);
      this.weapons.restoreState(checkpoint.weapons);
      this.grenades.restoreState(checkpoint.grenades);
      this.enemies.restoreState(checkpoint.enemies);
      this.simulationRandom.restore(checkpoint.randomState);
      this.hostileKills = checkpoint.hostileKills;
      // World/RNG rewind without the session clock leaves AI fork(tick) salts
      // on the post-death timeline — restore both clocks to the checkpoint epoch.
      this.restoreSimulationClock(checkpoint.tick);
      // Death delay still runs grenades/AI: an in-flight frag wipe (or wave
      // pulse) can leave lastAliveCount at 0, then restored hostiles falsely
      // toast a "new wave" — same latch rematch already applies.
      this.lastAliveCount = this.enemies.getAlive().length;
      this.waveToastTimer = 0;
      // restoreState already clearInput'd then reapplied crouch/slide. A second
      // clearInput here would wipe slideTimer / sliding and stand you up vs the
      // jammer checkpoint pose — only resync physical holds that never got keyup.
    } else {
      this.resetRunToOpening();
      this.player.clearInput();
    }
    this.player.resyncHeldKeys(heldKeys);
    this.post.setDamageIntensity(0);
    this.hud.clearDamage();
    this.hud.clearMissionResult();
    // Death line + any death-delay frag credits stay on screen after the world
    // rewinds (hostileKills / roster already restored) — same presentation latch
    // family as waveToastTimer. Hitmarker is the same leftover class.
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
    this.syncMissionHud();
    this.syncAmmoHud();
    this.hud.setWeaponName(this.weapons.getActiveDef().name);
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.player.requestPointerLock(this.renderer.renderer.domElement);
  }

  /**
   * Align GameSession + FixedStepSimulation to the same tick and drop any
   * in-flight death countdown so restore cannot keep a half-spent timer.
   */
  private restoreSimulationClock(tick: number): void {
    this.gameSession.rewindClock(tick);
    this.simulation.reset(tick);
    this.deathRestoreRemaining = null;
    this.pendingSessionEvents.length = 0;
    this.pendingSquadEvents.length = 0;
  }

  /** Full clean start: mission, combatants, and loadout match a fresh run. */
  private resetRunToOpening(): void {
    this.mission.reset();
    this.grenades.reset();
    this.weapons.reset();
    this.enemies.resetToInitial();
    // Rematch/early-death used to keep lastAliveCount at 0 after a wipe, so the
    // next spawn pulse falsely toasted a new wave. Latch the rebuilt roster.
    this.lastAliveCount = this.enemies.getAlive().length;
    this.waveToastTimer = 0;
    this.runtimeCheckpoint = null;
    this.hostileKills = 0;
    // Rebuild alone left the combat PRNG and session clock on the spent run —
    // rematch then polluted fork(tick) salts. Reset both to opening.
    this.simulationRandom.restore(this.simulationSeed);
    this.restoreSimulationClock(0);
    this.player.revive(true);
    this.player.setPosition(
      this.level.playerSpawn.x,
      this.level.playerSpawn.y,
      this.level.playerSpawn.z,
    );
  }

  private syncAmmoHud(): void {
    const ammo = this.weapons.getAmmo();
    if (ammo) {
      this.hud.setAmmo({
        magazine: ammo.mag,
        reserve: ammo.reserve,
        magazineSize: ammo.magSize,
      });
    } else {
      this.hud.setAmmo({ magazine: 0, reserve: 0, magazineSize: 0 });
    }
  }

  private onResize = (): void => {
    this.renderer.setSize();
    this.syncPostSize();
    const cam = this.player.camera;
    cam.aspect =
      (this.app.clientWidth || window.innerWidth) /
      Math.max(1, this.app.clientHeight || window.innerHeight);
    cam.updateProjectionMatrix();
  };

  private syncPostSize(): void {
    const w = this.app.clientWidth || window.innerWidth;
    const h = this.app.clientHeight || window.innerHeight;
    this.post.setSize(w, h);
  }

  private onPointerLock = (): void => {
    if (!this.playing) return;
    if (document.pointerLockElement === null && !this.player.isDead()) {
      this.paused = true;
      // Snapshot holds before clear — Esc unlock drops pointer lock without
      // keyup, so resume must resyncHeldKeys or WASD stay dead until repress.
      this.player.beginInputSuspend();
      this.simulation.setPaused(true);
      this.menu.show();
      this.hud.setVisible(false);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.playing) {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      }
    }
  };

  private loop = (frameTimestamp = performance.now()): void => {
    this.animId = requestAnimationFrame(this.loop);
    const mainThreadStartedAt = performance.now();
    this.renderer.beginPerformanceFrame(frameTimestamp);
    const dt = this.clock.getDelta();

    let interpolationAlpha = 1;
    if (this.playing && !this.paused && !this.menu.isVisible() && !this.qaFrozen) {
      this.simulation.setPaused(false);
      const frame = this.simulation.advance(dt, () => {
        this.gameSession.enqueueInput(
          this.gameSession.tick + 1,
          this.player.sampleInputFrame(),
        );
        this.gameSession.step();
      });
      interpolationAlpha = frame.interpolationAlpha;
    } else if (this.playing && this.qaFrozen) {
      this.simulation.setPaused(true);
    } else if (!this.playing) {
      // Idle menu camera — orbit the intersection for a cinematic title backdrop
      const t = this.qaFrozen ? 8 : this.clock.getElapsed();
      const cam = this.renderer.camera;
      const radius = 16 + Math.sin(t * 0.11) * 2;
      cam.position.set(
        Math.sin(t * 0.09) * radius,
        6.5 + Math.sin(t * 0.13) * 0.8,
        Math.cos(t * 0.09) * radius * 0.85 + 4,
      );
      cam.lookAt(0, 2.2, 4);
      this.post.setCamera(cam);
    }

    if (this.playing) {
      this.player.applyRenderInterpolation(interpolationAlpha);
      this.enemies.applyRenderInterpolation(interpolationAlpha);
    }

    const presentationDt = this.qaFrozen ? 0 : dt;
    // The ambient mote field is presentation-only and follows whichever camera
    // is live, so menu and gameplay framing both look through occupied air.
    this.vfx.setAmbientFocus(
      this.playing ? this.player.getPositionRef() : this.renderer.camera.position,
    );
    this.vfx.update(presentationDt);
    this.decals.update(presentationDt);
    this.environmentAssembler?.update(this.player.camera);
    this.environment.update(this.playing ? this.player.getPositionRef() : this.renderer.camera.position);
    this.renderer.syncViewModelEnvironment(this.renderer.scene);
    this.csm.update();
    if (this.csmHelper.visible) this.csmHelper.update();
    this.renderer.beginFrameStats();
    this.post.render(presentationDt);
    if (this.playing) this.renderer.renderViewModel();
    this.renderer.endFrameStats();
    this.renderer.endPerformanceFrame(performance.now() - mainThreadStartedAt);
  };

  private applyPlayerIntent(dt: number): void {
    this.post.setCamera(this.player.camera);
    this.player.update(dt, this.routeColliders);
  }

  private updateNavigationAndAI(dt: number, tick: number, random: SeededRandom): GameEvent[] {
    this.navigationRandom = random;
    try {
      // Advance mission combat state before the squad ticks so jammer clear /
      // beat changes / lull cooling affect this step's directive. HUD and audio
      // presentation stay in updateMissionAndPresentation after combat.
      this.advanceMissionCombatState(dt);
      this.enemies.applyCombatDirective(this.mission.getCombatDirective());
      this.enemies.update(dt, this.player.getPositionRef());
      const events: GameEvent[] = this.pendingSquadEvents
        .splice(0)
        .map(({ event, agentId }) => ({ type: 'squad', tick, event, agentId }));

      const alive = this.enemies.getAlive().length;
      if (this.lastAliveCount === 0 && alive > 0) {
        // Arm the toast timer only — syncMissionHud owns the shared interact slot
        // so jammer prompts are not wiped when this timer expires mid-objective.
        this.waveToastTimer = 2.4;
        this.audio.playUIClick();
      }
      this.lastAliveCount = alive;
      if (this.waveToastTimer > 0) this.waveToastTimer -= dt;
      return events;
    } finally {
      this.navigationRandom = null;
    }
  }

  /** Combat-affecting mission step; must run before applyCombatDirective. */
  private advanceMissionCombatState(dt: number): void {
    // Pass jammer clear on the mission frame so syncEncounterFlags grants the
    // encounter lull (and encounter-complete) the same way first-contact /
    // intersection clears do. Calling disableJammer() first would set the flag
    // early and skip that breather on the defense transition.
    const jammerDisabled =
      !!this.currentSessionInput.interact
      && this.mission.getBeat() === 'jammer'
      && this.canInteractWithJammer();
    this.mission.update(dt, {
      playerPosition: this.player.getPositionRef(),
      playerDead: this.player.isDead(),
      firstContactComplete: this.hostileKills >= 2,
      intersectionClear: this.hostileKills >= 6,
      jammerDisabled: jammerDisabled || undefined,
      hostilesAlive: this.enemies.getAlive().length,
      playerHealthFraction: this.player.health / this.player.maxHealth,
    });
  }

  private updateCombat(dt: number, tick: number): GameEvent[] {
    const hitscanTargets = this.enemies.asHitscanTargets();
    this.killCreditWeapon = this.weapons.getActiveDef().name;
    this.weapons.setSimulationTick(tick);
    this.weapons.update(dt, this.renderer.scene, hitscanTargets);
    this.grenades.setThrowHeld(!!this.currentSessionInput.grenade && !this.player.isDead());
    this.killCreditWeapon = 'Frag';
    this.grenades.update(dt, hitscanTargets);
    this.killCreditWeapon = this.weapons.getActiveDef().name;
    const events = this.pendingSessionEvents.splice(0);
    // Player rounds that pass close to a hostile suppress it, so shooting back
    // changes enemy behavior even when nothing connects.
    for (const event of events) {
      if (event.type !== 'shot') continue;
      this.enemies.notifyPlayerFire(
        new Vector3(event.origin.x, event.origin.y, event.origin.z),
        new Vector3(event.direction.x, event.direction.y, event.direction.z),
      );
    }
    return events;
  }

  private updateMissionAndPresentation(dt: number): GameEvent[] {
    // Acoustic space tracks the player continuously so ambient duck / footstep
    // coloration switch at the doorway, not only on the next gunshot.
    this.audio.setAcousticSpace(this.player.getPositionRef().z >= 21 ? 'indoor' : 'outdoor');

    // Mission combat state already advanced in updateNavigationAndAI so the
    // squad directive matches this tick's beat; this phase is presentation only.
    this.updateDeathRestore(dt);
    this.syncMissionHud();

    // Traversal cues are consumed here so camera and audio react to the same
    // event; CameraFeel's own latch read then finds nothing left to apply.
    const slideSpeed = this.player.consumeSlideStart();
    if (slideSpeed > 0) {
      this.cameraFeel.notifySlideStart(slideSpeed);
      this.audio.playSlide(slideSpeed / 10.2);
    }
    const mantleHeight = this.player.consumeMantle();
    if (mantleHeight > 0) {
      this.cameraFeel.notifyMantle(mantleHeight);
      this.audio.playMantle();
    }

    this.cameraFeel.update(
      dt,
      this.player.isMoving(),
      this.player.isSprinting(),
      this.weapons.isADS(),
      this.player.isGrounded(),
      this.player.isSliding(),
    );

    // Footsteps
    if (this.player.isGrounded() && this.player.isMoving()) {
      const speed = this.player.getHorizontalSpeed();
      this.footstepTimer -= dt;
      const interval = this.player.isSprinting() ? 0.32 : 0.48;
      if (this.footstepTimer <= 0 && speed > 0.8) {
        const queriedSurface = this.physics?.getSurfaceAt(this.player.getPositionRef()) ?? 'concrete';
        const footstepSurface = queriedSurface === 'metal'
          ? 'metal'
          : queriedSurface === 'dirt' || queriedSurface === 'wood'
            ? 'dirt'
            : 'concrete';
        this.audio.playFootstep(footstepSurface, this.player.isSprinting() ? 1.1 : 0.85);
        this.footstepTimer = interval;
      }
    } else {
      this.footstepTimer = 0;
    }

    // HUD sync
    const weaponName = this.weapons.getActiveDef().name;
    if (weaponName !== this.lastWeaponName) {
      this.lastWeaponName = weaponName;
      this.hud.setWeaponName(weaponName);
    }
    this.syncAmmoHud();
    this.hud.setVitals({
      health: this.player.health,
      maxHealth: this.player.maxHealth,
      armor: this.player.armor,
      maxArmor: this.player.maxArmor,
    });
    this.hud.setCompassYaw(this.player.getYaw());

    // Crosshair half-gap tracks the real hitscan cone (move + fire bloom + ADS).
    this.hud.setCrosshairFromWeaponSpread(this.weapons.getCurrentSpread());

    const dmgIntensity = MathUtilsClamp(
      1 - this.player.health / this.player.maxHealth,
      0,
      1,
    );
    this.post.setDamageIntensity(dmgIntensity * 0.85);
    if (dmgIntensity < 0.05) this.hud.clearDamage();
    return [];
  }

  private canInteractWithJammer(): boolean {
    const origin = this.player.getEyePosition();
    const distance = Math.hypot(
      origin.x - JAMMER_INTERACTION_TARGET.x,
      origin.y - JAMMER_INTERACTION_TARGET.y,
      origin.z - JAMMER_INTERACTION_TARGET.z,
    );
    return this.physics
      ? this.physics.queryInteraction({
          origin,
          target: JAMMER_INTERACTION_TARGET,
          maxDistance: JAMMER_INTERACTION_DISTANCE,
          excludeBody: 'player',
          terminalTolerance: 0.3,
        })
      : distance <= JAMMER_INTERACTION_DISTANCE;
  }

  private snapshotSessionWorld(): GameWorldSnapshot {
    const player = this.player.snapshotState();
    const weapon = this.weapons.snapshotState();
    return {
      player: {
        position: { ...player.position },
        velocity: { ...player.velocity },
        health: player.health,
        armor: player.armor,
        yaw: player.yaw,
        pitch: player.pitch,
        alive: player.alive,
        crouching: player.crouching,
        grounded: player.grounded,
        sliding: player.sliding,
        slideTimer: player.slideTimer,
        mantleCooldown: player.mantleCooldown,
        eyeHeight: player.eyeHeight,
      },
      inventory: {
        ammunition: {
          ar: { mag: weapon.ammo.ar.mag, reserve: weapon.ammo.ar.reserve },
          pistol: { mag: weapon.ammo.pistol.mag, reserve: weapon.ammo.pistol.reserve },
        },
        equipment: {},
      },
      weapon: {
        active: weapon.active,
        fireCooldown: weapon.fireCooldown,
        reloading: weapon.reloading,
        reloadRemaining: weapon.reloadTimer,
        ads: weapon.ads,
        toggledAds: weapon.toggledAds,
        recoil: {
          pitch: weapon.recoilPunchPitch,
          yaw: weapon.recoilPunchYaw,
        },
        recoilShotIndex: weapon.recoilShotIndex,
        recoilPatternTimer: weapon.recoilPatternTimer,
        spreadBloom: weapon.spreadBloom,
        dryFireLatch: weapon.dryFireLatch,
        prevFire: weapon.prevFire,
        randomState: weapon.randomState,
      },
      grenadeCount: this.grenades.getRemaining(),
      grenades: this.grenades.snapshotState(),
      mission: this.mission.snapshot(),
      encounter: { hostileKills: this.hostileKills },
      ai: this.enemies.snapshotState(),
    };
  }

  private restoreSessionWorld(snapshot: GameWorldSnapshot): void {
    const currentPlayer = this.player.snapshotState();
    this.player.restoreState({
      ...currentPlayer,
      position: { ...snapshot.player.position },
      velocity: { ...snapshot.player.velocity },
      health: snapshot.player.health,
      armor: snapshot.player.armor,
      yaw: snapshot.player.yaw,
      pitch: snapshot.player.pitch,
      alive: snapshot.player.alive,
      crouching: snapshot.player.crouching,
      grounded: snapshot.player.grounded,
      sliding: snapshot.player.sliding,
      slideTimer: snapshot.player.slideTimer,
      mantleCooldown: snapshot.player.mantleCooldown,
      eyeHeight: snapshot.player.eyeHeight,
    });
    // Build the restore payload from the snapshot only — spreading live weapon
    // state would keep recoilShotIndex / pattern timer / bloom across restores.
    const liveAmmo = this.weapons.snapshotState().ammo;
    const ammoAr = snapshot.inventory.ammunition.ar ?? { mag: 0, reserve: 0 };
    const ammoPistol = snapshot.inventory.ammunition.pistol ?? { mag: 0, reserve: 0 };
    this.weapons.restoreState({
      active: snapshot.weapon.active as ReturnType<WeaponSystem['getActiveWeapon']>,
      ammo: {
        ar: {
          mag: ammoAr.mag,
          reserve: ammoAr.reserve,
          magSize: liveAmmo.ar.magSize,
        },
        pistol: {
          mag: ammoPistol.mag,
          reserve: ammoPistol.reserve,
          magSize: liveAmmo.pistol.magSize,
        },
      },
      fireCooldown: snapshot.weapon.fireCooldown,
      reloadTimer: snapshot.weapon.reloadRemaining,
      reloading: snapshot.weapon.reloading,
      ads: snapshot.weapon.ads,
      toggledAds: snapshot.weapon.toggledAds,
      recoilPunchPitch: snapshot.weapon.recoil.pitch,
      recoilPunchYaw: snapshot.weapon.recoil.yaw,
      recoilShotIndex: snapshot.weapon.recoilShotIndex ?? 0,
      recoilPatternTimer: snapshot.weapon.recoilPatternTimer ?? 0,
      spreadBloom: snapshot.weapon.spreadBloom ?? 0,
      dryFireLatch: snapshot.weapon.dryFireLatch === true,
      prevFire: snapshot.weapon.prevFire === true,
      randomState: snapshot.weapon.randomState,
    });
    const grenadeSnapshot = snapshot.grenades;
    this.grenades.restoreState(
      grenadeSnapshot && typeof grenadeSnapshot === 'object'
        ? grenadeSnapshot as ReturnType<GrenadeSystem['snapshotState']>
        : { remaining: snapshot.grenadeCount },
    );
    this.mission.restore(snapshot.mission as ReturnType<MissionDirector['snapshot']>);
    this.enemies.restoreState(snapshot.ai as ReturnType<EnemyManager['snapshotState']>);
    this.hostileKills = Number((snapshot.encounter as { hostileKills?: number }).hostileKills ?? 0);
    // Wipe→snapshot.restore left lastAliveCount at 0 while hostiles came back;
    // the next AI tick then falsely armed a "new wave" toast (death/rematch
    // already re-latch). Clear any in-flight toast too.
    this.lastAliveCount = this.enemies.getAlive().length;
    this.waveToastTimer = 0;
    // hostileKills rewound with the snapshot — drop killfeed that belonged to
    // the pre-restore timeline (death/rematch/QA already clear). Hitmarker too.
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
  }

  private handleSessionEvent(_event: GameEvent): void {
    // Typed events are already applied by their owning systems; this hook is
    // intentionally the single bridge for telemetry/replay consumers.
  }

  private handleMissionEvent(event: MissionEvent): void {
    if (event.type === 'checkpoint-saved') {
      this.runtimeCheckpoint = this.captureRuntimeCheckpoint();
      this.hud.showCheckpoint('Jammer secured — defense checkpoint');
      this.audio.playUIClick();
    } else if (event.type === 'checkpoint-restored') {
      this.hud.clearMissionResult();
      this.hud.showCheckpoint('Checkpoint restored');
    } else if (event.type === 'mission-failed') {
      this.hud.showMissionResult({
        kind: 'failed',
        title: 'Operator down',
        subtitle: resolveDeathRestoreSubtitle(!!(event.checkpoint ?? this.runtimeCheckpoint)),
      });
    } else if (event.type === 'mission-complete') {
      this.hud.showMissionResult({
        kind: 'completed',
        title: 'Nightglass secured',
        subtitle: 'Extraction confirmed. Hostile signal network is offline.',
        action: 'Press Esc for the operations menu',
      });
      // Snapshot holds so Esc → Play rematch can resync WASD (bare clearInput
      // left extract-sprint empty for beginInputSuspend on pointer unlock).
      this.player.beginInputSuspend();
      this.paused = true;
      this.simulation.setPaused(true);
    }
  }

  private captureRuntimeCheckpoint(): RuntimeCheckpoint {
    return {
      tick: this.gameSession.tick,
      player: this.player.snapshotState(),
      weapons: this.weapons.snapshotState(),
      grenades: this.grenades.snapshotState(),
      mission: this.mission.snapshot(),
      enemies: this.enemies.snapshotState(),
      randomState: this.simulationRandom.snapshot(),
      hostileKills: this.hostileKills,
    };
  }

  /**
   * Authoritative route loading is intentionally asynchronous. Until supplied
   * licensed assets pass their manifest contract, the previous level stays as a
   * clearly detectable load-failure fallback for development only.
   */
  private async initializeAuthoredEnvironment(): Promise<void> {
    let pendingRegistry: AssetRegistry | null = null;
    let pendingAssembler: EnvironmentAssembler | null = null;
    let pendingLoaderDispose: (() => void) | null = null;
    let presentationInstalled = false;
    try {
      const response = await fetch('/assets/manifest.json');
      if (!response.ok) throw new Error(`asset manifest ${response.status}`);
      const manifest = await response.json() as import('./engine').AssetManifest;
      const contract = validateNightglassAssetContract(manifest);
      if (!contract.valid) {
        const detail = `Asset contract rejected (${contract.missingGroups.length} missing groups, ${contract.invalidAssets.length} invalid entries).`;
        console.warn('[assets] authored route disabled:', {
          missingGroups: contract.missingGroups,
          invalidAssets: contract.invalidAssets,
        });
        this.setReleaseAssetGate(detail);
        return;
      }
      await this.physicsReady;
      if (!this.physics) {
        throw new Error('authored route requires the Rapier physics authority');
      }
      const { createThreeAssetLoaders } = await import('./engine/ThreeAssetLoaders');
      const loaderSet = createThreeAssetLoaders({ renderer: this.renderer.renderer });
      pendingLoaderDispose = loaderSet.dispose;
      pendingRegistry = new AssetRegistry(manifest, {
        loaders: { ...createFetchAssetLoaders(), ...loaderSet.loaders },
      });
      if (!NIGHTGLASS_RUNTIME_ASSET_IDS.every((id) => pendingRegistry?.has(id))) {
        throw new Error('asset manifest does not provide the complete NIGHTGLASS runtime package');
      }
      const modules = authoredRouteModules();
      pendingAssembler = new EnvironmentAssembler({
        scene: this.renderer.scene,
        registry: pendingRegistry,
        modules,
        lodBias: this.quality.lodBias,
        // LOD0 establishes the playable route; distant detail streams after
        // first presentation instead of delaying the critical path.
        deferLodUpgrades: true,
        buildFallback: () => {
          this.level.group.visible = true;
          return { dispose: () => {} };
        },
      });
      const result = await pendingAssembler.load();
      if (result.mode !== 'authored') {
        throw result.error ?? new Error('authored environment assembler entered fallback mode');
      }
      if (this.releaseMode) {
        const lodErrors = await pendingAssembler.waitForLodUpgrades();
        if (lodErrors.length > 0) {
          throw new Error(`authored route has ${lodErrors.length} deferred LOD load failure(s)`);
        }
      }
      // Keep the fully assembled route detached from presentation until every
      // companion visual, lighting and audio asset has loaded successfully.
      result.group.visible = false;
      const authoredColliders = pendingAssembler.getStaticColliders();
      const authoredNavigation = pendingAssembler.getNavigationAnnotations();
      const authoredRenderStats = pendingAssembler.getRenderStats();
      if (authoredColliders.length === 0) {
        throw new Error('authored route has no COLLIDER_ nodes');
      }
      if (authoredColliders.some((collider) => collider.mesh.indices.length < 3)) {
        throw new Error('authored COLLIDER_ nodes must contain triangle geometry');
      }
      if (
        authoredNavigation.nodes.length < 2
        || authoredNavigation.links.length === 0
        || authoredNavigation.coverSlots.length === 0
      ) {
        throw new Error('authored route has incomplete NAV_/COVER_ annotations');
      }
      if (
        authoredRenderStats.instancedMeshes < 3
        || authoredRenderStats.instances < 6
        || authoredRenderStats.lightmappedMaterials < 3
        || authoredRenderStats.emissiveMaterials < 1
      ) {
        throw new Error('authored route lacks lamp/window/debris instances, baked lightmaps, or emissive cards');
      }

      const [viewmodel, characters, lightingTextures, heroTextures, audioAssets] = await Promise.all([
        pendingRegistry.load<GLTF>(NIGHTGLASS_VIEWMODEL_ASSET_ID),
        Promise.all(NIGHTGLASS_CHARACTER_ASSET_IDS.map((id) => pendingRegistry!.load<GLTF>(id))),
        Promise.all(NIGHTGLASS_LIGHTING_ASSET_IDS.map((id) => pendingRegistry!.load<Texture>(id))),
        Promise.all(NIGHTGLASS_TEXTURE_ASSET_IDS.map((id) => pendingRegistry!.load<Texture>(id))),
        Promise.all(NIGHTGLASS_AUDIO_ASSET_IDS.map(async (id) => ({
          id,
          entry: pendingRegistry!.getEntry(id),
          buffer: await pendingRegistry!.load<AudioBuffer>(id),
        }))),
      ]);

      if (this.physics) {
        this.replacePhysicsRoute(this.physics, authoredColliders, authoredNavigation);
      }
      this.setRouteColliders(authoredColliders);

      presentationInstalled = true;
      this.environment.setEnvironmentTexture(lightingTextures[0], true);
      this.environment.setReflectionProbes([
        { id: 'street', position: [0, 2, 10], texture: lightingTextures[1] },
        { id: 'warehouse', position: [0, 2, 27], texture: lightingTextures[2] },
      ]);
      this.weapons.viewModel.installAuthored(viewmodel);
      this.weapons.setAuthoredRifleOnly(true);
      this.enemies.setAuthoredArchetypes(characters);
      this.audio.clearSuppliedBuffers();
      for (const asset of audioAssets) {
        const capabilities = Array.isArray(asset.entry.metadata?.capabilities)
          ? asset.entry.metadata.capabilities.filter(
              (value): value is string => typeof value === 'string',
            )
          : [];
        this.audio.installBuffer(asset.id, asset.buffer, capabilities);
      }
      this.environmentAssembler?.dispose();
      this.assetRegistry?.dispose();
      this.threeAssetLoadersDispose?.();
      this.environmentAssembler = pendingAssembler;
      this.assetRegistry = pendingRegistry;
      this.threeAssetLoadersDispose = pendingLoaderDispose;
      pendingAssembler = null;
      pendingRegistry = null;
      pendingLoaderDispose = null;
      this.authoredStaticColliders = authoredColliders;
      this.authoredNavigation = authoredNavigation;
      this.authoredRenderStats = authoredRenderStats;
      this.authoredHeroTextureCount = heroTextures.length;
      this.setReleaseAssetGate(null);

      result.group.visible = true;
      this.level.group.visible = false;
      // The CC0 layer is a child of the procedural group, so the visibility
      // swap already removes it from presentation. Dispose it here as well so
      // an authored route does not retain development-only GPU resources.
      this.developmentPropLayer?.dispose();
      this.developmentPropLayer = null;
      this.developmentSkylineBackdrop?.dispose();
      this.developmentSkylineBackdrop = null;
      this.disposeDevelopmentRipstop();
      this.renderer.applySceneQuality(this.renderer.scene, this.quality);
      this.renderer.applySceneQuality(this.renderer.viewModelScene, this.quality);
      this.renderer.scene.traverse((node) => {
        const mesh = node as import('three').Mesh;
        if (!mesh.isMesh) return;
        const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material];
        for (const material of materials) {
          if (material instanceof MeshStandardMaterial) {
            this.setupCascadedShadowsAndFog(material);
          }
        }
      });
    } catch (error) {
      pendingAssembler?.dispose();
      pendingRegistry?.dispose();
      pendingLoaderDispose?.();
      if (presentationInstalled) {
        this.weapons.viewModel.clearAuthored();
        this.weapons.setAuthoredRifleOnly(false);
        this.enemies.setAuthoredArchetypes([]);
        this.audio.clearSuppliedBuffers();
        this.environment.clearAuthoredTextures();
        this.authoredStaticColliders = null;
        this.authoredNavigation = null;
        this.authoredRenderStats = null;
        this.authoredHeroTextureCount = 0;
        this.setRouteColliders(null);
        if (this.physics) this.replacePhysicsRoute(this.physics, null, null);
      }
      this.level.group.visible = true;
      if (!this.releaseMode) this.loadDevelopmentRipstop();
      this.setReleaseAssetGate('Authored asset package failed to load; release capture is unavailable.');
      console.warn('[assets] authored route load failed; development fallback remains active', error);
    }
  }

  /**
   * One optional development fetch for original soft-goods detail. A generation
   * guard disposes a late texture if the fallback is swapped out or the game is
   * destroyed before the image resolves.
   */
  private loadDevelopmentRipstop(): void {
    if (this.releaseMode || this.developmentRipstopTexture || this.developmentRipstopLoad) return;
    const generation = ++this.developmentRipstopGeneration;
    const maxAnisotropy = this.renderer.renderer.capabilities.getMaxAnisotropy();
    this.developmentRipstopLoad = (async () => {
      let texture: Texture | null = null;
      try {
        texture = await new TextureLoader().loadAsync(DEVELOPMENT_RIPSTOP_URL);
        if (generation !== this.developmentRipstopGeneration || this.releaseMode) {
          texture.dispose();
          return;
        }
        configureDevelopmentRipstopSource(texture, maxAnisotropy);
        // Both consumers alter only their known procedural fallback materials.
        // Authored GLTF roots and their material graphs are never passed here.
        this.weapons.viewModel.installDevelopmentRipstop(texture, maxAnisotropy);
        Enemy.installDevelopmentRipstop(texture, maxAnisotropy);
        this.developmentRipstopTexture = texture;
        texture = null;
        console.info('[development-ripstop] installed original fallback soft-goods material');
      } catch (error) {
        texture?.dispose();
        if (generation !== this.developmentRipstopGeneration) return;
        this.weapons.viewModel.clearDevelopmentRipstop();
        Enemy.clearDevelopmentRipstop();
        console.warn('[development-ripstop] material unavailable; retaining procedural fallback', error);
      } finally {
        if (generation === this.developmentRipstopGeneration) {
          this.developmentRipstopLoad = null;
        }
      }
    })();
  }

  /** Drops optional fallback clones/source before an authored swap or teardown. */
  private disposeDevelopmentRipstop(): void {
    this.developmentRipstopGeneration += 1;
    this.weapons.viewModel.clearDevelopmentRipstop();
    Enemy.clearDevelopmentRipstop();
    this.developmentRipstopTexture?.dispose();
    this.developmentRipstopTexture = null;
    this.developmentRipstopLoad = null;
  }

  private setReleaseAssetGate(message: string | null): void {
    if (!this.releaseMode) return;
    this.releaseAssetGate = message;
    this.menu?.setLaunchBlocked(message);
  }

  private canLaunchRelease(): boolean {
    return !this.releaseMode || (
      this.releaseAssetGate === null
      && this.environmentAssembler?.getMode() === 'authored'
      && this.level.group.visible === false
    );
  }

  private async initializePhysics(): Promise<void> {
    let physics: RapierPhysicsWorld | null = null;
    try {
      // Rapier is only required after the menu and render shell are live. Keep
      // its WASM wrapper out of the startup graph. startGame awaits
      // `physicsReady` before playing=true so AABB→Rapier never swaps mid-run.
      const { RapierPhysicsWorld } = await import('./simulation/PhysicsWorld');
      const initializedPhysics = await RapierPhysicsWorld.create();
      physics = initializedPhysics;
      this.addRouteColliders(initializedPhysics, this.authoredStaticColliders);
      const position = this.player.getPositionRef();
      initializedPhysics.addCharacter({
        id: 'player',
        position: { x: position.x, y: position.y + 0.9, z: position.z },
        radius: 0.32,
        halfHeight: 0.9,
      });
      this.enemies.setLineOfSight((origin, target) => {
        const direction = this.losRayDir.copy(target).sub(origin);
        const distance = direction.length();
        if (distance < 1e-5) return true;
        return !initializedPhysics.castRay({
          origin,
          direction,
          maxDistance: Math.max(0, distance - 0.02),
          includeCharacters: false,
        });
      });
      this.configureEnemyNavigation(initializedPhysics, this.authoredNavigation);
      this.physics = initializedPhysics;
      this.player.setPhysicsWorld(initializedPhysics, 'player');
      this.weapons.setPhysicsWorld(initializedPhysics);
      this.grenades.setPhysicsWorld(initializedPhysics);
    } catch (error) {
      physics?.dispose();
      if (this.physics === physics) this.physics = null;
      console.warn('[physics] Rapier unavailable; development fallback remains active', error);
    }
  }

  /**
   * The development route supplies the navigation annotations until authored
   * source modules arrive. Graph links are accepted only after the same
   * Rapier capsule sweep used by live enemy movement clears them.
   */
  private configureEnemyNavigation(
    physics: RapierPhysicsWorld,
    annotations: AuthoredNavigationAnnotations | null = null,
  ): void {
    const capsuleCenterY = 0.9;
    const authoredAnchors: Array<[string, number, number]> = [
      ['south-approach', 0, -28],
      ['spawn', 0, 0],
      ['intersection-south', 0, 7],
      ['intersection', 0, 12],
      ['intersection-north', 0, 18],
      ['warehouse-entry', 0, 23],
      ['warehouse', 0, 28],
      ['east-flank', 12, 12],
      ['west-flank', -12, 12],
    ];
    let nodes: Array<{ id: string; position: Vec3 }>;
    let links: Array<{ from: string; to: string }>;
    let coverDefinitions: Array<{ id: string; position: Vec3 }>;
    if (annotations) {
      nodes = annotations.nodes.map((node) => ({
        id: node.id,
        position: { ...node.position, y: node.position.y + capsuleCenterY },
      }));
      links = annotations.links.map((link) => ({ ...link }));
      coverDefinitions = annotations.coverSlots.map((slot) => ({
        id: slot.id,
        position: { ...slot.position },
      }));
    } else {
      const points = [
        ...authoredAnchors,
        ...this.level.enemySpawns.map((point, index) => [`spawn-${index}`, point.x, point.z] as [string, number, number]),
        ...this.level.coverNodes.map((point, index) => [`cover-${index}`, point.x, point.z] as [string, number, number]),
      ];
      const seen = new Set<string>();
      nodes = points
        .filter(([, x, z]) => {
          const key = `${x.toFixed(2)}:${z.toFixed(2)}`;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        })
        .map(([id, x, z]) => ({ id, position: { x, y: capsuleCenterY, z } }));
      links = [];
      for (let left = 0; left < nodes.length; left += 1) {
        for (let right = left + 1; right < nodes.length; right += 1) {
          const a = nodes[left];
          const b = nodes[right];
          const distance = Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z);
          if (distance < 1 || distance > 19) continue;
          links.push({ from: a.id, to: b.id }, { from: b.id, to: a.id });
        }
      }
      coverDefinitions = this.level.coverNodes.map((point, index) => ({
        id: `cover-${index}`,
        position: { x: point.x, y: point.y, z: point.z },
      }));
    }
    const graph = new NavigationGraph(nodes, links, physics, { radius: 0.32, halfHeight: 0.9 });
    if (annotations && nodes.slice(1).some((node) => !graph.isReachable(nodes[0].id, node.id))) {
      throw new Error('authored navigation graph is not fully reachable after Rapier capsule sweeps');
    }
    const cover = new CoverSlots(coverDefinitions);
    const squad = new SquadDirector(graph, cover);
    const movement: EnemyMovementAuthority = {
      move: (enemy, desiredTarget, dt, speed) => {
        const bodyId = this.ensureEnemyPhysicsBody(physics, enemy, capsuleCenterY);
        const current = enemy.position;
        const currentCenter = { x: current.x, y: current.y + capsuleCenterY, z: current.z };
        const desiredCenter = {
          x: desiredTarget.x,
          y: desiredTarget.y + capsuleCenterY,
          z: desiredTarget.z,
        };
        const from = graph.nearestNode(currentCenter);
        const to = graph.nearestNode(desiredCenter);
        const path = from && to ? graph.findPath(from.id, to.id) : null;
        let waypoint = desiredCenter;
        if (path) {
          waypoint = path.points.find((point) => (
            Math.hypot(point.x - currentCenter.x, point.z - currentCenter.z) > 0.45
          )) ?? desiredCenter;
        } else if (!physics.queryNavigation(currentCenter, desiredCenter, { radius: 0.32, halfHeight: 0.9 })) {
          return current.clone();
        }
        const dx = waypoint.x - currentCenter.x;
        const dz = waypoint.z - currentCenter.z;
        const distance = Math.hypot(dx, dz);
        if (distance < 1e-4) return current.clone();
        const distanceThisTick = Math.min(distance, Math.max(0, speed * dt));
        const result = physics.moveCharacter(bodyId, {
          translation: {
            x: (dx / distance) * distanceThisTick,
            y: 0,
            z: (dz / distance) * distanceThisTick,
          },
        });
        return new Vector3(result.position.x, result.position.y - capsuleCenterY, result.position.z);
      },
      release: (enemy) => {
        const bodyId = this.enemyPhysicsBodies.get(enemy);
        if (!bodyId) return;
        physics.removeCharacter(bodyId);
        this.enemyPhysicsBodies.delete(enemy);
      },
      teleport: (enemy, position) => {
        const bodyId = this.ensureEnemyPhysicsBody(physics, enemy, capsuleCenterY);
        physics.teleportCharacter(bodyId, {
          x: position.x,
          y: position.y + capsuleCenterY,
          z: position.z,
        });
      },
    };
    this.enemies.setNavigationRuntime({ graph, cover, squad, movement });
  }

  private replacePhysicsRoute(
    physics: RapierPhysicsWorld,
    colliders: readonly AuthoredStaticCollider[] | null,
    navigation: AuthoredNavigationAnnotations | null,
  ): void {
    physics.removeStaticColliders((id) => id.startsWith('level:') || id.startsWith('authored:'));
    try {
      this.addRouteColliders(physics, colliders);
      this.configureEnemyNavigation(physics, navigation);
    } catch (error) {
      physics.removeStaticColliders((id) => id.startsWith('authored:'));
      this.addRouteColliders(physics, null);
      this.configureEnemyNavigation(physics, null);
      throw error;
    }
  }

  private addRouteColliders(
    physics: RapierPhysicsWorld,
    colliders: readonly AuthoredStaticCollider[] | null,
  ): void {
    if (colliders) {
      for (const collider of colliders) {
        physics.addStaticTrimesh({
          id: collider.id,
          vertices: collider.mesh.vertices,
          indices: collider.mesh.indices,
          surface: collider.surface,
        });
      }
      return;
    }
    for (let index = 0; index < this.level.colliders.length; index += 1) {
      const collider = this.level.colliders[index];
      physics.addStaticBox({
        id: `level:${index}`,
        center: {
          x: (collider.min.x + collider.max.x) * 0.5,
          y: (collider.min.y + collider.max.y) * 0.5,
          z: (collider.min.z + collider.max.z) * 0.5,
        },
        halfExtents: {
          x: Math.max(0.01, (collider.max.x - collider.min.x) * 0.5),
          y: Math.max(0.01, (collider.max.y - collider.min.y) * 0.5),
          z: Math.max(0.01, (collider.max.z - collider.min.z) * 0.5),
        },
        surface: 'concrete',
      });
    }
  }

  private setRouteColliders(colliders: readonly AuthoredStaticCollider[] | null): void {
    this.routeColliders = colliders
      ? colliders.map((collider) => ({
          min: new Vector3(
            collider.center.x - collider.halfExtents.x,
            collider.center.y - collider.halfExtents.y,
            collider.center.z - collider.halfExtents.z,
          ),
          max: new Vector3(
            collider.center.x + collider.halfExtents.x,
            collider.center.y + collider.halfExtents.y,
            collider.center.z + collider.halfExtents.z,
          ),
        }))
      : this.level.colliders;
    this.weapons.setColliders(this.routeColliders);
    this.grenades.setColliders(this.routeColliders);
  }

  private ensureEnemyPhysicsBody(
    physics: RapierPhysicsWorld,
    enemy: Enemy,
    capsuleCenterY: number,
  ): string {
    const existing = this.enemyPhysicsBodies.get(enemy);
    if (existing) return existing;
    const id = `enemy:${++this.enemyPhysicsSerial}`;
    physics.addCharacter({
      id,
      position: {
        x: enemy.position.x,
        y: enemy.position.y + capsuleCenterY,
        z: enemy.position.z,
      },
      radius: 0.32,
      halfHeight: 0.9,
    });
    this.enemyPhysicsBodies.set(enemy, id);
    return id;
  }

  private qaStep(input: Partial<InputFrame> = {}, count = 1): void {
    this.qaFrozen = true;
    this.post.setDeterministicCapture(true);
    const frame: InputFrame = { ...EMPTY_QA_INPUT, ...input };
    const sustainedFrame = clearInputEdges(frame);
    for (let index = 0; index < Math.max(1, Math.floor(count)); index += 1) {
      this.gameSession.enqueueInput(this.gameSession.tick + 1, index === 0 ? frame : sustainedFrame);
      this.gameSession.step();
    }
    this.player.applyRenderInterpolation(1);
    this.enemies.applyRenderInterpolation(1);
  }

  private qaSetPresentation(hud: boolean, viewModel: boolean): void {
    this.hud.setVisible(hud);
    this.renderer.viewModelScene.visible = viewModel;
  }

  private qaSetDebugView(view: DebugRenderView | 'shadow-cascades'): void {
    const cascades = view === 'shadow-cascades';
    this.csmHelper.visible = cascades;
    this.renderer.setDebugView(cascades ? 'beauty' : view);
    if (cascades) this.csmHelper.update();
  }

  private qaResetPresentation(): void {
    if (!this.qaPlayerBaseline) {
      this.qaPlayerBaseline = this.player.snapshotState();
      this.qaWeaponBaseline = this.weapons.snapshotState();
      this.qaGrenadeBaseline = this.grenades.snapshotState();
      this.qaEnemyBaseline = this.enemies.snapshotState();
      this.qaSimulationRandomBaseline = this.simulationRandom.snapshot();
      this.qaTickBaseline = this.gameSession.tick;
    }
    const currentPlayer = this.player.snapshotState();
    this.player.restoreState({
      ...this.qaPlayerBaseline,
      position: currentPlayer.position,
      yaw: currentPlayer.yaw,
      pitch: currentPlayer.pitch,
    });
    if (this.qaSimulationRandomBaseline !== null) {
      this.simulationRandom.restore(this.qaSimulationRandomBaseline);
    }
    if (this.qaWeaponBaseline) this.weapons.restoreState(this.qaWeaponBaseline);
    if (this.qaGrenadeBaseline) this.grenades.restoreState(this.qaGrenadeBaseline);
    if (this.qaEnemyBaseline) this.enemies.restoreState(this.qaEnemyBaseline);
    this.mission.reset();
    this.runtimeCheckpoint = null;
    this.deathRestoreRemaining = null;
    this.hostileKills = 0;
    this.lastAliveCount = this.enemies.getAlive().length;
    this.waveToastTimer = 0;
    this.pendingSessionEvents.length = 0;
    this.post.setDamageIntensity(0);
    this.hud.clearDamage();
    this.hud.clearMissionResult();
    // Same combat-telemetry latch as death/rematch — capture baselines rewind
    // hostileKills, so leftover killfeed / hitmarker must not pollute QA.
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
    // Capture states share one page load. Restore RNG without the session
    // clock and later scenarios fork(tick) at leftover hip/ads ticks.
    if (this.qaTickBaseline !== null) {
      this.restoreSimulationClock(this.qaTickBaseline);
    }
    this.qaStep({}, 2);
  }

  private qaSetCaptureState(state: QACaptureState): void {
    this.qaResetPresentation();
    switch (state) {
      case 'hip':
        this.qaStep({}, 20);
        break;
      case 'ads':
        this.qaStep({ aim: true }, 24);
        break;
      case 'reload':
        this.qaStep({ reload: true }, 1);
        this.qaStep({}, 29);
        break;
      // Exact timeline checkpoints make the reload's three physical beats
      // independently reviewable in deterministic browser captures. They are
      // QA-only states; gameplay continues to use the same weapon timeline.
      case 'reload-eject':
        this.qaStep({ reload: true }, 1);
        this.qaStep({}, 17);
        break;
      case 'reload-insert':
        this.qaStep({ reload: true }, 1);
        this.qaStep({}, 73);
        break;
      case 'reload-chamber':
        this.qaStep({ reload: true }, 1);
        this.qaStep({}, 94);
        break;
      case 'muzzle':
        this.weapons.viewModel.kickOnFire(1, false);
        this.player.camera.getWorldPosition(this.muzzlePos);
        this.player.camera.getWorldDirection(this.muzzleDir);
        this.muzzlePos.addScaledVector(this.muzzleDir, 0.55);
        this.vfx.spawnMuzzleFlash(this.muzzlePos, this.muzzleDir);
        this.post.pulseBloom(0.4);
        break;
      case 'impact': {
        this.player.camera.getWorldPosition(this.muzzlePos);
        this.player.camera.getWorldDirection(this.muzzleDir);
        const point = this.muzzlePos.clone().addScaledVector(this.muzzleDir, 4);
        const normal = this.muzzleDir.clone().negate();
        this.vfx.spawnImpact(point, normal, 'concrete');
        this.decals.spawnAt(point, normal, undefined, 'concrete');
        break;
      }
      case 'damage':
        this.player.takeDamage(78);
        this.qaStep({}, 1);
        break;
      case 'death':
        this.player.takeDamage(10_000);
        this.qaStep({}, 1);
        break;
      case 'jammer':
        this.qaSetMissionBeat('jammer');
        this.qaStep({}, 1);
        break;
      case 'defense':
      case 'extraction':
        this.qaSetMissionBeat(state);
        this.qaStep({}, 1);
        break;
    }
  }

  private qaSetMissionBeat(beat: MissionBeat): void {
    const snapshot = this.mission.snapshot();
    const rank: Record<MissionBeat, number> = {
      insertion: 0,
      intersection: 1,
      jammer: 2,
      defense: 3,
      extraction: 4,
      complete: 5,
      failed: 6,
    };
    this.mission.restore({
      ...snapshot,
      beat,
      beatElapsed: 0,
      defenseRemaining: beat === 'defense' ? 45 : snapshot.defenseRemaining,
      encounters: {
        firstContactComplete: rank[beat] >= 1,
        intersectionClear: rank[beat] >= 2,
        jammerDisabled: rank[beat] >= 3,
        defenseStarted: rank[beat] >= 3,
      },
    });
    this.syncMissionHud();
  }

  private qaPlaceEnemy(distance: number): void {
    const enemy = this.enemies.getAlive()[0]
      ?? this.enemies.spawnAt(this.player.getPositionRef().clone());
    this.player.camera.getWorldDirection(this.tmp);
    this.tmp.y = 0;
    if (this.tmp.lengthSq() < 1e-6) this.tmp.set(0, 0, 1);
    this.tmp.normalize();
    const position = this.player.getPositionRef().clone().addScaledVector(this.tmp, distance);
    enemy.teleport(position);
    enemy.faceTarget(this.player.getEyePosition());
  }

  private qaStats(): Record<string, unknown> {
    return {
      renderer: this.renderer.getStats(),
      quality: this.quality,
      assetMode: this.environmentAssembler?.getMode() ?? 'unloaded',
      proceduralFallbackVisible: this.level.group.visible,
      authoredPresentation: {
        route: this.environmentAssembler?.getMode() === 'authored',
        viewModel: this.weapons.viewModel.hasAuthoredVisual(),
        enemies: this.enemies.hasAuthoredVisuals(),
        audioBuffers: this.audio.getSuppliedBufferCount(),
        staticColliders: this.authoredStaticColliders?.length ?? 0,
        triangleColliders: this.authoredStaticColliders?.filter(
          (collider) => collider.mesh.indices.length >= 3,
        ).length ?? 0,
        physics: this.physics?.getDebugStats() ?? null,
        navigationNodes: this.authoredNavigation?.nodes.length ?? 0,
        coverSlots: this.authoredNavigation?.coverSlots.length ?? 0,
        heroTextures: this.authoredHeroTextureCount,
        render: this.authoredRenderStats,
      },
      releaseGate: {
        enabled: this.releaseMode,
        ready: this.canLaunchRelease(),
        reason: this.releaseAssetGate,
      },
      viewModel: this.weapons.viewModel.getPresentationMetrics(),
      determinism: {
        seededSimulation: true,
        initialSeed: this.simulationSeed,
        randomState: this.simulationRandom.snapshot(),
        fixedStepSeconds: this.gameSession.fixedDelta,
        qaFrozen: this.qaFrozen,
        menuTimeSecondsWhenFrozen: 8,
        temporalEffectsFrozen: this.qaFrozen,
      },
      simulationTick: this.gameSession.tick,
      gameplay: {
        playerPosition: { ...this.player.getPositionRef() },
        grounded: this.player.isGrounded(),
        weapon: this.weapons.getActiveWeapon(),
        grenadesRemaining: this.grenades.getRemaining(),
      },
      mission: this.mission.getDebugState(),
    };
  }

  private syncMissionHud(): void {
    const state = this.mission.getDebugState();
    const descriptions: Record<string, string> = {
      insertion: 'Push through the southern approach',
      intersection: 'Use cover and break the hostile line',
      jammer: 'Move north and press E or F to disable the relay',
      defense: 'Hold both reinforcement routes',
      extraction: 'Proceed to the northern signal flare',
      complete: 'Operation Nightglass complete',
      failed: 'Checkpoint recovery in progress',
    };
    this.hud.setObjective({
      title: this.mission.getObjectiveText(),
      description: descriptions[state.beat],
      status: state.beat === 'failed' ? 'failed' : state.beat === 'complete' ? 'completed' : 'active',
      progress: state.beat === 'defense' ? 1 - state.defenseRemaining / 90 : undefined,
      progressLabel: state.beat === 'defense' ? `${Math.ceil(state.defenseRemaining)} SEC` : undefined,
    });
    // Interact beats wave toast; toast keeps the slot while its timer runs.
    this.hud.showInteract(
      resolveMissionInteractPrompt({
        jammerInteractAvailable:
          state.beat === 'jammer' && this.canInteractWithJammer(),
        waveToastRemaining: this.waveToastTimer,
      }),
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLock);
    window.removeEventListener('keydown', this.onKeyDown);
    this.disposeDevelopmentRipstop();
    this.weapons.dispose();
    this.grenades.dispose();
    this.player.dispose();
    this.enemies.dispose();
    this.physics?.dispose();
    this.enemyPhysicsBodies.clear();
    this.vfx.dispose();
    this.decals.dispose();
    this.developmentPropLayer?.dispose();
    this.developmentPropLayer = null;
    this.developmentSkylineBackdrop?.dispose();
    this.developmentSkylineBackdrop = null;
    this.level.dispose();
    this.environmentAssembler?.dispose();
    this.assetRegistry?.dispose();
    this.threeAssetLoadersDispose?.();
    this.threeAssetLoadersDispose = null;
    this.csmHelper.removeFromParent();
    this.csmHelper.dispose();
    this.csm.dispose();
    this.lighting.dispose();
    this.environment.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.audio.dispose();
  }
}

function authoredRouteModules(): EnvironmentModulePlacement[] {
  return [
    { id: 'spawn-street', kind: 'building', position: [0, 0, 0], assets: ['route-spawn-lod0', 'route-spawn-lod1', 'route-spawn-lod2'], lightMapAsset: 'route-spawn-lightmap' },
    { id: 'intersection', kind: 'building', position: [0, 0, 12], assets: ['route-intersection-lod0', 'route-intersection-lod1', 'route-intersection-lod2'], lightMapAsset: 'route-intersection-lightmap' },
    { id: 'warehouse', kind: 'building', position: [0, 0, 23], assets: ['route-warehouse-lod0', 'route-warehouse-lod1', 'route-warehouse-lod2'], lightMapAsset: 'route-warehouse-lightmap' },
    { id: 'street-lamps', kind: 'prop', position: [0, 0, 0], assets: ['route-props-lod0', 'route-props-lod1', 'route-props-lod2'] },
  ];
}

function MathUtilsClamp(v: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, v));
}

function clearInputEdges(input: Readonly<InputFrame>): InputFrame {
  return {
    ...input,
    lookX: 0,
    lookY: 0,
    firePressed: false,
    aimPressed: false,
    reload: false,
    grenade: false,
    interact: false,
    jump: false,
    weaponSlot: undefined,
    weaponCycle: 0,
  };
}

// Boot
const game = new Game();

/** Headless / QA hooks for cinematic captures without pointer lock. */
declare global {
  interface Window {
    __BLACKOPS__?: {
      start: () => Promise<void>;
      look: (yaw: number, pitch: number) => void;
      moveTo: (x: number, y: number, z: number) => void;
      fire: () => void;
      freeze: (frozen?: boolean) => void;
      step: (input?: Partial<InputFrame>, count?: number) => void;
      state: (state: QACaptureState) => void;
      enemyDistance: (distance: number) => void;
      presentation: (options: { hud: boolean; viewModel: boolean }) => void;
      debugView: (view: DebugRenderView | 'shadow-cascades') => void;
      stats: () => Record<string, unknown>;
      performanceCapture: {
        start: () => ReturnType<GameRenderer['startPerformanceCapture']>;
        stop: () => ReturnType<GameRenderer['stopPerformanceCapture']>;
        status: () => ReturnType<GameRenderer['getPerformanceCaptureStatus']>;
        result: () => ReturnType<GameRenderer['getPerformanceCaptureResult']>;
      };
      snapshot: () => GameSnapshot;
      restore: (snapshot: GameSnapshot) => void;
      debug: () => {
        pos: { x: number; y: number; z: number };
        grounded: boolean;
        colliders: number;
        yaw: number;
        pitch: number;
        mission: ReturnType<MissionDirector['getDebugState']>;
      };
    };
  }
}

window.__BLACKOPS__ = {
  start: async () => {
    if (!game['canLaunchRelease']()) {
      game['menu'].show();
      return;
    }
    // This hook exists for deterministic browser capture, where an AudioContext
    // may remain suspended forever because there is no user gesture. Normal
    // menu-driven launch still awaits audio unlock in startGame().
    void game['audio'].unlock();
    game['menu'].hide();
    game['hud'].setVisible(true);
    game['playing'] = true;
    game['paused'] = false;
    game['post'].setCamera(game['player'].camera);
  },
  look: (yaw: number, pitch: number) => {
    game['player'].setLook(yaw, pitch);
  },
  moveTo: (x: number, y: number, z: number) => {
    game['player'].setPosition(x, Math.max(0, y), z);
  },
  fire: () => {
    game['qaSetCaptureState']('muzzle');
  },
  freeze: (frozen = true) => {
    game['qaFrozen'] = frozen;
    game['post'].setDeterministicCapture(frozen);
  },
  step: (input = {}, count = 1) => {
    game['qaStep'](input, count);
  },
  state: (state) => {
    game['qaSetCaptureState'](state);
  },
  enemyDistance: (distance) => {
    game['qaPlaceEnemy'](Math.max(1, distance));
  },
  presentation: ({ hud, viewModel }) => {
    game['qaSetPresentation'](hud, viewModel);
  },
  debugView: (view) => {
    game['qaSetDebugView'](view);
  },
  stats: () => {
    return game['qaStats']();
  },
  performanceCapture: {
    start: () => game['renderer'].startPerformanceCapture(),
    stop: () => game['renderer'].stopPerformanceCapture(),
    status: () => game['renderer'].getPerformanceCaptureStatus(),
    result: () => game['renderer'].getPerformanceCaptureResult(),
  },
  snapshot: () => game['gameSession'].snapshot(),
  restore: (snapshot) => {
    game['gameSession'].restore(snapshot);
    // GameSession.restore rewinds tick/RNG/world; FixedStepSimulation and the
    // death countdown live outside that snapshot and must be forced in sync.
    game['simulation'].reset(snapshot.tick);
    game['deathRestoreRemaining'] = null;
    game['pendingSessionEvents'].length = 0;
    game['pendingSquadEvents'].length = 0;
    game['player'].applyRenderInterpolation(1);
    game['enemies'].applyRenderInterpolation(1);
  },
  debug: () => {
    const p = game['player'];
    return {
      pos: p.getPosition(),
      grounded: p.isGrounded(),
      colliders: game['level'].colliders.length,
      yaw: p.getYaw(),
      pitch: p.getPitch(),
      mission: game['mission'].getDebugState(),
    };
  },
};

void game;
