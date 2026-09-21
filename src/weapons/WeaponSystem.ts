import {
  AdditiveBlending,
  BufferAttribute,
  BufferGeometry,
  DynamicDrawUsage,
  Line,
  LineBasicMaterial,
  MathUtils,
  Scene,
  Vector3,
  type PerspectiveCamera,
} from 'three';
import {
  hitscan,
  type BodyPart,
  type HitscanEnemy,
  type HitscanHit,
} from '../combat/Hitscan';
import type { WorldCollider } from '../player/PlayerController';
import type { PlayerController } from '../player/PlayerController';
import { SeededRandom, type RandomSource } from '../mission';
import type { InputFrame, PhysicsWorld } from '../simulation';
import { ViewModel, type WeaponId } from './ViewModel';

/**
 * A tracer is a travelling streak, not a full-length line that blinks on for a
 * frame: the head advances at a readable muzzle velocity and the tail chases it,
 * which is what makes automatic fire look like rounds in flight.
 */
interface TracerLine {
  active: boolean;
  line: Line;
  positions: Float32Array;
  origin: Vector3;
  direction: Vector3;
  travel: number;
  head: number;
  tail: number;
  speed: number;
  trail: number;
  life: number;
  maxLife: number;
  intensity: number;
}

/** Visual muzzle velocity. Well below real ballistics so the streak reads. */
const TRACER_SPEED = 340;
const TRACER_MAX_LIFE = 0.45;
/** Every Nth round is a bright tracer; the rest are dim, short scratches. */
const TRACER_CADENCE = 3;
/** Covers a full automatic burst at the configured visual lifetime. */
const TRACER_POOL_SIZE = 12;

/** Rounds over which sustained fire reaches its full recoil climb. */
const RECOIL_CLIMB_ROUNDS = 7;
/** Idle time after which the recoil pattern walks back to its first round. */
const RECOIL_PATTERN_RESET = 0.32;

export type { WeaponId };

export interface WeaponDef {
  id: WeaponId;
  name: string;
  damage: number;
  headMult: number;
  limbMult: number;
  rpm: number;
  magSize: number;
  reserveMax: number;
  reloadTime: number;
  range: number;
  automatic: boolean;
  recoilPitch: number;
  recoilYaw: number;
  adsSpread: number;
  hipSpread: number;
  melee?: boolean;
}

export interface AmmoState {
  mag: number;
  reserve: number;
  magSize: number;
}

export interface WeaponSystemCallbacks {
  onFire?: (weapon: WeaponId, hit: HitscanHit | null) => void;
  onHit?: (enemy: HitscanEnemy, bodyPart: BodyPart | undefined, damage: number, hit: HitscanHit) => void;
  onKill?: (enemy: HitscanEnemy, bodyPart: BodyPart | undefined, hit: HitscanHit) => void;
  onReload?: (weapon: WeaponId, empty: boolean) => void;
  onShot?: (record: ShotRecord) => void;
  /**
   * Transient camera recoil in radians. Aim-changing recoil is applied to the
   * player inside this system; this is the separate view kick presentation owns.
   */
  onViewPunch?: (pitch: number, yaw: number, roll: number) => void;
  /** Trigger pulled on a genuinely empty weapon with nothing left in reserve. */
  onDryFire?: (weapon: WeaponId) => void;
}

export interface ShotRecord {
  tick: number;
  weapon: WeaponId;
  seed: number;
  origin: { x: number; y: number; z: number };
  direction: { x: number; y: number; z: number };
  hit: string | null;
  muzzleObstructed: boolean;
}

export interface WeaponSystemSnapshot {
  active: WeaponId;
  ammo: Record<'ar' | 'pistol', AmmoState>;
  fireCooldown: number;
  reloading: boolean;
  reloadTimer: number;
  ads: boolean;
  toggledAds: boolean;
  recoilPunchPitch: number;
  recoilPunchYaw: number;
  /** Position in the sustained-fire recoil pattern. */
  recoilShotIndex: number;
  /** Time left before the pattern resets to its first round. */
  recoilPatternTimer: number;
  /** Accumulated firing inaccuracy, 0→1. */
  spreadBloom: number;
  /** Latches empty-mag dry-fire so a held trigger clicks once, not every tick. */
  dryFireLatch: boolean;
  /** Prior-frame fire-held edge; needed for DOM firePressed after restore. */
  prevFire: boolean;
  randomState: number;
}

export interface WeaponSystemOptions {
  player: PlayerController;
  camera: PerspectiveCamera;
  /** Dedicated origin-relative camera used only for viewmodel presentation. */
  viewModelCamera?: PerspectiveCamera;
  colliders?: WorldCollider[];
  /** Dedicated presentation scene; world rendering is kept separate. */
  viewModelScene?: Scene;
  /** Optional world scene used to preallocate tracer geometry before combat. */
  scene?: Scene;
  /** Serializable randomness for every simulation-affecting shot. */
  random?: SeededRandom;
  /** Separate visual stream so render effects never consume combat RNG. */
  presentationRandom?: RandomSource;
  physicsWorld?: PhysicsWorld;
  callbacks?: WeaponSystemCallbacks;
  /**
   * When false, skip DOM key/mouse listeners. GameSession + PlayerController
   * own InputFrame sampling; WeaponSystem only consumes setSessionInput.
   * Defaults to true for isolated/standalone harness use.
   */
  captureDomInput?: boolean;
}

