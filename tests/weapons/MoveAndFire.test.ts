import { PerspectiveCamera, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeededRandom } from '../../src/mission';
import type { PlayerController } from '../../src/player';
import type { InputFrame } from '../../src/simulation';
import { WeaponSystem } from '../../src/weapons';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('WASD move + LMB fire', () => {
  it('fires the automatic while walking (isMoving + fireHeld)', () => {
    const player = mockPlayer({ moving: true, sprinting: false });
    const { weapon, scene, shots } = createWeapon(player);
    const magBefore = weapon.getAmmo()!.mag;

    weapon.setSessionInput(inputFrame({ moveY: 1, fire: true, firePressed: true }));
    weapon.update(1 / 60, scene, []);

    expect(shots).toHaveLength(1);
    expect(weapon.getAmmo()!.mag).toBe(magBefore - 1);
    weapon.dispose();
  });

  it('still fires while sprinting+moving with fire held (hipfire; sprint cancel is player-side)', () => {
    // Even if a caller still reports isSprinting true for one tick, fire must not be gated.
    const player = mockPlayer({ moving: true, sprinting: true });
    const { weapon, scene, shots } = createWeapon(player);
    const magBefore = weapon.getAmmo()!.mag;

    weapon.setSessionInput(inputFrame({
      moveY: 1,
      sprint: true,
      fire: true,
      firePressed: true,
    }));
    weapon.update(1 / 60, scene, []);

    expect(shots).toHaveLength(1);
    expect(weapon.getAmmo()!.mag).toBe(magBefore - 1);
    weapon.dispose();
  });

  it('uses hip pose (not sprint) when fire is held while the player reports walk after sprint cancel', () => {
    const player = mockPlayer({ moving: true, sprinting: false });
    const { weapon, scene } = createWeapon(player);

    weapon.setSessionInput(inputFrame({
      moveY: 1,
      sprint: true,
      fire: true,
      firePressed: true,
    }));
    weapon.update(1 / 60, scene, []);

    // ViewModel pose is private; sustained auto fire + no sprint flag ⇒ hip path.
    expect(weapon.isADS()).toBe(false);
    expect(weapon.getShotRecords()).toHaveLength(1);
    weapon.dispose();
  });

  it('allows ADS on the next tick after fire cancelled sprint (RMB held, no longer sprinting)', () => {
    let sprinting = true;
    const player = mockPlayer({
      moving: true,
      getSprinting: () => sprinting,
    });
    const { weapon, scene } = createWeapon(player);

    weapon.setSessionInput(inputFrame({
      moveY: 1,
      sprint: true,
      fire: true,
      firePressed: true,
    }));
    weapon.update(1 / 60, scene, []);
    expect(weapon.getShotRecords()).toHaveLength(1);

    // Player-side cancel: fire held ⇒ isSprinting false; release trigger, keep aim.
    sprinting = false;
    weapon.setSessionInput(inputFrame({ moveY: 1, sprint: true, aim: true }));
    weapon.update(1 / 60, scene, []);
    expect(weapon.isADS()).toBe(true);
    weapon.dispose();
  });
});

function mockPlayer(options: {
  moving?: boolean;
  sprinting?: boolean;
  getSprinting?: () => boolean;
}): PlayerController {
  const moving = options.moving ?? false;
  return {
    isADSHeld: () => false,
    isSprinting: () => options.getSprinting?.() ?? options.sprinting ?? false,
    isMoving: () => moving,
    isDead: () => false,
    isPointerLocked: () => true,
    isFireHeld: () => false,
    addLookDelta: () => {},
    getHorizontalSpeed: () => (moving ? 4 : 0),
    isGrounded: () => true,
  } as unknown as PlayerController;
}

function createWeapon(player: PlayerController): {
  weapon: WeaponSystem;
  scene: Scene;
  shots: unknown[];
} {
  const camera = new PerspectiveCamera();
  camera.position.set(1, 2, 3);
  camera.lookAt(1, 2, 2);
  camera.updateMatrixWorld(true);
  const scene = new Scene();
  const shots: unknown[] = [];
  const weapon = new WeaponSystem({
    player,
    camera,
    viewModelScene: new Scene(),
    random: new SeededRandom(0x4d4f5645),
    presentationRandom: () => 0.5,
    callbacks: { onShot: (record) => shots.push(record) },
  });
  return { weapon, scene, shots };
}

function inputFrame(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
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
    ...overrides,
  };
}
