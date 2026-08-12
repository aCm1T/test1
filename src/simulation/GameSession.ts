import { SeededRandom } from '../mission';
import type { PhysicsWorld, Vec3 } from './PhysicsWorld';

export interface InputFrame {
  moveX: number;
  moveY: number;
  /** Raw pointer delta accumulated since the previous fixed tick. */
  lookX: number;
  lookY: number;
  /** Held state for automatic weapons. */
  fire: boolean;
  /** Edge captured by the input sampler for semi-auto/melee actions. */
  firePressed: boolean;
  aim: boolean;
  /** Edge captured separately so toggle-ADS is replayable. */
  aimPressed: boolean;
  /** The remaining action fields are fixed-tick press events unless noted. */
  reload: boolean;
  grenade: boolean;
  interact: boolean;
  jump: boolean;
  /** Held movement modifiers. */
  crouch: boolean;
  sprint: boolean;
  weaponSlot?: 1 | 2 | 3;
  weaponCycle: -1 | 0 | 1;
}

export type GameEvent =
  | { type: 'shot'; tick: number; weapon: string; seed: number; origin: Vec3; direction: Vec3; hit: string | null }
  | { type: 'mission'; tick: number; event: string }
  | { type: 'checkpoint'; tick: number; id: string }
  | { type: 'simulation'; tick: number; event: string }
  /** Squad-pressure telemetry (role changes, flanks, reinforcements, barks). */
  | { type: 'squad'; tick: number; event: string; agentId?: string };

export interface PlayerSnapshot {
  position: Vec3;
  velocity: Vec3;
  health: number;
  armor: number;
  yaw: number;
  pitch: number;
  alive: boolean;
  crouching: boolean;
  grounded: boolean;
  sliding: boolean;
  slideTimer: number;
  mantleCooldown: number;
  eyeHeight: number;
}

export interface InventorySnapshot {
  ammunition: Record<string, { mag: number; reserve: number }>;
  equipment: Record<string, number>;
}

export interface WeaponSnapshot {
  active: string;
  fireCooldown: number;
  reloading: boolean;
  reloadRemaining: number;
  ads: boolean;
  toggledAds: boolean;
  recoil: { pitch: number; yaw: number };
  /** Sustained-fire pattern cursor; must round-trip with restore (not live spread). */
  recoilShotIndex: number;
  /** Seconds until the pattern resets; must round-trip with restore. */
  recoilPatternTimer: number;
  /** Accumulated hip/ADS bloom 0→1; must round-trip with restore. */
  spreadBloom: number;
  /** Empty-mag dry-fire latch; must round-trip or restore re-clicks a held trigger. */
  dryFireLatch: boolean;
  /** Prior-frame fire-held edge for DOM firePressed after restore. */
  prevFire: boolean;
  randomState: number;
}

export interface GameWorldSnapshot {
  player: PlayerSnapshot;
  inventory: InventorySnapshot;
  weapon: WeaponSnapshot;
  grenadeCount: number;
  /** Full live-equipment state; optional for snapshots produced before replay support. */
  grenades?: unknown;
  mission: unknown;
  encounter: unknown;
  ai: unknown;
}

export interface GameSnapshot {
  tick: number;
  fixedDelta: number;
  randomState: number;
  world: GameWorldSnapshot;
  pendingInputs: Array<[number, InputFrame]>;
}

export interface GameSessionSystems {
  /**
   * Fixed pipeline: input intent → physics → navigation/AI → combat → mission
   * presentation. Combat-affecting mission state (beat / jammer / lull) is
   * advanced inside updateNavigationAndAI before the squad directive is applied
   * so AI sees same-tick transitions; updateMission stays HUD/audio only.
   */
  applyInput(input: Readonly<InputFrame>, tick: number, dt: number): void;
  physics: PhysicsWorld;
  /**
   * AI and squad coordination. `random` is a per-tick stream derived from the
   * session seed, so tactical variety never shifts the weapon/combat stream and
   * both remain byte-identical across replays. Returned events are emitted in
   * pipeline order alongside combat and mission events.
   */
  updateNavigationAndAI(tick: number, dt: number, random: SeededRandom): GameEvent[] | void;
  updateCombat(tick: number, dt: number, random: SeededRandom): GameEvent[];
  updateMission(tick: number, dt: number): GameEvent[];
  snapshotWorld(): GameWorldSnapshot;
  restoreWorld(snapshot: GameWorldSnapshot): void;
}

export interface GameSessionOptions {
  systems: GameSessionSystems;
  fixedDelta?: number;
  seed?: number;
  random?: SeededRandom;
  onEvent?: (event: GameEvent) => void;
}