const WEAPON_DEFS: Record<WeaponId, WeaponDef> = {
  ar: {
    id: 'ar',
    name: 'Assault Rifle',
    damage: 28,
    headMult: 1.6,
    limbMult: 0.85,
    rpm: 700,
    magSize: 30,
    reserveMax: 120,
    reloadTime: 1.85,
    range: 220,
    automatic: true,
    recoilPitch: 0.018,
    recoilYaw: 0.009,
    adsSpread: 0.0026,
    hipSpread: 0.022,
  },
  pistol: {
    id: 'pistol',
    name: 'Sidearm',
    damage: 34,
    headMult: 2.0,
    limbMult: 0.8,
    rpm: 280,
    magSize: 12,
    reserveMax: 48,
    reloadTime: 1.35,
    range: 120,
    automatic: false,
    recoilPitch: 0.028,
    recoilYaw: 0.014,
    adsSpread: 0.004,
    hipSpread: 0.018,
  },
  knife: {
    id: 'knife',
    name: 'Combat Knife',
    damage: 75,
    headMult: 1.5,
    limbMult: 1.0,
    rpm: 90,
    magSize: 0,
    reserveMax: 0,
    reloadTime: 0,
    range: 2.2,
    automatic: false,
    recoilPitch: 0,
    recoilYaw: 0,
    adsSpread: 0,
    hipSpread: 0,
    melee: true,
  },
};

const SLOT_ORDER: WeaponId[] = ['ar', 'pistol', 'knife'];

/**
 * FPS weapon system: AR / Pistol / Knife.
 * LMB fire, R reload, 1/2/3 switch, RMB ADS, scroll switch.
 * Hitscan via combat/Hitscan helper. Recoil + ammo state + combat callbacks.
 */
export class WeaponSystem {
  readonly viewModel: ViewModel;
  readonly defs = WEAPON_DEFS;

  onFire: WeaponSystemCallbacks['onFire'];
  onHit: WeaponSystemCallbacks['onHit'];
  onKill: WeaponSystemCallbacks['onKill'];
  onReload: WeaponSystemCallbacks['onReload'];
  onShot: WeaponSystemCallbacks['onShot'];
  onViewPunch: WeaponSystemCallbacks['onViewPunch'];
  onDryFire: WeaponSystemCallbacks['onDryFire'];

  private readonly player: PlayerController;
  private readonly camera: PerspectiveCamera;
  private readonly random: SeededRandom;
  private colliders: WorldCollider[];
  private physicsWorld: PhysicsWorld | null;

  private active: WeaponId = 'ar';
  private readonly ammo: Record<'ar' | 'pistol', AmmoState> = {
    ar: { mag: 30, reserve: 90, magSize: 30 },
    pistol: { mag: 12, reserve: 36, magSize: 12 },
  };

  private fireCooldown = 0;
  private reloading = false;
  private reloadTimer = 0;
  private ads = false;
  private toggleAdsEnabled = false;
  private toggledAds = false;
  private authoredRifleOnly = false;
  private sessionInput: Readonly<InputFrame> | null = null;
  private fireHeld = false;
  private firePressed = false;
  private prevFire = false;
  private pendingFirePressed = false;
  private pendingAimPressed = false;
  private pendingReload = false;
  private pendingWeaponSlot: 1 | 2 | 3 | undefined;
  private pendingWeaponCycle: -1 | 0 | 1 = 0;

  private recoilPunchPitch = 0;
  private recoilPunchYaw = 0;
  /**
   * Recoil is a repeatable pattern indexed by round, not fresh noise each shot.
   * Players can learn and counter it, which is the core of modern gunplay. All
   * three fields are simulation state and are snapshotted for replay.
   */
  private recoilShotIndex = 0;
  private recoilPatternTimer = 0;
  private spreadBloom = 0;
  private dryFireLatch = false;

  private readonly keys = new Set<string>();
  private disposeFns: Array<() => void> = [];
  private readonly tracers: TracerLine[] = [];
  private readonly tracerPool: TracerLine[] = [];
  private scene: Scene | null = null;
  private simulationTick = 0;
  private readonly shotRecords: ShotRecord[] = [];
  private muzzleObstructed = false;

  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly _forward = new Vector3();
  private readonly _right = new Vector3();
  private readonly _up = new Vector3();
  private readonly _muzzle = new Vector3();
  private readonly _tracerEnd = new Vector3();

