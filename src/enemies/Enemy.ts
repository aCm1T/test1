import * as THREE from 'three';
import { SeededRandom } from '../mission';
import { RoundedBoxGeometry } from 'three/addons/geometries/RoundedBoxGeometry.js';
import { collapseStaticSubtrees, equivalentEdge, SurfaceFamily } from '../engine/StaticBatching';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export type EnemyTeam = 'hostile' | 'neutral';
export type HitPart = 'head' | 'torso' | 'arm' | 'leg' | 'generic';

export type EnemyState =
  | 'idle'
  | 'patrol'
  | 'alert'
  | 'search'
  | 'combat'
  | 'flank'
  | 'cover'
  | 'reload'
  | 'dead';

/** Mirrors `SquadRole` in the simulation layer without importing it. */
export type EnemyRole = 'assault' | 'flanker' | 'suppressor' | 'anchor';

/** Short radio-style barks a presentation layer can voice or subtitle. */
export type EnemyCallout =
  | 'contact'
  | 'flanking'
  | 'suppressing'
  | 'reloading'
  | 'taking-fire'
  | 'lost-visual';

export type EnemyLineOfSight = (
  origin: Readonly<THREE.Vector3>,
  target: Readonly<THREE.Vector3>,
  /** Present for combat samples; spawn gating may omit it. */
  enemy?: Enemy,
) => boolean;

/** True when a squadmate stands in the shot; the AI then holds fire instead. */
export type EnemyFireLaneTest = (
  enemy: Enemy,
  origin: Readonly<THREE.Vector3>,
  target: Readonly<THREE.Vector3>,
) => boolean;

export type EnemyDebugState = {
  state: EnemyState;
  role: EnemyRole;
  health: number;
  position: { x: number; y: number; z: number };
  hasVisual: boolean;
  lastSeenAge: number;
  lastKnownPlayerPosition: { x: number; y: number; z: number } | null;
  coverTarget: { x: number; y: number; z: number } | null;
  fireCooldown: number;
  shotsRemaining: number;
  reloadTimer: number;
  suppression: number;
  awareness: number;
  inCover: boolean;
  peeking: boolean;
};

export type EnemyRuntimeSnapshot = EnemyDebugState & {
  id: string;
  maxHealth: number;
  accuracy: number;
  fireInterval: number;
  rotationY: number;
  rotationQuaternion: { x: number; y: number; z: number; w: number };
  alive: boolean;
  velocity: { x: number; y: number; z: number };
  stateTimer: number;
  alertTimer: number;
  patrolTarget: { x: number; y: number; z: number };
  patrolSeed: number;
  collapseAmount: number;
  hitFlash: number;
  randomState: number | null;
  flankSide: number;
  flankTarget: { x: number; y: number; z: number } | null;
  searchTarget: { x: number; y: number; z: number } | null;
  searchSweeps: number;
  burstRemaining: number;
  burstPause: number;
  peekTimer: number;
  coverHoldTimer: number;
  repositionTimer: number;
  suppressiveBudget: number;
  threatYaw: number | null;
  /** Tick-scheduled LOS cache (determinism; not wall-clock). */
  losTick: number;
  losCachedClear: boolean;
  losHasSample: boolean;
  losTicksSinceSample: number;
  losBlockedPending: number;
  losDirty: boolean;
};

/** Movement and cover are injected so AI never owns a second collision model. */
export interface EnemyMovementAuthority {
  move(
    enemy: Enemy,
    desiredTarget: Readonly<THREE.Vector3>,
    dt: number,
    speed: number,
  ): THREE.Vector3 | null;
  release(enemy: Enemy): void;
  teleport?(enemy: Enemy, position: Readonly<THREE.Vector3>): void;
}

export type EnemyCoverAuthority = {
  reserve(enemy: Enemy): THREE.Vector3 | null;
  release(enemy: Enemy): void;
};

export type EnemyShootEvent = {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  damage: number;
  enemy: Enemy;
};

export type EnemyOptions = {
  id?: string;
  position?: THREE.Vector3;
  team?: EnemyTeam;
  health?: number;
  speed?: number;
  accuracy?: number;
  fireInterval?: number;
  engageRange?: number;
  coverNodes?: THREE.Vector3[];
  /** Deterministic random source. */
  random?: () => number;
  randomSource?: SeededRandom;
  lineOfSight?: EnemyLineOfSight;
  requestFireSlot?: (enemy: Enemy) => boolean;
  /** Squad-level check that stops hostiles shooting through each other. */
  isFireLaneBlocked?: EnemyFireLaneTest;
  facingYaw?: number;
  role?: EnemyRole;
  /** 0 shrugs suppression off instantly, 1 is fully pinned by near misses. */
  suppressionSensitivity?: number;
  onShoot?: (ev: EnemyShootEvent) => void;
  onCallout?: (callout: EnemyCallout, enemy: Enemy) => void;
  movementAuthority?: EnemyMovementAuthority | null;
  coverAuthority?: EnemyCoverAuthority | null;
};

const HEAD_MULT = 2.0;
const TORSO_MULT = 1.0;
const ARM_MULT = 0.65;
const LEG_MULT = 0.55;

const ENEMY_ANIMATION_ALIASES: Readonly<Record<EnemyState, readonly string[]>> = {
  idle: ['idle'],
  patrol: ['locomotion', 'walk', 'run'],
  alert: ['reaction', 'alert'],
  search: ['locomotion', 'walk'],
  combat: ['idle', 'combat'],
  flank: ['locomotion', 'run', 'walk'],
  cover: ['cover'],
  reload: ['reload'],
  dead: ['death', 'die'],
};

/** Magazine size shared by the shot budget and the reload cycle. */
const MAGAZINE_SIZE = 8;
/** Suppression drains this fast per second once rounds stop landing nearby. */
const SUPPRESSION_DECAY = 0.42;

const REQUIRED_ENEMY_ANIMATIONS: Readonly<Record<string, readonly string[]>> = {
  idle: ENEMY_ANIMATION_ALIASES.idle,
  locomotion: ENEMY_ANIMATION_ALIASES.patrol,
  reaction: ENEMY_ANIMATION_ALIASES.alert,
  firing: ['firing', 'fire', 'shoot'],
  reload: ENEMY_ANIMATION_ALIASES.reload,
  death: ENEMY_ANIMATION_ALIASES.dead,
  cover: ENEMY_ANIMATION_ALIASES.cover,
};

interface DevelopmentRipstopTextures {
  /** Source ownership stays with the development bootstrap, not Enemy. */
  source: THREE.Texture;
  /** The single view the shared soft-goods surface samples. */
  view: THREE.Texture;
}

/**
 * Development-only source state is kept separate from authored archetypes.
 * The bootstrap clears this state in release mode and owns the source image.
 */
let developmentRipstop: DevelopmentRipstopTextures | null = null;

/**
 * Neutral lift the soft-goods batches take while the development albedo is
 * installed. That source is charcoal, so without it the shared surface would
 * crush its weave to black; it is the average of the tints webbing and gloves
 * carried before the two shared one batch.
 */
const DEVELOPMENT_SOFT_GOODS_TINT = 0xc9d1c9;

/**
 * Every fallback material and generated texture is created once per process.
 * Hostiles differ only by their fatigue material, which damage response mutates.
 */
interface EnemyFallbackKit {
  body: THREE.MeshStandardMaterial;
  gear: THREE.MeshStandardMaterial;
  skin: THREE.MeshStandardMaterial;
  plate: THREE.MeshStandardMaterial;
  trouser: THREE.MeshStandardMaterial;
  glove: THREE.MeshStandardMaterial;
  webbing: THREE.MeshStandardMaterial;
  helmet: THREE.MeshStandardMaterial;
  lens: THREE.MeshStandardMaterial;
  weapon: THREE.MeshStandardMaterial;
  hardware: THREE.MeshStandardMaterial;
  trim: THREE.MeshStandardMaterial;
  cloth: THREE.MeshStandardMaterial;
  shadow: THREE.MeshBasicMaterial;
  textures: THREE.Texture[];
  /**
   * Shared surfaces the batcher merges the fallback's pieces into, hard goods
   * first so untextured trim joins them rather than the soft-goods weave.
   */
  families: readonly SurfaceFamily[];
  /** The soft-goods surface, whose albedo the optional development source replaces. */
  softGoods: SurfaceFamily;
  /** Generated soft-goods albedo, restored whenever that source is absent. */
  softGoodsAlbedo: THREE.Texture;
}

/**
 * Metres of viewing distance each metre of batch size is worth before the batch
 * stops being drawn. At 1080p with the game's vertical field of view, one metre
 * covers about 850 pixels at one metre out, so this retires a batch once its
 * largest piece falls to roughly two pixels — inside the texture filtering, and
 * behind the temporal antialiasing, well before it can pop.
 */
const ENEMY_LOD_SCALE = 425;
/** Corpses are not what the player is reading, so they thin out sooner. */
const ENEMY_DEAD_LOD_BIAS = 2.5;
/** Batches come back a little closer than they left, so thresholds cannot flicker. */
const ENEMY_LOD_HYSTERESIS = 0.9;
/** Equivalent cube edge under which a fallback piece counts as trim. */
const ENEMY_TRIM_EXTENT = 0.045;
/**
 * Distance past which only the seven articulated parts are drawn. A hostile
 * that far out is around forty pixels tall, so pouches, webbing and rail
 * hardware are inside the silhouette the parts already describe.
 */
const ENEMY_SILHOUETTE_DISTANCE = 26;
/**
 * Fixed-tick LOS amortisation. At 60 Hz, interval 5 ≈ 12 Hz for cold hostiles;
 * hot combat / close range / taking fire still refresh every tick.
 */
const LOS_REFRESH_TICKS = 5;
/** Consecutive blocked samples required to drop a cached clear (non-forced). */
const LOS_CLEAR_HYSTERESIS = 2;
/** Metres: inside this range LOS refreshes every fixed tick. */
const LOS_FORCE_RANGE = 12;

/** Equivalent cube edge under which a piece is dropped from the shadow pass. */
const ENEMY_SHADOW_EXTENT = 0.1;
/** Distance past which a hostile stops rendering into the shadow map at all. */
const ENEMY_SHADOW_DISTANCE = 34;
let sharedFallbackKit: EnemyFallbackKit | null = null;
let sharedFallbackTemplate: THREE.Group | null = null;

function fallbackKit(): EnemyFallbackKit {
  if (!sharedFallbackKit) {
    sharedFallbackKit = createFallbackKit();
    applyDevelopmentRipstopToKit();
  }
  return sharedFallbackKit;
}

function fallbackTemplate(): THREE.Group {
  if (!sharedFallbackTemplate) sharedFallbackTemplate = buildFallbackTemplate(fallbackKit());
  return sharedFallbackTemplate;
}

/**
 * Retargets the shared soft-goods surface, which webbing and gloves both merge
 * into and which is the only fallback surface the optional development albedo
 * replaces. The kit is shared, so this runs once per install rather than once
 * per hostile, and authored characters are untouched either way.
 */
function applyDevelopmentRipstopToKit(): void {
  const kit = sharedFallbackKit;
  if (!kit) return;
  const ripstop = developmentRipstop;
  kit.softGoods.setAlbedo(ripstop ? ripstop.view : kit.softGoodsAlbedo);
  kit.softGoods.setTint(ripstop ? DEVELOPMENT_SOFT_GOODS_TINT : 0xffffff);
}

/**
 * Procedural low-poly soldier with simple combat AI:
 * patrol → alert → combat / take cover → shoot → death collapse.
 */
export class Enemy {
  readonly id: string;
  readonly mesh: THREE.Group;
  /** Presentation-only crumple root; simulation pose stays on `mesh`. */
  private readonly visualRoot: THREE.Group;
  readonly team: EnemyTeam;

  health: number;
  readonly maxHealth: number;
  state: EnemyState = 'idle';
  alive = true;

  /** Callback fired when the AI takes a shot. */
  onShoot: ((ev: EnemyShootEvent) => void) | null = null;
  onCallout: ((callout: EnemyCallout, enemy: Enemy) => void) | null = null;

  private readonly speed: number;
  private readonly accuracy: number;
  private readonly fireInterval: number;
  private readonly engageRange: number;
  private readonly suppressionSensitivity: number;
  private readonly random: () => number;
  private readonly randomSource: SeededRandom | null;
  private lineOfSight: EnemyLineOfSight | null;
  private readonly requestFireSlot: ((enemy: Enemy) => boolean) | null;
  private isFireLaneBlocked: EnemyFireLaneTest | null;
  private coverNodes: THREE.Vector3[];

  private role: EnemyRole;
  private flankSide: -1 | 1 = 1;
  private flankTarget: THREE.Vector3 | null = null;
  private searchTarget: THREE.Vector3 | null = null;
  private searchSweeps = 0;
  private suppression = 0;
  private awareness = 0;
  private burstRemaining: number;
  private burstPause = 0;
  private peekTimer = 0;
  private peeking = true;
  private inCover = false;
  private coverHoldTimer = 0;
  private repositionTimer = 0;
  private suppressiveBudget = 0;
  private threatYaw: number | null = null;

  private readonly velocity = new THREE.Vector3();
  private readonly previousSimulationPosition = new THREE.Vector3();
  private readonly simulationPosition = new THREE.Vector3();
  private readonly previousSimulationQuaternion = new THREE.Quaternion();
  private readonly simulationQuaternion = new THREE.Quaternion();
  private readonly aimDir = new THREE.Vector3(0, 0, 1);
  private readonly _tmp = new THREE.Vector3();
  private readonly _tmp2 = new THREE.Vector3();
  private readonly _tmp3 = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();
  private readonly _focus = new THREE.Vector3();
  private readonly _targetEye = new THREE.Vector3();

  private fireCooldown = 0;
  private shotsRemaining = MAGAZINE_SIZE;
  private reloadTimer = 0;
  private stateTimer = 0;
  private alertTimer = 0;
  private patrolTarget = new THREE.Vector3();
  private coverTarget: THREE.Vector3 | null = null;
  private movementAuthority: EnemyMovementAuthority | null;
  private coverAuthority: EnemyCoverAuthority | null;
  private collapseAmount = 0;
  private hitFlash = 0;
  private patrolSeed: number;
  private readonly lastKnownPlayerPosition = new THREE.Vector3();
  private hasLastKnownPosition = false;
  private hasVisual = false;
  /** Monotonic fixed-step counter for LOS refresh scheduling. */
  private losTick = 0;
  private losCachedClear = true;
  private losHasSample = false;
  private losTicksSinceSample = 0;
  private losBlockedPending = 0;
  /** Set by hits / suppression so the next AI step re-queries immediately. */
  private losDirty = false;
  private readonly losPhase: number;
  private lastSeenAge = Infinity;

