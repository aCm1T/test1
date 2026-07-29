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

const POSES: Record<WeaponId, Record<ViewPose, PoseTransform>> = {
  ar: {
    hip: { pos: [0.22, -0.22, -0.42], rot: [0.06, 0.08, 0.04] },
    ads: { pos: [0.0, -0.145, -0.28], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.28, -0.32, -0.38], rot: [0.55, 0.35, -0.45] },
    reload: { pos: [0.18, -0.28, -0.4], rot: [0.35, -0.15, 0.25] },
  },
  pistol: {
    hip: { pos: [0.2, -0.2, -0.38], rot: [0.04, 0.06, 0.02] },
    ads: { pos: [0.0, -0.14, -0.3], rot: [0.0, 0.0, 0.0] },
    sprint: { pos: [0.26, -0.28, -0.35], rot: [0.4, 0.45, -0.3] },
    reload: { pos: [0.16, -0.26, -0.36], rot: [0.3, -0.2, 0.2] },
  },
  knife: {
    hip: { pos: [0.24, -0.18, -0.35], rot: [0.15, -0.4, 0.35] },
    ads: { pos: [0.1, -0.12, -0.32], rot: [0.05, -0.2, 0.15] },
    sprint: { pos: [0.3, -0.25, -0.32], rot: [0.5, -0.55, 0.55] },
    reload: { pos: [0.22, -0.2, -0.34], rot: [0.2, -0.35, 0.4] },
  },
};

function mat(
  color: number,
  opts: { metalness?: number; roughness?: number; emissive?: number; emissiveIntensity?: number } = {},
): MeshStandardMaterial {
  return new MeshStandardMaterial({
    color,
    metalness: opts.metalness ?? 0.85,
    roughness: opts.roughness ?? 0.35,
    emissive: new Color(opts.emissive ?? 0x000000),
    emissiveIntensity: opts.emissiveIntensity ?? 0,
  });
}