  constructor(options: WeaponSystemOptions) {
    this.player = options.player;
    this.camera = options.camera;
    this.colliders = options.colliders ?? [];
    this.physicsWorld = options.physicsWorld ?? null;
    this.onFire = options.callbacks?.onFire;
    this.onHit = options.callbacks?.onHit;
    this.onKill = options.callbacks?.onKill;
    this.onReload = options.callbacks?.onReload;
    this.onShot = options.callbacks?.onShot;
    this.onViewPunch = options.callbacks?.onViewPunch;
    this.onDryFire = options.callbacks?.onDryFire;
    this.random = options.random ?? new SeededRandom(0x5745504e);
    this.scene = options.scene ?? null;

    this.viewModel = new ViewModel(
      options.viewModelCamera ?? this.camera,
      options.viewModelScene,
      options.presentationRandom,
    );
    if (this.scene) this.initializeTracerPool(this.scene);
    // GameSession play path disables this so only PlayerController samples DOM.
    if (options.captureDomInput !== false) {
      this.bindInput();
    }
  }

  setColliders(colliders: WorldCollider[]): void {
    this.colliders = colliders;
  }

  setPhysicsWorld(physicsWorld: PhysicsWorld | null): void {
    this.physicsWorld = physicsWorld;
  }

  /** Supplies the immutable input sampled for the current fixed tick. */
  setSessionInput(input: Readonly<InputFrame> | null): void {
    this.sessionInput = input;
  }

  setAuthoredRifleOnly(enabled: boolean): void {
    this.authoredRifleOnly = enabled;
    if (!enabled || this.active === 'ar') return;
    this.reloading = false;
    this.reloadTimer = 0;
    this.active = 'ar';
    this.viewModel.switchWeapon('ar');
  }

  getActiveWeapon(): WeaponId {
    return this.active;
  }

  getActiveDef(): WeaponDef {
    return WEAPON_DEFS[this.active];
  }

  getAmmo(): AmmoState | null {
    if (this.active === 'knife') return null;
    return { ...this.ammo[this.active] };
  }

  /** Deterministic encounter reward; returns the rounds actually accepted. */
  resupply(rounds: Partial<Record<'ar' | 'pistol', number>>): { ar: number; pistol: number } {
    const added = { ar: 0, pistol: 0 };
    for (const weapon of ['ar', 'pistol'] as const) {
      const requested = Math.max(0, Math.floor(rounds[weapon] ?? 0));
      const before = this.ammo[weapon].reserve;
      this.ammo[weapon].reserve = Math.min(
        WEAPON_DEFS[weapon].reserveMax,
        before + requested,
      );
      added[weapon] = this.ammo[weapon].reserve - before;
    }
    return added;
  }

  isADS(): boolean {
    return this.ads && this.active !== 'knife' && !this.reloading;
  }

  setToggleADS(enabled: boolean): void {
    this.toggleAdsEnabled = enabled;
    this.toggledAds = false;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  /** Current view recoil punch (radians) — apply to look or read for HUD. */
  getRecoilPunch(): { pitch: number; yaw: number } {
    return { pitch: this.recoilPunchPitch, yaw: this.recoilPunchYaw };
  }

  setSimulationTick(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < 0) throw new RangeError('tick must be a non-negative integer');
    this.simulationTick = tick;
  }

  getShotRecords(): readonly ShotRecord[] {
    return this.shotRecords.map((record) => ({
      ...record,
      origin: { ...record.origin },
      direction: { ...record.direction },
    }));
  }

  snapshotState(): WeaponSystemSnapshot {
    return {
      active: this.active,
      ammo: { ar: { ...this.ammo.ar }, pistol: { ...this.ammo.pistol } },
      fireCooldown: this.fireCooldown,
      reloading: this.reloading,
      reloadTimer: this.reloadTimer,
      ads: this.ads,
      toggledAds: this.toggledAds,
      recoilPunchPitch: this.recoilPunchPitch,
      recoilPunchYaw: this.recoilPunchYaw,
      recoilShotIndex: this.recoilShotIndex,
      recoilPatternTimer: this.recoilPatternTimer,
      spreadBloom: this.spreadBloom,
      dryFireLatch: this.dryFireLatch,
      prevFire: this.prevFire,
      randomState: this.random.snapshot(),
    };
  }

  restoreState(snapshot: WeaponSystemSnapshot): void {
    this.active = snapshot.active;
    Object.assign(this.ammo.ar, snapshot.ammo.ar);
    Object.assign(this.ammo.pistol, snapshot.ammo.pistol);
    this.fireCooldown = Math.max(0, snapshot.fireCooldown);
    this.reloading = snapshot.reloading;
    this.reloadTimer = Math.max(0, snapshot.reloadTimer);
    this.ads = snapshot.ads;
    this.toggledAds = snapshot.toggledAds;
    this.recoilPunchPitch = Number.isFinite(snapshot.recoilPunchPitch)
      ? snapshot.recoilPunchPitch
      : 0;
    this.recoilPunchYaw = Number.isFinite(snapshot.recoilPunchYaw)
      ? snapshot.recoilPunchYaw
      : 0;
    // Older checkpoints predate the recoil pattern; a missing field restores as
    // a fresh pattern rather than rejecting the checkpoint.
    this.recoilShotIndex = Number.isSafeInteger(snapshot.recoilShotIndex)
      ? Math.max(0, snapshot.recoilShotIndex)
      : 0;
    this.recoilPatternTimer = Number.isFinite(snapshot.recoilPatternTimer)
      ? Math.max(0, snapshot.recoilPatternTimer)
      : 0;
    this.spreadBloom = Number.isFinite(snapshot.spreadBloom)
      ? MathUtils.clamp(snapshot.spreadBloom, 0, 1)
      : 0;
    // Older checkpoints omit edge/latch bits; missing → unlatched / rising edge free.
    this.dryFireLatch = snapshot.dryFireLatch === true;
    this.prevFire = snapshot.prevFire === true;
    this.random.restore(snapshot.randomState);
    this.viewModel.switchWeapon(snapshot.active);
    // switchWeapon no-ops on the already-drawn gun, so a paused rewind would
    // keep kick/heat/brass/flash. Snap presentation, then replay a mid-reload.
    this.viewModel.resetPresentation(snapshot.ads && !snapshot.reloading);
    if (snapshot.reloading) {
      this.viewModel.playReload(
        Math.max(0.01, snapshot.reloadTimer),
        snapshot.active !== 'knife' && snapshot.ammo[snapshot.active].mag <= 0,
      );
    }
    this.clearTracers();
  }