  private readonly parts: {
    head: THREE.Mesh;
    torso: THREE.Mesh;
    leftArm: THREE.Mesh;
    rightArm: THREE.Mesh;
    leftLeg: THREE.Mesh;
    rightLeg: THREE.Mesh;
    weapon: THREE.Mesh;
  };

  /**
   * Pouches, buckles, rail lugs and similar small hardware are merged into
   * their own batches so they can be dropped once a hostile is far enough away
   * for them to be sub-pixel. Only visibility changes; the simulation never
   * sees this.
   */
  private readonly detailMeshes: Array<{ mesh: THREE.Mesh; range: number }> = [];
  /** Number of leading entries in `detailMeshes` currently drawn. */
  private detailDrawn = -1;
  /**
   * Every batch that reaches the shadow map. A hostile far enough away casts a
   * shadow only a few pixels across, so past that range the whole silhouette
   * leaves the depth pass rather than doubling its own draw cost.
   */
  private readonly casterMeshes: THREE.Mesh[] = [];
  private castersEnabled = true;
  private detailBias = 1;
  /**
   * Quality-tier LOD bias from `QualityProfile.lodBias`. Positive values treat
   * the hostile as further away so Low/Medium drop merged dressing earlier;
   * negative values keep dressing longer on Ultra. Presentation only.
   */
  private lodBias = 0;
  /** Only this hostile's fatigue material is mutable (hit flash, death fade). */
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private authoredRoot: THREE.Object3D | null = null;
  private authoredMixer: THREE.AnimationMixer | null = null;
  private readonly authoredActions = new Map<string, THREE.AnimationAction>();
  private authoredAction: THREE.AnimationAction | null = null;
  private authoredOneShotTimer = 0;

  constructor(options: EnemyOptions = {}) {
    this.id = options.id ?? 'enemy-unassigned';
    this.team = options.team ?? 'hostile';
    this.maxHealth = options.health ?? 100;
    this.health = this.maxHealth;
    this.speed = options.speed ?? 3.4;
    this.accuracy = options.accuracy ?? 0.72;
    this.fireInterval = options.fireInterval ?? 0.85;
    this.engageRange = options.engageRange ?? 38;
    const fallbackRandom = new SeededRandom(0x454e454d);
    this.randomSource = options.randomSource ?? (options.random ? null : fallbackRandom);
    this.random = options.random ?? (() => this.randomSource!.next());
    this.lineOfSight = options.lineOfSight ?? null;
    this.requestFireSlot = options.requestFireSlot ?? null;
    this.isFireLaneBlocked = options.isFireLaneBlocked ?? null;
    this.coverNodes = options.coverNodes ? options.coverNodes.map((c) => c.clone()) : [];
    this.onShoot = options.onShoot ?? null;
    this.onCallout = options.onCallout ?? null;
    this.movementAuthority = options.movementAuthority ?? null;
    this.coverAuthority = options.coverAuthority ?? null;
    this.role = options.role ?? 'assault';
    this.suppressionSensitivity = THREE.MathUtils.clamp(
      options.suppressionSensitivity ?? 1,
      0,
      1,
    );
    this.patrolSeed = this.random() * 1000;
    this.burstRemaining = this.rollBurstSize();
    this.losPhase = losRefreshPhase(this.id);

    // Every other fallback material and texture is shared process-wide; only
    // the fatigue material is per-hostile because damage response mutates it.
    this.bodyMat = fallbackKit().body.clone();

    this.mesh = new THREE.Group();
    this.mesh.name = 'EnemySoldier';
    this.mesh.castShadow = true;
    this.visualRoot = new THREE.Group();
    this.visualRoot.name = 'EnemyVisual';
    this.mesh.add(this.visualRoot);
    this.parts = this.buildMesh();
    for (const child of this.visualRoot.children) child.userData.proceduralFallback = true;
    this.tagParts();

    const spawn = options.position ?? new THREE.Vector3();
    this.mesh.position.copy(spawn);
    this.mesh.rotation.y = options.facingYaw ?? 0;
    this.previousSimulationPosition.copy(this.mesh.position);
    this.simulationPosition.copy(this.mesh.position);
    this.previousSimulationQuaternion.copy(this.mesh.quaternion);
    this.simulationQuaternion.copy(this.mesh.quaternion);
    this.aimDir.set(
      Math.sin(this.mesh.rotation.y),
      0,
      Math.cos(this.mesh.rotation.y),
    );
    this.pickPatrolTarget();
    this.state = 'patrol';
  }

  /**
   * Installs a clone for the shared procedural soft-goods surface only, which
   * webbing and gloves are the sole members of. Authored GLTF materials remain
   * outside this registry and are never changed. Tiling comes from the merged
   * geometry rather than the texture, so the clone is left untransformed.
   */
  static installDevelopmentRipstop(source: THREE.Texture, maxAnisotropy = 8): void {
    if (developmentRipstop?.source === source) {
      applyDevelopmentRipstopToKit();
      return;
    }
    Enemy.clearDevelopmentRipstop();

    const view = source.clone();
    view.name = 'DevelopmentFallbackEnemySoftGoodsRipstop';
    view.colorSpace = THREE.SRGBColorSpace;
    view.wrapS = THREE.RepeatWrapping;
    view.wrapT = THREE.RepeatWrapping;
    view.repeat.set(1, 1);
    view.magFilter = THREE.LinearFilter;
    view.minFilter = THREE.LinearMipmapLinearFilter;
    view.generateMipmaps = true;
    view.anisotropy = Math.max(1, Math.min(8, Math.floor(maxAnisotropy)));
    view.needsUpdate = true;

    developmentRipstop = { source, view };
    applyDevelopmentRipstopToKit();
  }

  /** Releases shared fallback clones without disposing the bootstrap-owned source. */
  static clearDevelopmentRipstop(): void {
    const current = developmentRipstop;
    developmentRipstop = null;
    applyDevelopmentRipstopToKit();
    current?.view.dispose();
  }

  get position(): THREE.Vector3 {
    return this.simulationPosition;
  }

  /** Smooths only the visible transform; all AI and combat keep current tick state. */
  applyRenderInterpolation(alpha: number): void {
    const t = THREE.MathUtils.clamp(alpha, 0, 1);
    this.mesh.position.lerpVectors(
      this.previousSimulationPosition,
      this.simulationPosition,
      t,
    );
    this.mesh.quaternion.slerpQuaternions(
      this.previousSimulationQuaternion,
      this.simulationQuaternion,
      t,
    );
  }

  teleport(position: Readonly<THREE.Vector3>): void {
    this.mesh.position.copy(position);
    this.previousSimulationPosition.copy(position);
    this.simulationPosition.copy(position);
    this.previousSimulationQuaternion.copy(this.mesh.quaternion);
    this.simulationQuaternion.copy(this.mesh.quaternion);
    this.movementAuthority?.teleport?.(this, position);
  }

  faceTarget(target: Readonly<THREE.Vector3>): void {
    this.mesh.lookAt(target);
    this.previousSimulationQuaternion.copy(this.mesh.quaternion);
    this.simulationQuaternion.copy(this.mesh.quaternion);
  }

  installAuthoredVisual(gltf: GLTF): void {
    if (!hasSkinnedMesh(gltf.scene)) {
      throw new Error('authored hostile must contain a rigged SkinnedMesh');
    }
    const missingClips = missingAnimationRoles(gltf, REQUIRED_ENEMY_ANIMATIONS);
    if (missingClips.length > 0) {
      throw new Error(`authored hostile is missing clips: ${missingClips.join(', ')}`);
    }
    const visual = cloneSkinned(gltf.scene);
    this.removeAuthoredVisual();
    for (const child of this.visualRoot.children) child.visible = false;
    visual.name = `AuthoredHostile:${this.id}`;
    visual.traverse((node) => {
      node.castShadow = true;
      node.receiveShadow = true;
      node.userData.enemy = this;
      node.userData.hitPart ??= 'generic';
    });
    this.visualRoot.add(visual);
    this.authoredRoot = visual;
    this.authoredMixer = new THREE.AnimationMixer(visual);
    for (const clip of gltf.animations) {
      this.authoredActions.set(clip.name.toLowerCase(), this.authoredMixer.clipAction(clip));
    }
    this.updateAuthoredAnimation();
  }

  hasAuthoredVisual(): boolean {
    return this.authoredRoot !== null;
  }

  clearAuthoredVisual(): void {
    this.removeAuthoredVisual();
  }

  setCoverNodes(nodes: THREE.Vector3[]): void {
    this.coverNodes = nodes.map((n) => n.clone());
  }

  setLineOfSight(lineOfSight: EnemyLineOfSight | null): void {
    this.lineOfSight = lineOfSight;
    this.losHasSample = false;
    this.losTicksSinceSample = 0;
    this.losBlockedPending = 0;
    this.losDirty = true;
  }

  setMovementAuthority(authority: EnemyMovementAuthority | null): void {
    this.movementAuthority = authority;
  }

  setCoverAuthority(authority: EnemyCoverAuthority | null): void {
    this.coverAuthority = authority;
  }

  setFireLaneTest(test: EnemyFireLaneTest | null): void {
    this.isFireLaneBlocked = test;
  }

  getRole(): EnemyRole {
    return this.role;
  }

  /**
   * Squad roles are re-planned while a fight runs. A hostile that is asked to
   * work around the player drops its cover claim and picks a lateral route; one
   * pulled back to holding fire keeps the position it already occupies.
   */
  setRole(role: EnemyRole, side: -1 | 1 = this.flankSide): void {
    this.flankSide = side;
    if (this.role === role) return;
    this.role = role;
    this.burstRemaining = Math.min(this.burstRemaining, this.rollBurstSize());
    if (role !== 'flanker') {
      this.flankTarget = null;
      if (this.state === 'flank') this.state = 'combat';
      return;
    }
    if (this.state === 'combat' || this.state === 'cover') {
      this.releaseCover();
      this.flankTarget = null;
    }
  }

  getFlankSide(): -1 | 1 {
    return this.flankSide;
  }

  setFlankTarget(target: Readonly<THREE.Vector3> | null): void {
    this.flankTarget = target
      ? new THREE.Vector3(target.x, target.y, target.z)
      : null;
  }

  getFlankTarget(): THREE.Vector3 | null {
    return this.flankTarget ? this.flankTarget.clone() : null;
  }

  getSuppression(): number {
    return this.suppression;
  }

  hasVisualContact(): boolean {
    return this.hasVisual;
  }

  isSuppressed(): boolean {
    return this.suppression >= 0.55;
  }

  isInCover(): boolean {
    return this.inCover;
  }

  getAwareness(): number {
    return this.awareness;
  }

  getLastKnownPlayerPosition(out = new THREE.Vector3()): THREE.Vector3 | null {
    return this.hasLastKnownPosition ? out.copy(this.lastKnownPlayerPosition) : null;
  }

  getLastSeenAge(): number {
    return this.lastSeenAge;
  }

  /**
   * Near misses and impacts pin the AI: accuracy drops, bursts get shorter and
   * more hesitant, and a pinned hostile prefers hard cover over pushing.
   */
  applySuppression(amount: number, source?: Readonly<THREE.Vector3>): void {
    if (!this.alive || amount <= 0) return;
    const scaled = amount * this.suppressionSensitivity;
    if (scaled <= 0) return;
    const before = this.suppression;
    this.suppression = Math.min(1, this.suppression + scaled);
    if (source) this.noteThreatDirection(source);
    this.losDirty = true;
    // Being shot at is also information: it wakes an unaware hostile up.
    this.awareness = Math.min(1, this.awareness + scaled * 0.9);
    if (this.state === 'idle' || this.state === 'patrol') {
      this.state = 'alert';
      this.alertTimer = 0.25 + this.random() * 0.2;
      this.stateTimer = 0;
      this.emitCallout('taking-fire');
    } else if (before < 0.55 && this.suppression >= 0.55) {
      this.emitCallout('taking-fire');
      // Interrupt a push the moment the volume of fire becomes dangerous.
      if (this.state === 'combat' || this.state === 'flank') {
        this.seekCover();
        if (this.coverTarget) this.enterCoverRun();
      }
    }
  }

  /**
   * Squad radio: a teammate's sighting is shared as a last-known position. It
   * never grants line of sight, so the hostile still has to look and confirm.
   */
  notifyContact(position: Readonly<THREE.Vector3>, confidence = 0.7): void {
    if (!this.alive || this.state === 'dead') return;
    const gain = THREE.MathUtils.clamp(confidence, 0, 1);
    if (this.hasVisual) return;
    if (this.hasLastKnownPosition && this.lastSeenAge < 0.75) return;
    this.lastKnownPlayerPosition.copy(position);
    this.hasLastKnownPosition = true;
    this.lastSeenAge = Math.min(this.lastSeenAge, 1.2);
    this.awareness = Math.min(1, this.awareness + gain * 0.6);
    this.noteThreatDirection(position);
    if (this.state === 'idle' || this.state === 'patrol') {
      this.state = 'alert';
      this.alertTimer = 0.3 + this.random() * 0.45;
      this.stateTimer = 0;
    } else if (this.state === 'search') {
      // Re-vector an existing sweep onto the fresher call.
      this.searchTarget = null;
      this.searchSweeps = 0;
    }
  }

  /**
   * Apply damage to a body part. Returns remaining health.
   * Headshots and limb hits use different multipliers.
   */
  hit(damage: number, part: HitPart = 'generic'): number {
    if (!this.alive) return 0;

    let mult = TORSO_MULT;
    if (part === 'head') mult = HEAD_MULT;
    else if (part === 'arm') mult = ARM_MULT;
    else if (part === 'leg') mult = LEG_MULT;
    else if (part === 'torso') mult = TORSO_MULT;

    this.health = Math.max(0, this.health - damage * mult);
    this.hitFlash = 0.18;
    this.losDirty = true;

    if (this.state === 'idle' || this.state === 'patrol') {
      this.state = 'alert';
      this.alertTimer = 0.6;
    } else if (this.state === 'alert') {
      this.state = 'combat';
    }
    // A round on target is the strongest suppression signal there is.
    if (this.health > 0) this.applySuppression(0.5);

    // Seek cover when wounded
    if (this.alive && this.health < this.maxHealth * 0.45 && this.state !== 'cover' && this.state !== 'dead') {
      this.seekCover();
      if (this.coverTarget) this.enterCoverRun();
    }

    if (this.health <= 0) {
      this.kill();
    } else {
      this.playAuthoredClip(['reaction', 'hit'], true);
    }
    return this.health;
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.state = 'dead';
    this.collapseAmount = 0;
    this.velocity.set(0, 0, 0);
    this.coverAuthority?.release(this);
    this.movementAuthority?.release(this);
    this.playAuthoredClip(['death', 'die'], true);
  }

