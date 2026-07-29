import {
  BoxGeometry,
  Color,
  CylinderGeometry,
  Group,
  MathUtils,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  PointLight,
  SphereGeometry,
  type PerspectiveCamera,
} from 'three';

export type WeaponId = 'ar' | 'pistol' | 'knife';
export type ViewPose = 'hip' | 'ads' | 'sprint' | 'reload';

interface PoseTransform {
  pos: [number, number, number];
  rot: [number, number, number];
}

/** Tuned for COD-style FOV viewmodels: receiver visible on hip, tight ADS, pronounced sprint tilt. */
const POSES: Record<WeaponId, Record<ViewPose, PoseTransform>> = {
  ar: {
    // Pulled in / raised so lower+upper receiver sit in frame (not a bottom-right silhouette).
    hip: { pos: [0.16, -0.165, -0.34], rot: [0.04, 0.06, 0.028] },
    ads: { pos: [0.0, -0.132, -0.255], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.26, -0.3, -0.32], rot: [0.62, 0.42, -0.52] },
    reload: { pos: [0.14, -0.26, -0.34], rot: [0.42, -0.18, 0.28] },
  },
  pistol: {
    hip: { pos: [0.15, -0.155, -0.32], rot: [0.03, 0.045, 0.018] },
    ads: { pos: [0.0, -0.128, -0.275], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.24, -0.26, -0.3], rot: [0.48, 0.5, -0.35] },
    reload: { pos: [0.12, -0.24, -0.3], rot: [0.36, -0.22, 0.24] },
  },
  knife: {
    hip: { pos: [0.2, -0.14, -0.3], rot: [0.15, -0.4, 0.35] },
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

interface MatOpts {
  metalness?: number;
  roughness?: number;
  emissive?: number;
  emissiveIntensity?: number;
  flatShading?: boolean;
}

function mat(color: number, opts: MatOpts = {}): MeshStandardMaterial {
  const m = new MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.8,
    roughness: opts.roughness ?? 0.45,
    emissive: new Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 0,
    flatShading: opts.flatShading ?? false,
  });
  // Keep depth writes so viewmodel occludes correctly under the camera.
  m.depthTest = true;
  m.depthWrite = true;
  return m;
}

/**
 * High-detail procedural FPS viewmodels (AR, pistol, knife) built from primitives.
 * Dark nitride metal / polymer grit / subtle emissive irons. Attaches under the player camera.
 */
export class ViewModel {
  readonly root: Group;
  readonly muzzleFlash: Mesh;
  readonly muzzleLight: PointLight;

  private readonly camera: PerspectiveCamera;
  private readonly weapons: Record<WeaponId, Group>;
  private active: WeaponId = 'ar';
  private pose: ViewPose = 'hip';
  private targetPose: ViewPose = 'hip';

  private readonly kickRot = { x: 0, y: 0, z: 0 };
  private readonly kickPos = { x: 0, y: 0, z: 0 };
  private flashTimer = 0;
  private reloadT = 0;
  private reloading = false;
  private switchT = 1;
  private prevWeapon: WeaponId = 'ar';
  private idleT = 0;
  private _reloadDuration = 1.6;

