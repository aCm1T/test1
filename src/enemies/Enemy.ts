import * as THREE from 'three';

export type EnemyTeam = 'hostile' | 'neutral';
export type HitPart = 'head' | 'torso' | 'arm' | 'leg' | 'generic';

export type EnemyState =
  | 'idle'
  | 'patrol'
  | 'alert'
  | 'combat'
  | 'cover'
  | 'dead';

export type EnemyShootEvent = {
  origin: THREE.Vector3;
  direction: THREE.Vector3;
  damage: number;
  enemy: Enemy;
};

export type EnemyOptions = {
  position?: THREE.Vector3;
  team?: EnemyTeam;
  health?: number;
  speed?: number;
  accuracy?: number;
  fireInterval?: number;
  engageRange?: number;
  coverNodes?: THREE.Vector3[];
  onShoot?: (ev: EnemyShootEvent) => void;
};

const HEAD_MULT = 2.0;
const TORSO_MULT = 1.0;
const ARM_MULT = 0.65;
const LEG_MULT = 0.55;

/**
 * Procedural low-poly soldier with simple combat AI:
 * patrol → alert → combat / take cover → shoot → death collapse.
 */
export class Enemy {
  readonly mesh: THREE.Group;
  readonly team: EnemyTeam;

  health: number;
  readonly maxHealth: number;
  state: EnemyState = 'idle';
  alive = true;

  /** Callback fired when the AI takes a shot. */
  onShoot: ((ev: EnemyShootEvent) => void) | null = null;

  private readonly speed: number;
  private readonly accuracy: number;
  private readonly fireInterval: number;
  private readonly engageRange: number;
  private coverNodes: THREE.Vector3[];

  private readonly velocity = new THREE.Vector3();
  private readonly aimDir = new THREE.Vector3(0, 0, 1);
  private readonly _tmp = new THREE.Vector3();
  private readonly _tmp2 = new THREE.Vector3();
  private readonly _look = new THREE.Vector3();

  private fireCooldown = 0;
  private stateTimer = 0;
  private alertTimer = 0;
  private patrolTarget = new THREE.Vector3();
  private coverTarget: THREE.Vector3 | null = null;
  private collapseAmount = 0;
  private hitFlash = 0;
  private patrolSeed: number;

  private readonly parts: {
    head: THREE.Mesh;
    torso: THREE.Mesh;
    leftArm: THREE.Mesh;
    rightArm: THREE.Mesh;
    leftLeg: THREE.Mesh;
    rightLeg: THREE.Mesh;
    weapon: THREE.Mesh;
  };

  private readonly materials: THREE.MeshStandardMaterial[] = [];
  private readonly bodyMat: THREE.MeshStandardMaterial;
  private readonly gearMat: THREE.MeshStandardMaterial;
  private readonly skinMat: THREE.MeshStandardMaterial;

  constructor(options: EnemyOptions = {}) {
    this.team = options.team ?? 'hostile';
    this.maxHealth = options.health ?? 100;
    this.health = this.maxHealth;
    this.speed = options.speed ?? 3.4;
    this.accuracy = options.accuracy ?? 0.72;
    this.fireInterval = options.fireInterval ?? 0.85;
    this.engageRange = options.engageRange ?? 38;
    this.coverNodes = options.coverNodes ? options.coverNodes.map((c) => c.clone()) : [];
    this.onShoot = options.onShoot ?? null;
    this.patrolSeed = Math.random() * 1000;

    this.bodyMat = new THREE.MeshStandardMaterial({
      color: 0x3a4534,
      roughness: 0.88,
      metalness: 0.05,
    });
    this.gearMat = new THREE.MeshStandardMaterial({
      color: 0x2a2e28,
      roughness: 0.7,
      metalness: 0.25,
    });
    this.skinMat = new THREE.MeshStandardMaterial({
      color: 0xb08a68,
      roughness: 0.75,
      metalness: 0.0,
    });
    this.materials.push(this.bodyMat, this.gearMat, this.skinMat);

    this.mesh = new THREE.Group();
    this.mesh.name = 'EnemySoldier';
    this.parts = this.buildMesh();
    this.tagParts();

    const spawn = options.position ?? new THREE.Vector3();
    this.mesh.position.copy(spawn);
    this.pickPatrolTarget();
    this.state = 'patrol';
  }

  get position(): THREE.Vector3 {
    return this.mesh.position;
  }

  setCoverNodes(nodes: THREE.Vector3[]): void {
    this.coverNodes = nodes.map((n) => n.clone());
  }

