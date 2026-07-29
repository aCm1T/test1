import { Vector3 } from 'three';
import type { WorldCollider } from '../player/PlayerController';

export type BodyPart = 'head' | 'torso' | 'limbs';

export interface EnemyHitbox {
  min: Vector3;
  max: Vector3;
  bodyPart: BodyPart;
}

/**
 * Minimal enemy surface for hitscan combat.
 * Concrete enemy classes should implement this.
 */
export interface HitscanEnemy {
  readonly alive: boolean;
  /** World-space AABB hitboxes tagged by body part. */
  getHitboxes(): EnemyHitbox[];
  /**
   * Apply damage. Return `true` if this hit killed the enemy.
   */
  takeDamage(amount: number, bodyPart?: BodyPart): boolean;
}

export interface HitscanHit {
  point: Vector3;
  normal: Vector3;
  enemy?: HitscanEnemy;
  bodyPart?: BodyPart;
  distance: number;
  /** True when the closest hit was world geometry (not an enemy). */
  hitWorld: boolean;
}

const _invDir = new Vector3();
const _hitPoint = new Vector3();
const _normal = new Vector3();

/**
 * Ray vs AABB (slab method). Returns distance along ray or null.
 */
export function rayAABB(
  origin: Vector3,
  dir: Vector3,
  min: Vector3,
  max: Vector3,
  maxDist: number,
): { t: number; normal: Vector3 } | null {
  _invDir.set(
    dir.x !== 0 ? 1 / dir.x : 1e12,
    dir.y !== 0 ? 1 / dir.y : 1e12,
    dir.z !== 0 ? 1 / dir.z : 1e12,
  );

  let tmin: number;
  let tmax: number;
  let tymin: number;
  let tymax: number;
  let tzmin: number;
  let tzmax: number;

  if (_invDir.x >= 0) {
    tmin = (min.x - origin.x) * _invDir.x;
    tmax = (max.x - origin.x) * _invDir.x;
  } else {
    tmin = (max.x - origin.x) * _invDir.x;
    tmax = (min.x - origin.x) * _invDir.x;
  }

  if (_invDir.y >= 0) {
    tymin = (min.y - origin.y) * _invDir.y;
    tymax = (max.y - origin.y) * _invDir.y;
  } else {
    tymin = (max.y - origin.y) * _invDir.y;
    tymax = (min.y - origin.y) * _invDir.y;
  }

  if (tmin > tymax || tymin > tmax) return null;
  if (tymin > tmin) tmin = tymin;
  if (tymax < tmax) tmax = tymax;

  if (_invDir.z >= 0) {
    tzmin = (min.z - origin.z) * _invDir.z;
    tzmax = (max.z - origin.z) * _invDir.z;
  } else {
    tzmin = (max.z - origin.z) * _invDir.z;
    tzmax = (min.z - origin.z) * _invDir.z;
  }

  if (tmin > tzmax || tzmin > tmax) return null;
  if (tzmin > tmin) tmin = tzmin;
  if (tzmax < tmax) tmax = tzmax;

  // Closest positive intersection
  const t = tmin >= 0 ? tmin : tmax >= 0 ? tmax : -1;
  if (t < 0 || t > maxDist) return null;

  // Face normal from which slab we hit
  _normal.set(0, 0, 0);
  const eps = 1e-5;
  _hitPoint.copy(origin).addScaledVector(dir, t);

  if (Math.abs(_hitPoint.x - min.x) < eps) _normal.set(-1, 0, 0);
  else if (Math.abs(_hitPoint.x - max.x) < eps) _normal.set(1, 0, 0);
  else if (Math.abs(_hitPoint.y - min.y) < eps) _normal.set(0, -1, 0);
  else if (Math.abs(_hitPoint.y - max.y) < eps) _normal.set(0, 1, 0);
  else if (Math.abs(_hitPoint.z - min.z) < eps) _normal.set(0, 0, -1);
  else if (Math.abs(_hitPoint.z - max.z) < eps) _normal.set(0, 0, 1);
  else {
    // Fallback: push from box center
    const cx = (min.x + max.x) * 0.5;
    const cy = (min.y + max.y) * 0.5;
    const cz = (min.z + max.z) * 0.5;
    const dx = _hitPoint.x - cx;
    const dy = _hitPoint.y - cy;
    const dz = _hitPoint.z - cz;
    const ax = Math.abs(dx) / Math.max((max.x - min.x) * 0.5, 1e-6);
    const ay = Math.abs(dy) / Math.max((max.y - min.y) * 0.5, 1e-6);
    const az = Math.abs(dz) / Math.max((max.z - min.z) * 0.5, 1e-6);
    if (ax >= ay && ax >= az) _normal.set(Math.sign(dx) || 1, 0, 0);
    else if (ay >= ax && ay >= az) _normal.set(0, Math.sign(dy) || 1, 0);
    else _normal.set(0, 0, Math.sign(dz) || 1);
  }

  return { t, normal: _normal.clone() };
}

/**
 * Hitscan ray test against enemies and world AABB colliders.
 * Closest hit wins. Enemy body-part hitboxes take priority at equal distance.
 */
export function hitscan(
  origin: Vector3,
  direction: Vector3,
  enemies: HitscanEnemy[],
  colliders: WorldCollider[],
  maxDist: number,
): HitscanHit {
  const dir = direction.lengthSq() > 0 ? direction.clone().normalize() : new Vector3(0, 0, -1);

  let bestT = maxDist;
  let bestNormal = new Vector3(0, 1, 0);
  let bestEnemy: HitscanEnemy | undefined;
  let bestPart: BodyPart | undefined;
  let hitWorld = false;

  // World colliders
  for (const c of colliders) {
    const hit = rayAABB(origin, dir, c.min, c.max, bestT);
    if (hit && hit.t < bestT) {
      bestT = hit.t;
      bestNormal.copy(hit.normal);
      bestEnemy = undefined;
      bestPart = undefined;
      hitWorld = true;
    }
  }

  // Enemies (alive only)
  for (const enemy of enemies) {
    if (!enemy.alive) continue;
    const boxes = enemy.getHitboxes();
    for (const box of boxes) {
      const hit = rayAABB(origin, dir, box.min, box.max, bestT);
      if (hit && hit.t <= bestT) {
        // Prefer enemy over world at same/near distance; prefer head over torso
        const prefer =
          hit.t < bestT - 1e-5 ||
          (Math.abs(hit.t - bestT) < 1e-5 &&
            (hitWorld || bodyPartPriority(box.bodyPart) > bodyPartPriority(bestPart)));
        if (prefer) {
          bestT = hit.t;
          bestNormal.copy(hit.normal);
          bestEnemy = enemy;
          bestPart = box.bodyPart;
          hitWorld = false;
        }
      }
    }
  }

  const point = origin.clone().addScaledVector(dir, bestT);

  // Miss — still return end of ray
  if (bestT >= maxDist && !bestEnemy && !hitWorld) {
    return {
      point: origin.clone().addScaledVector(dir, maxDist),
      normal: dir.clone().negate(),
      distance: maxDist,
      hitWorld: false,
    };
  }

  return {
    point,
    normal: bestNormal,
    enemy: bestEnemy,
    bodyPart: bestPart,
    distance: bestT,
    hitWorld,
  };
}

function bodyPartPriority(part?: BodyPart): number {
  if (part === 'head') return 3;
  if (part === 'torso') return 2;
  if (part === 'limbs') return 1;
  return 0;
}
