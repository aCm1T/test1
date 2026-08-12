import {
  IcosahedronGeometry,
  Mesh,
  MeshStandardMaterial,
  PointLight,
  Vector3,
  type PerspectiveCamera,
  type Scene,
} from 'three';
import type { HitscanEnemy } from '../combat';
import type { WorldCollider } from '../player/PlayerController';
import type { GrenadeBodySnapshot, RapierPhysicsWorld, Vec3 } from '../simulation';

export interface GrenadeExplosion {
  position: Vector3;
  radius: number;
  damaged: number;
  /** Damage applied to the thrower when player splash is enabled; 0 otherwise. */
  playerDamage: number;
  /** Camera distance at detonation, so shake and audio can attenuate. */
  distanceToCamera: number;
}

export interface GrenadeBounce {
  position: Vector3;
  /** Impact speed, used to scale the bounce clack. */
  speed: number;
  bounces: number;
}

export interface GrenadeSystemOptions {
  scene: Scene;
  camera: PerspectiveCamera;
  colliders: WorldCollider[];
  maxGrenades?: number;
  onThrow?: (remaining: number) => void;
  onExplode?: (event: GrenadeExplosion) => void;
  /** Metal-on-concrete clack, which is the main cue for a bounced-back frag. */
  onBounce?: (event: GrenadeBounce) => void;
  /** Throttled fuse-smoke emission point while the grenade is in flight. */
  onTrail?: (position: Vector3) => void;
  /**
   * Optional thrower splash: same blast radius / linear falloff as enemy splash.
   * Both must be set; omitted keeps frags risk-free for the player.
   */
  getPlayerPosition?: () => Readonly<Pick<Vector3, 'x' | 'y' | 'z'>>;
  onPlayerDamage?: (amount: number) => void;
  physicsWorld?: RapierPhysicsWorld;
}

export interface GrenadeSystemSnapshot {
  remaining: number;
  /** Optional only for backwards-compatible checkpoints from older builds. */
  serial?: number;
  /** Optional only for backwards-compatible checkpoints from older builds. */
  grenades?: LiveGrenadeSnapshot[];
}

export interface LiveGrenadeSnapshot {
  id: string;
  position: Vec3;
  velocity: Vec3;
  rotation: { x: number; y: number; z: number; w: number };
  fuse: number;
  bounces: number;
  /** Present only when the shared physics world owns the body. */
  physics: GrenadeBodySnapshot | null;
}

interface LiveGrenade {
  id: string;
  mesh: Mesh;
  /** Blinking fuse indicator parented to the body. */
  light: PointLight;
  velocity: Vector3;
  fuse: number;
  bounces: number;
  /** Countdown until the next trail puff. */
  trailTimer: number;
  /** Bounce count already reported, so one impact fires one clack. */
  reportedBounces: number;
  /** Prior Rapier sample, used to edge-detect contacts from velocity changes. */
  priorPhysicsVelocity: Vector3 | null;
}

const GRAVITY = 18;
const RADIUS = 0.09;
const FUSE_SECONDS = 2.65;
/** Impact speed below which a frag is treated as settled rather than bouncing. */
const REST_SPEED = 0.85;
const TRAIL_INTERVAL = 0.085;

/** Lightweight deterministic frag-grenade presentation and AABB physics. */
export class GrenadeSystem {
  private readonly scene: Scene;
  private readonly camera: PerspectiveCamera;
  private colliders: WorldCollider[];
  private readonly geometry = new IcosahedronGeometry(RADIUS, 1);
  private readonly material = new MeshStandardMaterial({
    color: 0x344036,
    roughness: 0.68,
    metalness: 0.54,
  });
  private readonly grenades: LiveGrenade[] = [];
  private readonly origin = new Vector3();
  private readonly direction = new Vector3();
  private readonly next = new Vector3();
  private readonly closest = new Vector3();
  private readonly maxGrenades: number;
  private readonly onThrow?: (remaining: number) => void;
  private readonly onExplode?: (event: GrenadeExplosion) => void;
  private readonly onBounce?: (event: GrenadeBounce) => void;
  private readonly onTrail?: (position: Vector3) => void;
  private readonly getPlayerPosition?: () => Readonly<Pick<Vector3, 'x' | 'y' | 'z'>>;
  private readonly onPlayerDamage?: (amount: number) => void;
  private physicsWorld: RapierPhysicsWorld | null;
  private serial = 0;
  private remaining: number;
  private throwLatch = false;