  /** Restores a fresh loadout without touching the shared simulation RNG. */
  reset(): void {
    this.active = 'ar';
    this.ammo.ar.mag = WEAPON_DEFS.ar.magSize;
    this.ammo.ar.reserve = 90;
    this.ammo.ar.magSize = WEAPON_DEFS.ar.magSize;
    this.ammo.pistol.mag = WEAPON_DEFS.pistol.magSize;
    this.ammo.pistol.reserve = 36;
    this.ammo.pistol.magSize = WEAPON_DEFS.pistol.magSize;
    this.fireCooldown = 0;
    this.reloading = false;
    this.reloadTimer = 0;
    this.ads = false;
    this.toggledAds = false;
    this.recoilPunchPitch = 0;
    this.recoilPunchYaw = 0;
    this.recoilShotIndex = 0;
    this.recoilPatternTimer = 0;
    this.spreadBloom = 0;
    this.dryFireLatch = false;
    this.fireHeld = false;
    this.firePressed = false;
    this.prevFire = false;
    this.pendingFirePressed = false;
    this.pendingAimPressed = false;
    this.pendingReload = false;
    this.pendingWeaponSlot = undefined;
    this.pendingWeaponCycle = 0;
    this.shotRecords.length = 0;
    this.viewModel.switchWeapon('ar');
    this.viewModel.resetPresentation(false);
    this.clearTracers();
    if (this.authoredRifleOnly) this.setAuthoredRifleOnly(true);
  }

  /**
   * Total angular spread for the next shot, including sustained-fire bloom and
   * movement penalties. The HUD reads this so the crosshair matches the cone the
   * simulation actually uses.
   */
  getCurrentSpread(): number {
    const def = WEAPON_DEFS[this.active];
    if (def.melee) return 0;
    return (this.ads ? def.adsSpread : def.hipSpread) * this.spreadMultiplier();
  }

  /** Accumulated firing inaccuracy, 0→1. */
  getSpreadBloom(): number {
    return this.spreadBloom;
  }

  switchWeapon(id: WeaponId): void {
    if (this.authoredRifleOnly && id !== 'ar') return;
    if (id === this.active) return;
    if (this.reloading) {
      this.reloading = false;
      this.reloadTimer = 0;
    }
    this.active = id;
    this.viewModel.switchWeapon(id);
    this.fireCooldown = 0.15;
  }

  switchSlot(slot: 1 | 2 | 3): void {
    const id = SLOT_ORDER[slot - 1];
    if (id) this.switchWeapon(id);
  }

  cycleWeapon(dir: number): void {
    const idx = SLOT_ORDER.indexOf(this.active);
    const next = (idx + (dir > 0 ? 1 : -1) + SLOT_ORDER.length) % SLOT_ORDER.length;
    this.switchWeapon(SLOT_ORDER[next]);
  }

  startReload(): void {
    if (this.active === 'knife' || this.reloading) return;
    const a = this.ammo[this.active];
    if (a.mag >= a.magSize || a.reserve <= 0) return;

    const def = WEAPON_DEFS[this.active];
    // Running the weapon dry costs the bolt-release beat. Reloading before empty
    // is the faster option, which is what makes magazine discipline matter.
    const empty = a.mag <= 0;
    this.reloading = true;
    this.reloadTimer = def.reloadTime * (empty ? 1.14 : 1);
    this.ads = false;
    // A reload resets the learned recoil pattern and clears accumulated bloom.
    this.recoilShotIndex = 0;
    this.recoilPatternTimer = 0;
    this.spreadBloom = 0;
    this.viewModel.playReload(this.reloadTimer, empty);
    this.onReload?.(this.active, empty);
  }