  /**
   * Per-frame AI + animation.
   * @param dt seconds
   * @param playerPos player world position (feet or torso)
   * @param scene optional scene for los helpers (reserved)
   */
  update(dt: number, playerPos: THREE.Vector3, _scene?: THREE.Scene): void {
    this.beginSimulationStep();
    this.updateTrimVisibility(playerPos);
    if (this.state === 'dead') {
      this.updateDeath(dt);
      this.authoredMixer?.update(dt);
      this.endSimulationStep();
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.burstPause = Math.max(0, this.burstPause - dt);
    this.authoredOneShotTimer = Math.max(0, this.authoredOneShotTimer - dt);
    this.stateTimer += dt;
    this.repositionTimer += dt;
    this.suppression = Math.max(0, this.suppression - SUPPRESSION_DECAY * dt);
    if (this.hitFlash > 0) {
      this.hitFlash = Math.max(0, this.hitFlash - dt);
      const flash = this.hitFlash > 0;
      this.bodyMat.emissive.setHex(flash ? 0x441010 : BODY_RIM_EMISSIVE);
      this.bodyMat.emissiveIntensity = flash ? 0.6 : BODY_RIM_INTENSITY;
    }

    const toPlayer = this._tmp.copy(playerPos).sub(this.mesh.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    this._targetEye.copy(playerPos).addScaledVector(THREE.Object3D.DEFAULT_UP, 1.35);
    const eye = this.getAimPoint(this._tmp2);
    const targetDir = this._look.copy(this._targetEye).sub(eye).normalize();
    // A narrow focal cone plus a wide "something moved" cone means a player who
    // stays outside a hostile's attention is only spotted once they get close.
    const focus = this.aimDir.dot(targetDir);
    const alerted = this.state !== 'idle' && this.state !== 'patrol';
    const fovThreshold = alerted ? 0.24 : 0.42;
    const insideFov = focus > fovThreshold || dist < (alerted ? 9 : 7);
    const losClear = this.resolveLineOfSight(eye, this._targetEye, dist);
    const hadVisual = this.hasVisual;
    this.hasVisual = dist < this.engageRange && insideFov && losClear;
    if (this.hasVisual) {
      this.lastKnownPlayerPosition.copy(playerPos);
      this.hasLastKnownPosition = true;
      this.lastSeenAge = 0;
      this.awareness = Math.min(1, this.awareness + dt * 3.2);
      this.suppressiveBudget = 4;
      this.threatYaw = null;
      if (!hadVisual && !alerted) this.emitCallout('contact');
    } else {
      this.lastSeenAge += dt;
      this.awareness = Math.max(0, this.awareness - dt * 0.12);
      if (hadVisual) this.emitCallout('lost-visual');
    }

    switch (this.state) {
      case 'idle':
        if (this.hasVisual && dist < this.engageRange * 0.7) {
          this.state = 'alert';
          this.alertTimer = this.rollReactionTime(dist);
        } else if (this.stateTimer > 2) {
          this.state = 'patrol';
          this.pickPatrolTarget();
        }
        break;

      case 'patrol':
        this.moveToward(this.patrolTarget, dt, this.speed * 0.55);
        this.faceToward(this.patrolTarget, dt, 4);
        if (this.mesh.position.distanceTo(this.patrolTarget) < 1.2) {
          this.pickPatrolTarget();
        }
        if (this.hasVisual) {
          this.state = 'alert';
          this.alertTimer = this.rollReactionTime(dist);
          this.emitCallout('contact');
        }
        break;

      case 'alert':
        this.faceToward(this.hasVisual ? playerPos : this.lastKnownPlayerPosition, dt, 8);
        // Floored at zero so a checkpoint round-trips to the same tick exactly.
        this.alertTimer = Math.max(0, this.alertTimer - dt);
        if (this.alertTimer <= 0) this.commitToEngagement(dist, playerPos);
        break;

      case 'search':
        this.updateSearch(dt, playerPos);
        break;

      case 'flank':
        this.updateFlank(dt, playerPos, dist);
        break;

      case 'cover':
        this.updateCover(dt, playerPos, dist);
        break;

      case 'combat':
        this.updateCombat(dt, playerPos, dist);
        break;

      case 'reload':
        // Reloading is the moment the AI is most exposed, so it ducks first.
        if (!this.inCover && this.suppression > 0.35 && !this.coverTarget) {
          this.seekCover();
          if (this.coverTarget) this.enterCoverRun();
        }
        this.faceToward(this.hasVisual ? playerPos : this.lastKnownPlayerPosition, dt, 6);
        this.reloadTimer = Math.max(0, this.reloadTimer - dt);
        if (this.reloadTimer <= 0) {
          this.shotsRemaining = MAGAZINE_SIZE;
          this.burstRemaining = this.rollBurstSize();
          this.burstPause = 0;
          this.state = this.hasVisual ? 'combat' : 'search';
          this.stateTimer = 0;
        }
        break;
    }

    this.animateLocomotion(dt);
    this.updateAuthoredAnimation();
    this.authoredMixer?.update(dt);
    this.endSimulationStep();
  }

  dispose(): void {
    this.removeAuthoredVisual();
    // Fallback geometry, textures, and every other material are shared by all
    // hostiles, so only the per-hostile fatigue material is released here.
    this.bodyMat.dispose();
    this.detailMeshes.length = 0;
    this.casterMeshes.length = 0;
    this.mesh.clear();
    this.mesh.removeFromParent();
  }

  /** World-space aim point (approx chest). */
  getAimPoint(out = new THREE.Vector3()): THREE.Vector3 {
    const p = this.mesh.position;
    return out.set(p.x, p.y + 1.35, p.z);
  }

  getDebugState(): EnemyDebugState {
    const vector = (v: THREE.Vector3) => ({ x: v.x, y: v.y, z: v.z });
    return {
      state: this.state,
      role: this.role,
      health: this.health,
      position: vector(this.simulationPosition),
      hasVisual: this.hasVisual,
      lastSeenAge: this.lastSeenAge,
      lastKnownPlayerPosition: this.hasLastKnownPosition
        ? vector(this.lastKnownPlayerPosition)
        : null,
      coverTarget: this.coverTarget ? vector(this.coverTarget) : null,
      fireCooldown: this.fireCooldown,
      shotsRemaining: this.shotsRemaining,
      reloadTimer: this.reloadTimer,
      suppression: this.suppression,
      awareness: this.awareness,
      inCover: this.inCover,
      peeking: this.peeking,
    };
  }

  snapshotState(): EnemyRuntimeSnapshot {
    const rotation = new THREE.Euler().setFromQuaternion(
      this.simulationQuaternion,
      this.mesh.rotation.order,
    );
    return {
      ...this.getDebugState(),
      id: this.id,
      maxHealth: this.maxHealth,
      accuracy: this.accuracy,
      fireInterval: this.fireInterval,
      rotationY: rotation.y,
      rotationQuaternion: {
        x: this.simulationQuaternion.x,
        y: this.simulationQuaternion.y,
        z: this.simulationQuaternion.z,
        w: this.simulationQuaternion.w,
      },
      alive: this.alive,
      velocity: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
      stateTimer: this.stateTimer,
      alertTimer: this.alertTimer,
      patrolTarget: { x: this.patrolTarget.x, y: this.patrolTarget.y, z: this.patrolTarget.z },
      patrolSeed: this.patrolSeed,
      collapseAmount: this.collapseAmount,
      hitFlash: this.hitFlash,
      randomState: this.randomSource?.snapshot() ?? null,
      flankSide: this.flankSide,
      flankTarget: vectorOrNull(this.flankTarget),
      searchTarget: vectorOrNull(this.searchTarget),
      searchSweeps: this.searchSweeps,
      burstRemaining: this.burstRemaining,
      burstPause: this.burstPause,
      peekTimer: this.peekTimer,
      coverHoldTimer: this.coverHoldTimer,
      repositionTimer: this.repositionTimer,
      suppressiveBudget: this.suppressiveBudget,
      threatYaw: this.threatYaw,
      losTick: this.losTick,
      losCachedClear: this.losCachedClear,
      losHasSample: this.losHasSample,
      losTicksSinceSample: this.losTicksSinceSample,
      losBlockedPending: this.losBlockedPending,
      losDirty: this.losDirty,
    };
  }

  restoreState(snapshot: EnemyRuntimeSnapshot): void {
    this.mesh.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    this.mesh.quaternion.set(
      snapshot.rotationQuaternion.x,
      snapshot.rotationQuaternion.y,
      snapshot.rotationQuaternion.z,
      snapshot.rotationQuaternion.w,
    );
    this.health = Math.max(0, Math.min(this.maxHealth, snapshot.health));
    this.alive = snapshot.alive;
    this.state = snapshot.state;
    this.role = snapshot.role;
    this.hasVisual = snapshot.hasVisual;
    this.lastSeenAge = snapshot.lastSeenAge;
    this.suppression = THREE.MathUtils.clamp(snapshot.suppression, 0, 1);
    this.awareness = THREE.MathUtils.clamp(snapshot.awareness, 0, 1);
    this.inCover = snapshot.inCover;
    this.peeking = snapshot.peeking;
    this.flankSide = snapshot.flankSide < 0 ? -1 : 1;
    this.flankTarget = vectorFrom(snapshot.flankTarget);
    this.searchTarget = vectorFrom(snapshot.searchTarget);
    this.searchSweeps = Math.max(0, Math.floor(snapshot.searchSweeps));
    this.burstRemaining = Math.max(0, Math.floor(snapshot.burstRemaining));
    this.burstPause = Math.max(0, snapshot.burstPause);
    this.peekTimer = snapshot.peekTimer;
    this.coverHoldTimer = Math.max(0, snapshot.coverHoldTimer);
    this.repositionTimer = Math.max(0, snapshot.repositionTimer);
    this.suppressiveBudget = Math.max(0, Math.floor(snapshot.suppressiveBudget));
    this.threatYaw = snapshot.threatYaw;
    this.losTick = Math.max(0, Math.floor(snapshot.losTick));
    this.losCachedClear = snapshot.losCachedClear;
    this.losHasSample = snapshot.losHasSample;
    this.losTicksSinceSample = Math.max(0, Math.floor(snapshot.losTicksSinceSample));
    this.losBlockedPending = Math.max(0, Math.floor(snapshot.losBlockedPending));
    this.losDirty = snapshot.losDirty;
    this.fireCooldown = Math.max(0, snapshot.fireCooldown);
    this.shotsRemaining = Math.max(0, Math.floor(snapshot.shotsRemaining));
    this.reloadTimer = Math.max(0, snapshot.reloadTimer);
    this.velocity.set(snapshot.velocity.x, snapshot.velocity.y, snapshot.velocity.z);
    this.stateTimer = Math.max(0, snapshot.stateTimer);
    this.alertTimer = Math.max(0, snapshot.alertTimer);
    this.patrolTarget.set(snapshot.patrolTarget.x, snapshot.patrolTarget.y, snapshot.patrolTarget.z);
    this.patrolSeed = snapshot.patrolSeed;
    this.collapseAmount = Math.max(0, snapshot.collapseAmount);
    this.hitFlash = Math.max(0, snapshot.hitFlash);
    if (snapshot.randomState !== null) this.randomSource?.restore(snapshot.randomState);
    this.coverTarget = snapshot.coverTarget ? new THREE.Vector3(
      snapshot.coverTarget.x,
      snapshot.coverTarget.y,
      snapshot.coverTarget.z,
    ) : null;
    if (snapshot.lastKnownPlayerPosition) {
      this.lastKnownPlayerPosition.set(
        snapshot.lastKnownPlayerPosition.x,
        snapshot.lastKnownPlayerPosition.y,
        snapshot.lastKnownPlayerPosition.z,
      );
      this.hasLastKnownPosition = true;
    } else {
      this.hasLastKnownPosition = false;
    }
    if (!this.alive || this.state === 'dead') {
      this.alive = false;
      this.state = 'dead';
      const t = this.collapseAmount;
      this.visualRoot.rotation.x = THREE.MathUtils.lerp(0, Math.PI * 0.5, t * t);
      this.visualRoot.position.y = THREE.MathUtils.lerp(0, 0.15, t);
    } else {
      this.visualRoot.rotation.x = 0;
      this.visualRoot.position.y = 0;
    }
    this.aimDir.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
    this.previousSimulationPosition.copy(this.mesh.position);
    this.simulationPosition.copy(this.mesh.position);
    this.previousSimulationQuaternion.copy(this.mesh.quaternion);
    this.simulationQuaternion.copy(this.mesh.quaternion);
    // Rapier capsules stay put until the next moveCharacter unless we teleport;
    // resync so queries and the next step start on the restored mesh pose.
    if (this.alive) {
      this.movementAuthority?.teleport?.(this, this.mesh.position);
    } else {
      this.movementAuthority?.release(this);
    }
  }

  /** Resolve which body part a world ray hit (by mesh name / userData). */
  static partFromObject(obj: THREE.Object3D | null): HitPart {
    let o: THREE.Object3D | null = obj;
    while (o) {
      const part = o.userData?.hitPart as HitPart | undefined;
      if (part) return part;
      o = o.parent;
    }
    return 'generic';
  }

  // ── internals ────────────────────────────────────────────────────────

  /**
   * Presentation-only detail allowance from the squad's draw budget. A hostile
   * the manager has not granted full detail to is treated as if it were further
   * away, so it keeps its silhouette and loses only merged dressing.
   */
  setDetailBias(bias: number): void {
    this.detailBias = Math.max(1, bias);
  }

  /**
   * Presentation-only quality LOD bias. Matches EnvironmentAssembler's sign:
   * positive bias thins earlier (Low/Medium), negative keeps dressing longer.
   */
  setLodBias(bias: number): void {
    this.lodBias = Number.isFinite(bias) ? bias : 0;
  }

  /**
   * Retires merged batches as they stop being resolvable. `detailMeshes` is
   * ordered from the largest batch to the smallest, so the drawn set is always
   * a prefix and each step only touches the batches that actually changed.
   * This is presentation only: hit resolution, AI, and snapshot state never
   * read visibility.
   */
  private updateTrimVisibility(playerPos: THREE.Vector3): void {
    // 2^lodBias stretches effective distance the same way EnvironmentAssembler
    // shrinks switch distances — Low (1.35) and Medium (1) thin earlier.
    const distance = this.mesh.position.distanceTo(playerPos)
      * (this.state === 'dead' ? ENEMY_DEAD_LOD_BIAS : this.detailBias)
      * Math.pow(2, this.lodBias);

    if (this.detailMeshes.length > 0) {
      const meshes = this.detailMeshes;
      let drawn = this.detailDrawn;
      // Stepping from the current tier, with the two edges of the band offset,
      // keeps a hostile hovering at a threshold from toggling every frame.
      while (drawn > 0 && meshes[drawn - 1].range < distance) drawn -= 1;
      while (drawn < meshes.length && meshes[drawn].range * ENEMY_LOD_HYSTERESIS > distance) {
        drawn += 1;
      }
      if (drawn !== this.detailDrawn) {
        for (let i = Math.min(drawn, this.detailDrawn); i < Math.max(drawn, this.detailDrawn); i += 1) {
          this.detailMeshes[i].mesh.visible = i < drawn;
        }
        this.detailDrawn = drawn;
      }
    }

    if (this.casterMeshes.length > 0) {
      // Budget-thinned hostiles (detailBias > 1) keep a silhouette but never
      // pay for CSM — only the nearest fully-dressed few cast shadows.
      const casting = this.detailBias <= 1 && distance < ENEMY_SHADOW_DISTANCE;
      if (casting !== this.castersEnabled) {
        this.castersEnabled = casting;
        for (const mesh of this.casterMeshes) mesh.castShadow = casting;
      }
    }
  }

  private buildMesh(): Enemy['parts'] {
    const kit = fallbackKit();
    // Object3D.clone shares geometry and material references, so an extra
    // hostile only allocates nodes, never a second copy of the silhouette.
    const root = fallbackTemplate().clone(true);
    for (const child of [...root.children]) this.visualRoot.add(child);
    this.visualRoot.traverse((obj) => {
      const mesh = obj as THREE.Mesh;
      if (!mesh.isMesh) return;
      if (mesh.material === kit.body) mesh.material = this.bodyMat;
      const extent = mesh.userData.batchExtent as number | undefined;
      // The seven animated parts carry the silhouette and are never retired;
      // only the merged batches hanging off them are.
      if (extent !== undefined) {
        this.detailMeshes.push({
          mesh,
          range: Math.min(extent * ENEMY_LOD_SCALE, ENEMY_SILHOUETTE_DISTANCE),
        });
      }
      if (mesh.castShadow) this.casterMeshes.push(mesh);
    });
    this.detailMeshes.sort((a, b) => b.range - a.range);
    this.detailDrawn = this.detailMeshes.length;
    const part = (name: string) => this.visualRoot.getObjectByName(name) as THREE.Mesh;
    return {
      head: part('enemy_head'),
      torso: part('enemy_torso'),
      leftArm: part('enemy_left_arm'),
      rightArm: part('enemy_right_arm'),
      leftLeg: part('enemy_left_leg'),
      rightLeg: part('enemy_right_leg'),
      weapon: part('enemy_rifle'),
    };
  }

  private tagParts(): void {
    this.parts.head.userData.hitPart = 'head';
    this.parts.head.name = 'enemy_head';
    this.parts.torso.userData.hitPart = 'torso';
    this.parts.torso.name = 'enemy_torso';
    this.parts.leftArm.userData.hitPart = 'arm';
    this.parts.leftArm.name = 'enemy_left_arm';
    this.parts.rightArm.userData.hitPart = 'arm';
    this.parts.rightArm.name = 'enemy_right_arm';
    this.parts.leftLeg.userData.hitPart = 'leg';
    this.parts.leftLeg.name = 'enemy_left_leg';
    this.parts.rightLeg.userData.hitPart = 'leg';
    this.parts.rightLeg.name = 'enemy_right_leg';
    this.parts.weapon.userData.hitPart = 'generic';
    this.parts.weapon.name = 'enemy_rifle';
    this.mesh.userData.isEnemy = true;
    this.mesh.userData.enemy = this;
  }

  private pickPatrolTarget(): void {
    const r = 4 + this.random() * 6;
    const a = this.random() * Math.PI * 2;
    this.patrolTarget.set(
      this.mesh.position.x + Math.cos(a) * r,
      this.mesh.position.y,
      this.mesh.position.z + Math.sin(a) * r,
    );
    // Keep roughly inside arena
    this.patrolTarget.x = THREE.MathUtils.clamp(this.patrolTarget.x, -30, 30);
    this.patrolTarget.z = THREE.MathUtils.clamp(this.patrolTarget.z, -30, 30);
    this.stateTimer = 0;
  }

  private seekCover(): void {
    const reserved = this.coverAuthority?.reserve(this) ?? null;
    if (reserved) {
      this.coverTarget = reserved;
      this.stateTimer = 0;
      return;
    }
    if (this.coverNodes.length === 0) {
      this.coverTarget = null;
      return;
    }
    const threat = this.hasLastKnownPosition ? this.lastKnownPlayerPosition : null;
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const node of this.coverNodes) {
      const d = this.mesh.position.distanceTo(node);
      if (d < 2) continue;
      // Prefer nearby cover that holds a usable standoff from the threat and
      // does not require crossing the firing line to reach.
      let score = d + this.random() * 3;
      if (threat) {
        const threatDistance = node.distanceTo(threat);
        if (threatDistance < 5) score += (5 - threatDistance) * 3;
        else if (threatDistance > 26) score += (threatDistance - 26) * 0.5;
      }
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    this.coverTarget = best ? best.clone() : null;
    this.stateTimer = 0;
  }

  /** Reaction time: distance, awareness and squad chatter all shorten it. */
  private rollReactionTime(dist: number): number {
    const range = THREE.MathUtils.clamp(dist / this.engageRange, 0, 1);
    const base = (0.18 + range * 0.42) * (1 - this.awareness * 0.45);
    return Math.max(0.08, base + this.random() * 0.22);
  }

  private rollBurstSize(): number {
    const base = this.role === 'suppressor' ? 5 : 3;
    return base + Math.floor(this.random() * 3);
  }

  /** Standoff each role tries to hold once it is trading fire. */
  private preferredEngagementRange(): number {
    switch (this.role) {
      case 'anchor': return 17;
      case 'suppressor': return 20;
      case 'flanker': return 11;
      default: return 12;
    }
  }

  private commitToEngagement(dist: number, playerPos: THREE.Vector3): void {
    this.stateTimer = 0;
    this.repositionTimer = 0;
    if (this.role === 'flanker' && dist > 9 && this.suppression < 0.5) {
      this.ensureFlankTarget(playerPos);
      if (this.flankTarget) {
        this.state = 'flank';
        this.emitCallout('flanking');
        return;
      }
    }
    // Suppressors and anchors always want a hard position; assaults gamble.
    const wantsCover = this.suppression > 0.3
      || this.role === 'anchor'
      || this.role === 'suppressor'
      || (dist < 16 && this.random() > 0.35);
    if (wantsCover) {
      this.seekCover();
      if (this.coverTarget) {
        this.enterCoverRun();
        return;
      }
    }
    this.state = 'combat';
  }

  private enterCoverRun(): void {
    this.state = 'cover';
    this.inCover = false;
    this.peeking = false;
    this.peekTimer = 0;
    this.coverHoldTimer = 0;
    this.stateTimer = 0;
    this.repositionTimer = 0;
  }

  private releaseCover(): void {
    this.coverTarget = null;
    this.inCover = false;
    this.coverHoldTimer = 0;
    this.peeking = true;
    this.coverAuthority?.release(this);
  }

  private beginSearch(): void {
    this.releaseCover();
    this.state = 'search';
    this.stateTimer = 0;
    this.repositionTimer = 0;
    this.searchTarget = null;
    this.searchSweeps = 0;
    this.suppressiveBudget = 0;
  }

  private updateCover(dt: number, playerPos: THREE.Vector3, dist: number): void {
    if (!this.inCover && !this.coverTarget) {
      this.seekCover();
      if (!this.coverTarget) {
        this.state = 'combat';
        this.stateTimer = 0;
        return;
      }
    }

    if (!this.inCover && this.coverTarget) {
      this.moveToward(this.coverTarget, dt, this.speed * 1.15);
      this.faceToward(
        this.hasVisual ? playerPos : this.coverTarget,
        dt,
        this.hasVisual ? 7 : 9,
      );
      if (this.mesh.position.distanceTo(this.coverTarget) < 1.0) {
        this.inCover = true;
        this.coverHoldTimer = 0;
        this.peeking = false;
        this.peekTimer = 0.2 + this.random() * 0.35;
      }
      // Fire on the move only when the target is close and the AI is not pinned.
      if (this.hasVisual && dist < this.engageRange * 0.85 && this.suppression < 0.7) {
        this.tryShoot(playerPos);
      }
      return;
    }

    this.coverHoldTimer += dt;
    this.faceToward(this.threatFocus(playerPos), dt, 8);
    this.peekTimer -= dt;
    if (this.peekTimer <= 0) {
      // Heavy incoming fire keeps the hostile down; a lull brings it back up.
      this.peeking = !this.peeking && this.suppression < 0.85;
      const pinned = 1 + this.suppression * 2.2;
      this.peekTimer = this.peeking
        ? (0.7 + this.random() * 0.9) / pinned
        : (0.4 + this.random() * 0.65) * pinned;
    }
    if (this.peeking) {
      if (this.hasVisual) this.tryShoot(playerPos);
      else this.trySuppressiveFire();
    }
    this.considerLeavingCover(dist, playerPos);
  }

  private considerLeavingCover(dist: number, playerPos: THREE.Vector3): void {
    if (!this.hasVisual && this.lastSeenAge > 4.5) {
      this.beginSearch();
      return;
    }
    if (this.suppression > 0.4) return;
    if (this.role === 'flanker' && this.coverHoldTimer > 1.8) {
      this.ensureFlankTarget(playerPos);
      if (this.flankTarget) {
        this.releaseCover();
        this.state = 'flank';
        this.stateTimer = 0;
        this.emitCallout('flanking');
      }
      return;
    }
    const holdTime = this.role === 'anchor' ? 6.5 : this.role === 'suppressor' ? 5 : 3.2;
    if (this.coverHoldTimer > holdTime && (dist > 11 || !this.hasVisual)) {
      // Return fire dropped off — push instead of camping the same crate.
      this.releaseCover();
      this.state = 'combat';
      this.stateTimer = 0;
      this.repositionTimer = 0;
    }
  }

  private updateFlank(dt: number, playerPos: THREE.Vector3, dist: number): void {
    if (this.suppression > 0.6) {
      this.seekCover();
      if (this.coverTarget) {
        this.enterCoverRun();
        return;
      }
    }
    this.ensureFlankTarget(playerPos);
    const target = this.flankTarget;
    if (!target) {
      this.state = 'combat';
      this.stateTimer = 0;
      return;
    }
    this.moveToward(target, dt, this.speed * 1.05);
    this.faceToward(this.hasVisual ? playerPos : target, dt, this.hasVisual ? 8 : 6);
    if (this.hasVisual && dist < this.engageRange * 0.8) this.tryShoot(playerPos);
    if (this.mesh.position.distanceTo(target) < 1.4 || this.stateTimer > 7 || dist < 6.5) {
      this.flankTarget = null;
      this.state = 'combat';
      this.stateTimer = 0;
      this.repositionTimer = 0;
    }
  }

  private updateCombat(dt: number, playerPos: THREE.Vector3, dist: number): void {
    this.faceToward(this.threatFocus(playerPos), dt, this.hasVisual ? 10 : 5);
    if (!this.hasVisual && this.lastSeenAge > 3.5) {
      this.beginSearch();
      return;
    }
    if (dist > this.engageRange * 1.15) {
      this.state = 'alert';
      this.alertTimer = 0.5;
      return;
    }
    // Pinned or badly wounded hostiles break contact for hard cover.
    if (
      (this.suppression > 0.5 || this.health < this.maxHealth * 0.4)
      && this.repositionTimer > 0.8
    ) {
      this.seekCover();
      if (this.coverTarget) {
        this.enterCoverRun();
        return;
      }
      this.repositionTimer = 0;
    }

    const preferred = this.preferredEngagementRange();
    if (dist > preferred + 4) {
      this.moveToward(this.threatFocus(playerPos), dt, this.speed * (this.hasVisual ? 0.72 : 0.85));
    } else if (dist < preferred - 3) {
      this.backOff(playerPos, dt);
    } else {
      this.strafe(playerPos, dt, dist);
    }

    if (this.hasVisual) this.tryShoot(playerPos);
    else this.trySuppressiveFire();

    // Long static exchanges get stale; rotate to a fresh firing position.
    if (this.repositionTimer > 5.5 && this.random() < 0.02) {
      this.seekCover();
      if (this.coverTarget) this.enterCoverRun();
      this.repositionTimer = 0;
    }
  }

  private updateSearch(dt: number, playerPos: THREE.Vector3): void {
    if (this.hasVisual) {
      this.state = 'combat';
      this.stateTimer = 0;
      this.searchTarget = null;
      this.emitCallout('contact');
      return;
    }
    if (!this.hasLastKnownPosition) {
      this.state = 'patrol';
      this.pickPatrolTarget();
      return;
    }
    if (!this.searchTarget) {
      // The first leg goes straight to the last sighting, later legs fan out.
      this.searchTarget = this.searchSweeps === 0
        ? this.lastKnownPlayerPosition.clone()
        : this.rollSearchPoint();
    }
    this.moveToward(this.searchTarget, dt, this.speed * (this.searchSweeps === 0 ? 0.7 : 0.5));
    this.faceToward(this.sweepFocus(this.searchTarget), dt, 3.5);
    if (this.mesh.position.distanceTo(this.searchTarget) < 1.6 || this.stateTimer > 4.5) {
      this.searchTarget = null;
      this.searchSweeps += 1;
      this.stateTimer = 0;
      if (this.searchSweeps > 2) {
        // Give up the hunt so the level keeps moving instead of freezing here.
        this.hasLastKnownPosition = false;
        this.searchSweeps = 0;
        this.awareness = Math.min(this.awareness, 0.4);
        this.state = 'patrol';
        this.pickPatrolTarget();
      }
    }
  }

  private rollSearchPoint(): THREE.Vector3 {
    const radius = 3 + this.searchSweeps * 2.5 + this.random() * 3;
    const angle = this.random() * Math.PI * 2;
    return new THREE.Vector3(
      THREE.MathUtils.clamp(this.lastKnownPlayerPosition.x + Math.cos(angle) * radius, -30, 30),
      this.mesh.position.y,
      THREE.MathUtils.clamp(this.lastKnownPlayerPosition.z + Math.sin(angle) * radius, -30, 30),
    );
  }

  /** Muzzle sweep applied while clearing, so searching does not read as a stare. */
  private sweepFocus(target: Readonly<THREE.Vector3>): THREE.Vector3 {
    this._focus.copy(target).sub(this.mesh.position);
    this._focus.y = 0;
    if (this._focus.lengthSq() < 1e-6) return this._focus.copy(target);
    const yaw = Math.atan2(this._focus.x, this._focus.z)
      + Math.sin(this.stateTimer * 1.6 + this.patrolSeed) * 0.9;
    return this._focus.set(
      this.mesh.position.x + Math.sin(yaw) * 4,
      this.mesh.position.y,
      this.mesh.position.z + Math.cos(yaw) * 4,
    );
  }

  /** Best available belief about where the threat is, visual or otherwise. */
  private threatFocus(playerPos: Readonly<THREE.Vector3>): THREE.Vector3 {
    if (this.hasVisual) return this._focus.copy(playerPos);
    if (this.hasLastKnownPosition) return this._focus.copy(this.lastKnownPlayerPosition);
    if (this.threatYaw !== null) {
      return this._focus.set(
        this.mesh.position.x + Math.sin(this.threatYaw) * 5,
        this.mesh.position.y,
        this.mesh.position.z + Math.cos(this.threatYaw) * 5,
      );
    }
    return this._focus.copy(this.patrolTarget);
  }

  private ensureFlankTarget(playerPos: Readonly<THREE.Vector3>): void {
    if (this.flankTarget) return;
    const anchor = this.hasVisual
      ? playerPos
      : this.hasLastKnownPosition ? this.lastKnownPlayerPosition : null;
    if (!anchor) return;
    this._tmp3.copy(this.mesh.position).sub(anchor);
    this._tmp3.y = 0;
    const radius = THREE.MathUtils.clamp(this._tmp3.length() * 0.85, 7, 20);
    if (this._tmp3.lengthSq() < 1e-6) this._tmp3.set(0, 0, 1);
    else this._tmp3.normalize();
    // Swing a wide lateral arc around the threat rather than charging the axis.
    const arc = (0.85 + this.random() * 0.5) * this.flankSide;
    const cos = Math.cos(arc);
    const sin = Math.sin(arc);
    this.flankTarget = new THREE.Vector3(
      anchor.x + (this._tmp3.x * cos - this._tmp3.z * sin) * radius,
      this.mesh.position.y,
      anchor.z + (this._tmp3.x * sin + this._tmp3.z * cos) * radius,
    );
  }

  private strafe(playerPos: Readonly<THREE.Vector3>, dt: number, dist: number): void {
    this._tmp3.copy(playerPos).sub(this.mesh.position);
    this._tmp3.y = 0;
    if (this._tmp3.lengthSq() < 1e-6) return;
    this._tmp3.normalize();
    const side = Math.sin(this.stateTimer * 1.4 + this.patrolSeed) >= 0
      ? this.flankSide
      : -this.flankSide;
    this._tmp2
      .set(-this._tmp3.z, 0, this._tmp3.x)
      .multiplyScalar(side * 2.4)
      .addScaledVector(this._tmp3, dist < 7 ? -1.2 : 0.3)
      .add(this.mesh.position);
    this.moveToward(this._tmp2, dt, this.speed * (this.suppression > 0.4 ? 0.4 : 0.62));
  }

  private backOff(playerPos: Readonly<THREE.Vector3>, dt: number): void {
    this._tmp2.copy(this.mesh.position).sub(playerPos);
    this._tmp2.y = 0;
    if (this._tmp2.lengthSq() < 1e-6) return;
    this._tmp2.normalize().multiplyScalar(3).add(this.mesh.position);
    this.moveToward(this._tmp2, dt, this.speed * 0.55);
  }

  /**
   * Rounds at the last known position. This is what keeps a player who breaks
   * line of sight pinned instead of instantly safe, and it is budgeted so the
   * squad cannot hose a doorway forever.
   */
  private trySuppressiveFire(): void {
    if (this.suppressiveBudget <= 0 || !this.hasLastKnownPosition) return;
    if (this.lastSeenAge > 2.4 || this.role === 'flanker' || this.suppression > 0.55) return;
    const first = this.suppressiveBudget === 4;
    if (!this.tryShoot(this.lastKnownPlayerPosition, true)) return;
    this.suppressiveBudget -= 1;
    if (first) this.emitCallout('suppressing');
  }

  private emitCallout(callout: EnemyCallout): void {
    this.onCallout?.(callout, this);
  }

  private noteThreatDirection(source: Readonly<THREE.Vector3>): void {
    const dx = source.x - this.simulationPosition.x;
    const dz = source.z - this.simulationPosition.z;
    if (dx * dx + dz * dz < 1e-6) return;
    this.threatYaw = Math.atan2(dx, dz);
    if (!this.hasLastKnownPosition) {
      // Incoming fire is a real report: hunt where the rounds came from.
      this.lastKnownPlayerPosition.copy(source);
      this.hasLastKnownPosition = true;
      this.lastSeenAge = Math.min(this.lastSeenAge, 2);
    }
  }

  private moveToward(target: THREE.Vector3, dt: number, speed: number): void {
    const authoritativePosition = this.movementAuthority?.move(this, target, dt, speed);
    if (authoritativePosition) {
      this.velocity.copy(authoritativePosition).sub(this.mesh.position);
      if (dt > 1e-6) this.velocity.multiplyScalar(1 / dt);
      this.mesh.position.copy(authoritativePosition);
      return;
    }
    this._tmp.copy(target).sub(this.mesh.position);
    this._tmp.y = 0;
    const len = this._tmp.length();
    if (len < 0.05) return;
    this._tmp.multiplyScalar(1 / len);
    this.mesh.position.addScaledVector(this._tmp, speed * dt);
    this.velocity.copy(this._tmp).multiplyScalar(speed);
  }

  private faceToward(target: THREE.Vector3, dt: number, turnSpeed: number): void {
    this._look.copy(target).sub(this.mesh.position);
    this._look.y = 0;
    if (this._look.lengthSq() < 1e-6) return;
    const yaw = Math.atan2(this._look.x, this._look.z);
    let diff = yaw - this.mesh.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.mesh.rotation.y += THREE.MathUtils.clamp(diff, -turnSpeed * dt, turnSpeed * dt);
    this.aimDir.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
  }

  /**
   * Fires one round with trigger discipline. Returns false whenever the AI
   * deliberately holds fire (burst pause, squad slot, blocked lane) so callers
   * can distinguish "chose not to shoot" from "shot".
   */
  private tryShoot(target: Readonly<THREE.Vector3>, suppressive = false): boolean {
    if (this.fireCooldown > 0 || !this.onShoot) return false;
    if (this.shotsRemaining <= 0) {
      this.state = 'reload';
      this.reloadTimer = 1.45 + this.random() * 0.35;
      this.stateTimer = 0;
      this.emitCallout('reloading');
      this.playAuthoredClip(['reload'], true);
      return false;
    }
    if (this.burstPause > 0) return false;

    const origin = this.getAimPoint(this._tmp);
    const chest = this._tmp3.set(target.x, target.y + 1.4, target.z);
    // The lane check runs before the slot request so a hostile with a squadmate
    // in the way never burns the squad's bounded firing concurrency.
    if (this.isFireLaneBlocked?.(this, origin, chest)) {
      // Hold fire and step off the line instead.
      this.fireCooldown = Math.max(this.fireCooldown, 0.12);
      this.repositionTimer = Math.max(this.repositionTimer, 5.6);
      return false;
    }
    if (this.requestFireSlot && !this.requestFireSlot(this)) return false;

    const dir = this._tmp2.copy(chest).sub(origin);
    const dist = dir.length();
    dir.normalize();

    // Closer = tighter cone (more threatening in mid-range gunfights). Being
    // suppressed, or shooting at a remembered position, opens it back up.
    const closeBonus = dist < 14 ? THREE.MathUtils.clamp((14 - dist) / 14, 0, 1) * 0.22 : 0;
    const effectiveAcc = THREE.MathUtils.clamp(
      this.accuracy + closeBonus - this.suppression * 0.35 - (suppressive ? 0.25 : 0),
      0.08,
      0.96,
    );
    const spread = (1 - effectiveAcc) * 0.12;
    dir.x += (this.random() - 0.5) * spread;
    dir.y += (this.random() - 0.5) * spread * 0.6;
    dir.z += (this.random() - 0.5) * spread;
    dir.normalize();

    this.fireCooldown = this.fireInterval
      * (0.42 + this.random() * 0.26)
      * (1 + this.suppression * 0.5);
    this.shotsRemaining -= 1;
    this.burstRemaining -= 1;
    if (this.burstRemaining <= 0) {
      this.burstRemaining = this.rollBurstSize();
      // The gap between bursts is what makes incoming fire readable and gives
      // the player a window to move; suppressed hostiles hesitate longer.
      this.burstPause = this.fireInterval
        * (1.15 + this.random() * 0.9)
        * (1 + this.suppression * 1.4);
    }
    // Recoil pose
    this.parts.weapon.rotation.x = -0.25;
    this.onShoot({
      origin: origin.clone(),
      direction: dir.clone(),
      damage: 12 + this.random() * 8,
      enemy: this,
    });
    this.playAuthoredClip(['firing', 'fire', 'shoot'], true);
    return true;
  }

  private animateLocomotion(dt: number): void {
    const moving = this.velocity.lengthSq() > 0.4;
    const t = this.stateTimer;
    // Keep all secondary motion derived from simulation state. This makes the
    // fallback feel alive without adding an animation asset or changing the
    // authoritative enemy transform used by AI and hit resolution.
    const breathing = Math.sin(t * 2.15 + this.patrolSeed * 0.017);
    const weightShift = moving
      ? Math.sin(t * 8) * 0.004
      : Math.sin(t * 1.25 + this.patrolSeed * 0.009) * 0.009;
    this.parts.torso.position.set(0, 1.38 + breathing * 0.007, 0.012 + weightShift * 0.35);
    this.parts.torso.rotation.set(0.055 + breathing * 0.012, 0, weightShift * 0.5);
    this.parts.head.position.set(0, 1.895 + breathing * 0.01, 0.045 + weightShift * 0.55);
    this.parts.head.rotation.set(
      0.028 + breathing * 0.008,
      moving ? Math.sin(t * 4.4) * 0.018 : breathing * 0.032,
      0,
    );
    this.parts.weapon.position.set(0.045, 1.37 + breathing * 0.008, 0.39 + weightShift * 0.7);
    this.parts.weapon.rotation.z = -weightShift * 1.5;

    // The procedural rig is held in a compact rifle-ready pose. Layer gait
    // over the asymmetric ready stance rather than returning to a rigid T-pose.
    const leftArmAim = -1.08;
    const rightArmAim = -0.8;
    const leftLegAim = -0.12;
    const rightLegAim = -0.055;
    if (moving) {
      const swing = Math.sin(t * 8) * 0.24;
      this.parts.leftLeg.rotation.x = leftLegAim + swing;
      this.parts.rightLeg.rotation.x = rightLegAim - swing;
      this.parts.leftArm.rotation.x = leftArmAim - swing * 0.22;
      this.parts.rightArm.rotation.x = rightArmAim + swing * 0.18;
    } else {
      this.parts.leftLeg.rotation.x = THREE.MathUtils.damp(
        this.parts.leftLeg.rotation.x,
        leftLegAim,
        8,
        dt,
      );
      this.parts.rightLeg.rotation.x = THREE.MathUtils.damp(
        this.parts.rightLeg.rotation.x,
        rightLegAim,
        8,
        dt,
      );
      this.parts.leftArm.rotation.x = THREE.MathUtils.damp(
        this.parts.leftArm.rotation.x,
        leftArmAim,
        6,
        dt,
      );
      this.parts.rightArm.rotation.x = THREE.MathUtils.damp(
        this.parts.rightArm.rotation.x,
        rightArmAim,
        6,
        dt,
      );
    }
    this.parts.weapon.rotation.x = THREE.MathUtils.damp(
      this.parts.weapon.rotation.x,
      -0.045,
      10,
      dt,
    );
    this.velocity.multiplyScalar(0.85);
  }

  private updateDeath(dt: number): void {
    if (this.collapseAmount < 1) {
      this.collapseAmount = Math.min(1, this.collapseAmount + dt * 2.2);
      const t = this.collapseAmount;
      // Collapse limbs on the procedural kit; authored clips own their pose.
      this.parts.leftArm.rotation.z = t * 0.8;
      this.parts.rightArm.rotation.z = -t * 0.5;
      this.bodyMat.color.lerp(new THREE.Color(0x2a2a28), dt * 2);
    }
    const t = this.collapseAmount;
    // Animate the visual child only — mesh.position/quaternion feed simulation.
    this.visualRoot.rotation.x = THREE.MathUtils.lerp(0, Math.PI * 0.5, t * t);
    this.visualRoot.position.y = THREE.MathUtils.lerp(0, 0.15, t);
  }

  private updateAuthoredAnimation(): void {
    if (this.authoredOneShotTimer > 0) return;
    this.playAuthoredClip(ENEMY_ANIMATION_ALIASES[this.state], this.state === 'dead');
  }

  private playAuthoredClip(aliases: readonly string[], once: boolean): void {
    if (!this.authoredMixer) return;
    const action = [...this.authoredActions]
      .find(([name]) => aliases.some((alias) => name.includes(alias)))?.[1];
    if (!action || (action === this.authoredAction && !once)) return;
    action.reset();
    action.clampWhenFinished = once;
    action.setLoop(once ? THREE.LoopOnce : THREE.LoopRepeat, once ? 1 : Infinity);
    if (once) this.authoredOneShotTimer = Math.max(this.authoredOneShotTimer, action.getClip().duration);
    action.fadeIn(0.1).play();
    if (this.authoredAction && this.authoredAction !== action) this.authoredAction.fadeOut(0.1);
    this.authoredAction = action;
  }

  private removeAuthoredVisual(): void {
    if (!this.authoredRoot) return;
    this.authoredMixer?.stopAllAction();
    this.authoredMixer?.uncacheRoot(this.authoredRoot);
    this.authoredRoot.removeFromParent();
    this.authoredRoot = null;
    this.authoredMixer = null;
    this.authoredActions.clear();
    this.authoredAction = null;
    this.authoredOneShotTimer = 0;
    for (const child of this.visualRoot.children) child.visible = true;
  }

  private beginSimulationStep(): void {
    this.mesh.position.copy(this.simulationPosition);
    this.mesh.quaternion.copy(this.simulationQuaternion);
    this.previousSimulationPosition.copy(this.simulationPosition);
    this.previousSimulationQuaternion.copy(this.simulationQuaternion);
  }

  private endSimulationStep(): void {
    this.simulationPosition.copy(this.mesh.position);
    this.simulationQuaternion.copy(this.mesh.quaternion);
  }

  /**
   * Tick-scheduled LOS with hysteresis. Cold hostiles refresh on a staggered
   * fixed-tick cadence; combat, close range, and taking fire force an immediate
   * sample so gunfights do not feel laggy behind cover.
   */
  private resolveLineOfSight(
    eye: Readonly<THREE.Vector3>,
    targetEye: Readonly<THREE.Vector3>,
    dist: number,
  ): boolean {
    if (!this.lineOfSight) return true;

    this.losTick += 1;
    this.losTicksSinceSample += 1;

    const inHotCombat =
      this.state === 'combat'
      || this.state === 'cover'
      || this.state === 'flank';
    const force =
      this.losDirty
      || this.hitFlash > 0
      || dist < LOS_FORCE_RANGE
      || inHotCombat;
    const scheduled =
      !this.losHasSample
      || (this.losTick + this.losPhase) % LOS_REFRESH_TICKS === 0;
    if (!force && !scheduled) {
      return this.losCachedClear;
    }

    const sample = this.lineOfSight(eye, targetEye, this);
    const hadPriorClear = this.losHasSample && this.losCachedClear;
    this.losHasSample = true;
    this.losTicksSinceSample = 0;
    this.losDirty = false;

    if (sample) {
      this.losBlockedPending = 0;
      this.losCachedClear = true;
    } else if (force || !hadPriorClear) {
      this.losBlockedPending = 0;
      this.losCachedClear = false;
    } else {
      // Sticky clear: a single blocked sample while recently clear does not
      // flip awareness until hysteresis samples agree (or a forced refresh).
      this.losBlockedPending += 1;
      if (this.losBlockedPending >= LOS_CLEAR_HYSTERESIS) {
        this.losCachedClear = false;
        this.losBlockedPending = 0;
      }
    }
    return this.losCachedClear;
  }
}

function losRefreshPhase(id: string): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) {
    hash = (hash * 31 + id.charCodeAt(i)) | 0;
  }
  return Math.abs(hash) % LOS_REFRESH_TICKS;
}

