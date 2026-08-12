import {
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from 'three';
import type { InputFrame, PhysicsWorld } from '../simulation';

/** Axis-aligned world collider used for FPS ground/wall collision. */
export interface WorldCollider {
  min: Vector3;
  max: Vector3;
}

export interface PlayerControllerOptions {
  /** Spawn position (feet). */
  position?: Vector3;
  walkSpeed?: number;
  sprintSpeed?: number;
  crouchSpeed?: number;
  jumpVelocity?: number;
  /** Mouse look sensitivity (radians per pixel). */
  sensitivity?: number;
  maxHealth?: number;
  maxArmor?: number;
  fov?: number;
  aspect?: number;
}

export interface PlayerStateSnapshot {
  position: { x: number; y: number; z: number };
  velocity: { x: number; y: number; z: number };
  health: number;
  armor: number;
  yaw: number;
  pitch: number;
  alive: boolean;
  crouching: boolean;
  grounded: boolean;
  sliding: boolean;
  slideTimer: number;
  mantleCooldown: number;
  eyeHeight: number;
}

const STAND_EYE = 1.62;
const CROUCH_EYE = 1.05;
const STAND_HALF_HEIGHT = 0.9;
const CROUCH_HALF_HEIGHT = 0.55;
const RADIUS = 0.32;
const GRAVITY = 28;
const TERMINAL_V = 48;

/** COD-like horizontal accel / friction (snappy but grounded). */
const GROUND_ACCEL = 85;
const AIR_ACCEL = 18;
const GROUND_FRICTION = 14;
const AIR_FRICTION = 1.2;
const SPRINT_THRESHOLD = 0.35;
const SLIDE_DURATION = 0.68;
const SLIDE_START_SPEED = 10.2;
const MANTLE_REACH = 0.78;
const MANTLE_MIN_HEIGHT = 0.42;
const MANTLE_MAX_HEIGHT = 1.28;

/**
 * Pointer-lock FPS player controller with COD-style movement feel.
 * Camera is a child of the player pivot (yaw on pivot, pitch on camera).
 */
export class PlayerController {
  /** World-space player root — yaw lives here; camera is a child. */
  readonly pivot: Object3D;
  readonly camera: PerspectiveCamera;

  /** Mouse look sensitivity (radians per pixel). */
  sensitivity: number;
  adsSensitivityMultiplier = 0.8;

  health: number;
  armor: number;
  readonly maxHealth: number;
  readonly maxArmor: number;

  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  jumpVelocity: number;

  private readonly position = new Vector3(0, 0, 0);
  private readonly previousPosition = new Vector3(0, 0, 0);
  private readonly velocity = new Vector3();
  private readonly wishDir = new Vector3();
  private readonly eyeWorld = new Vector3();
  private readonly _min = new Vector3();
  private readonly _max = new Vector3();
  private physicsWorld: PhysicsWorld | null = null;
  private physicsBodyId: string | null = null;
  private physicsCenterOffset = STAND_HALF_HEIGHT;
  private sessionInput: Readonly<InputFrame> | null = null;
  private pendingLookX = 0;
  private pendingLookY = 0;
  private pendingFirePressed = false;
  private pendingAimPressed = false;
  private pendingJump = false;
  private pendingReload = false;
  private pendingGrenade = false;
  private pendingInteract = false;
  private pendingWeaponSlot: 1 | 2 | 3 | undefined;
  private pendingWeaponCycle: -1 | 0 | 1 = 0;
  private previousSessionCrouch = false;

  private readonly keys = new Set<string>();
  /**
   * Keyboard codes still physically held across a pause unlock. clearInput wipes
   * `keys`, and the OS will not re-fire keydown until release — keyup/keydown
   * while suspended keep this set honest so resume can resyncHeldKeys.
   */
  private suspendedHeldKeys: Set<string> | null = null;
  private pointerLocked = false;
  private disposeFns: Array<() => void> = [];
  private attachElement: HTMLElement | null = null;

  private eyeHeight = STAND_EYE;
  private targetEyeHeight = STAND_EYE;
  private halfHeight = STAND_HALF_HEIGHT;
  private crouching = false;
  private wantCrouch = false;
  private jumpPressed = false;
  private sliding = false;
  private slideTimer = 0;
  private mantleCooldown = 0;
  private grounded = false;
  private wasGrounded = false;
  private justLanded = false;
  private landImpact = 0;
  private fallSpeedAtImpact = 0;
  private yaw = 0;
  private pitch = 0;
  private alive = true;

  /** Last damage taken (for CameraFeel shake hooks). */
  lastDamageAmount = 0;
  private damagePulse = 0;
  /**
   * Traversal feedback latches. These are consumed rather than reset per tick so
   * that a slide or mantle triggered from the standalone DOM path is still
   * observable by presentation, which runs later in the frame.
   */
  private slideStartSpeed = 0;
  private mantleHeight = 0;

  constructor(options: PlayerControllerOptions = {}) {
    this.maxHealth = options.maxHealth ?? 100;
    this.maxArmor = options.maxArmor ?? 100;
    this.health = this.maxHealth;
    this.armor = 50;

    this.walkSpeed = options.walkSpeed ?? 5.4;
    this.sprintSpeed = options.sprintSpeed ?? 8.6;
    this.crouchSpeed = options.crouchSpeed ?? 2.8;
    this.jumpVelocity = options.jumpVelocity ?? 8.2;
    this.sensitivity = options.sensitivity ?? 0.00215;

    if (options.position) {
      this.position.copy(options.position);
    }
    this.previousPosition.copy(this.position);

    this.pivot = new Object3D();
    this.pivot.name = 'PlayerPivot';

    this.camera = new PerspectiveCamera(
      options.fov ?? 75,
      options.aspect ??
        (typeof window !== 'undefined'
          ? window.innerWidth / window.innerHeight
          : 16 / 9),
      0.05,
      1200,
    );
    this.camera.name = 'PlayerCamera';
    this.pivot.add(this.camera);

    this.syncTransforms();
    this.bindInput();
  }

  /**
   * Attach pointer-lock + click-to-lock to a DOM element (typically the canvas).
   */
  attach(dom: HTMLElement): void {
    this.detachDom();
    this.attachElement = dom;

    const onClick = () => {
      if (!this.pointerLocked && this.alive) {
        dom.requestPointerLock?.();
      }
    };

    dom.addEventListener('click', onClick);
    this.disposeFns.push(() => dom.removeEventListener('click', onClick));
  }

  /** Detach only the DOM click listener from a previous attach(). */
  private detachDom(): void {
    // Click listeners are tracked in disposeFns; full dispose clears all.
    this.attachElement = null;
  }

  requestPointerLock(element?: HTMLElement): void {
    const el = element ?? this.attachElement ?? document.body;
    if (!this.pointerLocked) {
      el.requestPointerLock?.();
    }
  }

  isPointerLocked(): boolean {
    return this.pointerLocked;
  }

  getCamera(): PerspectiveCamera {
    return this.camera;
  }

  getPivot(): Object3D {
    return this.pivot;
  }

  getPosition(): Vector3 {
    return this.position.clone();
  }

  /** Feet position reference (mutable — do not modify unless intentional). */
  getPositionRef(): Vector3 {
    return this.position;
  }

  setPosition(x: number, y: number, z: number): void {
    this.position.set(x, y, z);
    this.previousPosition.copy(this.position);
    this.velocity.set(0, 0, 0);
    if (this.physicsWorld && this.physicsBodyId) {
      this.physicsWorld.teleportCharacter?.(this.physicsBodyId, {
        x,
        y: y + this.physicsCenterOffset,
        z,
      });
    }
    this.syncTransforms();
  }

  /** Switch collision authority from legacy development AABBs to PhysicsWorld. */
  setPhysicsWorld(physicsWorld: PhysicsWorld | null, bodyId = 'player'): void {
    this.physicsWorld = physicsWorld;
    this.physicsBodyId = physicsWorld ? bodyId : null;
    if (physicsWorld && this.physicsBodyId) {
      this.resizePhysicsCapsule(this.halfHeight);
      physicsWorld.teleportCharacter?.(this.physicsBodyId, {
        x: this.position.x,
        y: this.position.y + this.physicsCenterOffset,
        z: this.position.z,
      });
    }
  }

  getVelocity(): Vector3 {
    return this.velocity.clone();
  }

  /** Applies visual-only fixed-step interpolation without changing simulation state. */
  applyRenderInterpolation(alpha: number): void {
    this.pivot.position.lerpVectors(
      this.previousPosition,
      this.position,
      MathUtils.clamp(alpha, 0, 1),
    );
  }

  snapshotState(): PlayerStateSnapshot {
    return {
      position: { x: this.position.x, y: this.position.y, z: this.position.z },
      velocity: { x: this.velocity.x, y: this.velocity.y, z: this.velocity.z },
      health: this.health,
      armor: this.armor,
      yaw: this.yaw,
      pitch: this.pitch,
      alive: this.alive,
      crouching: this.crouching,
      grounded: this.grounded,
      sliding: this.sliding,
      slideTimer: this.slideTimer,
      mantleCooldown: this.mantleCooldown,
      eyeHeight: this.eyeHeight,
    };
  }

  restoreState(snapshot: PlayerStateSnapshot): void {
    this.clearInput();
    this.position.set(snapshot.position.x, snapshot.position.y, snapshot.position.z);
    this.previousPosition.copy(this.position);
    this.velocity.set(snapshot.velocity.x, snapshot.velocity.y, snapshot.velocity.z);
    this.health = MathUtils.clamp(snapshot.health, 0, this.maxHealth);
    this.armor = MathUtils.clamp(snapshot.armor, 0, this.maxArmor);
    this.alive = snapshot.alive;
    this.crouching = snapshot.crouching;
    this.wantCrouch = snapshot.crouching;
    // clearInput zeros the crouch edge latch; mirror restored pose so a held
    // crouch on the next session frame does not re-fire startSlide.
    this.previousSessionCrouch = snapshot.crouching;
    this.eyeHeight = MathUtils.clamp(
      snapshot.eyeHeight,
      Math.min(CROUCH_EYE, STAND_EYE),
      Math.max(CROUCH_EYE, STAND_EYE),
    );
    this.targetEyeHeight = snapshot.crouching ? CROUCH_EYE : STAND_EYE;
    this.halfHeight = snapshot.crouching ? CROUCH_HALF_HEIGHT : STAND_HALF_HEIGHT;
    this.resizePhysicsCapsule(this.halfHeight);
    this.yaw = snapshot.yaw;
    this.pitch = MathUtils.clamp(snapshot.pitch, -Math.PI * 0.49, Math.PI * 0.49);
    this.grounded = snapshot.grounded;
    this.wasGrounded = snapshot.grounded;
    this.sliding = snapshot.sliding && snapshot.crouching;
    this.slideTimer = Math.max(0, snapshot.slideTimer);
    this.mantleCooldown = Math.max(0, snapshot.mantleCooldown);
    this.justLanded = false;
    this.landImpact = 0;
    this.fallSpeedAtImpact = 0;
    if (this.physicsWorld && this.physicsBodyId) {
      this.physicsWorld.teleportCharacter?.(this.physicsBodyId, {
        x: this.position.x,
        y: this.position.y + this.physicsCenterOffset,
        z: this.position.z,
      });
    }
    this.syncTransforms();
  }

  getEyePosition(): Vector3 {
    this.eyeWorld.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z,
    );
    return this.eyeWorld.clone();
  }

  /** Writes eye position into `out` without allocating. */
  getEyePositionInto(out: Vector3): Vector3 {
    return out.set(
      this.position.x,
      this.position.y + this.eyeHeight,
      this.position.z,
    );
  }

  isGrounded(): boolean {
    return this.grounded;
  }

  isDead(): boolean {
    return !this.alive;
  }

  isAlive(): boolean {
    return this.alive;
  }

  getYaw(): number {
    return this.yaw;
  }

  getPitch(): number {
    return this.pitch;
  }

  /** Apply look punch (recoil / explosion) in radians. */
  addLookDelta(pitchDelta: number, yawDelta = 0): void {
    this.pitch = MathUtils.clamp(
      this.pitch + pitchDelta,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    );
    this.yaw += yawDelta;
  }

  /** Absolute look angles (radians). Pitch negative = look down. */
  setLook(yaw: number, pitch: number): void {
    this.yaw = yaw;
    this.pitch = MathUtils.clamp(pitch, -Math.PI * 0.49, Math.PI * 0.49);
    this.syncTransforms();
  }

  getEyeHeight(): number {
    return this.eyeHeight;
  }

  getHorizontalSpeed(): number {
    return Math.hypot(this.velocity.x, this.velocity.z);
  }

  justDidLand(): boolean {
    return this.justLanded;
  }

  getLandImpact(): number {
    return this.landImpact;
  }

  consumeDamagePulse(): number {
    const v = this.damagePulse;
    this.damagePulse = 0;
    return v;
  }

  /** Entry speed of a slide that began since the last call, else 0. */
  consumeSlideStart(): number {
    const v = this.slideStartSpeed;
    this.slideStartSpeed = 0;
    return v;
  }

  /** Ledge height of a mantle completed since the last call, else 0. */
  consumeMantle(): number {
    const v = this.mantleHeight;
    this.mantleHeight = 0;
    return v;
  }

  isSprinting(): boolean {
    // Holding fire breaks sprint (CoD-style): hipfire at walk speed, ADS free next tick.
    if (this.isFireHeld()) return false;
    const sprintHeld = this.sessionInput?.sprint
      ?? (this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'));
    return (
      this.grounded &&
      !this.crouching &&
      sprintHeld &&
      this.wishDir.lengthSq() > SPRINT_THRESHOLD * SPRINT_THRESHOLD &&
      this.forwardPressed()
    );
  }

  isCrouching(): boolean {
    return this.crouching;
  }

  isSliding(): boolean {
    return this.sliding;
  }

  isMoving(): boolean {
    return this.getHorizontalSpeed() > 0.15 || this.wishDir.lengthSq() > 0.01;
  }

  isADSHeld(): boolean {
    return this.sessionInput?.aim ?? this.keys.has('MouseRight');
  }

  isFireHeld(): boolean {
    return this.sessionInput?.fire ?? this.keys.has('MouseLeft');
  }

  setSessionInput(input: Readonly<InputFrame> | null): void {
    this.sessionInput = input;
  }

  /** Immutable fixed-tick input sample for GameSession/replay recording. */
  sampleInputFrame(): InputFrame {
    const moveX = (this.keys.has('KeyD') || this.keys.has('ArrowRight') ? 1 : 0) -
      (this.keys.has('KeyA') || this.keys.has('ArrowLeft') ? 1 : 0);
    const moveY = (this.keys.has('KeyW') || this.keys.has('ArrowUp') ? 1 : 0) -
      (this.keys.has('KeyS') || this.keys.has('ArrowDown') ? 1 : 0);
    const frame: InputFrame = {
      moveX,
      moveY,
      lookX: this.pendingLookX,
      lookY: this.pendingLookY,
      fire: this.keys.has('MouseLeft'),
      firePressed: this.pendingFirePressed,
      aim: this.keys.has('MouseRight'),
      aimPressed: this.pendingAimPressed,
      reload: this.pendingReload,
      grenade: this.pendingGrenade,
      interact: this.pendingInteract,
      jump: this.pendingJump,
      crouch: this.keys.has('ControlLeft')
        || this.keys.has('ControlRight')
        || this.keys.has('KeyC'),
      sprint: this.keys.has('ShiftLeft') || this.keys.has('ShiftRight'),
      weaponSlot: this.pendingWeaponSlot,
      weaponCycle: this.pendingWeaponCycle,
    };
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    this.pendingFirePressed = false;
    this.pendingAimPressed = false;
    this.pendingJump = false;
    this.pendingReload = false;
    this.pendingGrenade = false;
    this.pendingInteract = false;
    this.pendingWeaponSlot = undefined;
    this.pendingWeaponCycle = 0;
    return frame;
  }

  /** Clears latched controls when pausing, losing focus, or restoring a checkpoint. */
  clearInput(): void {
    this.keys.clear();
    this.sessionInput = null;
    this.wantCrouch = false;
    this.jumpPressed = false;
    this.sliding = false;
    this.slideTimer = 0;
    this.pendingLookX = 0;
    this.pendingLookY = 0;
    this.pendingFirePressed = false;
    this.pendingAimPressed = false;
    this.pendingJump = false;
    this.pendingReload = false;
    this.pendingGrenade = false;
    this.pendingInteract = false;
    this.pendingWeaponSlot = undefined;
    this.pendingWeaponCycle = 0;
    this.previousSessionCrouch = false;
  }

  /** Snapshot of codes currently tracked as held (keyboard + mouse buttons). */
  getHeldKeyCodes(): string[] {
    return [...this.keys];
  }

  /**
   * Codes to re-apply after death restore. Alt-tab during the death delay calls
   * beginInputSuspend (blur) but skips the pause menu while dead, so live `keys`
   * are empty and only the suspend snapshot still knows which WASD are held.
   * Drains the latch so auto-respawn does not leave movement dead until repress.
   */
  consumeHeldKeysForRestore(): string[] {
    if (this.suspendedHeldKeys !== null) {
      const held = [...this.suspendedHeldKeys];
      this.suspendedHeldKeys = null;
      return held;
    }
    return [...this.keys];
  }

  /**
   * Re-apply sustained keyboard holds after clearInput. Physical keys that never
   * received a keyup stay down in the OS, so without this WASD/sprint/crouch go
   * dead until the player releases and represses. Mouse buttons are skipped —
   * pointer lock owns fire/aim edges after a restore.
   */
  resyncHeldKeys(codes: Iterable<string>): void {
    for (const code of codes) {
      if (code === 'MouseLeft' || code === 'MouseRight') continue;
      this.keys.add(code);
    }
    const crouchHeld =
      this.keys.has('ControlLeft')
      || this.keys.has('ControlRight')
      || this.keys.has('KeyC');
    // Drive crouch intent from live keys, not a prior restore latch — otherwise
    // a crouched checkpoint sticks after crouch was released during death delay.
    // When held, treat as already down so the next session frame does not
    // edge-trigger startSlide.
    this.wantCrouch = crouchHeld;
    this.previousSessionCrouch = crouchHeld;
  }

  /**
   * Pause / pointer-unlock path: snapshot keyboard holds, then clear latches.
   * Keyup/keydown while suspended keep the snapshot current (same stuck-keys
   * class as death restore, but keys can change while the menu is open).
   * Idempotent: blur often races ahead of pointerlockchange and must not
   * replace an existing snapshot with an empty live key set.
   */
  beginInputSuspend(): void {
    const live = [...this.keys].filter(
      (code) => code !== 'MouseLeft' && code !== 'MouseRight',
    );
    if (this.suspendedHeldKeys === null) {
      this.suspendedHeldKeys = new Set(live);
    } else {
      for (const code of live) this.suspendedHeldKeys.add(code);
    }
    this.clearInput();
  }

  /**
   * Resume from pause: clear edges again, then restore still-held keyboard codes.
   * No-ops the suspend bookkeeping when beginInputSuspend was never called
   * (fresh Play from the title menu).
   */
  endInputSuspend(): void {
    const held = this.suspendedHeldKeys;
    this.suspendedHeldKeys = null;
    this.clearInput();
    if (held && held.size > 0) this.resyncHeldKeys(held);
  }

  isInputSuspended(): boolean {
    return this.suspendedHeldKeys !== null;
  }

  setBaseFov(fov: number): void {
    this.camera.fov = MathUtils.clamp(fov, 60, 120);
    this.camera.updateProjectionMatrix();
  }

  setAdsSensitivityMultiplier(multiplier: number): void {
    this.adsSensitivityMultiplier = MathUtils.clamp(multiplier, 0.2, 1.5);
  }

  /**
   * Apply damage. Armor absorbs ~65% first, then soft soak.
   * @returns actual health lost
   */
  takeDamage(amount: number): number {
    if (!this.alive || amount <= 0) return 0;

    let remaining = amount;
    let healthLost = 0;

    if (this.armor > 0) {
      const absorbed = Math.min(this.armor, remaining * 0.65);
      this.armor = Math.max(0, this.armor - absorbed);
      remaining -= absorbed;
      remaining *= 0.55;
    }

    const before = this.health;
    this.health = Math.max(0, this.health - remaining);
    healthLost = before - this.health;

    this.lastDamageAmount = amount;
    this.damagePulse = Math.max(this.damagePulse, Math.min(amount / 40, 1.5));

    if (this.health <= 0) {
      this.health = 0;
      this.alive = false;
      this.velocity.set(0, 0, 0);
    }

    return healthLost;
  }

  heal(amount: number): void {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  addArmor(amount: number): void {
    if (!this.alive) return;
    this.armor = Math.min(this.maxArmor, this.armor + amount);
  }

  revive(full = true): void {
    this.alive = true;
    this.health = full ? this.maxHealth : Math.max(25, this.health);
    if (full) this.armor = Math.max(this.armor, 50);
  }

  /**
   * Per-frame simulation.
   * @param dt seconds
   * @param colliders world AABB solids `{ min, max }[]`
   */
  update(dt: number, colliders: WorldCollider[]): void {
    const clampedDt = Math.min(dt, 0.05);
    this.previousPosition.copy(this.position);
    this.justLanded = false;
    this.landImpact = 0;

    if (!this.alive) {
      this.syncTransforms();
      return;
    }

    this.applyFixedInput();
    this.updateCrouchState(colliders);
    this.computeWishDir();

    this.mantleCooldown = Math.max(0, this.mantleCooldown - clampedDt);
    if (this.sliding) {
      this.slideTimer -= clampedDt;
      if (this.slideTimer <= 0 || !this.grounded || this.getHorizontalSpeed() < 3.2) {
        this.sliding = false;
      }
    }

    const sprinting = this.isSprinting();
    const maxSpeed = this.sliding
      ? Math.max(SLIDE_START_SPEED, this.getHorizontalSpeed())
      : this.crouching
      ? this.crouchSpeed
      : sprinting
        ? this.sprintSpeed
        : this.walkSpeed;

    this.accelerate(
      this.wishDir,
      maxSpeed,
      this.grounded ? GROUND_ACCEL : AIR_ACCEL,
      clampedDt,
    );

    if (this.grounded) {
      this.applyFriction(
        clampedDt,
        this.sliding ? 3.2 : GROUND_FRICTION,
        !this.sliding && this.wishDir.lengthSq() < 0.01,
      );
    } else {
      this.applyFriction(clampedDt, AIR_FRICTION, false);
    }

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > maxSpeed * 1.08) {
      const scale = (maxSpeed * 1.08) / hSpeed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    if (this.grounded && this.jumpPressed) {
      if (!this.tryMantle(colliders)) {
        this.velocity.y = this.jumpVelocity;
        this.grounded = false;
        if (this.crouching) this.velocity.y *= 1.05;
      }
    }
    this.jumpPressed = false;

    if (!this.grounded) {
      this.velocity.y -= GRAVITY * clampedDt;
      if (this.velocity.y < -TERMINAL_V) this.velocity.y = -TERMINAL_V;
    }

    this.wasGrounded = this.grounded;
    this.moveAndCollide(clampedDt, colliders);

    // Safety net — never fall through the arena into the sky-dome void.
    if (this.position.y < -0.5) {
      this.position.y = 0;
      this.velocity.y = 0;
      this.grounded = true;
    }

    if (this.grounded && !this.wasGrounded) {
      this.justLanded = true;
      this.landImpact = MathUtils.clamp(this.fallSpeedAtImpact / 18, 0, 1.4);
    }

    this.eyeHeight = MathUtils.damp(this.eyeHeight, this.targetEyeHeight, 14, clampedDt);
    this.syncTransforms();
  }

  dispose(): void {
    for (const fn of this.disposeFns) fn();
    this.disposeFns.length = 0;
    this.keys.clear();
    this.attachElement = null;
    this.pivot.removeFromParent();
  }

  // ─── Internals ───────────────────────────────────────────────────────────

  private bindInput(): void {
    const onKeyDown = (e: KeyboardEvent) => {
      const freshPress = !this.keys.has(e.code);
      this.keys.add(e.code);
      this.suspendedHeldKeys?.add(e.code);
      if (freshPress && e.code === 'Space') this.pendingJump = true;
      if (freshPress && e.code === 'KeyR') this.pendingReload = true;
      if (freshPress && e.code === 'KeyG') this.pendingGrenade = true;
      if (freshPress && (e.code === 'KeyE' || e.code === 'KeyF')) this.pendingInteract = true;
      if (freshPress && (e.code === 'Digit1' || e.code === 'Numpad1')) this.pendingWeaponSlot = 1;
      if (freshPress && (e.code === 'Digit2' || e.code === 'Numpad2')) this.pendingWeaponSlot = 2;
      if (freshPress && (e.code === 'Digit3' || e.code === 'Numpad3')) this.pendingWeaponSlot = 3;
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
        this.wantCrouch = true;
        if (!this.sessionInput && freshPress && this.grounded && this.isSprinting() && this.getHorizontalSpeed() > 5.2) {
          this.startSlide();
        }
      }
      if (this.pointerLocked && (e.code === 'Space' || e.code.startsWith('Control'))) {
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
      this.suspendedHeldKeys?.delete(e.code);
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
        if (
          !this.keys.has('ControlLeft') &&
          !this.keys.has('ControlRight') &&
          !this.keys.has('KeyC')
        ) {
          this.wantCrouch = false;
        }
      }
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

    const onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked || !this.alive) return;
      this.pendingLookX += e.movementX;
      this.pendingLookY += e.movementY;
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.pointerLocked) return;
      e.preventDefault();
      this.pendingWeaponCycle = e.deltaY > 0 ? 1 : -1;
    };

    const onLockChange = () => {
      this.pointerLocked = document.pointerLockElement != null;
      if (!this.pointerLocked) {
        this.keys.delete('MouseLeft');
        this.keys.delete('MouseRight');
      }
    };

    const onContextMenu = (e: Event) => {
      if (this.pointerLocked) e.preventDefault();
    };

    const onBlur = () => {
      // Alt-tab / focus loss often fires blur before pointerlockchange.
      // Bare clearInput empties holds so a later beginInputSuspend snapshots
      // nothing and resume leaves WASD dead until repress.
      this.beginInputSuspend();
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('wheel', onWheel, { passive: false });
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);

    this.disposeFns.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => window.removeEventListener('wheel', onWheel),
      () => document.removeEventListener('pointerlockchange', onLockChange),
      () => window.removeEventListener('contextmenu', onContextMenu),
      () => window.removeEventListener('blur', onBlur),
    );
  }

  private forwardPressed(): boolean {
    return (this.sessionInput?.moveY ?? 0) > 0.35
      || this.keys.has('KeyW')
      || this.keys.has('ArrowUp');
  }

  private applyFixedInput(): void {
    const input = this.sessionInput;
    if (input) {
      const aimScale = input.aim ? this.adsSensitivityMultiplier : 1;
      this.applyLookDelta(input.lookX, input.lookY, aimScale);
      const crouchPressed = input.crouch && !this.previousSessionCrouch;
      this.previousSessionCrouch = input.crouch;
      this.wantCrouch = input.crouch;
      this.jumpPressed = input.jump;
      if (
        crouchPressed
        && this.grounded
        && input.sprint
        && input.moveY > SPRINT_THRESHOLD
        && this.getHorizontalSpeed() > 5.2
      ) this.startSlide();
      return;
    }
    if (this.pendingLookX !== 0 || this.pendingLookY !== 0) {
      const aimScale = this.keys.has('MouseRight') ? this.adsSensitivityMultiplier : 1;
      this.applyLookDelta(this.pendingLookX, this.pendingLookY, aimScale);
      this.pendingLookX = 0;
      this.pendingLookY = 0;
    }
    if (this.pendingJump) {
      this.jumpPressed = true;
      this.pendingJump = false;
    }
  }

  private applyLookDelta(x: number, y: number, scale: number): void {
    this.yaw -= x * this.sensitivity * scale;
    this.pitch = MathUtils.clamp(
      this.pitch - y * this.sensitivity * scale,
      -Math.PI * 0.49,
      Math.PI * 0.49,
    );
  }

  private computeWishDir(): void {
    if (this.sessionInput) {
      this.wishDir.set(this.sessionInput.moveX, 0, -this.sessionInput.moveY);
      if (this.wishDir.lengthSq() > 0) {
        const sin = Math.sin(this.yaw);
        const cos = Math.cos(this.yaw);
        const x = this.wishDir.x;
        const z = this.wishDir.z;
        this.wishDir.set(x * cos + z * sin, 0, -x * sin + z * cos).normalize();
      }
      return;
    }
    let x = 0;
    let z = 0;
    if (this.keys.has('KeyW') || this.keys.has('ArrowUp')) z -= 1;
    if (this.keys.has('KeyS') || this.keys.has('ArrowDown')) z += 1;
    if (this.keys.has('KeyA') || this.keys.has('ArrowLeft')) x -= 1;
    if (this.keys.has('KeyD') || this.keys.has('ArrowRight')) x += 1;

    this.wishDir.set(0, 0, 0);
    if (x === 0 && z === 0) return;

    const sin = Math.sin(this.yaw);
    const cos = Math.cos(this.yaw);
    this.wishDir.set(x * cos + z * sin, 0, -x * sin + z * cos);
    if (this.wishDir.lengthSq() > 0) this.wishDir.normalize();
  }

  private accelerate(wish: Vector3, wishSpeed: number, accel: number, dt: number): void {
    if (wish.lengthSq() < 1e-8) return;
    const currentSpeed = this.velocity.x * wish.x + this.velocity.z * wish.z;
    const addSpeed = wishSpeed - currentSpeed;
    if (addSpeed <= 0) return;
    let accelSpeed = accel * dt * wishSpeed;
    if (accelSpeed > addSpeed) accelSpeed = addSpeed;
    this.velocity.x += accelSpeed * wish.x;
    this.velocity.z += accelSpeed * wish.z;
  }

  private applyFriction(dt: number, amount: number, fullStop: boolean): void {
    const speed = Math.hypot(this.velocity.x, this.velocity.z);
    if (speed < 1e-5) {
      this.velocity.x = 0;
      this.velocity.z = 0;
      return;
    }
    const drop = fullStop ? speed * amount * dt : speed * amount * 0.35 * dt;
    const newSpeed = Math.max(speed - drop, 0);
    const scale = newSpeed / speed;
    this.velocity.x *= scale;
    this.velocity.z *= scale;
    if (newSpeed < 0.02) {
      this.velocity.x = 0;
      this.velocity.z = 0;
    }
  }

  private updateCrouchState(colliders: WorldCollider[]): void {
    if (this.wantCrouch || this.sliding) {
      this.crouching = true;
      this.targetEyeHeight = CROUCH_EYE;
      this.halfHeight = CROUCH_HALF_HEIGHT;
      this.resizePhysicsCapsule(CROUCH_HALF_HEIGHT);
      return;
    }

    if (this.crouching) {
      const canStand = this.physicsWorld && this.physicsBodyId
        ? this.resizePhysicsCapsule(STAND_HALF_HEIGHT)
        : this.hasHeadroom(colliders, STAND_HALF_HEIGHT);
      if (canStand) {
        this.crouching = false;
        this.targetEyeHeight = STAND_EYE;
        this.halfHeight = STAND_HALF_HEIGHT;
      } else {
        this.targetEyeHeight = CROUCH_EYE;
        this.halfHeight = CROUCH_HALF_HEIGHT;
      }
    } else {
      this.targetEyeHeight = STAND_EYE;
      this.halfHeight = STAND_HALF_HEIGHT;
    }
  }

  private startSlide(): void {
    this.sliding = true;
    this.slideTimer = SLIDE_DURATION;
    this.crouching = true;
    this.targetEyeHeight = CROUCH_EYE;
    this.halfHeight = CROUCH_HALF_HEIGHT;
    const speed = this.getHorizontalSpeed();
    this.slideStartSpeed = Math.max(speed, SLIDE_START_SPEED);
    if (speed > 0.01 && speed < SLIDE_START_SPEED) {
      const boost = SLIDE_START_SPEED / speed;
      this.velocity.x *= boost;
      this.velocity.z *= boost;
    }
  }

  /**
   * Deterministic low-ledge mantle. Authored gameplay uses Rapier rays and a
   * capsule sweep; the AABB branch exists only for explicit fallback mode.
   */
  private tryMantle(colliders: WorldCollider[]): boolean {
    if (this.mantleCooldown > 0 || !this.forwardPressed()) return false;
    const forwardX = -Math.sin(this.yaw);
    const forwardZ = -Math.cos(this.yaw);
    if (this.physicsWorld && this.physicsBodyId) {
      return this.tryPhysicsMantle(forwardX, forwardZ);
    }
    const probeX = this.position.x + forwardX * MANTLE_REACH;
    const probeZ = this.position.z + forwardZ * MANTLE_REACH;

    for (const collider of colliders) {
      const inProbe =
        probeX + RADIUS >= collider.min.x &&
        probeX - RADIUS <= collider.max.x &&
        probeZ + RADIUS >= collider.min.z &&
        probeZ - RADIUS <= collider.max.z;
      if (!inProbe) continue;

      const ledgeHeight = collider.max.y - this.position.y;
      if (ledgeHeight < MANTLE_MIN_HEIGHT || ledgeHeight > MANTLE_MAX_HEIGHT) continue;

      const landingX = probeX + forwardX * (RADIUS + 0.2);
      const landingZ = probeZ + forwardZ * (RADIUS + 0.2);
      const landingY = collider.max.y + 0.025;
      this._min.set(landingX - RADIUS, landingY, landingZ - RADIUS);
      this._max.set(landingX + RADIUS, landingY + STAND_HALF_HEIGHT * 2, landingZ + RADIUS);
      const blocked = colliders.some(
        (other) => other !== collider && this.aabbOverlap(this._min, this._max, other.min, other.max),
      );
      if (blocked) continue;

      this.mantleHeight = ledgeHeight;
      this.position.set(landingX, landingY, landingZ);
      this.velocity.set(forwardX * 2.4, 0, forwardZ * 2.4);
      this.grounded = true;
      this.sliding = false;
      this.mantleCooldown = 0.35;
      return true;
    }
    return false;
  }

  private tryPhysicsMantle(forwardX: number, forwardZ: number): boolean {
    if (!this.physicsWorld || !this.physicsBodyId) return false;
    const forward = { x: forwardX, y: 0, z: forwardZ };
    const blocker = this.physicsWorld.castRay({
      origin: {
        x: this.position.x,
        y: this.position.y + MANTLE_MIN_HEIGHT,
        z: this.position.z,
      },
      direction: forward,
      maxDistance: MANTLE_REACH,
      excludeBody: this.physicsBodyId,
      includeCharacters: false,
    });
    if (!blocker || Math.abs(blocker.normal.y) > 0.45) return false;

    const landingDistance = blocker.distance + RADIUS * 2 + 0.24;
    const landingX = this.position.x + forwardX * landingDistance;
    const landingZ = this.position.z + forwardZ * landingDistance;
    const ledgeProbeY = this.position.y + MANTLE_MAX_HEIGHT + 0.24;
    const ledge = this.physicsWorld.castRay({
      origin: { x: landingX, y: ledgeProbeY, z: landingZ },
      direction: { x: 0, y: -1, z: 0 },
      maxDistance: MANTLE_MAX_HEIGHT + 0.3,
      excludeBody: this.physicsBodyId,
      includeCharacters: false,
    });
    if (!ledge || ledge.normal.y < 0.55) return false;
    const landingY = ledge.point.y + 0.025;
    const ledgeHeight = landingY - this.position.y;
    if (ledgeHeight < MANTLE_MIN_HEIGHT || ledgeHeight > MANTLE_MAX_HEIGHT) return false;

    const blocked = this.physicsWorld.sweepCapsule({
      position: {
        x: landingX,
        y: landingY + STAND_HALF_HEIGHT,
        z: landingZ,
      },
      radius: RADIUS,
      halfHeight: STAND_HALF_HEIGHT,
      direction: { x: 0, y: 1, z: 0 },
      maxDistance: 0.01,
      excludeBody: this.physicsBodyId,
      includeCharacters: false,
    });
    if (blocked) return false;

    this.mantleHeight = ledgeHeight;
    this.position.set(landingX, landingY, landingZ);
    this.physicsWorld.teleportCharacter?.(this.physicsBodyId, {
      x: landingX,
      y: landingY + this.physicsCenterOffset,
      z: landingZ,
    });
    this.velocity.set(forwardX * 2.4, 0, forwardZ * 2.4);
    this.grounded = true;
    this.sliding = false;
    this.mantleCooldown = 0.35;
    return true;
  }

  private resizePhysicsCapsule(halfHeight: number): boolean {
    if (!this.physicsWorld || !this.physicsBodyId) return true;
    const resized = this.physicsWorld.resizeCharacter?.(
      this.physicsBodyId,
      RADIUS,
      halfHeight,
    );
    if (resized === false) return false;
    this.physicsCenterOffset = halfHeight;
    return true;
  }

  private hasHeadroom(colliders: WorldCollider[], standHalf: number): boolean {
    this.getAABB(this._min, this._max, standHalf);
    this._min.y = this.position.y + this.halfHeight * 2 - 0.05;
    this._max.y = this.position.y + standHalf * 2;
    for (const c of colliders) {
      if (this.aabbOverlap(this._min, this._max, c.min, c.max)) return false;
    }
    return true;
  }

  private getAABB(outMin: Vector3, outMax: Vector3, halfH = this.halfHeight): void {
    outMin.set(
      this.position.x - RADIUS,
      this.position.y,
      this.position.z - RADIUS,
    );
    outMax.set(
      this.position.x + RADIUS,
      this.position.y + halfH * 2,
      this.position.z + RADIUS,
    );
  }

  private aabbOverlap(
    aMin: Vector3,
    aMax: Vector3,
    bMin: Vector3,
    bMax: Vector3,
  ): boolean {
    return (
      aMin.x <= bMax.x &&
      aMax.x >= bMin.x &&
      aMin.y <= bMax.y &&
      aMax.y >= bMin.y &&
      aMin.z <= bMax.z &&
      aMax.z >= bMin.z
    );
  }

  private moveAndCollide(dt: number, colliders: WorldCollider[]): void {
    if (this.physicsWorld && this.physicsBodyId) {
      const desired = {
        x: this.velocity.x * dt,
        y: this.velocity.y * dt,
        z: this.velocity.z * dt,
      };
      const previouslyGrounded = this.grounded;
      const moved = this.physicsWorld.moveCharacter(this.physicsBodyId, { translation: desired });
      this.position.set(
        moved.position.x,
        moved.position.y - this.physicsCenterOffset,
        moved.position.z,
      );
      this.grounded = moved.grounded;
      if (this.grounded && !previouslyGrounded && this.velocity.y < -0.5) {
        this.fallSpeedAtImpact = -this.velocity.y;
      }
      if (Math.abs(moved.appliedTranslation.y - desired.y) > 1e-4) this.velocity.y = 0;
      if (moved.collisions.length > 0) {
        if (Math.abs(moved.appliedTranslation.x - desired.x) > 1e-4) this.velocity.x = 0;
        if (Math.abs(moved.appliedTranslation.z - desired.z) > 1e-4) this.velocity.z = 0;
      }
      return;
    }
    const steps = 3;
    const stepDt = dt / steps;
    this.grounded = false;

    for (let s = 0; s < steps; s++) {
      this.position.x += this.velocity.x * stepDt;
      this.resolveAxis('x', colliders);

      this.position.z += this.velocity.z * stepDt;
      this.resolveAxis('z', colliders);

      const prevY = this.position.y;
      this.position.y += this.velocity.y * stepDt;
      const hitY = this.resolveAxis('y', colliders);
      if (hitY === 'floor') {
        if (this.velocity.y < -0.5) {
          this.fallSpeedAtImpact = -this.velocity.y;
        }
        this.velocity.y = 0;
        this.grounded = true;
      } else if (hitY === 'ceiling') {
        this.velocity.y = Math.min(this.velocity.y, 0);
      } else if (this.velocity.y < 0 && Math.abs(this.position.y - prevY) < 1e-6) {
        // stuck
      }
    }

    if (!this.grounded && this.velocity.y <= 0) {
      this.position.y -= 0.08;
      const probe = this.resolveAxis('y', colliders);
      if (probe === 'floor') {
        this.grounded = true;
        this.velocity.y = 0;
      } else {
        this.position.y += 0.08;
      }
    }
  }

  private resolveAxis(
    axis: 'x' | 'y' | 'z',
    colliders: WorldCollider[],
  ): 'floor' | 'ceiling' | 'wall' | null {
    this.getAABB(this._min, this._max);
    let result: 'floor' | 'ceiling' | 'wall' | null = null;

    for (const c of colliders) {
      if (!this.aabbOverlap(this._min, this._max, c.min, c.max)) continue;

      if (axis === 'x') {
        const overlapLeft = this._max.x - c.min.x;
        const overlapRight = c.max.x - this._min.x;
        const pen = Math.min(overlapLeft, overlapRight);
        // Ignore pathological deep embeds (spawn-inside-geo) — skip rather than fling.
        if (pen > 1.25) continue;
        if (overlapLeft < overlapRight) {
          this.position.x -= overlapLeft;
        } else {
          this.position.x += overlapRight;
        }
        this.velocity.x = 0;
        result = 'wall';
        this.getAABB(this._min, this._max);
      } else if (axis === 'z') {
        const overlapNear = this._max.z - c.min.z;
        const overlapFar = c.max.z - this._min.z;
        const pen = Math.min(overlapNear, overlapFar);
        if (pen > 1.25) continue;
        if (overlapNear < overlapFar) {
          this.position.z -= overlapNear;
        } else {
          this.position.z += overlapFar;
        }
        this.velocity.z = 0;
        result = 'wall';
        this.getAABB(this._min, this._max);
      } else {
        // Y axis — velocity decides floor vs ceiling. Never use raw overlap size:
        // a standing player always penetrates "more from below" on thin floor slabs.
        const overlapTop = c.max.y - this._min.y;
        const overlapBottom = this._max.y - c.min.y;

        if (this.velocity.y > 0.05) {
          this.position.y -= overlapBottom;
          result = 'ceiling';
        } else {
          this.position.y += Math.max(0, overlapTop);
          result = 'floor';
        }
        this.getAABB(this._min, this._max);
      }
    }

    return result;
  }

  private syncTransforms(): void {
    this.pivot.position.copy(this.position);
    this.pivot.rotation.set(0, this.yaw, 0);

    // Base eye height — CameraFeel layers bob/shake on top via local offsets.
    this.camera.position.set(0, this.eyeHeight, 0);
    this.camera.rotation.set(this.pitch, 0, 0);
  }
}
