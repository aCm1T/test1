import { Vector3 } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { PlayerController } from '../../src/player';

type TestDocument = EventTarget & {
  pointerLockElement: object | null;
  body: { requestPointerLock(): void };
};

let testWindow: EventTarget & { innerWidth: number; innerHeight: number };
let testDocument: TestDocument;

beforeEach(() => {
  testWindow = Object.assign(new EventTarget(), { innerWidth: 1920, innerHeight: 1080 });
  testDocument = Object.assign(new EventTarget(), {
    pointerLockElement: null,
    body: { requestPointerLock() {} },
  });
  vi.stubGlobal('window', testWindow);
  vi.stubGlobal('document', testDocument);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('PlayerController fixed-tick input sampling', () => {
  it('captures held controls and consumes pointer/action edges exactly once', () => {
    const player = new PlayerController();
    testDocument.pointerLockElement = {};
    testDocument.dispatchEvent(new Event('pointerlockchange'));

    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });
    dispatchWindow('keydown', { code: 'KeyC' });
    dispatchWindow('keydown', { code: 'Space' });
    dispatchWindow('keydown', { code: 'KeyR' });
    dispatchWindow('keydown', { code: 'KeyG' });
    dispatchWindow('keydown', { code: 'KeyE' });
    dispatchWindow('keydown', { code: 'Digit2' });
    dispatchWindow('mousedown', { button: 0 });
    dispatchWindow('mousedown', { button: 2 });
    dispatchWindow('mousemove', { movementX: 12, movementY: -4 });
    dispatchWindow('wheel', { deltaY: 1 });

    expect(player.sampleInputFrame()).toMatchObject({
      moveX: 0,
      moveY: 1,
      lookX: 12,
      lookY: -4,
      fire: true,
      firePressed: true,
      aim: true,
      aimPressed: true,
      reload: true,
      grenade: true,
      interact: true,
      jump: true,
      crouch: true,
      sprint: true,
      weaponSlot: 2,
      weaponCycle: 1,
    });

    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      lookX: 0,
      lookY: 0,
      fire: true,
      firePressed: false,
      aim: true,
      aimPressed: false,
      reload: false,
      grenade: false,
      interact: false,
      jump: false,
      crouch: true,
      sprint: true,
      weaponCycle: 0,
    });
    expect(player.sampleInputFrame().weaponSlot).toBeUndefined();
    player.dispose();
  });

  it('round-trips every simulation-affecting player field', () => {
    const player = new PlayerController();
    const restored = {
      ...player.snapshotState(),
      position: { x: 4, y: 1, z: 9 },
      velocity: { x: 2, y: -3, z: 5 },
      health: 37,
      armor: 12,
      yaw: 1.2,
      pitch: -0.3,
      alive: true,
      crouching: true,
      grounded: true,
      sliding: true,
      slideTimer: 0.42,
      mantleCooldown: 0.18,
      eyeHeight: 1.16,
    };
    player.restoreState(restored);
    expect(player.snapshotState()).toEqual(restored);
    player.dispose();
  });

  it('resyncHeldKeys restores sustained WASD after clearInput without re-arming edges', () => {
    const player = new PlayerController();
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });
    dispatchWindow('keydown', { code: 'Space' });
    dispatchWindow('mousedown', { button: 0 });

    const held = player.getHeldKeyCodes();
    expect(held).toEqual(expect.arrayContaining(['KeyW', 'ShiftLeft', 'Space', 'MouseLeft']));

    // First sample consumes the jump edge; clear then resync must not re-fire it.
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      sprint: true,
      jump: true,
      fire: true,
      firePressed: true,
    });

    player.clearInput();
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 0,
      sprint: false,
      jump: false,
      fire: false,
    });

    player.resyncHeldKeys(held);
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      sprint: true,
      jump: false,
      fire: false,
      firePressed: false,
    });
    player.dispose();
  });

  it('beginInputSuspend/endInputSuspend restores holds and drops keys released while paused', () => {
    const player = new PlayerController();
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'KeyA' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });
    dispatchWindow('mousedown', { button: 0 });

    player.beginInputSuspend();
    expect(player.isInputSuspended()).toBe(true);
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 0,
      moveX: 0,
      sprint: false,
      fire: false,
    });

    // Released during pause must not come back on resume.
    dispatchWindow('keyup', { code: 'KeyA' });
    // Still held through the menu — and a fresh press while suspended.
    dispatchWindow('keydown', { code: 'KeyD' });

    player.endInputSuspend();
    expect(player.isInputSuspended()).toBe(false);
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      moveX: 1,
      sprint: true,
      fire: false,
      firePressed: false,
    });
    player.dispose();
  });

  it('blur-before-beginInputSuspend race still restores WASD on resume', () => {
    const player = new PlayerController();
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'KeyD' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });

    // Historical alt-tab order: window blur clears before pointer-unlock
    // beginInputSuspend. Bare clearInput left the suspend snapshot empty.
    dispatchWindow('blur', {});
    expect(player.isInputSuspended()).toBe(true);
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 0,
      moveX: 0,
      sprint: false,
    });

    player.beginInputSuspend();
    player.endInputSuspend();
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      moveX: 1,
      sprint: true,
    });
    player.dispose();
  });

  it('death restore drains blur suspend so held WASD survive auto-respawn', () => {
    const player = new PlayerController();
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'KeyA' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });

    // Alt-tab during death delay: blur suspends, pointer-unlock skips pause
    // while dead, so getHeldKeyCodes() would see an empty live set.
    dispatchWindow('blur', {});
    expect(player.isInputSuspended()).toBe(true);
    expect(player.getHeldKeyCodes()).toEqual([]);

    const held = player.consumeHeldKeysForRestore();
    expect(player.isInputSuspended()).toBe(false);
    expect(held).toEqual(expect.arrayContaining(['KeyW', 'KeyA', 'ShiftLeft']));

    // Mirror updateDeathRestore: restoreState clearInput'd, then resync.
    player.restoreState({
      ...player.snapshotState(),
      grounded: true,
    });
    player.resyncHeldKeys(held);
    expect(player.sampleInputFrame()).toMatchObject({
      moveY: 1,
      moveX: -1,
      sprint: true,
    });
    player.dispose();
  });

  it('does not re-edge startSlide when restoring while crouch is held', () => {
    const player = new PlayerController();
    const floor = {
      min: new Vector3(-20, -1, -20),
      max: new Vector3(20, 0, 20),
    };
    // Fast grounded crouch pose — without previousSessionCrouch latch, a held
    // crouch+sprint frame would re-fire startSlide after restore.
    player.restoreState({
      ...player.snapshotState(),
      velocity: { x: 0, y: 0, z: 8 },
      crouching: true,
      grounded: true,
      sliding: false,
      slideTimer: 0,
    });
    expect(player.isSliding()).toBe(false);

    player.setSessionInput({
      moveX: 0,
      moveY: 1,
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
      crouch: true,
      sprint: true,
      weaponCycle: 0,
    });
    player.update(1 / 60, [floor]);
    expect(player.isSliding()).toBe(false);
    expect(player.isCrouching()).toBe(true);
    player.dispose();
  });

  it('resyncHeldKeys latches crouch so death restore does not startSlide', () => {
    const player = new PlayerController();
    const floor = {
      min: new Vector3(-20, -1, -20),
      max: new Vector3(20, 0, 20),
    };
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });
    dispatchWindow('keydown', { code: 'KeyC' });
    const held = player.getHeldKeyCodes();

    // Death restore path: restoreState already clears input; do not clear again
    // (that would wipe restored slide), only resyncHeldKeys(held).
    player.restoreState({
      ...player.snapshotState(),
      velocity: { x: 0, y: 0, z: 8 },
      crouching: true,
      grounded: true,
      sliding: false,
      slideTimer: 0,
    });
    player.resyncHeldKeys(held);

    const frame = player.sampleInputFrame();
    expect(frame).toMatchObject({ crouch: true, sprint: true, moveY: 1 });
    player.setSessionInput(frame);
    player.update(1 / 60, [floor]);
    expect(player.isSliding()).toBe(false);
    expect(player.isCrouching()).toBe(true);
    player.dispose();
  });

  it('death restore keeps slide pose when crouch was released during the death delay', () => {
    const player = new PlayerController();
    const floor = {
      min: new Vector3(-20, -1, -20),
      max: new Vector3(20, 0, 20),
    };
    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('keydown', { code: 'ShiftLeft' });
    // Crouch was held at death, then released during the restore countdown —
    // heldKeys captured at restore time must not include KeyC.
    const held = ['KeyW', 'ShiftLeft'];

    player.restoreState({
      ...player.snapshotState(),
      velocity: { x: 0, y: 0, z: 9 },
      crouching: true,
      grounded: true,
      sliding: true,
      slideTimer: 0.42,
      eyeHeight: 1.16,
    });
    // Bug regression: a second clearInput after restoreState zeroed sliding.
    player.resyncHeldKeys(held);

    expect(player.isSliding()).toBe(true);
    expect(player.snapshotState().slideTimer).toBeCloseTo(0.42, 5);
    expect(player.sampleInputFrame()).toMatchObject({ crouch: false, sprint: true, moveY: 1 });

    player.setSessionInput(player.sampleInputFrame());
    player.update(1 / 60, [floor]);
    // Slide continues from restored timer; crouch intent follows live keys.
    expect(player.isSliding()).toBe(true);
    expect(player.isCrouching()).toBe(true);
    player.dispose();
  });

  it('samples walk+fire together and keeps wishDir when fire is in the session frame', () => {
    const player = new PlayerController();
    testDocument.pointerLockElement = {};
    testDocument.dispatchEvent(new Event('pointerlockchange'));

    dispatchWindow('keydown', { code: 'KeyW' });
    dispatchWindow('mousedown', { button: 0 });
    const frame = player.sampleInputFrame();
    expect(frame).toMatchObject({ moveY: 1, fire: true, firePressed: true });

    player.setSessionInput({ ...frame, fire: true, sprint: true, moveY: 1 });
    player.update(1 / 60, []);
    expect(player.isMoving()).toBe(true);
    expect(player.isFireHeld()).toBe(true);
    // Fire cancels sprint for ADS/pose/speed — CoD hipfire at walk speed.
    expect(player.isSprinting()).toBe(false);
    player.dispose();
  });

  it('reports sprint only while shift+forward is held without fire', () => {
    const player = new PlayerController();
    // Empty collider lists clear grounded every tick; give the feet a floor.
    const floor = {
      min: new Vector3(-20, -1, -20),
      max: new Vector3(20, 0, 20),
    };
    const sprintFrame = {
      moveX: 0,
      moveY: 1,
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
      sprint: true,
      weaponCycle: 0,
    };
    player.setSessionInput(sprintFrame);
    player.update(1 / 60, [floor]);
    expect(player.isSprinting()).toBe(true);

    player.setSessionInput({ ...sprintFrame, fire: true, firePressed: true });
    player.update(1 / 60, [floor]);
    expect(player.isSprinting()).toBe(false);
    expect(player.isMoving()).toBe(true);
    player.dispose();
  });

  it('records Rapier landing impact from fall speed before zeroing velocity', () => {
    const player = new PlayerController();
    let grounded = false;
    const idle = {
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
      weaponCycle: 0 as const,
    };
    const physics = {
      moveCharacter: vi.fn((_id: string, intent: { translation: { x: number; y: number; z: number } }) => ({
        position: { x: 0, y: grounded ? 0.9 : 3, z: 0 },
        grounded,
        appliedTranslation: grounded
          ? { x: intent.translation.x, y: 0, z: intent.translation.z }
          : { ...intent.translation },
        collisions: grounded ? [{ normal: { x: 0, y: 1, z: 0 } }] : [],
      })),
      teleportCharacter: vi.fn(),
      resizeCharacter: vi.fn(),
    };
    player.setPhysicsWorld(physics as never);
    player.restoreState({
      ...player.snapshotState(),
      position: { x: 0, y: 2.5, z: 0 },
      velocity: { x: 0, y: -14, z: 0 },
      grounded: false,
    });

    player.setSessionInput(idle);
    grounded = false;
    player.update(1 / 60, []);
    expect(player.justDidLand()).toBe(false);

    grounded = true;
    player.update(1 / 60, []);
    expect(player.justDidLand()).toBe(true);
    expect(player.getLandImpact()).toBeGreaterThan(0.5);
    player.dispose();
  });

  it('uses AABB movement until PhysicsWorld binds, then routes through moveCharacter', () => {
    const player = new PlayerController();
    const move = {
      moveX: 0,
      moveY: 1,
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
      weaponCycle: 0 as const,
    };
    const moveCharacter = vi.fn((_id: string, intent: { translation: { x: number; y: number; z: number } }) => ({
      position: {
        x: player.getPositionRef().x + intent.translation.x,
        y: 0.9,
        z: player.getPositionRef().z + intent.translation.z,
      },
      grounded: true,
      appliedTranslation: { ...intent.translation },
      collisions: [],
    }));

    player.setPosition(0, 0, 0);
    player.setSessionInput(move);
    player.update(1 / 60, []);
    expect(moveCharacter).not.toHaveBeenCalled();
    expect(player.getPositionRef().z).not.toBe(0);

    player.setPhysicsWorld({
      moveCharacter,
      teleportCharacter: vi.fn(),
      resizeCharacter: vi.fn(),
    } as never);
    player.setSessionInput(move);
    player.update(1 / 60, []);
    expect(moveCharacter).toHaveBeenCalled();
    player.dispose();
  });

  it('ignores heal and armor while dead', () => {
    const player = new PlayerController();
    player.takeDamage(999);
    expect(player.isAlive()).toBe(false);
    const before = player.snapshotState();
    player.heal(40);
    player.addArmor(40);
    expect(player.snapshotState().armor).toBe(before.armor);
    expect(player.snapshotState().health).toBe(before.health);
    player.dispose();
  });
});

function dispatchWindow(type: string, properties: Record<string, unknown>): void {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  testWindow.dispatchEvent(event);
}