function vectorOrNull(value: THREE.Vector3 | null): { x: number; y: number; z: number } | null {
  return value ? { x: value.x, y: value.y, z: value.z } : null;
}

function vectorFrom(
  value: { x: number; y: number; z: number } | null | undefined,
): THREE.Vector3 | null {
  return value ? new THREE.Vector3(value.x, value.y, value.z) : null;
}

function hasSkinnedMesh(root: THREE.Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if ((node as THREE.SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}

function missingAnimationRoles(
  gltf: GLTF,
  roles: Readonly<Record<string, readonly string[]>>,
): string[] {
  const names = gltf.animations.map((clip) => clip.name.toLowerCase());
  return Object.entries(roles)
    .filter(([, aliases]) => !names.some((name) => aliases.some((alias) => name.includes(alias))))
    .map(([role]) => role);
}

/** Edge of every generated fallback surface tile. */
const SURFACE_TEXTURE_SIZE = 32;

/** The albedo, tiling and roughness one fallback surface reads at. */
interface FallbackSurfaceSpec {
  /** Deterministic pattern seed. */
  seed: number;
  /** sRGB byte tones the weave picks between. */
  palette: readonly (readonly [number, number, number])[];
  /** Tiles per UV unit. */
  repeat: number;
  /** Mean roughness of the generated signal. */
  roughness: number;
  /** False for a surface that only ever used the roughness signal. */
  albedo?: false;
}

/**
 * Every mapped fallback surface. These used to be seven independent texture
 * pairs, which meant seven programs no batch could merge across; they are now
 * two shared weaves plus the per-surface tint, roughness and tiling that made
 * each one distinct. Keeping the palettes here is what lets the shared weave be
 * built from their average and each surface be corrected back onto it.
 */
const FALLBACK_SURFACES = {
  // Charcoal-OD fatigue: desaturated so dusk key light reads fabric, not toy green.
  body: { seed: 17, palette: [[52, 56, 50], [58, 62, 54], [45, 48, 44]], repeat: 2.3, roughness: 0.87 },
  trouser: { seed: 29, palette: [[42, 46, 44], [48, 52, 48], [36, 39, 37]], repeat: 2.0, roughness: 0.91 },
  plate: { seed: 43, palette: [[58, 62, 56], [66, 70, 62], [50, 54, 50]], repeat: 2.7, roughness: 0.9 },
  gear: { seed: 59, palette: [[62, 62, 58], [72, 72, 67], [52, 53, 50]], repeat: 4.5, roughness: 0.8, albedo: false },
  weapon: { seed: 73, palette: [[43, 50, 49], [52, 60, 58], [33, 40, 40]], repeat: 3.2, roughness: 0.56 },
  webbing: { seed: 61, palette: [[38, 44, 38], [46, 52, 44], [30, 36, 32]], repeat: 5.6, roughness: 0.86 },
  glove: { seed: 67, palette: [[29, 35, 31], [39, 46, 40], [23, 29, 26]], repeat: 7.5, roughness: 0.9 },
} as const satisfies Record<string, FallbackSurfaceSpec>;

/** Hard goods, listed first so untextured trim merges with them. */
const HARD_GOODS_SURFACES = [
  FALLBACK_SURFACES.body,
  FALLBACK_SURFACES.trouser,
  FALLBACK_SURFACES.plate,
  FALLBACK_SURFACES.gear,
  FALLBACK_SURFACES.weapon,
] as const;

/** Soft goods, which are the only surfaces the development albedo replaces. */
const SOFT_GOODS_SURFACES = [
  FALLBACK_SURFACES.webbing,
  FALLBACK_SURFACES.glove,
] as const;

const srgbToLinear = (channel: number): number => (
  channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4
);

interface SurfacePixels {
  color: Uint8Array;
  roughness: Uint8Array;
  /** Mean albedo in the renderer's working space. */
  albedoMean: THREE.Color;
  /** Mean of the roughness signal. */
  roughnessMean: number;
}

/**
 * Keep the fallback self-contained: these are tiny, deterministic data textures
 * rather than downloaded art. The low-frequency pattern creates fabric breakup
 * at combat distance; the separate roughness signal keeps webbing and carrier
 * panels from catching light like molded plastic.
 *
 * The means are measured rather than assumed, because they are what a surface
 * sharing this weave has to be corrected against to keep the level it read at.
 */
function surfacePixels(spec: FallbackSurfaceSpec): SurfacePixels {
  const size = SURFACE_TEXTURE_SIZE;
  const { seed, palette, roughness } = spec;
  const color = new Uint8Array(size * size * 4);
  const roughnessData = new Uint8Array(size * size * 4);
  const noise = (x: number, y: number, salt: number) => {
    let value = Math.imul(x + seed * 37, 374761393)
      ^ Math.imul(y + salt * 17, 668265263)
      ^ Math.imul(seed + salt, 1442695041);
    value = Math.imul(value ^ (value >>> 13), 1274126177);
    return ((value ^ (value >>> 16)) >>> 0) / 0xffffffff;
  };
  const albedoTotal = new THREE.Color(0, 0, 0);
  let roughnessTotal = 0;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const offset = (y * size + x) * 4;
      // 4px islands read as a restrained printed weave, while the smaller
      // value modulation prevents perfectly flat colour planes up close.
      const patch = Math.floor(noise(x >> 2, y >> 2, 3) * palette.length);
      const grain = 0.94 + noise(x, y, 11) * 0.1;
      const tone = palette[Math.min(palette.length - 1, patch)];
      color[offset] = Math.round(tone[0] * grain);
      color[offset + 1] = Math.round(tone[1] * grain);
      color[offset + 2] = Math.round(tone[2] * grain);
      color[offset + 3] = 255;
      albedoTotal.r += srgbToLinear(color[offset] / 255);
      albedoTotal.g += srgbToLinear(color[offset + 1] / 255);
      albedoTotal.b += srgbToLinear(color[offset + 2] / 255);
      const r = THREE.MathUtils.clamp(
        roughness + (noise(x >> 1, y >> 1, 23) - 0.5) * 0.16,
        0.08,
        0.98,
      );
      const byte = Math.round(r * 255);
      roughnessData[offset] = byte;
      roughnessData[offset + 1] = byte;
      roughnessData[offset + 2] = byte;
      roughnessData[offset + 3] = 255;
      roughnessTotal += byte / 255;
    }
  }
  const texels = size * size;
  albedoTotal.multiplyScalar(1 / texels);
  return {
    color,
    roughness: roughnessData,
    albedoMean: albedoTotal,
    roughnessMean: roughnessTotal / texels,
  };
}

