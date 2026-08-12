import { PerspectiveCamera } from 'three';
import { describe, expect, it } from 'vitest';
import { CameraFeel } from '../../src/player';
import type { PlayerController } from '../../src/player';

const EYE = 1.62;
const BASE_PITCH = -0.15;

describe('CameraFeel view punch', () => {
  it('kicks the view, overshoots, and settles back onto the player aim angle', () => {
    const { feel, camera } = createFeel();

    feel.addViewPunch(0.03, 0.01, 0.02);
    step(feel, 1);
    const firstFrame = feel.getViewPunch().pitch;
    step(feel, 3);
    const rising = feel.getViewPunch().pitch;

    // A spring keeps climbing for several frames; a damped offset would only
    // ever decay from its first value.
    expect(firstFrame).toBeGreaterThan(0);
    expect(rising).toBeGreaterThan(firstFrame);

    step(feel, 180);
    expect(feel.getViewPunch()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    // The punch must not leave a permanent bias on the aim it borrowed. The
    // residual is idle breath only, an order of magnitude under the kick.
    expect(Math.abs(camera.rotation.x - BASE_PITCH)).toBeLessThan(0.002);
    expect(camera.rotation.y).toBe(0);
  });

  it('stacks successive shots into a larger kick than a single round', () => {
    const single = createFeel();
    const burst = createFeel();

    single.feel.addViewPunch(0.03);
    step(single.feel, 4);

    for (let i = 0; i < 4; i++) {
      burst.feel.addViewPunch(0.03);
      step(burst.feel, 1);
    }

    expect(burst.feel.getViewPunch().pitch)
      .toBeGreaterThan(single.feel.getViewPunch().pitch);
  });

  it('scales impulses down under reduced motion', () => {
    const normal = createFeel();
    const reduced = createFeel();
    reduced.feel.setReducedMotion(true);

    normal.feel.addViewPunch(0.04);
    reduced.feel.addViewPunch(0.04);
    step(normal.feel, 3);
    step(reduced.feel, 3);

    expect(reduced.feel.getViewPunch().pitch)
      .toBeLessThan(normal.feel.getViewPunch().pitch * 0.5);
  });
});

describe('CameraFeel traversal feedback', () => {
  it('drops and widens the view while sliding, then restores it', () => {
    const { feel, camera, player } = createFeel();
    step(feel, 30);
    const standingY = camera.position.y;
    const standingFov = camera.fov;

    player.slideSpeed = 10.2;
    player.sliding = true;
    step(feel, 20);

    expect(camera.position.y).toBeLessThan(standingY - 0.02);
    expect(camera.fov).toBeGreaterThan(standingFov + 1);
    expect(feel.getSlideBlend()).toBeGreaterThan(0.8);

    player.sliding = false;
    step(feel, 120);
    expect(feel.getSlideBlend()).toBeLessThan(0.02);
    expect(Math.abs(camera.position.y - EYE)).toBeLessThan(0.01);
    expect(camera.fov).toBeCloseTo(standingFov, 1);
  });

  it('consumes each slide latch exactly once', () => {
    const { feel, player } = createFeel();
    player.slideSpeed = 10.2;
    step(feel, 1);
    const afterFirst = Math.abs(feel.getViewPunch().pitch);
    expect(afterFirst).toBeGreaterThan(0);
    expect(player.slideConsumed).toBe(1);

    step(feel, 1);
    expect(player.slideConsumed).toBe(1);
  });

  it('surges the view upward on a mantle proportionally to ledge height', () => {
    const low = createFeel();
    const high = createFeel();
    low.player.mantleHeight = 0.45;
    high.player.mantleHeight = 1.25;

    step(low.feel, 4);
    step(high.feel, 4);

    // A mantle pitches the view down as the operator pulls up over the ledge.
    expect(high.feel.getViewPunch().pitch).toBeLessThan(low.feel.getViewPunch().pitch);
    expect(high.camera.position.y).toBeGreaterThan(low.camera.position.y);

    step(high.feel, 200);
    expect(Math.abs(high.camera.position.y - EYE)).toBeLessThan(0.01);
  });

  it('attenuates blast shake with distance from the detonation', () => {
    const near = createFeel();
    const far = createFeel();

    near.feel.notifyExplosion(0.5, 6.5);
    far.feel.notifyExplosion(5.5, 6.5);
    step(near.feel, 3);
    step(far.feel, 3);

    expect(near.feel.getViewPunch().pitch)
      .toBeGreaterThan(far.feel.getViewPunch().pitch * 3);

    // Beyond the blast radius nothing is felt at all.
    const outside = createFeel();
    outside.feel.notifyExplosion(9, 6.5);
    step(outside.feel, 3);
    expect(outside.feel.getViewPunch().pitch).toBe(0);
  });
});

interface StubPlayer {
  sliding: boolean;
  slideSpeed: number;
  mantleHeight: number;
  slideConsumed: number;
}

function createFeel(): {
  feel: CameraFeel;
  camera: PerspectiveCamera;
  player: StubPlayer;
} {
  const camera = new PerspectiveCamera(75, 16 / 9, 0.05, 1200);
  const state: StubPlayer = {
    sliding: false,
    slideSpeed: 0,
    mantleHeight: 0,
    slideConsumed: 0,
  };
  const player = {
    consumeDamagePulse: () => 0,
    justDidLand: () => false,
    getLandImpact: () => 0,
    consumeSlideStart: () => {
      const value = state.slideSpeed;
      if (value > 0) state.slideConsumed += 1;
      state.slideSpeed = 0;
      return value;
    },
    consumeMantle: () => {
      const value = state.mantleHeight;
      state.mantleHeight = 0;
      return value;
    },
    isSliding: () => state.sliding,
    getEyeHeight: () => EYE,
    getPitch: () => BASE_PITCH,
  } as unknown as PlayerController;

  return { feel: new CameraFeel(camera, player), camera, player: state };
}

function step(feel: CameraFeel, frames: number): void {
  for (let i = 0; i < frames; i++) {
    feel.update(1 / 60, false, false, false, true);
  }
}
