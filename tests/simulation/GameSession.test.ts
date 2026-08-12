import { describe, expect, it } from 'vitest';
import { SeededRandom } from '../../src/mission';
import {
  GameSession,
  type CharacterId,
  type CharacterIntent,
  type CharacterMoveResult,
  type CapsuleSweep,
  type GameEvent,
  type GameSessionSystems,
  type GameWorldSnapshot,
  type InteractionQuery,
  type NavPath,
  type PathOptions,
  type PhysicsWorld,
  type RayHit,
  type RayQuery,
  type SurfaceTag,
  type SweepHit,
  type Vec3,
} from '../../src/simulation';

class TestPhysics implements PhysicsWorld {
  ticks = 0;
  constructor(private readonly order: string[]) {}
  step(): void { this.ticks += 1; this.order.push('physics'); }
  moveCharacter(_body: CharacterId, _intent: CharacterIntent): CharacterMoveResult {
    throw new Error('not used');
  }
  castRay(_query: RayQuery): RayHit | null { return null; }
  sweepCapsule(_query: CapsuleSweep): SweepHit | null { return null; }
  queryNavigation(_from: Vec3, _to: Vec3, _options?: PathOptions): NavPath | null { return null; }
  queryInteraction(_query: InteractionQuery): boolean { return false; }
  getSurfaceAt(_position: Vec3): SurfaceTag { return 'default'; }
}

interface SystemsOptions {
  /** Random draws the AI layer makes each tick, plus the squad event it reports. */
  aiDraws?: number;
  /**
   * Enemy outbound shots resolved in the AI phase — mirrors main.ts
   * `handleEnemyShot` (chance to hit + damage roll) on the forked AI stream.
   */
  enemyHitRolls?: number;
  squadEvents?: GameEvent[];
  /** Master combat stream state observed at the start of updateCombat each tick. */
  combatEntryStates?: number[];
}

function createSystems(
  order: string[],
  shots: GameEvent[],
  options: SystemsOptions = {},
): GameSessionSystems {
  const physics = new TestPhysics(order);
  let world: GameWorldSnapshot = {
    player: {
      position: { x: 0, y: 0, z: 0 },
      velocity: { x: 0, y: 0, z: 0 },
      health: 100,
      armor: 50,
      yaw: 0,
      pitch: 0,
      alive: true,
      crouching: false,
      grounded: true,
      sliding: false,
      slideTimer: 0,
      mantleCooldown: 0,
      eyeHeight: 1.62,
    },
    inventory: { ammunition: { ar: { mag: 30, reserve: 90 } }, equipment: {} },
    weapon: {
      active: 'ar',
      fireCooldown: 0,
      reloading: false,
      reloadRemaining: 0,
      ads: false,
      toggledAds: false,
      recoil: { pitch: 0, yaw: 0 },
      recoilShotIndex: 0,
      recoilPatternTimer: 0,
      spreadBloom: 0,
      dryFireLatch: false,
      prevFire: false,
      randomState: 22,
    },
    grenadeCount: 2,
    mission: { beat: 'insertion' },
    encounter: { firstContactComplete: false },
    ai: { alive: 2 },
  };
  return {
    physics,
    applyInput(input) {
      order.push('input');
      world.player.position.x += input.moveX;
    },
    updateNavigationAndAI(tick, _dt, random) {
      order.push('ai');
      const enemyShots = options.enemyHitRolls ?? 0;
      // Live pattern: enemy hit/damage RNG lives only on the AI fork.
      for (let index = 0; index < enemyShots; index += 1) {
        const hitChance = 0.35 + (index % 5) * 0.1;
        if (random.chance(hitChance)) {
          world.player.health -= 5 + random.next() * 10;
        }
      }
      const draws = options.aiDraws ?? 0;
      if (draws === 0 && enemyShots === 0) return;
      let roll = 0;
      for (let index = 0; index < draws; index += 1) roll = random.next();
      const event: GameEvent = {
        type: 'squad', tick, event: `flank:${roll.toFixed(6)}`, agentId: 'enemy:1',
      };
      options.squadEvents?.push(event);
      return draws > 0 || enemyShots > 0 ? [event] : undefined;
    },
    updateCombat(tick, _dt, random) {
      order.push('combat');
      options.combatEntryStates?.push(random.snapshot());
      if (!random.chance(0.5)) {
        world.weapon.randomState = random.snapshot();
        return [];
      }
      // Spread/recoil style draws — same stream player weapons consume.
      random.next();
      random.next();
      const event: GameEvent = {
        type: 'shot', tick, weapon: 'ar', seed: random.snapshot(),
        origin: { x: 0, y: 1.6, z: 0 }, direction: { x: 0, y: 0, z: 1 }, hit: null,
      };
      world.weapon.randomState = event.seed;
      shots.push(event);
      return [event];
    },
    updateMission() { order.push('mission'); return []; },
    snapshotWorld: () => structuredClone(world),
    restoreWorld(snapshot) { world = structuredClone(snapshot); },
  };
}