  /**
   * Per-frame update.
   * @param dt seconds
   * @param scene scene (tracers attach here)
   * @param enemies hitscan targets
   */
  update(dt: number, scene: Scene, enemies: HitscanEnemy[]): void {
    const clampedDt = Math.min(dt, 0.05);
    this.scene = scene;
    this.initializeTracerPool(scene);

    const input = this.sessionInput;
    // When GameSession drives combat, InputFrame is the only authority — never
    // mix in DOM pending*/keys (those duplicate PlayerController sampling).
    // Local DOM state remains only as a standalone fallback when sessionInput
    // is null. Pointer lock is presentation-only (look/pause).
    const sessionDriven = input !== null;
    const aimHeld = sessionDriven ? input.aim : this.keys.has('MouseRight');
    const aimPressed = sessionDriven ? input.aimPressed : this.pendingAimPressed;
    if (this.toggleAdsEnabled && aimPressed) {
      this.toggledAds = !this.toggledAds;
    }
    const requestedSlot = sessionDriven ? input.weaponSlot : this.pendingWeaponSlot;
    if (requestedSlot) this.switchSlot(requestedSlot);
    const requestedCycle = sessionDriven ? input.weaponCycle : this.pendingWeaponCycle;
    if (requestedCycle !== 0) this.cycleWeapon(requestedCycle);
    if (sessionDriven ? input.reload : this.pendingReload) this.startReload();

    const wantAds = this.toggleAdsEnabled
      ? this.toggledAds
      : aimHeld;
    this.ads =
      wantAds &&
      this.active !== 'knife' &&
      !this.reloading &&
      !this.player.isSprinting();

    // Fire state
    this.fireHeld = sessionDriven
      ? input.fire
      : (this.keys.has('MouseLeft') || this.player.isFireHeld());
    this.firePressed = sessionDriven
      ? input.firePressed
      : (this.pendingFirePressed || (this.fireHeld && !this.prevFire));
    this.prevFire = this.fireHeld;
    this.consumeActionEdges();

    // Reload
    if (this.reloading) {
      this.reloadTimer -= clampedDt;
      if (this.reloadTimer <= 0) {
        this.finishReload();
      }
    }

    // Cooldown
    if (this.fireCooldown > 0) {
      this.fireCooldown = Math.max(0, this.fireCooldown - clampedDt);
    }

    // Pose — sprint pose only when still sprinting (fire already cancels sprint on the player).
    if (this.reloading) {
      this.viewModel.setPose('reload');
    } else if (this.player.isSprinting() && this.player.isMoving()) {
      this.viewModel.setPose('sprint');
    } else if (this.ads) {
      this.viewModel.setPose('ads');
    } else {
      this.viewModel.setPose('hip');
    }

    // Fire: movement never blocks shots. Sprint is cancelled by fire on the player,
    // so canFire stays free of the old !(sprint && move && !fireHeld) gate.
    const def = WEAPON_DEFS[this.active];
    const canFire =
      !this.player.isDead() &&
      !this.reloading &&
      this.fireCooldown <= 0;

    if (canFire) {
      if (def.melee) {
        if (this.firePressed) this.fireMelee(enemies, def);
      } else if (def.automatic) {
        if (this.fireHeld) this.fireHitscan(enemies, def);
      } else if (this.firePressed) {
        this.fireHitscan(enemies, def);
      }
    }

    // Dry fire: a dead trigger needs its own click so the player learns they are
    // out rather than wondering whether the input was dropped.
    if (!def.melee && !this.reloading) {
      const ammo = this.ammo[this.active as 'ar' | 'pistol'];
      const dead = ammo.mag <= 0 && ammo.reserve <= 0;
      if (dead && this.fireHeld && !this.dryFireLatch) {
        this.dryFireLatch = true;
        this.onDryFire?.(this.active);
      }
      if (!this.fireHeld) this.dryFireLatch = false;
    } else {
      this.dryFireLatch = false;
    }

    // Auto-reload on empty
    if (
      !this.reloading &&
      this.active !== 'knife' &&
      this.ammo[this.active].mag <= 0 &&
      this.ammo[this.active].reserve > 0
    ) {
      this.startReload();
    }

    // Recoil punch recovery — snappy settle back to iron sights
    this.recoilPunchPitch = MathUtils.damp(this.recoilPunchPitch, 0, 22, clampedDt);
    this.recoilPunchYaw = MathUtils.damp(this.recoilPunchYaw, 0, 22, clampedDt);

    // Sustained-fire state relaxes once the trigger is released.
    this.spreadBloom = MathUtils.damp(this.spreadBloom, 0, 3.6, clampedDt);
    if (this.recoilPatternTimer > 0) {
      this.recoilPatternTimer = Math.max(0, this.recoilPatternTimer - clampedDt);
      if (this.recoilPatternTimer <= 0) this.recoilShotIndex = 0;
    }

    this.feedViewModelMotion(input);
    this.updateTracers(clampedDt);
    this.viewModel.update(clampedDt);
  }

  /**
   * Hands the viewmodel its sway inputs. Everything here comes from the fixed
   * tick's own frame or from already-stepped simulation state, so presentation
   * lag can never feed back into combat or diverge between replays.
   */
  private feedViewModelMotion(input: Readonly<InputFrame> | null): void {
    this.viewModel.applyLookSway(input?.lookX ?? 0, input?.lookY ?? 0);
    const speed = typeof this.player.getHorizontalSpeed === 'function'
      ? this.player.getHorizontalSpeed()
      : 0;
    const grounded = typeof this.player.isGrounded === 'function'
      ? this.player.isGrounded()
      : true;
    this.viewModel.setMovementState(speed, input?.moveX ?? 0, !grounded);
  }