/** The weave a set of surfaces shares, built from the average of all of them. */
function sharedSurfaceSpec(
  members: readonly FallbackSurfaceSpec[],
  seed: number,
): FallbackSurfaceSpec {
  const toned = members.filter((member) => member.albedo !== false);
  const levels = toned[0].palette.length;
  const palette: Array<[number, number, number]> = [];
  for (let level = 0; level < levels; level += 1) {
    const tone: [number, number, number] = [0, 0, 0];
    for (const member of toned) {
      const source = member.palette[level];
      tone[0] += source[0];
      tone[1] += source[1];
      tone[2] += source[2];
    }
    palette.push([
      Math.round(tone[0] / toned.length),
      Math.round(tone[1] / toned.length),
      Math.round(tone[2] / toned.length),
    ]);
  }
  const roughness = members.reduce((total, member) => total + member.roughness, 0)
    / members.length;
  return { seed, palette, repeat: 1, roughness };
}

/**
 * One shared weave plus everything a member needs to sit on it without changing
 * the level it used to read at.
 */
interface SharedSurface {
  family: SurfaceFamily;
  albedo: THREE.DataTexture;
  roughness: THREE.DataTexture;
  mean: SurfacePixels;
}

function createSharedSurface(
  name: string,
  members: readonly FallbackSurfaceSpec[],
  seed: number,
  textures: THREE.Texture[],
): SharedSurface {
  const spec = sharedSurfaceSpec(members, seed);
  const pixels = surfacePixels(spec);
  const configure = (data: Uint8Array, suffix: string, colorSpace: string) => {
    const texture = new THREE.DataTexture(
      data,
      SURFACE_TEXTURE_SIZE,
      SURFACE_TEXTURE_SIZE,
      THREE.RGBAFormat,
    );
    texture.name = `FallbackEnemy${name}${suffix}`;
    texture.colorSpace = colorSpace;
    texture.wrapS = THREE.RepeatWrapping;
    texture.wrapT = THREE.RepeatWrapping;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    textures.push(texture);
    return texture;
  };
  const albedo = configure(pixels.color, 'Albedo', THREE.SRGBColorSpace);
  const roughness = configure(pixels.roughness, 'Roughness', THREE.NoColorSpace);
  return {
    family: new SurfaceFamily(name, { map: albedo, roughnessMap: roughness }),
    albedo,
    roughness,
    mean: pixels,
  };
}

