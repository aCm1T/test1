import * as THREE from 'three';
import { describe, expect, it, vi } from 'vitest';
import { SeededRandom } from '../../src/mission';
import { Enemy, EnemyManager, type EnemyMovementAuthority, type HitPart } from '../../src/enemies';
import { GrenadeSystem } from '../../src/weapons';
import type { Level } from '../../src/world';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';

describe('Enemy simulation state', () => {
  it('replays delegated motion from a complete AI snapshot', () => {
    const random = new SeededRandom(73);
    const movement: EnemyMovementAuthority = {
      move: (_enemy, desiredTarget) => new THREE.Vector3(
        desiredTarget.x,
        desiredTarget.y,
        desiredTarget.z,
      ),
      release: () => {},
    };
    const enemy = new Enemy({
      id: 'hostile:alpha',
      position: new THREE.Vector3(0, 0, 0),
      randomSource: random,
      movementAuthority: movement,
    });
    const checkpoint = enemy.snapshotState();

    enemy.update(1 / 60, new THREE.Vector3(100, 0, 100));
    const after = enemy.snapshotState();
    enemy.restoreState(checkpoint);
    enemy.update(1 / 60, new THREE.Vector3(100, 0, 100));

    expect(enemy.snapshotState()).toEqual(after);
  });

  it('teleports Rapier motion onto the restored pose immediately', () => {
    const teleport = vi.fn();
    const release = vi.fn();
    const enemy = new Enemy({
      id: 'hostile:restore-physics',
      position: new THREE.Vector3(0, 0, 0),
      movementAuthority: {
        move: () => null,
        release,
        teleport,
      },
    });
    const checkpoint = enemy.snapshotState();
    enemy.mesh.position.set(12, 0, -8);
    enemy.restoreState({
      ...checkpoint,
      position: { x: 5.5, y: 1.25, z: -3.25 },
    });

    expect(teleport).toHaveBeenCalledTimes(1);
    expect(teleport.mock.calls[0][0]).toBe(enemy);
    expect(teleport.mock.calls[0][1]).toMatchObject({ x: 5.5, y: 1.25, z: -3.25 });
    expect(release).not.toHaveBeenCalled();
    enemy.dispose();
  });

  it('releases physics when a checkpoint restores a dead hostile', () => {
    const teleport = vi.fn();
    const release = vi.fn();
    const enemy = new Enemy({
      id: 'hostile:restore-dead-physics',
      position: new THREE.Vector3(2, 0, 4),
      movementAuthority: {
        move: () => null,
        release,
        teleport,
      },
    });
    const checkpoint = enemy.snapshotState();
    enemy.restoreState({
      ...checkpoint,
      alive: false,
      state: 'dead',
      health: 0,
    });

    expect(enemy.alive).toBe(false);
    expect(teleport).not.toHaveBeenCalled();
    expect(release).toHaveBeenCalledTimes(1);
    expect(release).toHaveBeenCalledWith(enemy);
    enemy.dispose();
  });

  it('keeps death crumple off the simulation world Y', () => {
    const enemy = new Enemy({
      id: 'hostile:collapse',
      position: new THREE.Vector3(3, 1.25, -2),
    });
    const spawnY = enemy.position.y;
    enemy.kill();
    for (let i = 0; i < 40; i++) {
      enemy.update(1 / 60, new THREE.Vector3(0, 1.25, 0));
    }
    expect(enemy.position.y).toBeCloseTo(spawnY, 5);
    expect(enemy.snapshotState().position.y).toBeCloseTo(spawnY, 5);
    expect(enemy.mesh.position.y).toBeCloseTo(spawnY, 5);
    const visual = enemy.mesh.getObjectByName('EnemyVisual');
    expect(visual).toBeTruthy();
    expect(visual!.position.y).toBeGreaterThan(0.05);
    expect(visual!.rotation.x).toBeGreaterThan(0.5);
    enemy.dispose();
  });

  it('releases its physics body and reserved cover exactly once on death', () => {
    let releasedMovement = 0;
    let releasedCover = 0;
    const enemy = new Enemy({
      id: 'hostile:bravo',
      movementAuthority: {
        move: () => null,
        release: () => { releasedMovement += 1; },
      },
      coverAuthority: {
        reserve: () => null,
        release: () => { releasedCover += 1; },
      },
    });
    enemy.kill();
    enemy.kill();

    expect(releasedMovement).toBe(1);
    expect(releasedCover).toBe(1);
  });

  it('interpolates the rendered pose without changing authoritative position', () => {
    const enemy = new Enemy({
      id: 'hostile:charlie',
      position: new THREE.Vector3(0, 0, 0),
      movementAuthority: {
        move: () => new THREE.Vector3(4, 0, 0),
        release: () => {},
      },
    });
    enemy.update(1 / 60, new THREE.Vector3(100, 0, 100));
    expect(enemy.position.x).toBe(4);

    enemy.applyRenderInterpolation(0.25);
    expect(enemy.mesh.position.x).toBeCloseTo(1);
    expect(enemy.position.x).toBe(4);
  });

  it('keeps the layered fallback silhouette behind stable combat hit-part tags', () => {
    const enemy = new Enemy({ id: 'hostile:visual-fallback' });
    enemy.mesh.updateWorldMatrix(true, true);
    const bounds = new THREE.Box3().setFromObject(enemy.mesh);
    const size = bounds.getSize(new THREE.Vector3());

    // The fallback remains character-scale rather than a compact prop, while
    // all of the secondary tactical geometry resolves to its primary hit part.
    expect(size.y).toBeGreaterThan(2);
    expect(size.y).toBeLessThan(2.35);
    const checks: Array<[string, 'head' | 'torso' | 'arm' | 'leg' | 'generic']> = [
      ['enemy_head', 'head'],
      ['enemy_torso', 'torso'],
      ['enemy_left_arm', 'arm'],
      ['enemy_right_leg', 'leg'],
      ['enemy_rifle', 'generic'],
    ];
    for (const [name, expectedPart] of checks) {
      const part = enemy.mesh.getObjectByName(name);
      expect(part).toBeTruthy();
      expect(part?.children.length).toBeGreaterThan(0);
      expect(Enemy.partFromObject(part?.children[0] ?? null)).toBe(expectedPart);
    }
    enemy.dispose();
  });

  it('installs authored animation clips and restores the explicit procedural fallback', () => {
    const enemy = new Enemy({ id: 'hostile:delta' });
    const source = riggedGroup();
    source.name = 'LicensedHostile';
    enemy.installAuthoredVisual({
      scene: source,
      animations: [
        new THREE.AnimationClip('idle', 1, []),
        new THREE.AnimationClip('locomotion', 1, []),
        new THREE.AnimationClip('reaction', 0.4, []),
        new THREE.AnimationClip('firing', 0.2, []),
        new THREE.AnimationClip('reload', 1, []),
        new THREE.AnimationClip('death', 1, []),
        new THREE.AnimationClip('cover', 1, []),
      ],
    } as GLTF);

    expect(enemy.hasAuthoredVisual()).toBe(true);
    expect(enemy.mesh.getObjectByName('AuthoredHostile:hostile:delta')).toBeTruthy();
    enemy.kill();
    enemy.update(1 / 60, new THREE.Vector3());
    enemy.clearAuthoredVisual();
    expect(enemy.hasAuthoredVisual()).toBe(false);
    const visual = enemy.mesh.getObjectByName('EnemyVisual');
    expect(visual?.children.some((child) => child.userData.proceduralFallback && child.visible)).toBe(true);
    enemy.dispose();
  });

  it('rejects a non-rigged or animation-incomplete hostile archetype', () => {
    const enemy = new Enemy({ id: 'hostile:invalid' });
    expect(() => enemy.installAuthoredVisual({
      scene: new THREE.Group(),
      animations: [new THREE.AnimationClip('idle', 1, [])],
    } as GLTF)).toThrow(/rigged SkinnedMesh/);
    expect(enemy.hasAuthoredVisual()).toBe(false);
    enemy.dispose();
  });

  it('enters and snapshots a deterministic authored reload cycle', () => {
    let shots = 0;
    const enemy = new Enemy({
      id: 'hostile:echo',
      fireInterval: 0,
      onShoot: () => { shots += 1; },
      lineOfSight: () => true,
    });
    enemy.state = 'combat';
    for (let index = 0; index < 9; index += 1) {
      enemy.update(1 / 60, new THREE.Vector3(0, 0, 5));
    }
    expect(shots).toBe(8);
    expect(enemy.state).toBe('reload');
    expect(enemy.snapshotState()).toMatchObject({ shotsRemaining: 0, reloadTimer: expect.any(Number) });
    enemy.update(2, new THREE.Vector3(0, 0, 5));
    expect(enemy.snapshotState().shotsRemaining).toBe(8);
    enemy.dispose();
  });

  it('restores bounded squad firing-slot ownership with the complete AI world', () => {
    const scene = new THREE.Scene();
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene, level, {
      maxAlive: 2,
      maxFireSlots: 1,
      fireSlotDuration: 2,
      lineOfSight: () => true,
      onEnemyShoot: () => {},
      seed: 91,
    });
    for (const enemy of manager.getAlive()) enemy.state = 'combat';
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    const checkpoint = manager.snapshotState();
    expect(checkpoint.fireSlots).toHaveLength(1);
    manager.update(2.5, new THREE.Vector3(0, 0, 0));
    manager.restoreState(checkpoint);
    expect(manager.snapshotState()).toEqual(checkpoint);
    manager.dispose();
  });

  it('resetToInitial rebuilds the opening roster after a mid-fight wipe', () => {
    const scene = new THREE.Scene();
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(0, 0, 0),
      enemySpawns: [
        new THREE.Vector3(-8, 0, 14),
        new THREE.Vector3(8, 0, 16),
        new THREE.Vector3(0, 0, 20),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene, level, {
      maxAlive: 6,
      seed: 44,
      lineOfSight: () => false,
      isSpawnVisible: () => false,
    });
    const opening = manager.snapshotState();
    expect(opening.enemies.length).toBeGreaterThan(0);
    for (const enemy of [...manager.getAlive()]) enemy.kill();
    manager.spawnAt(new THREE.Vector3(1, 0, 30));
    expect(manager.getAlive().some((enemy) => enemy.id !== opening.enemies[0].id)).toBe(true);

    manager.resetToInitial();
    const restarted = manager.snapshotState();
    expect(restarted.enemies).toHaveLength(opening.enemies.length);
    expect(restarted.enemies.every((enemy) => enemy.alive)).toBe(true);
    expect(restarted.elapsed).toBe(0);
    expect(restarted.spawnSerial).toBe(opening.spawnSerial);
    expect(restarted.randomState).toBe(opening.randomState);
    expect(restarted.enemies.map((enemy) => enemy.id)).toEqual(
      opening.enemies.map((enemy) => enemy.id),
    );
    manager.dispose();
  });
});

