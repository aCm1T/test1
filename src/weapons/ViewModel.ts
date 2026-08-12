import {
  AdditiveBlending,
  AnimationAction,
  AnimationMixer,
  Box3,
  BoxGeometry,
  BufferGeometry,
  CapsuleGeometry,
  Color,
  ClampToEdgeWrapping,
  CylinderGeometry,
  DataTexture,
  DynamicDrawUsage,
  Euler,
  ExtrudeGeometry,
  Group,
  InstancedMesh,
  LinearFilter,
  LinearMipmapLinearFilter,
  MathUtils,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  NoColorSpace,
  Object3D,
  PointLight,
  Quaternion,
  RGBAFormat,
  RepeatWrapping,
  Shape,
  SphereGeometry,
  Sprite,
  SpriteMaterial,
  SRGBColorSpace,
  LoopOnce,
  LoopRepeat,
  Scene,
  TorusGeometry,
  Vector2,
  Vector3,
  type PerspectiveCamera,
  type Texture,
} from 'three';
import { SeededRandom, type RandomSource } from '../mission';
import { collapseStaticSubtrees, SurfaceFamily } from '../engine/StaticBatching';
import type { GLTF } from 'three/addons/loaders/GLTFLoader.js';
import { clone as cloneSkinned } from 'three/addons/utils/SkeletonUtils.js';

export type WeaponId = 'ar' | 'pistol' | 'knife';
export type ViewPose = 'hip' | 'ads' | 'sprint' | 'reload';

interface PoseTransform {
  pos: [number, number, number];
  rot: [number, number, number];
}

export const MAX_HIP_FRAME_OCCUPANCY = 0.3;
export const MAX_ADS_RETICLE_ERROR_PX_1080P = 2;

/**
 * Nodes the runtime addresses by name. Together with anything carrying a
 * recorded rest pose in userData, these are the only parts of the procedural
 * weapon that must survive static batching as independent transforms.
 */
const VIEWMODEL_PIVOT_NAMES = new Set([
  'magazine',
  'slide',
  'ADS_RETICLE',
  'FallbackReloadMagazine',
  'FallbackOpenMagwell',
  'FallbackSupportHand',
  'FallbackFiringHand',
  'FallbackSupportArm',
  'FallbackFiringArm',
  'FallbackSupportSeam',
  'FallbackFiringSeam',
  'FallbackTriggerFinger',
  'FallbackChargingHandle',
  'FallbackBoltCarrier',
]);

export interface ViewModelPresentationMetrics {
  hipFrameOccupancy: number;
  adsReticleErrorPixelsAt1080p: number;
  adsReticleMarkerPresent: boolean;
  sampleValid: boolean;
}

/** Tuned for COD-style FOV viewmodels: receiver visible on hip, tight ADS, pronounced sprint tilt. */
const POSES: Record<WeaponId, Record<ViewPose, PoseTransform>> = {
  ar: {
    // Centered hip: rifle fills lower-right FOV without clipping as a corner stub.
    hip: { pos: [0.21, -0.22, -0.5], rot: [0.028, 0.1, 0.018] },
    ads: { pos: [0.0, -0.132, -0.255], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.26, -0.3, -0.32], rot: [0.62, 0.42, -0.52] },
    reload: { pos: [0.14, -0.26, -0.34], rot: [0.42, -0.18, 0.28] },
  },
  pistol: {
    hip: { pos: [0.14, -0.145, -0.31], rot: [0.02, 0.08, 0.012] },
    ads: { pos: [0.0, -0.128, -0.275], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.24, -0.26, -0.3], rot: [0.48, 0.5, -0.35] },
    reload: { pos: [0.12, -0.24, -0.3], rot: [0.36, -0.22, 0.24] },
  },
  knife: {
    hip: { pos: [0.12, -0.105, -0.27], rot: [0.1, -0.32, 0.26] },
    ads: { pos: [0.08, -0.1, -0.28], rot: [0.05, -0.2, 0.15] },
    sprint: { pos: [0.28, -0.22, -0.28], rot: [0.55, -0.6, 0.58] },
    reload: { pos: [0.18, -0.16, -0.3], rot: [0.2, -0.35, 0.4] },
  },
};

const POSE_SPEED: Record<ViewPose, number> = {
  hip: 11,
  ads: 18,
  sprint: 9,
  reload: 13,
};

/**
 * Recoil/lag spring tuning. The rotational spring is deliberately the softest
 * of the three so muzzle climb reads over several frames, while position snaps
 * back fast enough that the receiver never appears to float.
 */
const RECOIL_ROT_STIFFNESS = 210;
const RECOIL_ROT_DAMPING = 19;
const RECOIL_POS_STIFFNESS = 300;
const RECOIL_POS_DAMPING = 24;
const LAG_STIFFNESS = 130;
const LAG_DAMPING = 15;
/** Springs integrate in fixed slices so a long frame cannot destabilise them. */
const MAX_SPRING_SLICE = 1 / 120;

const CASING_POOL_SIZE = 8;
const CASING_LIFE = 0.7;

/** Ejection port in weapon-local space, per weapon. */
const EJECT_OFFSETS: Record<WeaponId, readonly [number, number, number]> = {
  ar: [0.045, 0.037, -0.012],
  pistol: [0.026, 0.05, -0.02],
  knife: [0, 0, 0],
};

/**
 * One InstancedMesh submission covers the whole brass pool. Inactive slots
 * collapse to a zero scale so a burst never adds one colour draw per casing.
 */
const HIDDEN_CASING = new Matrix4().makeScale(0, 0, 0);
const _casingPos = new Vector3();
const _casingEuler = new Euler();
const _casingQuat = new Quaternion();
const _casingScale = new Vector3();
const _casingMatrix = new Matrix4();

interface ShellCasing {
  life: number;
  x: number;
  y: number;
  z: number;
  rx: number;
  ry: number;
  rz: number;
  scale: number;
  vx: number;
  vy: number;
  vz: number;
  spinX: number;
  spinY: number;
  spinZ: number;
}

const VIEWMODEL_ANIMATION_ALIASES: Record<ViewPose, readonly string[]> = {
  hip: ['idle', 'hip'],
  ads: ['ads', 'aim'],
  sprint: ['sprint', 'run'],
  reload: ['reload'],
};

const VIEWMODEL_REQUIRED_CLIPS: Readonly<Record<string, readonly string[]>> = {
  ...VIEWMODEL_ANIMATION_ALIASES,
  fire: ['fire', 'shoot'],
  melee: ['melee', 'knife'],
};

type FinishKind = 'metal' | 'polymer' | 'fabric' | 'paint';

interface FinishTextures {
  albedo: DataTexture;
  roughness: DataTexture;
  normal: DataTexture;
}

/**
 * A tiny deterministic PBR finish atlas.  The fallback has to read under a
 * broad range of world lighting, and solid colors made the rifle collapse into
 * a featureless black silhouette at actual HUD resolution.  Data textures keep
 * the fallback self-contained (and safe in Node tests) while giving its metal,
 * polymer and fabric distinct specular response.
 */
function makeFinishTextures(kind: FinishKind): FinishTextures {
  const size = 64;
  const albedo = new Uint8Array(size * size * 4);
  const roughness = new Uint8Array(size * size * 4);
  const normal = new Uint8Array(size * size * 4);
  const seed = kind === 'metal' ? 0x13579bdf
    : kind === 'polymer' ? 0x3c6ef372
      : kind === 'fabric' ? 0x9e3779b9
        : 0x7f4a7c15;
  let state = seed >>> 0;
  const next = (): number => {
    state ^= state << 13;
    state ^= state >>> 17;
    state ^= state << 5;
    return (state >>> 0) / 0xffffffff;
  };
  const baseRoughness = kind === 'metal' ? 105 : kind === 'paint' ? 154 : kind === 'fabric' ? 228 : 208;
  const repeat = kind === 'fabric' ? [9, 12] as const : kind === 'metal' ? [7, 13] as const : [8, 10] as const;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = (y * size + x) * 4;
      const grain = Math.round((next() - 0.5) * (kind === 'metal' ? 24 : 16));
      const scratch = kind === 'metal' && ((x + y * 7) % 31 === 0 || (x * 11 + y) % 47 === 0);
      const brush = kind === 'metal' && x % 17 === 0 && (y + x) % 5 !== 0;
      const wearPatch = kind === 'metal' && next() > 0.965;
      const oilDark = kind === 'metal' && ((x * 5 + y * 3) % 23 === 0);
      const weave = kind === 'fabric' && (x % 7 === 0 || y % 9 === 0);
      const albedoValue = Math.max(0, Math.min(255,
        236 + grain
        + (scratch ? 18 : 0)
        + (brush ? 8 : 0)
        - (wearPatch ? 22 : 0)
        - (oilDark ? 14 : 0)
        - (weave ? 12 : 0),
      ));
      const roughnessValue = Math.max(0, Math.min(255,
        baseRoughness + grain * 2
        + (scratch ? -36 : 0)
        + (brush ? -18 : 0)
        + (wearPatch ? 28 : 0)
        + (oilDark ? 18 : 0)
        + (weave ? 14 : 0),
      ));
      const nx = Math.max(0, Math.min(255, 128 + Math.round((next() - 0.5) * (kind === 'metal' ? 34 : 18))));
      const ny = Math.max(0, Math.min(255, 128 + Math.round((next() - 0.5) * (kind === 'metal' ? 34 : 18))));
      albedo[i] = albedo[i + 1] = albedo[i + 2] = albedoValue;
      albedo[i + 3] = 255;
      roughness[i] = roughness[i + 1] = roughness[i + 2] = roughnessValue;
      roughness[i + 3] = 255;
      normal[i] = nx;
      normal[i + 1] = ny;
      normal[i + 2] = 255;
      normal[i + 3] = 255;
    }
  }

  const create = (data: Uint8Array, name: string, colorSpace: typeof SRGBColorSpace | typeof NoColorSpace): DataTexture => {
    const texture = new DataTexture(data, size, size, RGBAFormat);
    texture.name = `FallbackViewmodel${kind}${name}`;
    texture.colorSpace = colorSpace;
    texture.wrapS = RepeatWrapping;
    texture.wrapT = RepeatWrapping;
    texture.repeat.set(repeat[0], repeat[1]);
    texture.magFilter = LinearFilter;
    texture.minFilter = LinearMipmapLinearFilter;
    texture.generateMipmaps = true;
    texture.needsUpdate = true;
    return texture;
  };

  return {
    albedo: create(albedo, 'Albedo', SRGBColorSpace),
    roughness: create(roughness, 'Roughness', NoColorSpace),
    normal: create(normal, 'Normal', NoColorSpace),
  };
}

const FALLBACK_FINISHES: Record<FinishKind, FinishTextures> = {
  metal: makeFinishTextures('metal'),
  polymer: makeFinishTextures('polymer'),
  fabric: makeFinishTextures('fabric'),
  paint: makeFinishTextures('paint'),
};

/** Derived from the finish, so it is constant across a finish's materials. */
function finishNormalStrength(kind: FinishKind): number {
  return kind === 'metal' ? 0.28 : 0.13;
}

/**
 * One shared surface per finish. Every material of a finish already samples the
 * same three textures, so the only things keeping their pieces on separate
 * submissions were the tint, roughness, metalness and emissive lift they set
 * individually — all of which the batcher bakes per vertex. Consolidating here
 * is therefore exact rather than an approximation.
 */
const FALLBACK_FINISH_FAMILIES: readonly SurfaceFamily[] = (
  Object.keys(FALLBACK_FINISHES) as FinishKind[]
).map((kind) => {
  const finish = FALLBACK_FINISHES[kind];
  const strength = finishNormalStrength(kind);
  return new SurfaceFamily(`Viewmodel${kind}`, {
    map: finish.albedo,
    roughnessMap: finish.roughness,
    normalMap: finish.normal,
    normalScale: new Vector2(strength, strength),
  });
});

const FALLBACK_FABRIC_FAMILY = FALLBACK_FINISH_FAMILIES[
  (Object.keys(FALLBACK_FINISHES) as FinishKind[]).indexOf('fabric')
];

/** Generated soft-goods swatches, and the neutral lift each takes from the
 * charcoal development albedo so its weave survives the dark fallback tone. */
const FALLBACK_GLOVE_COLOR = 0x3c4848;
const FALLBACK_SLEEVE_COLOR = 0x3e4950;
const DEVELOPMENT_GLOVE_COLOR = 0xd0d8d0;
const DEVELOPMENT_SLEEVE_COLOR = 0xb8c0bc;

/**
 * The lift as one multiplier the shared fabric surface can carry. Merged fabric
 * pieces bake their own colour into the geometry, so the per-material swap has
 * to be re-expressed as a tint on the batch; the geometric mean of the two
 * members' lifts leaves both within a few percent of where they used to read.
 */
function developmentFabricTint(): Color {
  const tint = new Color(1, 1, 1);
  for (const [base, target] of [
    [FALLBACK_GLOVE_COLOR, DEVELOPMENT_GLOVE_COLOR],
    [FALLBACK_SLEEVE_COLOR, DEVELOPMENT_SLEEVE_COLOR],
  ]) {
    const from = new Color(base);
    const to = new Color(target);
    tint.setRGB(tint.r * (to.r / from.r), tint.g * (to.g / from.g), tint.b * (to.b / from.b));
  }
  return tint.setRGB(Math.sqrt(tint.r), Math.sqrt(tint.g), Math.sqrt(tint.b));
}

interface MatOpts {
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flatShading?: boolean;
  finish?: FinishKind;
  transparent?: boolean;
  opacity?: number;
  depthWrite?: boolean;
}

function mat(color: number, opts: MatOpts = {}): MeshStandardMaterial {
  const finish = opts.finish ? FALLBACK_FINISHES[opts.finish] : undefined;
  const m = new MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.8,
    roughness: opts.roughness ?? 0.45,
    emissive: new Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    flatShading: opts.flatShading ?? false,
    transparent: opts.transparent ?? false,
    opacity: opts.opacity ?? 1,
  });
  if (finish && opts.finish) {
    m.map = finish.albedo;
    m.roughnessMap = finish.roughness;
    m.normalMap = finish.normal;
    const strength = finishNormalStrength(opts.finish);
    m.normalScale.set(strength, strength);
    // Dusk split-tone: metals drink cool env/rim; polymer stays on warm key.
    m.envMapIntensity = opts.finish === 'metal'
      ? 1.38
      : opts.finish === 'polymer'
        ? 0.48
        : opts.finish === 'paint'
          ? 0.72
          : 0.4;
  }
  // Transparent sight glass must not turn its own lens into an opaque cyan
  // card. Every other fallback surface keeps depth writes for correct
  // viewmodel occlusion.
  m.depthTest = true;
  m.depthWrite = opts.depthWrite ?? !opts.transparent;
  return m;
}

