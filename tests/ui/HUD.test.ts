import { describe, expect, it } from 'vitest';
import {
  CROSSHAIR_SPREAD_RAD_TO_PX,
  INTERACT_PROMPT_KEYS,
  angularSpreadToCrosshairPx,
  formatInteractPrompt,
  resolveDeathRestoreSubtitle,
  resolveMissionInteractPrompt,
} from '../../src/ui';

describe('crosshair spread mapping', () => {
  it('scales angular weapon spread into a readable pixel gap', () => {
    const hipIdle = 0.022;
    const hipBloomed = hipIdle * (1 + 1.7);
    const adsIdle = 0.0026;

    const idlePx = angularSpreadToCrosshairPx(hipIdle);
    const bloomPx = angularSpreadToCrosshairPx(hipBloomed);
    const adsPx = angularSpreadToCrosshairPx(adsIdle);

    expect(idlePx).toBeCloseTo(hipIdle * CROSSHAIR_SPREAD_RAD_TO_PX, 5);
    expect(bloomPx).toBeGreaterThan(idlePx * 1.5);
    expect(adsPx).toBeLessThan(idlePx * 0.2);
  });

  it('returns zero for melee / non-finite cones so the HUD floor can clamp', () => {
    expect(angularSpreadToCrosshairPx(0)).toBe(0);
    expect(angularSpreadToCrosshairPx(-1)).toBe(0);
    expect(angularSpreadToCrosshairPx(Number.NaN)).toBe(0);
  });
});

describe('interact prompt keys', () => {
  it('advertises both E and F so HUD and objective stay aligned', () => {
    expect(INTERACT_PROMPT_KEYS).toBe('E/F');
    const markup = formatInteractPrompt('DISABLE SIGNAL JAMMER');
    expect(markup).toContain('<kbd>E</kbd>');
    expect(markup).toContain('<kbd>F</kbd>');
    expect(markup).toContain('DISABLE SIGNAL JAMMER');
    expect(formatInteractPrompt('<script>')).toContain('&lt;script&gt;');
  });
});

describe('mission interact slot priority', () => {
  it('lets jammer interact beat an active wave toast', () => {
    expect(
      resolveMissionInteractPrompt({
        jammerInteractAvailable: true,
        waveToastRemaining: 2.4,
      }),
    ).toBe('DISABLE SIGNAL JAMMER');
  });

  it('keeps the wave toast while the timer runs and no interact is available', () => {
    expect(
      resolveMissionInteractPrompt({
        jammerInteractAvailable: false,
        waveToastRemaining: 1.1,
      }),
    ).toBe('INCOMING — HOSTILES REINFORCING');
  });

  it('clears the shared slot once toast and interact are both idle', () => {
    expect(
      resolveMissionInteractPrompt({
        jammerInteractAvailable: false,
        waveToastRemaining: 0,
      }),
    ).toBeNull();
  });
});

describe('death restore subtitle', () => {
  it('claims checkpoint restore only when a checkpoint exists', () => {
    expect(resolveDeathRestoreSubtitle(true)).toBe('Restoring the last secure checkpoint.');
    expect(resolveDeathRestoreSubtitle(false)).toBe('Restarting Operation Nightglass.');
    expect(resolveDeathRestoreSubtitle(false)).not.toMatch(/checkpoint/i);
  });
});