describe('Enemy combat behaviour', () => {
  it('breaks contact for cover the moment incoming fire becomes dangerous', () => {
    const enemy = new Enemy({
      id: 'hostile:pinned',
      position: new THREE.Vector3(0, 0, 0),
      coverNodes: [new THREE.Vector3(6, 0, -4)],
      lineOfSight: () => true,
    });
    enemy.state = 'combat';
    enemy.update(1 / 60, new THREE.Vector3(0, 0, 12));
    expect(enemy.getSuppression()).toBe(0);
    expect(enemy.isSuppressed()).toBe(false);

    enemy.applySuppression(0.9, new THREE.Vector3(0, 0, 12));
    expect(enemy.isSuppressed()).toBe(true);
    expect(enemy.state).toBe('cover');
    expect(enemy.getDebugState().coverTarget).toEqual({ x: 6, y: 0, z: -4 });
    enemy.dispose();
  });

  it('suppression thins out volume of fire without stopping the fight', () => {
    const countShots = (suppress: boolean): number => {
      let shots = 0;
      const enemy = new Enemy({
        id: 'hostile:cadence',
        position: new THREE.Vector3(0, 0, 0),
        fireInterval: 0.4,
        randomSource: new SeededRandom(31),
        lineOfSight: () => true,
        onShoot: () => { shots += 1; },
      });
      enemy.state = 'combat';
      for (let tick = 0; tick < 180; tick += 1) {
        if (suppress) enemy.applySuppression(0.02);
        enemy.update(1 / 60, new THREE.Vector3(0, 0, 14));
      }
      enemy.dispose();
      return shots;
    };
    const pinned = countShots(true);
    const free = countShots(false);
    expect(pinned).toBeLessThan(free);
    expect(pinned).toBeGreaterThan(0);
  });

  it('fires in bursts and holds the trigger between them', () => {
    let shots = 0;
    const enemy = new Enemy({
      id: 'hostile:burst',
      position: new THREE.Vector3(0, 0, 0),
      fireInterval: 0.4,
      randomSource: new SeededRandom(17),
      lineOfSight: () => true,
      onShoot: () => { shots += 1; },
    });
    enemy.state = 'combat';
    let observedPause = 0;
    for (let tick = 0; tick < 300; tick += 1) {
      enemy.update(1 / 60, new THREE.Vector3(0, 0, 14));
      observedPause = Math.max(observedPause, enemy.snapshotState().burstPause);
    }

    // A burst pause has to actually happen, and the resulting cadence must be
    // far below one round per available tick.
    expect(observedPause).toBeGreaterThan(0);
    expect(shots).toBeGreaterThan(3);
    expect(shots).toBeLessThan(24);
    enemy.dispose();
  });

  it('amortizes LOS casts on a fixed-tick schedule for cold hostiles', () => {
    const los = vi.fn(() => false);
    const enemy = new Enemy({
      id: 'hostile:los-cache',
      position: new THREE.Vector3(0, 0, 0),
      lineOfSight: los,
    });
    // Stay outside close-range force and never enter combat so refresh stays
    // on the staggered cadence rather than every fixed tick.
    const player = new THREE.Vector3(0, 0, 25);
    const ticks = 60;
    for (let i = 0; i < ticks; i += 1) {
      enemy.update(1 / 60, player);
    }

    expect(los.mock.calls.length).toBeGreaterThan(0);
    expect(los.mock.calls.length).toBeLessThan(ticks);
    expect(los.mock.calls.length).toBeLessThanOrEqual(Math.ceil(ticks / 5) + 2);
    expect(enemy.hasVisualContact()).toBe(false);
    enemy.dispose();
  });

  it('still acquires and loses visual through the amortized LOS cache', () => {
    let clear = true;
    const los = vi.fn(() => clear);
    const enemy = new Enemy({
      id: 'hostile:los-feel',
      position: new THREE.Vector3(0, 0, 0),
      facingYaw: 0,
      lineOfSight: los,
    });
    const player = new THREE.Vector3(0, 0, 10);
    for (let i = 0; i < 4; i += 1) {
      enemy.update(1 / 60, player);
    }
    expect(enemy.hasVisualContact()).toBe(true);

    clear = false;
    enemy.state = 'combat';
    for (let i = 0; i < 3; i += 1) {
      enemy.update(1 / 60, player);
    }
    expect(enemy.hasVisualContact()).toBe(false);
    enemy.dispose();
  });

  it('forces an immediate LOS refresh when taking fire', () => {
    const los = vi.fn(() => false);
    const enemy = new Enemy({
      id: 'hostile:los-dirty',
      position: new THREE.Vector3(0, 0, 0),
      lineOfSight: los,
    });
    const player = new THREE.Vector3(0, 0, 25);
    for (let i = 0; i < 5; i += 1) enemy.update(1 / 60, player);
    const before = los.mock.calls.length;

    enemy.applySuppression(0.3, player);
    enemy.update(1 / 60, player);
    expect(los.mock.calls.length).toBe(before + 1);
    enemy.dispose();
  });

  it('holds fire while a squadmate is inside the shot', () => {
    const fire = (blocked: boolean): number => {
      let shots = 0;
      const enemy = new Enemy({
        id: 'hostile:lane',
        position: new THREE.Vector3(0, 0, 0),
        fireInterval: 0,
        randomSource: new SeededRandom(63),
        lineOfSight: () => true,
        isFireLaneBlocked: () => blocked,
        onShoot: () => { shots += 1; },
      });
      enemy.state = 'combat';
      for (let tick = 0; tick < 30; tick += 1) {
        enemy.update(1 / 60, new THREE.Vector3(0, 0, 10));
      }
      enemy.dispose();
      return shots;
    };
    expect(fire(true)).toBe(0);
    expect(fire(false)).toBeGreaterThan(0);
  });

  it('acts on a squadmate report without granting line of sight', () => {
    const enemy = new Enemy({
      id: 'hostile:radio',
      position: new THREE.Vector3(0, 0, 0),
      randomSource: new SeededRandom(45),
      lineOfSight: () => false,
    });
    enemy.notifyContact(new THREE.Vector3(0, 0, 14), 0.8);

    expect(enemy.state).toBe('alert');
    expect(enemy.hasVisualContact()).toBe(false);
    expect(enemy.getLastKnownPlayerPosition()).toEqual(new THREE.Vector3(0, 0, 14));
    expect(enemy.getAwareness()).toBeGreaterThan(0);
    enemy.dispose();
  });

  it('sweeps the last known position and folds back into a patrol', () => {
    let visible = true;
    const enemy = new Enemy({
      id: 'hostile:search',
      position: new THREE.Vector3(0, 0, 0),
      randomSource: new SeededRandom(5),
      lineOfSight: () => visible,
    });
    enemy.state = 'combat';
    enemy.update(1 / 60, new THREE.Vector3(0, 0, 10));
    expect(enemy.hasVisualContact()).toBe(true);

    visible = false;
    const states = new Set<string>();
    for (let tick = 0; tick < 60 * 16; tick += 1) {
      enemy.update(1 / 60, new THREE.Vector3(0, 0, 10));
      states.add(enemy.state);
    }

    // It hunts toward the sighting, then gives the contact up entirely.
    expect(states.has('search')).toBe(true);
    expect(enemy.position.z).toBeGreaterThan(1);
    expect(enemy.state).toBe('patrol');
    expect(enemy.getLastKnownPlayerPosition()).toBeNull();
    enemy.dispose();
  });

  it('works a lateral arc toward its assigned flank side', () => {
    const enemy = new Enemy({
      id: 'hostile:flanker',
      position: new THREE.Vector3(0, 0, -18),
      randomSource: new SeededRandom(88),
      lineOfSight: () => true,
    });
    enemy.setRole('flanker', 1);
    enemy.state = 'alert';
    for (let tick = 0; tick < 90; tick += 1) {
      enemy.update(1 / 60, new THREE.Vector3(0, 0, 0));
    }

    expect(enemy.state).toBe('flank');
    const target = enemy.getFlankTarget();
    expect(target).not.toBeNull();
    // The route swings off the straight approach lane rather than charging it.
    expect(Math.abs(target?.x ?? 0)).toBeGreaterThan(4);
    expect(Math.abs(enemy.position.x)).toBeGreaterThan(0.5);
    enemy.dispose();
  });

  it('round-trips suppression, roles and flank routes through a snapshot', () => {
    const enemy = new Enemy({
      id: 'hostile:tactical-snapshot',
      position: new THREE.Vector3(0, 0, -12),
      randomSource: new SeededRandom(101),
      lineOfSight: () => true,
    });
    enemy.setRole('flanker', -1);
    enemy.state = 'alert';
    for (let tick = 0; tick < 40; tick += 1) enemy.update(1 / 60, new THREE.Vector3(0, 0, 0));
    enemy.applySuppression(0.4);
    const checkpoint = enemy.snapshotState();
    expect(checkpoint).toMatchObject({ role: 'flanker', flankSide: -1 });
    expect(checkpoint.suppression).toBeGreaterThan(0);

    for (let tick = 0; tick < 30; tick += 1) enemy.update(1 / 60, new THREE.Vector3(0, 0, 0));
    const after = enemy.snapshotState();
    enemy.restoreState(checkpoint);
    for (let tick = 0; tick < 30; tick += 1) enemy.update(1 / 60, new THREE.Vector3(0, 0, 0));

    expect(enemy.snapshotState()).toEqual(after);
    enemy.dispose();
  });
});