describe('GameSession', () => {
  it('uses the required fixed-tick system order and records seeded weapon events', () => {
    const order: string[] = [];
    const shots: GameEvent[] = [];
    const events: GameEvent[] = [];
    const session = new GameSession({
      systems: createSystems(order, shots),
      seed: 8921,
      onEvent: (event) => events.push(event),
    });
    session.enqueueInput(1, {
      moveX: 1, moveY: 0, lookX: 0, lookY: 0,
      fire: true, firePressed: true, aim: false, aimPressed: false,
      reload: false, grenade: false, interact: false, jump: false,
      crouch: false, sprint: false, weaponCycle: 0,
    });
    session.step();
    expect(order).toEqual(['input', 'physics', 'ai', 'combat', 'mission']);
    expect(events).toEqual(shots);
    expect(events.every((event) => event.type !== 'shot' || typeof event.seed === 'number')).toBe(true);
  });

  it('fully restores player, inventory, weapon, grenade, mission, RNG, encounters and AI', () => {
    const firstOrder: string[] = [];
    const firstShots: GameEvent[] = [];
    const session = new GameSession({ systems: createSystems(firstOrder, firstShots), seed: 22 });
    session.enqueueInput(1, {
      moveX: 3, moveY: 0, lookX: 0, lookY: 0,
      fire: false, firePressed: false, aim: false, aimPressed: false,
      reload: false, grenade: false, interact: false, jump: false,
      crouch: false, sprint: false, weaponCycle: 0,
    });
    session.enqueueInput(3, {
      moveX: 2, moveY: 0, lookX: 0, lookY: 0,
      fire: false, firePressed: false, aim: false, aimPressed: false,
      reload: false, grenade: false, interact: false, jump: false,
      crouch: false, sprint: false, weaponCycle: 0,
    });
    session.step(2);
    const checkpoint = session.snapshot();
    session.step(3);
    const after = session.snapshot();
    session.restore(checkpoint);
    session.step(3);
    expect(session.snapshot()).toEqual(after);
  });

  it('rewinds the session clock so AI fork salts match the checkpoint epoch', () => {
    // Regression: death restore used to rewind world/RNG but leave GameSession.tick
    // on the post-death timeline, so random.fork(tick) salts diverged.
    const master = new SeededRandom(0x5449434b);
    const order: string[] = [];
    const shots: GameEvent[] = [];
    const session = new GameSession({
      systems: createSystems(order, shots),
      random: master,
    });
    session.step(40);
    const checkpointTick = session.tick;
    const checkpointRandom = master.snapshot();
    const expectedForkState = master.fork(checkpointTick).snapshot();

    session.step(25);
    expect(session.tick).toBe(checkpointTick + 25);
    master.restore(checkpointRandom);
    session.rewindClock(checkpointTick);

    expect(session.tick).toBe(checkpointTick);
    expect(master.fork(session.tick).snapshot()).toBe(expectedForkState);
    // Pending inputs at/before the restored tick must not fire after a rewind.
    expect(() => session.enqueueInput(checkpointTick, {
      moveX: 0, moveY: 0, lookX: 0, lookY: 0,
      fire: false, firePressed: false, aim: false, aimPressed: false,
      reload: false, grenade: false, interact: false, jump: false,
      crouch: false, sprint: false, weaponCycle: 0,
    })).toThrow(/future integer/);
  });

  it('restore() also rewinds tick so a full QA snapshot round-trip keeps fork salts', () => {
    const master = new SeededRandom(0x51415253);
    const session = new GameSession({
      systems: createSystems([], []),
      random: master,
    });
    session.step(12);
    const checkpoint = session.snapshot();
    const expectedFork = master.fork(checkpoint.tick).snapshot();
    session.step(30);
    session.restore(checkpoint);
    expect(session.tick).toBe(checkpoint.tick);
    expect(master.fork(session.tick).snapshot()).toBe(expectedFork);
  });

  it('rematch-style seed+clock reset matches a fresh run fork salt', () => {
    // Mirrors main.resetRunToOpening: restore(simulationSeed) + rewindClock(0)
    // after a spent run so rematch/early-death cannot pollute AI fork salts.
    const simulationSeed = 0x4e494748;
    const fresh = new SeededRandom(simulationSeed);
    const expectedOpeningFork = fresh.fork(0).snapshot();

    const master = new SeededRandom(simulationSeed);
    const session = new GameSession({
      systems: createSystems([], []),
      random: master,
    });
    session.step(48);
    for (let i = 0; i < 12; i += 1) master.next();
    expect(master.snapshot()).not.toBe(simulationSeed);
    expect(session.tick).toBeGreaterThan(0);

    master.restore(simulationSeed);
    session.rewindClock(0);

    expect(session.tick).toBe(0);
    expect(master.snapshot()).toBe(simulationSeed);
    expect(master.fork(session.tick).snapshot()).toBe(expectedOpeningFork);
  });

  it('QA capture restore without clock rewind diverges AI fork salts', () => {
    // Mirrors qaResetPresentation: restore master seed then qaStep. Without
    // rewindClock, leftover hip ticks salt fork() for the next capture state.
    const simulationSeed = 0x4e494748;
    const leftoverSteps = 22;
    const opening = new SeededRandom(simulationSeed).fork(0).snapshot();

    const drifted = new SeededRandom(simulationSeed);
    const driftedSession = new GameSession({
      systems: createSystems([], []),
      random: drifted,
    });
    driftedSession.step(leftoverSteps);
    drifted.restore(simulationSeed);
    expect(drifted.fork(driftedSession.tick).snapshot()).not.toBe(opening);

    const restored = new SeededRandom(simulationSeed);
    const restoredSession = new GameSession({
      systems: createSystems([], []),
      random: restored,
    });
    restoredSession.step(leftoverSteps);
    restored.restore(simulationSeed);
    restoredSession.rewindClock(0);
    expect(restoredSession.tick).toBe(0);
    expect(restored.fork(restoredSession.tick).snapshot()).toBe(opening);
  });

  it('isolates AI randomness from the combat stream and still replays it', () => {
    const run = (aiDraws: number) => {
      const order: string[] = [];
      const shots: GameEvent[] = [];
      const squadEvents: GameEvent[] = [];
      const events: GameEvent[] = [];
      const session = new GameSession({
        systems: createSystems(order, shots, { aiDraws, squadEvents }),
        seed: 4242,
        onEvent: (event) => events.push(event),
      });
      session.step(600);
      return { shots, squadEvents, events, snapshot: session.snapshot() };
    };

    const quiet = run(0);
    const chatty = run(9);
    const replay = run(9);

    // Tactical draws must not shift a single weapon roll.
    expect(chatty.shots).toEqual(quiet.shots);
    expect(chatty.snapshot).toEqual(quiet.snapshot);
    expect(chatty.squadEvents).toEqual(replay.squadEvents);
    // A per-tick fork means consecutive ticks still get different tactical rolls.
    expect(new Set(chatty.squadEvents.map((event) => (event as { event: string }).event)).size)
      .toBeGreaterThan(1);

    const firstShot = chatty.events.findIndex((event) => event.type === 'shot');
    expect(firstShot).toBeGreaterThan(0);
    expect(chatty.events[firstShot - 1].type).toBe('squad');
  });

  it('keeps player shot seeds and weapon.randomState identical when AI-phase enemy hit rolls fire', () => {
    // Regression lock for the sim-determinism finding: handleEnemyShot must consume
    // the GameSession AI fork (chance + damage), never the weapon/combat stream.
    const run = (enemyHitRolls: number) => {
      const order: string[] = [];
      const shots: GameEvent[] = [];
      const combatEntryStates: number[] = [];
      const session = new GameSession({
        systems: createSystems(order, shots, { enemyHitRolls, combatEntryStates }),
        seed: 0x454e454d,
      });
      session.step(480);
      const snap = session.snapshot();
      return {
        shots,
        combatEntryStates,
        weaponRandomState: snap.world.weapon.randomState,
        masterRandomState: snap.randomState,
        shotSeeds: shots
          .filter((event): event is Extract<GameEvent, { type: 'shot' }> => event.type === 'shot')
          .map((event) => event.seed),
      };
    };

    const quiet = run(0);
    const underFire = run(7);

    expect(underFire.shots).toEqual(quiet.shots);
    expect(underFire.shotSeeds).toEqual(quiet.shotSeeds);
    expect(underFire.weaponRandomState).toBe(quiet.weaponRandomState);
    expect(underFire.masterRandomState).toBe(quiet.masterRandomState);
    // Fork isolation: AI damage rolls never advance the combat stream mid-tick.
    expect(underFire.combatEntryStates).toEqual(quiet.combatEntryStates);
    expect(quiet.shotSeeds.length).toBeGreaterThan(0);
  });

  it('does not advance the master combat SeededRandom when AI forks draw', () => {
    const master = new SeededRandom(0x434f4d42);
    const before = master.snapshot();
    const ai = master.fork(42);
    for (let index = 0; index < 32; index += 1) {
      if (ai.chance(0.4)) ai.next();
    }
    expect(master.snapshot()).toBe(before);
    master.next();
    expect(master.snapshot()).not.toBe(before);
  });

  it('replays ten independent fixed-seed ten-minute soak simulations identically', () => {
    const runs = Array.from({ length: 10 }, (_, index) => {
      const order: string[] = [];
      const shots: GameEvent[] = [];
      const session = new GameSession({ systems: createSystems(order, shots), seed: 100 + index });
      session.step(60 * 60 * 10);
      return { snapshot: session.snapshot(), shotCount: shots.length };
    });
    for (const [index, expected] of runs.entries()) {
      const order: string[] = [];
      const shots: GameEvent[] = [];
      const replay = new GameSession({ systems: createSystems(order, shots), seed: 100 + index });
      replay.step(60 * 60 * 10);
      expect({ snapshot: replay.snapshot(), shotCount: shots.length }).toEqual(expected);
    }
  });

  it('round-trips weapon recoil pattern and bloom through the world snapshot', () => {
    const order: string[] = [];
    const shots: GameEvent[] = [];
    const systems = createSystems(order, shots);
    const session = new GameSession({ systems, seed: 77 });
    const before = session.snapshot();
    before.world.weapon.recoilShotIndex = 5;
    before.world.weapon.recoilPatternTimer = 0.42;
    before.world.weapon.spreadBloom = 0.37;
    before.world.weapon.recoil = { pitch: 0.08, yaw: -0.02 };
    systems.restoreWorld(before.world);

    const restored = session.snapshot().world.weapon;
    expect(restored.recoilShotIndex).toBe(5);
    expect(restored.recoilPatternTimer).toBeCloseTo(0.42, 5);
    expect(restored.spreadBloom).toBeCloseTo(0.37, 5);
    expect(restored.recoil).toEqual({ pitch: 0.08, yaw: -0.02 });
    // Restoring must not silently drop the fields (cloneWorld retains them).
    expect('recoilShotIndex' in restored).toBe(true);
    expect('recoilPatternTimer' in restored).toBe(true);
    expect('spreadBloom' in restored).toBe(true);
  });
});
