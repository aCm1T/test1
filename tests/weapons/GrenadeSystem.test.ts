import { PerspectiveCamera, Scene, Vector3 } from 'three';
import { describe, expect, it, vi } from 'vitest';
import type { HitscanEnemy } from '../../src/combat';
import type { RapierPhysicsWorld } from '../../src/simulation';
import { GrenadeSystem } from '../../src/weapons';
import type { GrenadeBounce, GrenadeExplosion } from '../../src/weapons';

describe('GrenadeSystem', () => {
  it('uses the shared Rapier query as the sole splash-occlusion authority', () => {
    const clear = scenario(false);
    const blocked = scenario(true);

    clear.system.throw();
    blocked.system.throw();
    for (let index = 0; index < 70; index += 1) {
      clear.system.update(0.04, [clear.enemy]);
      blocked.system.update(0.04, [blocked.enemy]);
    }
    expect(clear.damage).toHaveLength(1);
    expect(blocked.damage).toHaveLength(0);
    expect(clear.physics.castRay).toHaveBeenCalled();
    expect(blocked.physics.castRay).toHaveBeenCalled();
    clear.system.dispose();
    blocked.system.dispose();
  });

  it('applies optional player splash with the same distance falloff as enemies', () => {
    const blastRadius = 6.5;
    const grenadeAt = { x: 0, y: 1.2, z: -1 };
    const nearPos = { x: 0, y: 1.0, z: -2.5 };
    const farPos = { x: 0, y: 1.0, z: -20 };
    const nearDist = Math.hypot(
      nearPos.x - grenadeAt.x,
      nearPos.y - grenadeAt.y,
      nearPos.z - grenadeAt.z,
    );
    const expectedNear = 35 + (1 - nearDist / blastRadius) * 95;

    const nearHits: number[] = [];
    const farHits: number[] = [];
    const nearExplosions: GrenadeExplosion[] = [];
    const farExplosions: GrenadeExplosion[] = [];

    const near = playerSplashScenario(grenadeAt, nearPos, nearHits, nearExplosions);
    const far = playerSplashScenario(grenadeAt, farPos, farHits, farExplosions);

    near.system.throw();
    far.system.throw();
    for (let index = 0; index < 70; index += 1) {
      near.system.update(0.04, []);
      far.system.update(0.04, []);
    }

    expect(nearHits).toHaveLength(1);
    expect(nearHits[0]).toBeCloseTo(expectedNear, 5);
    expect(nearExplosions[0].playerDamage).toBeCloseTo(expectedNear, 5);
    expect(nearHits[0]).toBeLessThan(130);
    expect(nearHits[0]).toBeGreaterThan(35);

    expect(farHits).toHaveLength(0);
    expect(farExplosions[0].playerDamage).toBe(0);

    near.system.dispose();
    far.system.dispose();
  });

  it('restores inventory and removes every in-flight Rapier body', () => {
    const test = scenario(false);
    expect(test.system.throw()).toBe(true);
    expect(test.system.snapshotState()).toMatchObject({ remaining: 1, serial: 1, grenades: [{ id: 'frag-1' }] });
    test.system.restoreState({ remaining: 2, serial: 0, grenades: [] });
    expect(test.system.snapshotState()).toEqual({ remaining: 2, serial: 0, grenades: [] });
    expect(test.physics.removeGrenade).toHaveBeenCalledWith('frag-1');
    test.system.dispose();
  });

  it('restores live fuse state, presentation pose and shared physics body state', () => {
    const test = scenario(false);
    expect(test.system.throw()).toBe(true);
    test.system.update(0.3, []);
    const checkpoint = test.system.snapshotState();

    test.system.update(0.4, []);
    test.system.restoreState(checkpoint);

    expect(test.system.snapshotState()).toEqual(checkpoint);
    expect(test.physics.restoreGrenade).toHaveBeenCalledWith(checkpoint.grenades![0].physics);
    test.system.dispose();
  });

  it('throws once across two consecutive held frames', () => {
    const test = scenario(false);
    expect(test.system.getRemaining()).toBe(2);
    expect(test.system.setThrowHeld(true)).toBe(true);
    expect(test.system.getRemaining()).toBe(1);
    expect(test.system.setThrowHeld(true)).toBe(false);
    expect(test.system.getRemaining()).toBe(1);
    expect(test.physics.addGrenade).toHaveBeenCalledTimes(1);
    test.system.setThrowHeld(false);
    expect(test.system.setThrowHeld(true)).toBe(true);
    expect(test.system.getRemaining()).toBe(0);
    expect(test.physics.addGrenade).toHaveBeenCalledTimes(2);
    test.system.dispose();
  });

  it('reset clears serial and throw latch like an empty restore', () => {
    const test = scenario(false);
    expect(test.system.throw()).toBe(true);
    expect(test.system.throw()).toBe(true);
    expect(test.system.snapshotState()).toMatchObject({ remaining: 0, serial: 2 });
    // Rematch can pause while grenade is still held — latch must not survive reset.
    test.system.setThrowHeld(true);
    expect(test.system.setThrowHeld(true)).toBe(false);

    test.system.reset();
    expect(test.system.snapshotState()).toEqual({ remaining: 2, serial: 0, grenades: [] });
    expect(test.system.setThrowHeld(true)).toBe(true);
    expect(test.system.snapshotState()).toMatchObject({
      remaining: 1,
      serial: 1,
      grenades: [{ id: 'frag-1' }],
    });
    test.system.dispose();
  });
});

