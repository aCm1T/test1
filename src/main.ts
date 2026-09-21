import './style.css';
import { assetUrl } from './AssetPaths';
import { GameLifecycle } from './GameLifecycle';

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
  AdaptiveQualityController,
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
import { disposeCsm, initializeCsmHelper } from './engine/CascadedShadows';
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
  supplies: RunSupplies;
};

type RunSupplies = {
  firstContact: boolean;
  intersection: boolean;
  defense: boolean;
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
  assetUrl('assets/development/original-materials/nightglass-urban-ripstop-v2.png');

/**
 * Let the opening patrol announce itself before rounds can hurt the player.
 * Mission elapsed time is fixed-step state, so the grace window survives
 * pause/replay without introducing a wall-clock combat branch.
 */
const OPENING_DAMAGE_GRACE_SECONDS = 2.5;

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
  /** Menu choice stays AUTO even if runtime pressure lowers the resolved tier. */
  private qualityPreference: QualityPreference;
  private readonly graphicsCapabilities: GraphicsCapabilities;
  private readonly adaptiveQuality = new AdaptiveQualityController();
  private readonly lifecycle = new GameLifecycle();
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
  private crosshairEnabled = true;
  /** Distinguishes a real Esc/focus unlock from an initial lock request that a browser refused. */
  private pointerLockAcquired = false;
  private footstepTimer = 0;
  private readonly muzzlePos = new Vector3();
  private readonly muzzleDir = new Vector3();
  private readonly tmp = new Vector3();
  private readonly losRayDir = new Vector3();
  private readonly shotOrigin = new Vector3();
  private readonly shotDirection = new Vector3();
  private lastWeaponName = '';
  private animId = 0;
  private previousFrameTimestamp: number | null = null;
  private previousTitleRender = -Infinity;
  private frameTelemetryCountdown = 0;
  private lastAliveCount = -1;
  private waveToastTimer = 0;
  private fragToastTimer = 0;
  private hostileKills = 0;
  private deaths = 0;
  private supplies: RunSupplies = {
    firstContact: false,
    intersection: false,
    defense: false,
  };
  private pointerPromptTimer: number | undefined;
  private controlsIntroTimer: number | undefined;
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
    document.documentElement.style.setProperty(
      '--nightglass-menu-bg',
      `url("${assetUrl('assets/frontline-menu-bg.png')}")`,
    );
    this.setLifecycle('loading');
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
    this.qualityPreference = qaQuality;
    this.quality = quality;
    this.app.dataset.qualityPreference = qaQuality;
    this.app.dataset.qualityTier = quality.tier;
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
        assetUrl('assets/development/polyhaven/sunset_jhbcentral_2k.hdr'),
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
      scene: this.renderer.scene,
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
    this.hud = new HUD(this.app, {
      onReplay: () => this.restartMission(true),
      onMainMenu: () => this.returnToMainMenu(),
    });
    this.grenades = new GrenadeSystem({
      scene: this.renderer.scene,
      camera: this.player.camera,
      colliders: this.routeColliders,
      getPlayerPosition: () => this.player.getPositionRef(),
      onPlayerDamage: (amount) => this.applyFragSplashToPlayer(amount),
      onThrow: () => {
        // Arm only — syncMissionHud owns the shared interact slot, so a direct
        // showInteract here is overwritten the same tick by wave/jammer/null.
        this.fragToastTimer = 2.4;
      },
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
        onRestart: () => this.restartMission(true),
        onReturnToMenu: () => this.returnToMainMenu(),
      },
      this.app,
    );
    this.menu.setLoading(true);
    if (this.releaseMode) {
      this.setReleaseAssetGate('Validating the authored NIGHTGLASS asset package.');
    }

    this.renderer.applySceneQuality(this.renderer.scene, quality);
    this.renderer.applySceneQuality(this.renderer.viewModelScene, quality);

    this.player.attach(this.renderer.renderer.domElement);

    window.addEventListener('resize', this.onResize);
    document.addEventListener('pointerlockchange', this.onPointerLock);
    window.addEventListener('keydown', this.onKeyDown);
    window.addEventListener('blur', this.onWindowBlur);

    // Prevent context menu on canvas during ADS
    this.renderer.renderer.domElement.addEventListener('contextmenu', (e) =>
      e.preventDefault(),
    );

    this.syncPostSize();
    this.clock.start();
    this.physicsReady = this.initializePhysics();
    void this.physicsReady.finally(() => {
      if (this.lifecycle.is('loading')) this.setLifecycle('ready');
      this.menu.setLoading(false);
    });
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
    this.crosshairEnabled = settings.showCrosshair ?? true;
    this.hud.setCrosshairVisible(this.crosshairEnabled && !this.weapons.isADS());
    this.hud.setReducedMotion(settings.reducedMotion ?? false);
    this.applyGraphicsQuality(settings.graphicsTier ?? 'auto');
  }

  /**
   * Atomically applies a capability-capped tier across every visual subsystem.
   * This is deliberately owned by Game rather than distributed among UI and
   * loaders, so a settings change cannot leave quality subsystems disagreeing.
   */
  private applyGraphicsQuality(preference: QualityPreference): void {
    const preferenceChanged = preference !== this.qualityPreference;
    this.qualityPreference = preference;
    this.app.dataset.qualityPreference = preference;
    // Other settings share the same callback. Do not let a volume/FOV change
    // silently undo a runtime AUTO downgrade by reselecting the capability tier.
    if (!preferenceChanged && preference === 'auto') return;
    this.adaptiveQuality.reset();
    const next = selectQualityProfile(this.graphicsCapabilities, preference).profile;
    this.applyResolvedGraphicsQuality(next);
  }

  private applyResolvedGraphicsQuality(next: QualityProfile): void {
    // PLAY reapplies the menu settings. Avoid rebuilding post targets,
    // traversing every texture and touching CSM when AUTO already resolved to
    // the profile installed during bootstrap.
    if (qualityProfilesEqual(next, this.quality)) {
      this.app.dataset.qualityTier = next.tier;
      return;
    }
    const csmChanged = next.shadowCascades !== this.quality.shadowCascades
      || next.shadowDistance !== this.quality.shadowDistance
      || next.shadowMapSize !== this.quality.shadowMapSize;
    this.quality = next;
    this.app.dataset.qualityTier = next.tier;
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
    initializeCsmHelper(helper);
    return helper;
  }

  private recreateCSM(profile: QualityProfile): void {
    const helperVisible = this.csmHelper.visible;
    disposeCsm(this.csm, this.csmHelper);
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

  private setLifecycle(state: Parameters<GameLifecycle['transition']>[0]): void {
    this.lifecycle.transition(state);
    this.app.dataset.gameState = state;
  }

  private pauseGame(showMenu = true): void {
    if (!this.lifecycle.is('playing')) return;
    this.setLifecycle('paused');
    this.paused = true;
    this.player.beginInputSuspend();
    this.simulation.setPaused(true);
    this.hud.showControlPrompt(null);
    if (showMenu) {
      this.menu.setInSession(true);
      this.menu.show();
      this.hud.setVisible(false);
    }
  }

  private resumeGame(): void {
    if (!this.lifecycle.is('paused')) return;
    this.setLifecycle('playing');
    this.paused = false;
    this.player.endInputSuspend();
    this.simulation.setPaused(false);
    this.menu.hide();
    this.hud.setVisible(true);
    this.hud.showControlPrompt(null);
    this.showControlsIntro();
  }

  private showControlsIntro(): void {
    if (this.mission.getElapsed() > 0.2) return;
    if (this.controlsIntroTimer !== undefined) window.clearTimeout(this.controlsIntroTimer);
    this.hud.showControlPrompt('WASD MOVE  //  RMB AIM  //  LMB FIRE  //  E/F INTERACT');
    this.controlsIntroTimer = window.setTimeout(() => {
      this.controlsIntroTimer = undefined;
      if (this.pointerLockAcquired) this.hud.showControlPrompt(null);
    }, 5200);
  }

  private armPointerPrompt(): void {
    if (this.pointerPromptTimer !== undefined) window.clearTimeout(this.pointerPromptTimer);
    this.pointerPromptTimer = window.setTimeout(() => {
      this.pointerPromptTimer = undefined;
      if (this.playing && !this.pointerLockAcquired && this.menu.isVisible() === false) {
        this.hud.showControlPrompt('CLICK THE GAME TO CAPTURE THE MOUSE');
      }
    }, 450);
  }

  private restartMission(requestLock: boolean): void {
    if (this.lifecycle.is('loading')) return;
    this.resetRunToOpening();
    this.hud.clearMissionResult();
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
    this.hud.clearCheckpoint();
    this.hud.clearDamage();
    this.post.setDamageIntensity(0);
    this.playing = true;
    this.paused = false;
    this.menu.setInSession(true);
    this.menu.hide();
    this.hud.setVisible(true);
    if (!this.lifecycle.is('playing')) this.setLifecycle('playing');
    this.syncMissionHud();
    this.syncAmmoHud();
    if (requestLock) this.player.requestPointerLock(this.renderer.renderer.domElement);
    if (!this.pointerLockAcquired) {
      this.pauseGame(false);
      this.armPointerPrompt();
    } else {
      this.showControlsIntro();
    }
  }

  private returnToMainMenu(): void {
    if (document.pointerLockElement) document.exitPointerLock();
    if (!this.lifecycle.is('ready')) this.setLifecycle('ready');
    this.playing = false;
    this.paused = false;
    this.pointerLockAcquired = false;
    this.player.beginInputSuspend();
    this.player.clearInput();
    this.resetRunToOpening();
    this.hud.clearMissionResult();
    this.hud.showControlPrompt(null);
    this.hud.setVisible(false);
    this.menu.setInSession(false);
    this.menu.show();
    this.post.setCamera(this.renderer.camera);
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
      this.hud.clearCheckpoint();
      this.post.setDamageIntensity(0);
      this.hud.clearDamage();
    }
    // AudioContext.resume() is allowed to remain pending indefinitely when a
    // browser or embedded webview declines autoplay activation. Sound is an
    // enhancement, not a launch gate: the gesture listener will keep trying,
    // while physics and gameplay are allowed to start immediately.
    void this.audio.unlock();
    // Rapier bind (or explicit init failure → AABB fallback) must settle before
    // play so movement never swaps AABB→Rapier authority mid-run.
    await this.physicsReady;
    if (this.lifecycle.is('loading')) this.setLifecycle('ready');
    this.menu.hide();
    this.hud.setVisible(true);
    this.playing = true;
    this.paused = false;
    if (!this.lifecycle.is('playing')) this.setLifecycle('playing');
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
    if (!this.pointerLockAcquired) {
      this.pauseGame(false);
      this.armPointerPrompt();
    } else {
      this.showControlsIntro();
    }
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
      playing: this.playing && this.lifecycle.acceptsCombat(),
      paused: this.paused,
      playerDead: this.player.isDead(),
      beat: this.mission.getBeat(),
      missionElapsed: this.mission.getElapsed(),
      openingProtectionSeconds: OPENING_DAMAGE_GRACE_SECONDS,
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
    if (this.lifecycle.is('playing')) this.setLifecycle('failed');
    this.deaths += 1;
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
      this.supplies = { ...checkpoint.supplies };
      // World/RNG rewind without the session clock leaves AI fork(tick) salts
      // on the post-death timeline — restore both clocks to the checkpoint epoch.
      this.restoreSimulationClock(checkpoint.tick);
      // Death delay still runs grenades/AI: an in-flight frag wipe (or wave
      // pulse) can leave lastAliveCount at 0, then restored hostiles falsely
      // toast a "new wave" — same latch rematch already applies.
      this.lastAliveCount = this.enemies.getAliveCount();
      this.waveToastTimer = 0;
      this.fragToastTimer = 0;
      // restoreState already clearInput'd then reapplied crouch/slide. A second
      // clearInput here would wipe slideTimer / sliding and stand you up vs the
      // jammer checkpoint pose — only resync physical holds that never got keyup.
    } else {
      this.resetRunToOpening(false);
      this.player.clearInput();
    }
    this.player.resyncHeldKeys(heldKeys);
    // Pause does not run CameraFeel; death delay can also freeze a slide dip.
    // Snap view impulses so the restored pose is not wearing the killing blow.
    this.cameraFeel.resetView(this.weapons.isADS());
    this.rewindCombatFx();
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
    if (this.pointerLockAcquired) {
      if (!this.lifecycle.is('playing')) this.setLifecycle('playing');
      this.paused = false;
    } else {
      if (!this.lifecycle.is('paused')) this.setLifecycle('paused');
      this.paused = true;
      this.armPointerPrompt();
    }
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

  /**
   * World-space combat FX is not in any snapshot. Pause and QA freeze the
   * pools, so rematch / death / session restore would keep the discarded
   * timeline's muzzle sparks, blood, blast cloud, and ~45s bullet holes.
   */
  private rewindCombatFx(): void {
    this.vfx.clearCombat();
    this.decals.clear();
  }

  /** Full clean start: mission, combatants, and loadout match a fresh run. */
  private resetRunToOpening(resetRunStats = true): void {
    this.mission.reset();
    this.grenades.reset();
    this.weapons.reset();
    this.enemies.resetToInitial();
    // Rematch/early-death used to keep lastAliveCount at 0 after a wipe, so the
    // next spawn pulse falsely toasted a new wave. Latch the rebuilt roster.
    this.lastAliveCount = this.enemies.getAliveCount();
    this.waveToastTimer = 0;
    this.fragToastTimer = 0;
    this.runtimeCheckpoint = null;
    this.hostileKills = 0;
    if (resetRunStats) this.deaths = 0;
    this.supplies = { firstContact: false, intersection: false, defense: false };
    // Rebuild alone left the combat PRNG and session clock on the spent run —
    // rematch then polluted fork(tick) salts. Reset both to opening.
    this.simulationRandom.restore(this.simulationSeed);
    this.restoreSimulationClock(0);
    // Extract pause freezes CameraFeel; rematch would spawn in leftover ADS FOV
    // / slide dip / recoil punch from the spent run.
    this.cameraFeel.resetView(false);
    this.rewindCombatFx();
    this.player.revive(true);
    this.player.setPosition(
      this.level.playerSpawn.x,
      this.level.playerSpawn.y,
      this.level.playerSpawn.z,
    );
  }

  private syncAmmoHud(): void {
    const ammo = this.weapons.getAmmo();
    this.hud.setWeaponStatus(this.weapons.isReloading()
      ? 'RELOADING'
      : ammo && ammo.mag <= Math.max(1, Math.floor(ammo.magSize * 0.25))
        ? ammo.reserve > 0 ? '[R] RELOAD' : ammo.mag === 0 ? 'NO AMMO · [2] SIDEARM' : 'LOW AMMO'
        : '');
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
    if (document.pointerLockElement !== null) {
      // The menu requests lock during the user gesture, before async audio and
      // physics startup completes. Remember that acquisition even while the
      // game is not marked playing yet so a later Esc still pauses correctly.
      this.pointerLockAcquired = true;
      if (this.playing && this.lifecycle.is('paused') && !this.menu.isVisible()) {
        this.resumeGame();
      }
      return;
    }
    // A rejected initial request may emit pointerlockchange with a null
    // element. It is not a pause: keep gameplay running so the player can click
    // the canvas to retry instead of being trapped behind the menu forever.
    if (!this.playing || !this.pointerLockAcquired) return;
    this.pointerLockAcquired = false;
    if (!this.player.isDead()) {
      this.pauseGame(true);
    }
  };

  private onKeyDown = (e: KeyboardEvent): void => {
    if (e.code === 'Escape' && this.playing) {
      if (document.pointerLockElement) {
        document.exitPointerLock();
      } else if (this.lifecycle.is('playing')) {
        this.pauseGame(true);
      }
    }
  };

  private onWindowBlur = (): void => {
    if (this.playing && this.lifecycle.is('playing') && !this.player.isDead()) {
      this.pauseGame(true);
    }
  };

  private loop = (frameTimestamp = performance.now()): void => {
    this.animId = requestAnimationFrame(this.loop);
    // The title backdrop covers the world. Keep its idle camera alive at a
    // modest cadence while DOM controls remain responsive at display refresh.
    if (!this.playing && !this.qaFrozen && !this.releaseMode) {
      if (frameTimestamp - this.previousTitleRender < 1000 / 15) return;
      this.previousTitleRender = frameTimestamp;
    }
    const rawFrameMs = this.previousFrameTimestamp === null
      ? 0
      : frameTimestamp - this.previousFrameTimestamp;
    this.previousFrameTimestamp = frameTimestamp;
    const mainThreadStartedAt = performance.now();
    this.renderer.beginPerformanceFrame(frameTimestamp);
    const dt = this.clock.getDelta();

    let interpolationAlpha = 1;
    const activeGameplay = this.playing
      && this.lifecycle.canSimulate()
      && !this.paused
      && !this.menu.isVisible()
      && !this.qaFrozen;
    const qualityDecision = activeGameplay
      && this.qualityPreference === 'auto'
      && rawFrameMs > 0
      ? this.adaptiveQuality.sample(rawFrameMs, this.quality.tier)
      : null;
    if (activeGameplay && this.qualityPreference === 'auto') {
      this.frameTelemetryCountdown -= 1;
      if (this.frameTelemetryCountdown <= 0) {
        const pacing = this.adaptiveQuality.getTelemetry();
        this.app.dataset.frameMs = pacing.averageFrameMs.toFixed(2);
        this.app.dataset.slowFrameRatio = pacing.slowFrameRatio.toFixed(3);
        this.frameTelemetryCountdown = 60;
      }
    }
    if (activeGameplay) {
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
    if (qualityDecision) {
      const previousTier = this.quality.tier;
      const next = selectQualityProfile(
        this.graphicsCapabilities,
        qualityDecision.nextTier,
      ).profile;
      this.applyResolvedGraphicsQuality(next);
      this.app.dataset.autoQualityAdjusted = 'true';
      console.info(
        `[performance] AUTO reduced ${previousTier} → ${this.quality.tier} after sustained frame pressure`,
        qualityDecision,
      );
    }
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

      const alive = this.enemies.getAliveCount();
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
      hostilesAlive: this.enemies.getAliveCount(),
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
        this.shotOrigin.set(event.origin.x, event.origin.y, event.origin.z),
        this.shotDirection.set(event.direction.x, event.direction.y, event.direction.z),
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
    if (this.fragToastTimer > 0) this.fragToastTimer -= dt;
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
    // Reflex sights own the centre point while aiming; leaving the hip crosshair
    // active produced a white debug cross over the projected red dot.
    this.hud.setCrosshairVisible(this.crosshairEnabled && !this.weapons.isADS());
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
      encounter: {
        hostileKills: this.hostileKills,
        deaths: this.deaths,
        supplies: { ...this.supplies },
      },
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
    const encounter = snapshot.encounter as {
      hostileKills?: number;
      deaths?: number;
      supplies?: Partial<RunSupplies>;
    };
    this.hostileKills = Number(encounter.hostileKills ?? 0);
    this.deaths = Number(encounter.deaths ?? 0);
    this.supplies = {
      firstContact: encounter.supplies?.firstContact === true,
      intersection: encounter.supplies?.intersection === true,
      defense: encounter.supplies?.defense === true,
    };
    // Wipe→snapshot.restore left lastAliveCount at 0 while hostiles came back;
    // the next AI tick then falsely armed a "new wave" toast (death/rematch
    // already re-latch). Clear any in-flight toast too.
    this.lastAliveCount = this.enemies.getAliveCount();
    this.waveToastTimer = 0;
    this.fragToastTimer = 0;
    // hostileKills rewound with the snapshot — drop killfeed that belonged to
    // the pre-restore timeline (death/rematch/QA already clear). Hitmarker too.
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
    // Checkpoint toast is event-driven, not health-synced — a pre-rewind
    // "Jammer secured" would otherwise linger on the restored timeline.
    this.hud.clearCheckpoint();
    // Damage vignette/flash is set on hit, not health-synced. Presentation only
    // calls clearDamage when HP is nearly full, so a 20 HP hit would keep its
    // vignette after restoring 80 HP. Death/rematch/QA already clear this.
    this.post.setDamageIntensity(0);
    this.hud.clearDamage();
    this.cameraFeel.resetView(this.weapons.isADS());
    this.rewindCombatFx();
  }

  private handleSessionEvent(_event: GameEvent): void {
    // Typed events are already applied by their owning systems; this hook is
    // intentionally the single bridge for telemetry/replay consumers.
  }

  private handleMissionEvent(event: MissionEvent): void {
    if (event.type === 'encounter-complete') {
      if (event.beat === 'insertion') this.grantEncounterSupply('firstContact', 'CONTACT CLEARED');
      if (event.beat === 'intersection') this.grantEncounterSupply('intersection', 'INTERSECTION SECURED');
      if (event.beat === 'jammer') this.grantEncounterSupply('defense', 'DEFENSE CACHE ACQUIRED');
    } else if (event.type === 'checkpoint-saved') {
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
      if (this.lifecycle.is('playing')) this.setLifecycle('completed');
      if (document.pointerLockElement) document.exitPointerLock();
      this.hud.showMissionResult({
        kind: 'completed',
        title: 'Nightglass secured',
        subtitle: 'Extraction confirmed. Hostile signal network is offline.',
        action: 'Mission record saved for this session',
        elapsedSeconds: this.mission.getElapsed(),
        kills: this.hostileKills,
        deaths: this.deaths,
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
      supplies: { ...this.supplies },
    };
  }

  private grantEncounterSupply(key: keyof RunSupplies, label: string): void {
    if (this.supplies[key]) return;
    this.supplies[key] = true;
    const added = this.weapons.resupply({ ar: 36, pistol: 12 });
    this.player.heal(32);
    this.player.addArmor(18);
    this.hud.showCheckpoint(`${label} — +${added.ar + added.pistol} AMMO / MEDICAL`);
    this.audio.playUIClick();
    this.syncAmmoHud();
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
      const response = await fetch(assetUrl('assets/manifest.json'));
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
    this.lastAliveCount = this.enemies.getAliveCount();
    this.waveToastTimer = 0;
    this.fragToastTimer = 0;
    this.pendingSessionEvents.length = 0;
    this.post.setDamageIntensity(0);
    this.hud.clearDamage();
    this.hud.clearMissionResult();
    // Same combat-telemetry latch as death/rematch — capture baselines rewind
    // hostileKills, so leftover killfeed / hitmarker must not pollute QA.
    this.hud.clearKillfeed();
    this.hud.clearHitmarker();
    this.hud.clearCheckpoint();
    this.cameraFeel.resetView(this.weapons.isADS());
    this.rewindCombatFx();
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
    const position = this.player.getPositionRef();
    const target = state.beat === 'insertion'
      ? { x: 0, z: 6 }
      : state.beat === 'intersection'
        ? { x: 0, z: 17 }
        : state.beat === 'jammer' || state.beat === 'defense'
          ? { x: 0, z: 19 }
          : state.beat === 'extraction'
            ? { x: 0, z: 30 }
            : null;
    const distance = target
      ? Math.ceil(Math.hypot(position.x - target.x, position.z - target.z))
      : null;
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
      description: `${descriptions[state.beat]}${distance === null ? '' : `  //  ${distance} M`}`,
      status: state.beat === 'failed' ? 'failed' : state.beat === 'complete' ? 'completed' : 'active',
      progress: state.beat === 'insertion'
        ? Math.min(1, this.hostileKills / 2)
        : state.beat === 'intersection'
          ? Math.min(1, Math.max(0, this.hostileKills - 2) / 4)
          : state.beat === 'defense'
            ? 1 - state.defenseRemaining / 90
            : undefined,
      progressLabel: state.beat === 'insertion'
        ? `${Math.min(2, this.hostileKills)} / 2 HOSTILES`
        : state.beat === 'intersection'
          ? `${Math.min(4, Math.max(0, this.hostileKills - 2))} / 4 HOSTILES`
          : state.beat === 'defense'
            ? `${Math.ceil(state.defenseRemaining)} SEC`
            : undefined,
    });
    // Interact beats wave toast; toast keeps the slot while its timer runs.
    this.hud.showInteract(
      resolveMissionInteractPrompt({
        jammerInteractAvailable:
          state.beat === 'jammer' && this.canInteractWithJammer(),
        waveToastRemaining: this.waveToastTimer,
        fragToastRemaining: this.fragToastTimer,
        fragCount: this.grenades.getRemaining(),
      }),
    );
  }

  dispose(): void {
    cancelAnimationFrame(this.animId);
    window.removeEventListener('resize', this.onResize);
    document.removeEventListener('pointerlockchange', this.onPointerLock);
    window.removeEventListener('keydown', this.onKeyDown);
    window.removeEventListener('blur', this.onWindowBlur);
    if (this.pointerPromptTimer !== undefined) window.clearTimeout(this.pointerPromptTimer);
    if (this.controlsIntroTimer !== undefined) window.clearTimeout(this.controlsIntroTimer);
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
    disposeCsm(this.csm, this.csmHelper);
    this.lighting.dispose();
    this.environment.dispose();
    this.post.dispose();
    this.renderer.dispose();
    this.hud.dispose();
    this.menu.dispose();
    this.audio.dispose();
    this.clock.dispose();
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

function qualityProfilesEqual(a: QualityProfile, b: QualityProfile): boolean {
  return a.tier === b.tier
    && a.maxPixelRatio === b.maxPixelRatio
    && a.renderScale === b.renderScale
    && a.shadowMapSize === b.shadowMapSize
    && a.shadowCascades === b.shadowCascades
    && a.shadowDistance === b.shadowDistance
    && a.ambientOcclusion === b.ambientOcclusion
    && a.bloom === b.bloom
    && a.volumetricFog === b.volumetricFog
    && a.textureAnisotropy === b.textureAnisotropy
    && a.particleMultiplier === b.particleMultiplier
    && a.maxDynamicLights === b.maxDynamicLights
    && a.lodBias === b.lodBias;
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

if (import.meta.env.DEV || import.meta.env.VITE_ENABLE_QA === '1') {
window.__BLACKOPS__ = {
  start: async () => {
    if (!game['canLaunchRelease']()) {
      game['menu'].show();
      return;
    }
    // Audio unlock is deliberately best-effort: browsers may retain a
    // suspended AudioContext even after an automated or embedded gesture.
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
}

void game;