  // ─── High-contrast COD palette: dark polymer vs bright steel vs FDE accents ─
  // Prior mid-gray stack photographed as "gray Legos" — separate value bands hard.
  private readonly nitride = mat(0x2a3038, {
    metalness: 0.72,
    roughness: 0.38,
    emissive: 0x12161c,
    emissiveIntensity: 0.28,
  });
  private readonly nitrideWorn = mat(0x3a424c, {
    metalness: 0.62,
    roughness: 0.48,
    emissive: 0x14181e,
    emissiveIntensity: 0.22,
  });
  private readonly steel = mat(0x8a929c, {
    metalness: 0.78,
    roughness: 0.28,
    emissive: 0x1c2228,
    emissiveIntensity: 0.2,
  });
  private readonly steelBright = mat(0xc0c8d0, {
    metalness: 0.85,
    roughness: 0.22,
    emissive: 0x202830,
    emissiveIntensity: 0.18,
  });
  // Polymer: near-black with grit — must sit darker than metal receivers.
  private readonly polymer = mat(0x14181c, {
    metalness: 0.04,
    roughness: 0.88,
    emissive: 0x080a0c,
    emissiveIntensity: 0.16,
  });
  private readonly polymerGrit = mat(0x0e1216, {
    metalness: 0.03,
    roughness: 0.94,
    emissive: 0x06080a,
    emissiveIntensity: 0.14,
  });
  private readonly polymerSoft = mat(0x1c2228, {
    metalness: 0.05,
    roughness: 0.8,
    emissive: 0x0a0c10,
    emissiveIntensity: 0.14,
  });
  // FDE / tan accents break the gray mass (magwell lip, stock cheek, grip panels).
  private readonly fde = mat(0xb08a58, {
    metalness: 0.12,
    roughness: 0.72,
    emissive: 0x2a1c0c,
    emissiveIntensity: 0.22,
  });
  private readonly railTooth = mat(0x5a626c, {
    metalness: 0.82,
    roughness: 0.4,
    emissive: 0x141820,
    emissiveIntensity: 0.16,
  });
  private readonly opticHousing = mat(0x101418, {
    metalness: 0.7,
    roughness: 0.42,
    emissive: 0x0c1014,
    emissiveIntensity: 0.18,
  });
  // Optic glass: hot cyan so the window reads as glass, not a gray slab.
  private readonly opticGlass = mat(0x184860, {
    metalness: 0.25,
    roughness: 0.08,
    emissive: 0x2ad0e8,
    emissiveIntensity: 1.15,
  });
  private readonly ironGlow = mat(0x2a1410, {
    metalness: 0.5,
    roughness: 0.48,
    emissive: 0xff5522,
    emissiveIntensity: 0.85,
  });
  private readonly blade = mat(0xd0dce4, {
    metalness: 0.92,
    roughness: 0.18,
    emissive: 0x14181c,
    emissiveIntensity: 0.1,
  });
  private readonly bladeEdge = mat(0xe8eef2, {
    metalness: 0.94,
    roughness: 0.14,
    emissive: 0x181c20,
    emissiveIntensity: 0.08,
  });
  private readonly flashMat = mat(0xffcc66, {
    metalness: 0,
    roughness: 1,
    emissive: 0xffaa44,
    emissiveIntensity: 2.8,
  });

  private readonly fillLight: PointLight;
  private readonly rimLight: PointLight;

  constructor(camera: PerspectiveCamera) {
    this.camera = camera;
    this.root = new Group();
    this.root.name = 'ViewModelRoot';

    this.weapons = {
      ar: this.buildAssaultRifle(),
      pistol: this.buildPistol(),
      knife: this.buildKnife(),
    };

    for (const id of Object.keys(this.weapons) as WeaponId[]) {
      this.weapons[id].visible = id === this.active;
      this.root.add(this.weapons[id]);
    }

    this.muzzleFlash = new Mesh(new SphereGeometry(0.032, 10, 10), this.flashMat);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.name = 'MuzzleFlash';
    this.root.add(this.muzzleFlash);

    // Secondary flash lobe for elongated muzzle shape
    const flashLobe = new Mesh(new SphereGeometry(0.022, 8, 8), this.flashMat);
    flashLobe.name = 'MuzzleFlashLobe';
    flashLobe.position.z = -0.02;
    flashLobe.scale.set(0.7, 0.7, 1.4);
    this.muzzleFlash.add(flashLobe);

    this.muzzleLight = new PointLight(0xffaa55, 0, 3.2, 2);
    this.muzzleLight.visible = false;
    this.root.add(this.muzzleLight);

    // Dedicated viewmodel fill — world dusk lights leave gun as flat gray Legos.
    this.fillLight = new PointLight(0xffe0c0, 1.35, 1.8, 2);
    this.fillLight.name = 'ViewModelFill';
    this.fillLight.position.set(0.12, 0.08, 0.05);
    this.fillLight.castShadow = false;
    this.root.add(this.fillLight);
    this.rimLight = new PointLight(0x88aacc, 0.55, 1.4, 2);
    this.rimLight.name = 'ViewModelRim';
    this.rimLight.position.set(-0.18, 0.06, -0.1);
    this.rimLight.castShadow = false;
    this.root.add(this.rimLight);

    camera.add(this.root);
    this.applyPoseImmediate('hip');
  }