describe('EnemyManager squad coordination', () => {
  it('relays one hostile’s sighting to a squadmate that cannot see the player', () => {
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 2,
      seed: 7,
      // Only the hostile spawned west of the player has eyes on.
      lineOfSight: (origin) => origin.x < 0,
      onEnemyShoot: () => {},
    });
    const [spotter, blind] = manager.getAll();
    for (let tick = 0; tick < 40; tick += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    }

    expect(spotter.hasVisualContact()).toBe(true);
    expect(blind.hasVisualContact()).toBe(false);
    expect(blind.getLastKnownPlayerPosition()).not.toBeNull();
    expect(blind.state).not.toBe('patrol');
    expect(manager.getSharedContact()).not.toBeNull();
    manager.dispose();
  });

  it('suppresses only the hostiles a player round actually passes close to', () => {
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 2,
      seed: 7,
      lineOfSight: () => false,
      onEnemyShoot: () => {},
    });
    const [near, far] = manager.getAll();
    manager.notifyPlayerFire(
      new THREE.Vector3(near.position.x, 1.35, 0),
      new THREE.Vector3(0, 0, 1),
    );

    expect(near.getSuppression()).toBeGreaterThan(0.3);
    expect(far.getSuppression()).toBe(0);
    manager.dispose();
  });

  it('hands the bounded firing slot from pinned hostiles to a fresh threat', () => {
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 4,
      maxFireSlots: 1,
      fireSlotDuration: 2,
      seed: 91,
      lineOfSight: () => true,
      onEnemyShoot: () => {},
    });
    const pinned = [...manager.getAll()];
    const pointBlank = manager.spawnAt(new THREE.Vector3(0, 0, 5));
    for (const enemy of manager.getAlive()) enemy.state = 'combat';
    for (const enemy of pinned) enemy.applySuppression(0.6);
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));

    const slots = manager.snapshotState().fireSlots;
    expect(slots).toHaveLength(1);
    expect(slots[0].enemyId).toBe(pointBlank.id);
    manager.dispose();
  });

  it('trickles reinforcements up to the pressure the mission asks for', () => {
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [new THREE.Vector3(0, 0, 24), new THREE.Vector3(6, 0, 26)],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 6,
      seed: 11,
      lineOfSight: () => false,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });
    const opening = manager.getAlive().length;
    expect(opening).toBe(4);

    // A beat that wants fewer hostiles never pushes more bodies in.
    manager.applyCombatDirective({ aliveTarget: 3, aggression: 0.2 });
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getAlive().length).toBe(opening);

    manager.applyCombatDirective({ aliveTarget: 6, aggression: 1, reinforcementDelay: 1 });
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getAlive().length).toBeGreaterThan(opening);
    expect(manager.getAlive().length).toBeLessThanOrEqual(6);
    manager.dispose();
  });

  it('extends in-flight reinforce timing when mission cooling lengthens delay', () => {
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 6,
      seed: 17,
      reinforcementDelay: 4,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });
    // Warehouse thinned under the cooled defense target with a jammer-era
    // timer already at 0 — the jammer→defense lull cousin that used to reinforce
    // on the breather tick.
    while (manager.getAlive().length > 2) {
      manager.getAlive()[0]!.kill();
    }
    manager.applyCombatDirective({ aliveTarget: 4, aggression: 0.4, reinforcementDelay: 4 });
    expect(manager.getDebugState().reinforcementTimer).toBe(0);

    manager.applyCombatDirective({
      aliveTarget: 4,
      aggression: 0.35,
      reinforcementDelay: 13,
      lullRemaining: 4,
    });
    expect(manager.getDebugState().reinforcementTimer).toBeGreaterThanOrEqual(13);

    const before = manager.getAlive().length;
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getAlive().length).toBe(before);
    expect(manager.getDebugState().reinforcementTimer).toBeGreaterThan(12);
    manager.dispose();
  });

  it('does not bank a reinforce lockout on baseline delay bumps without lull', () => {
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 4,
      seed: 31,
      reinforcementDelay: 9,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });
    // Boot / rematch cousin: insertion directive lengthens delay while timer
    // is still 0 and no encounter lull is active — must adopt delay only.
    expect(manager.getDebugState().reinforcementTimer).toBe(0);
    manager.applyCombatDirective({
      aliveTarget: 4,
      aggression: 0.45,
      reinforcementDelay: 12,
      lullRemaining: 0,
    });
    expect(manager.getDebugState().reinforcementTimer).toBe(0);
    expect(manager.snapshotState().reinforcementDelay).toBe(12);

    manager.resetToInitial();
    expect(manager.snapshotState().reinforcementDelay).toBe(9);
    expect(manager.getDebugState().reinforcementTimer).toBe(0);
    manager.applyCombatDirective({ reinforcementDelay: 12, lullRemaining: 0 });
    expect(manager.getDebugState().reinforcementTimer).toBe(0);
    manager.dispose();
  });

  it('arms wipe-wave wait with cooled reinforcement delay, not only waveDelay', () => {
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 4,
      seed: 23,
      waveDelay: 6,
      reinforcementDelay: 4,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });
    // Lull already applied — delay is long before the last body drops, so the
    // wipe arm must pick up reinforcementDelay (stretch only helps mid-wait).
    manager.applyCombatDirective({ aliveTarget: 4, aggression: 0.35, reinforcementDelay: 13 });
    while (manager.getAlive().length > 0) {
      manager.getAlive()[0]!.kill();
    }

    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getDebugState().waitingWave).toBe(true);
    expect(manager.getDebugState().waveTimer).toBeGreaterThanOrEqual(13 - 1 / 60);
    expect(manager.getAlive().length).toBe(0);

    // Short waveDelay alone would have expired; cooled arm must still hold.
    for (let i = 0; i < 7 * 60; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    }
    expect(manager.getAlive().length).toBe(0);
    expect(manager.getDebugState().waitingWave).toBe(true);
    expect(manager.getDebugState().waveTimer).toBeGreaterThan(5);
    manager.dispose();
  });

  it('retries a LOS-blocked trickle reinforce soon instead of every tick', () => {
    let blockSpawns = true;
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 6,
      seed: 41,
      reinforcementDelay: 4,
      isSpawnVisible: () => blockSpawns,
      onEnemyShoot: () => {},
    });
    while (manager.getAlive().length > 2) {
      manager.getAlive()[0]!.kill();
    }
    manager.applyCombatDirective({ aliveTarget: 5, aggression: 1, reinforcementDelay: 4 });
    expect(manager.getDebugState().reinforcementTimer).toBe(0);

    // First blocked trickle must arm a short retry, not leave timer at 0 for
    // a spawnGroup attempt on every following fixed step.
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getAlive().length).toBe(2);
    expect(manager.getDebugState().reinforcementTimer).toBeLessThanOrEqual(0.5);
    expect(manager.getDebugState().reinforcementTimer).toBeGreaterThan(0);

    const afterFail = manager.getDebugState().reinforcementTimer;
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getDebugState().reinforcementTimer).toBeLessThan(afterFail);
    expect(manager.getAlive().length).toBe(2);

    blockSpawns = false;
    for (let i = 0; i < 60; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
      if (manager.getAlive().length > 2) break;
    }
    expect(manager.getAlive().length).toBeGreaterThan(2);
    expect(manager.getDebugState().reinforcementTimer).toBeGreaterThan(1);
    manager.dispose();
  });

  it('retries a LOS-blocked wipe soon instead of re-arming a full cooled wait', () => {
    let blockSpawns = true;
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 4,
      seed: 29,
      waveDelay: 6,
      reinforcementDelay: 4,
      isSpawnVisible: () => blockSpawns,
      onEnemyShoot: () => {},
    });
    manager.applyCombatDirective({ aliveTarget: 4, aggression: 0.35, reinforcementDelay: 13 });
    while (manager.getAlive().length > 0) {
      manager.getAlive()[0]!.kill();
    }

    // Arm wipe, then expire the cooled wait while every spawn is LOS-blocked.
    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    expect(manager.getDebugState().waitingWave).toBe(true);
    for (let i = 0; i < 14 * 60; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    }
    expect(manager.getAlive().length).toBe(0);
    expect(manager.getDebugState().waitingWave).toBe(true);
    // Failed expiry must leave a short retry, not clear waitingWave for a
    // fresh 13s arm on the next empty-alive tick.
    expect(manager.getDebugState().waveTimer).toBeLessThanOrEqual(0.5);
    expect(manager.getDebugState().waveTimer).toBeGreaterThan(0);

    blockSpawns = false;
    for (let i = 0; i < 60; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
      if (manager.getAlive().length > 0) break;
    }
    expect(manager.getAlive().length).toBeGreaterThan(0);
    expect(manager.getDebugState().waitingWave).toBe(false);
    manager.dispose();
  });

  it('routes default spawn visibility through setLineOfSight', () => {
    // Production never passes isSpawnVisible; Rapier swaps via setLineOfSight.
    // clear LOS ⇒ spawn is visible ⇒ blocked; occluded ⇒ eligible to reinforce.
    let clear = true;
    const level = {
      colliders: [],
      playerSpawn: new THREE.Vector3(),
      enemySpawns: [
        new THREE.Vector3(0, 0, 24),
        new THREE.Vector3(6, 0, 26),
        new THREE.Vector3(-6, 0, 28),
        new THREE.Vector3(3, 0, 30),
      ],
      coverNodes: [],
    } as unknown as Level;
    const manager = new EnemyManager(scene(), level, {
      maxAlive: 4,
      seed: 17,
      waveDelay: 1,
      reinforcementDelay: 1,
      onEnemyShoot: () => {},
    });
    manager.setLineOfSight(() => clear);
    manager.applyCombatDirective({ aliveTarget: 4, aggression: 0.35, reinforcementDelay: 1 });
    while (manager.getAlive().length > 0) {
      manager.getAlive()[0]!.kill();
    }

    manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    for (let i = 0; i < 90; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
    }
    expect(manager.getAlive().length).toBe(0);

    clear = false;
    for (let i = 0; i < 60; i += 1) {
      manager.update(1 / 60, new THREE.Vector3(0, 0, 0));
      if (manager.getAlive().length > 0) break;
    }
    expect(manager.getAlive().length).toBeGreaterThan(0);
    manager.dispose();
  });

  it('scales the concurrent firing budget with mission aggression', () => {
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 2,
      maxFireSlots: 2,
      seed: 5,
      lineOfSight: () => true,
      onEnemyShoot: () => {},
    });
    const cautious = () => manager.getDebugState().fireSlotBudget;
    manager.applyCombatDirective({ aggression: 0, maxFireSlots: 2 });
    const holding = cautious();
    manager.applyCombatDirective({ aggression: 1, maxFireSlots: 4 });
    expect(cautious()).toBeGreaterThan(holding);
    manager.dispose();
  });

  it('replays a long squad engagement from a mid-fight snapshot', () => {
    const build = () => new EnemyManager(scene(), skirmishLevel(), {
      maxAlive: 6,
      seed: 4242,
      waveDelay: 2,
      reinforcementDelay: 2,
      isSpawnVisible: () => false,
      onEnemyShoot: () => {},
    });
    const playerAt = (tick: number) => new THREE.Vector3(
      Math.sin(tick * 0.01) * 6,
      0,
      4 + Math.cos(tick * 0.013) * 5,
    );
    const manager = build();
    for (let tick = 0; tick < 240; tick += 1) manager.update(1 / 60, playerAt(tick));
    const checkpoint = manager.snapshotState();
    for (let tick = 240; tick < 420; tick += 1) manager.update(1 / 60, playerAt(tick));
    const after = manager.snapshotState();

    manager.restoreState(checkpoint);
    expect(manager.snapshotState()).toEqual(checkpoint);
    for (let tick = 240; tick < 420; tick += 1) manager.update(1 / 60, playerAt(tick));
    expect(manager.snapshotState()).toEqual(after);
    manager.dispose();
  });
});

