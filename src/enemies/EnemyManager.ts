import * as THREE from 'three';
import {
  Enemy,
  type EnemyCallout,
  type EnemyDebugState,
  type EnemyRuntimeSnapshot,
  type EnemyLineOfSight,
  type EnemyMovementAuthority,
  type EnemyRole,
  type EnemyShootEvent,
  type HitPart,
} from './Enemy';
import { asHitscanEnemy, type BodyPart, type HitscanEnemy } from '../combat/Hitscan';
import type { Level } from '../world/Level';
import { SeededRandom } from '../mission/SeededRandom';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import {
  CoverSlots,
  SquadDirector,
  planSquadRoles,
  type CoverReservation,
  type NavigationGraph,
} from '../simulation';

/**
 * Global cap on hostiles that keep full merged dressing (nearest first).
 * Even inside close engagement range, a packed squad of maxAlive must not all
 * render at full dress — that is the largest peak draw risk under CSM.
 */
const MAX_DETAILED_HOSTILES = 4;
/** Range multiplier applied to a hostile the budget could not cover. */
const DETAIL_BUDGET_BIAS = 4;

export type SpawnVisibilityTest = (
  spawn: Readonly<THREE.Vector3>,
  playerPosition: Readonly<THREE.Vector3>,
) => boolean;

export type EnemyManagerOptions = {
  /** Max simultaneous alive hostiles. */
  maxAlive?: number;
  /** Seconds after a wipe before a light respawn wave. */
  waveDelay?: number;
  /** Enemies injected per wave (capped by spawn points / maxAlive). */
  waveSize?: number;
  /** Scenario seed; identical update/input sequences produce identical AI. */
  seed?: number;
  /** Maximum enemies allowed to occupy an active firing slot. */
  maxFireSlots?: number;
  fireSlotDuration?: number;
  minSpawnDistance?: number;
  /** Seconds between reinforcement trickles while a fight is still running. */
  reinforcementDelay?: number;
  /** Radius within which a sighting is relayed to squadmates. */
  commsRadius?: number;
  /** Relay cadence for shared contact reports. */
  commsDelay?: number;
  /** How long the squad keeps acting on a stale contact report. */
  contactMemory?: number;
  /** Miss distance at which player rounds still suppress. */
  suppressionRadius?: number;
  lineOfSight?: EnemyLineOfSight;
  /** True means the candidate is visibly exposed and should be rejected. */
  isSpawnVisible?: SpawnVisibilityTest;
  onEnemyShoot?: (ev: EnemyShootEvent) => void;
  /** Fired for every hostile death that went through applyHit / applyScaledDamage. */
  onEnemyDeath?: (enemy: Enemy, part: HitPart) => void;
  onEnemyCallout?: (callout: EnemyCallout, enemy: Enemy) => void;
};

/**
 * Pacing contract handed down by the mission layer. It lets a beat dial squad
 * pressure up or down without the AI knowing anything about mission structure.
 */
export type EnemyCombatDirective = {
  /** Simultaneous hostiles this beat wants in the fight. */
  aliveTarget?: number;
  reinforcementDelay?: number;
  /**
   * Remaining encounter lull seconds from MissionDirector. When > 0, a delay
   * increase may arm/stretch from a zero timer (jammer→defense breather).
   * Baseline beat bumps without a lull must not invent a lockout.
   */
  lullRemaining?: number;
  /** 0 is a cautious holding action, 1 is maximum squad pressure. */
  aggression?: number;
  maxFireSlots?: number;
  allowFlanking?: boolean;
};

export type EnemyManagerDebugState = {
  seedState: number;
  elapsed: number;
  waveIndex: number;
  waitingWave: boolean;
  waveTimer: number;
  activeFireSlots: number;
  fireSlotBudget: number;
  aliveTarget: number;
  aggression: number;
  reinforcementTimer: number;
  sharedContact: { x: number; y: number; z: number } | null;
  contactAge: number;
  roles: Record<EnemyRole, number>;
  lastPlayerPosition: { x: number; y: number; z: number };
  enemies: EnemyDebugState[];
};

export type EnemyManagerSnapshot = {
  randomState: number;
  elapsed: number;
  waveTimer: number;
  waitingWave: boolean;
  waveIndex: number;
  spawnSerial: number;
  lastPlayerPosition: { x: number; y: number; z: number };
  enemies: EnemyRuntimeSnapshot[];
  fireSlots: Array<{ enemyId: string; remaining: number }>;
  coverReservations: CoverReservation[];
  aliveTarget: number;
  reinforcementDelay: number;
  reinforcementTimer: number;
  aggression: number;
  allowFlanking: boolean;
  roleTimer: number;
  commsTimer: number;
  rosterSize: number;
  sharedContact: { x: number; y: number; z: number } | null;
  contactAge: number;
  playerHeading: { x: number; y: number; z: number };
};

/** Runtime bridge for graph-directed, Rapier-authoritative enemy motion. */
export type EnemyNavigationRuntime = {
  graph: NavigationGraph;
  cover: CoverSlots;
  squad: SquadDirector;
  movement: EnemyMovementAuthority;
};

export type HitResult = {
  enemy: Enemy;
  part: HitPart;
  killed: boolean;
  health: number;
} | null;

/**
 * Deterministic squad manager with occlusion-aware perception, bounded firing
 * concurrency, and reinforcement placement outside the player's view.
 */
export class EnemyManager {
  readonly enemies: Enemy[] = [];