  /**
   * Apply damage to a body part. Returns remaining health.
   * Headshots and limb hits use different multipliers.
   */
  hit(damage: number, part: HitPart = 'generic'): number {
    if (!this.alive) return 0;

    let mult = TORSO_MULT;
    if (part === 'head') mult = HEAD_MULT;
    else if (part === 'arm') mult = ARM_MULT;
    else if (part === 'leg') mult = LEG_MULT;
    else if (part === 'torso') mult = TORSO_MULT;

    this.health = Math.max(0, this.health - damage * mult);
    this.hitFlash = 0.18;

    if (this.state === 'idle' || this.state === 'patrol') {
      this.state = 'alert';
      this.alertTimer = 0.6;
    } else if (this.state === 'alert') {
      this.state = 'combat';
    }

    // Seek cover when wounded
    if (this.alive && this.health < this.maxHealth * 0.45 && this.state !== 'cover' && this.state !== 'dead') {
      this.seekCover();
      if (this.coverTarget) this.state = 'cover';
    }

    if (this.health <= 0) {
      this.kill();
    }
    return this.health;
  }

  kill(): void {
    if (!this.alive) return;
    this.alive = false;
    this.health = 0;
    this.state = 'dead';
    this.collapseAmount = 0;
    this.velocity.set(0, 0, 0);
  }

  /**
   * Per-frame AI + animation.
   * @param dt seconds
   * @param playerPos player world position (feet or torso)
   * @param scene optional scene for los helpers (reserved)
   */
  update(dt: number, playerPos: THREE.Vector3, _scene?: THREE.Scene): void {
    if (this.state === 'dead') {
      this.updateDeath(dt);
      return;
    }

    this.fireCooldown = Math.max(0, this.fireCooldown - dt);
    this.stateTimer += dt;
    if (this.hitFlash > 0) {
      this.hitFlash -= dt;
      const flash = this.hitFlash > 0;
      this.bodyMat.emissive.setHex(flash ? 0x441010 : 0x000000);
      this.bodyMat.emissiveIntensity = flash ? 0.6 : 0;
    }

    const toPlayer = this._tmp.copy(playerPos).sub(this.mesh.position);
    toPlayer.y = 0;
    const dist = toPlayer.length();
    const hasLosHint = dist < this.engageRange;

    switch (this.state) {
      case 'idle':
        if (hasLosHint && dist < this.engageRange * 0.7) {
          this.state = 'alert';
          this.alertTimer = 0.4;
        } else if (this.stateTimer > 2) {
          this.state = 'patrol';
          this.pickPatrolTarget();
        }
        break;

      case 'patrol':
        this.moveToward(this.patrolTarget, dt, this.speed * 0.55);
        this.faceToward(this.patrolTarget, dt, 4);
        if (this.mesh.position.distanceTo(this.patrolTarget) < 1.2) {
          this.pickPatrolTarget();
        }
        if (hasLosHint && dist < this.engageRange) {
          this.state = 'alert';
          this.alertTimer = 0.35 + Math.random() * 0.35;
        }
        break;

      case 'alert':
        this.faceToward(playerPos, dt, 8);
        this.alertTimer -= dt;
        if (this.alertTimer <= 0) {
          this.state = dist < 14 && Math.random() > 0.4 ? 'cover' : 'combat';
          if (this.state === 'cover') this.seekCover();
        }
        break;

      case 'cover':
        if (this.coverTarget) {
          this.moveToward(this.coverTarget, dt, this.speed * 1.1);
          this.faceToward(playerPos, dt, 6);
          if (this.mesh.position.distanceTo(this.coverTarget) < 1.0) {
            this.state = 'combat';
            this.coverTarget = null;
          }
        } else {
          this.state = 'combat';
        }
        // Peek-shoot while moving to cover if close
        if (dist < this.engageRange * 0.85) this.tryShoot(playerPos);
        break;

      case 'combat':
        this.faceToward(playerPos, dt, 10);
        if (dist > 18) {
          // Close distance somewhat
          this._tmp2.copy(playerPos);
          this.moveToward(this._tmp2, dt, this.speed * 0.7);
        } else if (dist < 6) {
          // Strafe / back off
          const side = Math.sin(this.stateTimer * 2 + this.patrolSeed) > 0 ? 1 : -1;
          this._tmp2
            .copy(this.mesh.position)
            .add(
              this._look
                .set(Math.cos(this.mesh.rotation.y), 0, Math.sin(this.mesh.rotation.y))
                .multiplyScalar(side * 2),
            );
          this.moveToward(this._tmp2, dt, this.speed * 0.5);
        }
        if (dist > this.engageRange * 1.15) {
          this.state = 'alert';
          this.alertTimer = 0.5;
        } else {
          this.tryShoot(playerPos);
        }
        // Occasionally relocate to cover
        if (this.stateTimer > 4 && Math.random() < 0.01) {
          this.seekCover();
          this.state = 'cover';
          this.stateTimer = 0;
        }
        break;
    }

    this.animateLocomotion(dt);
  }