  constructor(options: GrenadeSystemOptions) {
    this.scene = options.scene;
    this.camera = options.camera;
    this.colliders = options.colliders;
    this.maxGrenades = options.maxGrenades ?? 2;
    this.remaining = this.maxGrenades;
    this.onThrow = options.onThrow;
    this.onExplode = options.onExplode;
    this.onBounce = options.onBounce;
    this.onTrail = options.onTrail;
    this.getPlayerPosition = options.getPlayerPosition;
    this.onPlayerDamage = options.onPlayerDamage;
    this.physicsWorld = options.physicsWorld ?? null;
  }

  /**
   * Builds the frag body plus its blinking fuse light. Both the throw and the
   * checkpoint-restore path go through here so a restored grenade is never a
   * dark, silent sphere.
   */
  private createGrenadeMesh(): { mesh: Mesh; light: PointLight } {
    const mesh = new Mesh(this.geometry, this.material);
    mesh.name = 'PlayerFragGrenade';
    mesh.castShadow = true;
    const light = new PointLight(0xff6a2a, 0, 2.4, 2);
    light.name = 'FragFuseIndicator';
    light.castShadow = false;
    mesh.add(light);
    return { mesh, light };
  }

  private releaseGrenade(grenade: LiveGrenade): void {
    grenade.light.removeFromParent();
    grenade.light.dispose();
    grenade.mesh.removeFromParent();
    this.physicsWorld?.removeGrenade(grenade.id);
  }

  getRemaining(): number {
    return this.remaining;
  }

  reset(): void {
    this.remaining = this.maxGrenades;
    for (const grenade of this.grenades) this.releaseGrenade(grenade);
    this.grenades.length = 0;
    // Rematch / early-death must match an empty restore baseline — leftover
    // serial IDs and a stuck throwLatch diverge from a cold start.
    this.serial = 0;
    this.throwLatch = false;
  }

  snapshotState(): GrenadeSystemSnapshot {
    return {
      remaining: this.remaining,
      serial: this.serial,
      grenades: this.grenades.map((grenade) => ({
        id: grenade.id,
        position: vectorSnapshot(grenade.mesh.position),
        velocity: vectorSnapshot(grenade.velocity),
        rotation: quaternionSnapshot(grenade.mesh),
        fuse: grenade.fuse,
        bounces: grenade.bounces,
        physics: this.physicsWorld && typeof this.physicsWorld.snapshotGrenade === 'function'
          ? this.physicsWorld.snapshotGrenade(grenade.id)
          : null,
      })),
    };
  }

  restoreState(snapshot: GrenadeSystemSnapshot): void {
    for (const grenade of this.grenades) this.releaseGrenade(grenade);
    this.grenades.length = 0;
    this.remaining = Math.max(0, Math.min(this.maxGrenades, Math.floor(snapshot.remaining)));
    this.serial = Math.max(0, Math.floor(snapshot.serial ?? 0));
    for (const saved of snapshot.grenades ?? []) {
      if (!isSnapshotValid(saved)) continue;
      const { mesh, light } = this.createGrenadeMesh();
      mesh.position.set(saved.position.x, saved.position.y, saved.position.z);
      mesh.quaternion.set(
        saved.rotation.x,
        saved.rotation.y,
        saved.rotation.z,
        saved.rotation.w,
      );
      this.scene.add(mesh);
      if (this.physicsWorld) {
        if (saved.physics && typeof this.physicsWorld.restoreGrenade === 'function') {
          this.physicsWorld.restoreGrenade(saved.physics);
        }
        else this.physicsWorld.addGrenade({
          id: saved.id,
          position: saved.position,
          velocity: saved.velocity,
          radius: RADIUS,
        });
      }
      this.grenades.push({
        id: saved.id,
        mesh,
        light,
        velocity: new Vector3(saved.velocity.x, saved.velocity.y, saved.velocity.z),
        fuse: Math.max(0, saved.fuse),
        bounces: Math.max(0, Math.floor(saved.bounces)),
        trailTimer: 0,
        reportedBounces: Math.max(0, Math.floor(saved.bounces)),
        priorPhysicsVelocity: this.physicsWorld
          ? new Vector3(saved.velocity.x, saved.velocity.y, saved.velocity.z)
          : null,
      });
    }
    this.throwLatch = false;
  }

