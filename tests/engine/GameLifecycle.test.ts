import { describe, expect, it } from 'vitest';
import { GameLifecycle } from '../../src/GameLifecycle';

describe('GameLifecycle', () => {
  it('opens only after loading and simulates only while playing', () => {
    const lifecycle = new GameLifecycle();
    expect(lifecycle.getState()).toBe('loading');
    expect(lifecycle.canSimulate()).toBe(false);
    lifecycle.transition('ready');
    lifecycle.transition('playing');
    expect(lifecycle.canSimulate()).toBe(true);
    lifecycle.transition('paused');
    expect(lifecycle.canSimulate()).toBe(false);
  });

  it('supports failure recovery, completion replay and return to menu', () => {
    const failed = new GameLifecycle();
    failed.transition('ready');
    failed.transition('playing');
    failed.transition('failed');
    failed.transition('playing');
    failed.transition('ready');
    expect(failed.getState()).toBe('ready');

    const completed = new GameLifecycle();
    completed.transition('ready');
    completed.transition('playing');
    completed.transition('completed');
    completed.transition('playing');
    expect(completed.getState()).toBe('playing');
  });

  it('rejects a launch before loading has completed', () => {
    const lifecycle = new GameLifecycle();
    expect(() => lifecycle.transition('playing')).toThrow(/loading -> playing/);
  });

  it('can pause while checkpoint recovery is waiting for pointer lock', () => {
    const lifecycle = new GameLifecycle();
    lifecycle.transition('ready');
    lifecycle.transition('playing');
    lifecycle.transition('failed');
    lifecycle.transition('paused');
    expect(lifecycle.getState()).toBe('paused');
    expect(lifecycle.canSimulate()).toBe(false);
  });
});
