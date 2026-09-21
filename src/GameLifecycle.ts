export type GameLifecycleState =
  | 'loading'
  | 'ready'
  | 'playing'
  | 'paused'
  | 'failed'
  | 'completed';

const ALLOWED_TRANSITIONS: Record<GameLifecycleState, readonly GameLifecycleState[]> = {
  loading: ['ready'],
  ready: ['playing'],
  playing: ['paused', 'failed', 'completed', 'ready'],
  paused: ['playing', 'ready'],
  failed: ['playing', 'paused', 'ready'],
  completed: ['playing', 'ready'],
};

/** Small, fail-closed lifecycle authority shared by input, HUD and combat. */
export class GameLifecycle {
  private state: GameLifecycleState = 'loading';

  getState(): GameLifecycleState {
    return this.state;
  }

  is(state: GameLifecycleState): boolean {
    return this.state === state;
  }

  canSimulate(): boolean {
    return this.state === 'playing' || this.state === 'failed';
  }

  acceptsCombat(): boolean {
    return this.state === 'playing';
  }

  transition(next: GameLifecycleState): void {
    if (next === this.state) return;
    if (!ALLOWED_TRANSITIONS[this.state].includes(next)) {
      throw new Error(`Invalid game lifecycle transition: ${this.state} -> ${next}`);
    }
    this.state = next;
  }
}