  private readonly scene: THREE.Scene;
  private readonly level: Level;
  private readonly maxAlive: number;
  private readonly waveDelay: number;
  private readonly waveSize: number;
  private readonly maxFireSlots: number;
  private readonly fireSlotDuration: number;
  private readonly minSpawnDistance: number;
  private readonly commsRadius: number;
  private readonly commsDelay: number;
  private readonly contactMemory: number;
  private readonly suppressionRadius: number;
  private readonly random: SeededRandom;
  private lineOfSight: EnemyLineOfSight;
  private readonly isSpawnVisible: SpawnVisibilityTest;
  private readonly group = new THREE.Group();
  private readonly fireSlots = new Map<Enemy, number>();
  /** Scratch list for the per-frame draw-detail budget; never simulation state. */
  private readonly detailOrder: Array<{ enemy: Enemy; distance: number }> = [];
  /** Quality LOD bias applied to every hostile's presentation distances. */
  private lodBias = 0;
  private readonly lastPlayerPosition = new THREE.Vector3();
  private readonly playerHeading = new THREE.Vector3(0, 0, 1);
  private readonly sharedContact = new THREE.Vector3();
  private hasSharedContact = false;
  private contactAge = 0;
  private commsTimer = 0;
  private roleTimer = 0;
  private rosterSize = 0;
  private aliveTarget: number;
  private reinforcementDelay: number;
  private readonly initialReinforcementDelay: number;
  private reinforcementTimer = 0;
  private fireSlotBudget: number;
  private aggression = 0.5;
  private allowFlanking = true;
  /** Coordination is suspended while a checkpoint is being rebuilt. */
  private restoring = false;
  private readonly _lane = new THREE.Vector3();
  private readonly _chest = new THREE.Vector3();
  private readonly _closest = new THREE.Vector3();
  private readonly _spawnEye = new THREE.Vector3();
  private readonly _playerEye = new THREE.Vector3();
  private navigationRuntime: EnemyNavigationRuntime | null = null;
  private authoredArchetypes: readonly GLTF[] = [];
  private readonly coverAuthority = {
    reserve: (enemy: Enemy): THREE.Vector3 | null => {
      const runtime = this.navigationRuntime;
      if (!runtime) return null;
      const owned = runtime.cover.getReservationForOwner(enemy.id);
      const reservation = owned ?? runtime.cover.reserveNearest(enemy.id, enemy.position);
      const slot = reservation ? runtime.cover.getSlot(reservation.slotId) : null;
      return slot ? new THREE.Vector3(slot.position.x, slot.position.y, slot.position.z) : null;
    },
    release: (enemy: Enemy): void => {
      this.navigationRuntime?.cover.releaseOwner(enemy.id);
    },
  };

  private elapsed = 0;
  private waveTimer = 0;
  private waitingWave = false;
  private waveIndex = 0;
  private spawnSerial = 0;
  private readonly initialRandomState: number;

  onEnemyShoot: ((ev: EnemyShootEvent) => void) | null = null;
  onEnemyDeath: ((enemy: Enemy, part: HitPart) => void) | null = null;
  onEnemyCallout: ((callout: EnemyCallout, enemy: Enemy) => void) | null = null;

  constructor(scene: THREE.Scene, level: Level, options: EnemyManagerOptions = {}) {
    this.scene = scene;
    this.level = level;
    this.maxAlive = Math.max(0, options.maxAlive ?? 8);
    this.waveDelay = options.waveDelay ?? 6;
    this.waveSize = options.waveSize ?? 4;
    this.maxFireSlots = Math.max(1, options.maxFireSlots ?? 2);
    this.fireSlotDuration = Math.max(0.05, options.fireSlotDuration ?? 0.4);
    this.minSpawnDistance = Math.max(0, options.minSpawnDistance ?? 13);
    this.commsRadius = Math.max(0, options.commsRadius ?? 34);
    this.commsDelay = Math.max(0, options.commsDelay ?? 0.45);
    this.contactMemory = Math.max(0, options.contactMemory ?? 7);
    this.suppressionRadius = Math.max(0.1, options.suppressionRadius ?? 2.4);
    this.aliveTarget = this.maxAlive;
    this.reinforcementDelay = Math.max(0.5, options.reinforcementDelay ?? 9);
    this.initialReinforcementDelay = this.reinforcementDelay;
    this.fireSlotBudget = this.maxFireSlots;
    this.random = new SeededRandom(options.seed ?? 0x46524f4e);
    this.initialRandomState = this.random.snapshot();
    this.lineOfSight = options.lineOfSight ?? ((origin, target) => (
      hasColliderLineOfSight(origin, target, this.level.colliders)
    ));
    // Default spawn gating must share combat LOS authority so setLineOfSight
    // (Rapier / authored trimeshes) rewires wipe+trickle visibility too —
    // hardcoding level.colliders left reinforcements on stale AABB occluders.
    this.isSpawnVisible = options.isSpawnVisible ?? ((spawn, player) => {
      if (spawn.distanceToSquared(player) > 48 * 48) return false;
      this._spawnEye.set(spawn.x, spawn.y + 1.35, spawn.z);
      this._playerEye.set(player.x, player.y + 1.35, player.z);
      return this.lineOfSight(this._spawnEye, this._playerEye);
    });
    this.onEnemyShoot = options.onEnemyShoot ?? null;
    this.onEnemyDeath = options.onEnemyDeath ?? null;
    this.onEnemyCallout = options.onEnemyCallout ?? null;
    this.lastPlayerPosition.copy(level.playerSpawn);

    this.group.name = 'EnemyManager';
    scene.add(this.group);
    this.spawnInitial();
  }

  getAlive(): Enemy[] {
    return this.enemies.filter((enemy) => enemy.alive);
  }

  getAll(): Enemy[] {
    return this.enemies;
  }

  hasAuthoredVisuals(): boolean {
    return this.enemies.length > 0 && this.enemies.every((enemy) => enemy.hasAuthoredVisual());
  }

  setLineOfSight(lineOfSight: EnemyLineOfSight): void {
    this.lineOfSight = lineOfSight;
    for (const enemy of this.enemies) {
      enemy.setLineOfSight(lineOfSight);
    }
  }