/**
 * Points a material at a shared weave and corrects its tint and roughness so it
 * reads where its own texture pair used to put it. Tiling stays per surface: the
 * batcher bakes it into the merged UVs, and an untextured view carries it for
 * the pieces that are never merged.
 */
function bindSharedSurface(
  material: THREE.MeshStandardMaterial,
  spec: FallbackSurfaceSpec,
  surface: SharedSurface,
  textures: THREE.Texture[],
): void {
  const own = surfacePixels(spec);
  const view = (texture: THREE.Texture, suffix: string): THREE.Texture => {
    const tiled = texture.clone();
    tiled.name = `${texture.name}${suffix}`;
    tiled.repeat.set(spec.repeat, spec.repeat);
    textures.push(tiled);
    return tiled;
  };
  if (spec.albedo !== false) {
    material.map = view(surface.albedo, `x${spec.repeat}`);
    material.color.setRGB(
      material.color.r * (own.albedoMean.r / surface.mean.albedoMean.r),
      material.color.g * (own.albedoMean.g / surface.mean.albedoMean.g),
      material.color.b * (own.albedoMean.b / surface.mean.albedoMean.b),
    );
  }
  material.roughnessMap = view(surface.roughness, `x${spec.repeat}`);
  material.roughness *= own.roughnessMean / surface.mean.roughnessMean;
}

/**
 * Cool-olive rim rest for fatigues. Hit flash restores to this instead of black
 * so midground (5–30 m) hostiles keep a silhouette against dark facades without
 * lifting the world hemisphere.
 */
const BODY_RIM_EMISSIVE = 0x1a221c;
const BODY_RIM_INTENSITY = 0.22;
/** Cooler gear edge lift — separates pouches/carrier from fatigue mass. */
const GEAR_RIM_EMISSIVE = 0x243038;
const GEAR_RIM_INTENSITY = 0.18;

