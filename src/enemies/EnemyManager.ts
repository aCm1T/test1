import * as THREE from 'three';
import { Enemy, type EnemyShootEvent, type HitPart } from './Enemy';
import type { Level } from '../world/Level';

export type EnemyManagerOptions = {
  /** Max simultaneous alive hostiles. */
  maxAlive?: number;
  /** Seconds after a wipe before a light respawn wave. */
  waveDelay?: number;
  /** Enemies injected per wave (capped by spawn points / maxAlive). */
  waveSize?: number;
  onEnemyShoot?: (ev: EnemyShootEvent) => void;
  onEnemyDeath?: (enemy: Enemy) => void;
};

export type HitResult = {
  enemy: Enemy;
  part: HitPart;
  killed: boolean;
  health: number;
} | null;

/**
 * Spawns and updates combatants for a Level.
 * Supports weapon-system hit application and light wave respawn.
 */
export class EnemyManager {
  readonly enemies: Enemy[] = [];

  private readonly scene: THREE.Scene;
  private readonly level: Level;
  private readonly maxAlive: number;
  private readonly waveDelay: number;
  private readonly waveSize: number;
  private readonly group = new THREE.Group();

  private waveTimer = 0;
  private waitingWave = false;
  private waveIndex = 0;

  onEnemyShoot: ((ev: EnemyShootEvent) => void) | null = null;
  onEnemyDeath: ((enemy: Enemy) => void) | null = null;

  constructor(scene: THREE.Scene, level: Level, options: EnemyManagerOptions = {}) {
    this.scene = scene;
    this.level = level;
    this.maxAlive = options.maxAlive ?? 8;
    this.waveDelay = options.waveDelay ?? 6;
    this.waveSize = options.waveSize ?? 4;
    this.onEnemyShoot = options.onEnemyShoot ?? null;
    this.onEnemyDeath = options.onEnemyDeath ?? null;

    this.group.name = 'EnemyManager';
    scene.add(this.group);

    this.spawnInitial();
  }

  /** Alive hostiles. */
  getAlive(): Enemy[] {
    return this.enemies.filter((e) => e.alive);
  }

  getAll(): Enemy[] {
    return this.enemies;
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    let aliveCount = 0;
    for (const enemy of this.enemies) {
      enemy.update(dt, playerPos, this.scene);
      if (enemy.alive) aliveCount++;
    }

    // Light wave respawn when cleared
    if (aliveCount === 0) {
      if (!this.waitingWave) {
        this.waitingWave = true;
        this.waveTimer = this.waveDelay;
      } else {
        this.waveTimer -= dt;
        if (this.waveTimer <= 0) {
          this.spawnWave();
          this.waitingWave = false;
        }
      }
    } else {
      this.waitingWave = false;
    }
  }

  /**
   * Apply a hitscan / projectile hit from the weapon system.
   * Pass the intersected object to resolve body-part multipliers.
   */
  applyHit(
    enemyOrObject: Enemy | THREE.Object3D,
    damage: number,
    part?: HitPart,
  ): HitResult {
    const enemy =
      enemyOrObject instanceof Enemy
        ? enemyOrObject
        : this.findEnemyFromObject(enemyOrObject);
    if (!enemy || !enemy.alive) return null;

    const resolved = part ?? Enemy.partFromObject(
      enemyOrObject instanceof Enemy ? enemy.mesh : enemyOrObject,
    );
    const wasAlive = enemy.alive;
    const health = enemy.hit(damage, resolved);
    const killed = wasAlive && !enemy.alive;
    if (killed) this.onEnemyDeath?.(enemy);

    return { enemy, part: resolved, killed, health };
  }