  setPhysicsWorld(physicsWorld: RapierPhysicsWorld | null): void {
    this.physicsWorld = physicsWorld;
  }

  setColliders(colliders: WorldCollider[]): void {
    this.colliders = colliders;
  }

  setThrowHeld(held: boolean): boolean {
    const pressed = held && !this.throwLatch;
    this.throwLatch = held;
    if (pressed) return this.throw();
    return false;
  }

  throw(): boolean {
    if (this.remaining <= 0) return false;
    this.remaining--;
    this.camera.getWorldPosition(this.origin);
    this.camera.getWorldDirection(this.direction);
    this.origin.addScaledVector(this.direction, 0.48);
    this.origin.y -= 0.14;

    const { mesh, light } = this.createGrenadeMesh();
    mesh.position.copy(this.origin);
    this.scene.add(mesh);

    const id = `frag-${++this.serial}`;
    const velocity = this.direction.clone().multiplyScalar(12.5).add(new Vector3(0, 4.8, 0));
    if (this.physicsWorld) {
      this.physicsWorld.addGrenade({
        id,
        position: this.origin,
        velocity,
        radius: RADIUS,
      });
    }
    this.grenades.push({
      id,
      mesh,
      light,
      velocity,
      fuse: FUSE_SECONDS,
      bounces: 0,
      trailTimer: 0,
      reportedBounces: 0,
      priorPhysicsVelocity: null,
    });
    this.onThrow?.(this.remaining);
    return true;
  }

  update(dt: number, enemies: HitscanEnemy[]): void {
    const step = Math.min(dt, 0.04);
    for (let i = this.grenades.length - 1; i >= 0; i--) {
      const grenade = this.grenades[i];
      grenade.fuse -= step;
      const physicsPosition = this.physicsWorld?.grenadePosition(grenade.id);
      if (physicsPosition) {
        this.next.set(physicsPosition.x, physicsPosition.y, physicsPosition.z);
        // Rapier owns restitution/friction, so using the original throw
        // velocity after a bounce makes rotation visibly disagree with travel.
        const physicsVelocity = typeof this.physicsWorld?.grenadeVelocity === 'function'
          ? this.physicsWorld.grenadeVelocity(grenade.id)
          : null;
        if (physicsVelocity) {
          if (grenade.priorPhysicsVelocity) {
            this.detectRapierBounce(grenade, grenade.priorPhysicsVelocity, physicsVelocity);
          } else {
            grenade.priorPhysicsVelocity = new Vector3();
          }
          grenade.priorPhysicsVelocity.set(
            physicsVelocity.x,
            physicsVelocity.y,
            physicsVelocity.z,
          );
          grenade.velocity.set(
            physicsVelocity.x,
            physicsVelocity.y,
            physicsVelocity.z,
          );
        }
      } else {
        grenade.priorPhysicsVelocity = null;
        grenade.velocity.y -= GRAVITY * step;
        this.next.copy(grenade.mesh.position).addScaledVector(grenade.velocity, step);
        this.collide(grenade, this.next);
      }
      grenade.mesh.position.copy(this.next);
      // Tumble around the travel axis as well as across it, so a thrown frag
      // spins convincingly instead of rocking on two axes.
      grenade.mesh.rotation.x += grenade.velocity.z * step * 2;
      grenade.mesh.rotation.z -= grenade.velocity.x * step * 2;
      grenade.mesh.rotation.y += grenade.velocity.length() * step * 1.4;

      // Fuse indicator: blinks faster and brighter as detonation approaches.
      const fuseProgress = 1 - Math.max(0, grenade.fuse) / FUSE_SECONDS;
      const blinkRate = 3 + fuseProgress * 14;
      const blink = 0.5 + 0.5 * Math.sin(grenade.fuse * blinkRate * Math.PI * 2);
      grenade.light.intensity = (0.35 + fuseProgress * 2.1) * blink;

      if (grenade.bounces > grenade.reportedBounces) {
        grenade.reportedBounces = grenade.bounces;
        this.onBounce?.({
          position: grenade.mesh.position.clone(),
          speed: grenade.velocity.length(),
          bounces: grenade.bounces,
        });
      }

      grenade.trailTimer -= step;
      if (grenade.trailTimer <= 0) {
        grenade.trailTimer = TRAIL_INTERVAL;
        this.onTrail?.(grenade.mesh.position.clone());
      }

      if (grenade.fuse <= 0) {
        this.explode(grenade, enemies);
        this.releaseGrenade(grenade);
        this.grenades.splice(i, 1);
      }
    }
  }