  getActiveWeapon(): WeaponId {
    return this.active;
  }

  isReloading(): boolean {
    return this.reloading;
  }

  setPose(pose: ViewPose): void {
    if (this.reloading && pose !== 'reload') return;
    this.targetPose = pose;
  }

  getPose(): ViewPose {
    return this.pose;
  }

  switchWeapon(id: WeaponId): void {
    if (id === this.active && this.switchT >= 1) return;
    this.prevWeapon = this.active;
    this.active = id;
    this.switchT = 0;
    this.reloading = false;
    this.reloadT = 0;
    for (const wid of Object.keys(this.weapons) as WeaponId[]) {
      this.weapons[wid].visible = wid === id || wid === this.prevWeapon;
    }
    this.targetPose = 'hip';
  }

  /** Begin procedural reload pose timeline. */
  playReload(duration = 1.6): void {
    if (this.active === 'knife') return;
    this.reloading = true;
    this.reloadT = 0;
    this._reloadDuration = duration;
    this.targetPose = 'reload';
  }

  /** Camera-relative recoil kick on fire. */
  kickOnFire(amount = 1, ads = false): void {
    const mul = ads ? 0.42 : 1;
    const a = amount * mul;
    // Snappier first-frame kick, slight roll like COD
    this.kickRot.x += 0.042 * a + Math.random() * 0.01 * a;
    this.kickRot.y += (Math.random() - 0.5) * 0.018 * a;
    this.kickRot.z += (Math.random() - 0.5) * 0.022 * a;
    this.kickPos.z += 0.022 * a;
    this.kickPos.y -= 0.007 * a;
    this.kickPos.x += (Math.random() - 0.5) * 0.004 * a;

    // Pistol slide nudge
    if (this.active === 'pistol') {
      const slide = this.weapons.pistol.getObjectByName('slide');
      if (slide) {
        slide.userData.kickZ = (slide.userData.kickZ as number | undefined) ?? 0;
        slide.userData.kickZ = Math.min(0.028, (slide.userData.kickZ as number) + 0.022 * a);
      }
    }

    this.triggerMuzzleFlash();
  }

  /** Knife swing kick. */
  kickMelee(): void {
    this.kickRot.x += 0.18;
    this.kickRot.y -= 0.42;
    this.kickRot.z += 0.3;
    this.kickPos.z -= 0.1;
    this.kickPos.x += 0.055;
    this.kickPos.y -= 0.02;
  }

  private triggerMuzzleFlash(): void {
    if (this.active === 'knife') return;
    this.flashTimer = 0.05;
    this.muzzleFlash.visible = true;
    this.muzzleLight.visible = true;
    this.muzzleLight.intensity = 5.2;
    this.positionMuzzle();
  }

