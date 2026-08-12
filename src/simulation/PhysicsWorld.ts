import RAPIER from '@dimforge/rapier3d-compat';

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type CharacterId = string;
export type SurfaceTag = 'asphalt' | 'concrete' | 'metal' | 'wood' | 'dirt' | 'glass' | 'default';

export interface CharacterIntent {
  /** Desired displacement for this fixed simulation tick. */
  translation: Vec3;
}

export interface CharacterMoveResult {
  position: Vec3;
  appliedTranslation: Vec3;
  grounded: boolean;
  collisions: string[];
}

export interface RayQuery {
  origin: Vec3;
  direction: Vec3;
  maxDistance: number;
  excludeBody?: CharacterId;
  /**
   * Static-world queries (weapons, muzzle checks, splash occlusion) must not
   * reinterpret a character capsule as opaque level geometry. Defaults to
   * true so direct physics callers can still query character obstruction.
   */
  includeCharacters?: boolean;
}

export interface RayHit {
  colliderId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
  surface: SurfaceTag;
}

export interface CapsuleSweep {
  position: Vec3;
  radius: number;
  /** Overall capsule half-height, including the rounded caps. */
  halfHeight: number;
  direction: Vec3;
  maxDistance: number;
  excludeBody?: CharacterId;
  includeCharacters?: boolean;
}

export interface SweepHit {
  colliderId: string;
  point: Vec3;
  normal: Vec3;
  distance: number;
  surface: SurfaceTag;
}

export interface PathOptions {
  radius?: number;
  halfHeight?: number;
}

export interface InteractionQuery {
  origin: Vec3;
  target: Vec3;
  maxDistance: number;
  excludeBody?: CharacterId;
  /** Stops the occlusion ray before the target's own collision surface. */
  terminalTolerance?: number;
}

export interface NavPath {
  points: Vec3[];
}

export interface PhysicsWorld {
  step(dt: number): void;
  moveCharacter(body: CharacterId, intent: CharacterIntent): CharacterMoveResult;
  castRay(query: RayQuery): RayHit | null;
  sweepCapsule(query: CapsuleSweep): SweepHit | null;
  queryNavigation(from: Vec3, to: Vec3, options?: PathOptions): NavPath | null;
  queryInteraction(query: InteractionQuery): boolean;
  getSurfaceAt(position: Vec3): SurfaceTag;
  /** Optional immediate transform sync used by checkpoint/debug restores. */
  teleportCharacter?(body: CharacterId, position: Vec3): void;
  /**
   * Atomically resize a character capsule while preserving its feet position.
   * Returns false when the expanded shape would overlap world geometry.
   */
  resizeCharacter?(body: CharacterId, radius: number, halfHeight: number): boolean;
}

export interface StaticColliderSpec {
  id: string;
  center: Vec3;
  halfExtents: Vec3;
  surface?: SurfaceTag;
}

export interface StaticTrimeshSpec {
  id: string;
  /** Flat xyz triplets in world space. */
  vertices: readonly number[] | Float32Array;
  /** Triangle vertex indices. */
  indices: readonly number[] | Uint32Array;
  surface?: SurfaceTag;
}

export interface CharacterBodySpec {
  id: CharacterId;
  position: Vec3;
  radius?: number;
  /** Overall capsule half-height, including the rounded caps. */
  halfHeight?: number;
  stepHeight?: number;
}

export interface GrenadeBodySpec {
  id: string;
  position: Vec3;
  velocity: Vec3;
  radius?: number;
}

/** Data-only dynamic-body state used by deterministic checkpoint restores. */
export interface GrenadeBodySnapshot {
  id: string;
  position: Vec3;
  velocity: Vec3;
  rotation: { x: number; y: number; z: number; w: number };
  angularVelocity: Vec3;
  radius: number;
}

interface ColliderRecord {
  id: string;
  surface: SurfaceTag;
  kind: 'box' | 'trimesh';
  collider: RAPIER.Collider;
}

interface CharacterRecord {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  controller: RAPIER.KinematicCharacterController;
  radius: number;
  halfHeight: number;
}