  dispose(): void {
    for (const grenade of this.grenades) this.releaseGrenade(grenade);
    this.grenades.length = 0;
    this.geometry.dispose();
    this.material.dispose();
  }

  private collide(grenade: LiveGrenade, candidate: Vector3): void {
    if (candidate.y < RADIUS) {
      candidate.y = RADIUS;
      const impact = Math.abs(grenade.velocity.y);
      grenade.velocity.x *= 0.78;
      grenade.velocity.z *= 0.78;
      // Under the restitution floor the frag has settled. Letting it keep
      // "bouncing" would clack once per frame for the rest of the fuse.
      if (impact < REST_SPEED) {
        grenade.velocity.y = 0;
      } else {
        grenade.velocity.y = impact * 0.42;
        grenade.bounces++;
      }
    }
    for (const collider of this.colliders) {
      this.closest.set(
        Math.max(collider.min.x, Math.min(candidate.x, collider.max.x)),
        Math.max(collider.min.y, Math.min(candidate.y, collider.max.y)),
        Math.max(collider.min.z, Math.min(candidate.z, collider.max.z)),
      );
      if (this.closest.distanceToSquared(candidate) >= RADIUS * RADIUS) continue;
      const dx = Math.min(Math.abs(candidate.x - collider.min.x), Math.abs(candidate.x - collider.max.x));
      const dy = Math.min(Math.abs(candidate.y - collider.min.y), Math.abs(candidate.y - collider.max.y));
      const dz = Math.min(Math.abs(candidate.z - collider.min.z), Math.abs(candidate.z - collider.max.z));
      let impact: number;
      if (dy <= dx && dy <= dz) {
        impact = Math.abs(grenade.velocity.y);
        grenade.velocity.y *= -0.42;
      } else if (dx <= dz) {
        impact = Math.abs(grenade.velocity.x);
        grenade.velocity.x *= -0.48;
      } else {
        impact = Math.abs(grenade.velocity.z);
        grenade.velocity.z *= -0.48;
      }
      candidate.copy(grenade.mesh.position).addScaledVector(grenade.velocity, 0.012);
      // A frag wedged against geometry resolves every frame; only a real impact
      // counts as a bounce.
      if (impact >= REST_SPEED) grenade.bounces++;
    }
  }

  /**
   * Rapier owns contact resolution, so bounce edges are inferred from sudden
   * velocity reversals or impact-scale speed drops between physics samples.
   */
  private detectRapierBounce(
    grenade: LiveGrenade,
    previous: Vector3,
    next: { x: number; y: number; z: number },
  ): void {
    const prevSpeed = previous.length();
    const nextSpeed = Math.hypot(next.x, next.y, next.z);
    const verticalFlip = previous.y <= -REST_SPEED && next.y >= REST_SPEED * 0.2;
    const horizontalFlip = (
      (Math.abs(previous.x) >= REST_SPEED && previous.x * next.x < 0)
      || (Math.abs(previous.z) >= REST_SPEED && previous.z * next.z < 0)
    );
    const impactDrop = prevSpeed >= REST_SPEED
      && (prevSpeed - nextSpeed) >= REST_SPEED * 0.45
      && nextSpeed < prevSpeed * 0.85;
    if (verticalFlip || horizontalFlip || impactDrop) {
      grenade.bounces++;
    }
  }

