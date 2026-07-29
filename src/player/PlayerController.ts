import {
  MathUtils,
  Object3D,
  PerspectiveCamera,
  Vector3,
} from 'three';

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

  health: number;
  armor: number;
  readonly maxHealth: number;
  readonly maxArmor: number;

  walkSpeed: number;
  sprintSpeed: number;
  crouchSpeed: number;
  jumpVelocity: number;

  private readonly position = new Vector3(0, 0, 0);
  private readonly velocity = new Vector3();
  private readonly wishDir = new Vector3();
  private readonly eyeWorld = new Vector3();
  private readonly _min = new Vector3();
  private readonly _max = new Vector3();

  private readonly keys = new Set<string>();
  private pointerLocked = false;
  private disposeFns: Array<() => void> = [];
  private attachElement: HTMLElement | null = null;

  private eyeHeight = STAND_EYE;
  private targetEyeHeight = STAND_EYE;
  private halfHeight = STAND_HALF_HEIGHT;
  private crouching = false;
  private wantCrouch = false;
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
    this.velocity.set(0, 0, 0);
    this.syncTransforms();
  }

  getVelocity(): Vector3 {
    return this.velocity.clone();
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

  isSprinting(): boolean {
    return (
      this.grounded &&
      !this.crouching &&
      this.keys.has('ShiftLeft') &&
      this.wishDir.lengthSq() > SPRINT_THRESHOLD * SPRINT_THRESHOLD &&
      this.forwardPressed()
    );
  }

  isCrouching(): boolean {
    return this.crouching;
  }

  isMoving(): boolean {
    return this.getHorizontalSpeed() > 0.15 || this.wishDir.lengthSq() > 0.01;
  }

  isADSHeld(): boolean {
    return this.keys.has('MouseRight');
  }

  isFireHeld(): boolean {
    return this.keys.has('MouseLeft');
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
    this.justLanded = false;
    this.landImpact = 0;

    if (!this.alive) {
      this.syncTransforms();
      return;
    }

    this.updateCrouchState(colliders);
    this.computeWishDir();

    const sprinting = this.isSprinting();
    const maxSpeed = this.crouching
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
      this.applyFriction(clampedDt, GROUND_FRICTION, this.wishDir.lengthSq() < 0.01);
    } else {
      this.applyFriction(clampedDt, AIR_FRICTION, false);
    }

    const hSpeed = Math.hypot(this.velocity.x, this.velocity.z);
    if (hSpeed > maxSpeed * 1.08) {
      const scale = (maxSpeed * 1.08) / hSpeed;
      this.velocity.x *= scale;
      this.velocity.z *= scale;
    }

    if (this.grounded && this.keys.has('Space')) {
      this.velocity.y = this.jumpVelocity;
      this.grounded = false;
      if (this.crouching) {
        this.velocity.y *= 1.05;
      }
    }

    if (!this.grounded) {
      this.velocity.y -= GRAVITY * clampedDt;
      if (this.velocity.y < -TERMINAL_V) this.velocity.y = -TERMINAL_V;
    }

    this.wasGrounded = this.grounded;
    this.moveAndCollide(clampedDt, colliders);

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
      this.keys.add(e.code);
      if (e.code === 'ControlLeft' || e.code === 'ControlRight' || e.code === 'KeyC') {
        this.wantCrouch = true;
      }
      if (this.pointerLocked && (e.code === 'Space' || e.code.startsWith('Control'))) {
        e.preventDefault();
      }
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
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
      if (e.button === 0) this.keys.add('MouseLeft');
      if (e.button === 2) this.keys.add('MouseRight');
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.keys.delete('MouseLeft');
      if (e.button === 2) this.keys.delete('MouseRight');
    };

    const onMouseMove = (e: MouseEvent) => {
      if (!this.pointerLocked || !this.alive) return;
      this.yaw -= e.movementX * this.sensitivity;
      this.pitch -= e.movementY * this.sensitivity;
      this.pitch = MathUtils.clamp(this.pitch, -Math.PI * 0.49, Math.PI * 0.49);
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
      this.keys.clear();
      this.wantCrouch = false;
    };

    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    window.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mouseup', onMouseUp);
    window.addEventListener('mousemove', onMouseMove);
    document.addEventListener('pointerlockchange', onLockChange);
    window.addEventListener('contextmenu', onContextMenu);
    window.addEventListener('blur', onBlur);

    this.disposeFns.push(
      () => window.removeEventListener('keydown', onKeyDown),
      () => window.removeEventListener('keyup', onKeyUp),
      () => window.removeEventListener('mousedown', onMouseDown),
      () => window.removeEventListener('mouseup', onMouseUp),
      () => window.removeEventListener('mousemove', onMouseMove),
      () => document.removeEventListener('pointerlockchange', onLockChange),
      () => window.removeEventListener('contextmenu', onContextMenu),
      () => window.removeEventListener('blur', onBlur),
    );
  }

  private forwardPressed(): boolean {
    return this.keys.has('KeyW') || this.keys.has('ArrowUp');
  }

  private computeWishDir(): void {
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
    if (this.wantCrouch) {
      this.crouching = true;
      this.targetEyeHeight = CROUCH_EYE;
      this.halfHeight = CROUCH_HALF_HEIGHT;
      return;
    }

    if (this.crouching) {
      const canStand = this.hasHeadroom(colliders, STAND_HALF_HEIGHT);
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
        if (overlapNear < overlapFar) {
          this.position.z -= overlapNear;
        } else {
          this.position.z += overlapFar;
        }
        this.velocity.z = 0;
        result = 'wall';
        this.getAABB(this._min, this._max);
      } else {
        const overlapBottom = this._max.y - c.min.y;
        const overlapTop = c.max.y - this._min.y;
        if (overlapBottom < overlapTop) {
          this.position.y -= overlapBottom;
          result = 'floor';
        } else {
          this.position.y += overlapTop;
          result = 'ceiling';
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