interface GrenadeRecord {
  body: RAPIER.RigidBody;
  collider: RAPIER.Collider;
  radius: number;
}

const IDENTITY: RAPIER.Rotation = { x: 0, y: 0, z: 0, w: 1 };

/**
 * Rapier-backed single authority for route collision and scene queries. Every
 * gameplay layer gets the same ray/sweep answers, avoiding divergent bespoke
 * AABB checks for weapons, AI, movement, grenades and interactions.
 */
export class RapierPhysicsWorld implements PhysicsWorld {
  private readonly world: RAPIER.World;
  private readonly colliders = new Map<number, ColliderRecord>();
  private readonly characters = new Map<CharacterId, CharacterRecord>();
  private readonly grenades = new Map<string, GrenadeRecord>();

  private constructor(world: RAPIER.World) {
    this.world = world;
  }

  static async create(gravity: Vec3 = { x: 0, y: -24, z: 0 }): Promise<RapierPhysicsWorld> {
    await RAPIER.init();
    return new RapierPhysicsWorld(new RAPIER.World(gravity));
  }

  addStaticBox(spec: StaticColliderSpec): void {
    if (!spec.id.trim()) throw new Error('Static collider id is required');
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.cuboid(
        positive(spec.halfExtents.x, 'halfExtents.x'),
        positive(spec.halfExtents.y, 'halfExtents.y'),
        positive(spec.halfExtents.z, 'halfExtents.z'),
      ).setTranslation(spec.center.x, spec.center.y, spec.center.z),
    );
    this.colliders.set(collider.handle, {
      id: spec.id,
      surface: spec.surface ?? 'default',
      kind: 'box',
      collider,
    });
    this.world.updateSceneQueries();
  }

  addStaticTrimesh(spec: StaticTrimeshSpec): void {
    if (!spec.id.trim()) throw new Error('Static collider id is required');
    const vertices = Float32Array.from(spec.vertices);
    if (vertices.length < 9 || vertices.length % 3 !== 0 || !vertices.every(Number.isFinite)) {
      throw new Error('Static trimesh vertices must contain finite xyz triangles');
    }
    const vertexCount = vertices.length / 3;
    const rawIndices = Array.from(spec.indices);
    if (
      rawIndices.length < 3
      || rawIndices.length % 3 !== 0
      || !rawIndices.every(
        (index) => Number.isInteger(index) && index >= 0 && index < vertexCount,
      )
    ) throw new Error('Static trimesh indices must reference complete triangles');
    const indices = Uint32Array.from(rawIndices);
    const collider = this.world.createCollider(RAPIER.ColliderDesc.trimesh(vertices, indices));
    this.colliders.set(collider.handle, {
      id: spec.id,
      surface: spec.surface ?? 'default',
      kind: 'trimesh',
      collider,
    });
    this.world.updateSceneQueries();
  }

  removeStaticColliders(predicate: (id: string) => boolean): number {
    let removed = 0;
    for (const [handle, record] of [...this.colliders]) {
      if (!predicate(record.id)) continue;
      this.world.removeCollider(record.collider, false);
      this.colliders.delete(handle);
      removed += 1;
    }
    if (removed > 0) this.world.updateSceneQueries();
    return removed;
  }

  getDebugStats(): {
    staticColliders: number;
    trimeshColliders: number;
    characters: number;
    grenades: number;
  } {
    return {
      staticColliders: this.colliders.size,
      trimeshColliders: [...this.colliders.values()]
        .filter((record) => record.kind === 'trimesh').length,
      characters: this.characters.size,
      grenades: this.grenades.size,
    };
  }

  addCharacter(spec: CharacterBodySpec): void {
    if (this.characters.has(spec.id)) throw new Error(`Character "${spec.id}" already exists`);
    const radius = positive(spec.radius ?? 0.32, 'radius');
    const halfHeight = positive(spec.halfHeight ?? 0.9, 'halfHeight');
    const segmentHalfHeight = capsuleSegmentHalfHeight(halfHeight, radius);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.kinematicPositionBased().setTranslation(
        spec.position.x,
        spec.position.y,
        spec.position.z,
      ),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.capsule(segmentHalfHeight, radius),
      body,
    );
    const controller = this.world.createCharacterController(0.01);
    controller.enableAutostep(spec.stepHeight ?? 0.38, 0.18, false);
    controller.enableSnapToGround(0.16);
    controller.setApplyImpulsesToDynamicBodies(true);
    this.characters.set(spec.id, { body, collider, controller, radius, halfHeight });
    this.world.updateSceneQueries();
  }

  removeCharacter(id: CharacterId): void {
    const record = this.characters.get(id);
    if (!record) return;
    this.world.removeCharacterController(record.controller);
    this.world.removeRigidBody(record.body);
    this.characters.delete(id);
    this.world.updateSceneQueries();
  }

  addGrenade(spec: GrenadeBodySpec): void {
    if (this.grenades.has(spec.id)) throw new Error(`Grenade "${spec.id}" already exists`);
    const body = this.world.createRigidBody(
      RAPIER.RigidBodyDesc.dynamic()
        .setTranslation(spec.position.x, spec.position.y, spec.position.z)
        .setLinvel(spec.velocity.x, spec.velocity.y, spec.velocity.z)
        .setCcdEnabled(true),
    );
    const collider = this.world.createCollider(
      RAPIER.ColliderDesc.ball(positive(spec.radius ?? 0.09, 'radius'))
        .setRestitution(0.42)
        .setFriction(0.78),
      body,
    );
    this.grenades.set(spec.id, { body, collider, radius: positive(spec.radius ?? 0.09, 'radius') });
  }

  grenadePosition(id: string): Vec3 | null {
    const grenade = this.grenades.get(id);
    return grenade ? copy(grenade.body.translation()) : null;
  }

  /** Dynamic presentation must follow the solver after every bounce. */
  grenadeVelocity(id: string): Vec3 | null {
    const grenade = this.grenades.get(id);
    return grenade ? copy(grenade.body.linvel()) : null;
  }

  /**
   * Returns the complete body state rather than only its render position. A
   * fuse checkpoint that omits linear/angular velocity visibly diverges on
   * the very next fixed step, especially after a bounce.
   */
  snapshotGrenade(id: string): GrenadeBodySnapshot | null {
    const grenade = this.grenades.get(id);
    if (!grenade) return null;
    const rotation = grenade.body.rotation();
    return {
      id,
      position: copy(grenade.body.translation()),
      velocity: copy(grenade.body.linvel()),
      rotation: { x: rotation.x, y: rotation.y, z: rotation.z, w: rotation.w },
      angularVelocity: copy(grenade.body.angvel()),
      radius: grenade.radius,
    };
  }

  /** Recreates a dynamic grenade body exactly as it existed at a checkpoint. */
  restoreGrenade(snapshot: GrenadeBodySnapshot): void {
    if (!snapshot.id.trim()) throw new Error('Grenade id is required');
    const position = finiteVec(snapshot.position, 'grenade.position');
    const velocity = finiteVec(snapshot.velocity, 'grenade.velocity');
    const angularVelocity = finiteVec(snapshot.angularVelocity, 'grenade.angularVelocity');
    const radius = positive(snapshot.radius, 'grenade.radius');
    const rotation = snapshot.rotation;
    if (![rotation.x, rotation.y, rotation.z, rotation.w].every(Number.isFinite)) {
      throw new TypeError('grenade.rotation must contain finite values');
    }
    this.removeGrenade(snapshot.id);
    this.addGrenade({ id: snapshot.id, position, velocity, radius });
    const record = this.grenades.get(snapshot.id)!;
    record.body.setRotation(rotation, true);
    record.body.setAngvel(angularVelocity, true);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
  }

  removeGrenade(id: string): void {
    const grenade = this.grenades.get(id);
    if (!grenade) return;
    this.world.removeRigidBody(grenade.body);
    this.grenades.delete(id);
  }

  step(dt: number): void {
    this.world.timestep = clamp(dt, 1 / 240, 0.1);
    this.world.step();
  }

  moveCharacter(bodyId: CharacterId, intent: CharacterIntent): CharacterMoveResult {
    const record = this.characters.get(bodyId);
    if (!record) throw new Error(`Unknown character "${bodyId}"`);
    const requested = finiteVec(intent.translation, 'intent.translation');
    record.controller.computeColliderMovement(
      record.collider,
      requested,
      undefined,
      undefined,
      (collider) => collider.handle !== record.collider.handle,
    );
    const applied = record.controller.computedMovement();
    const current = record.body.translation();
    const next = {
      x: current.x + applied.x,
      y: current.y + applied.y,
      z: current.z + applied.z,
    };
    // Apply immediately so every fixed-tick query (movement, hitscan and LOS)
    // observes the same pose before the next dynamic-body step.
    record.body.setTranslation(next, true);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();

    const collisions: string[] = [];
    for (let index = 0; index < record.controller.numComputedCollisions(); index += 1) {
      const collision = record.controller.computedCollision(index);
      if (!collision?.collider) continue;
      const id = this.colliders.get(collision.collider.handle)?.id;
      if (id) collisions.push(id);
    }
    return {
      position: next,
      appliedTranslation: copy(applied),
      grounded: record.controller.computedGrounded(),
      collisions,
    };
  }

  castRay(query: RayQuery): RayHit | null {
    const direction = normalize(query.direction);
    const ray = new RAPIER.Ray(query.origin, direction);
    const hit = this.world.castRayAndGetNormal(
      ray,
      positive(query.maxDistance, 'maxDistance'),
      true,
      undefined,
      undefined,
      this.characters.get(query.excludeBody ?? '')?.collider,
      undefined,
      query.includeCharacters === false
        ? (collider) => !this.isCharacterCollider(collider)
        : undefined,
    );
    if (!hit) return null;
    const record = this.resolveCollider(hit.collider);
    return {
      colliderId: record.id,
      point: addScaled(query.origin, direction, hit.toi),
      normal: copy(hit.normal),
      distance: hit.toi,
      surface: record.surface,
    };
  }

  sweepCapsule(query: CapsuleSweep): SweepHit | null {
    const direction = normalize(query.direction);
    const hit = this.world.castShape(
      query.position,
      IDENTITY,
      direction,
      new RAPIER.Capsule(
        capsuleSegmentHalfHeight(query.halfHeight, query.radius),
        positive(query.radius, 'radius'),
      ),
      positive(query.maxDistance, 'maxDistance'),
      true,
      undefined,
      undefined,
      this.characters.get(query.excludeBody ?? '')?.collider,
      undefined,
      query.includeCharacters === false
        ? (collider) => !this.isCharacterCollider(collider)
        : undefined,
    );
    if (!hit) return null;
    const record = this.resolveCollider(hit.collider);
    return {
      colliderId: record.id,
      point: addScaled(query.position, direction, hit.toi),
      normal: copy(hit.normal1),
      distance: hit.toi,
      surface: record.surface,
    };
  }

  queryNavigation(from: Vec3, to: Vec3, options: PathOptions = {}): NavPath | null {
    const delta = subtract(to, from);
    const distance = length(delta);
    if (distance < 1e-5) return { points: [copy(from)] };
    if (this.sweepCapsule({
      position: from,
      radius: options.radius ?? 0.32,
      halfHeight: options.halfHeight ?? 0.9,
      direction: delta,
      maxDistance: distance,
      includeCharacters: false,
    })) return null;
    return { points: [copy(from), copy(to)] };
  }

  queryInteraction(query: InteractionQuery): boolean {
    const origin = finiteVec(query.origin, 'origin');
    const target = finiteVec(query.target, 'target');
    const maxDistance = positive(query.maxDistance, 'maxDistance');
    const delta = subtract(target, origin);
    const distance = length(delta);
    if (distance > maxDistance) return false;
    const terminalTolerance = clamp(query.terminalTolerance ?? 0.2, 0, maxDistance);
    if (distance <= Math.max(1e-5, terminalTolerance)) return true;
    return this.castRay({
      origin,
      direction: delta,
      maxDistance: distance - terminalTolerance,
      excludeBody: query.excludeBody,
      includeCharacters: false,
    }) === null;
  }

  getSurfaceAt(position: Vec3): SurfaceTag {
    const ray = this.castRay({
      origin: { x: position.x, y: position.y + 1.1, z: position.z },
      direction: { x: 0, y: -1, z: 0 },
      maxDistance: 2.4,
      includeCharacters: false,
    });
    return ray?.surface ?? 'default';
  }

  teleportCharacter(id: CharacterId, position: Vec3): void {
    const record = this.characters.get(id);
    if (!record) throw new Error(`Unknown character "${id}"`);
    record.body.setTranslation(finiteVec(position, 'position'), true);
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
  }

  resizeCharacter(id: CharacterId, radiusValue: number, halfHeightValue: number): boolean {
    const record = this.characters.get(id);
    if (!record) throw new Error(`Unknown character "${id}"`);
    const radius = positive(radiusValue, 'radius');
    const halfHeight = positive(halfHeightValue, 'halfHeight');
    if (
      Math.abs(record.radius - radius) < 1e-6
      && Math.abs(record.halfHeight - halfHeight) < 1e-6
    ) return true;

    const current = record.body.translation();
    const feetY = current.y - record.halfHeight;
    const proposed = {
      x: current.x,
      y: feetY + halfHeight,
      z: current.z,
    };
    const shape = new RAPIER.Capsule(capsuleSegmentHalfHeight(halfHeight, radius), radius);
    let blocked = false;
    this.world.intersectionsWithShape(
      proposed,
      IDENTITY,
      shape,
      () => {
        blocked = true;
        return false;
      },
      undefined,
      undefined,
      record.collider,
    );
    if (blocked) return false;

    record.collider.setShape(shape);
    record.body.setTranslation(proposed, true);
    record.radius = radius;
    record.halfHeight = halfHeight;
    this.world.propagateModifiedBodyPositionsToColliders();
    this.world.updateSceneQueries();
    return true;
  }

  dispose(): void {
    for (const record of this.characters.values()) this.world.removeCharacterController(record.controller);
    this.characters.clear();
    this.grenades.clear();
    this.colliders.clear();
    this.world.free();
  }

  private resolveCollider(collider: RAPIER.Collider): ColliderRecord {
    return this.colliders.get(collider.handle) ?? {
      id: `dynamic:${collider.handle}`,
      surface: 'default',
      kind: 'box',
      collider,
    };
  }

  private isCharacterCollider(collider: RAPIER.Collider): boolean {
    for (const record of this.characters.values()) {
      if (record.collider.handle === collider.handle) return true;
    }
    return false;
  }
}

function positive(value: number, name: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new RangeError(`${name} must be positive`);
  return value;
}

function capsuleSegmentHalfHeight(halfHeightValue: number, radiusValue: number): number {
  const halfHeight = positive(halfHeightValue, 'halfHeight');
  const radius = positive(radiusValue, 'radius');
  if (halfHeight <= radius) throw new RangeError('halfHeight must be greater than radius');
  return halfHeight - radius;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(value) ? value : min));
}

function finiteVec(value: Vec3, name: string): Vec3 {
  if (![value.x, value.y, value.z].every(Number.isFinite)) {
    throw new TypeError(`${name} must contain finite values`);
  }
  return value;
}

function copy(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function addScaled(origin: Vec3, direction: Vec3, scalar: number): Vec3 {
  return {
    x: origin.x + direction.x * scalar,
    y: origin.y + direction.y * scalar,
    z: origin.z + direction.z * scalar,
  };
}

function length(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function normalize(value: Vec3): Vec3 {
  const magnitude = length(value);
  if (magnitude < 1e-7) throw new RangeError('direction must not be zero');
  return { x: value.x / magnitude, y: value.y / magnitude, z: value.z / magnitude };
}
