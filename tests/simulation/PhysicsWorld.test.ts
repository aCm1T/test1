import { afterEach, describe, expect, it } from 'vitest';
import { RapierPhysicsWorld } from '../../src/simulation/PhysicsWorld';

const worlds: RapierPhysicsWorld[] = [];

afterEach(() => {
  while (worlds.length > 0) worlds.pop()?.dispose();
});

async function world() {
  const physics = await RapierPhysicsWorld.create({ x: 0, y: -9.81, z: 0 });
  worlds.push(physics);
  physics.addStaticBox({
    id: 'ground', center: { x: 0, y: -0.5, z: 0 }, halfExtents: { x: 20, y: 0.5, z: 20 }, surface: 'concrete',
  });
  physics.addStaticBox({
    id: 'warehouse-wall', center: { x: 0, y: 1.5, z: 5 }, halfExtents: { x: 2, y: 1.5, z: 0.25 }, surface: 'metal',
  });
  return physics;
}

describe('RapierPhysicsWorld', () => {
  it('moves a capsule character through the authoritative collision world', async () => {
    const physics = await world();
    physics.addCharacter({ id: 'player', position: { x: 0, y: 1, z: 0 } });
    const moved = physics.moveCharacter('player', { translation: { x: 1, y: 0, z: 0 } });
    expect(moved.position.x).toBeGreaterThan(0.9);
    expect(moved.appliedTranslation.x).toBeGreaterThan(0.9);
  });

  it('returns the same static collider for hitscan, capsule sweep and surface queries', async () => {
    const physics = await world();
    const ray = physics.castRay({
      origin: { x: 0, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxDistance: 20,
    });
    const sweep = physics.sweepCapsule({
      position: { x: 0, y: 1, z: 0 }, radius: 0.2, halfHeight: 0.6,
      direction: { x: 0, y: 0, z: 1 }, maxDistance: 20,
    });
    expect(ray?.colliderId).toBe('warehouse-wall');
    expect(sweep?.colliderId).toBe('warehouse-wall');
    expect(physics.getSurfaceAt({ x: 0, y: 0, z: 0 })).toBe('concrete');
  });

  it('atomically removes fallback static colliders before authored collision is installed', async () => {
    const physics = await world();
    expect(physics.removeStaticColliders((id) => id === 'warehouse-wall')).toBe(1);
    physics.addStaticBox({
      id: 'authored:warehouse-wall',
      center: { x: 0, y: 1.5, z: 8 },
      halfExtents: { x: 2, y: 1.5, z: 0.25 },
      surface: 'metal',
    });
    expect(physics.castRay({
      origin: { x: 0, y: 1.5, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      maxDistance: 20,
    })?.colliderId).toBe('authored:warehouse-wall');
  });

  it('uses authored triangle geometry for rays and capsule sweeps without filling its bounds', async () => {
    const physics = await world();
    physics.addStaticTrimesh({
      id: 'authored:triangular-wall',
      vertices: [
        -2, 0, 8,
        2, 0, 8,
        0, 3, 8,
      ],
      indices: [0, 1, 2],
      surface: 'concrete',
    });
    expect(physics.getDebugStats()).toMatchObject({
      staticColliders: 3,
      trimeshColliders: 1,
      characters: 0,
      grenades: 0,
    });
    const ray = physics.castRay({
      origin: { x: 0, y: 1.5, z: 6 },
      direction: { x: 0, y: 0, z: 1 },
      maxDistance: 4,
      includeCharacters: false,
    });
    const sweep = physics.sweepCapsule({
      position: { x: 0, y: 1.2, z: 6 },
      direction: { x: 0, y: 0, z: 1 },
      maxDistance: 4,
      radius: 0.2,
      halfHeight: 0.6,
      includeCharacters: false,
    });
    expect(ray).toMatchObject({ colliderId: 'authored:triangular-wall', surface: 'concrete' });
    expect(sweep).toMatchObject({ colliderId: 'authored:triangular-wall', surface: 'concrete' });

    expect(physics.castRay({
      origin: { x: 1.8, y: 2.5, z: 6 },
      direction: { x: 0, y: 0, z: 1 },
      maxDistance: 4,
      includeCharacters: false,
    })).toBeNull();
  });

  it('rejects malformed authored triangle indices before unsigned conversion can mask them', async () => {
    const physics = await world();
    const vertices = [
      -1, 0, 0,
      1, 0, 0,
      0, 1, 0,
    ];
    for (const indices of [[-1, 1, 2], [0, 1.5, 2], [0, Number.NaN, 2]]) {
      expect(() => physics.addStaticTrimesh({
        id: 'invalid-triangle',
        vertices,
        indices,
      })).toThrow('Static trimesh indices must reference complete triangles');
    }
  });

  it('lets static-world rays ignore character capsules used by enemy motion', async () => {
    const physics = await world();
    physics.addCharacter({ id: 'hostile', position: { x: 0, y: 0.9, z: 2 } });
    const hit = physics.castRay({
      origin: { x: 0, y: 1.5, z: 0 },
      direction: { x: 0, y: 0, z: 1 },
      maxDistance: 20,
      includeCharacters: false,
    });
    expect(hit?.colliderId).toBe('warehouse-wall');
    expect(physics.getSurfaceAt({ x: 0, y: 0, z: 2 })).toBe('concrete');
  });

  it('skips the shooter capsule on character-excluded LOS rays', async () => {
    const physics = await world();
    physics.addCharacter({
      id: 'shooter',
      position: { x: 0, y: 0.9, z: 0 },
      radius: 0.32,
      halfHeight: 0.9,
    });
    // Origin sits just behind the capsule so a default cast self-hits the shooter.
    const origin = { x: 0, y: 1.5, z: -0.5 };
    const direction = { x: 0, y: 0, z: 1 };
    const distance = 5.5;
    const selfHit = physics.castRay({
      origin,
      direction,
      maxDistance: Math.max(0, distance - 0.02),
    });
    expect(selfHit).not.toBeNull();
    expect(selfHit?.colliderId).not.toBe('warehouse-wall');

    expect(physics.castRay({
      origin,
      direction,
      maxDistance: Math.max(0, distance - 0.02),
      includeCharacters: false,
    })?.colliderId).toBe('warehouse-wall');
  });

  it('owns interaction range and world occlusion queries', async () => {
    const physics = await world();
    physics.addCharacter({ id: 'player', position: { x: 0, y: 0.9, z: 2 } });
    expect(physics.queryInteraction({
      origin: { x: 0, y: 1.5, z: 0 },
      target: { x: 0, y: 1.5, z: 4 },
      maxDistance: 5,
      excludeBody: 'player',
    })).toBe(true);
    expect(physics.queryInteraction({
      origin: { x: 0, y: 1.5, z: 0 },
      target: { x: 0, y: 1.5, z: 8 },
      maxDistance: 10,
      excludeBody: 'player',
    })).toBe(false);
    expect(physics.queryInteraction({
      origin: { x: 0, y: 1.5, z: 0 },
      target: { x: 3, y: 1.5, z: 4 },
      maxDistance: 2,
    })).toBe(false);
  });

  it('resizes crouch capsules while preserving feet and rejects blocked stand-up', async () => {
    const physics = await world();
    physics.addStaticBox({
      id: 'low-ceiling',
      center: { x: 0, y: 1.75, z: -2 },
      halfExtents: { x: 1, y: 0.1, z: 1 },
      surface: 'concrete',
    });
    physics.addCharacter({
      id: 'player',
      position: { x: 0, y: 0.9, z: 0 },
      radius: 0.32,
      halfHeight: 0.9,
    });

    expect(physics.resizeCharacter('player', 0.32, 0.55)).toBe(true);
    physics.teleportCharacter('player', { x: 0, y: 0.55, z: -2 });
    expect(physics.resizeCharacter('player', 0.32, 0.9)).toBe(false);

    const moved = physics.moveCharacter('player', {
      translation: { x: 0.5, y: 0, z: 0 },
    });
    expect(moved.position.y).toBeCloseTo(0.55, 3);
  });

  it('simulates CCD grenade bodies and makes splash occlusion queryable', async () => {
    const physics = await world();
    physics.addGrenade({
      id: 'frag-1', position: { x: 0, y: 2, z: 0 }, velocity: { x: 0, y: 2, z: 4 }, radius: 0.09,
    });
    const before = physics.grenadePosition('frag-1');
    physics.step(1 / 60);
    const after = physics.grenadePosition('frag-1');
    expect(after?.z).toBeGreaterThan(before?.z ?? Infinity);
    expect(physics.grenadeVelocity('frag-1')).toMatchObject({ z: expect.any(Number) });
    const occluder = physics.castRay({
      origin: { x: 0, y: 1.5, z: 0 }, direction: { x: 0, y: 0, z: 1 }, maxDistance: 8,
    });
    expect(occluder?.colliderId).toBe('warehouse-wall');
  });

  it('restores grenade dynamic state exactly for checkpoint replay', async () => {
    const physics = await world();
    physics.addGrenade({
      id: 'frag-checkpoint',
      position: { x: 0, y: 2, z: 0 },
      velocity: { x: 1, y: 3, z: 4 },
      radius: 0.11,
    });
    physics.step(1 / 60);
    const checkpoint = physics.snapshotGrenade('frag-checkpoint');
    expect(checkpoint).not.toBeNull();

    physics.step(1 / 30);
    const after = physics.snapshotGrenade('frag-checkpoint');
    physics.restoreGrenade(checkpoint!);
    physics.step(1 / 30);

    const replay = physics.snapshotGrenade('frag-checkpoint');
    expect(replay?.position).toEqual(after?.position);
    expect(replay?.velocity).toEqual(after?.velocity);
    expect(replay?.radius).toBe(0.11);
  });
});
