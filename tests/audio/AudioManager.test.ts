import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AudioManager } from '../../src/audio/AudioManager';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('procedural audio buffers', () => {
  it('builds each noise shape once and reuses it across automatic fire', () => {
    const presentationRandom = vi.fn(() => 0.5);
    const audio = new AudioManager({ random: presentationRandom });
    const createBuffer = vi.fn((_channels: number, length: number) => {
      const samples = new Float32Array(length);
      return { getChannelData: () => samples };
    });
    Object.assign(audio, {
      ctx: {
        sampleRate: 48_000,
        createBuffer,
        close: vi.fn(),
      },
    });
    const noise = audio as unknown as {
      createNoiseBuffer(duration: number, type: 'white' | 'brown'): AudioBuffer;
    };

    const first = noise.createNoiseBuffer(0.85, 'brown');
    const second = noise.createNoiseBuffer(0.85, 'brown');
    const crack = noise.createNoiseBuffer(0.12, 'white');

    expect(second).toBe(first);
    expect(crack).not.toBe(first);
    expect(createBuffer).toHaveBeenCalledTimes(2);
    expect(presentationRandom).not.toHaveBeenCalled();
    audio.dispose();
  });
});