  private positionMuzzle(): void {
    const offsets: Record<WeaponId, [number, number, number]> = {
      ar: [0.0, 0.038, -0.58],
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
    this.idleT += clampedDt;

    // Weapon switch crossfade with dip-out / dip-in
    if (this.switchT < 1) {
      this.switchT = Math.min(1, this.switchT + clampedDt / 0.26);
      const hide = this.switchT < 0.5;
      this.weapons[this.prevWeapon].visible = hide || this.switchT < 1;
      this.weapons[this.active].visible = !hide || this.switchT >= 0.5;

      const outW = this.weapons[this.prevWeapon];
      const inW = this.weapons[this.active];
      if (hide) {
        const t = this.switchT / 0.5;
        outW.position.y -= t * 0.12;
        outW.rotation.x += t * 0.25;
      } else {
        const t = (this.switchT - 0.5) / 0.5;
        inW.position.y -= (1 - t) * 0.1;
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
        this.targetPose = 'hip';
        this.resetMagazine(this.active);
      }
    }

    this.pose = this.targetPose;
    this.lerpWeaponToPose(this.active, this.pose, clampedDt);

    // Idle / breath sway (suppressed in ADS, stronger on hip)
    const swayAmp = this.pose === 'ads' ? 0.0012 : this.pose === 'sprint' ? 0.004 : 0.0028;
    const swayX = Math.sin(this.idleT * 1.35) * swayAmp;
    const swayY = Math.cos(this.idleT * 1.1) * swayAmp * 0.85;
    const swayRoll = Math.sin(this.idleT * 0.9) * swayAmp * 0.6;

    // Kick recovery — fast initial settle, lingering micro-shake
    this.kickRot.x = MathUtils.damp(this.kickRot.x, 0, 13, clampedDt);
    this.kickRot.y = MathUtils.damp(this.kickRot.y, 0, 15, clampedDt);
    this.kickRot.z = MathUtils.damp(this.kickRot.z, 0, 15, clampedDt);
    this.kickPos.x = MathUtils.damp(this.kickPos.x, 0, 15, clampedDt);
    this.kickPos.y = MathUtils.damp(this.kickPos.y, 0, 15, clampedDt);
    this.kickPos.z = MathUtils.damp(this.kickPos.z, 0, 17, clampedDt);

    const w = this.weapons[this.active];
    w.rotation.x += this.kickRot.x + swayY * 2;
    w.rotation.y += this.kickRot.y + swayX;
    w.rotation.z += this.kickRot.z + swayRoll;
    w.position.x += this.kickPos.x + swayX;
    w.position.y += this.kickPos.y + swayY;
    w.position.z += this.kickPos.z;

    // Sprint bob overlay
    if (this.pose === 'sprint' && !this.reloading) {
      const bob = Math.sin(this.idleT * 9.5) * 0.012;
      w.position.y += bob;
      w.rotation.z += Math.sin(this.idleT * 9.5) * 0.03;
    }

    // Reload procedural motion (mag drop + weapon dip + roll)
    if (this.reloading && this.active !== 'knife') {
      const u = MathUtils.clamp(this.reloadT / this._reloadDuration, 0, 1);
      // Ease-in/out dip curve
      const dipPhase = u < 0.55 ? u / 0.55 : 1 - (u - 0.55) / 0.45;
      const dip = Math.sin(dipPhase * Math.PI) * 0.09;
      w.position.y -= dip;
      w.rotation.x += dip * 1.35;
      w.rotation.z += Math.sin(u * Math.PI) * 0.08;

      const mag = w.getObjectByName('magazine');
      if (mag) {
        // Drop out → hold → slam home
        let drop: number;
        if (u < 0.35) {
          drop = this.smoothstep(u / 0.35);
        } else if (u < 0.62) {
          drop = 1;
        } else if (u < 0.88) {
          drop = 1 - this.smoothstep((u - 0.62) / 0.26);
        } else {
          drop = 0;
        }
        const baseY = (mag.userData.baseY as number | undefined) ?? mag.position.y;
        mag.userData.baseY = baseY;
        mag.position.y = baseY - drop * 0.14;
        mag.rotation.x = drop * 0.15;
        mag.visible = u < 0.98 || drop < 0.05;
      }
    }

    // Pistol slide recovery
    if (this.active === 'pistol') {
      const slide = this.weapons.pistol.getObjectByName('slide');
      if (slide) {
        const kickZ = (slide.userData.kickZ as number | undefined) ?? 0;
        const next = MathUtils.damp(kickZ, 0, 18, clampedDt);
        slide.userData.kickZ = next;
        const baseZ = (slide.userData.baseZ as number | undefined) ?? 0;
        slide.position.z = baseZ + next;
      }
    }

    // Muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= clampedDt;
      this.positionMuzzle();
      const s = 0.65 + Math.random() * 0.7;
      this.muzzleFlash.scale.set(s * 0.85, s * 0.85, s * 1.15);
      this.muzzleFlash.rotation.z = Math.random() * Math.PI;
      this.muzzleLight.intensity = 5.2 * Math.max(0, this.flashTimer / 0.05);
      if (this.flashTimer <= 0) {
        this.muzzleFlash.visible = false;
        this.muzzleLight.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }
  }

  private smoothstep(t: number): number {
    const x = MathUtils.clamp(t, 0, 1);
    return x * x * (3 - 2 * x);
  }

  private resetMagazine(id: WeaponId): void {
    const mag = this.weapons[id].getObjectByName('magazine');
    if (!mag) return;
    const baseY = (mag.userData.baseY as number | undefined) ?? mag.position.y;
    mag.position.y = baseY;
    mag.rotation.x = 0;
    mag.visible = true;
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

  // ─── Procedural meshes ───────────────────────────────────────────────────

  private mesh(
    geo: BoxGeometry | CylinderGeometry | SphereGeometry,
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
        this.mesh(new BoxGeometry(width, 0.01, 0.014), this.railTooth, 0, y, zStart + i * 0.028),
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

  private buildAssaultRifle(): Group {
    const g = new Group();
    g.name = 'ViewAR';

    // Lower receiver
    g.add(this.mesh(new BoxGeometry(0.068, 0.055, 0.2), this.nitride, 0, -0.005, 0.02));
    // Upper receiver
    g.add(this.mesh(new BoxGeometry(0.066, 0.052, 0.26), this.nitrideWorn, 0, 0.04, -0.04));
    // Dust cover / ejection port recess
    g.add(this.mesh(new BoxGeometry(0.01, 0.028, 0.055), this.steel, 0.036, 0.035, -0.01));
    g.add(this.mesh(new BoxGeometry(0.004, 0.022, 0.048), this.nitride, 0.04, 0.035, -0.01));

    // Forward assist / bolt catch bumps
    g.add(this.mesh(new BoxGeometry(0.014, 0.018, 0.02), this.steelBright, 0.038, 0.02, 0.06));
    g.add(this.mesh(new BoxGeometry(0.012, 0.016, 0.016), this.steelBright, -0.036, -0.01, 0.04));

    // Top rail base + Picatinny teeth
    g.add(this.mesh(new BoxGeometry(0.052, 0.018, 0.34), this.steel, 0, 0.072, -0.08));
    this.addPicatinny(g, -0.22, 12, 0.086);

    // Barrel (stepped)
    g.add(this.cyl(this.steel, 0.011, 0.013, 0.22, 0, 0.028, -0.36, 12));
    g.add(this.cyl(this.nitrideWorn, 0.014, 0.015, 0.08, 0, 0.028, -0.5, 10));

    // Gas block
    g.add(this.mesh(new BoxGeometry(0.032, 0.038, 0.036), this.nitride, 0, 0.05, -0.46));
    g.add(this.cyl(this.steel, 0.006, 0.006, 0.05, 0, 0.072, -0.42, 6));

    // Barrel shroud / suppressor-style muzzle device
    g.add(this.cyl(this.nitride, 0.02, 0.018, 0.07, 0, 0.028, -0.575, 12));
    // Muzzle brake ports
    for (let i = 0; i < 3; i++) {
      g.add(this.mesh(new BoxGeometry(0.028, 0.008, 0.01), this.steelBright, 0, 0.04, -0.555 - i * 0.016));
    }
    // Flash hider tip ring
    g.add(this.cyl(this.steelBright, 0.016, 0.017, 0.018, 0, 0.028, -0.615, 10));

    // Handguard body (M-LOK style)
    g.add(this.mesh(new BoxGeometry(0.062, 0.058, 0.24), this.polymer, 0, 0.012, -0.28));
    // Bottom handguard taper
    g.add(this.mesh(new BoxGeometry(0.055, 0.02, 0.22), this.polymerGrit, 0, -0.02, -0.28));

    // Side rails
    g.add(this.mesh(new BoxGeometry(0.01, 0.028, 0.2), this.steel, 0.035, 0.018, -0.28));
    g.add(this.mesh(new BoxGeometry(0.01, 0.028, 0.2), this.steel, -0.035, 0.018, -0.28));
    // Side Picatinny short sections
    for (let i = 0; i < 5; i++) {
      g.add(this.mesh(new BoxGeometry(0.012, 0.012, 0.014), this.railTooth, 0.04, 0.018, -0.36 + i * 0.032));
      g.add(this.mesh(new BoxGeometry(0.012, 0.012, 0.014), this.railTooth, -0.04, 0.018, -0.36 + i * 0.032));
    }

    // M-LOK handguard slots (vent cutouts)
    for (let i = 0; i < 6; i++) {
      const z = -0.38 + i * 0.036;
      g.add(this.mesh(new BoxGeometry(0.018, 0.006, 0.022), this.nitride, 0.028, -0.005, z));
      g.add(this.mesh(new BoxGeometry(0.018, 0.006, 0.022), this.nitride, -0.028, -0.005, z));
      g.add(this.mesh(new BoxGeometry(0.022, 0.006, 0.02), this.nitride, 0, -0.028, z));
    }

    // Magwell flare
    g.add(this.mesh(new BoxGeometry(0.06, 0.04, 0.078), this.nitrideWorn, 0, -0.04, -0.015));
    g.add(this.mesh(new BoxGeometry(0.068, 0.018, 0.086), this.steel, 0, -0.062, -0.015));
    // Magwell lip — FDE accent breaks gray mass
    g.add(this.mesh(new BoxGeometry(0.072, 0.008, 0.09), this.fde, 0, -0.072, -0.015));

    // Magazine (PMAG-style) — dark polymer body
    const mag = this.mesh(new BoxGeometry(0.048, 0.145, 0.068), this.polymerGrit, 0, -0.145, -0.015);
    mag.name = 'magazine';
    mag.userData.baseY = -0.145;
    g.add(mag);
    // Mag baseplate — FDE
    g.add(this.mesh(new BoxGeometry(0.052, 0.012, 0.074), this.fde, 0, -0.22, -0.015));
    // Mag witness window stripe
    g.add(this.mesh(new BoxGeometry(0.008, 0.1, 0.03), this.steelBright, 0.022, -0.14, -0.015));

    // Pistol grip (angled, textured panels)
    const grip = this.mesh(new BoxGeometry(0.038, 0.115, 0.052), this.polymerGrit, 0, -0.105, 0.085);
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
    g.add(this.mesh(new BoxGeometry(0.048, 0.055, 0.14), this.polymer, 0, 0.02, 0.28));
    g.add(this.mesh(new BoxGeometry(0.062, 0.095, 0.032), this.polymerGrit, 0, -0.005, 0.35));
    // Stock cheek weld — FDE
    g.add(this.mesh(new BoxGeometry(0.05, 0.025, 0.1), this.fde, 0, 0.045, 0.28));
    // Stock buttpad
    g.add(this.mesh(new BoxGeometry(0.066, 0.1, 0.014), this.polymerGrit, 0, -0.005, 0.37));

    // Trigger guard + trigger
    g.add(this.mesh(new BoxGeometry(0.028, 0.032, 0.048), this.nitrideWorn, 0, -0.038, 0.055));
    g.add(this.mesh(new BoxGeometry(0.006, 0.022, 0.01), this.steelBright, 0, -0.042, 0.058));
    // Mag release button
    g.add(this.cyl(this.steelBright, 0.006, 0.006, 0.02, 0.032, -0.02, 0.02, 6));

    // Holosight optic
    g.add(this.mesh(new BoxGeometry(0.042, 0.02, 0.07), this.opticHousing, 0, 0.1, -0.02));
    // Optic hood / window frame
    g.add(this.mesh(new BoxGeometry(0.04, 0.038, 0.012), this.opticHousing, 0, 0.125, -0.048));
    g.add(this.mesh(new BoxGeometry(0.04, 0.038, 0.012), this.opticHousing, 0, 0.125, 0.012));
    // Glass panes — hot cyan read
    g.add(this.mesh(new BoxGeometry(0.032, 0.03, 0.008), this.opticGlass, 0, 0.125, -0.052));
    g.add(this.mesh(new BoxGeometry(0.032, 0.03, 0.008), this.opticGlass, 0, 0.125, 0.016));
    // Side optic walls
    g.add(this.mesh(new BoxGeometry(0.006, 0.038, 0.055), this.opticHousing, 0.018, 0.125, -0.018));
    g.add(this.mesh(new BoxGeometry(0.006, 0.038, 0.055), this.opticHousing, -0.018, 0.125, -0.018));
    // Brightness dial + battery cap (orange accent)
    g.add(this.cyl(this.steelBright, 0.008, 0.008, 0.012, 0.026, 0.11, -0.02, 8));
    g.add(this.mesh(new BoxGeometry(0.012, 0.012, 0.012), this.ironGlow, -0.022, 0.11, 0.0));
    g.add(this.mesh(new BoxGeometry(0.012, 0.012, 0.012), this.ironGlow, -0.022, 0.11, -0.028));

    // Handguard heatshield stripe
    g.add(this.mesh(new BoxGeometry(0.058, 0.006, 0.2), this.fde, 0, 0.038, -0.28));

    // Backup iron sights (rear + front, subtle emissive)
    g.add(this.mesh(new BoxGeometry(0.028, 0.018, 0.014), this.steel, 0, 0.095, 0.08));
    g.add(this.mesh(new BoxGeometry(0.006, 0.014, 0.006), this.ironGlow, -0.008, 0.108, 0.08));
    g.add(this.mesh(new BoxGeometry(0.006, 0.014, 0.006), this.ironGlow, 0.008, 0.108, 0.08));
    g.add(this.mesh(new BoxGeometry(0.01, 0.022, 0.01), this.steel, 0, 0.09, -0.48));
    g.add(this.mesh(new BoxGeometry(0.005, 0.012, 0.005), this.ironGlow, 0, 0.105, -0.48));

    // Charging handle
    g.add(this.mesh(new BoxGeometry(0.085, 0.012, 0.018), this.steelBright, 0, 0.068, 0.09));
    g.add(this.mesh(new BoxGeometry(0.016, 0.014, 0.02), this.steel, 0.04, 0.068, 0.09));
    g.add(this.mesh(new BoxGeometry(0.016, 0.014, 0.02), this.steel, -0.04, 0.068, 0.09));

    // Fire selector + pin details
    g.add(this.mesh(new BoxGeometry(0.01, 0.01, 0.004), this.steelBright, 0.034, 0.01, 0.07));
    g.add(this.cyl(this.steel, 0.004, 0.004, 0.01, 0.034, 0.0, 0.05, 6));

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

    // Barrel + bushing
    g.add(this.cyl(this.steel, 0.009, 0.01, 0.13, 0, 0.04, -0.155, 10));
    g.add(this.cyl(this.nitride, 0.013, 0.012, 0.022, 0, 0.04, -0.235, 10));
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

    // Magazine
    const mag = this.mesh(new BoxGeometry(0.03, 0.105, 0.038), this.polymer, 0, -0.095, 0.04);
    mag.name = 'magazine';
    mag.userData.baseY = -0.095;
    mag.rotation.x = 0.3;
    g.add(mag);
    const magBase = this.mesh(new BoxGeometry(0.034, 0.012, 0.042), this.polymerSoft, 0, -0.15, 0.055);
    magBase.rotation.x = 0.3;
    g.add(magBase);

    // Trigger guard + trigger
    g.add(this.mesh(new BoxGeometry(0.026, 0.028, 0.042), this.polymer, 0, -0.022, 0.015));
    g.add(this.mesh(new BoxGeometry(0.005, 0.018, 0.01), this.steelBright, 0, -0.028, 0.02));
    // Slide stop / mag release
    g.add(this.cyl(this.steelBright, 0.005, 0.005, 0.016, 0.022, 0.005, 0.01, 6));
    g.add(this.mesh(new BoxGeometry(0.012, 0.008, 0.006), this.steel, 0.022, -0.015, 0.03));

    // Hammer / striker housing
    g.add(this.mesh(new BoxGeometry(0.014, 0.018, 0.016), this.nitrideWorn, 0, 0.055, 0.055));

    // Beveled muzzle crown ring
    g.add(this.cyl(this.steelBright, 0.011, 0.014, 0.01, 0, 0.04, -0.255, 10));

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

    return g;
  }

  dispose(): void {
    this.camera.remove(this.root);
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
    this.fillLight.dispose();
    this.rimLight.dispose();
  }
}
