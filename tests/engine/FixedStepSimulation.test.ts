import { test, assert } from 'vitest';
import { FixedStepSimulation } from '../../src/engine/FixedStepSimulation.ts';

test('fixed simulation is invariant to render-frame subdivision', () => {
  const coarse = new FixedStepSimulation();
  const fine = new FixedStepSimulation();
  const coarseTicks: number[] = [];
  const fineTicks: number[] = [];

  for (let frame = 0; frame < 60; frame += 1) {
    coarse.advance(1 / 60, (_dt, tick) => coarseTicks.push(tick));
  }
  for (let frame = 0; frame < 120; frame += 1) {
    fine.advance(1 / 120, (_dt, tick) => fineTicks.push(tick));
  }

  assert.equal(coarse.tick, 60);
  assert.equal(fine.tick, 60);
  assert.deepEqual(fineTicks, coarseTicks);
});

test('sub-step cap drops only whole backlog steps and preserves interpolation', () => {
  const simulation = new FixedStepSimulation({
    stepSeconds: 0.1,
    maxFrameDeltaSeconds: 1,
    maxSubSteps: 2,
  });

  const frame = simulation.advance(0.55, () => undefined);
  assert.equal(frame.steps, 2);
  assert.ok(Math.abs(frame.droppedSeconds - 0.3) < 1e-9);
  assert.ok(Math.abs(frame.interpolationAlpha - 0.5) < 1e-9);
  assert.equal(frame.tick, 2);
});

test('pause, time scale, manual steps, and reset are explicit', () => {
  const simulation = new FixedStepSimulation({
    stepSeconds: 0.25,
    maxFrameDeltaSeconds: 0.5,
  });
  simulation.setPaused(true);
  assert.equal(simulation.advance(1, () => assert.fail('paused update')).steps, 0);

  simulation.setPaused(false);
  simulation.setTimeScale(0.5);
  assert.equal(simulation.advance(0.5, () => undefined).steps, 1);
  simulation.runSteps(3, () => undefined);
  assert.equal(simulation.tick, 4);
  simulation.reset(10);
  assert.equal(simulation.tick, 10);
  assert.equal(simulation.interpolationAlpha, 0);
});

test('reset rewinds tick for checkpoint / QA restore clock sync', () => {
  const simulation = new FixedStepSimulation({ stepSeconds: 1 / 60 });
  simulation.runSteps(90, () => undefined);
  assert.equal(simulation.tick, 90);
  simulation.reset(40);
  assert.equal(simulation.tick, 40);
  assert.equal(simulation.simulatedSeconds, 40 / 60);
  assert.equal(simulation.interpolationAlpha, 0);
});

test('reset during advance aborts leftover hitch catch-up substeps', () => {
  // Mirrors death restore: updateDeathRestore → restoreSimulationClock → reset
  // runs inside gameSession.step inside advance(). Without abort, remaining
  // maxSubSteps keep advancing the restored checkpoint (blur hitch dependent).
  const simulation = new FixedStepSimulation({
    stepSeconds: 0.1,
    maxFrameDeltaSeconds: 1,
    maxSubSteps: 6,
  });
  simulation.runSteps(40, () => undefined);
  assert.equal(simulation.tick, 40);

  const ticks: number[] = [];
  const frame = simulation.advance(0.55, (_dt, tick) => {
    ticks.push(tick);
    if (ticks.length === 1) simulation.reset(40);
  });

  assert.deepEqual(ticks, [41]);
  assert.equal(frame.steps, 1);
  assert.equal(simulation.tick, 40);
  assert.equal(simulation.interpolationAlpha, 0);
});

test('pause during advance aborts leftover hitch catch-up substeps', () => {
  // Mirrors extract: mission-complete → setPaused(true) inside a fixed update.
  // Without abort, hitch leftover keeps simulating after the win overlay.
  const simulation = new FixedStepSimulation({
    stepSeconds: 0.1,
    maxFrameDeltaSeconds: 1,
    maxSubSteps: 6,
  });

  const ticks: number[] = [];
  const frame = simulation.advance(0.55, (_dt, tick) => {
    ticks.push(tick);
    if (ticks.length === 1) simulation.setPaused(true);
  });

  assert.deepEqual(ticks, [1]);
  assert.equal(frame.steps, 1);
  assert.equal(simulation.tick, 1);
  assert.equal(simulation.advance(1, () => assert.fail('paused update')).steps, 0);
});