/**
 * High-detail procedural FPS viewmodels (AR, pistol, knife) built from primitives.
 * Dark metal / polymer materials. Attaches under the player camera.
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

  private readonly metalDark = mat(0x1a1c1e, { metalness: 0.92, roughness: 0.28 });
  private readonly metalMid = mat(0x2a2e32, { metalness: 0.88, roughness: 0.32 });
  private readonly polymer = mat(0x121314, { metalness: 0.15, roughness: 0.72 });
  private readonly polymerGrip = mat(0x0e0f10, { metalness: 0.1, roughness: 0.78 });
  private readonly accent = mat(0x3a3f44, { metalness: 0.7, roughness: 0.4 });
  private readonly opticGlass = mat(0x0a1018, { metalness: 0.3, roughness: 0.15, emissive: 0x112233, emissiveIntensity: 0.15 });
  private readonly blade = mat(0xc0c4c8, { metalness: 1, roughness: 0.18 });
  private readonly flashMat = mat(0xffcc66, {
    metalness: 0,
    roughness: 1,
    emissive: 0xffaa44,
    emissiveIntensity: 2.5,
  });

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

    // Shared muzzle flash (repositioned per weapon)
    this.muzzleFlash = new Mesh(new SphereGeometry(0.035, 8, 8), this.flashMat);
    this.muzzleFlash.visible = false;
    this.muzzleFlash.name = 'MuzzleFlash';
    this.root.add(this.muzzleFlash);

    this.muzzleLight = new PointLight(0xffaa55, 0, 3, 2);
    this.muzzleLight.visible = false;
    this.root.add(this.muzzleLight);

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

  private _reloadDuration = 1.6;

  /** Camera-relative recoil kick on fire. */
  kickOnFire(amount = 1, ads = false): void {
    const mul = ads ? 0.45 : 1;
    const a = amount * mul;
    this.kickRot.x += 0.035 * a + Math.random() * 0.012 * a;
    this.kickRot.y += (Math.random() - 0.5) * 0.02 * a;
    this.kickRot.z += (Math.random() - 0.5) * 0.015 * a;
    this.kickPos.z += 0.018 * a;
    this.kickPos.y -= 0.006 * a;

    this.triggerMuzzleFlash();
  }

  /** Knife swing kick. */
  kickMelee(): void {
    this.kickRot.x += 0.15;
    this.kickRot.y -= 0.35;
    this.kickRot.z += 0.25;
    this.kickPos.z -= 0.08;
    this.kickPos.x += 0.04;
  }

  private triggerMuzzleFlash(): void {
    if (this.active === 'knife') return;
    this.flashTimer = 0.045;
    this.muzzleFlash.visible = true;
    this.muzzleLight.visible = true;
    this.muzzleLight.intensity = 4.5;
    this.positionMuzzle();
  }

  private positionMuzzle(): void {
    const offsets: Record<WeaponId, [number, number, number]> = {
      ar: [0.0, 0.04, -0.55],
      pistol: [0.0, 0.03, -0.28],
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

    // Weapon switch crossfade
    if (this.switchT < 1) {
      this.switchT = Math.min(1, this.switchT + clampedDt / 0.28);
      const hide = this.switchT < 0.5;
      this.weapons[this.prevWeapon].visible = hide || this.switchT < 1;
      this.weapons[this.active].visible = !hide || this.switchT >= 0.5;
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
      }
    }

    this.pose = this.targetPose;
    this.lerpWeaponToPose(this.active, this.pose, clampedDt);

    // Kick recovery
    this.kickRot.x = MathUtils.damp(this.kickRot.x, 0, 12, clampedDt);
    this.kickRot.y = MathUtils.damp(this.kickRot.y, 0, 14, clampedDt);
    this.kickRot.z = MathUtils.damp(this.kickRot.z, 0, 14, clampedDt);
    this.kickPos.x = MathUtils.damp(this.kickPos.x, 0, 14, clampedDt);
    this.kickPos.y = MathUtils.damp(this.kickPos.y, 0, 14, clampedDt);
    this.kickPos.z = MathUtils.damp(this.kickPos.z, 0, 16, clampedDt);

    const w = this.weapons[this.active];
    w.rotation.x += this.kickRot.x;
    w.rotation.y += this.kickRot.y;
    w.rotation.z += this.kickRot.z;
    w.position.x += this.kickPos.x;
    w.position.y += this.kickPos.y;
    w.position.z += this.kickPos.z;

    // Reload procedural motion (mag dip)
    if (this.reloading && this.active !== 'knife') {
      const u = this.reloadT / this._reloadDuration;
      const dip = Math.sin(Math.min(u, 1) * Math.PI) * 0.08;
      w.position.y -= dip;
      w.rotation.x += dip * 1.2;
      const mag = w.getObjectByName('magazine');
      if (mag) {
        const drop = u < 0.45 ? u / 0.45 : u < 0.7 ? 1 : 1 - (u - 0.7) / 0.3;
        mag.position.y = -drop * 0.12;
        mag.visible = u < 0.95;
      }
    }

    // Muzzle flash decay
    if (this.flashTimer > 0) {
      this.flashTimer -= clampedDt;
      this.positionMuzzle();
      const s = 0.7 + Math.random() * 0.6;
      this.muzzleFlash.scale.setScalar(s);
      this.muzzleLight.intensity = 4.5 * Math.max(0, this.flashTimer / 0.045);
      if (this.flashTimer <= 0) {
        this.muzzleFlash.visible = false;
        this.muzzleLight.visible = false;
        this.muzzleLight.intensity = 0;
      }
    }
  }

  private lerpWeaponToPose(id: WeaponId, pose: ViewPose, dt: number): void {
    const w = this.weapons[id];
    const p = POSES[id][pose];
    const speed = pose === 'ads' ? 16 : pose === 'sprint' ? 10 : 12;
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

  private buildAssaultRifle(): Group {
    const g = new Group();
    g.name = 'ViewAR';

    // Receiver
    g.add(this.mesh(new BoxGeometry(0.07, 0.09, 0.32), this.metalDark, 0, 0.02, -0.05));
    // Upper rail
    g.add(this.mesh(new BoxGeometry(0.055, 0.025, 0.3), this.metalMid, 0, 0.075, -0.06));
    // Picatinny teeth
    for (let i = 0; i < 8; i++) {
      g.add(
        this.mesh(
          new BoxGeometry(0.05, 0.012, 0.018),
          this.accent,
          0,
          0.09,
          -0.18 + i * 0.035,
        ),
      );
    }

    // Barrel
    const barrel = this.mesh(new CylinderGeometry(0.012, 0.014, 0.38, 10), this.metalMid, 0, 0.03, -0.38);
    barrel.rotation.x = Math.PI / 2;
    g.add(barrel);

    // Gas block / front sight
    g.add(this.mesh(new BoxGeometry(0.03, 0.05, 0.04), this.metalDark, 0, 0.055, -0.48));
    g.add(this.mesh(new BoxGeometry(0.008, 0.04, 0.008), this.accent, 0, 0.09, -0.48));

    // Muzzle brake
    const brake = new Mesh(new CylinderGeometry(0.018, 0.016, 0.05, 8), this.metalDark);
    brake.rotation.x = Math.PI / 2;
    brake.position.set(0, 0.03, -0.58);
    g.add(brake);

    // Handguard
    g.add(this.mesh(new BoxGeometry(0.065, 0.07, 0.22), this.polymer, 0, 0.015, -0.28));
    // Side rails
    g.add(this.mesh(new BoxGeometry(0.012, 0.03, 0.18), this.metalMid, 0.038, 0.02, -0.28));
    g.add(this.mesh(new BoxGeometry(0.012, 0.03, 0.18), this.metalMid, -0.038, 0.02, -0.28));

    // Magwell + magazine
    g.add(this.mesh(new BoxGeometry(0.055, 0.06, 0.08), this.metalDark, 0, -0.04, -0.02));
    const mag = this.mesh(new BoxGeometry(0.045, 0.14, 0.065), this.polymerGrip, 0, -0.12, -0.02);
    mag.name = 'magazine';
    g.add(mag);

    // Pistol grip
    const grip = this.mesh(new BoxGeometry(0.04, 0.11, 0.055), this.polymerGrip, 0, -0.1, 0.08);
    grip.rotation.x = 0.35;
    g.add(grip);

    // Stock
    g.add(this.mesh(new BoxGeometry(0.045, 0.055, 0.18), this.polymer, 0, 0.02, 0.22));
    g.add(this.mesh(new BoxGeometry(0.06, 0.1, 0.04), this.polymer, 0, 0.0, 0.32));
    g.add(this.mesh(new BoxGeometry(0.055, 0.03, 0.08), this.polymerGrip, 0, -0.04, 0.28));

    // Trigger guard + trigger
    g.add(this.mesh(new BoxGeometry(0.03, 0.035, 0.05), this.metalMid, 0, -0.035, 0.05));
    g.add(this.mesh(new BoxGeometry(0.008, 0.025, 0.012), this.accent, 0, -0.04, 0.055));

    // Optic (holo-style)
    g.add(this.mesh(new BoxGeometry(0.04, 0.035, 0.08), this.metalDark, 0, 0.115, -0.02));
    g.add(this.mesh(new BoxGeometry(0.032, 0.028, 0.01), this.opticGlass, 0, 0.115, -0.055));
    g.add(this.mesh(new BoxGeometry(0.032, 0.028, 0.01), this.opticGlass, 0, 0.115, 0.015));

    // Charging handle
    g.add(this.mesh(new BoxGeometry(0.08, 0.015, 0.02), this.accent, 0, 0.065, 0.08));

    // Ejection port detail
    g.add(this.mesh(new BoxGeometry(0.008, 0.03, 0.05), this.metalMid, 0.038, 0.03, -0.02));

    return g;
  }

  private buildPistol(): Group {
    const g = new Group();
    g.name = 'ViewPistol';

    // Slide
    g.add(this.mesh(new BoxGeometry(0.045, 0.045, 0.2), this.metalDark, 0, 0.04, -0.05));
    // Slide serrations
    for (let i = 0; i < 5; i++) {
      g.add(
        this.mesh(new BoxGeometry(0.048, 0.02, 0.008), this.metalMid, 0, 0.055, 0.02 + i * 0.012),
      );
    }

    // Frame
    g.add(this.mesh(new BoxGeometry(0.042, 0.04, 0.16), this.polymer, 0, 0.005, -0.02));

    // Barrel
    const barrel = new Mesh(new CylinderGeometry(0.01, 0.011, 0.14, 8), this.metalMid);
    barrel.rotation.x = Math.PI / 2;
    barrel.position.set(0, 0.04, -0.16);
    g.add(barrel);

    // Muzzle
    const muzzle = new Mesh(new CylinderGeometry(0.014, 0.012, 0.025, 8), this.metalDark);
    muzzle.rotation.x = Math.PI / 2;
    muzzle.position.set(0, 0.04, -0.24);
    g.add(muzzle);

    // Grip
    const grip = this.mesh(new BoxGeometry(0.038, 0.12, 0.055), this.polymerGrip, 0, -0.07, 0.04);
    grip.rotation.x = 0.28;
    g.add(grip);

    // Mag
    const mag = this.mesh(new BoxGeometry(0.032, 0.1, 0.04), this.polymer, 0, -0.09, 0.035);
    mag.name = 'magazine';
    mag.rotation.x = 0.28;
    g.add(mag);

    // Trigger guard
    g.add(this.mesh(new BoxGeometry(0.028, 0.03, 0.04), this.polymer, 0, -0.02, 0.02));
    g.add(this.mesh(new BoxGeometry(0.006, 0.02, 0.01), this.accent, 0, -0.025, 0.025));

    // Rear sight / front sight
    g.add(this.mesh(new BoxGeometry(0.03, 0.015, 0.012), this.accent, 0, 0.07, 0.04));
    g.add(this.mesh(new BoxGeometry(0.008, 0.02, 0.008), this.accent, 0, 0.075, -0.14));

    // Hammer
    g.add(this.mesh(new BoxGeometry(0.015, 0.02, 0.015), this.metalMid, 0, 0.055, 0.06));

    return g;
  }

  private buildKnife(): Group {
    const g = new Group();
    g.name = 'ViewKnife';

    // Handle
    g.add(this.mesh(new BoxGeometry(0.028, 0.028, 0.12), this.polymerGrip, 0, 0, 0.06));
    // Finger grooves
    for (let i = 0; i < 3; i++) {
      g.add(
        this.mesh(new BoxGeometry(0.03, 0.008, 0.02), this.polymer, 0, -0.012, 0.02 + i * 0.028),
      );
    }

    // Guard
    g.add(this.mesh(new BoxGeometry(0.06, 0.02, 0.02), this.metalDark, 0, 0, -0.01));

    // Blade
    const blade = this.mesh(new BoxGeometry(0.018, 0.008, 0.22), this.blade, 0, 0.002, -0.13);
    g.add(blade);

    // Blade taper tip (second box angled)
    const tip = this.mesh(new BoxGeometry(0.014, 0.006, 0.06), this.blade, 0, 0.002, -0.26);
    tip.rotation.y = 0.15;
    g.add(tip);

    // Spine ridge
    g.add(this.mesh(new BoxGeometry(0.004, 0.012, 0.18), this.metalMid, 0, 0.008, -0.12));

    // Pommel
    g.add(this.mesh(new BoxGeometry(0.032, 0.032, 0.025), this.metalDark, 0, 0, 0.13));

    return g;
  }

  dispose(): void {
    this.camera.remove(this.root);
    this.root.traverse((obj: Object3D) => {
      if (obj instanceof Mesh) {
        obj.geometry.dispose();
        if (Array.isArray(obj.material)) {
          obj.material.forEach((m) => m.dispose());
        } else {
          obj.material.dispose();
        }
      }
    });
    this.muzzleLight.dispose();
  }
}
