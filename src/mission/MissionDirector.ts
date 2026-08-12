import type { Vector3 } from 'three';

export type MissionBeat =
  | 'insertion'
  | 'intersection'
  | 'jammer'
  | 'defense'
  | 'extraction'
  | 'complete'
  | 'failed';

export type MissionEventType =
  | 'beat-changed'
  | 'encounter-complete'
  | 'checkpoint-saved'
  | 'checkpoint-restored'
  | 'mission-complete'
  | 'mission-failed';

export type MissionEvent = {
  type: MissionEventType;
  beat: MissionBeat;
  previousBeat?: MissionBeat;
  checkpoint?: MissionCheckpoint;
};

export type MissionFrame = {
  playerPosition: Readonly<Pick<Vector3, 'x' | 'y' | 'z'>>;
  playerDead?: boolean;
  firstContactComplete?: boolean;
  intersectionClear?: boolean;
  jammerDisabled?: boolean;
  /** Active authored trigger zones. Zone entry alone never advances an encounter. */
  activeZones?: Partial<Record<MissionTriggerZone, boolean>>;
  /** Live combat telemetry used only for pacing, never for beat progression. */
  hostilesAlive?: number;
  /** 0 is a downed player, 1 is untouched; drives the post-fight breather. */
  playerHealthFraction?: number;
};

/**
 * Squad pressure the current beat wants applied. The AI layer consumes this and
 * knows nothing about mission structure, and the director never touches enemies.
 */
export type MissionCombatDirective = {
  beat: MissionBeat;
  /** Simultaneous hostiles the beat is built for. */
  aliveTarget: number;
  reinforcementDelay: number;
  /** 0 is a cautious holding action, 1 is maximum squad pressure. */
  aggression: number;
  maxFireSlots: number;
  allowFlanking: boolean;
  /** Seconds of deliberate lull remaining after a completed encounter. */
  lullRemaining: number;
};

export type MissionTriggerZone = 'first-contact' | 'intersection' | 'jammer' | 'defense' | 'extraction';

export type MissionZone = { x: number; z: number; radius: number };

export type EncounterState = {
  firstContactComplete: boolean;
  intersectionClear: boolean;
  jammerDisabled: boolean;
  defenseStarted: boolean;
};

export type MissionCheckpoint = {
  beat: MissionBeat;
  playerPosition: { x: number; y: number; z: number };
  elapsed: number;
  defenseRemaining: number;
  encounters: EncounterState;
};

export type MissionSnapshot = {
  beat: MissionBeat;
  elapsed: number;
  beatElapsed: number;
  defenseRemaining: number;
  encounters: EncounterState;
  checkpoint: MissionCheckpoint | null;
  lullRemaining: number;
  /** Live combat telemetry; required so getCombatDirective round-trips. */
  hostilesAlive: number;
  playerHealthFraction: number;
};

export type MissionDirectorOptions = {
  /** Legacy zone center, retained for existing scene configuration. */
  insertionLineZ?: number;
  /** Crossing this northward Z line enters the warehouse/jammer beat. */
  intersectionLineZ?: number;
  /** Center of the extraction trigger. */
  extraction?: { x: number; z: number; radius: number };
  defenseDuration?: number;
  triggerZones?: Partial<Record<MissionTriggerZone, MissionZone>>;
  /** Seconds of reduced pressure granted after each completed encounter. */
  encounterLull?: number;
  onEvent?: (event: MissionEvent) => void;
};

export type MissionDebugState = {
  beat: MissionBeat;
  elapsed: number;
  beatElapsed: number;
  defenseRemaining: number;
  jammerDisabled: boolean;
  checkpoint: MissionCheckpoint | null;
  encounters: EncounterState;
  combat: MissionCombatDirective;
};

/**
 * Deterministic five-beat vertical-slice mission state machine.
 *
 * The director owns objective progression and its pre-defense checkpoint, but
 * deliberately does not own player/enemy objects. Consumers apply the returned
 * checkpoint to their own systems, which keeps restore behavior testable.
 */
export class MissionDirector {
  private readonly zones: Record<MissionTriggerZone, MissionZone>;
  private readonly defenseDuration: number;
  private readonly encounterLull: number;
  private readonly onEvent: ((event: MissionEvent) => void) | null;
  private lullRemaining = 0;
  private hostilesAlive = 0;
  private playerHealthFraction = 1;

  private beat: MissionBeat = 'insertion';
  private elapsed = 0;
  private beatElapsed = 0;
  private defenseRemaining: number;
  private readonly encounters: EncounterState = {
    firstContactComplete: false,
    intersectionClear: false,
    jammerDisabled: false,
    defenseStarted: false,
  };
  private checkpoint: MissionCheckpoint | null = null;

