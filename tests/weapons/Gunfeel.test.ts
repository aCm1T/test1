import { InstancedMesh, PerspectiveCamera, Scene } from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SeededRandom } from '../../src/mission';
import type { PlayerController } from '../../src/player';
import type { InputFrame } from '../../src/simulation';
import { ViewModel, WeaponSystem } from '../../src/weapons';
import type { WeaponSystemCallbacks } from '../../src/weapons';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('viewmodel recoil spring', () => {
  it('keeps rising after the firing frame, then settles back to rest', () => {
    const viewmodel = createViewModel();

    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    const firstFrame = viewmodel.getRecoilOffset().pitch;
    for (let i = 0; i < 4; i++) viewmodel.update(1 / 60);
    const climbing = viewmodel.getRecoilOffset().pitch;

    // A velocity-driven spring keeps travelling for several frames after the
    // shot. A damped offset would peak on frame one and only ever fall.
    expect(firstFrame).toBeGreaterThan(0);
    expect(climbing).toBeGreaterThan(firstFrame);

    for (let i = 0; i < 120; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getRecoilOffset()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    viewmodel.dispose();
  });

  it('kicks less when aiming than from the hip', () => {
    const hip = createViewModel();
    const ads = createViewModel();

    hip.kickOnFire(1, false);
    ads.kickOnFire(1, true);
    for (let i = 0; i < 5; i++) {
      hip.update(1 / 60);
      ads.update(1 / 60);
    }

    expect(ads.getRecoilOffset().pitch).toBeLessThan(hip.getRecoilOffset().pitch * 0.6);
    hip.dispose();
    ads.dispose();
  });

  it('accumulates muzzle heat over a burst and sheds it on a reload', () => {
    const viewmodel = createViewModel();

    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    const oneShot = viewmodel.getHeat();
    for (let i = 0; i < 6; i++) {
      viewmodel.kickOnFire(1, false);
      viewmodel.update(1 / 60);
    }
    const burst = viewmodel.getHeat();
    expect(burst).toBeGreaterThan(oneShot * 3);
    expect(burst).toBeLessThanOrEqual(1);

    viewmodel.playReload(1.85, true);
    expect(viewmodel.getHeat()).toBe(0);
    expect(viewmodel.isEmptyReload()).toBe(true);
    viewmodel.dispose();
  });

  it('cools back down once the trigger is released', () => {
    const viewmodel = createViewModel();
    for (let i = 0; i < 6; i++) {
      viewmodel.kickOnFire(1, false);
      viewmodel.update(1 / 60);
    }
    const hot = viewmodel.getHeat();
    for (let i = 0; i < 120; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getHeat()).toBeLessThan(hot * 0.2);
    viewmodel.dispose();
  });

  it('distinguishes a dry reload from a tactical one', () => {
    const viewmodel = createViewModel();
    viewmodel.playReload(1.85, false);
    expect(viewmodel.isReloading()).toBe(true);
    expect(viewmodel.isEmptyReload()).toBe(false);
    viewmodel.dispose();
  });
});

describe('viewmodel weapon lag', () => {
  it('trails a fast turn and whips back into line', () => {
    const viewmodel = createViewModel();

    viewmodel.applyLookSway(180, 0);
    viewmodel.update(1 / 60);
    const lag = viewmodel.getLookLag().yaw;
    expect(lag).toBeLessThan(-0.001);

    for (let i = 0; i < 90; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getLookLag()).toEqual({ yaw: 0, pitch: 0 });
    viewmodel.dispose();
  });

  it('suppresses lag while aimed in so the sight picture stays usable', () => {
    const hip = createViewModel();
    const ads = createViewModel();
    ads.setPose('ads');
    for (let i = 0; i < 60; i++) ads.update(1 / 60);
    expect(ads.getAdsBlend()).toBeGreaterThan(0.9);

    hip.applyLookSway(180, 0);
    ads.applyLookSway(180, 0);
    hip.update(1 / 60);
    ads.update(1 / 60);

    expect(Math.abs(ads.getLookLag().yaw)).toBeLessThan(Math.abs(hip.getLookLag().yaw) * 0.5);
    hip.dispose();
    ads.dispose();
  });

  it('ignores non-finite look deltas rather than poisoning the spring', () => {
    const viewmodel = createViewModel();
    viewmodel.applyLookSway(Number.NaN, 12);
    viewmodel.update(1 / 60);
    expect(viewmodel.getLookLag().yaw).toBe(0);
    expect(Number.isFinite(viewmodel.getRecoilOffset().pitch)).toBe(true);
    viewmodel.dispose();
  });
});

describe('viewmodel ADS blend', () => {
  it('blends continuously into the sights and back out again', () => {
    const viewmodel = createViewModel();
    expect(viewmodel.getAdsBlend()).toBe(0);

    viewmodel.setPose('ads');
    viewmodel.update(1 / 60);
    const partial = viewmodel.getAdsBlend();
    expect(partial).toBeGreaterThan(0);
    expect(partial).toBeLessThan(1);

    for (let i = 0; i < 60; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getAdsBlend()).toBeGreaterThan(0.95);

    viewmodel.setPose('hip');
    for (let i = 0; i < 60; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getAdsBlend()).toBeLessThan(0.05);
    viewmodel.dispose();
  });
});

describe('viewmodel rewind snap', () => {
  it('resetPresentation drops kick, heat, brass and ADS blend a same-gun swap would keep', () => {
    const viewmodel = createViewModel();
    viewmodel.setPose('ads');
    for (let i = 0; i < 8; i++) {
      viewmodel.kickOnFire(1, true);
      viewmodel.update(1 / 60);
    }
    expect(viewmodel.getRecoilOffset().pitch).not.toBe(0);
    expect(viewmodel.getHeat()).toBeGreaterThan(0);
    expect(viewmodel.getActiveCasingCount()).toBeGreaterThan(0);
    expect(viewmodel.getAdsBlend()).toBeGreaterThan(0.3);
    expect(viewmodel.muzzleFlash.visible).toBe(true);

    // Rematch stays on the AR, so switchWeapon no-ops and would keep all this.
    viewmodel.switchWeapon('ar');
    expect(viewmodel.getRecoilOffset().pitch).not.toBe(0);
    expect(viewmodel.getHeat()).toBeGreaterThan(0);

    viewmodel.resetPresentation(false);
    expect(viewmodel.getRecoilOffset()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(viewmodel.getLookLag()).toEqual({ yaw: 0, pitch: 0 });
    expect(viewmodel.getHeat()).toBe(0);
    expect(viewmodel.getAdsBlend()).toBe(0);
    expect(viewmodel.getActiveCasingCount()).toBe(0);
    expect(viewmodel.muzzleFlash.visible).toBe(false);
    expect(viewmodel.getPose()).toBe('hip');

    viewmodel.resetPresentation(true);
    expect(viewmodel.getAdsBlend()).toBe(1);
    expect(viewmodel.getPose()).toBe('ads');
    viewmodel.dispose();
  });

  it('weapon reset and restore snap presentation when the AR is already out', () => {
    const test = createWeapon(0x51a9);
    fireShots(test, 4);
    expect(test.weapon.getActiveTracerCount()).toBeGreaterThan(0);
    expect(test.weapon.viewModel.getHeat()).toBeGreaterThan(0);
    expect(test.weapon.viewModel.getRecoilOffset().pitch).not.toBe(0);

    test.weapon.reset();
    expect(test.weapon.getActiveTracerCount()).toBe(0);
    expect(test.weapon.viewModel.getHeat()).toBe(0);
    expect(test.weapon.viewModel.getRecoilOffset()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    expect(test.weapon.viewModel.getAdsBlend()).toBe(0);
    test.weapon.dispose();

    const restore = createWeapon(0x51aa);
    const cold = restore.weapon.snapshotState();
    fireShots(restore, 3);
    expect(restore.weapon.getActiveTracerCount()).toBeGreaterThan(0);
    restore.weapon.restoreState(cold);
    expect(restore.weapon.getActiveTracerCount()).toBe(0);
    expect(restore.weapon.viewModel.getHeat()).toBe(0);
    expect(restore.weapon.viewModel.getRecoilOffset()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    restore.weapon.dispose();
  });
});

describe('viewmodel shell ejection', () => {
  it('throws brass on every shot and recycles the pool', () => {
    const viewmodel = createViewModel();
    expect(viewmodel.getActiveCasingCount()).toBe(0);

    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    expect(viewmodel.getActiveCasingCount()).toBe(1);

    for (let i = 0; i < 40; i++) {
      viewmodel.kickOnFire(1, false);
      viewmodel.update(1 / 60);
    }
    // The pool is bounded: a long burst can never allocate without limit.
    expect(viewmodel.getActiveCasingCount()).toBeLessThanOrEqual(8);
    expect(viewmodel.getActiveCasingCount()).toBeGreaterThan(1);

    for (let i = 0; i < 60; i++) viewmodel.update(1 / 60);
    expect(viewmodel.getActiveCasingCount()).toBe(0);
    viewmodel.dispose();
  });

  it('submits the brass pool as one InstancedMesh instead of eight meshes', () => {
    const viewmodel = createViewModel();
    const batch = viewmodel.root.getObjectByName('FallbackShellCasings') as InstancedMesh | null;
    expect(batch).toBeTruthy();
    expect(batch!.isInstancedMesh).toBe(true);
    expect(batch!.count).toBe(0);

    let perSlotMeshes = 0;
    viewmodel.root.traverse((node) => {
      if (/^FallbackShellCasing\d+$/.test(node.name)) perSlotMeshes += 1;
    });
    expect(perSlotMeshes).toBe(0);

    for (let i = 0; i < 8; i++) {
      viewmodel.kickOnFire(1, false);
      viewmodel.update(1 / 60);
    }
    expect(viewmodel.getActiveCasingCount()).toBeGreaterThan(1);
    // Burst fire still pays one colour submission for the whole pool.
    expect(batch!.count).toBe(8);
    expect(viewmodel.root.getObjectByName('FallbackShellCasings')).toBe(batch);
    viewmodel.dispose();
  });

  it('drops brass from a weapon swap so it cannot follow the new weapon', () => {
    const viewmodel = createViewModel();
    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    expect(viewmodel.getActiveCasingCount()).toBe(1);

    viewmodel.switchWeapon('pistol');
    expect(viewmodel.getActiveCasingCount()).toBe(0);
    const batch = viewmodel.root.getObjectByName('FallbackShellCasings') as InstancedMesh;
    expect(batch.count).toBe(0);
    expect(viewmodel.getHeat()).toBe(0);
    expect(viewmodel.getRecoilOffset()).toEqual({ pitch: 0, yaw: 0, roll: 0 });
    viewmodel.dispose();
  });

  it('never ejects fallback brass for the knife', () => {
    const viewmodel = createViewModel();
    viewmodel.switchWeapon('knife');
    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    expect(viewmodel.getActiveCasingCount()).toBe(0);
    viewmodel.dispose();
  });
});

describe('weapon recoil pattern', () => {
  it('walks a repeatable pattern that resets after the trigger rests', () => {
    const test = createWeapon(0xa11ce);
    fireShots(test, 5);
    expect(test.weapon.snapshotState().recoilShotIndex).toBe(5);

    // Letting go long enough re-centres the pattern on its first round.
    test.weapon.setSessionInput(inputFrame());
    for (let i = 0; i < 10; i++) test.weapon.update(0.05, test.scene, []);
    expect(test.weapon.snapshotState().recoilShotIndex).toBe(0);
    test.weapon.dispose();
  });

  it('produces the same recoil walk for the same seed and diverges on another', () => {
    const a = createWeapon(0xbeef);
    const b = createWeapon(0xbeef);
    const c = createWeapon(0xfeed);
    fireShots(a, 6);
    fireShots(b, 6);
    fireShots(c, 6);

    expect(a.punches).toEqual(b.punches);
    expect(a.punches).not.toEqual(c.punches);
    // Recoil climbs over the opening rounds instead of repeating one kick.
    expect(a.punches[5].pitch).toBeGreaterThan(a.punches[0].pitch);
    a.weapon.dispose();
    b.weapon.dispose();
    c.weapon.dispose();
  });

  it('reports a camera punch alongside every shot, larger than the aim punch', () => {
    const test = createWeapon(7);
    fireShots(test, 1);
    expect(test.punches).toHaveLength(1);
    expect(test.punches[0].pitch)
      .toBeGreaterThan(test.weapon.getRecoilPunch().pitch);
    test.weapon.dispose();
  });
});

describe('weapon spread bloom', () => {
  it('blooms with sustained fire and recovers when the trigger rests', () => {
    const test = createWeapon(31);
    const base = test.weapon.getCurrentSpread();
    expect(test.weapon.getSpreadBloom()).toBe(0);

    fireShots(test, 8);
    const bloomed = test.weapon.getCurrentSpread();
    expect(test.weapon.getSpreadBloom()).toBeGreaterThan(0.12);
    expect(bloomed).toBeGreaterThan(base * 1.15);

    test.weapon.setSessionInput(inputFrame());
    for (let i = 0; i < 60; i++) test.weapon.update(0.05, test.scene, []);
    expect(test.weapon.getSpreadBloom()).toBeLessThan(0.01);
    expect(test.weapon.getCurrentSpread()).toBeCloseTo(base, 5);
    test.weapon.dispose();
  });

  it('clears bloom and the pattern on a reload', () => {
    const test = createWeapon(37);
    fireShots(test, 6);
    expect(test.weapon.getSpreadBloom()).toBeGreaterThan(0);

    test.weapon.startReload();
    expect(test.weapon.getSpreadBloom()).toBe(0);
    expect(test.weapon.snapshotState().recoilShotIndex).toBe(0);
    test.weapon.dispose();
  });

  it('round-trips pattern position and bloom through a snapshot', () => {
    const test = createWeapon(41);
    fireShots(test, 4);
    const snapshot = test.weapon.snapshotState();
    expect(snapshot.spreadBloom).toBeGreaterThan(0);
    expect(snapshot.recoilShotIndex).toBe(4);

    for (let i = 0; i < 20; i++) test.weapon.update(0.05, test.scene, []);
    test.weapon.restoreState(snapshot);
    expect(test.weapon.snapshotState()).toEqual(snapshot);
    test.weapon.dispose();
  });

  it('does not keep live bloom when restoring a cold snapshot without spread', () => {
    const test = createWeapon(43);
    fireShots(test, 5);
    expect(test.weapon.getSpreadBloom()).toBeGreaterThan(0);
    const cold = test.weapon.snapshotState();
    cold.recoilShotIndex = 0;
    cold.recoilPatternTimer = 0;
    cold.spreadBloom = 0;
    fireShots(test, 3);
    expect(test.weapon.snapshotState().recoilShotIndex).toBeGreaterThan(0);
    expect(test.weapon.getSpreadBloom()).toBeGreaterThan(0);

    // Explicit fields win — mirrors GameWorld restore not spreading live state.
    test.weapon.restoreState(cold);
    expect(test.weapon.snapshotState().recoilShotIndex).toBe(0);
    expect(test.weapon.snapshotState().recoilPatternTimer).toBe(0);
    expect(test.weapon.getSpreadBloom()).toBe(0);
    test.weapon.dispose();
  });
});

describe('reload weight', () => {
  it('costs the bolt-release beat when the weapon runs dry', () => {
    const tactical = createWeapon(51);
    const dry = createWeapon(51);
    setAmmo(tactical, 12, 90);
    setAmmo(dry, 0, 90);

    tactical.weapon.startReload();
    dry.weapon.startReload();

    const tacticalTime = tactical.weapon.snapshotState().reloadTimer;
    const dryTime = dry.weapon.snapshotState().reloadTimer;
    expect(dryTime).toBeGreaterThan(tacticalTime);
    expect(tactical.reloads).toEqual([{ weapon: 'ar', empty: false }]);
    expect(dry.reloads).toEqual([{ weapon: 'ar', empty: true }]);
    tactical.weapon.dispose();
    dry.weapon.dispose();
  });

  it('drops out of the sights while reloading', () => {
    const test = createWeapon(53);
    test.weapon.setToggleADS(true);
    test.weapon.setSessionInput(inputFrame({ aim: true, aimPressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.isADS()).toBe(true);

    setAmmo(test, 5, 90);
    test.weapon.startReload();
    test.weapon.setSessionInput(inputFrame({ aim: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.isADS()).toBe(false);
    test.weapon.dispose();
  });
});

describe('dry fire', () => {
  it('clicks once per trigger pull when the weapon is truly empty', () => {
    const test = createWeapon(61);
    setAmmo(test, 0, 0);

    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.dryFires).toEqual(['ar']);

    // Holding a dead trigger must not machine-gun the click.
    for (let i = 0; i < 10; i++) test.weapon.update(1 / 60, test.scene, []);
    expect(test.dryFires).toHaveLength(1);
    expect(test.weapon.getShotRecords()).toHaveLength(0);
    expect(test.weapon.isReloading()).toBe(false);

    test.weapon.setSessionInput(inputFrame());
    test.weapon.update(1 / 60, test.scene, []);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.dryFires).toHaveLength(2);
    test.weapon.dispose();
  });

  it('stays silent while ammunition remains in reserve', () => {
    const test = createWeapon(67);
    setAmmo(test, 0, 90);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.dryFires).toEqual([]);
    expect(test.weapon.isReloading()).toBe(true);
    test.weapon.dispose();
  });
});

describe('tracers', () => {
  it('spawns a travelling streak that expires on its own', () => {
    const test = createWeapon(71);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveTracerCount()).toBe(1);

    test.weapon.setSessionInput(inputFrame());
    for (let i = 0; i < 5; i++) test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveTracerCount()).toBe(1);

    for (let i = 0; i < 40; i++) test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveTracerCount()).toBe(0);
    test.weapon.dispose();
  });

  it('releases every live streak on dispose', () => {
    const test = createWeapon(73);
    fireShots(test, 3);
    expect(test.weapon.getActiveTracerCount()).toBeGreaterThan(0);
    test.weapon.dispose();
    expect(test.weapon.getActiveTracerCount()).toBe(0);
  });

  it('reuses a fixed tracer pool across repeated bursts', () => {
    const test = createWeapon(79);
    test.weapon.setSessionInput(inputFrame());
    test.weapon.update(1 / 60, test.scene, []);
    const pooled = test.scene.children.filter((child) => child.name.startsWith('TracerPool:'));
    expect(pooled).toHaveLength(12);

    for (let burst = 0; burst < 3; burst += 1) {
      fireShots(test, (burst + 1) * 8);
      test.weapon.setSessionInput(inputFrame());
      for (let frame = 0; frame < 40; frame += 1) {
        test.weapon.update(1 / 60, test.scene, []);
      }
    }

    expect(test.scene.children.filter((child) => child.name.startsWith('TracerPool:'))).toEqual(pooled);
    expect(test.weapon.getActiveTracerCount()).toBe(0);
    test.weapon.dispose();
    expect(test.scene.children.filter((child) => child.name.startsWith('TracerPool:'))).toHaveLength(0);
  });
});

interface WeaponTest {
  weapon: WeaponSystem;
  scene: Scene;
  punches: { pitch: number; yaw: number; roll: number }[];
  reloads: { weapon: string; empty: boolean }[];
  dryFires: string[];
}

function createViewModel(): ViewModel {
  return new ViewModel(new PerspectiveCamera(58, 16 / 9, 0.01, 8), new Scene(), () => 0.5);
}

function createWeapon(seed: number): WeaponTest {
  const camera = new PerspectiveCamera();
  camera.position.set(1, 2, 3);
  camera.lookAt(1, 2, 2);
  camera.updateMatrixWorld(true);
  const player = {
    isADSHeld: () => false,
    isSprinting: () => false,
    isMoving: () => false,
    isDead: () => false,
    isPointerLocked: () => true,
    isFireHeld: () => false,
    addLookDelta: () => {},
  } as unknown as PlayerController;

  const punches: WeaponTest['punches'] = [];
  const reloads: WeaponTest['reloads'] = [];
  const dryFires: string[] = [];
  const callbacks: WeaponSystemCallbacks = {
    onViewPunch: (pitch, yaw, roll) => punches.push({ pitch, yaw, roll }),
    onReload: (weapon, empty) => reloads.push({ weapon, empty }),
    onDryFire: (weapon) => dryFires.push(weapon),
  };

  return {
    scene: new Scene(),
    punches,
    reloads,
    dryFires,
    weapon: new WeaponSystem({
      player,
      camera,
      viewModelScene: new Scene(),
      random: new SeededRandom(seed),
      presentationRandom: () => 0.5,
      callbacks,
    }),
  };
}

/** Drives fixed ticks with the trigger held until `count` rounds have left. */
function fireShots(test: WeaponTest, count: number): void {
  test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
  for (let i = 0; i < count * 8 && test.weapon.getShotRecords().length < count; i++) {
    test.weapon.update(0.05, test.scene, []);
  }
  if (test.weapon.getShotRecords().length < count) {
    throw new Error(`only fired ${test.weapon.getShotRecords().length} of ${count} rounds`);
  }
}

function setAmmo(test: WeaponTest, mag: number, reserve: number): void {
  const snapshot = test.weapon.snapshotState();
  test.weapon.restoreState({
    ...snapshot,
    ammo: {
      ar: { ...snapshot.ammo.ar, mag, reserve },
      pistol: { ...snapshot.ammo.pistol },
    },
  });
}

function inputFrame(overrides: Partial<InputFrame> = {}): InputFrame {
  return {
    moveX: 0,
    moveY: 0,
    lookX: 0,
    lookY: 0,
    fire: false,
    firePressed: false,
    aim: false,
    aimPressed: false,
    reload: false,
    grenade: false,
    interact: false,
    jump: false,
    crouch: false,
    sprint: false,
    weaponCycle: 0,
    ...overrides,
  };
}
