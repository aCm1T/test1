import { readFileSync } from 'node:fs';
import path from 'node:path';
import { InstancedMesh, Scene, Vector3 } from 'three';
import { beforeAll, describe, expect, it } from 'vitest';
import { DecalManager, VFXManager } from '../../src/vfx';

/**
 * Particle and decal constructors paint CanvasTextures. Vitest's Node
 * environment has no document, so this stub only has to survive construction.
 */
function installCanvasStub(): void {
  const scope = globalThis as typeof globalThis & { document?: Document };
  if (typeof scope.document?.createElement === 'function') return;
  const gradient = { addColorStop() {} };
  const ctx = {
    createRadialGradient: () => gradient,
    fillRect() {},
    clearRect() {},
    beginPath() {},
    arc() {},
    fill() {},
    stroke() {},
    moveTo() {},
    lineTo() {},
    closePath() {},
    fillStyle: '',
    strokeStyle: '',
    lineWidth: 1,
    globalAlpha: 1,
  };
  scope.document = {
    createElement(tag: string) {
      if (tag !== 'canvas') throw new Error(`unexpected element: ${tag}`);
      return {
        width: 0,
        height: 0,
        getContext: (type: string) => (type === '2d' ? ctx : null),
      };
    },
  } as unknown as Document;
}

function liveDecalBatches(root: Scene['children'][number]): number {
  let live = 0;
  root.traverse((node) => {
    const mesh = node as InstancedMesh;
    if (!mesh.isInstancedMesh) return;
    if (mesh.count > 0) live += 1;
  });
  return live;
}

describe('combat FX rewind', () => {
  beforeAll(() => {
    installCanvasStub();
  });

  it('drops muzzle, impact, blood and explosion particles without touching motes', () => {
    const scene = new Scene();
    const vfx = new VFXManager(scene);
    const origin = new Vector3(0, 1.2, -2);
    const forward = new Vector3(0, 0, -1);
    const up = new Vector3(0, 1, 0);

    vfx.spawnMuzzleFlash(origin, forward);
    vfx.spawnImpact(origin, up, 'concrete');
    vfx.spawnBlood(origin, forward);
    vfx.spawnExplosion(origin, 1);
    vfx.spawnSmoke(origin, 6, 0.4);

    expect(vfx.muzzle.object.visible).toBe(true);
    expect(vfx.impact.object.visible).toBe(true);
    expect(vfx.blood.object.visible).toBe(true);
    expect(vfx.smoke.object.visible).toBe(true);
    expect(vfx.explosion.objects.some((points) => points.visible)).toBe(true);

    vfx.clearCombat();

    expect(vfx.muzzle.object.visible).toBe(false);
    expect(vfx.impact.object.visible).toBe(false);
    expect(vfx.debris.object.visible).toBe(false);
    expect(vfx.smoke.object.visible).toBe(false);
    expect(vfx.blood.object.visible).toBe(false);
    expect(vfx.explosion.objects.every((points) => !points.visible)).toBe(true);
    expect(vfx.motes.points.visible).toBe(true);

    vfx.spawnMuzzleFlash(origin, forward);
    expect(vfx.muzzle.object.visible).toBe(true);
    vfx.dispose();
  });

  it('hides every live bullet-hole batch so a rewind cannot keep 45s impacts', () => {
    const scene = new Scene();
    const decals = new DecalManager(scene);
    expect(decals.spawnAt(new Vector3(1, 1, -4), new Vector3(0, 0, 1), 0.1, 'concrete')).toBe(true);
    expect(liveDecalBatches(decals.root)).toBeGreaterThan(0);

    decals.clear();
    expect(liveDecalBatches(decals.root)).toBe(0);

    expect(decals.spawnAt(new Vector3(2, 1, -4), new Vector3(0, 1, 0), 0.1, 'metal')).toBe(true);
    expect(liveDecalBatches(decals.root)).toBeGreaterThan(0);
    decals.dispose();
  });

  it('rewinds combat FX on death restore, rematch, session restore and QA reset', () => {
    const src = readFileSync(path.join(process.cwd(), 'src/main.ts'), 'utf8');
    const helper = src.slice(
      src.indexOf('private rewindCombatFx'),
      src.indexOf('private resetRunToOpening'),
    );
    expect(helper).toContain('this.vfx.clearCombat()');
    expect(helper).toContain('this.decals.clear()');

    const death = src.slice(
      src.indexOf('private updateDeathRestore'),
      src.indexOf('private restoreSimulationClock'),
    );
    const rematch = src.slice(
      src.indexOf('private resetRunToOpening'),
      src.indexOf('private syncAmmoHud'),
    );
    const session = src.slice(
      src.indexOf('private restoreSessionWorld'),
      src.indexOf('private handleSessionEvent'),
    );
    const qa = src.slice(
      src.indexOf('private qaResetPresentation'),
      src.indexOf('private qaSetCaptureState'),
    );
    expect(death).toContain('this.rewindCombatFx()');
    expect(rematch).toContain('this.rewindCombatFx()');
    expect(session).toContain('this.rewindCombatFx()');
    expect(qa).toContain('this.rewindCombatFx()');
  });
});