describe('EnemyManager death accounting', () => {
  /**
   * Mirrors main.registerHostileKill: every onEnemyDeath increments the
   * mission kill counter so grenade splash and firearm hits share credit.
   */
  function hostileKillLedger() {
    let hostileKills = 0;
    const deaths: Array<{ id: string; part: HitPart }> = [];
    return {
      get hostileKills() {
        return hostileKills;
      },
      deaths,
      onEnemyDeath: (enemy: Enemy, part: HitPart) => {
        hostileKills += 1;
        deaths.push({ id: enemy.id, part });
      },
    };
  }

  it('credits grenade splash kills through asHitscanTargets → onEnemyDeath', () => {
    const ledger = hostileKillLedger();
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 1,
      seed: 19,
      lineOfSight: () => false,
      onEnemyDeath: ledger.onEnemyDeath,
    });
    const enemy = manager.getAlive()[0];
    expect(enemy).toBeTruthy();
    // Park the opening hostile under the frag so splash is guaranteed.
    enemy.position.set(0, 0, -2);
    enemy.mesh.position.copy(enemy.position);
    const targets = manager.asHitscanTargets();
    expect(targets).toHaveLength(1);

    const camera = new THREE.PerspectiveCamera();
    camera.position.set(0, 1.6, 0);
    camera.lookAt(0, 1.6, -1);
    camera.updateMatrixWorld(true);
    const system = new GrenadeSystem({
      scene: scene(),
      camera,
      colliders: [],
      physicsWorld: {
        addGrenade: vi.fn(),
        grenadePosition: vi.fn(() => ({ x: 0, y: 1.2, z: -2 })),
        removeGrenade: vi.fn(),
        castRay: vi.fn(() => null),
      } as never,
    });

    expect(system.throw()).toBe(true);
    for (let i = 0; i < 80; i += 1) system.update(0.04, targets);

    expect(enemy.alive).toBe(false);
    expect(ledger.hostileKills).toBe(1);
    expect(ledger.deaths).toEqual([{ id: enemy.id, part: 'torso' }]);
    system.dispose();
    manager.dispose();
  });

  it('increments the same hostileKills ledger for firearm hitscan kills', () => {
    const ledger = hostileKillLedger();
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 1,
      seed: 21,
      lineOfSight: () => false,
      onEnemyDeath: ledger.onEnemyDeath,
    });
    const enemy = manager.getAlive()[0];
    const [target] = manager.asHitscanTargets();
    expect(target.takeDamage(500, 'head')).toBe(true);
    expect(enemy.alive).toBe(false);
    expect(ledger.hostileKills).toBe(1);
    expect(ledger.deaths).toEqual([{ id: enemy.id, part: 'head' }]);
    manager.dispose();
  });

  it('routes applyHit firearm kills through the same onEnemyDeath counter', () => {
    const ledger = hostileKillLedger();
    const manager = new EnemyManager(scene(), emptyLevel(), {
      maxAlive: 1,
      seed: 23,
      lineOfSight: () => false,
      onEnemyDeath: ledger.onEnemyDeath,
    });
    const enemy = manager.getAlive()[0];
    const result = manager.applyHit(enemy, 500, 'torso');
    expect(result?.killed).toBe(true);
    expect(enemy.alive).toBe(false);
    expect(ledger.hostileKills).toBe(1);
    expect(ledger.deaths).toEqual([{ id: enemy.id, part: 'torso' }]);
    manager.dispose();
  });
});