describe('grenade feedback', () => {
  it('clacks once per impact with the speed that produced it', () => {
    const test = juiceScenario();
    test.system.throw();
    runToDetonation(test);

    expect(test.bounces.length).toBeGreaterThan(0);
    // Each impact must be reported exactly once, in order, with a real speed.
    expect(test.bounces.map((b) => b.bounces)).toEqual(
      test.bounces.map((_, index) => index + 1),
    );
    for (const bounce of test.bounces) {
      expect(bounce.speed).toBeGreaterThan(0);
      expect(Number.isFinite(bounce.position.y)).toBe(true);
    }
    test.system.dispose();
  });

  it('infers Rapier bounce edges from vertical velocity reversals', () => {
    const camera = new PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.6, -1);
    camera.updateMatrixWorld(true);
    const bounces: GrenadeBounce[] = [];
    const samples = [
      { x: 0, y: -8, z: -6 },
      { x: 0, y: -9, z: -5.5 },
      { x: 0, y: 3.6, z: -4.2 }, // restitution kick after ground contact
      { x: 0, y: 2.4, z: -3.8 },
      { x: 0, y: -1.2, z: -3.2 },
      { x: 0, y: 1.1, z: -2.6 }, // second bounce
    ];
    let sampleIndex = 0;
    const physics = {
      addGrenade: vi.fn(),
      grenadePosition: vi.fn(() => ({ x: 0, y: 0.4, z: -1 })),
      grenadeVelocity: vi.fn(() => samples[Math.min(sampleIndex, samples.length - 1)]),
      snapshotGrenade: vi.fn(),
      restoreGrenade: vi.fn(),
      removeGrenade: vi.fn(),
      castRay: vi.fn(() => null),
    };
    const system = new GrenadeSystem({
      scene: new Scene(),
      camera,
      colliders: [],
      physicsWorld: physics as unknown as RapierPhysicsWorld,
      onBounce: (event) => bounces.push(event),
    });
    expect(system.throw()).toBe(true);
    for (let i = 0; i < samples.length; i++) {
      sampleIndex = i;
      system.update(0.04, []);
    }
    expect(bounces.length).toBeGreaterThanOrEqual(2);
    expect(bounces.map((b) => b.bounces)).toEqual(
      bounces.map((_, index) => index + 1),
    );
    system.dispose();
  });

  it('does not re-clack impacts a rewind has already reported', () => {
    const test = juiceScenario();
    test.system.throw();
    // Long enough for the frag to land, bounce out its restitution and settle,
    // but short of the fuse.
    for (let i = 0; i < 60; i++) test.system.update(0.04, []);
    expect(test.bounces.length).toBeGreaterThanOrEqual(3);

    const checkpoint = test.system.snapshotState();
    const reported = test.bounces.length;
    test.system.restoreState(checkpoint);
    test.system.update(0.04, []);

    expect(test.bounces).toHaveLength(reported);
    test.system.dispose();
  });

  it('emits a throttled fuse trail instead of one puff per frame', () => {
    const test = juiceScenario();
    test.system.throw();
    const frames = runToDetonation(test);

    // Roughly fuse length / trail interval, and far fewer than the frame count.
    expect(test.trail.length).toBeGreaterThan(15);
    expect(test.trail.length).toBeLessThan(frames);
    test.system.dispose();
  });

  it('reports the true camera distance at detonation so the blast can attenuate', () => {
    const far = juiceScenario();
    const near = juiceScenario((camera) => camera.lookAt(0, 0, 0));

    far.system.throw();
    near.system.throw();
    runToDetonation(far);
    runToDetonation(near);

    expect(far.explosions).toHaveLength(1);
    expect(near.explosions).toHaveLength(1);
    for (const test of [far, near]) {
      const event = test.explosions[0];
      expect(event.distanceToCamera).toBeCloseTo(
        test.camera.position.distanceTo(event.position),
        5,
      );
      expect(event.radius).toBeGreaterThan(0);
    }
    expect(near.explosions[0].distanceToCamera)
      .toBeLessThan(far.explosions[0].distanceToCamera * 0.4);
    far.system.dispose();
    near.system.dispose();
  });
});