  constructor(options: MissionDirectorOptions = {}) {
    const extraction = options.extraction ?? { x: 0, z: 30, radius: 4 };
    this.zones = {
      'first-contact': { x: 0, z: options.insertionLineZ ?? 6, radius: 8 },
      intersection: { x: 0, z: options.intersectionLineZ ?? 17, radius: 10 },
      jammer: { x: 0, z: (options.intersectionLineZ ?? 17) + 2, radius: 12 },
      defense: { x: 0, z: (options.intersectionLineZ ?? 17) + 2, radius: 14 },
      extraction,
      ...options.triggerZones,
    };
    this.defenseDuration = Math.max(1, options.defenseDuration ?? 90);
    this.defenseRemaining = this.defenseDuration;
    this.encounterLull = Math.max(0, options.encounterLull ?? 4);
    this.onEvent = options.onEvent ?? null;
  }

  update(dt: number, frame: MissionFrame): MissionEvent[] {
    const events: MissionEvent[] = [];
    if (this.isTerminal()) return events;

    const step = Math.max(0, dt);
    this.elapsed += step;
    this.beatElapsed += step;
    this.lullRemaining = Math.max(0, this.lullRemaining - step);
    if (frame.hostilesAlive !== undefined) {
      this.hostilesAlive = Math.max(0, Math.floor(frame.hostilesAlive));
    }
    if (frame.playerHealthFraction !== undefined) {
      this.playerHealthFraction = clamp01(frame.playerHealthFraction);
    }

    if (frame.playerDead) {
      this.fail(events);
      return events;
    }

    this.syncEncounterFlags(frame, events);

    switch (this.beat) {
      case 'insertion':
        if (this.encounters.firstContactComplete && this.inZone('first-contact', frame)) {
          this.transition('intersection', events);
        }
        break;
      case 'intersection':
        if (this.encounters.intersectionClear && this.inZone('intersection', frame)) {
          this.transition('jammer', events);
        }
        break;
      case 'jammer':
        if (this.encounters.jammerDisabled && this.inZone('jammer', frame)) {
          const checkpoint = this.saveCheckpoint(frame.playerPosition);
          this.transition('defense', events);
          this.emit({
            type: 'checkpoint-saved',
            beat: 'defense',
            checkpoint: cloneCheckpoint(checkpoint),
          }, events);
        }
        break;
      case 'defense':
        // CoD-style hold: once the defense beat starts, the timer keeps
        // counting even if the player briefly steps outside the zone.
        this.encounters.defenseStarted = true;
        this.defenseRemaining = Math.max(0, this.defenseRemaining - step);
        if (this.defenseRemaining === 0) this.transition('extraction', events);
        break;
      case 'extraction': {
        if (this.inZone('extraction', frame)) {
          this.transition('complete', events);
          this.emit({ type: 'mission-complete', beat: 'complete' }, events);
        }
        break;
      }
      case 'complete':
      case 'failed':
        break;
    }
    return events;
  }

  disableJammer(): void {
    if (this.encounters.jammerDisabled) return;
    this.encounters.jammerDisabled = true;
    // Live interact clears through this side door (not MissionFrame.jammerDisabled),
    // so grant the same breather syncEncounterFlags would — otherwise defense opens
    // at full squad pressure with no encounter lull.
    this.lullRemaining = Math.max(this.lullRemaining, this.encounterLull);
    this.onEvent?.({ type: 'encounter-complete', beat: this.beat });
  }

  completeEncounter(encounter: 'first-contact' | 'intersection'): void {
    if (encounter === 'first-contact') this.encounters.firstContactComplete = true;
    else this.encounters.intersectionClear = true;
  }

  /** Mark failure immediately (for damage/death systems outside the fixed step). */
  markFailed(): MissionEvent[] {
    const events: MissionEvent[] = [];
    if (!this.isTerminal()) this.fail(events);
    return events;
  }

  /**
   * Restore mission timing/state and return the player transform snapshot that
   * the integration layer should apply. Returns null before a checkpoint exists.
   */
  restoreCheckpoint(): MissionCheckpoint | null {
    if (!this.checkpoint) return null;
    const restored = cloneCheckpoint(this.checkpoint);
    this.beat = restored.beat;
    this.elapsed = restored.elapsed;
    this.beatElapsed = 0;
    this.defenseRemaining = restored.defenseRemaining;
    // A restored player gets the same breather as a cleared encounter instead of
    // spawning straight back into a fully committed squad.
    this.lullRemaining = this.encounterLull;
    this.playerHealthFraction = 1;
    Object.assign(this.encounters, cloneEncounters(restored.encounters));
    this.onEvent?.({
      type: 'checkpoint-restored',
      beat: this.beat,
      checkpoint: cloneCheckpoint(restored),
    });
    return restored;
  }

