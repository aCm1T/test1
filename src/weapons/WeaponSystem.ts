import { MathUtils, Scene, Vector3, type PerspectiveCamera } from 'three';
import {
  hitscan,
  type BodyPart,
  type HitscanEnemy,
  type HitscanHit,
} from '../combat/Hitscan';
import type { WorldCollider } from '../player/PlayerController';
import type { PlayerController } from '../player/PlayerController';
import { ViewModel, type WeaponId } from './ViewModel';

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
  onReload?: (weapon: WeaponId) => void;
}

export interface WeaponSystemOptions {
  player: PlayerController;
  camera: PerspectiveCamera;
  colliders?: WorldCollider[];
  callbacks?: WeaponSystemCallbacks;
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
    adsSpread: 0.004,
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
    adsSpread: 0.006,
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

  private readonly player: PlayerController;
  private readonly camera: PerspectiveCamera;
  private colliders: WorldCollider[];

  private active: WeaponId = 'ar';
  private readonly ammo: Record<'ar' | 'pistol', AmmoState> = {
    ar: { mag: 30, reserve: 90, magSize: 30 },
    pistol: { mag: 12, reserve: 36, magSize: 12 },
  };

  private fireCooldown = 0;
  private reloading = false;
  private reloadTimer = 0;
  private ads = false;
  private fireHeld = false;
  private firePressed = false;
  private prevFire = false;

  private recoilPunchPitch = 0;
  private recoilPunchYaw = 0;

  private readonly keys = new Set<string>();
  private disposeFns: Array<() => void> = [];

  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly _forward = new Vector3();

  constructor(options: WeaponSystemOptions) {
    this.player = options.player;
    this.camera = options.camera;
    this.colliders = options.colliders ?? [];
    this.onFire = options.callbacks?.onFire;
    this.onHit = options.callbacks?.onHit;
    this.onKill = options.callbacks?.onKill;
    this.onReload = options.callbacks?.onReload;

    this.viewModel = new ViewModel(this.camera);
    this.bindInput();
  }