function juiceScenario(aim?: (camera: PerspectiveCamera) => void) {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  if (aim) aim(camera);
  else camera.lookAt(0, 1.6, -1);
  camera.updateMatrixWorld(true);

  const bounces: GrenadeBounce[] = [];
  const trail: Vector3[] = [];
  const explosions: GrenadeExplosion[] = [];
  // No Rapier world here: this exercises the ballistic fallback that owns its
  // own bounce accounting.
  const system = new GrenadeSystem({
    scene: new Scene(),
    camera,
    colliders: [],
    onBounce: (event) => bounces.push(event),
    onTrail: (position) => trail.push(position),
    onExplode: (event) => explosions.push(event),
  });
  return { system, camera, bounces, trail, explosions };
}

/** Runs fixed ticks until the frag detonates. Returns the frame count used. */
function runToDetonation(test: ReturnType<typeof juiceScenario>): number {
  for (let i = 1; i <= 200; i++) {
    test.system.update(0.04, []);
    if (test.explosions.length > 0) return i;
  }
  throw new Error('grenade never detonated');
}

function scenario(blocked: boolean) {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.6, -1);
  camera.updateMatrixWorld(true);
  const damage: number[] = [];
  const enemy: HitscanEnemy = {
    alive: true,
    getHitboxes: () => [{
      min: new Vector3(-0.3, 0.8, -2.3),
      max: new Vector3(0.3, 1.8, -1.7),
      bodyPart: 'torso',
    }],
    takeDamage: (amount) => {
      damage.push(amount);
      return false;
    },
  };
  const physics = {
    addGrenade: vi.fn(),
    grenadePosition: vi.fn(() => ({ x: 0, y: 1.2, z: -1 })),
    snapshotGrenade: vi.fn((id: string) => ({
      id,
      position: { x: 0, y: 1.2, z: -1 },
      velocity: { x: 0, y: 4.8, z: -12.5 },
      rotation: { x: 0, y: 0, z: 0, w: 1 },
      angularVelocity: { x: 0, y: 0, z: 0 },
      radius: 0.09,
    })),
    restoreGrenade: vi.fn(),
    removeGrenade: vi.fn(),
    castRay: vi.fn(() => blocked ? {
      colliderId: 'authored:wall',
      point: { x: 0, y: 1.2, z: -1.5 },
      normal: { x: 0, y: 0, z: 1 },
      distance: 0.5,
      surface: 'concrete' as const,
    } : null),
  };
  const system = new GrenadeSystem({
    scene: new Scene(),
    camera,
    colliders: [{ min: new Vector3(-10, 0, -1.5), max: new Vector3(10, 3, -1.4) }],
    physicsWorld: physics as unknown as RapierPhysicsWorld,
  });
  return { system, enemy, physics, damage };
}

function playerSplashScenario(
  grenadeAt: { x: number; y: number; z: number },
  playerAt: { x: number; y: number; z: number },
  hits: number[],
  explosions: GrenadeExplosion[],
) {
  const camera = new PerspectiveCamera();
  camera.position.set(0, 1.6, 0);
  camera.lookAt(0, 1.6, -1);
  camera.updateMatrixWorld(true);
  const physics = {
    addGrenade: vi.fn(),
    grenadePosition: vi.fn(() => ({ ...grenadeAt })),
    snapshotGrenade: vi.fn(),
    restoreGrenade: vi.fn(),
    removeGrenade: vi.fn(),
    castRay: vi.fn(() => null),
  };
  const system = new GrenadeSystem({
    scene: new Scene(),
    camera,
    colliders: [],
    physicsWorld: physics as unknown as RapierPhysicsWorld,
    getPlayerPosition: () => playerAt,
    onPlayerDamage: (amount) => hits.push(amount),
    onExplode: (event) => explosions.push(event),
  });
  return { system, physics };
}