  private explode(grenade: LiveGrenade, enemies: HitscanEnemy[]): void {
    const blastRadius = 6.5;
    let damaged = 0;
    for (const enemy of enemies) {
      if (!enemy.alive) continue;
      const hitboxes = enemy.getHitboxes();
      const torso = hitboxes.find((h) => h.bodyPart === 'torso') ?? hitboxes[0];
      if (!torso) continue;
      this.closest.copy(torso.min).add(torso.max).multiplyScalar(0.5);
      const distance = this.closest.distanceTo(grenade.mesh.position);
      if (distance > blastRadius || this.isOccluded(grenade.mesh.position, this.closest)) continue;
      const falloff = 1 - distance / blastRadius;
      enemy.takeDamage(splashDamage(falloff), 'torso');
      damaged++;
    }

    let playerDamage = 0;
    if (this.getPlayerPosition && this.onPlayerDamage) {
      const playerPos = this.getPlayerPosition();
      this.closest.set(playerPos.x, playerPos.y, playerPos.z);
      const distance = this.closest.distanceTo(grenade.mesh.position);
      if (distance <= blastRadius && !this.isOccluded(grenade.mesh.position, this.closest)) {
        const falloff = 1 - distance / blastRadius;
        playerDamage = splashDamage(falloff);
        this.onPlayerDamage(playerDamage);
      }
    }

    this.camera.getWorldPosition(this.origin);
    this.onExplode?.({
      position: grenade.mesh.position.clone(),
      radius: blastRadius,
      damaged,
      playerDamage,
      distanceToCamera: this.origin.distanceTo(grenade.mesh.position),
    });
  }

  private isOccluded(from: Vector3, to: Vector3): boolean {
    const dir = this.direction.copy(to).sub(from);
    const distance = dir.length();
    if (distance < 0.001) return false;
    dir.multiplyScalar(1 / distance);
    const physicsHit = this.physicsWorld?.castRay({
      origin: from,
      direction: dir,
      maxDistance: Math.max(0.01, distance - 0.15),
      includeCharacters: false,
    });
    if (this.physicsWorld) return physicsHit !== null;
    for (const collider of this.colliders) {
      let tMin = 0;
      let tMax = distance;
      for (const axis of ['x', 'y', 'z'] as const) {
        const inv = Math.abs(dir[axis]) > 1e-6 ? 1 / dir[axis] : 1e9;
        let a = (collider.min[axis] - from[axis]) * inv;
        let b = (collider.max[axis] - from[axis]) * inv;
        if (a > b) [a, b] = [b, a];
        tMin = Math.max(tMin, a);
        tMax = Math.min(tMax, b);
        if (tMin > tMax) break;
      }
      if (tMin <= tMax && tMin > 0.08 && tMin < distance - 0.15) return true;
    }
    return false;
  }
}

/** Linear falloff shared by enemy and optional player splash (35 edge → 130 center). */
function splashDamage(falloff: number): number {
  return 35 + falloff * 95;
}

function vectorSnapshot(value: Vector3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function quaternionSnapshot(mesh: Mesh): { x: number; y: number; z: number; w: number } {
  return {
    x: mesh.quaternion.x,
    y: mesh.quaternion.y,
    z: mesh.quaternion.z,
    w: mesh.quaternion.w,
  };
}

function isSnapshotValid(snapshot: LiveGrenadeSnapshot): boolean {
  return typeof snapshot.id === 'string'
    && snapshot.id.length > 0
    && [
      snapshot.position.x, snapshot.position.y, snapshot.position.z,
      snapshot.velocity.x, snapshot.velocity.y, snapshot.velocity.z,
      snapshot.rotation.x, snapshot.rotation.y, snapshot.rotation.z, snapshot.rotation.w,
      snapshot.fuse, snapshot.bounces,
    ].every(Number.isFinite);
}
