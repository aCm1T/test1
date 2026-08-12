import { test, assert } from 'vitest';
import { TypedEventBus } from '../../src/engine/EventBus.ts';

interface TestEvents {
  damage: { amount: number };
  complete: undefined;
}

test('typed event bus honors priority, stable order, and once listeners', () => {
  const bus = new TypedEventBus<TestEvents>();
  const calls: string[] = [];
  bus.on('damage', () => calls.push('normal-a'));
  bus.once('damage', () => calls.push('once'), { priority: 10 });
  bus.on('damage', () => calls.push('normal-b'));

  assert.equal(bus.emit('damage', { amount: 4 }), 3);
  assert.equal(bus.emit('damage', { amount: 2 }), 2);
  assert.deepEqual(calls, ['once', 'normal-a', 'normal-b', 'normal-a', 'normal-b']);
});

test('removal during emit suppresses a pending listener and abort unsubscribes', () => {
  const bus = new TypedEventBus<TestEvents>();
  const calls: string[] = [];
  const controller = new AbortController();
  const removeLater = bus.on('complete', () => calls.push('later'));
  bus.on('complete', () => {
    calls.push('first');
    removeLater();
  }, { priority: 1 });
  bus.on('complete', () => calls.push('aborted'), { signal: controller.signal });
  controller.abort();

  assert.equal(bus.emit('complete', undefined), 1);
  assert.deepEqual(calls, ['first']);
});

test('listener failures do not prevent the remaining listeners from running', () => {
  const bus = new TypedEventBus<TestEvents>();
  let reached = false;
  bus.on('complete', () => {
    throw new Error('boom');
  });
  bus.on('complete', () => {
    reached = true;
  });
  assert.throws(() => bus.emit('complete', undefined), /boom/);
  assert.equal(reached, true);
});