/** Soft additive muzzle disc — one sprite draw instead of lit sphere lobes. */
function createMuzzleFlashTexture(size = 64): Texture {
  const data = new Uint8Array(size * size * 4);
  const cx = (size - 1) * 0.5;
  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = (x - cx) / cx;
      const dy = (y - cx) / cx;
      const r = Math.min(1, Math.sqrt(dx * dx + dy * dy));
      const core = Math.exp(-r * r * 9.5);
      const skirt = Math.pow(Math.max(0, 1 - r), 2.4) * 0.45;
      const a = Math.min(1, core + skirt);
      const i = (y * size + x) * 4;
      data[i] = 255;
      data[i + 1] = Math.round(210 + (1 - r) * 35);
      data[i + 2] = Math.round(80 + (1 - r) * 90);
      data[i + 3] = Math.round(a * 255);
    }
  }
  const texture = new DataTexture(data, size, size, RGBAFormat);
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.needsUpdate = true;
  texture.name = 'ViewModelMuzzleFlash';
  return texture;
}

/**
 * Presentation-only FPS viewmodel. It lives in a dedicated scene/camera so it
 * cannot clip against world geometry or inherit world depth.
 */
export class ViewModel {
  readonly root: Group;
  readonly muzzleFlash: Sprite;
  readonly muzzleLight: PointLight;

  private readonly camera: PerspectiveCamera;
  private readonly parent: Object3D;
  private readonly random: RandomSource;
  private readonly weapons: Record<WeaponId, Group>;
  /**
   * Per-material clones of the original development ripstop source. Cloning
   * keeps glove and sleeve UV density independent without mutating the source
   * texture owned by the bootstrap.
   */
  private readonly developmentRipstopTextures: Texture[] = [];
  private authoredRoot: Object3D | null = null;
  private authoredMixer: AnimationMixer | null = null;
  private readonly authoredActions = new Map<string, AnimationAction>();
  private authoredAction: AnimationAction | null = null;
  private active: WeaponId = 'ar';
  private pose: ViewPose = 'hip';
  private targetPose: ViewPose = 'hip';

  /**
   * Recoil is a second-order spring rather than a damped offset: `kickOnFire`
   * injects velocity, so the weapon rises, overshoots slightly and settles.
   * Sustained fire stacks into a climbing pattern the way an automatic should.
   */
  private readonly kickRot = { x: 0, y: 0, z: 0 };
  private readonly kickPos = { x: 0, y: 0, z: 0 };
  private readonly kickRotVel = { x: 0, y: 0, z: 0 };
  private readonly kickPosVel = { x: 0, y: 0, z: 0 };
  private flashTimer = 0;
  private flashDuration = 0.05;
  /**
   * Presentation-only impulses.  Combat recoil remains in WeaponSystem; these
   * values only give the visible weapon a short trigger squeeze and a small
   * return stroke instead of a single damped transform.
   */
  private triggerPulse = 0;
  private recoilReturn = 0;
  /** Sustained-fire heat: grows the flash, shakes the sight picture, drifts up. */
  private heat = 0;
  /** Continuous 0→1 aim blend used for sway suppression and pose weighting. */
  private adsBlend = 0;
  /**
   * Weapon lag. Driven only by fixed-tick look/move values handed in by
   * WeaponSystem, never by DOM pointer events, so replays stay identical.
   */
  private lagYaw = 0;
  private lagPitch = 0;
  private lagYawVel = 0;
  private lagPitchVel = 0;
  private moveSpeed = 0;
  private moveStrafe = 0;
  private moveAirborne = false;
  private reloadT = 0;
  private reloading = false;
  private emptyReload = false;
  private switchT = 1;
  private prevWeapon: WeaponId = 'ar';
  private readonly switchFromPosition = new Vector3();
  private readonly switchFromRotation = new Vector3();
  private poseTransitionT = 1;
  private idleT = 0;
  private _reloadDuration = 1.6;

  // ─── Hard value bands: near-black polymer / dark receivers / hot steel edges ─
  // Cool nitride emissive tracks RimSeparation; warm polymer toe tracks SunDusk
  // bounce so the two finishes separate under the shared dusk grade.
  private readonly nitride = mat(0x4a5d6e, {
    metalness: 0.86,
    roughness: 0.25,
    emissive: 0x0e1824,
    emissiveIntensity: 0.18,
    finish: 'metal',
  });
  private readonly nitrideWorn = mat(0x6a8090, {
    metalness: 0.78,
    roughness: 0.34,
    emissive: 0x121c28,
    emissiveIntensity: 0.17,
    finish: 'metal',
  });
  private readonly steel = mat(0x6d808f, {
    metalness: 0.94,
    roughness: 0.16,
    emissive: 0x121c26,
    emissiveIntensity: 0.08,
    finish: 'metal',
  });
  private readonly steelBright = mat(0xb4c4d0, {
    metalness: 0.97,
    roughness: 0.1,
    emissive: 0x1c2832,
    emissiveIntensity: 0.09,
    finish: 'metal',
  });
  // Polymer keeps a warm rest so the cool rim does not chrome it like nitride.
  private readonly polymer = mat(0x37434d, {
    metalness: 0.015,
    roughness: 0.78,
    emissive: 0x100c08,
    emissiveIntensity: 0.1,
    finish: 'polymer',
  });
  private readonly polymerGrit = mat(0x2c353e, {
    metalness: 0.01,
    roughness: 0.86,
    emissive: 0x0c0906,
    emissiveIntensity: 0.09,
    finish: 'polymer',
  });
  private readonly polymerSoft = mat(0x4a5660, {
    metalness: 0.02,
    roughness: 0.8,
    emissive: 0x120e0a,
    emissiveIntensity: 0.1,
    finish: 'polymer',
  });
  // FDE / tan accents break the gray mass (magwell lip, stock cheek, grip panels).
  private readonly fde = mat(0x8a6f45, {
    metalness: 0.1,
    roughness: 0.69,
    emissive: 0x24180b,
    emissiveIntensity: 0.1,
    finish: 'paint',
  });
  private readonly railTooth = mat(0x4a535d, {
    metalness: 0.94,
    roughness: 0.14,
    emissive: 0x11161c,
    emissiveIntensity: 0.04,
    finish: 'metal',
  });
  private readonly opticHousing = mat(0x1b242d, {
    metalness: 0.78,
    roughness: 0.32,
    emissive: 0x070c11,
    emissiveIntensity: 0.12,
    finish: 'metal',
  });
  // Smoke rather than cyan: a real optic needs to reveal the scene through
  // its lens while its rim, not a luminous rectangle, owns the silhouette.
  private readonly opticGlass = mat(0x203943, {
    metalness: 0.08,
    roughness: 0.08,
    emissive: 0x061319,
    emissiveIntensity: 0.06,
    finish: 'paint',
    transparent: true,
    opacity: 0.32,
    depthWrite: false,
  });
  private readonly reticleGlow = mat(0xf06b45, {
    metalness: 0.05,
    roughness: 0.38,
    emissive: 0xed412c,
    emissiveIntensity: 1.35,
  });
  private readonly gloveReinforcement = mat(0x273238, {
    metalness: 0.01,
    roughness: 0.72,
    emissive: 0x05090b,
    emissiveIntensity: 0.08,
    finish: 'fabric',
  });
  private readonly gripRubber = mat(0x1c252b, {
    metalness: 0.01,
    roughness: 0.88,
    finish: 'paint',
  });
  private readonly ironGlow = mat(0x4b2b1c, {
    metalness: 0.5,
    roughness: 0.42,
    emissive: 0xf06a2d,
    emissiveIntensity: 0.34,
  });
  private readonly blade = mat(0xe0e8f0, {
    metalness: 0.94,
    roughness: 0.14,
    emissive: 0x1c2228,
    emissiveIntensity: 0.14,
  });
  private readonly bladeEdge = mat(0xf4f8fc, {
    metalness: 0.96,
    roughness: 0.1,
    emissive: 0x202428,
    emissiveIntensity: 0.12,
  });
  private readonly glove = mat(0x3c4848, {
    metalness: 0.02,
    roughness: 0.78,
    finish: 'fabric',
  });
  private readonly sleeve = mat(0x3e4950, {
    metalness: 0.01,
    roughness: 0.86,
    finish: 'fabric',
  });
  private readonly flashMat = new SpriteMaterial({
    map: createMuzzleFlashTexture(),
    color: 0xffcc88,
    blending: AdditiveBlending,
    transparent: true,
    depthWrite: false,
    fog: false,
  });
  // Ejected brass reads as a hot spec of metal for a few frames, so it keeps a
  // faint emissive lift to stay visible against dark ground clutter.
  private readonly brass = mat(0xc9a227, {
    metalness: 0.92,
    roughness: 0.29,
    emissive: 0x3a2a08,
    emissiveIntensity: 0.35,
    finish: 'metal',
  });

  /**
   * Brass pool. Casings live in viewmodel space so they read as ejecting from
   * the receiver; they clear the frame well inside their short life. All eight
   * slots share one InstancedMesh so burst fire stays a single colour draw.
   */
  private readonly casings: ShellCasing[] = [];
  private readonly casingMesh: InstancedMesh;
  private casingAlive = 0;

  constructor(camera: PerspectiveCamera, scene?: Scene, random?: RandomSource) {
    this.camera = camera;
    const fallbackRandom = new SeededRandom(0x56494557);
    this.random = random ?? (() => fallbackRandom.next());
    this.root = new Group();
    this.root.name = 'ViewModelRoot';

    this.weapons = {
      ar: this.buildAssaultRifle(),
      pistol: this.buildPistol(),
      knife: this.buildKnife(),
    };

    // The first-person weapon is on screen every frame, so its several hundred
    // authored pieces are the most expensive thing in the scene. Everything the
    // animation code does not address by name is baked into merged surfaces;
    // hidden and named parts keep their own transform and visibility.
    for (const id of Object.keys(this.weapons) as WeaponId[]) {
      collapseStaticSubtrees(this.weapons[id], {
        isPivot: (node) => VIEWMODEL_PIVOT_NAMES.has(node.name)
          || Object.keys(node.userData).length > 0,
        namePrefix: 'ViewModelBatch',
        unifyPlainMaterials: true,
        surfaceFamilies: FALLBACK_FINISH_FAMILIES,
      });
    }

    for (const id of Object.keys(this.weapons) as WeaponId[]) {
      this.weapons[id].visible = id === this.active;
      this.root.add(this.weapons[id]);
    }

    this.muzzleFlash = new Sprite(this.flashMat);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.name = 'MuzzleFlash';
    this.muzzleFlash.scale.set(0.09, 0.09, 1);
    this.root.add(this.muzzleFlash);

    this.muzzleLight = new PointLight(0xffaa55, 0, 3.2, 2);
    this.muzzleLight.visible = false;
    this.root.add(this.muzzleLight);

    // Weapon lighting comes from the viewmodel scene's synced env + directionals
    // (ViewModelKey / Rim / MoonFill). Local PointLight fills washed nitride
    // and polymer into the same mid-gray and fought the world dusk grade.

    this.casingMesh = this.buildCasingPool();

    this.parent = scene ?? camera;
    this.parent.add(this.root);
    this.applyPoseImmediate('hip');
  }

  private buildCasingPool(): InstancedMesh {
    const geometry = new CylinderGeometry(0.0042, 0.0046, 0.019, 6);
    const mesh = new InstancedMesh(geometry, this.brass, CASING_POOL_SIZE);
    mesh.name = 'FallbackShellCasings';
    mesh.count = 0;
    mesh.frustumCulled = false;
    mesh.castShadow = false;
    mesh.receiveShadow = false;
    mesh.instanceMatrix.setUsage(DynamicDrawUsage);
    for (let i = 0; i < CASING_POOL_SIZE; i++) {
      mesh.setMatrixAt(i, HIDDEN_CASING);
      this.casings.push({
        life: 0,
        x: 0,
        y: 0,
        z: 0,
        rx: 0,
        ry: 0,
        rz: 0,
        scale: 1,
        vx: 0,
        vy: 0,
        vz: 0,
        spinX: 0,
        spinY: 0,
        spinZ: 0,
      });
    }
    mesh.instanceMatrix.needsUpdate = true;
    this.root.add(mesh);
    return mesh;
  }

  private writeCasingInstance(index: number, casing: ShellCasing): void {
    if (casing.life <= 0) {
      this.casingMesh.setMatrixAt(index, HIDDEN_CASING);
      return;
    }
    _casingPos.set(casing.x, casing.y, casing.z);
    _casingEuler.set(casing.rx, casing.ry, casing.rz);
    _casingQuat.setFromEuler(_casingEuler);
    _casingScale.setScalar(casing.scale);
    _casingMatrix.compose(_casingPos, _casingQuat, _casingScale);
    this.casingMesh.setMatrixAt(index, _casingMatrix);
  }

  getPresentationMetrics(): ViewModelPresentationMetrics {
    const holder = this.weapons.ar;
    const marker = findAdsReticle(holder);
    const occupancy = this.measureAtPose(holder, 'hip', () => this.measureVisibleFrameOccupancy(holder));
    const adsError = marker
      ? this.measureAtPose(holder, 'ads', () => this.measureReticleError(marker))
      : Number.MAX_SAFE_INTEGER;
    return {
      hipFrameOccupancy: occupancy,
      adsReticleErrorPixelsAt1080p: adsError,
      adsReticleMarkerPresent: marker !== null,
      sampleValid: Number.isFinite(occupancy) && Number.isFinite(adsError),
    };
  }