  setNavigationRuntime(runtime: EnemyNavigationRuntime | null): void {
    if (this.navigationRuntime === runtime) return;
    for (const enemy of this.enemies) {
      this.navigationRuntime?.movement.release(enemy);
      enemy.setMovementAuthority(null);
      enemy.setCoverAuthority(null);
    }
    this.navigationRuntime = runtime;
    for (const enemy of this.enemies) {
      enemy.setMovementAuthority(runtime?.movement ?? null);
      enemy.setCoverAuthority(runtime ? this.coverAuthority : null);
    }
    this.assignSquadTactics();
  }

  setAuthoredArchetypes(archetypes: readonly GLTF[]): void {
    this.authoredArchetypes = [...archetypes];
    if (this.authoredArchetypes.length === 0) {
      for (const enemy of this.enemies) enemy.clearAuthoredVisual();
      return;
    }
    this.enemies.forEach((enemy, index) => {
      enemy.installAuthoredVisual(this.authoredArchetypes[index % this.authoredArchetypes.length]);
    });
  }

  update(dt: number, playerPos: THREE.Vector3): void {
    const step = Math.max(0, Math.min(dt, 0.25));
    this.elapsed += step;
    this.trackPlayerHeading(playerPos, step);
    this.lastPlayerPosition.copy(playerPos);
    this.expireFireSlots();
    // Coordination runs before the agents tick so roles, shared contacts and
    // flank routes are already in place for this simulation step.
    this.updateSquadCoordination(step);

    this.applyDetailBudget(playerPos);

    let aliveCount = 0;
    for (const enemy of this.enemies) {
      enemy.update(step, playerPos, this.scene);
      if (enemy.alive) aliveCount++;
      else this.fireSlots.delete(enemy);
    }

    this.updateWavePacing(step, aliveCount);
  }

  /**
   * Presentation-only quality LOD bias. Propagates to every living hostile so
   * Low/Medium thin merged dressing earlier without touching sim state.
   */
  setLodBias(lodBias: number): void {
    this.lodBias = Number.isFinite(lodBias) ? lodBias : 0;
    for (const enemy of this.enemies) {
      enemy.setLodBias(this.lodBias);
    }
  }

  /**
   * A full squad of hostiles at full dressing is by far the largest draw cost
   * in the frame. The budget hands full dressing to the nearest few globally
   * (capped even when every hostile is inside engagement range) and lets the
   * rest render as silhouettes that also skip CSM. This is presentation only —
   * it reads positions that the simulation already produced and writes nothing
   * back.
   */
  private applyDetailBudget(playerPos: THREE.Vector3): void {
    this.detailOrder.length = 0;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      this.detailOrder.push({
        enemy,
        distance: enemy.mesh.position.distanceToSquared(playerPos),
      });
    }
    this.detailOrder.sort((a, b) => a.distance - b.distance);