function createFallbackKit(): EnemyFallbackKit {
  const textures: THREE.Texture[] = [];
  // Fatigues are the only per-hostile material: hit flash and the death fade
  // mutate them. Everything else is shared by every procedural hostile so a
  // squad costs one material graph rather than one per soldier.
  const bodyMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.9,
    metalness: 0.0,
    emissive: BODY_RIM_EMISSIVE,
    emissiveIntensity: BODY_RIM_INTENSITY,
  });
  // Gear sits a value step above fatigues with a cool edge so pouches and
  // carrier panels still read when the body merges into lee facades.
  const gearMat = new THREE.MeshStandardMaterial({
    color: 0x3a4436,
    roughness: 0.76,
    metalness: 0.12,
    emissive: GEAR_RIM_EMISSIVE,
    emissiveIntensity: GEAR_RIM_INTENSITY,
  });
  const skinMat = new THREE.MeshStandardMaterial({
    // Slightly cooler mid-tone so the face doesn't read as plastic tan under
    // warm practicals; low metalness and mid roughness keep pores from chrome.
    color: 0x7a5c48,
    roughness: 0.78,
    metalness: 0.0,
    emissive: 0x2a1810,
    emissiveIntensity: 0.045,
  });
  const plateMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.04,
    emissive: 0x161c18,
    emissiveIntensity: 0.1,
  });
  const trouserMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.92,
    metalness: 0.01,
    emissive: BODY_RIM_EMISSIVE,
    emissiveIntensity: BODY_RIM_INTENSITY * 0.7,
  });
  const gloveMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.88,
    metalness: 0.03,
  });
  // Keep soft webbing distinct from hard radios, weapon furniture, and
  // helmet hardware so the fabric source never reads like a rifle coating.
  const webbingMat = new THREE.MeshStandardMaterial({
    // Match the former shared gear baseline until the optional development
    // source is installed, so release/fallback behavior remains unchanged.
    color: 0xffffff,
    roughness: 0.86,
    metalness: 0.06,
    emissive: GEAR_RIM_EMISSIVE,
    emissiveIntensity: GEAR_RIM_INTENSITY * 0.55,
  });
  const helmetMat = new THREE.MeshStandardMaterial({
    // Flat charcoal shell; cool rim keeps the head mass off dark facade brick.
    color: 0x2a302c,
    roughness: 0.88,
    metalness: 0.05,
    emissive: 0x141c22,
    emissiveIntensity: 0.14,
  });
  const lensMat = new THREE.MeshStandardMaterial({
    color: 0x0c1418,
    roughness: 0.22,
    metalness: 0.55,
    emissive: 0x101820,
    emissiveIntensity: 0.12,
  });
  const weaponMat = new THREE.MeshStandardMaterial({
    color: 0xffffff,
    roughness: 0.56,
    metalness: 0.4,
    emissive: 0x121820,
    emissiveIntensity: 0.1,
  });
  const hardwareMat = new THREE.MeshStandardMaterial({
    color: 0x1a2224,
    roughness: 0.36,
    metalness: 0.68,
    emissive: 0x182028,
    emissiveIntensity: 0.14,
  });
  const trimMat = new THREE.MeshStandardMaterial({
    // Lifted olive-khaki so rails, buckles and bands break the silhouette.
    color: 0x7a8670,
    roughness: 0.66,
    metalness: 0.18,
    emissive: 0x2a3228,
    emissiveIntensity: 0.12,
  });
  const clothShadowMat = new THREE.MeshStandardMaterial({
    color: 0x1c241d,
    roughness: 0.94,
    metalness: 0.0,
  });

  // Two shared weaves instead of seven independent texture pairs. Hard goods
  // and soft goods stay apart because only the latter takes the optional
  // development albedo, and a shared surface can only be replaced wholesale.
  const hardGoods = createSharedSurface('HardGoods', HARD_GOODS_SURFACES, 17, textures);
  const softGoods = createSharedSurface('SoftGoods', SOFT_GOODS_SURFACES, 61, textures);
  bindSharedSurface(bodyMat, FALLBACK_SURFACES.body, hardGoods, textures);
  bindSharedSurface(trouserMat, FALLBACK_SURFACES.trouser, hardGoods, textures);
  bindSharedSurface(plateMat, FALLBACK_SURFACES.plate, hardGoods, textures);
  bindSharedSurface(gearMat, FALLBACK_SURFACES.gear, hardGoods, textures);
  bindSharedSurface(weaponMat, FALLBACK_SURFACES.weapon, hardGoods, textures);
  bindSharedSurface(webbingMat, FALLBACK_SURFACES.webbing, softGoods, textures);
  bindSharedSurface(gloveMat, FALLBACK_SURFACES.glove, softGoods, textures);

  // A compact contact shadow anchors the character without reading as a large
  // black disc when the sun is low.
  const shadowMat = new THREE.MeshBasicMaterial({
    color: 0x000000,
    transparent: true,
    opacity: 0.28,
    depthWrite: false,
  });
  return {
    body: bodyMat,
    gear: gearMat,
    skin: skinMat,
    plate: plateMat,
    trouser: trouserMat,
    glove: gloveMat,
    webbing: webbingMat,
    helmet: helmetMat,
    lens: lensMat,
    weapon: weaponMat,
    hardware: hardwareMat,
    trim: trimMat,
    cloth: clothShadowMat,
    shadow: shadowMat,
    textures,
    families: [hardGoods.family, softGoods.family],
    softGoods: softGoods.family,
    softGoodsAlbedo: softGoods.albedo,
  };
}

/**
 * Leaves one caster per articulated part. After collapsing, a part is one large
 * body surface plus batches of webbing, pouches and hardware wrapped around it;
 * each of those costs a shadow submission while adding only a few centimetres
 * to an outline the body surface already casts under a soft dusk sun.
 */
function pruneShadowCasters(part: THREE.Mesh): void {
  const casters: Array<{ mesh: THREE.Mesh; edge: number }> = [];
  part.traverse((node) => {
    const mesh = node as THREE.Mesh;
    if (mesh.isMesh && mesh.castShadow && mesh.geometry) {
      casters.push({ mesh, edge: equivalentEdge(mesh.geometry) });
    }
  });
  if (casters.length < 2) return;
  const dominant = casters.reduce((best, entry) => (entry.edge > best.edge ? entry : best));
  for (const { mesh } of casters) mesh.castShadow = mesh === dominant.mesh;
}

/**
 * Builds the articulated fallback hierarchy exactly once. Each of the seven
 * animated parts is then collapsed into one mesh per render state, so a
 * hostile costs tens of draws instead of the ~130 loose meshes the layered
 * silhouette is authored from.
 */