const EMPTY_INPUT: Readonly<InputFrame> = Object.freeze({
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
});

/**
 * Fixed-tick owner for every simulation-affecting system. Rendering consumes
 * an interpolated view of this state and never advances gameplay on its own.
 */
export class GameSession {
  readonly fixedDelta: number;
  private readonly systems: GameSessionSystems;
  private readonly random: SeededRandom;
  private readonly onEvent?: (event: GameEvent) => void;
  private readonly inputs = new Map<number, InputFrame>();
  private currentTick = 0;

  constructor(options: GameSessionOptions) {
    this.fixedDelta = positive(options.fixedDelta ?? 1 / 60, 'fixedDelta');
    this.systems = options.systems;
    this.random = options.random ?? new SeededRandom(options.seed);
    this.onEvent = options.onEvent;
  }

  get tick(): number {
    return this.currentTick;
  }

  enqueueInput(tick: number, input: InputFrame): void {
    if (!Number.isSafeInteger(tick) || tick <= this.currentTick) {
      throw new RangeError(`Input tick ${tick} must be a future integer`);
    }
    this.inputs.set(tick, cloneInput(input));
  }

  step(count = 1): void {
    if (!Number.isSafeInteger(count) || count < 1) throw new RangeError('step count must be a positive integer');
    for (let index = 0; index < count; index += 1) this.stepOne();
  }

  snapshot(): GameSnapshot {
    return {
      tick: this.currentTick,
      fixedDelta: this.fixedDelta,
      randomState: this.random.snapshot(),
      world: cloneWorld(this.systems.snapshotWorld()),
      pendingInputs: [...this.inputs]
        .sort(([a], [b]) => a - b)
        .map(([tick, input]) => [tick, cloneInput(input)]),
    };
  }

  restore(snapshot: GameSnapshot): void {
    if (snapshot.fixedDelta !== this.fixedDelta) {
      throw new Error(`Cannot restore a ${snapshot.fixedDelta}s snapshot into a ${this.fixedDelta}s session`);
    }
    if (!Number.isSafeInteger(snapshot.tick) || snapshot.tick < 0) {
      throw new RangeError('Snapshot tick must be a non-negative integer');
    }
    this.currentTick = snapshot.tick;
    this.random.restore(snapshot.randomState);
    this.inputs.clear();
    for (const [tick, input] of snapshot.pendingInputs) this.inputs.set(tick, cloneInput(input));
    this.systems.restoreWorld(cloneWorld(snapshot.world));
  }

  /**
   * Rewind only the session clock. Death restore uses this so mission lull can
   * still come from `restoreCheckpoint()` without a full world snapshot swap —
   * AI `fork(tick)` salts must match the checkpoint epoch or they diverge.
   */
  rewindClock(tick: number): void {
    if (!Number.isSafeInteger(tick) || tick < 0) {
      throw new RangeError('tick must be a non-negative integer');
    }
    this.currentTick = tick;
    this.inputs.clear();
  }

  private stepOne(): void {
    this.currentTick += 1;
    const input = this.inputs.get(this.currentTick) ?? EMPTY_INPUT;
    this.inputs.delete(this.currentTick);
    this.systems.applyInput(input, this.currentTick, this.fixedDelta);
    this.systems.physics.step(this.fixedDelta);
    // fork() derives a stream without advancing the master state, so AI draws
    // stay isolated from the combat stream while remaining fully replayable.
    this.emitAll(this.systems.updateNavigationAndAI(
      this.currentTick,
      this.fixedDelta,
      this.random.fork(this.currentTick),
    ));
    this.emitAll(this.systems.updateCombat(this.currentTick, this.fixedDelta, this.random));
    this.emitAll(this.systems.updateMission(this.currentTick, this.fixedDelta));
  }

  private emitAll(events: readonly GameEvent[] | void): void {
    if (!events) return;
    for (const event of events) this.onEvent?.(event);
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function cloneInput(input: InputFrame): InputFrame {
  for (const value of [input.moveX, input.moveY, input.lookX, input.lookY]) {
    if (!Number.isFinite(value)) throw new TypeError('Input axes must be finite');
  }
  if (input.weaponSlot !== undefined && ![1, 2, 3].includes(input.weaponSlot)) {
    throw new RangeError('weaponSlot must be 1, 2 or 3');
  }
  if (![-1, 0, 1].includes(input.weaponCycle)) {
    throw new RangeError('weaponCycle must be -1, 0 or 1');
  }
  return { ...input };
}

function cloneWorld(world: GameWorldSnapshot): GameWorldSnapshot {
  // Game snapshot payloads are deliberately data-only. structuredClone retains
  // `undefined` fields correctly and is available in every supported browser.
  return structuredClone(world);
}