    let budget = MAX_DETAILED_HOSTILES;
    for (const entry of this.detailOrder) {
      entry.enemy.setDetailBias(budget > 0 ? 1 : DETAIL_BUDGET_BIAS);
      budget -= 1;
    }
  }

  /**
   * Mission beats own pacing; the squad only reacts to the pressure it is told
   * to apply. Values are clamped to the manager's hard ceilings so a directive
   * can never exceed the budget the scene was built for.
   */
  applyCombatDirective(directive: EnemyCombatDirective): void {
    if (directive.aliveTarget !== undefined) {
      this.aliveTarget = Math.max(0, Math.min(this.maxAlive, Math.round(directive.aliveTarget)));
    }
    if (directive.reinforcementDelay !== undefined) {
      const next = Math.max(0.5, directive.reinforcementDelay);
      // Cooling / encounter lull lengthens delay; stretch in-flight waits so a
      // jammer-era remainder of 0 cannot reinforce on the defense-open tick.
      // Baseline beat bumps (boot 9→12, rematch) must only adopt the new delay
      // for the *next* arm — inventing a lockout from timer 0 with no lull
      // stalls trickle after opening kills for no encounter reason.
      if (next > this.reinforcementDelay) {
        const lullActive = (directive.lullRemaining ?? 0) > 0;
        if (this.reinforcementTimer > 0 || this.waitingWave || lullActive) {
          this.reinforcementTimer = Math.max(this.reinforcementTimer, next);
          if (this.waitingWave) {
            this.waveTimer = Math.max(this.waveTimer, next);
          }
        }
      }
      this.reinforcementDelay = next;
    }
    if (directive.aggression !== undefined) {
      this.aggression = THREE.MathUtils.clamp(directive.aggression, 0, 1);
    }
    if (directive.maxFireSlots !== undefined) {
      this.fireSlotBudget = THREE.MathUtils.clamp(
        Math.round(directive.maxFireSlots),
        1,
        this.maxFireSlots + 2,
      );
    }
    if (directive.allowFlanking !== undefined) this.allowFlanking = directive.allowFlanking;
  }

  /**
   * Player rounds that pass close to a hostile pin it without dealing damage.
   * This is the other half of the gunfight: shooting back changes enemy
   * behavior even when nothing connects.
   */
  notifyPlayerFire(
    origin: Readonly<THREE.Vector3>,
    direction: Readonly<THREE.Vector3>,
    options: { range?: number; radius?: number; power?: number } = {},
  ): void {
    const length = Math.hypot(direction.x, direction.y, direction.z);
    if (length < 1e-6) return;
    const range = Math.max(0, options.range ?? 90);
    const radius = Math.max(0.1, options.radius ?? this.suppressionRadius);
    const power = Math.max(0, options.power ?? 0.42);
    this._lane.set(direction.x / length, direction.y / length, direction.z / length);
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const chest = enemy.getAimPoint(this._chest);
      const along = THREE.MathUtils.clamp(
        (chest.x - origin.x) * this._lane.x
        + (chest.y - origin.y) * this._lane.y
        + (chest.z - origin.z) * this._lane.z,
        0,
        range,
      );
      this._closest
        .set(origin.x, origin.y, origin.z)
        .addScaledVector(this._lane, along);
      const miss = chest.distanceTo(this._closest);
      if (miss > radius) continue;
      // A round that cracks past an ear is worth far more than a distant one.
      const falloff = 1 - miss / radius;
      enemy.applySuppression(power * falloff * falloff, origin);
    }
  }

  /** Blast pressure suppresses everyone nearby, cover or not. */
  notifyExplosion(position: Readonly<THREE.Vector3>, radius = 8, power = 0.85): void {
    if (radius <= 0) return;
    for (const enemy of this.enemies) {
      if (!enemy.alive) continue;
      const distance = enemy.position.distanceTo(position);
      if (distance > radius) continue;
      enemy.applySuppression(power * (1 - distance / radius), position);
    }
  }

  /** Last position any squad member confirmed, used by HUD/QA tooling. */
  getSharedContact(): THREE.Vector3 | null {
    return this.hasSharedContact ? this.sharedContact.clone() : null;
  }

  applyRenderInterpolation(alpha: number): void {
    for (const enemy of this.enemies) enemy.applyRenderInterpolation(alpha);
  }

  applyHit(
    enemyOrObject: Enemy | THREE.Object3D,
    damage: number,
    part?: HitPart,
  ): HitResult {
    const enemy = enemyOrObject instanceof Enemy
      ? enemyOrObject
      : this.findEnemyFromObject(enemyOrObject);
    if (!enemy || !enemy.alive) return null;

    const resolved = part ?? Enemy.partFromObject(
      enemyOrObject instanceof Enemy ? enemy.mesh : enemyOrObject,
    );
    const wasAlive = enemy.alive;
    const health = enemy.hit(damage, resolved);
    const killed = wasAlive && !enemy.alive;
    if (killed) {
      this.fireSlots.delete(enemy);
      this.onEnemyDeath?.(enemy, resolved);
    }
    return { enemy, part: resolved, killed, health };
  }

  /**
   * Pre-scaled combat damage (weapons/grenades already applied multipliers).
   * Every kill is reported through onEnemyDeath so mission kill credit stays
   * on one path regardless of the damage source.
   */
  applyScaledDamage(
    enemy: Enemy,
    damage: number,
    reportPart: HitPart = 'generic',
  ): HitResult {
    if (!enemy.alive) return null;
    const wasAlive = enemy.alive;
    const health = enemy.hit(damage, 'generic');
    const killed = wasAlive && !enemy.alive;
    if (killed) {
      this.fireSlots.delete(enemy);
      this.onEnemyDeath?.(enemy, reportPart);
    }
    return { enemy, part: reportPart, killed, health };
  }

  /**
   * Hitscan adapters that route takeDamage through applyScaledDamage so
   * grenade splash and firearm hits share EnemyManager death accounting.
   */
  asHitscanTargets(): HitscanEnemy[] {
    return this.getAlive().map((enemy) => {
      const base = asHitscanEnemy(enemy);
      return {
        get alive() {
          return enemy.alive;
        },
        getHitboxes: () => base.getHitboxes(),
        takeDamage: (amount: number, bodyPart?: BodyPart) => {
          const result = this.applyScaledDamage(
            enemy,
            amount,
            hitscanBodyPartToHitPart(bodyPart),
          );
          return Boolean(result?.killed);
        },
      };
    });
  }

  raycast(
    raycaster: THREE.Raycaster,
  ): { enemy: Enemy; part: HitPart; intersection: THREE.Intersection } | null {
    const aliveMeshes: THREE.Object3D[] = [];
    const meshToEnemy = new Map<THREE.Object3D, Enemy>();
    for (const enemy of this.getAlive()) {
      enemy.mesh.traverse((object) => {
        const mesh = object as THREE.Mesh;
        if (mesh.isMesh) {
          aliveMeshes.push(mesh);
          meshToEnemy.set(mesh, enemy);
        }
      });
    }
    const hit = raycaster.intersectObjects(aliveMeshes, false)[0];
    if (!hit) return null;
    const enemy = meshToEnemy.get(hit.object);
    if (!enemy) return null;
    return { enemy, part: Enemy.partFromObject(hit.object), intersection: hit };
  }

  spawnAt(position: THREE.Vector3): Enemy {
    return this.spawnAtSnapshot(position);
  }

  private spawnAtSnapshot(position: THREE.Vector3, snapshot?: EnemyRuntimeSnapshot): Enemy {
    const serial = snapshot ? this.spawnSerial : ++this.spawnSerial;
    const enemyRandom = snapshot?.randomState !== null && snapshot?.randomState !== undefined
      ? new SeededRandom(snapshot.randomState)
      : this.random.fork(serial);
    const toPlayer = this.lastPlayerPosition.clone().sub(position);
    const enemy = new Enemy({
      id: snapshot?.id ?? `enemy:${serial}`,
      position: position.clone(),
      facingYaw: Math.atan2(toPlayer.x, toPlayer.z),
      coverNodes: this.level.coverNodes,
      lineOfSight: this.lineOfSight,
      requestFireSlot: (candidate) => this.requestFireSlot(candidate),
      isFireLaneBlocked: (shooter, origin, target) => this.isFireLaneBlocked(shooter, origin, target),
      role: snapshot?.role,
      randomSource: enemyRandom,
      onShoot: (event) => this.onEnemyShoot?.(event),
      onCallout: (callout, source) => this.onEnemyCallout?.(callout, source),
      health: snapshot?.maxHealth ?? this.random.integer(90, 119),
      accuracy: snapshot?.accuracy ?? this.random.range(0.62, 0.82),
      fireInterval: snapshot?.fireInterval ?? this.random.range(0.7, 1.2),
      movementAuthority: this.navigationRuntime?.movement ?? null,
      coverAuthority: this.navigationRuntime ? this.coverAuthority : null,
    });
    this.group.add(enemy.mesh);
    enemy.setLodBias(this.lodBias);
    if (this.authoredArchetypes.length > 0) {
      enemy.installAuthoredVisual(
        this.authoredArchetypes[this.enemies.length % this.authoredArchetypes.length],
      );
    }
    this.enemies.push(enemy);
    this.assignSquadTactics();
    return enemy;
  }

  pruneDead(maxKeep = 12): void {
    const dead = this.enemies.filter((enemy) => !enemy.alive);
    if (dead.length <= maxKeep) return;
    let remaining = dead.length - maxKeep;
    for (let i = this.enemies.length - 1; i >= 0 && remaining > 0; i--) {
      const enemy = this.enemies[i];
      if (!enemy.alive) {
        this.fireSlots.delete(enemy);
        enemy.dispose();
        this.enemies.splice(i, 1);
        remaining--;
      }
    }
  }

  getDebugState(): EnemyManagerDebugState {
    const p = this.lastPlayerPosition;
    const roles: Record<EnemyRole, number> = {
      assault: 0,
      flanker: 0,
      suppressor: 0,
      anchor: 0,
    };
    for (const enemy of this.enemies) {
      if (enemy.alive) roles[enemy.getRole()] += 1;
    }
    return {
      seedState: this.random.snapshot(),
      elapsed: this.elapsed,
      waveIndex: this.waveIndex,
      waitingWave: this.waitingWave,
      waveTimer: this.waveTimer,
      activeFireSlots: this.fireSlots.size,
      fireSlotBudget: this.effectiveFireSlots(),
      aliveTarget: this.aliveTarget,
      aggression: this.aggression,
      reinforcementTimer: this.reinforcementTimer,
      sharedContact: this.hasSharedContact
        ? { x: this.sharedContact.x, y: this.sharedContact.y, z: this.sharedContact.z }
        : null,
      contactAge: this.contactAge,
      roles,
      lastPlayerPosition: { x: p.x, y: p.y, z: p.z },
      enemies: this.enemies.map((enemy) => enemy.getDebugState()),
    };
  }

  snapshotState(): EnemyManagerSnapshot {
    return {
      randomState: this.random.snapshot(),
      elapsed: this.elapsed,
      waveTimer: this.waveTimer,
      waitingWave: this.waitingWave,
      waveIndex: this.waveIndex,
      spawnSerial: this.spawnSerial,
      lastPlayerPosition: {
        x: this.lastPlayerPosition.x,
        y: this.lastPlayerPosition.y,
        z: this.lastPlayerPosition.z,
      },
      enemies: this.enemies.map((enemy) => enemy.snapshotState()),
      fireSlots: [...this.fireSlots]
        .map(([enemy, expiry]) => ({
          enemyId: enemy.id,
          remaining: Math.max(0, expiry - this.elapsed),
        }))
        .filter((slot) => slot.remaining > 0)
        .sort((a, b) => a.enemyId.localeCompare(b.enemyId)),
      coverReservations: this.navigationRuntime?.cover.snapshot() ?? [],
      aliveTarget: this.aliveTarget,
      reinforcementDelay: this.reinforcementDelay,
      reinforcementTimer: this.reinforcementTimer,
      aggression: this.aggression,
      allowFlanking: this.allowFlanking,
      roleTimer: this.roleTimer,
      commsTimer: this.commsTimer,
      rosterSize: this.rosterSize,
      sharedContact: this.hasSharedContact
        ? { x: this.sharedContact.x, y: this.sharedContact.y, z: this.sharedContact.z }
        : null,
      contactAge: this.contactAge,
      playerHeading: {
        x: this.playerHeading.x,
        y: this.playerHeading.y,
        z: this.playerHeading.z,
      },
    };
  }

  restoreState(snapshot: EnemyManagerSnapshot): void {
    for (const enemy of this.enemies) {
      this.navigationRuntime?.movement.release(enemy);
      enemy.dispose();
    }
    this.enemies.length = 0;
    this.fireSlots.clear();
    this.elapsed = Math.max(0, snapshot.elapsed);
    this.waveTimer = Math.max(0, snapshot.waveTimer);
    this.waitingWave = snapshot.waitingWave;
    this.waveIndex = Math.max(0, Math.floor(snapshot.waveIndex));
    this.spawnSerial = Math.max(0, Math.floor(snapshot.spawnSerial));
    this.lastPlayerPosition.set(
      snapshot.lastPlayerPosition.x,
      snapshot.lastPlayerPosition.y,
      snapshot.lastPlayerPosition.z,
    );
    this.aliveTarget = THREE.MathUtils.clamp(
      Math.round(snapshot.aliveTarget ?? this.maxAlive),
      0,
      this.maxAlive,
    );
    this.reinforcementDelay = Math.max(0.5, snapshot.reinforcementDelay ?? this.reinforcementDelay);
    this.reinforcementTimer = Math.max(0, snapshot.reinforcementTimer ?? 0);
    this.aggression = THREE.MathUtils.clamp(snapshot.aggression ?? 0.5, 0, 1);
    this.allowFlanking = snapshot.allowFlanking ?? true;
    this.roleTimer = Math.max(0, snapshot.roleTimer ?? 0);
    this.commsTimer = Math.max(0, snapshot.commsTimer ?? 0);
    this.rosterSize = Math.max(0, Math.floor(snapshot.rosterSize ?? 0));
    this.contactAge = Math.max(0, snapshot.contactAge ?? 0);
    this.hasSharedContact = snapshot.sharedContact !== null
      && snapshot.sharedContact !== undefined;
    if (snapshot.sharedContact) {
      this.sharedContact.set(
        snapshot.sharedContact.x,
        snapshot.sharedContact.y,
        snapshot.sharedContact.z,
      );
    }
    const heading = snapshot.playerHeading;
    if (heading) this.playerHeading.set(heading.x, heading.y, heading.z);
    this.random.restore(snapshot.randomState);
    // Rebuilding the roster must not re-plan tactics; every agent's role and
    // cover claim comes from the snapshot instead.
    this.restoring = true;
    try {
      for (const enemySnapshot of snapshot.enemies) {
        const enemy = this.spawnAtSnapshot(new THREE.Vector3(
          enemySnapshot.position.x,
          enemySnapshot.position.y,
          enemySnapshot.position.z,
        ), enemySnapshot);
        enemy.restoreState(enemySnapshot);
      }
    } finally {
      this.restoring = false;
    }
    const enemiesById = new Map(this.enemies.map((enemy) => [enemy.id, enemy]));
    for (const slot of snapshot.fireSlots ?? []) {
      if (this.fireSlots.size >= this.effectiveFireSlots()) break;
      const enemy = enemiesById.get(slot.enemyId);
      if (!enemy?.alive || this.fireSlots.has(enemy) || !Number.isFinite(slot.remaining)) continue;
      const remaining = Math.max(0, slot.remaining);
      if (remaining > 0) this.fireSlots.set(enemy, this.elapsed + remaining);
    }
    this.navigationRuntime?.cover.restore(snapshot.coverReservations ?? []);
  }

  /**
   * Tears down the mid-fight roster and rebuilds the opening spawn set so a
   * death without a checkpoint (or a post-complete rematch) matches a clean start.
   */
  resetToInitial(): void {
    for (const enemy of this.enemies) {
      this.navigationRuntime?.movement.release(enemy);
      enemy.dispose();
    }
    this.enemies.length = 0;
    this.fireSlots.clear();
    this.elapsed = 0;
    this.waveTimer = 0;
    this.waitingWave = false;
    this.waveIndex = 0;
    this.spawnSerial = 0;
    this.reinforcementTimer = 0;
    this.roleTimer = 0;
    this.commsTimer = 0;
    this.rosterSize = 0;
    this.contactAge = 0;
    this.hasSharedContact = false;
    this.aliveTarget = this.maxAlive;
    this.reinforcementDelay = this.initialReinforcementDelay;
    this.aggression = 0.5;
    this.allowFlanking = true;
    this.fireSlotBudget = this.maxFireSlots;
    this.playerHeading.set(0, 0, 1);
    this.lastPlayerPosition.copy(this.level.playerSpawn);
    this.random.restore(this.initialRandomState);
    this.navigationRuntime?.cover.restore([]);
    this.spawnInitial();
    if (this.authoredArchetypes.length > 0) {
      this.enemies.forEach((enemy, index) => {
        enemy.installAuthoredVisual(
          this.authoredArchetypes[index % this.authoredArchetypes.length],
        );
      });
    }
  }

  dispose(): void {
    for (const enemy of this.enemies) {
      this.navigationRuntime?.movement.release(enemy);
      enemy.dispose();
    }
    this.enemies.length = 0;
    this.fireSlots.clear();
    this.group.removeFromParent();
  }

  private spawnInitial(): void {
    const opening = [
      new THREE.Vector3(-3.5, 0, 9),
      new THREE.Vector3(4, 0, 11),
    ];
    for (const position of opening) {
      if (this.enemies.length >= this.maxAlive) break;
      this.spawnAt(position);
    }

    const target = Math.min(
      this.maxAlive,
      Math.max(4, Math.floor(this.level.enemySpawns.length * 0.6)),
    );
    const candidates = this.rankSpawnCandidates(this.level.enemySpawns, opening);
    for (const position of candidates) {
      if (this.enemies.length >= target) break;
      this.spawnAt(position);
    }
    this.waveIndex = 1;
  }

  private assignSquadTactics(): void {
    const runtime = this.navigationRuntime;
    const preferred = runtime?.graph.nearestNode(this.lastPlayerPosition);
    if (!runtime || !preferred || this.restoring) return;
    const threat = this.hasSharedContact ? this.sharedContact : this.lastPlayerPosition;
    const assignments = runtime.squad.assign(
      this.getAlive().map((enemy) => ({
        id: enemy.id,
        position: { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z },
        alive: enemy.alive,
      })),
      preferred.id,
      {
        threat: { x: threat.x, y: threat.y, z: threat.z },
        threatFacing: { x: this.playerHeading.x, y: 0, z: this.playerHeading.z },
        maxFlankers: this.maxFlankers(),
      },
    );
    const byId = new Map(this.enemies.map((enemy) => [enemy.id, enemy]));
    for (const assignment of assignments) {
      const enemy = byId.get(assignment.agentId);
      if (!enemy || !assignment.role) continue;
      enemy.setRole(assignment.role, assignment.side ?? enemy.getFlankSide());
      if (assignment.role !== 'flanker') continue;
      const node = assignment.flankNodeId
        ? runtime.graph.getNode(assignment.flankNodeId)
        : null;
      if (node) {
        enemy.setFlankTarget(new THREE.Vector3(node.position.x, enemy.position.y, node.position.z));
      }
    }
  }

  /**
   * Shared awareness plus periodic role planning. A hostile that sees the
   * player becomes the squad's eyes: the sighting is relayed on a delay so
   * squadmates react like a radio call rather than a hive mind.
   */
  private updateSquadCoordination(step: number): void {
    if (this.restoring) return;
    const alive = this.getAlive();
    if (alive.length === 0) {
      this.hasSharedContact = false;
      this.contactAge = 0;
      this.rosterSize = 0;
      return;
    }

    const spotter = alive.find((enemy) => enemy.hasVisualContact()) ?? null;
    if (spotter) {
      this.sharedContact.copy(this.lastPlayerPosition);
      this.hasSharedContact = true;
      this.contactAge = 0;
    } else if (this.hasSharedContact) {
      this.contactAge += step;
      if (this.contactAge > this.contactMemory) {
        this.hasSharedContact = false;
        this.contactAge = 0;
      }
    }

    // Timers are floored at zero so a checkpoint round-trips exactly.
    this.commsTimer = Math.max(0, this.commsTimer - step);
    if (this.hasSharedContact && this.commsTimer <= 0) {
      this.commsTimer = this.commsDelay;
      this.relayContact(spotter, alive);
    }

    this.roleTimer = Math.max(0, this.roleTimer - step);
    if (this.roleTimer <= 0 || alive.length !== this.rosterSize) {
      // Re-planning on a cadence keeps roles stable enough to read on screen
      // while still adapting as the squad is whittled down.
      this.roleTimer = 0.75;
      this.rosterSize = alive.length;
      this.planRoles(alive);
    }
  }

  private relayContact(spotter: Enemy | null, alive: readonly Enemy[]): void {
    const radiusSq = this.commsRadius * this.commsRadius;
    for (const enemy of alive) {
      if (enemy === spotter || enemy.hasVisualContact()) continue;
      const reference = spotter ? spotter.position : this.sharedContact;
      const distanceSq = enemy.position.distanceToSquared(reference);
      if (distanceSq > radiusSq) continue;
      // Confidence falls off with distance from whoever made the call.
      const confidence = 0.85 - Math.sqrt(distanceSq) / this.commsRadius * 0.5;
      enemy.notifyContact(this.sharedContact, confidence);
    }
  }

  private planRoles(alive: readonly Enemy[]): void {
    const runtime = this.navigationRuntime;
    if (runtime) {
      // With a navigation graph the squad director owns roles, crossfire cover
      // and flank routes in one deterministic pass.
      this.assignSquadTactics();
      return;
    }
    const threat = this.hasSharedContact ? this.sharedContact : this.lastPlayerPosition;
    const plans = planSquadRoles(
      alive.map((enemy) => ({
        id: enemy.id,
        position: { x: enemy.position.x, y: enemy.position.y, z: enemy.position.z },
        alive: enemy.alive,
      })),
      { x: threat.x, y: threat.y, z: threat.z },
      {
        threatFacing: { x: this.playerHeading.x, y: 0, z: this.playerHeading.z },
        maxFlankers: this.maxFlankers(),
      },
    );
    const byId = new Map(alive.map((enemy) => [enemy.id, enemy]));
    for (const plan of plans) byId.get(plan.agentId)?.setRole(plan.role, plan.side);
  }

  private maxFlankers(): number {
    if (!this.allowFlanking || this.aggression < 0.3) return 0;
    return Math.min(2, Math.max(1, Math.round(this.aggression * 2)));
  }

  private trackPlayerHeading(playerPos: Readonly<THREE.Vector3>, step: number): void {
    if (step <= 0) return;
    const dx = playerPos.x - this.lastPlayerPosition.x;
    const dz = playerPos.z - this.lastPlayerPosition.z;
    if (dx * dx + dz * dz < 1e-6) return;
    // Movement direction stands in for player facing; flank planning only needs
    // an axis to work around, and this stays replay-safe.
    this.playerHeading.set(dx, 0, dz).normalize();
  }

  private updateWavePacing(step: number, aliveCount: number): void {
    if (aliveCount === 0) {
      this.reinforcementTimer = 0;
      if (!this.waitingWave) {
        this.waitingWave = true;
        // Cooling already lengthened reinforcementDelay before this wipe arm —
        // use that floor so a lull wipe does not respawn on the short waveDelay
        // while mid-wait stretch only covers delay increases after waiting starts.
        this.waveTimer = Math.max(this.waveDelay, this.reinforcementDelay);
      } else {
        this.waveTimer = Math.max(0, this.waveTimer - step);
        if (this.waveTimer <= 0) {
          // Match trickle reinforce: a LOS-blocked wipe must retry soon, not
          // clear waitingWave and burn another full cooled waveDelay.
          if (this.spawnWave() > 0) this.waitingWave = false;
          else this.waveTimer = 0.5;
        }
      }
      return;
    }
    this.waitingWave = false;
    // Trickle reinforcements so pressure is continuous instead of arriving as
    // one lump after a total wipe.
    this.reinforcementTimer = Math.max(0, this.reinforcementTimer - step);
    const target = Math.min(this.maxAlive, this.aliveTarget);
    if (aliveCount >= target || this.reinforcementTimer > 0) return;
    const batch = Math.min(target - aliveCount, 1 + Math.floor(this.aggression * 2));
    // Match wipe: a LOS-blocked trickle must retry soon, not hammer spawnGroup
    // every tick while reinforcementTimer stays at 0.
    if (this.spawnGroup(batch) > 0) this.reinforcementTimer = this.reinforcementDelay;
    else this.reinforcementTimer = 0.5;
  }

  private spawnWave(): number {
    this.pruneDead(8);
    const target = Math.min(this.maxAlive, this.aliveTarget);
    const room = Math.max(0, target - this.getAlive().length);
    // waveIndex only advances on a real spawn so blocked attempts do not
    // inflate the next successful wave size.
    const count = Math.min(this.waveSize + Math.floor(this.waveIndex * 0.5), room);
    const spawned = this.spawnGroup(count);
    if (spawned > 0) {
      this.waveIndex++;
      this.reinforcementTimer = this.reinforcementDelay;
    }
    return spawned;
  }

  private spawnGroup(count: number): number {
    if (count <= 0) return 0;
    const candidates = this.rankSpawnCandidates(this.level.enemySpawns);
    if (candidates.length === 0) return 0;
    let spawned = 0;
    for (let i = 0; i < count; i++) {
      if (this.getAlive().length >= this.maxAlive) break;
      const source = candidates[i % candidates.length];
      const jitter = new THREE.Vector3(
        this.random.range(-0.75, 0.75),
        0,
        this.random.range(-0.75, 0.75),
      );
      this.spawnAt(source.clone().add(jitter));
      spawned += 1;
    }
    return spawned;
  }

  private rankSpawnCandidates(
    candidates: readonly THREE.Vector3[],
    excluded: readonly THREE.Vector3[] = [],
  ): THREE.Vector3[] {
    const unique = candidates.filter((candidate) => (
      !excluded.some((position) => position.distanceToSquared(candidate) < 3.5 * 3.5) &&
      candidate.distanceTo(this.lastPlayerPosition) >= this.minSpawnDistance &&
      !this.isSpawnVisible(candidate, this.lastPlayerPosition)
    ));
    const shuffled = shuffledCopy(unique, this.random);
    return shuffled.sort((a, b) => {
      const aDistance = a.distanceTo(this.lastPlayerPosition);
      const bDistance = b.distanceTo(this.lastPlayerPosition);
      return bDistance - aDistance;
    });
  }

  private requestFireSlot(enemy: Enemy): boolean {
    const current = this.fireSlots.get(enemy);
    if (current !== undefined && current > this.elapsed) return true;
    this.fireSlots.delete(enemy);
    this.expireFireSlots();
    const budget = this.effectiveFireSlots();
    if (this.fireSlots.size < budget) {
      this.fireSlots.set(enemy, this.elapsed + this.fireSlotDuration);
      return true;
    }
    // Bounded concurrency is the main pacing lever, so the slot should belong to
    // whoever is the most immediate threat rather than whoever asked first.
    const priority = this.firePriority(enemy);
    let weakest: Enemy | null = null;
    let weakestPriority = Infinity;
    for (const holder of this.fireSlots.keys()) {
      const holderPriority = this.firePriority(holder);
      if (
        weakest === null
        || holderPriority < weakestPriority
        || (holderPriority === weakestPriority && holder.id.localeCompare(weakest.id) < 0)
      ) {
        weakest = holder;
        weakestPriority = holderPriority;
      }
    }
    // The margin stops two evenly matched hostiles trading the slot every tick.
    if (!weakest || priority <= weakestPriority + 0.15) return false;
    this.fireSlots.delete(weakest);
    this.fireSlots.set(enemy, this.elapsed + this.fireSlotDuration);
    return true;
  }

  private firePriority(enemy: Enemy): number {
    const distance = enemy.position.distanceTo(this.lastPlayerPosition);
    return (enemy.hasVisualContact() ? 1 : 0)
      + THREE.MathUtils.clamp(1 - distance / 40, 0, 1) * 0.8
      + (enemy.getRole() === 'suppressor' ? 0.25 : 0)
      - enemy.getSuppression() * 0.5;
  }

  private effectiveFireSlots(): number {
    return Math.max(1, Math.round(this.fireSlotBudget * (0.75 + this.aggression * 0.75)));
  }

  /** True when a squadmate stands inside the shot; the shooter then holds fire. */
  private isFireLaneBlocked(
    shooter: Enemy,
    origin: Readonly<THREE.Vector3>,
    target: Readonly<THREE.Vector3>,
  ): boolean {
    const dx = target.x - origin.x;
    const dy = target.y - origin.y;
    const dz = target.z - origin.z;
    const lengthSq = dx * dx + dy * dy + dz * dz;
    if (lengthSq < 1e-6) return false;
    for (const other of this.enemies) {
      if (other === shooter || !other.alive) continue;
      const chest = other.getAimPoint(this._chest);
      const along = ((chest.x - origin.x) * dx
        + (chest.y - origin.y) * dy
        + (chest.z - origin.z) * dz) / lengthSq;
      if (along <= 0.05 || along >= 0.98) continue;
      const ox = origin.x + dx * along - chest.x;
      const oy = origin.y + dy * along - chest.y;
      const oz = origin.z + dz * along - chest.z;
      if (ox * ox + oy * oy + oz * oz < 0.55 * 0.55) return true;
    }
    return false;
  }

  private expireFireSlots(): void {
    for (const [enemy, expiry] of this.fireSlots) {
      if (!enemy.alive || expiry <= this.elapsed) this.fireSlots.delete(enemy);
    }
  }

  private findEnemyFromObject(object: THREE.Object3D): Enemy | null {
    let current: THREE.Object3D | null = object;
    while (current) {
      if (current.userData?.enemy instanceof Enemy) return current.userData.enemy as Enemy;
      current = current.parent;
    }
    return null;
  }
}