  /** Sustained fire and movement both widen the cone the hitscan actually uses. */
  private spreadMultiplier(): number {
    const bloom = 1 + this.spreadBloom * (this.ads ? 0.85 : 1.7);
    const moving = typeof this.player.isMoving === 'function' && this.player.isMoving();
    const sprinting = typeof this.player.isSprinting === 'function' && this.player.isSprinting();
    const movement = sprinting ? 1.6 : moving ? 1.22 : 1;
    return bloom * movement;
  }

  private fireHitscan(enemies: HitscanEnemy[], def: WeaponDef): void {
    const slot = this.active as 'ar' | 'pistol';
    const a = this.ammo[slot];
    if (a.mag <= 0) {
      this.startReload();
      return;
    }

    a.mag -= 1;
    this.fireCooldown = 60 / def.rpm;

    // Spread grows with sustained fire and movement, so tapping is rewarded.
    const spread = (this.ads ? def.adsSpread : def.hipSpread) * this.spreadMultiplier();
    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this._forward);

    const seed = this.random.snapshot();
    const sx = (this.random.next() - 0.5) * 2 * spread;
    const sy = (this.random.next() - 0.5) * 2 * spread;
    this.direction.copy(this._forward);
    // Build orthonormal basis for spread
    this._right.crossVectors(this._forward, this.camera.up).normalize();
    this._up.crossVectors(this._right, this._forward).normalize();
    this.direction.addScaledVector(this._right, sx).addScaledVector(this._up, sy).normalize();

    const hit = this.resolveHitscan(enemies, def.range);

    const shotIndex = this.recoilShotIndex;
    this.spawnTracer(
      this.origin,
      this.direction,
      hit?.distance ?? def.range,
      this._right,
      this._up,
      shotIndex % TRACER_CADENCE === 0,
    );

    // Recoil — a learnable pattern rather than symmetric noise. Vertical climb
    // ramps over the first rounds and the horizontal walk follows a fixed curve,
    // with only a small random component on top.
    const adsMul = this.ads ? 0.55 : 1;
    const climb = Math.min(1, shotIndex / RECOIL_CLIMB_ROUNDS);
    const pattern = Math.sin(shotIndex * 1.24) * 0.62 + Math.sin(shotIndex * 0.37) * 0.38;
    const pitchKick = def.recoilPitch * adsMul
      * (0.82 + climb * 0.7) * (0.9 + this.random.next() * 0.2);
    const yawKick = def.recoilYaw * adsMul
      * (pattern * (0.55 + climb * 0.9) + (this.random.next() - 0.5) * 0.55);
    this.recoilPunchPitch += pitchKick;
    this.recoilPunchYaw += yawKick;
    this.player.addLookDelta(pitchKick, yawKick);

    this.recoilShotIndex = shotIndex + 1;
    this.recoilPatternTimer = RECOIL_PATTERN_RESET;
    this.spreadBloom = MathUtils.clamp(
      this.spreadBloom + (def.automatic ? 0.085 : 0.17),
      0,
      1,
    );

    this.viewModel.kickOnFire(this.ads ? 0.7 : 1.1, this.ads);
    // Camera view punch is deliberately larger than the aim punch and returns to
    // zero, so a burst feels heavy without stealing the player's aim twice.
    this.onViewPunch?.(pitchKick * 1.5, yawKick * 1.2, yawKick * 2.4);