  getActiveWeapon(): WeaponId {
    return this.active;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  /** True while the current reload is running its empty/bolt-release timeline. */
  isEmptyReload(): boolean {
    return this.reloading && this.emptyReload;
  }

  /** Continuous aim blend: 0 at the hip, 1 fully settled in the sights. */
  getAdsBlend(): number {
    return this.adsBlend;
  }

  /** Current spring recoil offset in radians, for tests and HUD sway. */
  getRecoilOffset(): { pitch: number; yaw: number; roll: number } {
    return { pitch: this.kickRot.x, yaw: this.kickRot.y, roll: this.kickRot.z };
  }

  /** Sustained-fire heat, 0→1. Grows the flash and widens the sight picture. */
  getHeat(): number {
    return this.heat;
  }

  /** Current weapon-lag offset in radians, trailing the look input. */
  getLookLag(): { yaw: number; pitch: number } {
    return { yaw: this.lagYaw, pitch: this.lagPitch };
  }

  /** Live ejected brass, used by tests and the shell-drop audio cue. */
  getActiveCasingCount(): number {
    return this.casings.reduce((total, casing) => total + (casing.life > 0 ? 1 : 0), 0);
  }

  /**
   * Weapon lag from the fixed-tick look delta. Values are the same raw pointer
   * deltas the simulation already consumed, so this cannot desynchronise a
   * replay: it only offsets the presentation transform.
   */
  applyLookSway(lookX: number, lookY: number): void {
    if (!Number.isFinite(lookX) || !Number.isFinite(lookY)) return;
    const suppression = 1 - this.adsBlend * 0.72;
    this.lagYawVel -= MathUtils.clamp(lookX, -220, 220) * 0.0016 * suppression;
    this.lagPitchVel -= MathUtils.clamp(lookY, -220, 220) * 0.0013 * suppression;
  }

  /** Movement context for sway/bob overlays, sampled from the simulation. */
  setMovementState(speed: number, strafe: number, airborne: boolean): void {
    this.moveSpeed = Number.isFinite(speed) ? Math.max(0, speed) : 0;
    this.moveStrafe = Number.isFinite(strafe) ? MathUtils.clamp(strafe, -1, 1) : 0;
    this.moveAirborne = airborne;
  }

  /**
   * Applies original project material only to the visible procedural soft-goods
   * fallback. Authored rifle-and-arms GLTF materials are never traversed or
   * modified here.
   */
  installDevelopmentRipstop(source: Texture, maxAnisotropy = 8): void {
    // An authored viewmodel owns all camera-visible materials. Keep even the
    // hidden fallback untouched once that route has been installed.
    if (this.authoredRoot) return;
    this.clearDevelopmentRipstop();

    const anisotropy = Math.max(1, Math.min(8, Math.floor(maxAnisotropy)));
    const clone = (name: string, repeatX: number, repeatY: number): Texture => {
      const texture = source.clone();
      texture.name = name;
      texture.colorSpace = SRGBColorSpace;
      texture.wrapS = RepeatWrapping;
      texture.wrapT = RepeatWrapping;
      texture.repeat.set(repeatX, repeatY);
      texture.magFilter = LinearFilter;
      texture.minFilter = LinearMipmapLinearFilter;
      texture.generateMipmaps = true;
      texture.anisotropy = anisotropy;
      texture.needsUpdate = true;
      this.developmentRipstopTextures.push(texture);
      return texture;
    };

    // Keep the generated fabric roughness and normal maps in place. The
    // authored original is only the albedo detail layer for soft goods.
    this.glove.map = clone('DevelopmentFallbackGloveRipstop', 8, 11);
    this.sleeve.map = clone('DevelopmentFallbackSleeveRipstop', 5, 8);
    // The source itself is charcoal. A restrained neutral tint prevents the
    // existing dark fallback swatch from crushing its weave to pure black.
    this.glove.color.setHex(DEVELOPMENT_GLOVE_COLOR);
    this.sleeve.color.setHex(DEVELOPMENT_SLEEVE_COLOR);
    this.glove.needsUpdate = true;
    this.sleeve.needsUpdate = true;
    // Merged soft-goods pieces read the shared fabric surface rather than these
    // materials, so the swap has to reach it too. Its tiling comes from the
    // baked UVs, which is why the view is left untransformed.
    FALLBACK_FABRIC_FAMILY.setAlbedo(clone('DevelopmentFallbackFabricRipstop', 1, 1));
    FALLBACK_FABRIC_FAMILY.setTint(developmentFabricTint());
  }

  /** Releases only clones owned by the fallback; never the bootstrap source. */
  clearDevelopmentRipstop(): void {
    this.glove.map = FALLBACK_FINISHES.fabric.albedo;
    this.sleeve.map = FALLBACK_FINISHES.fabric.albedo;
    this.glove.color.setHex(FALLBACK_GLOVE_COLOR);
    this.sleeve.color.setHex(FALLBACK_SLEEVE_COLOR);
    this.glove.needsUpdate = true;
    this.sleeve.needsUpdate = true;
    FALLBACK_FABRIC_FAMILY.setAlbedo(FALLBACK_FINISHES.fabric.albedo);
    FALLBACK_FABRIC_FAMILY.setTint(0xffffff);
    for (const texture of this.developmentRipstopTextures) texture.dispose();
    this.developmentRipstopTextures.length = 0;
  }

  setPose(pose: ViewPose): void {
    if (this.reloading && pose !== 'reload') return;
    if (this.targetPose !== pose) {
      this.poseTransitionT = 0;
      this.playAuthoredPose(pose);
    }
    this.targetPose = pose;
  }

  getPose(): ViewPose {
    return this.pose;
  }

  switchWeapon(id: WeaponId): void {
    if (id === this.active && this.switchT >= 1) return;
    const outgoing = this.weapons[this.active];
    this.switchFromPosition.copy(outgoing.position);
    this.switchFromRotation.set(outgoing.rotation.x, outgoing.rotation.y, outgoing.rotation.z);
    this.prevWeapon = this.active;
    this.active = id;
    this.switchT = 0;
    this.poseTransitionT = 0;
    this.reloading = false;
    this.emptyReload = false;
    this.reloadT = 0;
    // A swap must not carry the outgoing weapon's recoil, heat or brass across.
    this.heat = 0;
    this.clearRecoilSprings();
    this.clearCasings();
    this.resetMagazine(this.prevWeapon);
    // The incoming model may have been the hidden side of a previous switch.
    // Rebase it before the draw-in so poses never accumulate off-screen.
    const incoming = this.weapons[id];
    const incomingPose = POSES[id].hip;
    incoming.position.set(...incomingPose.pos);
    incoming.rotation.set(...incomingPose.rot);
    for (const wid of Object.keys(this.weapons) as WeaponId[]) {
      this.weapons[wid].visible = wid === id || wid === this.prevWeapon;
    }
    this.targetPose = 'hip';
    if (id === 'ar') this.playAuthoredPose('hip');
  }

  /**
   * Begin procedural reload pose timeline.
   *
   * @param empty Ran dry: adds the bolt-release beat and a heavier settle, so a
   *   dry reload is visibly slower to get back on target than a tactical one.
   */
  playReload(duration = 1.6, empty = false): void {
    if (this.active === 'knife') return;
    this.reloading = true;
    this.emptyReload = empty;
    this.reloadT = 0;
    this._reloadDuration = duration;
    this.targetPose = 'reload';
    this.poseTransitionT = 0;
    // A reload is the natural place to shed accumulated muzzle heat.
    this.heat = 0;
    this.resetFallbackReloadState(this.weapons[this.active]);
    this.playAuthoredClip(['reload'], true);
  }

  cancelReload(): void {
    this.reloading = false;
    this.emptyReload = false;
    this.reloadT = 0;
    this.targetPose = 'hip';
    this.pose = 'hip';
    this.poseTransitionT = 0;
    this.resetMagazine(this.active);
    this.playAuthoredPose('hip');
  }

  installAuthored(gltf: GLTF): void {
    if (!hasSkinnedMesh(gltf.scene)) {
      throw new Error('authored viewmodel must contain a rigged SkinnedMesh');
    }
    const visual = cloneSkinned(gltf.scene);
    const missingClips = missingAnimationRoles(gltf, VIEWMODEL_REQUIRED_CLIPS);
    if (missingClips.length > 0) {
      throw new Error(`authored viewmodel is missing clips: ${missingClips.join(', ')}`);
    }
    if (!findAdsReticle(visual)) {
      throw new Error('authored viewmodel is missing ADS_RETICLE marker');
    }
    this.removeAuthored();
    this.active = 'ar';
    this.prevWeapon = 'ar';
    this.switchT = 1;
    for (const id of Object.keys(this.weapons) as WeaponId[]) {
      this.weapons[id].visible = id === 'ar';
    }
    const holder = this.weapons.ar;
    for (const child of holder.children) child.visible = false;
    visual.name = 'AuthoredViewModelRifleArms';
    visual.traverse((node) => {
      node.castShadow = false;
      node.receiveShadow = false;
    });
    holder.add(visual);
    this.authoredRoot = visual;
    this.authoredMixer = new AnimationMixer(visual);
    for (const clip of gltf.animations) {
      this.authoredActions.set(clip.name.toLowerCase(), this.authoredMixer.clipAction(clip));
    }
    this.playAuthoredPose('hip');
  }

  hasAuthoredVisual(): boolean {
    return this.authoredRoot !== null;
  }

  clearAuthored(): void {
    this.removeAuthored();
  }

  /**
   * Camera-relative recoil kick on fire. Impulses feed the recoil spring's
   * velocity, and sustained fire raises `heat` so a long burst climbs and
   * loosens instead of repeating one identical hitch.
   */
  kickOnFire(amount = 1, ads = false): void {
    const mul = ads ? 0.42 : 1;
    const a = amount * mul;
    // Heat biases the kick upward and adds lateral wander, so the tenth round
    // of a burst is visibly less controlled than the first.
    const climb = 1 + this.heat * 0.55;
    const wander = 1 + this.heat * 1.4;

    this.kickRotVel.x += (2.55 * climb + this.random() * 0.6) * a;
    this.kickRotVel.y += (this.random() - 0.5) * 1.15 * wander * a;
    this.kickRotVel.z += (this.random() - 0.5) * 1.35 * wander * a;
    this.kickPosVel.z += 1.55 * a;
    this.kickPosVel.y -= 0.5 * a;
    this.kickPosVel.x += (this.random() - 0.5) * 0.3 * wander * a;

    this.triggerPulse = Math.min(1.25, this.triggerPulse + 0.92 * a);
    this.recoilReturn = Math.min(1, this.recoilReturn + 0.85 * a);
    this.heat = Math.min(1, this.heat + (this.active === 'pistol' ? 0.16 : 0.11));

    // Pistol slide nudge
    if (this.active === 'pistol') {
      const slide = this.weapons.pistol.getObjectByName('slide');
      if (slide) {
        slide.userData.kickZ = (slide.userData.kickZ as number | undefined) ?? 0;
        slide.userData.kickZ = Math.min(0.028, (slide.userData.kickZ as number) + 0.022 * a);
      }
    }

    this.ejectCasing();
    this.triggerMuzzleFlash();
    this.playAuthoredClip(['fire', 'shoot'], true);
  }

  /** Sends one brass case out of the ejection port on a short ballistic arc. */
  private ejectCasing(): void {
    // Authored rigs own every visible mechanism, including their own brass.
    if (this.authoredRoot || this.active === 'knife') return;
    const index = this.casings.findIndex((candidate) => candidate.life <= 0);
    if (index < 0) return;
    const casing = this.casings[index]!;

    const weapon = this.weapons[this.active];
    const offset = EJECT_OFFSETS[this.active];
    casing.x = weapon.position.x + offset[0];
    casing.y = weapon.position.y + offset[1];
    casing.z = weapon.position.z + offset[2];
    casing.rx = this.random() * 3;
    casing.ry = this.random() * 3;
    casing.rz = this.random() * 3;
    casing.scale = 1;
    casing.life = CASING_LIFE;
    casing.vx = 0.85 + this.random() * 0.5;
    casing.vy = 0.65 + this.random() * 0.4;
    casing.vz = 0.28 + this.random() * 0.35;
    casing.spinX = 12 + this.random() * 14;
    casing.spinY = (this.random() - 0.5) * 20;
    casing.spinZ = 8 + this.random() * 12;
    this.writeCasingInstance(index, casing);
    this.casingAlive += 1;
    this.casingMesh.count = CASING_POOL_SIZE;
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }

  private updateCasings(dt: number): void {
    if (this.casingAlive <= 0) return;
    let alive = 0;
    for (let index = 0; index < this.casings.length; index++) {
      const casing = this.casings[index]!;
      if (casing.life <= 0) continue;
      casing.life -= dt;
      if (casing.life <= 0) {
        casing.life = 0;
        this.writeCasingInstance(index, casing);
        continue;
      }
      casing.vy -= 3.2 * dt;
      casing.x += casing.vx * dt;
      casing.y += casing.vy * dt;
      casing.z += casing.vz * dt;
      casing.rx += casing.spinX * dt;
      casing.ry += casing.spinY * dt;
      casing.rz += casing.spinZ * dt;
      const fade = MathUtils.clamp(casing.life / (CASING_LIFE * 0.45), 0, 1);
      casing.scale = 0.55 + fade * 0.45;
      this.writeCasingInstance(index, casing);
      alive += 1;
    }
    this.casingAlive = alive;
    this.casingMesh.count = alive > 0 ? CASING_POOL_SIZE : 0;
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }

  private clearCasings(): void {
    if (this.casingAlive <= 0 && this.casingMesh.count === 0) return;
    for (let index = 0; index < this.casings.length; index++) {
      const casing = this.casings[index]!;
      casing.life = 0;
      this.writeCasingInstance(index, casing);
    }
    this.casingAlive = 0;
    this.casingMesh.count = 0;
    this.casingMesh.instanceMatrix.needsUpdate = true;
  }

  private clearRecoilSprings(): void {
    for (const axis of ['x', 'y', 'z'] as const) {
      this.kickRot[axis] = 0;
      this.kickRotVel[axis] = 0;
      this.kickPos[axis] = 0;
      this.kickPosVel[axis] = 0;
    }
    this.lagYaw = 0;
    this.lagPitch = 0;
    this.lagYawVel = 0;
    this.lagPitchVel = 0;
    this.triggerPulse = 0;
    this.recoilReturn = 0;
  }

  /** Knife swing kick — a broad slash impulse rather than a muzzle rise. */
  kickMelee(): void {
    this.kickRotVel.x += 11;
    this.kickRotVel.y -= 26;
    this.kickRotVel.z += 18;
    this.kickPosVel.z -= 6.2;
    this.kickPosVel.x += 3.4;
    this.kickPosVel.y -= 1.3;
    this.playAuthoredClip(['melee', 'knife'], true);
  }

  private triggerMuzzleFlash(): void {
    if (this.active === 'knife') return;
    // A hot barrel throws a longer, brighter flash. The duration is stored so
    // the decay curve stays correct instead of assuming a fixed 50 ms.
    this.flashDuration = 0.045 + this.heat * 0.028;
    this.flashTimer = this.flashDuration;
    this.muzzleFlash.visible = true;
    this.muzzleLight.visible = true;
    this.muzzleLight.intensity = 5.2 + this.heat * 3.4;
    this.positionMuzzle();
  }

  private positionMuzzle(): void {
    const offsets: Record<WeaponId, [number, number, number]> = {
      ar: [0.0, 0.038, -0.645],
      pistol: [0.0, 0.038, -0.275],
      knife: [0, 0, 0],
    };
    const o = offsets[this.active];
    const w = this.weapons[this.active];
    this.muzzleFlash.position.set(
      w.position.x + o[0],
      w.position.y + o[1],
      w.position.z + o[2],
    );
    this.muzzleLight.position.copy(this.muzzleFlash.position);
  }

  update(dt: number): void {
    const clampedDt = Math.min(dt, 0.05);
    this.authoredMixer?.update(clampedDt);
    this.idleT += clampedDt;

    // Weapon switch draw: explicitly rebase both sides every frame.  The old
    // version accumulated its dip on a hidden object, so repeated swaps could
    // bring a weapon back in from an arbitrary pose.
    if (this.switchT < 1) {
      this.switchT = Math.min(1, this.switchT + clampedDt / 0.26);
      const hide = this.switchT < 0.5;
      this.weapons[this.prevWeapon].visible = hide || this.switchT < 1;
      this.weapons[this.active].visible = !hide || this.switchT >= 0.5;

      const outW = this.weapons[this.prevWeapon];
      const inW = this.weapons[this.active];
      if (hide) {
        const t = this.smoothstep(this.switchT / 0.5);
        outW.position.copy(this.switchFromPosition);
        outW.rotation.set(this.switchFromRotation.x, this.switchFromRotation.y, this.switchFromRotation.z);
        outW.position.y -= t * 0.13;
        outW.position.z += t * 0.04;
        outW.rotation.x += t * 0.31;
        outW.rotation.z += t * 0.075;
      } else {
        const t = this.smoothstep((this.switchT - 0.5) / 0.5);
        const p = POSES[this.active].hip;
        inW.position.set(
          p.pos[0] + (1 - t) * 0.035,
          p.pos[1] - (1 - t) * 0.125,
          p.pos[2] + (1 - t) * 0.055,
        );
        inW.rotation.set(
          p.rot[0] + (1 - t) * 0.23,
          p.rot[1] - (1 - t) * 0.08,
          p.rot[2] - (1 - t) * 0.1,
        );
      }

      if (this.switchT >= 1) {
        this.weapons[this.prevWeapon].visible = false;
        this.weapons[this.active].visible = true;
      }
    }

    // Reload timeline
    if (this.reloading) {
      this.reloadT += clampedDt;
      const u = this.reloadT / this._reloadDuration;
      this.targetPose = 'reload';
      if (u >= 1) {
        this.reloading = false;
        this.emptyReload = false;
        this.targetPose = 'hip';
        this.resetMagazine(this.active);
      }
    }

    this.pose = this.targetPose;
    this.lerpWeaponToPose(this.active, this.pose, clampedDt);
    this.poseTransitionT = Math.min(
      1,
      this.poseTransitionT + clampedDt / (this.targetPose === 'ads' ? 0.16 : 0.22),
    );

    // A continuous aim blend drives every suppression term below, so partially
    // aimed frames behave like a real transition rather than snapping between
    // two discrete sway budgets at the moment the pose flips.
    this.adsBlend = MathUtils.damp(
      this.adsBlend,
      this.targetPose === 'ads' ? 1 : 0,
      this.targetPose === 'ads' ? 17 : 13,
      clampedDt,
    );
    this.heat = MathUtils.damp(this.heat, 0, 1.7, clampedDt);
    this.integrateRecoilSprings(clampedDt);
    this.triggerPulse = MathUtils.damp(this.triggerPulse, 0, 36, clampedDt);
    this.recoilReturn = MathUtils.damp(this.recoilReturn, 0, 10, clampedDt);

    // Idle / breath sway. Heat widens the hold; aiming tightens it.
    const swayAmp = (this.pose === 'sprint' ? 0.004 : 0.0028 + this.heat * 0.0022)
      * (1 - this.adsBlend * 0.62);
    const swayX = Math.sin(this.idleT * 1.35) * swayAmp;
    const swayY = Math.cos(this.idleT * 1.1) * swayAmp * 0.85;
    const swayRoll = Math.sin(this.idleT * 0.9) * swayAmp * 0.6;

    const w = this.weapons[this.active];
    w.rotation.x += this.kickRot.x + swayY * 2;
    w.rotation.y += this.kickRot.y + swayX;
    w.rotation.z += this.kickRot.z + swayRoll;
    w.position.x += this.kickPos.x + swayX;
    w.position.y += this.kickPos.y + swayY;
    w.position.z += this.kickPos.z;

    // Weapon lag: the muzzle trails a fast turn, then whips back into line.
    w.position.x += this.lagYaw * 0.055;
    w.position.y += this.lagPitch * 0.045;
    w.rotation.y += this.lagYaw * 0.5;
    w.rotation.x += this.lagPitch * 0.42;
    w.rotation.z -= this.lagYaw * 0.35;

    // Movement sway: a walk cycle offset that ADS mostly cancels.
    if (!this.reloading) {
      const gait = MathUtils.clamp(this.moveSpeed / 8.6, 0, 1.2) * (1 - this.adsBlend * 0.7);
      if (gait > 0.01) {
        const phase = this.idleT * (6.5 + gait * 4.5);
        w.position.x += Math.cos(phase) * 0.006 * gait - this.moveStrafe * 0.012 * gait;
        w.position.y += Math.sin(phase * 2) * 0.005 * gait;
        w.rotation.z += Math.cos(phase) * 0.02 * gait + this.moveStrafe * 0.035 * gait;
        w.rotation.x += Math.sin(phase * 2) * 0.012 * gait;
      }
      if (this.moveAirborne) {
        w.position.y -= 0.012;
        w.rotation.x -= 0.03;
      }
    }

    // A short, restrained overshoot gives ADS/draw transitions a sense of
    // shoulder weight while the settled ADS pose stays exactly on the reticle
    // marker required by the asset contract.
    if (this.poseTransitionT < 1 && !this.reloading) {
      const settle = Math.sin(this.poseTransitionT * Math.PI);
      const aiming = this.targetPose === 'ads';
      w.position.y -= settle * (aiming ? 0.0055 : 0.008);
      w.position.z += settle * (aiming ? 0.007 : 0.011);
      w.rotation.x += settle * (aiming ? 0.018 : -0.022);
      w.rotation.z += settle * (aiming ? -0.006 : 0.01);
    }

    const returnArc = Math.sin((1 - this.recoilReturn) * Math.PI) * this.recoilReturn;
    w.rotation.x -= returnArc * 0.008;
    w.position.z += returnArc * 0.002;

    // Sprint bob overlay
    if (this.pose === 'sprint' && !this.reloading) {
      const bob = Math.sin(this.idleT * 9.5) * 0.012;
      w.position.y += bob;
      w.rotation.z += Math.sin(this.idleT * 9.5) * 0.03;
    }

    // Reload procedural motion: the rifle dips as the hands take over the
    // physical magazine/charging-handle stages below.
    if (this.reloading && this.active !== 'knife') {
      const u = MathUtils.clamp(this.reloadT / this._reloadDuration, 0, 1);
      // Ease-in/out dip curve
      const dipPhase = u < 0.55 ? u / 0.55 : 1 - (u - 0.55) / 0.45;
      const dip = Math.sin(dipPhase * Math.PI) * (this.emptyReload ? 0.108 : 0.09);
      w.position.y -= dip;
      w.rotation.x += dip * 1.35;
      w.rotation.z += Math.sin(u * Math.PI) * 0.08;
      // A dry reload ends on a bolt release: the receiver snaps forward hard
      // enough to read as a distinct beat from a tactical mag change.
      if (this.emptyReload) {
        const release = this.smoothstepRange(u, 0.82, 0.88)
          * (1 - this.smoothstepRange(u, 0.9, 0.99));
        w.position.z += release * 0.026;
        w.rotation.x -= release * 0.055;
      }
    }

    // Pistol slide recovery / reload lock-back.  Authored rigs own their own
    // mechanisms and are intentionally left alone.
    if (this.active === 'pistol' && !this.authoredRoot) {
      const slide = this.weapons.pistol.getObjectByName('slide');
      if (slide) {
        const kickZ = (slide.userData.kickZ as number | undefined) ?? 0;
        const next = MathUtils.damp(kickZ, 0, 18, clampedDt);
        slide.userData.kickZ = next;
        const baseZ = (slide.userData.baseZ as number | undefined) ?? 0;
        const reloadLock = this.reloading
          ? this.smoothstepRange(this.reloadT / this._reloadDuration, 0.72, 0.9) * 0.032
          : 0;
        slide.position.z = baseZ + Math.max(next, reloadLock);
      }
    }

    this.updateFallbackMechanics(w);

    this.updateCasings(clampedDt);

    // Muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= clampedDt;
      this.positionMuzzle();
      const remaining = Math.max(0, this.flashTimer / this.flashDuration);
      // Flash starts wide and collapses toward the bore instead of holding one
      // random size for its whole life, and aiming pulls it in so the optic is
      // never washed out by the player's own muzzle.
      const collapse = 0.45 + remaining * 0.85;
      const s = (0.65 + this.random() * 0.7) * collapse * (1 + this.heat * 0.35)
        * (1 - this.adsBlend * 0.3);
      this.muzzleFlash.scale.set(
        s * 0.1,
        s * 0.085 * (1.05 + this.heat * 0.25),
        1,
      );
      this.muzzleFlash.material.rotation = this.random() * Math.PI;
      this.muzzleLight.intensity = (5.2 + this.heat * 3.4) * remaining;
      if (this.flashTimer <= 0) {
        this.muzzleFlash.visible = false;
        this.muzzleLight.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }
  }

  /**
   * Integrates the recoil and lag springs. Impulses live in the velocity terms,
   * so the visible weapon rises off the shot, overshoots once and settles.
   */
  private integrateRecoilSprings(dt: number): void {
    let remaining = dt;
    while (remaining > 1e-6) {
      const step = Math.min(MAX_SPRING_SLICE, remaining);
      remaining -= step;

      for (const axis of ['x', 'y', 'z'] as const) {
        this.kickRotVel[axis] +=
          (-RECOIL_ROT_STIFFNESS * this.kickRot[axis] - RECOIL_ROT_DAMPING * this.kickRotVel[axis])
          * step;
        this.kickRot[axis] += this.kickRotVel[axis] * step;
        this.kickPosVel[axis] +=
          (-RECOIL_POS_STIFFNESS * this.kickPos[axis] - RECOIL_POS_DAMPING * this.kickPosVel[axis])
          * step;
        this.kickPos[axis] += this.kickPosVel[axis] * step;
      }

      this.lagYawVel += (-LAG_STIFFNESS * this.lagYaw - LAG_DAMPING * this.lagYawVel) * step;
      this.lagYaw += this.lagYawVel * step;
      this.lagPitchVel += (-LAG_STIFFNESS * this.lagPitch - LAG_DAMPING * this.lagPitchVel) * step;
      this.lagPitch += this.lagPitchVel * step;
    }

    for (const axis of ['x', 'y', 'z'] as const) {
      if (Math.abs(this.kickRot[axis]) < 1e-5 && Math.abs(this.kickRotVel[axis]) < 1e-4) {
        this.kickRot[axis] = 0;
        this.kickRotVel[axis] = 0;
      }
      if (Math.abs(this.kickPos[axis]) < 1e-5 && Math.abs(this.kickPosVel[axis]) < 1e-4) {
        this.kickPos[axis] = 0;
        this.kickPosVel[axis] = 0;
      }
    }
    if (Math.abs(this.lagYaw) < 1e-5 && Math.abs(this.lagYawVel) < 1e-4) {
      this.lagYaw = 0;
      this.lagYawVel = 0;
    }
    if (Math.abs(this.lagPitch) < 1e-5 && Math.abs(this.lagPitchVel) < 1e-4) {
      this.lagPitch = 0;
      this.lagPitchVel = 0;
    }
  }

  private smoothstep(t: number): number {
    const x = MathUtils.clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  private smoothstepRange(value: number, start: number, end: number): number {
    if (end <= start) return value >= end ? 1 : 0;
    return this.smoothstep((value - start) / (end - start));
  }

  /** Records the authored-at-construction transform for a fallback-only part. */
  private tagFallbackNode<T extends Object3D>(node: T, name: string): T {
    node.name = name;
    node.userData.fallbackRestPosition = node.position.clone();
    node.userData.fallbackRestRotation = [node.rotation.x, node.rotation.y, node.rotation.z] as const;
    return node;
  }

  private restoreFallbackNode(node: Object3D | null | undefined): void {
    if (!node) return;
    const position = node.userData.fallbackRestPosition as Vector3 | undefined;
    const rotation = node.userData.fallbackRestRotation as readonly [number, number, number] | undefined;
    if (position) node.position.copy(position);
    if (rotation) node.rotation.set(rotation[0], rotation[1], rotation[2]);
  }

  /** Applies offsets from a stored rest pose, never from last frame's pose. */
  private offsetFallbackNode(
    node: Object3D | null | undefined,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    if (!node) return;
    const position = node.userData.fallbackRestPosition as Vector3 | undefined;
    const rotation = node.userData.fallbackRestRotation as readonly [number, number, number] | undefined;
    if (position) node.position.set(position.x + x, position.y + y, position.z + z);
    if (rotation) node.rotation.set(rotation[0] + rx, rotation[1] + ry, rotation[2] + rz);
  }

  /** Adds a short-lived impulse after a pose offset has already been applied. */
  private nudgeFallbackNode(
    node: Object3D | null | undefined,
    x = 0,
    y = 0,
    z = 0,
    rx = 0,
    ry = 0,
    rz = 0,
  ): void {
    if (!node) return;
    node.position.x += x;
    node.position.y += y;
    node.position.z += z;
    node.rotation.x += rx;
    node.rotation.y += ry;
    node.rotation.z += rz;
  }

  /**
   * Fallback-only hand and mechanism layer.  The authored GLTF path owns every
   * visible limb and mechanism, so this path must remain completely inert once
   * it is installed.
   */
  private updateFallbackMechanics(w: Group): void {
    if (this.authoredRoot) return;

    const supportHand = w.getObjectByName('FallbackSupportHand');
    const firingHand = w.getObjectByName('FallbackFiringHand');
    const supportArm = w.getObjectByName('FallbackSupportArm');
    const firingArm = w.getObjectByName('FallbackFiringArm');
    const supportSeam = w.getObjectByName('FallbackSupportSeam');
    const firingSeam = w.getObjectByName('FallbackFiringSeam');
    const triggerFinger = w.getObjectByName('FallbackTriggerFinger');
    const idleX = Math.sin(this.idleT * 1.12) * 0.0011;
    const idleY = Math.cos(this.idleT * 0.96) * 0.0014;
    const recoil = MathUtils.clamp(this.kickRot.x * 15 + this.triggerPulse * 0.22, 0, 1);

    // Start all limb parts from a known construction pose.  This prevents a
    // reload interrupt or repeated stance changes from drifting the hands away
    // from their grips over a long session.
    this.restoreFallbackNode(supportHand);
    this.restoreFallbackNode(firingHand);
    this.restoreFallbackNode(supportArm);
    this.restoreFallbackNode(firingArm);
    this.restoreFallbackNode(supportSeam);
    this.restoreFallbackNode(firingSeam);
    this.restoreFallbackNode(triggerFinger);

    if (this.pose === 'ads') {
      this.offsetFallbackNode(supportHand, idleX * 0.32, 0.004 + idleY * 0.32, 0.006, 0.035, -0.018, -0.028);
      this.offsetFallbackNode(firingHand, -idleX * 0.22, 0.003 + idleY * 0.22, 0.003, 0.012, 0.008, 0.014);
      this.offsetFallbackNode(supportArm, idleX * 0.2, 0.003, 0.004, 0.025, 0, -0.01);
      this.offsetFallbackNode(firingArm, 0, 0.002, 0.002, 0.012, 0, 0.008);
      this.offsetFallbackNode(supportSeam, idleX * 0.2, 0.003, 0.004, 0.025, 0, -0.01);
      this.offsetFallbackNode(firingSeam, 0, 0.002, 0.002, 0.012, 0, 0.008);
    } else if (this.pose === 'sprint') {
      this.offsetFallbackNode(supportHand, -0.012, -0.024, 0.028, 0.26, -0.05, 0.15);
      this.offsetFallbackNode(firingHand, 0.014, -0.016, 0.018, 0.12, 0.04, -0.08);
      this.offsetFallbackNode(supportArm, -0.014, -0.02, 0.018, 0.2, 0, 0.09);
      this.offsetFallbackNode(firingArm, 0.012, -0.016, 0.012, 0.1, 0, -0.05);
      this.offsetFallbackNode(supportSeam, -0.014, -0.02, 0.018, 0.2, 0, 0.09);
      this.offsetFallbackNode(firingSeam, 0.012, -0.016, 0.012, 0.1, 0, -0.05);
    } else {
      this.offsetFallbackNode(supportHand, idleX, idleY, 0, idleY * 0.7, 0, idleX * 0.8);
      this.offsetFallbackNode(firingHand, -idleX * 0.6, idleY * 0.65, 0, idleY * 0.35, 0, -idleX * 0.4);
      this.offsetFallbackNode(supportArm, idleX * 0.45, idleY * 0.35, 0);
      this.offsetFallbackNode(firingArm, -idleX * 0.25, idleY * 0.3, 0);
      this.offsetFallbackNode(supportSeam, idleX * 0.45, idleY * 0.35, 0);
      this.offsetFallbackNode(firingSeam, -idleX * 0.25, idleY * 0.3, 0);
    }

    // A local trigger squeeze and a tiny firing-arm follow-through make the
    // recoil read through the player's hands instead of only the whole rifle.
    this.nudgeFallbackNode(triggerFinger, 0, 0, 0, -this.triggerPulse * 0.24, 0, 0);
    this.nudgeFallbackNode(firingHand, 0, recoil * 0.0025, recoil * 0.004, recoil * 0.028, 0, -recoil * 0.012);
    this.nudgeFallbackNode(firingArm, 0, recoil * 0.0015, recoil * 0.002, recoil * 0.014, 0, -recoil * 0.006);
    this.nudgeFallbackNode(firingSeam, 0, recoil * 0.0015, recoil * 0.002, recoil * 0.014, 0, -recoil * 0.006);

    if (this.reloading && this.active !== 'knife') {
      this.updateFallbackReloadMechanics(w, MathUtils.clamp(this.reloadT / this._reloadDuration, 0, 1));
    } else {
      this.resetFallbackReloadState(w);
    }
  }

  /** Four readable fallback reload beats: break grip, eject, insert, chamber. */
  private updateFallbackReloadMechanics(w: Group, u: number): void {
    const magazine = w.getObjectByName('magazine');
    const reloadMagazine = w.getObjectByName('FallbackReloadMagazine');
    const emptyMagwell = w.getObjectByName('FallbackOpenMagwell');
    const supportHand = w.getObjectByName('FallbackSupportHand');
    const supportArm = w.getObjectByName('FallbackSupportArm');
    const supportSeam = w.getObjectByName('FallbackSupportSeam');
    const firingHand = w.getObjectByName('FallbackFiringHand');
    const firingArm = w.getObjectByName('FallbackFiringArm');
    const firingSeam = w.getObjectByName('FallbackFiringSeam');
    const chargingHandle = w.getObjectByName('FallbackChargingHandle');
    const boltCarrier = w.getObjectByName('FallbackBoltCarrier');

    // These beats intentionally land on the deterministic QA checkpoints
    // (eject ~0.16, insert ~0.67, chamber ~0.86).  The prior overlapping
    // curves made all three screenshots look like the same lowered rifle.
    const eject = this.smoothstepRange(u, 0.04, 0.15)
      * (1 - this.smoothstepRange(u, 0.28, 0.38));
    // Pull the old magazine well below the receiver for a genuine empty-well
    // silhouette; it is not reused as the fresh magazine until after seating.
    this.offsetFallbackNode(
      magazine,
      -eject * 0.092,
      -eject * 0.36,
      eject * 0.18,
      eject * 0.72,
      eject * 0.26,
      -eject * 0.3,
    );
    if (magazine) magazine.visible = u < 0.34 || u >= 0.79;
    if (emptyMagwell) {
      emptyMagwell.visible = u >= 0.1 && u < 0.79;
      emptyMagwell.scale.setScalar(0.97 + Math.sin(MathUtils.clamp((u - 0.1) / 0.69, 0, 1) * Math.PI) * 0.08);
    }

    // The fresh magazine remains a separate object until late seating, which
    // keeps the insertion checkpoint legible rather than doubling the old mag.
    if (reloadMagazine) {
      const approach = this.smoothstepRange(u, 0.34, 0.78);
      const seat = this.smoothstepRange(u, 0.7, 0.84);
      reloadMagazine.visible = u >= 0.22 && u < 0.82;
      reloadMagazine.position.set(
        -0.235 + approach * 0.16 + seat * 0.075,
        -0.245 + approach * 0.09 + seat * 0.095,
        -0.16 + approach * 0.19 + seat * 0.075,
      );
      reloadMagazine.rotation.set(
        0.7 - approach * 0.62 - seat * 0.08,
        -0.58 + approach * 0.5 + seat * 0.08,
        -0.72 + approach * 0.62 + seat * 0.1,
      );
    }

    const ejectReach = this.smoothstepRange(u, 0.045, 0.13)
      * (1 - this.smoothstepRange(u, 0.26, 0.39));
    const insertReach = this.smoothstepRange(u, 0.32, 0.56)
      * (1 - this.smoothstepRange(u, 0.72, 0.82));
    const handX = -0.048 * ejectReach + 0.068 * insertReach;
    const handY = -0.14 * ejectReach - 0.16 * insertReach;
    const handZ = 0.22 * ejectReach + 0.34 * insertReach;
    const handPitch = 0.6 * ejectReach + 0.76 * insertReach;
    const handYaw = 0.2 * ejectReach + 0.34 * insertReach;
    const handRoll = -0.5 * ejectReach - 0.64 * insertReach;
    this.offsetFallbackNode(
      supportHand,
      handX,
      handY,
      handZ,
      handPitch,
      handYaw,
      handRoll,
    );
    this.offsetFallbackNode(
      supportArm,
      handX * 0.68,
      handY * 0.7,
      handZ * 0.66,
      handPitch * 0.6,
      handYaw * 0.44,
      handRoll * 0.56,
    );
    this.offsetFallbackNode(
      supportSeam,
      handX * 0.68,
      handY * 0.7,
      handZ * 0.66,
      handPitch * 0.6,
      handYaw * 0.44,
      handRoll * 0.56,
    );
    // Firing hand stays indexed to the grip but opens just enough to sell the
    // mag-release/reacquire beats.
    const gripBreak = this.smoothstepRange(u, 0.09, 0.2) * (1 - this.smoothstepRange(u, 0.8, 0.94));
    this.offsetFallbackNode(firingHand, 0.006 * gripBreak, 0.008 * gripBreak, 0.004 * gripBreak, 0.095 * gripBreak, 0, -0.045 * gripBreak);
    this.offsetFallbackNode(firingArm, 0.004 * gripBreak, 0.004 * gripBreak, 0, 0.04 * gripBreak, 0, -0.018 * gripBreak);
    this.offsetFallbackNode(firingSeam, 0.004 * gripBreak, 0.004 * gripBreak, 0, 0.04 * gripBreak, 0, -0.018 * gripBreak);

    // The final chamber check is deliberately late, after the magazine has
    // seated. It is subtle on the pistol and a clearly readable pull/release on
    // the fallback rifle's charging handle.
    const chamber = this.smoothstepRange(u, 0.74, 0.8) * (1 - this.smoothstepRange(u, 0.9, 0.98));
    this.offsetFallbackNode(chargingHandle, -chamber * 0.024, chamber * 0.012, chamber * 0.155, 0.06 * chamber, 0, 0.14 * chamber);
    this.offsetFallbackNode(boltCarrier, 0, 0, chamber * 0.115, 0, 0, 0);
    // The support hand visibly leaves the fresh magazine for the charging
    // handle, completing the final beat instead of the bolt moving alone.
    // This is an additive late-stage reach. `offsetFallbackNode` would reset
    // the magazine-well pose whenever chamber is zero, so use the post-pose
    // nudge helper to preserve the earlier reload beat until this one starts.
    this.nudgeFallbackNode(
      supportHand,
      0.115 * chamber,
      0.046 * chamber,
      0.22 * chamber,
      -0.52 * chamber,
      -0.12 * chamber,
      -0.3 * chamber,
    );
  }

  private resetFallbackReloadState(w: Group): void {
    if (this.authoredRoot) return;
    const magazine = w.getObjectByName('magazine');
    this.restoreFallbackNode(magazine);
    if (magazine) magazine.visible = true;
    const reloadMagazine = w.getObjectByName('FallbackReloadMagazine');
    this.restoreFallbackNode(reloadMagazine);
    if (reloadMagazine) reloadMagazine.visible = false;
    const emptyMagwell = w.getObjectByName('FallbackOpenMagwell');
    this.restoreFallbackNode(emptyMagwell);
    if (emptyMagwell) {
      emptyMagwell.visible = false;
      emptyMagwell.scale.setScalar(1);
    }
    this.restoreFallbackNode(w.getObjectByName('FallbackChargingHandle'));
    this.restoreFallbackNode(w.getObjectByName('FallbackBoltCarrier'));
  }

  private resetMagazine(id: WeaponId): void {
    if (this.authoredRoot) return;
    const mag = this.weapons[id].getObjectByName('magazine');
    if (!mag) return;
    if (mag.userData.fallbackRestPosition) this.restoreFallbackNode(mag);
    else {
      const baseY = (mag.userData.baseY as number | undefined) ?? mag.position.y;
      mag.position.y = baseY;
      mag.rotation.x = 0;
    }
    mag.visible = true;
    this.resetFallbackReloadState(this.weapons[id]);
  }

  private lerpWeaponToPose(id: WeaponId, pose: ViewPose, dt: number): void {
    const w = this.weapons[id];
    const p = POSES[id][pose];
    const speed = POSE_SPEED[pose];
    w.position.x = MathUtils.damp(w.position.x, p.pos[0], speed, dt);
    w.position.y = MathUtils.damp(w.position.y, p.pos[1], speed, dt);
    w.position.z = MathUtils.damp(w.position.z, p.pos[2], speed, dt);
    w.rotation.x = MathUtils.damp(w.rotation.x, p.rot[0], speed, dt);
    w.rotation.y = MathUtils.damp(w.rotation.y, p.rot[1], speed, dt);
    w.rotation.z = MathUtils.damp(w.rotation.z, p.rot[2], speed, dt);
  }

  private applyPoseImmediate(pose: ViewPose): void {
    for (const id of Object.keys(this.weapons) as WeaponId[]) {
      const w = this.weapons[id];
      const p = POSES[id][pose];
      w.position.set(...p.pos);
      w.rotation.set(...p.rot);
    }
    this.pose = pose;
    this.targetPose = pose;
  }

  private playAuthoredPose(pose: ViewPose): void {
    this.playAuthoredClip(VIEWMODEL_ANIMATION_ALIASES[pose], false);
  }

  private playAuthoredClip(aliases: readonly string[], once: boolean): void {
    if (!this.authoredMixer) return;
    const action = [...this.authoredActions]
      .find(([name]) => aliases.some((alias) => name.includes(alias)))?.[1];
    if (!action || (action === this.authoredAction && !once)) return;
    action.reset();
    action.clampWhenFinished = once;
    action.setLoop(once ? LoopOnce : LoopRepeat, once ? 1 : Infinity);
    action.fadeIn(0.08).play();
    if (this.authoredAction && this.authoredAction !== action) this.authoredAction.fadeOut(0.08);
    this.authoredAction = action;
  }

  private removeAuthored(): void {
    if (!this.authoredRoot) return;
    this.authoredMixer?.stopAllAction();
    this.authoredMixer?.uncacheRoot(this.authoredRoot);
    this.authoredRoot.removeFromParent();
    this.authoredRoot = null;
    this.authoredMixer = null;
    this.authoredActions.clear();
    this.authoredAction = null;
    for (const child of this.weapons.ar.children) child.visible = true;
    // The carried fallback magazine is intentionally hidden at rest.  Restoring
    // generic child visibility after an authored swap must not flash it for one
    // frame before the next update.
    this.resetFallbackReloadState(this.weapons.ar);
  }

  private measureAtPose<T>(holder: Group, pose: ViewPose, measure: () => T): T {
    const position = holder.position.clone();
    const quaternion = holder.quaternion.clone();
    const target = POSES.ar[pose];
    holder.position.set(...target.pos);
    holder.rotation.set(...target.rot);
    this.parent.updateMatrixWorld(true);
    this.camera.updateMatrixWorld(true);
    const result = measure();
    holder.position.copy(position);
    holder.quaternion.copy(quaternion);
    this.parent.updateMatrixWorld(true);
    return result;
  }

  private measureVisibleFrameOccupancy(root: Object3D): number {
    const bounds = new Box3().makeEmpty();
    const meshBounds = new Box3();
    root.traverse((node) => {
      if (!isVisibleThrough(node, root)) return;
      const mesh = node as Mesh;
      if (!mesh.isMesh || !mesh.geometry) return;
      if (!mesh.geometry.boundingBox) mesh.geometry.computeBoundingBox();
      if (!mesh.geometry.boundingBox) return;
      meshBounds.copy(mesh.geometry.boundingBox).applyMatrix4(mesh.matrixWorld);
      bounds.union(meshBounds);
    });
    if (bounds.isEmpty()) return 1;
    const min = bounds.min;
    const max = bounds.max;
    const point = new Vector3();
    let minX = Infinity;
    let minY = Infinity;
    let maxX = -Infinity;
    let maxY = -Infinity;
    for (const x of [min.x, max.x]) {
      for (const y of [min.y, max.y]) {
        for (const z of [min.z, max.z]) {
          point.set(x, y, z).project(this.camera);
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);
        }
      }
    }
    const width = Math.max(0, Math.min(1, (maxX + 1) * 0.5) - Math.max(0, (minX + 1) * 0.5));
    const height = Math.max(0, Math.min(1, (maxY + 1) * 0.5) - Math.max(0, (minY + 1) * 0.5));
    return width * height;
  }

  private measureReticleError(marker: Object3D): number {
    const projected = marker.getWorldPosition(new Vector3()).project(this.camera);
    return Math.hypot(projected.x * 960, projected.y * 540);
  }

  // ─── Procedural meshes ───────────────────────────────────────────────────

  private mesh(
    geo: BufferGeometry,
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
    sx = 1,
    sy = 1,
    sz = 1,
  ): Mesh {
    const m = new Mesh(geo, material);
    m.position.set(x, y, z);
    m.scale.set(sx, sy, sz);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  /** A centered beveled box avoids the toy-block catchlight of BoxGeometry. */
  private roundedBoxGeometry(width: number, height: number, depth: number, radius = 0.006): ExtrudeGeometry {
    const r = Math.min(radius, width * 0.45, height * 0.45);
    const left = -width * 0.5;
    const right = width * 0.5;
    const bottom = -height * 0.5;
    const top = height * 0.5;
    const shape = new Shape();
    shape.moveTo(left + r, bottom);
    shape.lineTo(right - r, bottom);
    shape.quadraticCurveTo(right, bottom, right, bottom + r);
    shape.lineTo(right, top - r);
    shape.quadraticCurveTo(right, top, right - r, top);
    shape.lineTo(left + r, top);
    shape.quadraticCurveTo(left, top, left, top - r);
    shape.lineTo(left, bottom + r);
    shape.quadraticCurveTo(left, bottom, left + r, bottom);
    const geometry = new ExtrudeGeometry(shape, {
      depth,
      bevelEnabled: true,
      bevelSegments: 2,
      bevelSize: Math.min(r * 0.55, 0.004),
      bevelThickness: Math.min(r * 0.55, 0.004),
      curveSegments: 4,
    });
    geometry.translate(0, 0, -depth * 0.5);
    return geometry;
  }

  private roundedMesh(
    material: MeshStandardMaterial,
    x: number,
    y: number,
    z: number,
    width: number,
    height: number,
    depth: number,
    radius = 0.006,
  ): Mesh {
    return this.mesh(this.roundedBoxGeometry(width, height, depth, radius), material, x, y, z);
  }

  private capsule(
    material: MeshStandardMaterial,
    radius: number,
    length: number,
    x: number,
    y: number,
    z: number,
    axis: 'x' | 'y' | 'z' = 'z',
  ): Mesh {
    const m = new Mesh(new CapsuleGeometry(radius, Math.max(0.001, length), 5, 10), material);
    if (axis === 'z') m.rotation.x = Math.PI * 0.5;
    if (axis === 'x') m.rotation.z = -Math.PI * 0.5;
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  /** Side-facing screw head / selector cap. */
  private disc(
    material: MeshStandardMaterial,
    radius: number,
    depth: number,
    x: number,
    y: number,
    z: number,
    segments = 10,
  ): Mesh {
    const m = new Mesh(new CylinderGeometry(radius, radius, depth, segments), material);
    m.rotation.z = Math.PI * 0.5;
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  private cyl(
    material: MeshStandardMaterial,
    rTop: number,
    rBot: number,
    len: number,
    x: number,
    y: number,
    z: number,
    segments = 10,
  ): Mesh {
    const m = new Mesh(new CylinderGeometry(rTop, rBot, len, segments), material);
    m.rotation.x = Math.PI / 2;
    m.position.set(x, y, z);
    m.castShadow = false;
    m.receiveShadow = false;
    return m;
  }

  private addPicatinny(parent: Group, zStart: number, count: number, y: number, width = 0.048): void {
    for (let i = 0; i < count; i++) {
      parent.add(
        this.roundedMesh(this.railTooth, 0, y, zStart + i * 0.028, width, 0.010, 0.014, 0.0025),
      );
      // Side undercuts for rail channels
      parent.add(
        this.mesh(new BoxGeometry(0.006, 0.008, 0.014), this.nitride, width * 0.48, y - 0.006, zStart + i * 0.028),
      );
      parent.add(
        this.mesh(new BoxGeometry(0.006, 0.008, 0.014), this.nitride, -width * 0.48, y - 0.006, zStart + i * 0.028),
      );
    }
  }

  /** Short Picatinny run on a handguard side or bottom face. */
  private addSidePicatinny(
    parent: Group,
    x: number,
    y: number,
    zStart: number,
    count: number,
    axis: 'x' | 'y' = 'x',
  ): void {
    for (let i = 0; i < count; i++) {
      const z = zStart + i * 0.028;
      const tooth = this.roundedMesh(this.railTooth, x, y, z, 0.014, 0.012, 0.014, 0.002);
      if (axis === 'y') tooth.rotation.x = Math.PI * 0.5;
      parent.add(tooth);
    }
  }

  /** Three-prong muzzle device with a stepped collar and visible port bands. */
  private addMuzzleDevice(parent: Group, y: number, z: number): void {
    parent.add(this.cyl(this.nitride, 0.024, 0.021, 0.082, 0, y, z - 0.04, 18));
    parent.add(this.cyl(this.nitrideWorn, 0.021, 0.019, 0.028, 0, y, z - 0.002, 18));
    const collar = new Mesh(new TorusGeometry(0.0215, 0.0032, 8, 18), this.steelBright);
    collar.position.set(0, y, z - 0.012);
    parent.add(collar);
    const crown = new Mesh(new TorusGeometry(0.0175, 0.0038, 8, 18), this.steelBright);
    crown.position.set(0, y, z - 0.078);
    parent.add(crown);
    for (let i = 0; i < 3; i++) {
      const angle = (i / 3) * Math.PI * 2;
      const prong = this.roundedMesh(
        this.steelBright,
        Math.sin(angle) * 0.014,
        y + Math.cos(angle) * 0.014,
        z - 0.068,
        0.007,
        0.022,
        0.012,
        0.0018,
      );
      prong.rotation.z = angle;
      parent.add(prong);
    }
    for (let i = 0; i < 3; i++) {
      parent.add(this.roundedMesh(this.steelBright, 0, y + 0.034, z - 0.028 - i * 0.018, 0.028, 0.007, 0.011, 0.002));
    }
    parent.add(this.cyl(this.steelBright, 0.019, 0.02, 0.016, 0, y, z - 0.074, 16));
    parent.add(this.disc(this.nitrideWorn, 0.019, 0.004, 0, y, z + 0.006, 12));
  }

  /** Stepped micro-optic with mount claws, turrets and a short sunshade. */
  private addMicroOptic(parent: Group, y: number, z: number): Group {
    const optic = new Group();
    optic.name = 'FallbackMicroOptic';
    optic.add(this.roundedMesh(this.nitrideWorn, 0, y + 0.011, z, 0.056, 0.018, 0.074, 0.004));
    optic.add(this.roundedMesh(this.steel, 0, y - 0.004, z, 0.048, 0.008, 0.062, 0.003));
    for (const sx of [-0.021, 0.021]) {
      optic.add(this.roundedMesh(this.opticHousing, sx, y + 0.022, z, 0.013, 0.026, 0.04, 0.003));
      optic.add(this.disc(this.steelBright, 0.0045, 0.008, sx, y - 0.002, z + 0.012, 10));
    }
    optic.add(this.cyl(this.opticHousing, 0.028, 0.029, 0.082, 0, y + 0.044, z, 18));
    for (const tz of [z + 0.028, z - 0.028]) {
      const ring = new Mesh(new TorusGeometry(0.025, 0.0018, 8, 18), this.nitrideWorn);
      ring.position.set(0, y + 0.044, tz);
      optic.add(ring);
    }
    const rearRim = new Mesh(new TorusGeometry(0.0252, 0.0019, 8, 18), this.nitrideWorn);
    rearRim.position.set(0, y + 0.044, z + 0.042);
    optic.add(rearRim);
    const frontRim = new Mesh(new TorusGeometry(0.0255, 0.0016, 8, 18), this.nitride);
    frontRim.position.set(0, y + 0.044, z - 0.042);
    optic.add(frontRim);
    const rearLens = this.cyl(this.opticGlass, 0.022, 0.022, 0.003, 0, y + 0.044, z + 0.044, 18);
    rearLens.name = 'FallbackOpticSmokedLens';
    rearLens.renderOrder = 2;
    optic.add(rearLens);
    optic.add(this.cyl(this.opticGlass, 0.0215, 0.0215, 0.003, 0, y + 0.044, z - 0.044, 18));
    optic.add(this.disc(this.gripRubber, 0.009, 0.012, 0.034, y + 0.044, z - 0.004, 12));
    optic.add(this.disc(this.steelBright, 0.004, 0.014, 0.039, y + 0.044, z - 0.004, 10));
    for (let i = 0; i < 5; i++) {
      const knurl = this.roundedMesh(this.gripRubber, 0.035, y + 0.044, z - 0.004 + (i - 2) * 0.004, 0.003, 0.008, 0.003, 0.001);
      optic.add(knurl);
    }
    optic.add(this.disc(this.gripRubber, 0.007, 0.01, -0.033, y + 0.059, z - 0.018, 12));
    for (let i = 0; i < 4; i++) {
      optic.add(this.roundedMesh(this.gripRubber, -0.033, y + 0.059, z - 0.022 + i * 0.004, 0.003, 0.007, 0.003, 0.001));
    }
    optic.add(this.roundedMesh(this.opticHousing, 0, y + 0.065, z - 0.018, 0.038, 0.008, 0.05, 0.003));
    optic.add(this.roundedMesh(this.nitride, 0, y + 0.072, z - 0.022, 0.034, 0.006, 0.038, 0.0025));

    const reticle = new Group();
    reticle.name = 'FallbackOpticReticle';
    reticle.position.set(0, y + 0.044, z + 0.047);
    const reticleRing = new Mesh(new TorusGeometry(0.0048, 0.0008, 6, 12), this.reticleGlow);
    reticleRing.renderOrder = 3;
    reticle.add(reticleRing);
    const reticleDot = new Mesh(new SphereGeometry(0.0018, 10, 10), this.reticleGlow);
    reticleDot.renderOrder = 3;
    reticle.add(reticleDot);
    optic.add(reticle);
    parent.add(optic);
    return optic;
  }

  /**
   * Fallback hand silhouette.  The hand remains deliberately modest in scope
   * (the authored rifle-and-arms GLTF still owns release presentation), but its
   * palm, metacarpals, joints and thumb now read as a gloved hand instead of a
   * tan capsule ending in a black sphere.
   */
  private addGlovedHand(
    parent: Group,
    x: number,
    y: number,
    z: number,
    roll = 0,
    pose: 'support' | 'firing' = 'support',
  ): Group {
    const hand = new Group();
    hand.position.set(x, y, z);
    hand.rotation.z = roll;
    this.tagFallbackNode(hand, pose === 'firing' ? 'FallbackFiringHand' : 'FallbackSupportHand');

    const cuff = this.capsule(this.sleeve, 0.04, 0.1, 0, -0.064, 0.055);
    cuff.rotation.z = -0.16;
    hand.add(cuff);
    const cuffBand = this.roundedMesh(this.gloveReinforcement, 0, -0.028, 0.02, 0.078, 0.018, 0.026, 0.005);
    cuffBand.rotation.x = 0.12;
    hand.add(cuffBand);
    const wrist = this.roundedMesh(this.glove, 0, 0.002, 0.0, 0.074, 0.052, 0.064, 0.012);
    wrist.rotation.x = 0.22;
    hand.add(wrist);
    const palm = this.roundedMesh(this.glove, 0, 0.024, -0.037, 0.084, 0.049, 0.075, 0.016);
    palm.rotation.x = -0.14;
    hand.add(palm);
    const dorsalPlate = this.roundedMesh(this.gloveReinforcement, 0, 0.052, -0.035, 0.07, 0.013, 0.052, 0.005);
    dorsalPlate.rotation.x = -0.18;
    hand.add(dorsalPlate);
    // Thin stitched cuff breaks turn the forearm-to-glove transition into soft
    // equipment rather than a single gray capsule at the edge of the frame.
    for (let i = 0; i < 3; i++) {
      const cuffStitch = this.roundedMesh(this.polymerSoft, 0, -0.044 - i * 0.016, 0.032, 0.058, 0.0035, 0.008, 0.0015);
      cuffStitch.rotation.x = 0.12;
      hand.add(cuffStitch);
    }

    // Separated two-joint fingers produce a recognisable gripping silhouette
    // under the close camera without requiring a rig in the fallback path.
    for (let i = 0; i < 4; i++) {
      const finger = new Group();
      // Only the trigger finger is driven at runtime. The rest stay anonymous
      // so static batching can fold them into the hand they belong to.
      if (pose === 'firing' && i === 1) this.tagFallbackNode(finger, 'FallbackTriggerFinger');
      const fingerX = -0.027 + i * 0.018;
      const curl = pose === 'firing' ? -0.52 - i * 0.035 : -0.32 - i * 0.025;
      const proximal = this.capsule(this.glove, 0.0085, 0.026, fingerX, 0.028, -0.077);
      proximal.rotation.x += curl;
      finger.add(proximal);
      const distal = this.capsule(this.glove, 0.0075, 0.021, fingerX, 0.019, -0.102);
      distal.rotation.x += curl - 0.15;
      finger.add(distal);
      const knuckle = this.roundedMesh(this.gloveReinforcement, fingerX, 0.049, -0.067, 0.014, 0.011, 0.017, 0.003);
      knuckle.rotation.x = -0.2;
      finger.add(knuckle);
      const fingerPlate = this.roundedMesh(this.gloveReinforcement, fingerX, 0.037, -0.09, 0.011, 0.006, 0.022, 0.0025);
      fingerPlate.rotation.x = curl - 0.1;
      finger.add(fingerPlate);
      hand.add(finger);
    }
    const thumbBase = this.capsule(this.glove, 0.0105, 0.026, 0.043, 0.007, -0.025, 'x');
    thumbBase.rotation.y = pose === 'firing' ? -0.48 : -0.3;
    thumbBase.rotation.z += -0.45;
    hand.add(thumbBase);
    const thumbTip = this.capsule(this.glove, 0.009, 0.021, 0.052, 0.013, -0.048, 'x');
    thumbTip.rotation.y = pose === 'firing' ? -0.66 : -0.5;
    thumbTip.rotation.z += -0.62;
    hand.add(thumbTip);
    const thumbGuard = this.roundedMesh(this.gloveReinforcement, 0.046, 0.026, -0.04, 0.016, 0.01, 0.026, 0.003);
    thumbGuard.rotation.y = pose === 'firing' ? -0.56 : -0.4;
    thumbGuard.rotation.z = -0.44;
    hand.add(thumbGuard);
    parent.add(hand);
    return hand;
  }

  /** Fresh magazine carried by the procedural support hand during reload. */
  private buildReloadMagazine(id: 'ar' | 'pistol'): Group {
    const mag = this.tagFallbackNode(new Group(), 'FallbackReloadMagazine');
    if (id === 'ar') {
      mag.add(this.roundedMesh(this.polymerGrit, 0, 0, 0, 0.05, 0.145, 0.071, 0.01));
      mag.add(this.roundedMesh(this.fde, 0, -0.075, 0, 0.055, 0.013, 0.077, 0.004));
      mag.add(this.roundedMesh(this.steelBright, 0.024, 0.005, 0, 0.006, 0.096, 0.032, 0.002));
      mag.add(this.roundedMesh(this.polymerSoft, -0.024, 0, 0, 0.005, 0.11, 0.055, 0.002));
    } else {
      const body = this.mesh(new BoxGeometry(0.03, 0.105, 0.038), this.polymer, 0, 0, 0);
      body.rotation.x = 0.3;
      mag.add(body);
      const base = this.mesh(new BoxGeometry(0.034, 0.012, 0.042), this.polymerSoft, 0, -0.06, 0.015);
      base.rotation.x = 0.3;
      mag.add(base);
    }
    mag.visible = false;
    return mag;
  }

  private buildAssaultRifle(): Group {
    const g = new Group();
    g.name = 'ViewAR';

    const adsReticle = new Object3D();
    adsReticle.name = 'ADS_RETICLE';
    adsReticle.userData.adsReticle = true;
    adsReticle.position.set(0, 0.132, -0.054);
    g.add(adsReticle);

    // Receiver is the dominant on-screen mass: rounded, stepped forms give it
    // an actual machined silhouette instead of the previous monolithic block.
    g.add(this.roundedMesh(this.nitride, 0, -0.004, 0.02, 0.071, 0.058, 0.205, 0.009));
    g.add(this.roundedMesh(this.nitrideWorn, 0, 0.041, -0.052, 0.068, 0.054, 0.27, 0.008));
    const receiverSpine = this.roundedMesh(this.steel, 0, 0.073, -0.058, 0.047, 0.012, 0.29, 0.004);
    g.add(receiverSpine);
    // Ejection port is a recessed, bright-edged opening rather than a side box.
    g.add(this.roundedMesh(this.steel, 0.036, 0.037, -0.012, 0.008, 0.027, 0.06, 0.003));
    g.add(this.roundedMesh(this.polymerGrit, 0.0405, 0.037, -0.012, 0.004, 0.019, 0.046, 0.0015));
    g.add(this.disc(this.steelBright, 0.0065, 0.007, 0.039, 0.053, 0.044));
    // Separate carrier gives the chamber beat a visible receiver movement,
    // instead of relying on a tiny charging-handle translation alone.
    const boltCarrier = this.tagFallbackNode(new Group(), 'FallbackBoltCarrier');
    boltCarrier.add(this.roundedMesh(this.steelBright, 0.035, 0.037, -0.016, 0.005, 0.017, 0.042, 0.0018));
    boltCarrier.add(this.roundedMesh(this.nitride, 0.039, 0.037, -0.016, 0.003, 0.012, 0.035, 0.0012));
    g.add(boltCarrier);
    // Mirror the high-level machined read on the camera-facing side: this makes
    // the receiver legible whether a future authored pose rolls left or right.
    g.add(this.roundedMesh(this.nitrideWorn, -0.037, 0.027, -0.038, 0.006, 0.028, 0.135, 0.0025));
    g.add(this.roundedMesh(this.steel, -0.041, 0.046, -0.028, 0.004, 0.007, 0.115, 0.0015));
    for (const z of [-0.085, -0.015, 0.052]) {
      g.add(this.disc(this.steelBright, 0.004, 0.006, -0.041, 0.012, z, 8));
    }
    for (const z of [-0.06, 0.02, 0.08]) {
      g.add(this.roundedMesh(this.nitrideWorn, 0.036, 0.018, z, 0.004, 0.014, 0.028, 0.0015));
    }

    // Forward assist / bolt catch bumps
    g.add(this.mesh(new BoxGeometry(0.014, 0.018, 0.02), this.steelBright, 0.038, 0.02, 0.06));
    g.add(this.mesh(new BoxGeometry(0.012, 0.016, 0.016), this.steelBright, -0.036, -0.01, 0.04));

    // Top rail base + Picatinny teeth
    g.add(this.roundedMesh(this.steel, 0, 0.078, -0.08, 0.054, 0.016, 0.34, 0.0035));
    this.addPicatinny(g, -0.22, 12, 0.086);
    g.add(this.roundedMesh(this.steelBright, -0.027, 0.089, -0.082, 0.006, 0.005, 0.314, 0.0018));
    g.add(this.roundedMesh(this.steelBright, 0.027, 0.089, -0.082, 0.006, 0.005, 0.314, 0.0018));

    // Barrel — stepped profile with higher segment count on the hero tube.
    g.add(this.cyl(this.steel, 0.014, 0.016, 0.12, 0, 0.028, -0.31, 18));
    g.add(this.cyl(this.steel, 0.013, 0.014, 0.11, 0, 0.028, -0.42, 18));
    g.add(this.cyl(this.nitrideWorn, 0.016, 0.017, 0.08, 0, 0.028, -0.5, 16));
    for (const z of [-0.34, -0.41, -0.48]) {
      g.add(this.roundedMesh(this.nitrideWorn, 0, 0.041, z, 0.028, 0.004, 0.012, 0.0015));
    }

    // Gas block
    g.add(this.roundedMesh(this.nitride, 0, 0.05, -0.46, 0.034, 0.04, 0.038, 0.005));
    g.add(this.cyl(this.steel, 0.006, 0.006, 0.05, 0, 0.072, -0.42, 8));

    // Muzzle device: prong cage, collar and compensator ports.
    this.addMuzzleDevice(g, 0.028, -0.575);

    // Ten-sided free-float handguard with side/bottom rails and M-LOK cutouts.
    g.add(this.cyl(this.polymer, 0.043, 0.047, 0.245, 0, 0.013, -0.285, 10));
    g.add(this.roundedMesh(this.polymerGrit, 0, -0.026, -0.285, 0.054, 0.013, 0.218, 0.004));
    g.add(this.roundedMesh(this.fde, 0, 0.048, -0.285, 0.052, 0.008, 0.202, 0.0025));
    g.add(this.roundedMesh(this.nitrideWorn, 0, 0.048, -0.395, 0.048, 0.006, 0.034, 0.002));

    // Side rails with short Picatinny teeth
    g.add(this.roundedMesh(this.steel, 0.037, 0.018, -0.28, 0.010, 0.028, 0.2, 0.0025));
    g.add(this.roundedMesh(this.steel, -0.037, 0.018, -0.28, 0.010, 0.028, 0.2, 0.0025));
    this.addSidePicatinny(g, 0.04, 0.018, -0.36, 5);
    this.addSidePicatinny(g, -0.04, 0.018, -0.36, 5);
    g.add(this.roundedMesh(this.steel, 0, -0.034, -0.28, 0.048, 0.008, 0.19, 0.0025));
    this.addPicatinny(g, -0.36, 4, -0.038, 0.042);

    // M-LOK handguard slots (vent cutouts) and QD sling nubs
    for (let i = 0; i < 6; i++) {
      const z = -0.38 + i * 0.036;
      g.add(this.roundedMesh(this.nitride, 0.033, -0.004, z, 0.014, 0.005, 0.022, 0.002));
      g.add(this.roundedMesh(this.nitride, -0.033, -0.004, z, 0.014, 0.005, 0.022, 0.002));
      g.add(this.roundedMesh(this.nitride, 0, -0.034, z, 0.021, 0.005, 0.02, 0.002));
      g.add(this.roundedMesh(this.polymerGrit, 0.033, -0.001, z, 0.011, 0.003, 0.018, 0.0015));
      g.add(this.roundedMesh(this.polymerGrit, -0.033, -0.001, z, 0.011, 0.003, 0.018, 0.0015));
      if (i % 2 === 0) {
        g.add(this.roundedMesh(this.nitrideWorn, -0.045, 0.012, z, 0.004, 0.015, 0.017, 0.0015));
        g.add(this.roundedMesh(this.steelBright, 0.048, 0.008, z, 0.005, 0.005, 0.008, 0.001));
        g.add(this.roundedMesh(this.steelBright, -0.048, 0.008, z, 0.005, 0.005, 0.008, 0.001));
      }
    }

    // Magwell flare — nested funnel, worn contact edges and release wings.
    g.add(this.roundedMesh(this.nitrideWorn, 0, -0.04, -0.015, 0.062, 0.042, 0.08, 0.008));
    g.add(this.roundedMesh(this.steel, 0, -0.062, -0.015, 0.07, 0.018, 0.088, 0.005));
    g.add(this.roundedMesh(this.fde, 0, -0.072, -0.015, 0.072, 0.008, 0.09, 0.0025));
    g.add(this.roundedMesh(this.nitride, 0, -0.088, -0.015, 0.048, 0.022, 0.06, 0.006));
    g.add(this.roundedMesh(this.polymerGrit, 0, -0.102, -0.018, 0.036, 0.014, 0.048, 0.004));
    for (const sx of [-0.034, 0.034]) {
      g.add(this.roundedMesh(this.nitrideWorn, sx, -0.058, -0.015, 0.006, 0.024, 0.042, 0.002));
    }
    g.add(this.roundedMesh(this.steelBright, 0.038, -0.028, 0.018, 0.008, 0.012, 0.006, 0.0015));

    // Magazine is an assembly rather than one moving mesh: body, baseplate,
    // witness window and ribs now travel together through the reload arc.
    const mag = this.tagFallbackNode(new Group(), 'magazine');
    mag.add(this.roundedMesh(this.polymerGrit, 0, -0.145, -0.015, 0.05, 0.145, 0.071, 0.01));
    // Mag baseplate — FDE
    mag.add(this.roundedMesh(this.fde, 0, -0.22, -0.015, 0.055, 0.013, 0.077, 0.004));
    // Mag witness window stripe
    mag.add(this.roundedMesh(this.steelBright, 0.024, -0.14, -0.015, 0.006, 0.096, 0.032, 0.002));
    // Wide ribs and a rear spine make the magazine look like a distinct molded
    // component at hip scale instead of a hanging black rectangular void.
    mag.add(this.roundedMesh(this.polymerSoft, -0.024, -0.145, -0.015, 0.005, 0.11, 0.055, 0.002));
    for (let i = 0; i < 3; i++) {
      const rib = this.roundedMesh(this.nitrideWorn, 0.026, -0.10 - i * 0.037, -0.016, 0.005, 0.009, 0.05, 0.0015);
      mag.add(rib);
    }
    g.add(mag);

    // A recessed, temporarily visible magazine well gives the ejection beat a
    // readable empty cavity instead of making the magazine simply disappear.
    const emptyMagwell = this.tagFallbackNode(new Group(), 'FallbackOpenMagwell');
    emptyMagwell.add(this.roundedMesh(this.nitride, 0, -0.14, -0.015, 0.043, 0.09, 0.06, 0.008));
    emptyMagwell.add(this.roundedMesh(this.polymerGrit, 0, -0.148, -0.018, 0.033, 0.07, 0.051, 0.004));
    emptyMagwell.add(this.roundedMesh(this.steelBright, 0, -0.096, -0.015, 0.052, 0.006, 0.064, 0.0018));
    emptyMagwell.add(this.roundedMesh(this.nitride, 0, -0.118, -0.012, 0.028, 0.038, 0.042, 0.004));
    emptyMagwell.visible = false;
    g.add(emptyMagwell);
    g.add(this.buildReloadMagazine('ar'));

    // Pistol grip (angled, textured panels)
    const grip = this.roundedMesh(this.polymerGrit, 0, -0.105, 0.085, 0.041, 0.117, 0.056, 0.009);
    grip.rotation.x = 0.38;
    g.add(grip);
    const gripPanel = this.mesh(new BoxGeometry(0.042, 0.08, 0.01), this.fde, 0.02, -0.1, 0.085);
    gripPanel.rotation.x = 0.38;
    g.add(gripPanel);
    const gripPanelL = this.mesh(new BoxGeometry(0.042, 0.08, 0.01), this.fde, -0.02, -0.1, 0.085);
    gripPanelL.rotation.x = 0.38;
    g.add(gripPanelL);
    // Grip backstrap ridges
    for (let i = 0; i < 4; i++) {
      const ridge = this.mesh(new BoxGeometry(0.034, 0.01, 0.008), this.polymerSoft, 0, -0.07 - i * 0.022, 0.11);
      ridge.rotation.x = 0.38;
      g.add(ridge);
    }

    // Buffer tube
    g.add(this.cyl(this.steelBright, 0.016, 0.016, 0.14, 0, 0.025, 0.18, 10));
    // Stock body
    g.add(this.roundedMesh(this.polymer, 0, 0.02, 0.28, 0.05, 0.057, 0.145, 0.009));
    g.add(this.roundedMesh(this.polymerGrit, 0, -0.005, 0.35, 0.064, 0.097, 0.034, 0.009));
    // Stock cheek weld — FDE
    g.add(this.mesh(new BoxGeometry(0.05, 0.025, 0.1), this.fde, 0, 0.045, 0.28));
    // Stock buttpad
    g.add(this.mesh(new BoxGeometry(0.066, 0.1, 0.014), this.polymerGrit, 0, -0.005, 0.37));

    // Trigger guard + trigger
    g.add(this.mesh(new BoxGeometry(0.028, 0.032, 0.048), this.nitrideWorn, 0, -0.038, 0.055));
    g.add(this.mesh(new BoxGeometry(0.006, 0.022, 0.01), this.steelBright, 0, -0.042, 0.058));
    // Mag release button
    g.add(this.cyl(this.steelBright, 0.006, 0.006, 0.02, 0.032, -0.02, 0.02, 6));

    // Sealed micro-optic with mount claws, turrets and a short sunshade.
    this.addMicroOptic(g, 0.088, -0.02);

    // Backup iron sights (rear + front, subtle emissive)
    g.add(this.mesh(new BoxGeometry(0.028, 0.018, 0.014), this.steel, 0, 0.095, 0.08));
    g.add(this.roundedMesh(this.ironGlow, -0.007, 0.106, 0.08, 0.004, 0.009, 0.004, 0.001));
    g.add(this.roundedMesh(this.ironGlow, 0.007, 0.106, 0.08, 0.004, 0.009, 0.004, 0.001));
    g.add(this.mesh(new BoxGeometry(0.01, 0.022, 0.01), this.steel, 0, 0.09, -0.48));
    g.add(this.roundedMesh(this.ironGlow, 0, 0.103, -0.48, 0.0035, 0.008, 0.0035, 0.0008));

    // Charging handle grouped for the late reload chamber-check beat.
    const chargingHandle = this.tagFallbackNode(new Group(), 'FallbackChargingHandle');
    chargingHandle.add(this.mesh(new BoxGeometry(0.085, 0.012, 0.018), this.steelBright, 0, 0.068, 0.09));
    chargingHandle.add(this.mesh(new BoxGeometry(0.016, 0.014, 0.02), this.steel, 0.04, 0.068, 0.09));
    chargingHandle.add(this.mesh(new BoxGeometry(0.016, 0.014, 0.02), this.steel, -0.04, 0.068, 0.09));
    g.add(chargingHandle);

    // Fire selector + pin details
    g.add(this.mesh(new BoxGeometry(0.01, 0.01, 0.004), this.steelBright, 0.034, 0.01, 0.07));
    g.add(this.cyl(this.steel, 0.004, 0.004, 0.01, 0.034, 0.0, 0.05, 6));

    // Layered soft-goods use rounded volumes and seams so the player reads as
    // a body holding the rifle instead of two cylinders glued to a receiver.
    const supportArm = this.capsule(this.sleeve, 0.044, 0.25, -0.078, -0.118, -0.19);
    supportArm.rotation.z = -0.16;
    this.tagFallbackNode(supportArm, 'FallbackSupportArm');
    g.add(supportArm);
    const supportSeam = this.roundedMesh(this.polymerSoft, -0.095, -0.1, -0.125, 0.02, 0.108, 0.1, 0.006);
    supportSeam.rotation.z = -0.16;
    this.tagFallbackNode(supportSeam, 'FallbackSupportSeam');
    g.add(supportSeam);
    const firingArm = this.capsule(this.sleeve, 0.05, 0.22, 0.09, -0.155, 0.2);
    firingArm.rotation.z = 0.12;
    this.tagFallbackNode(firingArm, 'FallbackFiringArm');
    g.add(firingArm);
    const firingSeam = this.roundedMesh(this.polymerSoft, 0.108, -0.137, 0.145, 0.022, 0.1, 0.09, 0.006);
    firingSeam.rotation.z = 0.12;
    this.tagFallbackNode(firingSeam, 'FallbackFiringSeam');
    g.add(firingSeam);
    // Readable cuffs, articulated fingers and knuckle plates layer over the grips.
    this.addGlovedHand(g, -0.055, -0.07, -0.34, -0.08);
    this.addGlovedHand(g, 0.045, -0.08, 0.075, 0.1, 'firing');

    return g;
  }

  private buildPistol(): Group {
    const g = new Group();
    g.name = 'ViewPistol';

    // Slide group (animates on fire)
    const slide = new Group();
    slide.name = 'slide';
    slide.userData.baseZ = 0;
    slide.userData.kickZ = 0;

    slide.add(this.mesh(new BoxGeometry(0.044, 0.042, 0.195), this.nitride, 0, 0.042, -0.05));
    // Slide top flats
    slide.add(this.mesh(new BoxGeometry(0.04, 0.008, 0.18), this.nitrideWorn, 0, 0.065, -0.05));
    // Rear serrations
    for (let i = 0; i < 7; i++) {
      slide.add(
        this.mesh(new BoxGeometry(0.046, 0.022, 0.006), this.steel, 0, 0.052, 0.025 + i * 0.01),
      );
    }
    // Front serrations
    for (let i = 0; i < 4; i++) {
      slide.add(
        this.mesh(new BoxGeometry(0.046, 0.016, 0.005), this.steel, 0, 0.055, -0.12 - i * 0.01),
      );
    }
    // Ejection port cut
    slide.add(this.mesh(new BoxGeometry(0.02, 0.018, 0.04), this.steelBright, 0.014, 0.05, -0.02));
    // Rear sight
    slide.add(this.mesh(new BoxGeometry(0.032, 0.014, 0.014), this.steel, 0, 0.072, 0.04));
    slide.add(this.mesh(new BoxGeometry(0.006, 0.012, 0.006), this.ironGlow, -0.008, 0.082, 0.04));
    slide.add(this.mesh(new BoxGeometry(0.006, 0.012, 0.006), this.ironGlow, 0.008, 0.082, 0.04));
    // Front sight
    slide.add(this.mesh(new BoxGeometry(0.008, 0.018, 0.01), this.steel, 0, 0.074, -0.135));
    slide.add(this.mesh(new BoxGeometry(0.005, 0.008, 0.005), this.ironGlow, 0, 0.086, -0.135));

    g.add(slide);

    // Frame
    g.add(this.mesh(new BoxGeometry(0.04, 0.038, 0.155), this.polymer, 0, 0.008, -0.025));
    // Dust cover / rail under barrel
    g.add(this.mesh(new BoxGeometry(0.036, 0.014, 0.08), this.polymerGrit, 0, -0.008, -0.1));
    // Accessory rail teeth
    for (let i = 0; i < 4; i++) {
      g.add(this.mesh(new BoxGeometry(0.03, 0.006, 0.01), this.railTooth, 0, -0.016, -0.08 - i * 0.016));
    }

    // Barrel + bushing (slightly thicker silhouette)
    g.add(this.cyl(this.steel, 0.011, 0.012, 0.13, 0, 0.04, -0.155, 10));
    g.add(this.cyl(this.nitride, 0.015, 0.014, 0.022, 0, 0.04, -0.235, 10));
    // Recoil spring guide tip
    g.add(this.cyl(this.steelBright, 0.005, 0.005, 0.04, 0, 0.022, -0.14, 6));

    // Magwell
    g.add(this.mesh(new BoxGeometry(0.038, 0.03, 0.045), this.polymerSoft, 0, -0.04, 0.035));
    g.add(this.mesh(new BoxGeometry(0.042, 0.01, 0.05), this.nitrideWorn, 0, -0.055, 0.038));

    // Grip
    const grip = this.mesh(new BoxGeometry(0.036, 0.118, 0.052), this.polymerGrit, 0, -0.075, 0.045);
    grip.rotation.x = 0.3;
    g.add(grip);
    // Grip texture panels
    const gpR = this.mesh(new BoxGeometry(0.006, 0.09, 0.04), this.polymer, 0.018, -0.07, 0.045);
    gpR.rotation.x = 0.3;
    g.add(gpR);
    const gpL = this.mesh(new BoxGeometry(0.006, 0.09, 0.04), this.polymer, -0.018, -0.07, 0.045);
    gpL.rotation.x = 0.3;
    g.add(gpL);
    // Backstrap stipple ridges
    for (let i = 0; i < 5; i++) {
      const r = this.mesh(new BoxGeometry(0.03, 0.008, 0.006), this.polymerSoft, 0, -0.04 - i * 0.018, 0.07);
      r.rotation.x = 0.3;
      g.add(r);
    }

    // Keep the pistol's baseplate attached to the body during the reload.
    const mag = this.tagFallbackNode(new Group(), 'magazine');
    const magBody = this.mesh(new BoxGeometry(0.03, 0.105, 0.038), this.polymer, 0, -0.095, 0.04);
    magBody.rotation.x = 0.3;
    mag.add(magBody);
    const magBase = this.mesh(new BoxGeometry(0.034, 0.012, 0.042), this.polymerSoft, 0, -0.15, 0.055);
    magBase.rotation.x = 0.3;
    mag.add(magBase);
    g.add(mag);
    g.add(this.buildReloadMagazine('pistol'));

    // Trigger guard + trigger
    g.add(this.mesh(new BoxGeometry(0.026, 0.028, 0.042), this.polymer, 0, -0.022, 0.015));
    g.add(this.mesh(new BoxGeometry(0.005, 0.018, 0.01), this.steelBright, 0, -0.028, 0.02));
    // Slide stop / mag release
    g.add(this.cyl(this.steelBright, 0.005, 0.005, 0.016, 0.022, 0.005, 0.01, 6));
    g.add(this.mesh(new BoxGeometry(0.012, 0.008, 0.006), this.steel, 0.022, -0.015, 0.03));

    // Hammer / striker housing
    g.add(this.mesh(new BoxGeometry(0.014, 0.018, 0.016), this.nitrideWorn, 0, 0.055, 0.055));

    // Beveled muzzle crown ring
    g.add(this.cyl(this.steelBright, 0.013, 0.016, 0.01, 0, 0.04, -0.255, 10));

    // Pistol used to float in isolation in the fallback path.  A single
    // dominant firing hand plus a cropped support wrist anchors it to a body.
    this.addGlovedHand(g, 0.01, -0.09, 0.065, 0.04, 'firing');
    const supportCuff = this.cyl(this.sleeve, 0.034, 0.048, 0.17, -0.055, -0.125, -0.015, 10);
    supportCuff.rotation.z = -0.34;
    g.add(supportCuff);
    this.addGlovedHand(g, -0.047, -0.112, -0.022, -0.16);

    return g;
  }

  private buildKnife(): Group {
    const g = new Group();
    g.name = 'ViewKnife';

    // Handle core
    g.add(this.mesh(new BoxGeometry(0.026, 0.026, 0.125), this.polymerGrit, 0, 0, 0.06));
    // Scale panels
    g.add(this.mesh(new BoxGeometry(0.03, 0.008, 0.11), this.polymer, 0, 0.014, 0.055));
    g.add(this.mesh(new BoxGeometry(0.03, 0.008, 0.11), this.polymer, 0, -0.014, 0.055));
    // Finger grooves
    for (let i = 0; i < 4; i++) {
      g.add(
        this.mesh(new BoxGeometry(0.032, 0.007, 0.018), this.polymerSoft, 0, -0.014, 0.01 + i * 0.026),
      );
    }
    // Lanyard hole ring
    g.add(this.cyl(this.steel, 0.006, 0.006, 0.01, 0, 0, 0.125, 8));

    // Crossguard
    g.add(this.mesh(new BoxGeometry(0.062, 0.018, 0.018), this.nitride, 0, 0, -0.012));
    g.add(this.mesh(new BoxGeometry(0.014, 0.028, 0.012), this.nitrideWorn, 0.028, 0, -0.012));
    g.add(this.mesh(new BoxGeometry(0.014, 0.028, 0.012), this.nitrideWorn, -0.028, 0, -0.012));

    // Blade body
    g.add(this.mesh(new BoxGeometry(0.02, 0.007, 0.2), this.blade, 0, 0.001, -0.125));
    // False edge / clip
    const clip = this.mesh(new BoxGeometry(0.014, 0.005, 0.055), this.bladeEdge, 0, 0.005, -0.235);
    clip.rotation.x = -0.12;
    g.add(clip);
    // Tip
    const tip = this.mesh(new BoxGeometry(0.01, 0.004, 0.04), this.bladeEdge, 0, 0.0, -0.255);
    tip.rotation.y = 0.12;
    g.add(tip);
    // Fuller groove
    g.add(this.mesh(new BoxGeometry(0.006, 0.002, 0.14), this.steelBright, 0, 0.005, -0.11));
    // Spine ridge
    g.add(this.mesh(new BoxGeometry(0.004, 0.01, 0.17), this.steel, 0, 0.008, -0.11));
    // Serration section near guard
    for (let i = 0; i < 5; i++) {
      g.add(this.mesh(new BoxGeometry(0.016, 0.004, 0.008), this.bladeEdge, 0, -0.004, -0.04 - i * 0.012));
    }

    // Pommel
    g.add(this.mesh(new BoxGeometry(0.03, 0.03, 0.022), this.nitride, 0, 0, 0.132));
    g.add(this.mesh(new BoxGeometry(0.02, 0.02, 0.01), this.steelBright, 0, 0, 0.148));

    // Tang pins
    g.add(this.cyl(this.steelBright, 0.004, 0.004, 0.028, 0, 0, 0.03, 6));
    g.add(this.cyl(this.steelBright, 0.004, 0.004, 0.028, 0, 0, 0.08, 6));

    this.addGlovedHand(g, 0.015, -0.045, 0.075, 0.2);

    return g;
  }

  dispose(): void {
    this.removeAuthored();
    this.clearDevelopmentRipstop();
    this.parent.remove(this.root);
    const disposed = new Set<MeshStandardMaterial>();
    this.root.traverse((obj: Object3D) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
        for (const m of mats) {
          if (m instanceof MeshStandardMaterial && !disposed.has(m)) {
            disposed.add(m);
            m.dispose();
          }
        }
      }
    });
    this.muzzleLight.dispose();
    this.flashMat.map?.dispose();
    this.flashMat.dispose();
  }
}

function findAdsReticle(root: Object3D): Object3D | null {
  let marker: Object3D | null = null;
  root.traverse((node) => {
    if (!marker && (node.name.toUpperCase() === 'ADS_RETICLE' || node.userData.adsReticle === true)) {
      marker = node;
    }
  });
  return marker;
}

function missingAnimationRoles(
  gltf: GLTF,
  roles: Readonly<Record<string, readonly string[]>>,
): string[] {
  const names = gltf.animations.map((clip) => clip.name.toLowerCase());
  return Object.entries(roles)
    .filter(([, aliases]) => !names.some((name) => aliases.some((alias) => name.includes(alias))))
    .map(([role]) => role);
}

function isVisibleThrough(node: Object3D, root: Object3D): boolean {
  let current: Object3D | null = node;
  while (current) {
    if (!current.visible) return false;
    if (current === root) return true;
    current = current.parent;
  }
  return false;
}

function hasSkinnedMesh(root: Object3D): boolean {
  let found = false;
  root.traverse((node) => {
    if ((node as import('three').SkinnedMesh).isSkinnedMesh) found = true;
  });
  return found;
}