function buildFallbackTemplate(kit: EnemyFallbackKit): THREE.Group {
  const {
    body: bodyMat,
    gear: gearMat,
    skin: skinMat,
    plate: plateMat,
    trouser: trouserMat,
    glove: gloveMat,
    webbing: webbingMat,
    helmet: helmetMat,
    lens: lensMat,
    weapon: weaponMat,
    hardware: hardwareMat,
    trim: trimMat,
    cloth: clothShadowMat,
    shadow: shadowMat,
  } = kit;
  const g = new THREE.Group();
  const addMesh = <T extends THREE.Mesh>(mesh: T, parent: THREE.Object3D = g): T => {
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    parent.add(mesh);
    return mesh;
  };
  const rounded = (
    width: number,
    height: number,
    depth: number,
    material: THREE.Material,
    parent: THREE.Object3D = g,
    radius = 0.025,
  ) => addMesh(new THREE.Mesh(
    new RoundedBoxGeometry(width, height, depth, 2, radius),
    material,
  ), parent);
  const taperedLimb = (
    topRadius: number,
    bottomRadius: number,
    length: number,
    material: THREE.Material,
    parent: THREE.Object3D = g,
  ) => {
    const geometry = new THREE.CylinderGeometry(topRadius, bottomRadius, length, 10);
    // A translated geometry gives every limb a real joint pivot instead of
    // having walk animation rotate around its center like a toy figurine.
    geometry.translate(0, -length * 0.5, 0);
    return addMesh(new THREE.Mesh(geometry, material), parent);
  };
  const blob = new THREE.Mesh(new THREE.CircleGeometry(0.43, 24), shadowMat);
  blob.rotation.x = -Math.PI * 0.5;
  blob.position.y = 0.012;
  blob.renderOrder = 1;
  g.add(blob);

  // ── torso / carrier ────────────────────────────────────────────────
  // A rounded box reads as a padded torso; the layered carrier panels break up
  // the mid-body silhouette before pouches and webbing add close-range detail.
  const torso = addMesh(
    new THREE.Mesh(new RoundedBoxGeometry(0.42, 0.72, 0.28, 2, 0.04), bodyMat),
  );
  // A slight forward set keeps the fallback in a guarded, rifle-ready
  // posture instead of the upright mannequin pose used by the first pass.
  torso.position.set(0, 1.38, 0.012);
  torso.rotation.x = 0.055;

  // Bridge the torso→leg void that read as a floating upper body in captures.
  // Abdomen + hip stay parented to the torso so breathing/weightShift cannot
  // open an air gap above the thighs.
  const abdomen = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.29, 0.26, 10), trouserMat),
    torso,
  );
  abdomen.position.y = -0.42;

  const belt = addMesh(
    new THREE.Mesh(new THREE.TorusGeometry(0.267, 0.026, 6, 12), webbingMat),
    torso,
  );
  belt.rotation.x = Math.PI * 0.5;
  belt.position.y = -0.33;
  const buckle = rounded(0.09, 0.055, 0.035, weaponMat, torso, 0.012);
  buckle.position.set(0, -0.33, 0.272);

  const carrierFrame = rounded(0.48, 0.5, 0.065, webbingMat, torso, 0.035);
  carrierFrame.position.set(0, 0.04, 0.268);
  const frontPlate = rounded(0.285, 0.36, 0.032, plateMat, torso, 0.012);
  frontPlate.position.set(0, 0.075, 0.318);
  const upperPlate = rounded(0.215, 0.135, 0.028, plateMat, torso, 0.01);
  upperPlate.position.set(0, 0.285, 0.322);
  const upperCarrier = rounded(0.385, 0.105, 0.048, webbingMat, torso, 0.018);
  upperCarrier.position.set(0, 0.235, 0.335);
  // Three restrained rows of webbing and three different-depth magazines
  // suggest textile construction without turning the torso into a grid.
  for (const y of [-0.02, 0.075, 0.17]) {
    const webbing = rounded(0.35, 0.018, 0.018, webbingMat, torso, 0.006);
    webbing.position.set(0, y, 0.326);
  }
  for (const [index, x] of [-0.13, 0, 0.13].entries()) {
    const pouch = rounded(0.102, 0.185 - index * 0.012, 0.082, plateMat, torso, 0.012);
    pouch.position.set(x, -0.105, 0.358 + index * 0.006);
    const flap = rounded(0.106, 0.032, 0.036, webbingMat, pouch, 0.008);
    flap.position.set(0, 0.075, 0.049);
    const pullTab = rounded(0.022, 0.045, 0.012, clothShadowMat, pouch, 0.004);
    pullTab.position.set(0, 0.09, 0.062);
  }

  for (const side of [-1, 1]) {
    const shoulder = rounded(0.145, 0.12, 0.135, plateMat, torso, 0.028);
    shoulder.position.set(side * 0.278, 0.245, 0.015);
    shoulder.rotation.z = -side * 0.22;
    const sidePlate = rounded(0.062, 0.285, 0.235, plateMat, torso, 0.018);
    sidePlate.position.set(side * 0.285, 0.02, 0.022);
    sidePlate.rotation.z = -side * 0.12;
    const wing = rounded(0.085, 0.225, 0.042, plateMat, torso, 0.012);
    wing.position.set(side * 0.238, 0.04, 0.292);
    const hipPouch = rounded(0.11, 0.155, 0.085, gearMat, torso, 0.014);
    hipPouch.position.set(side * 0.255, -0.175, 0.055);
    const hipFlap = rounded(0.114, 0.028, 0.034, webbingMat, hipPouch, 0.008);
    hipFlap.position.set(0, 0.065, 0.048);
  }

  const radio = rounded(0.075, 0.17, 0.055, gearMat, torso, 0.012);
  radio.position.set(-0.205, 0.115, 0.325);
  const antenna = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.19, 6), gearMat),
    radio,
  );
  antenna.position.set(-0.022, 0.15, 0);
  antenna.rotation.z = -0.1;
  const backpack = rounded(0.33, 0.42, 0.13, plateMat, torso, 0.035);
  backpack.position.set(0, 0.015, -0.27);
  const packStrap = rounded(0.06, 0.44, 0.026, webbingMat, torso, 0.01);
  packStrap.position.set(-0.16, 0.02, -0.342);
  const packPanel = rounded(0.19, 0.12, 0.02, clothShadowMat, backpack, 0.008);
  packPanel.position.set(0, -0.075, -0.072);
  for (const x of [-0.08, 0.08]) {
    const packWebbing = rounded(0.026, 0.31, 0.018, webbingMat, backpack, 0.006);
    packWebbing.position.set(x, 0.01, -0.072);
  }

  // Layered front straps, release hardware, and a small admin pocket make
  // the carrier read as worn equipment rather than a single smooth slab.
  for (const side of [-1, 1]) {
    const harness = rounded(0.055, 0.405, 0.026, webbingMat, torso, 0.009);
    harness.position.set(side * 0.19, 0.045, 0.335);
    harness.rotation.z = -side * 0.13;
    const buckleHousing = rounded(0.072, 0.048, 0.038, hardwareMat, torso, 0.01);
    buckleHousing.position.set(side * 0.19, -0.105, 0.358);
    const buckleFace = rounded(0.046, 0.019, 0.009, trimMat, buckleHousing, 0.003);
    buckleFace.position.z = 0.023;
  }
  const adminPouch = rounded(0.205, 0.09, 0.044, plateMat, torso, 0.014);
  adminPouch.position.set(0.045, 0.19, 0.366);
  const adminZip = rounded(0.155, 0.012, 0.012, hardwareMat, adminPouch, 0.003);
  adminZip.position.set(0, 0.006, 0.027);
  const releaseTab = rounded(0.034, 0.08, 0.016, webbingMat, torso, 0.006);
  releaseTab.position.set(0.245, 0.105, 0.36);
  const tourniquet = rounded(0.058, 0.12, 0.09, clothShadowMat, torso, 0.012);
  tourniquet.position.set(0.295, -0.12, 0.092);
  const tourniquetBar = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.012, 0.012, 0.1, 6), trimMat),
    tourniquet,
  );
  tourniquetBar.rotation.z = Math.PI * 0.5;
  tourniquetBar.position.set(0, 0.02, 0.055);
  const commsLead = addMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(-0.205, 0.2, 0.355),
          new THREE.Vector3(-0.18, 0.33, 0.315),
          new THREE.Vector3(-0.12, 0.43, 0.16),
        ]),
        14,
        0.008,
        5,
        false,
      ),
      hardwareMat,
    ),
    torso,
  );
  commsLead.renderOrder = 2;

  // ── head / helmet ──────────────────────────────────────────────────
  const neck = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.082, 0.092, 0.17, 10), skinMat),
    torso,
  );
  neck.position.y = 0.43;
  const head = addMesh(new THREE.Mesh(new THREE.SphereGeometry(0.165, 20, 16), skinMat));
  head.position.set(0, 1.895, 0.045);
  head.scale.set(0.86, 1.08, 0.88);
  head.rotation.x = 0.028;

  const helmet = addMesh(
    new THREE.Mesh(
      new THREE.SphereGeometry(0.188, 20, 12, 0, Math.PI * 2, 0, Math.PI * 0.58),
      helmetMat,
    ),
    head,
  );
  helmet.position.set(0, 0.012, -0.008);
  helmet.scale.set(1.04, 0.96, 1.06);
  // Drop the cheek coverage so the helmet rim sits above the eyes instead of
  // painting the whole head olive in mid-distance captures.
  const helmetSkirt = rounded(0.34, 0.04, 0.28, helmetMat, head, 0.012);
  helmetSkirt.position.set(0, -0.02, -0.02);
  const helmetRim = addMesh(
    new THREE.Mesh(new THREE.TorusGeometry(0.168, 0.009, 6, 16), helmetMat),
    head,
  );
  helmetRim.rotation.x = Math.PI * 0.5;
  helmetRim.position.set(0, -0.045, 0.002);
  for (const side of [-1, 1]) {
    const ear = addMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.041, 0.041, 0.034, 10), gearMat),
      head,
    );
    ear.rotation.z = Math.PI * 0.5;
    ear.position.set(side * 0.153, -0.018, 0.005);
    const rail = rounded(0.034, 0.095, 0.034, hardwareMat, head, 0.007);
    rail.position.set(side * 0.152, 0.045, 0.012);
    rail.rotation.z = side * 0.12;
    const mandible = rounded(0.085, 0.125, 0.095, helmetMat, head, 0.012);
    mandible.position.set(side * 0.132, -0.102, 0.082);
    mandible.rotation.y = side * 0.28;
    mandible.rotation.z = side * 0.08;
    const sideSkirt = rounded(0.048, 0.155, 0.085, helmetMat, head, 0.01);
    sideSkirt.position.set(side * 0.168, -0.035, -0.035);
    sideSkirt.rotation.z = side * 0.18;
    sideSkirt.rotation.y = side * 0.12;
  }
  const chinGuard = rounded(0.125, 0.055, 0.075, helmetMat, head, 0.012);
  chinGuard.position.set(0, -0.138, 0.095);
  const rearBrim = rounded(0.22, 0.035, 0.095, helmetMat, head, 0.01);
  rearBrim.position.set(0, -0.02, -0.155);
  const counterweight = rounded(0.12, 0.06, 0.045, gearMat, head, 0.01);
  counterweight.position.set(0, 0.025, -0.165);
  const nvgShroud = rounded(0.09, 0.068, 0.042, hardwareMat, head, 0.008);
  nvgShroud.position.set(0, 0.092, 0.165);
  const nvgPlate = rounded(0.058, 0.036, 0.012, trimMat, nvgShroud, 0.003);
  nvgPlate.position.z = 0.027;
  for (const x of [-0.028, 0.028]) {
    const nvgTube = addMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.022, 0.027, 0.075, 8), hardwareMat),
      nvgShroud,
    );
    nvgTube.rotation.x = Math.PI * 0.5;
    nvgTube.position.set(x, -0.018, 0.06);
    const nvgLens = addMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.017, 0.017, 0.006, 8), lensMat),
      nvgTube,
    );
    nvgLens.rotation.x = Math.PI * 0.5;
    nvgLens.position.z = 0.041;
  }
  for (const y of [0.108, 0.145]) {
    const helmetBand = rounded(0.125, 0.012, 0.018, trimMat, head, 0.004);
    helmetBand.position.set(0, y, 0.11);
  }
  const micBoom = addMesh(
    new THREE.Mesh(
      new THREE.TubeGeometry(
        new THREE.CatmullRomCurve3([
          new THREE.Vector3(-0.157, -0.028, 0.022),
          new THREE.Vector3(-0.175, -0.09, 0.11),
          new THREE.Vector3(-0.075, -0.106, 0.164),
        ]),
        10,
        0.006,
        5,
        false,
      ),
      hardwareMat,
    ),
    head,
  );
  micBoom.renderOrder = 2;
  const micTip = addMesh(new THREE.Mesh(new THREE.SphereGeometry(0.012, 7, 6), hardwareMat), head);
  micTip.position.set(-0.07, -0.106, 0.164);
  // Small, non-emissive eye protection and a fabric lower face resolve the
  // previous featureless black visor without making the fallback cartoony.
  const brow = rounded(0.175, 0.03, 0.025, helmetMat, head, 0.007);
  brow.position.set(0, 0.052, 0.14);
  for (const x of [-0.05, 0.05]) {
    const eye = rounded(0.057, 0.027, 0.012, lensMat, head, 0.007);
    eye.position.set(x, 0.006, 0.15);
  }
  const nose = addMesh(new THREE.Mesh(new THREE.SphereGeometry(0.025, 8, 6), skinMat), head);
  nose.scale.set(0.72, 0.9, 1.1);
  nose.position.set(0, -0.023, 0.153);
  const faceWrap = rounded(0.165, 0.06, 0.04, gloveMat, head, 0.016);
  faceWrap.position.set(0, -0.08, 0.125);
  for (const y of [-0.094, -0.076, -0.058]) {
    const wrapFold = rounded(0.12, 0.006, 0.009, clothShadowMat, head, 0.002);
    wrapFold.position.set(0, y, 0.149);
  }
  const chinStrap = rounded(0.105, 0.02, 0.022, webbingMat, head, 0.006);
  chinStrap.position.set(0, -0.125, 0.105);

  // ── articulated aiming arms ────────────────────────────────────────
  const buildArm = (side: number, upperAim: number, forearmAim: number) => {
    const arm = taperedLimb(0.1, 0.086, 0.4, bodyMat);
    arm.position.set(side * 0.315, 1.625, 0.055);
    arm.rotation.set(upperAim, 0, -side * 0.23);
    const sleeveBand = addMesh(
      new THREE.Mesh(new THREE.TorusGeometry(0.091, 0.012, 5, 10), trouserMat),
      arm,
    );
    sleeveBand.rotation.x = Math.PI * 0.5;
    sleeveBand.position.y = -0.18;
    const elbow = addMesh(new THREE.Mesh(new THREE.SphereGeometry(0.102, 10, 8), plateMat), arm);
    elbow.scale.set(0.94, 0.72, 0.8);
    elbow.position.set(0, -0.405, 0.01);
    const forearm = taperedLimb(0.085, 0.068, 0.36, gloveMat, arm);
    forearm.position.set(0, -0.39, 0);
    forearm.rotation.x = forearmAim;
    const wrist = addMesh(new THREE.Mesh(new THREE.SphereGeometry(0.074, 10, 8), gloveMat), arm);
    wrist.scale.set(0.82, 0.68, 1.04);
    wrist.position.set(0, -0.71, 0.065);
    const gloveCuff = addMesh(
      new THREE.Mesh(new THREE.TorusGeometry(0.071, 0.009, 5, 10), webbingMat),
      arm,
    );
    gloveCuff.rotation.x = Math.PI * 0.5;
    gloveCuff.position.set(0, -0.655, 0.042);
    const palm = rounded(0.098, 0.06, 0.12, gloveMat, arm, 0.014);
    palm.position.set(0, -0.755, 0.11);
    palm.rotation.x = side * 0.08;
    for (const x of [-0.027, 0, 0.027]) {
      const knuckle = rounded(0.018, 0.026, 0.032, clothShadowMat, palm, 0.004);
      knuckle.position.set(x, 0.004, 0.063);
    }
    return arm;
  };
  const leftArm = buildArm(-1, -1.08, -0.13);
  const rightArm = buildArm(1, -0.8, -0.22);

  // ── lower body ─────────────────────────────────────────────────────
  const hip = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.275, 0.295, 0.22, 10), trouserMat),
    torso,
  );
  // Local to torso (world ~1.02) so the pelvis rides with carrier motion.
  hip.position.set(0, -0.36, -0.01);
  const buildLeg = (side: number) => {
    const leg = taperedLimb(0.145, 0.12, 0.45, trouserMat);
    // Stagger and flex the legs so the operator has a planted fighting
    // stance. The boots follow the shins rather than floating below them.
    // Slightly higher pivot keeps thighs nested under the parented hip.
    leg.position.set(side * 0.185, 1.16, side < 0 ? -0.045 : 0.045);
    leg.rotation.x = side < 0 ? -0.12 : -0.055;
    const cargo = rounded(0.065, 0.145, 0.12, plateMat, leg, 0.012);
    cargo.position.set(side * 0.095, -0.225, 0.035);
    const knee = rounded(0.17, 0.11, 0.07, plateMat, leg, 0.025);
    knee.position.set(0, -0.44, 0.07);
    const calf = taperedLimb(0.105, 0.078, 0.43, trouserMat, leg);
    calf.position.set(0, -0.425, 0);
    calf.rotation.x = side < 0 ? 0.24 : 0.16;
    const boot = rounded(0.205, 0.14, 0.38, gearMat, calf, 0.028);
    boot.position.set(0, -0.66, 0.09);
    const ankle = rounded(0.18, 0.1, 0.185, gloveMat, calf, 0.02);
    ankle.position.set(0, -0.5, 0.02);
    return leg;
  };
  const leftLeg = buildLeg(-1);
  const rightLeg = buildLeg(1);

  // ── rifle ──────────────────────────────────────────────────────────
  // Build the rifle as one articulated hierarchy so recoil moves receiver,
  // stock, handguard, optic and muzzle together instead of leaving a box
  // floating between the hands.
  const weapon = rounded(0.12, 0.145, 0.31, weaponMat, g, 0.022);
  weapon.position.set(0.045, 1.37, 0.39);
  weapon.rotation.x = -0.045;
  const handguard = rounded(0.105, 0.115, 0.38, plateMat, weapon, 0.018);
  handguard.position.set(0, -0.005, 0.305);
  const topRail = rounded(0.055, 0.019, 0.61, hardwareMat, weapon, 0.004);
  topRail.position.set(0, 0.084, 0.25);
  for (const z of [-0.02, 0.07, 0.16, 0.25, 0.34, 0.43, 0.52]) {
    const railLug = rounded(0.075, 0.016, 0.018, trimMat, weapon, 0.003);
    railLug.position.set(0, 0.098, z);
  }
  for (const z of [0.18, 0.29, 0.4]) {
    const vent = rounded(0.012, 0.03, 0.05, clothShadowMat, weapon, 0.003);
    vent.position.set(0.058, -0.012, z);
  }
  const ejectionPort = rounded(0.014, 0.056, 0.118, clothShadowMat, weapon, 0.003);
  ejectionPort.position.set(0.067, 0.01, -0.025);
  const chargingHandle = rounded(0.03, 0.024, 0.065, hardwareMat, weapon, 0.006);
  chargingHandle.position.set(0.086, 0.055, -0.09);
  const foregrip = rounded(0.065, 0.18, 0.075, gloveMat, weapon, 0.012);
  foregrip.position.set(-0.01, -0.125, 0.31);
  foregrip.rotation.x = -0.14;
  const barrel = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.025, 0.43, 10), weaponMat),
    weapon,
  );
  barrel.rotation.x = Math.PI * 0.5;
  barrel.position.set(0, 0, 0.69);
  const muzzle = addMesh(
    new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.034, 0.095, 10), gearMat),
    weapon,
  );
  muzzle.rotation.x = Math.PI * 0.5;
  muzzle.position.set(0, 0, 0.955);
  const stock = rounded(0.155, 0.12, 0.28, gearMat, weapon, 0.024);
  stock.position.set(0, 0.005, -0.275);
  const pistolGrip = rounded(0.075, 0.22, 0.095, gearMat, weapon, 0.014);
  pistolGrip.position.set(0.025, -0.15, -0.055);
  pistolGrip.rotation.x = -0.18;
  const magazine = rounded(0.09, 0.245, 0.11, weaponMat, weapon, 0.015);
  magazine.position.set(-0.018, -0.165, 0.025);
  magazine.rotation.x = -0.14;
  for (const y of [-0.075, -0.015, 0.045]) {
    const magRib = rounded(0.096, 0.012, 0.025, trimMat, magazine, 0.003);
    magRib.position.set(0, y, 0.06);
  }
  const optic = rounded(0.115, 0.085, 0.16, gearMat, weapon, 0.016);
  optic.position.set(0, 0.13, 0.05);
  const opticGlass = rounded(0.088, 0.052, 0.012, lensMat, optic, 0.006);
  opticGlass.position.set(0, 0, 0.086);
  for (const side of [-1, 1]) {
    const opticDial = addMesh(
      new THREE.Mesh(new THREE.CylinderGeometry(0.021, 0.021, 0.018, 8), hardwareMat),
      optic,
    );
    opticDial.rotation.z = Math.PI * 0.5;
    opticDial.position.set(side * 0.064, 0.024, 0.006);
  }
  const frontSight = rounded(0.035, 0.075, 0.026, gearMat, weapon, 0.006);
  frontSight.position.set(0, 0.08, 0.51);
  const sling = addMesh(
    new THREE.Mesh(new THREE.TorusGeometry(0.27, 0.01, 5, 12, Math.PI * 0.82), webbingMat),
    weapon,
  );
  sling.rotation.set(Math.PI * 0.5, 0, 0.22);
  sling.position.set(0.02, -0.065, 0.1);

  const parts: Array<[string, THREE.Mesh]> = [
    ['enemy_head', head],
    ['enemy_torso', torso],
    ['enemy_left_arm', leftArm],
    ['enemy_right_arm', rightArm],
    ['enemy_left_leg', leftLeg],
    ['enemy_right_leg', rightLeg],
    ['enemy_rifle', weapon],
  ];
  for (const [name, part] of parts) {
    part.name = name;
    // Only the seven part roots are animated, so everything hanging off one of
    // them can be baked into a handful of merged surfaces.
    collapseStaticSubtrees(part, {
      trimExtent: ENEMY_TRIM_EXTENT,
      trimFlag: 'enemyTrim',
      shadowExtent: ENEMY_SHADOW_EXTENT,
      namePrefix: 'HostileBatch',
      unifyPlainMaterials: true,
      surfaceFamilies: kit.families,
    });
    pruneShadowCasters(part);
  }
  g.updateMatrixWorld(true);
  return g;
}
