import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';

describe('release readiness script', () => {
  it('fail-closes qa:release while source assets are empty and never invents a pass', () => {
    const result = spawnSync(process.execPath, ['scripts/verify-release-readiness.mjs'], {
      cwd: process.cwd(),
      encoding: 'utf8',
      env: process.env,
    });

    expect(result.status).toBe(1);
    const combined = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
    expect(combined).toMatch(/asset release gate: BLOCKED/i);
    expect(combined).toMatch(/0 of 12 legal matched references/i);
    expect(combined).toMatch(/WOULD REFUSE/i);
    expect(combined).toMatch(/capture-matrix[\s\S]*NOT EVIDENCED/i);
    expect(combined).toMatch(/performance[\s\S]*NOT EVIDENCED/i);
    expect(combined).toMatch(/blind-review[\s\S]*NOT EVIDENCED/i);
    expect(combined).toMatch(/release readiness: BLOCKED/i);
    expect(combined).not.toMatch(/release readiness: PASS/i);
  });
});