  /** Raycast helper against all living enemy meshes. */
  raycast(
    raycaster: THREE.Raycaster,
  ): { enemy: Enemy; part: HitPart; intersection: THREE.Intersection } | null {
    const aliveMeshes: THREE.Object3D[] = [];
    const meshToEnemy = new Map<THREE.Object3D, Enemy>();
    for (const e of this.getAlive()) {
      e.mesh.traverse((o) => {
        const m = o as THREE.Mesh;
        if (m.isMesh) {
          aliveMeshes.push(m);
          meshToEnemy.set(m, e);
        }
      });
    }
    const hits = raycaster.intersectObjects(aliveMeshes, false);
    if (hits.length === 0) return null;
    const hit = hits[0];
    const enemy = meshToEnemy.get(hit.object);
    if (!enemy) return null;
    return {
      enemy,
      part: Enemy.partFromObject(hit.object),
      intersection: hit,
    };
  }

  spawnAt(position: THREE.Vector3): Enemy {
    const enemy = new Enemy({
      position: position.clone(),
      coverNodes: this.level.coverNodes,
      onShoot: (ev) => this.onEnemyShoot?.(ev),
      health: 90 + Math.floor(Math.random() * 30),
      accuracy: 0.62 + Math.random() * 0.2,
      fireInterval: 0.7 + Math.random() * 0.5,
    });
    this.group.add(enemy.mesh);
    this.enemies.push(enemy);
    return enemy;
  }

  /** Remove dead enemies that have fully collapsed (optional GC). */
  pruneDead(maxKeep = 12): void {
    const dead = this.enemies.filter((e) => !e.alive);
    if (dead.length <= maxKeep) return;
    const removeCount = dead.length - maxKeep;
    let removed = 0;
    for (let i = this.enemies.length - 1; i >= 0 && removed < removeCount; i--) {
      const e = this.enemies[i];
      if (!e.alive) {
        e.dispose();
        this.enemies.splice(i, 1);
        removed++;
      }
    }
  }

  dispose(): void {
    for (const e of this.enemies) e.dispose();
    this.enemies.length = 0;
    this.group.removeFromParent();
  }

  // ── spawn logic ──────────────────────────────────────────────────────

  private spawnInitial(): void {
    const spawns = this.level.enemySpawns;
    const count = Math.min(this.maxAlive, Math.max(4, Math.floor(spawns.length * 0.6)));
    // Always seed the first two spawn slots (near-player readability), then shuffle the rest.
    const indices: number[] = [];
    if (spawns.length > 0) indices.push(0);
    if (spawns.length > 1) indices.push(1);
    const rest = shuffledIndices(spawns.length).filter((i) => i > 1);
    for (const i of rest) indices.push(i);
    for (let i = 0; i < count; i++) {
      const p = spawns[indices[i % indices.length]];
      this.spawnAt(p);
    }
    this.waveIndex = 1;
  }

  private spawnWave(): void {
    this.waveIndex++;
    this.pruneDead(8);
    const alive = this.getAlive().length;
    const room = Math.max(0, this.maxAlive - alive);
    const toSpawn = Math.min(this.waveSize + Math.floor(this.waveIndex * 0.5), room);
    if (toSpawn <= 0) return;

    const spawns = this.level.enemySpawns;
    const indices = shuffledIndices(spawns.length);
    for (let i = 0; i < toSpawn; i++) {
      const p = spawns[indices[i % spawns.length]];
      // Offset slightly so they don't stack
      const jitter = new THREE.Vector3(
        (Math.random() - 0.5) * 1.5,
        0,
        (Math.random() - 0.5) * 1.5,
      );
      this.spawnAt(p.clone().add(jitter));
    }
  }

  private findEnemyFromObject(obj: THREE.Object3D): Enemy | null {
    let o: THREE.Object3D | null = obj;
    while (o) {
      if (o.userData?.enemy instanceof Enemy) return o.userData.enemy as Enemy;
      o = o.parent;
    }
    // Fallback: distance / membership
    for (const e of this.enemies) {
      let found = false;
      e.mesh.traverse((child) => {
        if (child === obj) found = true;
      });
      if (found) return e;
    }
    return null;
  }
}

function shuffledIndices(n: number): number[] {
  const arr = Array.from({ length: n }, (_, i) => i);
  for (let i = arr.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [arr[i], arr[j]] = [arr[j], arr[i]];
  }
  return arr;
}
