import {
  AnimationClip,
  Bone,
  BoxGeometry,
  Group,
  MeshBasicMaterial,
  Object3D,
  PerspectiveCamera,
  Scene,
  Skeleton,
  SkinnedMesh,
} from 'three';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { SeededRandom } from '../../src/mission';
import type { PlayerController } from '../../src/player';
import type { InputFrame, PhysicsWorld } from '../../src/simulation';
import { ViewModel, WeaponSystem } from '../../src/weapons';

beforeEach(() => {
  vi.stubGlobal('window', new EventTarget());
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/** Geometry in a subtree, which batching redistributes but never changes. */
function triangles(root: Object3D): number {
  let total = 0;
  root.traverse((node) => {
    const geometry = (node as import('three').Mesh).geometry;
    if (!geometry) return;
    const indexed = geometry.index?.count;
    total += (indexed ?? geometry.attributes.position?.count ?? 0) / 3;
  });
  return total;
}

describe('authored weapon presentation', () => {
  it('replaces and restores the camera-visible procedural rifle as one owned visual', () => {
    const scene = new Scene();
    const viewmodel = new ViewModel(new PerspectiveCamera(), scene, () => 0.5);
    const authoredScene = riggedGroup();
    authoredScene.name = 'LicensedRifleAndArms';
    const marker = new Object3D();
    marker.name = 'ADS_RETICLE';
    marker.position.set(0, 0.132, -0.054);
    authoredScene.add(marker);
    const gltf = {
      scene: authoredScene,
      animations: [
        new AnimationClip('idle', 1, []),
        new AnimationClip('reload', 1, []),
        new AnimationClip('fire', 0.1, []),
        new AnimationClip('ads', 1, []),
        new AnimationClip('sprint', 1, []),
        new AnimationClip('melee', 0.3, []),
      ],
    } as GLTF;

    viewmodel.installAuthored(gltf);
    expect(viewmodel.hasAuthoredVisual()).toBe(true);
    expect(viewmodel.root.getObjectByName('AuthoredViewModelRifleArms')).toBeTruthy();
    viewmodel.playReload(1);
    viewmodel.update(1 / 60);

    viewmodel.clearAuthored();
    expect(viewmodel.hasAuthoredVisual()).toBe(false);
    expect(viewmodel.root.getObjectByName('AuthoredViewModelRifleArms')).toBeUndefined();
    expect(viewmodel.root.getObjectByName('FallbackReloadMagazine')?.visible).toBe(false);
    viewmodel.dispose();
  });

  it('measures the procedural benchmark instead of returning hard-coded occupancy/alignment', () => {
    const camera = new PerspectiveCamera(58, 16 / 9, 0.01, 8);
    const viewmodel = new ViewModel(camera, new Scene(), () => 0.5);
    const metrics = viewmodel.getPresentationMetrics();
    expect(metrics).toMatchObject({ adsReticleMarkerPresent: true, sampleValid: true });
    expect(metrics.hipFrameOccupancy).toBeLessThanOrEqual(0.3);
    expect(metrics.adsReticleErrorPixelsAt1080p).toBeLessThanOrEqual(2);
    viewmodel.dispose();
  });

  it('stages a complete fallback reload assembly, then restores every visible mechanism', () => {
    const viewmodel = new ViewModel(new PerspectiveCamera(58, 16 / 9, 0.01, 8), new Scene(), () => 0.5);
    const installed = viewmodel.root.getObjectByName('magazine');
    const carried = viewmodel.root.getObjectByName('FallbackReloadMagazine');
    const supportHand = viewmodel.root.getObjectByName('FallbackSupportHand');
    const chargingHandle = viewmodel.root.getObjectByName('FallbackChargingHandle');
    // The magazine has to be a built assembly rather than a placeholder box.
    // Counting triangles rather than children keeps this independent of how many
    // submissions the batching pass folds that assembly into.
    expect(triangles(installed!)).toBeGreaterThan(100);
    expect(carried).toBeTruthy();
    expect(supportHand).toBeTruthy();
    expect(chargingHandle).toBeTruthy();
    const installedY = installed!.position.y;
    const supportY = supportHand!.position.y;
    const chargingZ = chargingHandle!.position.z;

    viewmodel.playReload(1);
    for (let i = 0; i < 5; i++) viewmodel.update(0.05);
    expect(installed!.position.y).toBeLessThan(installedY - 0.02);
    expect(carried!.visible).toBe(true);
    expect(supportHand!.position.y).toBeLessThan(supportY - 0.02);

    for (let i = 0; i < 11; i++) viewmodel.update(0.05);
    expect(chargingHandle!.position.z).toBeGreaterThan(chargingZ);

    for (let i = 0; i < 5; i++) viewmodel.update(0.05);
    expect(installed!.position.y).toBeCloseTo(installedY, 6);
    expect(carried!.visible).toBe(false);
    // Idle breathing resumes after the reload, but the hand must be back on
    // its grip rather than stranded at the magazine well.
    expect(supportHand!.position.y).toBeCloseTo(supportY, 2);
    viewmodel.dispose();
  });

  it('moves the procedural trigger/firing hand on a shot and lets it recover', () => {
    const viewmodel = new ViewModel(new PerspectiveCamera(58, 16 / 9, 0.01, 8), new Scene(), () => 0.5);
    const trigger = viewmodel.root.getObjectByName('FallbackTriggerFinger');
    const firingHand = viewmodel.root.getObjectByName('FallbackFiringHand');
    expect(trigger).toBeTruthy();
    expect(firingHand).toBeTruthy();
    const triggerX = trigger!.rotation.x;
    const handY = firingHand!.position.y;

    viewmodel.kickOnFire(1, false);
    viewmodel.update(1 / 60);
    expect(trigger!.rotation.x).toBeLessThan(triggerX - 0.02);
    expect(firingHand!.position.y).toBeGreaterThan(handY);

    for (let i = 0; i < 90; i++) viewmodel.update(1 / 60);
    expect(trigger!.rotation.x).toBeCloseTo(triggerX, 4);
    viewmodel.dispose();
  });

  it('rejects an authored rig whose clips or ADS marker cannot prove the contract', () => {
    const viewmodel = new ViewModel(new PerspectiveCamera(58, 1, 0.01, 8), new Scene());
    expect(() => viewmodel.installAuthored({
      scene: riggedGroup(),
      animations: [new AnimationClip('idle', 1, [])],
    } as GLTF)).toThrow(/missing clips/);
    expect(viewmodel.hasAuthoredVisual()).toBe(false);
    viewmodel.dispose();
  });
});

describe('seeded WeaponSystem shots', () => {
  it('records identical tick, seed, origin, direction and hit for identical replay input', () => {
    const first = createWeapon(0x12345678);
    const second = createWeapon(0x12345678);
    first.weapon.setSimulationTick(41);
    second.weapon.setSimulationTick(41);
    first.weapon.update(1 / 60, first.scene, []);
    second.weapon.update(1 / 60, second.scene, []);

    expect(first.weapon.getShotRecords()).toEqual(second.weapon.getShotRecords());
    expect(first.weapon.getShotRecords()[0]).toMatchObject({
      tick: 41,
      weapon: 'ar',
      seed: expect.any(Number),
      hit: null,
    });
    first.weapon.dispose();
    second.weapon.dispose();
  });

  it('keeps the licensed rifle as the only authored camera-visible loadout', () => {
    const test = createWeapon(9);
    test.weapon.setAuthoredRifleOnly(true);
    test.weapon.switchWeapon('pistol');
    expect(test.weapon.getActiveWeapon()).toBe('ar');
    test.weapon.setAuthoredRifleOnly(false);
    test.weapon.switchWeapon('pistol');
    expect(test.weapon.getActiveWeapon()).toBe('pistol');
    test.weapon.dispose();
  });

  it('measures presentation with the origin-relative viewmodel camera, not the world camera', () => {
    const worldCamera = new PerspectiveCamera(90, 16 / 9, 0.05, 1200);
    worldCamera.position.set(80, 12, -40);
    const viewModelCamera = new PerspectiveCamera(58, 16 / 9, 0.01, 8);
    const player = {
      isADSHeld: () => false,
      isSprinting: () => false,
      isMoving: () => false,
      isDead: () => false,
      isPointerLocked: () => false,
      isFireHeld: () => false,
      addLookDelta: () => {},
    } as unknown as PlayerController;
    const weapon = new WeaponSystem({
      player,
      camera: worldCamera,
      viewModelCamera,
      viewModelScene: new Scene(),
    });
    expect(weapon.viewModel.getPresentationMetrics()).toMatchObject({
      sampleValid: true,
      adsReticleMarkerPresent: true,
    });
    expect(weapon.viewModel.getPresentationMetrics().hipFrameOccupancy).toBeLessThanOrEqual(0.3);
    expect(weapon.viewModel.getPresentationMetrics().adsReticleErrorPixelsAt1080p).toBeLessThanOrEqual(2);
    weapon.dispose();
  });

  it('records a Rapier-owned muzzle obstruction before the long-range shot query', () => {
    const castRay = vi.fn((query: Parameters<PhysicsWorld['castRay']>[0]) => (
      query.maxDistance <= 0.55
        ? {
            colliderId: 'authored:cover',
            point: { x: 1, y: 2, z: 2.7 },
            normal: { x: 0, y: 0, z: 1 },
            distance: 0.3,
            surface: 'concrete' as const,
          }
        : null
    ));
    const test = createWeapon(11, { castRay } as unknown as PhysicsWorld);
    test.weapon.update(1 / 60, test.scene, []);
    expect(castRay).toHaveBeenCalledTimes(1);
    expect(test.weapon.getShotRecords()[0]).toMatchObject({
      hit: 'world',
      muzzleObstructed: true,
    });
    test.weapon.dispose();
  });

  it('consumes fire, reload, weapon and toggle-ADS edges only from fixed-tick frames', () => {
    const test = createWeapon(19, undefined, false);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getShotRecords()).toHaveLength(1);

    test.weapon.setSessionInput(inputFrame({ reload: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.isReloading()).toBe(true);

    test.weapon.setSessionInput(inputFrame({ weaponSlot: 2 }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveWeapon()).toBe('pistol');
    expect(test.weapon.isReloading()).toBe(false);

    test.weapon.setToggleADS(true);
    test.weapon.setSessionInput(inputFrame({ aim: true, aimPressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.isADS()).toBe(true);
    test.weapon.setSessionInput(inputFrame({ aimPressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.isADS()).toBe(false);
    test.weapon.dispose();
  });

  it('honours session fire, ADS and dry-fire without pointer lock', () => {
    const dryFires: string[] = [];
    const live = createWeapon(27, undefined, false, false);
    live.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    live.weapon.update(1 / 60, live.scene, []);
    expect(live.weapon.getShotRecords()).toHaveLength(1);

    live.weapon.setToggleADS(true);
    live.weapon.setSessionInput(inputFrame({ aimPressed: true }));
    live.weapon.update(1 / 60, live.scene, []);
    expect(live.weapon.isADS()).toBe(true);
    live.weapon.dispose();

    const empty = createWeapon(27, undefined, false, false, {
      onDryFire: (weapon) => dryFires.push(weapon),
    });
    empty.weapon.restoreState({
      ...empty.weapon.snapshotState(),
      ammo: {
        ar: { mag: 0, reserve: 0, magSize: 30 },
        pistol: { mag: 0, reserve: 0, magSize: 12 },
      },
      fireCooldown: 0,
      ads: false,
      toggledAds: false,
    });
    empty.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    empty.weapon.update(1 / 60, empty.scene, []);
    expect(empty.weapon.getShotRecords()).toHaveLength(0);
    expect(dryFires).toEqual(['ar']);
    empty.weapon.dispose();
  });

  it('ignores DOM pending*/keys while session InputFrame drives combat', () => {
    const test = createWeapon(53, undefined, false);
    // Latched DOM weapon switch + fire must not leak into a quiet session frame.
    dispatchWindow('keydown', { code: 'Digit2' });
    dispatchWindow('mousedown', { button: 0 });
    dispatchWindow('keydown', { code: 'KeyR' });

    test.weapon.setSessionInput(inputFrame({}));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveWeapon()).toBe('ar');
    expect(test.weapon.getShotRecords()).toHaveLength(0);
    expect(test.weapon.isReloading()).toBe(false);

    // Session edges still work; DOM must not force an extra slot switch.
    dispatchWindow('keydown', { code: 'Digit3' });
    test.weapon.setSessionInput(inputFrame({ weaponSlot: 2 }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.getActiveWeapon()).toBe('pistol');
    test.weapon.dispose();
  });

  it('skips duplicate DOM bindInput when captureDomInput is disabled', () => {
    const addSpy = vi.spyOn(window, 'addEventListener');
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
    const scene = new Scene();
    const weapon = new WeaponSystem({
      player,
      camera,
      viewModelScene: new Scene(),
      random: new SeededRandom(61),
      presentationRandom: () => 0.5,
      captureDomInput: false,
    });
    expect(addSpy.mock.calls.some(([type]) => (
      type === 'keydown' || type === 'keyup' || type === 'mousedown'
      || type === 'mouseup' || type === 'wheel' || type === 'blur'
    ))).toBe(false);

    // Without session input, DOM presses must not arm fire / slot switches.
    dispatchWindow('keydown', { code: 'Digit2' });
    dispatchWindow('mousedown', { button: 0 });
    weapon.update(1 / 60, scene, []);
    expect(weapon.getActiveWeapon()).toBe('ar');
    expect(weapon.getShotRecords()).toHaveLength(0);

    weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    weapon.update(1 / 60, scene, []);
    expect(weapon.getShotRecords()).toHaveLength(1);

    weapon.setSessionInput(inputFrame({ weaponSlot: 2 }));
    weapon.update(1 / 60, scene, []);
    expect(weapon.getActiveWeapon()).toBe('pistol');
    weapon.dispose();
    addSpy.mockRestore();
  });

  it('round-trips cooldown, reload, ADS, recoil, ammunition and RNG state', () => {
    const test = createWeapon(23, undefined, false);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    test.weapon.setToggleADS(true);
    test.weapon.setSessionInput(inputFrame({ aim: true, aimPressed: true, reload: true }));
    test.weapon.update(1 / 60, test.scene, []);
    const snapshot = test.weapon.snapshotState();
    test.weapon.switchWeapon('pistol');
    test.weapon.update(0.5, test.scene, []);
    test.weapon.restoreState(snapshot);
    expect(test.weapon.snapshotState()).toEqual(snapshot);
    test.weapon.dispose();
  });

  it('restores dryFireLatch and prevFire so a held empty trigger does not re-click', () => {
    const dryFires: string[] = [];
    const test = createWeapon(31, undefined, false, true, {
      onDryFire: (weapon) => dryFires.push(weapon),
    });
    test.weapon.restoreState({
      ...test.weapon.snapshotState(),
      ammo: {
        ar: { mag: 0, reserve: 0, magSize: 30 },
        pistol: { mag: 0, reserve: 0, magSize: 12 },
      },
    });
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(dryFires).toEqual(['ar']);
    expect(test.weapon.snapshotState()).toMatchObject({ dryFireLatch: true, prevFire: true });

    const latched = test.weapon.snapshotState();
    // Simulate post-release drift that would re-arm the click without a latch restore.
    test.weapon.restoreState({ ...latched, dryFireLatch: false, prevFire: false });
    test.weapon.setSessionInput(inputFrame({ fire: false }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(test.weapon.snapshotState().dryFireLatch).toBe(false);

    test.weapon.restoreState(latched);
    expect(test.weapon.snapshotState()).toMatchObject({ dryFireLatch: true, prevFire: true });
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: false }));
    test.weapon.update(1 / 60, test.scene, []);
    expect(dryFires).toEqual(['ar']);
    test.weapon.dispose();
  });

  it('reset restores a fresh AR loadout without consuming shared RNG', () => {
    const test = createWeapon(41, undefined, false);
    test.weapon.setSessionInput(inputFrame({ fire: true, firePressed: true }));
    for (let i = 0; i < 12; i++) test.weapon.update(1 / 60, test.scene, []);
    const afterFireRandom = test.weapon.snapshotState().randomState;
    test.weapon.switchWeapon('pistol');
    test.weapon.reset();
    expect(test.weapon.getActiveWeapon()).toBe('ar');
    expect(test.weapon.getAmmo()).toEqual({ mag: 30, reserve: 90, magSize: 30 });
    expect(test.weapon.isReloading()).toBe(false);
    expect(test.weapon.getSpreadBloom()).toBe(0);
    expect(test.weapon.snapshotState().randomState).toBe(afterFireRandom);
    test.weapon.dispose();
  });
});

function createWeapon(
  seed: number,
  physicsWorld?: PhysicsWorld,
  fireHeld = true,
  pointerLocked = true,
  callbacks?: ConstructorParameters<typeof WeaponSystem>[0]['callbacks'],
): { weapon: WeaponSystem; scene: Scene } {
  const camera = new PerspectiveCamera();
  camera.position.set(1, 2, 3);
  camera.lookAt(1, 2, 2);
  camera.updateMatrixWorld(true);
  const player = {
    isADSHeld: () => false,
    isSprinting: () => false,
    isMoving: () => false,
    isDead: () => false,
    isPointerLocked: () => pointerLocked,
    isFireHeld: () => fireHeld,
    addLookDelta: () => {},
  } as unknown as PlayerController;
  const scene = new Scene();
  return {
    scene,
    weapon: new WeaponSystem({
      player,
      camera,
      viewModelScene: new Scene(),
      random: new SeededRandom(seed),
      presentationRandom: () => 0.5,
      physicsWorld,
      callbacks,
    }),
  };
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

function dispatchWindow(type: string, properties: Record<string, unknown>): void {
  const event = new Event(type, { cancelable: true });
  for (const [key, value] of Object.entries(properties)) {
    Object.defineProperty(event, key, { configurable: true, value });
  }
  window.dispatchEvent(event);
}

function riggedGroup(): Group {
  const group = new Group();
  const bone = new Bone();
  const mesh = new SkinnedMesh(new BoxGeometry(0.2, 0.2, 0.6), new MeshBasicMaterial());
  mesh.add(bone);
  mesh.bind(new Skeleton([bone]));
  group.add(mesh);
  return group;
}