    this.onFire?.(this.active, hit);
    this.applyHitDamage(hit, def);
    this.recordShot(seed, hit);
  }

  /**
   * Spawns a travelling tracer. The streak starts offset toward the muzzle so
   * rounds visibly leave the barrel instead of the centre of the screen, then
   * flies to the impact point over several frames.
   */
  private spawnTracer(
    origin: Vector3,
    direction: Vector3,
    length: number,
    right: Vector3,
    up: Vector3,
    bright: boolean,
  ): void {
    if (!this.scene) return;
    this.initializeTracerPool(this.scene);
    let tracer: TracerLine | undefined;
    for (const candidate of this.tracerPool) {
      if (!candidate.active) {
        tracer = candidate;
        break;
      }
    }
    if (!tracer) {
      // Pool exhaustion is presentation-only. Recycle the oldest line instead
      // of allocating in the middle of an unusually dense burst.
      tracer = this.tracers.shift();
      if (!tracer) return;
      tracer.active = false;
    }
    const travel = MathUtils.clamp(length, 1.2, 240);
    this._muzzle.copy(origin)
      .addScaledVector(direction, 0.5)
      .addScaledVector(right, this.ads ? 0.02 : 0.16)
      .addScaledVector(up, this.ads ? -0.03 : -0.1);
    const positions = tracer.positions;
    positions[0] = this._muzzle.x;
    positions[1] = this._muzzle.y;
    positions[2] = this._muzzle.z;
    positions[3] = this._muzzle.x;
    positions[4] = this._muzzle.y;
    positions[5] = this._muzzle.z;
    tracer.origin.copy(this._muzzle);
    tracer.direction.copy(direction);
    tracer.travel = travel;
    tracer.head = 0;
    tracer.tail = 0;
    tracer.speed = TRACER_SPEED;
    tracer.trail = bright ? 9 : 3.2;
    tracer.life = 0;
    tracer.maxLife = TRACER_MAX_LIFE;
    tracer.intensity = bright ? 0.95 : 0.4;
    tracer.active = true;
    tracer.line.visible = true;
    tracer.line.geometry.attributes.position.needsUpdate = true;
    const material = tracer.line.material as LineBasicMaterial;
    material.color.setHex(bright ? 0xfff0c0 : 0xffb060);
    material.opacity = tracer.intensity;
    this.tracers.push(tracer);
  }

  private updateTracers(dt: number): void {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const t = this.tracers[i];
      t.life += dt;
      t.head = Math.min(t.travel, t.head + t.speed * dt);
      // The tail only starts chasing once the streak has reached full length,
      // which keeps a short-range shot from vanishing before it is visible.
      t.tail = Math.max(0, Math.min(t.head - t.trail, t.travel));

      this._tracerEnd.copy(t.origin).addScaledVector(t.direction, t.head);
      t.positions[0] = t.origin.x + t.direction.x * t.tail;
      t.positions[1] = t.origin.y + t.direction.y * t.tail;
      t.positions[2] = t.origin.z + t.direction.z * t.tail;
      t.positions[3] = this._tracerEnd.x;
      t.positions[4] = this._tracerEnd.y;
      t.positions[5] = this._tracerEnd.z;
      t.line.geometry.attributes.position.needsUpdate = true;

      const mat = t.line.material as LineBasicMaterial;
      const fade = t.head >= t.travel
        ? Math.max(0, 1 - (t.tail / Math.max(t.travel, 1e-3)))
        : 1;
      mat.opacity = t.intensity * fade;

      if ((t.head >= t.travel && t.tail >= t.travel) || t.life >= t.maxLife) {
        this.releaseTracer(t);
        this.tracers.splice(i, 1);
      }
    }
  }

  private initializeTracerPool(scene: Scene): void {
    if (this.tracerPool.length > 0) {
      for (const tracer of this.tracerPool) {
        if (tracer.line.parent !== scene) scene.add(tracer.line);
      }
      return;
    }
    for (let index = 0; index < TRACER_POOL_SIZE; index += 1) {
      const positions = new Float32Array(6);
      const geometry = new BufferGeometry();
      geometry.setAttribute(
        'position',
        new BufferAttribute(positions, 3).setUsage(DynamicDrawUsage),
      );
      const material = new LineBasicMaterial({
        color: 0xffb060,
        transparent: true,
        opacity: 0,
        depthWrite: false,
        blending: AdditiveBlending,
      });
      const line = new Line(geometry, material);
      line.name = `TracerPool:${index}`;
      line.frustumCulled = false;
      line.visible = false;
      scene.add(line);
      this.tracerPool.push({
        active: false,
        line,
        positions,
        origin: new Vector3(),
        direction: new Vector3(),
        travel: 0,
        head: 0,
        tail: 0,
        speed: TRACER_SPEED,
        trail: 0,
        life: 0,
        maxLife: TRACER_MAX_LIFE,
        intensity: 0,
      });
    }
  }

  private releaseTracer(tracer: TracerLine): void {
    tracer.active = false;
    tracer.line.visible = false;
    (tracer.line.material as LineBasicMaterial).opacity = 0;
  }

  /** Drop live streaks so a paused rematch cannot keep rounds in flight. */
  private clearTracers(): void {
    for (const tracer of this.tracers) this.releaseTracer(tracer);
    this.tracers.length = 0;
  }

  /** Live tracer streaks, for tests and debug overlays. */
  getActiveTracerCount(): number {
    return this.tracers.length;
  }

  private fireMelee(enemies: HitscanEnemy[], def: WeaponDef): void {
    this.fireCooldown = 60 / def.rpm;
    this.viewModel.kickMelee();
    // A knife swing throws the whole view rather than kicking it upward.
    this.onViewPunch?.(-0.012, 0.02, 0.05);

    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this.direction);

    const hit = this.resolveHitscan(enemies, def.range);
    const seed = this.random.snapshot();
    this.onFire?.(this.active, hit);
    this.applyHitDamage(hit, def);
    this.recordShot(seed, hit);
  }

  private recordShot(seed: number, hit: HitscanHit | null): void {
    const record: ShotRecord = {
      tick: this.simulationTick,
      weapon: this.active,
      seed,
      origin: { x: this.origin.x, y: this.origin.y, z: this.origin.z },
      direction: { x: this.direction.x, y: this.direction.y, z: this.direction.z },
      hit: !hit || (!hit.hitWorld && !hit.enemy)
        ? null
        : hit.hitWorld
          ? 'world'
          : hit.bodyPart ?? 'enemy',
      muzzleObstructed: this.muzzleObstructed,
    };
    this.shotRecords.push(record);
    if (this.shotRecords.length > 256) this.shotRecords.shift();
    this.onShot?.(record);
  }

  private resolveHitscan(enemies: HitscanEnemy[], range: number): HitscanHit {
    this.muzzleObstructed = false;
    const hit = hitscan(
      this.origin,
      this.direction,
      enemies,
      this.physicsWorld ? [] : this.colliders,
      range,
    );
    const muzzleHit = this.physicsWorld?.castRay({
      origin: this.origin,
      direction: this.direction,
      maxDistance: Math.min(range, 0.55),
      includeCharacters: false,
    });
    if (muzzleHit) {
      this.muzzleObstructed = true;
      return {
        point: new Vector3(muzzleHit.point.x, muzzleHit.point.y, muzzleHit.point.z),
        normal: new Vector3(muzzleHit.normal.x, muzzleHit.normal.y, muzzleHit.normal.z),
        distance: muzzleHit.distance,
        hitWorld: true,
      };
    }
    const worldHit = this.physicsWorld?.castRay({
      origin: this.origin,
      direction: this.direction,
      maxDistance: range,
      includeCharacters: false,
    });
    if (!worldHit || worldHit.distance > hit.distance) return hit;
    return {
      point: new Vector3(worldHit.point.x, worldHit.point.y, worldHit.point.z),
      normal: new Vector3(worldHit.normal.x, worldHit.normal.y, worldHit.normal.z),
      distance: worldHit.distance,
      hitWorld: true,
    };
  }

  private applyHitDamage(hit: HitscanHit, def: WeaponDef): void {
    if (!hit.enemy || hit.hitWorld) return;

    let dmg = def.damage;
    if (hit.bodyPart === 'head') dmg *= def.headMult;
    else if (
      hit.bodyPart === 'limbs' ||
      hit.bodyPart === 'arm' ||
      hit.bodyPart === 'leg'
    ) {
      dmg *= def.limbMult;
    }

    // Mild falloff for firearms
    if (!def.melee) {
      const falloff = MathUtils.clamp(1 - hit.distance / def.range, 0.55, 1);
      dmg *= falloff;
    }

    dmg = Math.round(dmg);
    const killed = hit.enemy.takeDamage(dmg, hit.bodyPart);
    this.onHit?.(hit.enemy, hit.bodyPart, dmg, hit);
    if (killed) {
      this.onKill?.(hit.enemy, hit.bodyPart, hit);
    }
  }

  private finishReload(): void {
    if (this.active === 'knife') {
      this.reloading = false;
      return;
    }
    const a = this.ammo[this.active];
    const need = a.magSize - a.mag;
    const take = Math.min(need, a.reserve);
    a.mag += take;
    a.reserve -= take;
    this.reloading = false;
    this.reloadTimer = 0;
  }

  private bindInput(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      const freshPress = !this.keys.has(e.code);
      this.keys.add(e.code);
      if (freshPress && e.code === 'KeyR') this.pendingReload = true;
      if (freshPress && (e.code === 'Digit1' || e.code === 'Numpad1')) this.pendingWeaponSlot = 1;
      if (freshPress && (e.code === 'Digit2' || e.code === 'Numpad2')) this.pendingWeaponSlot = 2;
      if (freshPress && (e.code === 'Digit3' || e.code === 'Numpad3')) this.pendingWeaponSlot = 3;
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) {
        if (!this.keys.has('MouseLeft')) this.pendingFirePressed = true;
        this.keys.add('MouseLeft');
      }
      if (e.button === 2) {
        if (!this.keys.has('MouseRight')) this.pendingAimPressed = true;
        this.keys.add('MouseRight');
      }
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.keys.delete('MouseLeft');
      if (e.button === 2) this.keys.delete('MouseRight');
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.player.isPointerLocked()) return;
      e.preventDefault();
      this.pendingWeaponCycle = e.deltaY > 0 ? 1 : -1;
    };

    const onBlur = () => {
      this.keys.clear();
      this.fireHeld = false;
      this.prevFire = false;
      this.toggledAds = false;
      this.pendingFirePressed = false;
      this.pendingAimPressed = false;
      this.pendingReload = false;
      this.pendingWeaponSlot = undefined;
      this.pendingWeaponCycle = 0;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('wheel', onWheel, { passive: false });
    window.addEventListener('blur', onBlur);

    this.disposeFns.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('wheel', onWheel),
      () => window.removeEventListener('blur', onBlur),
    );
  }

  private consumeActionEdges(): void {
    this.pendingFirePressed = false;
    this.pendingAimPressed = false;
    this.pendingReload = false;
    this.pendingWeaponSlot = undefined;
    this.pendingWeaponCycle = 0;
    if (!this.sessionInput) return;
    this.sessionInput = {
      ...this.sessionInput,
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

  dispose(): void {
    for (const fn of this.disposeFns) fn();
    this.disposeFns.length = 0;
    this.sessionInput = null;
    this.clearTracers();
    for (const tracer of this.tracerPool) {
      tracer.line.removeFromParent();
      tracer.line.geometry.dispose();
      (tracer.line.material as LineBasicMaterial).dispose();
    }
    this.tracerPool.length = 0;
    this.viewModel.dispose();
  }
}