function shuffledCopy<T>(items: readonly T[], random: SeededRandom): T[] {
  const result = [...items];
  for (let i = result.length - 1; i > 0; i--) {
    const j = random.integer(0, i);
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

function hitscanBodyPartToHitPart(bodyPart?: BodyPart): HitPart {
  if (bodyPart === 'head') return 'head';
  if (bodyPart === 'arm' || bodyPart === 'limbs') return 'arm';
  if (bodyPart === 'leg') return 'leg';
  if (bodyPart === 'torso') return 'torso';
  return 'generic';
}

/** Segment/AABB occlusion query; true means no level collider blocks the ray. */
function hasColliderLineOfSight(
  origin: Readonly<THREE.Vector3>,
  target: Readonly<THREE.Vector3>,
  colliders: readonly { min: THREE.Vector3; max: THREE.Vector3 }[],
): boolean {
  const dx = target.x - origin.x;
  const dy = target.y - origin.y;
  const dz = target.z - origin.z;
  for (const collider of colliders) {
    let enter = 0;
    let exit = 1;
    const axes: Array<[number, number, number, number]> = [
      [origin.x, dx, collider.min.x, collider.max.x],
      [origin.y, dy, collider.min.y, collider.max.y],
      [origin.z, dz, collider.min.z, collider.max.z],
    ];
    let intersects = true;
    for (const [start, delta, min, max] of axes) {
      if (Math.abs(delta) < 1e-8) {
        if (start < min || start > max) {
          intersects = false;
          break;
        }
        continue;
      }
      const a = (min - start) / delta;
      const b = (max - start) / delta;
      enter = Math.max(enter, Math.min(a, b));
      exit = Math.min(exit, Math.max(a, b));
      if (enter > exit) {
        intersects = false;
        break;
      }
    }
    // Ignore contact at the exact endpoints; only interior occlusion blocks LOS.
    if (intersects && exit > 1e-4 && enter < 1 - 1e-4) return false;
  }
  return true;
}