  reset(): void {
    this.beat = 'insertion';
    this.elapsed = 0;
    this.beatElapsed = 0;
    this.defenseRemaining = this.defenseDuration;
    this.lullRemaining = 0;
    this.hostilesAlive = 0;
    this.playerHealthFraction = 1;
    Object.assign(this.encounters, {
      firstContactComplete: false,
      intersectionClear: false,
      jammerDisabled: false,
      defenseStarted: false,
    });
    this.checkpoint = null;
  }

  getBeat(): MissionBeat {
    return this.beat;
  }

  getObjectiveText(): string {
    switch (this.beat) {
      case 'insertion': return 'Advance north and make first contact';
      case 'intersection': return 'Cross the intersection';
      case 'jammer': return 'Clear the warehouse and disable the jammer';
      case 'defense': return `Defend the jammer — ${Math.ceil(this.defenseRemaining)}s`;
      case 'extraction': return 'Reach northern extraction';
      case 'complete': return 'Mission complete';
      case 'failed': return 'Mission failed';
    }
  }

  /**
   * Per-beat squad pressure. Insertion is a light contact, the warehouse is a
   * held-position fight, and defense escalates on a timer so the last seconds
   * are the hardest. A completed encounter or a badly hurt player buys a short
   * breather, which is what stops sustained combat reading as a flat grind.
   */
  getCombatDirective(): MissionCombatDirective {
    const base = this.baseDirective();
    const hurt = 1 - this.playerHealthFraction;
    // Cooling factor: 0 keeps full pressure, 1 backs the squad right off.
    const cooling = Math.min(
      0.75,
      (this.lullRemaining > 0 ? 0.45 : 0) + (hurt > 0.65 ? 0.3 : 0),
    );
    const aggression = clamp01(base.aggression * (1 - cooling));
    // An already-crowded fight does not need more bodies thrown into it.
    const crowded = this.hostilesAlive > base.aliveTarget ? 4 : 0;
    return {
      beat: this.beat,
      aliveTarget: Math.max(
        this.beat === 'complete' || this.beat === 'failed' ? 0 : 1,
        Math.round(base.aliveTarget * (1 - cooling * 0.5)),
      ),
      reinforcementDelay: base.reinforcementDelay * (1 + cooling * 1.5) + crowded,
      aggression,
      maxFireSlots: Math.max(1, Math.round(base.maxFireSlots - cooling * 2)),
      allowFlanking: base.allowFlanking && aggression >= 0.35,
      lullRemaining: this.lullRemaining,
    };
  }

  getDebugState(): MissionDebugState {
    return {
      beat: this.beat,
      elapsed: this.elapsed,
      beatElapsed: this.beatElapsed,
      defenseRemaining: this.defenseRemaining,
      jammerDisabled: this.encounters.jammerDisabled,
      checkpoint: this.checkpoint ? cloneCheckpoint(this.checkpoint) : null,
      encounters: cloneEncounters(this.encounters),
      combat: this.getCombatDirective(),
    };
  }

  snapshot(): MissionSnapshot {
    return {
      beat: this.beat,
      elapsed: this.elapsed,
      beatElapsed: this.beatElapsed,
      defenseRemaining: this.defenseRemaining,
      encounters: cloneEncounters(this.encounters),
      checkpoint: this.checkpoint ? cloneCheckpoint(this.checkpoint) : null,
      lullRemaining: this.lullRemaining,
      hostilesAlive: this.hostilesAlive,
      playerHealthFraction: this.playerHealthFraction,
    };
  }

  restore(snapshot: MissionSnapshot): void {
    this.beat = snapshot.beat;
    this.elapsed = Math.max(0, snapshot.elapsed);
    this.beatElapsed = Math.max(0, snapshot.beatElapsed);
    this.defenseRemaining = Math.max(0, snapshot.defenseRemaining);
    Object.assign(this.encounters, cloneEncounters(snapshot.encounters));
    this.checkpoint = snapshot.checkpoint ? cloneCheckpoint(snapshot.checkpoint) : null;
    this.lullRemaining = Math.max(0, snapshot.lullRemaining ?? 0);
    this.hostilesAlive = Math.max(0, Math.floor(snapshot.hostilesAlive ?? 0));
    this.playerHealthFraction = clamp01(snapshot.playerHealthFraction ?? 1);
  }