function scene(): THREE.Scene {
  return new THREE.Scene();
}

function emptyLevel(): Level {
  return {
    colliders: [],
    playerSpawn: new THREE.Vector3(),
    enemySpawns: [],
    coverNodes: [],
  } as unknown as Level;
}

function skirmishLevel(): Level {
  return {
    colliders: [],
    playerSpawn: new THREE.Vector3(),
    enemySpawns: [
      new THREE.Vector3(-8, 0, 22),
      new THREE.Vector3(9, 0, 25),
      new THREE.Vector3(0, 0, 28),
      new THREE.Vector3(-14, 0, 18),
    ],
    coverNodes: [
      new THREE.Vector3(-5, 0, 8),
      new THREE.Vector3(5, 0, 9),
      new THREE.Vector3(0, 0, 15),
      new THREE.Vector3(-9, 0, 14),
    ],
  } as unknown as Level;
}

function riggedGroup(): THREE.Group {
  const group = new THREE.Group();
  const bone = new THREE.Bone();
  const mesh = new THREE.SkinnedMesh(
    new THREE.BoxGeometry(0.5, 1.8, 0.4),
    new THREE.MeshBasicMaterial(),
  );
  mesh.add(bone);
  mesh.bind(new THREE.Skeleton([bone]));
  group.add(mesh);
  return group;
}