  setColliders(colliders: WorldCollider[]): void {
    this.colliders = colliders;
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

  isADS(): boolean {
    return this.ads && this.active !== 'knife' && !this.reloading;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  /** Current view recoil punch (radians) — apply to look or read for HUD. */
  getRecoilPunch(): { pitch: number; yaw: number } {
    return { pitch: this.recoilPunchPitch, yaw: this.recoilPunchYaw };
  }

  switchWeapon(id: WeaponId): void {
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
    this.reloading = true;
    this.reloadTimer = def.reloadTime;
    this.ads = false;
    this.viewModel.playReload(def.reloadTime);
    this.onReload?.(this.active);
  }

  /**
   * Per-frame update.
   * @param dt seconds
   * @param _scene scene (reserved for tracers/decals hooks)
   * @param enemies hitscan targets
   */
  update(dt: number, _scene: Scene, enemies: HitscanEnemy[]): void {
    const clampedDt = Math.min(dt, 0.05);

    // ADS from RMB (player also tracks MouseRight; we mirror for independence)
    const wantAds =
      this.keys.has('MouseRight') || this.player.isADSHeld();
    this.ads =
      wantAds &&
      this.active !== 'knife' &&
      !this.reloading &&
      !this.player.isSprinting();

    // Fire state
    this.fireHeld = this.keys.has('MouseLeft') || this.player.isFireHeld();
    this.firePressed = this.fireHeld && !this.prevFire;
    this.prevFire = this.fireHeld;

    // Reload
    if (this.reloading) {
      this.reloadTimer -= clampedDt;
      if (this.reloadTimer <= 0) {
        this.finishReload();
      }
    }

    // Cooldown
    if (this.fireCooldown > 0) {
      this.fireCooldown -= clampedDt;
    }

    // Pose
    if (this.reloading) {
      this.viewModel.setPose('reload');
    } else if (this.player.isSprinting() && this.player.isMoving() && !this.fireHeld) {
      this.viewModel.setPose('sprint');
    } else if (this.ads) {
      this.viewModel.setPose('ads');
    } else {
      this.viewModel.setPose('hip');
    }

    // Fire logic
    const def = WEAPON_DEFS[this.active];
    const canFire =
      !this.player.isDead() &&
      this.player.isPointerLocked() &&
      !this.reloading &&
      this.fireCooldown <= 0 &&
      !(this.player.isSprinting() && this.player.isMoving() && !this.fireHeld);

    if (canFire) {
      if (def.melee) {
        if (this.firePressed) this.fireMelee(enemies, def);
      } else if (def.automatic) {
        if (this.fireHeld) this.fireHitscan(enemies, def);
      } else if (this.firePressed) {
        this.fireHitscan(enemies, def);
      }
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

    // Recoil punch recovery (visual residual)
    this.recoilPunchPitch = MathUtils.damp(this.recoilPunchPitch, 0, 14, clampedDt);
    this.recoilPunchYaw = MathUtils.damp(this.recoilPunchYaw, 0, 14, clampedDt);

    this.viewModel.update(clampedDt);
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

    // Spread
    const spread = this.ads ? def.adsSpread : def.hipSpread;
    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this._forward);

    const sx = (Math.random() - 0.5) * 2 * spread;
    const sy = (Math.random() - 0.5) * 2 * spread;
    this.direction.copy(this._forward);
    // Build orthonormal basis for spread
    const right = new Vector3().crossVectors(this._forward, this.camera.up).normalize();
    const up = new Vector3().crossVectors(right, this._forward).normalize();
    this.direction.addScaledVector(right, sx).addScaledVector(up, sy).normalize();

    const hit = hitscan(this.origin, this.direction, enemies, this.colliders, def.range);

    // Recoil — punch player look angles (survives CameraFeel re-base)
    const adsMul = this.ads ? 0.55 : 1;
    const pitchKick = def.recoilPitch * adsMul * (0.85 + Math.random() * 0.3);
    const yawKick = def.recoilYaw * adsMul * (Math.random() - 0.5) * 2;
    this.recoilPunchPitch += pitchKick;
    this.recoilPunchYaw += yawKick;
    this.player.addLookDelta(pitchKick, yawKick);

    this.viewModel.kickOnFire(this.ads ? 0.7 : 1.1, this.ads);

    this.onFire?.(this.active, hit);
    this.applyHitDamage(hit, def);
  }

  private fireMelee(enemies: HitscanEnemy[], def: WeaponDef): void {
    this.fireCooldown = 60 / def.rpm;
    this.viewModel.kickMelee();

    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this.direction);

    const hit = hitscan(this.origin, this.direction, enemies, this.colliders, def.range);
    this.onFire?.(this.active, hit);
    this.applyHitDamage(hit, def);
  }

  private applyHitDamage(hit: HitscanHit, def: WeaponDef): void {
    if (!hit.enemy || hit.hitWorld) return;

    let dmg = def.damage;
    if (hit.bodyPart === 'head') dmg *= def.headMult;
    else if (hit.bodyPart === 'limbs') dmg *= def.limbMult;

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
      this.keys.add(e.code);

      if (e.code === 'KeyR') {
        this.startReload();
      }
      if (e.code === 'Digit1' || e.code === 'Numpad1') this.switchSlot(1);
      if (e.code === 'Digit2' || e.code === 'Numpad2') this.switchSlot(2);
      if (e.code === 'Digit3' || e.code === 'Numpad3') this.switchSlot(3);
    };

    const onKeyUp = (e: KeyboardEvent) => {
      this.keys.delete(e.code);
    };

    const onMouseDown = (e: MouseEvent) => {
      if (e.button === 0) this.keys.add('MouseLeft');
      if (e.button === 2) this.keys.add('MouseRight');
    };

    const onMouseUp = (e: MouseEvent) => {
      if (e.button === 0) this.keys.delete('MouseLeft');
      if (e.button === 2) this.keys.delete('MouseRight');
    };

    const onWheel = (e: WheelEvent) => {
      if (!this.player.isPointerLocked()) return;
      e.preventDefault();
      this.cycleWeapon(e.deltaY > 0 ? 1 : -1);
    };

    const onBlur = () => {
      this.keys.clear();
      this.fireHeld = false;
      this.prevFire = false;
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

  dispose(): void {
    for (const fn of this.disposeFns) fn();
    this.disposeFns.length = 0;
    this.viewModel.dispose();
  }
}