  /** Unmodulated pressure for the current beat. */
  private baseDirective(): Omit<MissionCombatDirective, 'beat' | 'lullRemaining'> {
    switch (this.beat) {
      case 'insertion':
        return {
          aliveTarget: 4,
          reinforcementDelay: 12,
          aggression: 0.45,
          maxFireSlots: 2,
          allowFlanking: false,
        };
      case 'intersection':
        // Open ground: the squad is allowed to work the flanks here.
        return {
          aliveTarget: 6,
          reinforcementDelay: 10,
          aggression: 0.7,
          maxFireSlots: 3,
          allowFlanking: true,
        };
      case 'jammer':
        return {
          aliveTarget: 6,
          reinforcementDelay: 11,
          aggression: 0.6,
          maxFireSlots: 2,
          allowFlanking: true,
        };
      case 'defense': {
        // Escalate as the clock runs down so the final push is the peak.
        const progress = clamp01(1 - this.defenseRemaining / this.defenseDuration);
        return {
          aliveTarget: 5 + Math.round(progress * 3),
          reinforcementDelay: 8 - progress * 4,
          aggression: 0.65 + progress * 0.35,
          maxFireSlots: 3 + (progress > 0.7 ? 1 : 0),
          allowFlanking: true,
        };
      }
      case 'extraction':
        return {
          aliveTarget: 5,
          reinforcementDelay: 9,
          aggression: 0.85,
          maxFireSlots: 3,
          allowFlanking: true,
        };
      case 'complete':
      case 'failed':
        return {
          aliveTarget: 0,
          reinforcementDelay: 30,
          aggression: 0,
          maxFireSlots: 1,
          allowFlanking: false,
        };
    }
  }

  private saveCheckpoint(
    position: Readonly<Pick<Vector3, 'x' | 'y' | 'z'>>,
  ): MissionCheckpoint {
    this.checkpoint = {
      beat: 'defense',
      playerPosition: { x: position.x, y: position.y, z: position.z },
      elapsed: this.elapsed,
      defenseRemaining: this.defenseDuration,
      encounters: cloneEncounters(this.encounters),
    };
    return this.checkpoint;
  }

  private transition(next: MissionBeat, events: MissionEvent[]): void {
    const previousBeat = this.beat;
    this.beat = next;
    this.beatElapsed = 0;
    this.emit({ type: 'beat-changed', beat: next, previousBeat }, events);
  }

  private fail(events: MissionEvent[]): void {
    this.transition('failed', events);
    this.emit({
      type: 'mission-failed',
      beat: 'failed',
      checkpoint: this.checkpoint ? cloneCheckpoint(this.checkpoint) : undefined,
    }, events);
  }

  private emit(event: MissionEvent, events: MissionEvent[]): void {
    events.push(event);
    this.onEvent?.(event);
  }

  private isTerminal(): boolean {
    return this.beat === 'complete' || this.beat === 'failed';
  }

  private syncEncounterFlags(frame: MissionFrame, events: MissionEvent[]): void {
    const incoming: Array<[keyof EncounterState, boolean | undefined, 'first-contact' | 'intersection' | 'jammer']> = [
      ['firstContactComplete', frame.firstContactComplete, 'first-contact'],
      ['intersectionClear', frame.intersectionClear, 'intersection'],
      ['jammerDisabled', frame.jammerDisabled, 'jammer'],
    ];
    for (const [key, value, encounter] of incoming) {
      if (!value || this.encounters[key]) continue;
      this.encounters[key] = true;
      // Clearing an encounter earns a breather before the next push.
      this.lullRemaining = Math.max(this.lullRemaining, this.encounterLull);
      this.emit({ type: 'encounter-complete', beat: this.beat }, events);
    }
  }

  private inZone(zone: MissionTriggerZone, frame: MissionFrame): boolean {
    if (frame.activeZones?.[zone] !== undefined) return frame.activeZones[zone] === true;
    const trigger = this.zones[zone];
    const dx = frame.playerPosition.x - trigger.x;
    const dz = frame.playerPosition.z - trigger.z;
    return dx * dx + dz * dz <= trigger.radius * trigger.radius;
  }
}

function cloneCheckpoint(value: MissionCheckpoint): MissionCheckpoint {
  return {
    beat: value.beat,
    playerPosition: { ...value.playerPosition },
    elapsed: value.elapsed,
    defenseRemaining: value.defenseRemaining,
    encounters: cloneEncounters(value.encounters),
  };
}

function cloneEncounters(value: EncounterState): EncounterState {
  return { ...value };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

/**
 * Extraction can pause mid-tick while AI / frags still resolve. Combat damage
 * after a terminal beat (or while paused) would overwrite the win overlay and
 * arm a death restore that never ticks.
 */
export function shouldApplyCombatDamage(state: {
  playing: boolean;
  paused: boolean;
  playerDead: boolean;
  beat: MissionBeat;
}): boolean {
  if (!state.playing || state.paused || state.playerDead) return false;
  return state.beat !== 'complete' && state.beat !== 'failed';
}