  dispose(): void {
    this.mesh.traverse((obj) => {
      const m = obj as THREE.Mesh;
      if (m.isMesh) {
        m.geometry?.dispose();
      }
    });
    for (const mat of this.materials) mat.dispose();
    this.mesh.removeFromParent();
  }

  /** World-space aim point (approx chest). */
  getAimPoint(out = new THREE.Vector3()): THREE.Vector3 {
    return out.copy(this.mesh.position).add(new THREE.Vector3(0, 1.35, 0));
  }

  /** Resolve which body part a world ray hit (by mesh name / userData). */
  static partFromObject(obj: THREE.Object3D | null): HitPart {
    let o: THREE.Object3D | null = obj;
    while (o) {
      const part = o.userData?.hitPart as HitPart | undefined;
      if (part) return part;
      o = o.parent;
    }
    return 'generic';
  }

  // ── internals ────────────────────────────────────────────────────────

  private buildMesh(): Enemy['parts'] {
    const g = this.mesh;

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.75, 0.32), this.bodyMat);
    torso.position.set(0, 1.25, 0);
    torso.castShadow = true;
    g.add(torso);

    // Chest rig / plate
    const plate = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.12), this.gearMat);
    plate.position.set(0, 1.35, 0.18);
    plate.castShadow = true;
    g.add(plate);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.32, 0.28), this.skinMat);
    head.position.set(0, 1.82, 0);
    head.castShadow = true;
    g.add(head);

    // Helmet
    const helmet = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.16, 0.34), this.gearMat);
    helmet.position.set(0, 1.96, 0.02);
    helmet.castShadow = true;
    g.add(helmet);

    const leftArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.6, 0.16), this.bodyMat);
    leftArm.position.set(-0.4, 1.2, 0);
    leftArm.castShadow = true;
    g.add(leftArm);

    const rightArm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.6, 0.16), this.bodyMat);
    rightArm.position.set(0.4, 1.2, 0);
    rightArm.castShadow = true;
    g.add(rightArm);

    const leftLeg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.22), this.gearMat);
    leftLeg.position.set(-0.16, 0.4, 0);
    leftLeg.castShadow = true;
    g.add(leftLeg);

    const rightLeg = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.7, 0.22), this.gearMat);
    rightLeg.position.set(0.16, 0.4, 0);
    rightLeg.castShadow = true;
    g.add(rightLeg);

    // Rifle
    const weaponMat = new THREE.MeshStandardMaterial({
      color: 0x1a1c18,
      roughness: 0.45,
      metalness: 0.7,
    });
    this.materials.push(weaponMat);
    const weapon = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.14, 0.85), weaponMat);
    weapon.position.set(0.28, 1.2, 0.45);
    weapon.castShadow = true;
    g.add(weapon);

    // Mag
    const mag = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.22, 0.12), weaponMat);
    mag.position.set(0.28, 1.05, 0.35);
    g.add(mag);

    return { head, torso, leftArm, rightArm, leftLeg, rightLeg, weapon };
  }

  private tagParts(): void {
    this.parts.head.userData.hitPart = 'head';
    this.parts.head.name = 'enemy_head';
    this.parts.torso.userData.hitPart = 'torso';
    this.parts.torso.name = 'enemy_torso';
    this.parts.leftArm.userData.hitPart = 'arm';
    this.parts.rightArm.userData.hitPart = 'arm';
    this.parts.leftLeg.userData.hitPart = 'leg';
    this.parts.rightLeg.userData.hitPart = 'leg';
    this.parts.weapon.userData.hitPart = 'generic';
    this.mesh.userData.isEnemy = true;
    this.mesh.userData.enemy = this;
  }

  private pickPatrolTarget(): void {
    const r = 4 + Math.random() * 6;
    const a = Math.random() * Math.PI * 2;
    this.patrolTarget.set(
      this.mesh.position.x + Math.cos(a) * r,
      this.mesh.position.y,
      this.mesh.position.z + Math.sin(a) * r,
    );
    // Keep roughly inside arena
    this.patrolTarget.x = THREE.MathUtils.clamp(this.patrolTarget.x, -30, 30);
    this.patrolTarget.z = THREE.MathUtils.clamp(this.patrolTarget.z, -30, 30);
    this.stateTimer = 0;
  }

  private seekCover(): void {
    if (this.coverNodes.length === 0) {
      this.coverTarget = null;
      return;
    }
    let best: THREE.Vector3 | null = null;
    let bestScore = Infinity;
    for (const node of this.coverNodes) {
      const d = this.mesh.position.distanceTo(node);
      if (d < 2) continue;
      // Prefer nearby cover that isn't behind us too far
      const score = d + Math.random() * 3;
      if (score < bestScore) {
        bestScore = score;
        best = node;
      }
    }
    this.coverTarget = best ? best.clone() : null;
    this.stateTimer = 0;
  }

  private moveToward(target: THREE.Vector3, dt: number, speed: number): void {
    this._tmp.copy(target).sub(this.mesh.position);
    this._tmp.y = 0;
    const len = this._tmp.length();
    if (len < 0.05) return;
    this._tmp.multiplyScalar(1 / len);
    this.mesh.position.addScaledVector(this._tmp, speed * dt);
    this.velocity.copy(this._tmp).multiplyScalar(speed);
  }

  private faceToward(target: THREE.Vector3, dt: number, turnSpeed: number): void {
    this._look.copy(target).sub(this.mesh.position);
    this._look.y = 0;
    if (this._look.lengthSq() < 1e-6) return;
    const yaw = Math.atan2(this._look.x, this._look.z);
    let diff = yaw - this.mesh.rotation.y;
    while (diff > Math.PI) diff -= Math.PI * 2;
    while (diff < -Math.PI) diff += Math.PI * 2;
    this.mesh.rotation.y += THREE.MathUtils.clamp(diff, -turnSpeed * dt, turnSpeed * dt);
    this.aimDir.set(Math.sin(this.mesh.rotation.y), 0, Math.cos(this.mesh.rotation.y));
  }

  private tryShoot(playerPos: THREE.Vector3): void {
    if (this.fireCooldown > 0 || !this.onShoot) return;

    const origin = this.getAimPoint(this._tmp);
    const dir = this._tmp2.copy(playerPos).add(new THREE.Vector3(0, 1.4, 0)).sub(origin).normalize();

    // Accuracy cone
    const spread = (1 - this.accuracy) * 0.12;
    dir.x += (Math.random() - 0.5) * spread;
    dir.y += (Math.random() - 0.5) * spread * 0.6;
    dir.z += (Math.random() - 0.5) * spread;
    dir.normalize();

    this.fireCooldown = this.fireInterval * (0.75 + Math.random() * 0.5);
    // Recoil pose
    this.parts.weapon.rotation.x = -0.25;
    this.onShoot({
      origin: origin.clone(),
      direction: dir.clone(),
      damage: 12 + Math.random() * 8,
      enemy: this,
    });
  }

  private animateLocomotion(dt: number): void {
    const moving = this.velocity.lengthSq() > 0.4;
    const t = this.stateTimer;
    if (moving) {
      const swing = Math.sin(t * 8) * 0.35;
      this.parts.leftLeg.rotation.x = swing;
      this.parts.rightLeg.rotation.x = -swing;
      this.parts.leftArm.rotation.x = -swing * 0.6;
      this.parts.rightArm.rotation.x = swing * 0.4 - 0.3;
    } else {
      this.parts.leftLeg.rotation.x = THREE.MathUtils.damp(
        this.parts.leftLeg.rotation.x,
        0,
        8,
        dt,
      );
      this.parts.rightLeg.rotation.x = THREE.MathUtils.damp(
        this.parts.rightLeg.rotation.x,
        0,
        8,
        dt,
      );
      this.parts.leftArm.rotation.x = THREE.MathUtils.damp(
        this.parts.leftArm.rotation.x,
        0.15,
        6,
        dt,
      );
      this.parts.rightArm.rotation.x = THREE.MathUtils.damp(
        this.parts.rightArm.rotation.x,
        -0.35,
        6,
        dt,
      );
    }
    this.parts.weapon.rotation.x = THREE.MathUtils.damp(
      this.parts.weapon.rotation.x,
      -0.05,
      10,
      dt,
    );
    this.velocity.multiplyScalar(0.85);
  }

  private updateDeath(dt: number): void {
    if (this.collapseAmount >= 1) return;
    this.collapseAmount = Math.min(1, this.collapseAmount + dt * 2.2);
    const t = this.collapseAmount;
    // Collapse forward/side
    this.mesh.rotation.x = THREE.MathUtils.lerp(0, Math.PI * 0.5, t * t);
    this.mesh.position.y = THREE.MathUtils.lerp(0, 0.15, t);
    this.parts.leftArm.rotation.z = t * 0.8;
    this.parts.rightArm.rotation.z = -t * 0.5;
    this.bodyMat.color.lerp(new THREE.Color(0x2a2a28), dt * 2);
  }
}
