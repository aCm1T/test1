import type { PhysicsWorld, Vec3 } from './PhysicsWorld';

export interface NavigationNode {
  id: string;
  position: Vec3;
}

export interface NavigationEdge {
  from: string;
  to: string;
  cost?: number;
}

export interface NavigationPath {
  nodeIds: string[];
  points: Vec3[];
  cost: number;
}

export interface CoverSlotDefinition {
  id: string;
  position: Vec3;
  /** A point the occupant can fire from after reaching the slot. */
  peekPosition?: Vec3;
}

export interface CoverReservation {
  slotId: string;
  ownerId: string;
}

/** Tactical job a hostile performs inside a squad engagement. */
export type SquadRole = 'assault' | 'flanker' | 'suppressor' | 'anchor';

export interface SquadRolePlan {
  agentId: string;
  role: SquadRole;
  /** Lateral bias (-1 left, +1 right) relative to the threat's facing. */
  side: -1 | 1;
}

export interface SquadRoleOptions {
  /** Hard ceiling on simultaneous flankers so a squad never abandons contact. */
  maxFlankers?: number;
  maxSuppressors?: number;
  /** Direction the threat is looking/moving; flankers are pushed off this axis. */
  threatFacing?: Vec3;
}

export interface FlankNodeOptions {
  side?: -1 | 1;
  minThreatDistance?: number;
  maxThreatDistance?: number;
  maxTravelDistance?: number;
  /** Candidates verified against the traversable graph before being returned. */
  requireReachable?: boolean;
}

export interface CoverScoringOptions {
  /** Slots closer than this to the threat are treated as suicidal. */
  minThreatDistance?: number;
  maxTravelDistance?: number;
}

/**
 * Authored graph whose traversable edges are verified with exactly the capsule
 * sweep used by movement. This removes navigation paths that AI cannot occupy.
 */
export class NavigationGraph {
  private readonly nodes = new Map<string, NavigationNode>();
  private readonly edges = new Map<string, Array<{ to: string; cost: number }>>();

  constructor(
    nodes: readonly NavigationNode[],
    edges: readonly NavigationEdge[],
    physics: PhysicsWorld,
    options: { radius?: number; halfHeight?: number } = {},
  ) {
    for (const node of nodes) {
      if (this.nodes.has(node.id)) throw new Error(`Duplicate navigation node "${node.id}"`);
      this.nodes.set(node.id, { id: node.id, position: copy(node.position) });
      this.edges.set(node.id, []);
    }
    for (const edge of edges) this.addValidatedEdge(edge, physics, options);
  }

  getNode(id: string): NavigationNode | null {
    const node = this.nodes.get(id);
    return node ? { id: node.id, position: copy(node.position) } : null;
  }

  nearestNode(position: Vec3): NavigationNode | null {
    return [...this.nodes.values()]
      .sort((a, b) => distance(a.position, position) - distance(b.position, position) || a.id.localeCompare(b.id))
      .map((node) => ({ id: node.id, position: copy(node.position) }))[0] ?? null;
  }

  isReachable(fromId: string, toId: string): boolean {
    return this.findPath(fromId, toId) !== null;
  }

  findPath(fromId: string, toId: string): NavigationPath | null {
    if (!this.nodes.has(fromId) || !this.nodes.has(toId)) return null;
    const frontier = new Set<string>([fromId]);
    const cameFrom = new Map<string, string>();
    const cost = new Map<string, number>([[fromId, 0]]);
    const target = this.nodes.get(toId)!;

    while (frontier.size > 0) {
      const current = lowestPriority(frontier, (id) => (
        (cost.get(id) ?? Infinity) + distance(this.nodes.get(id)!.position, target.position)
      ));
      frontier.delete(current);
      if (current === toId) return this.makePath(cameFrom, cost.get(current) ?? 0, fromId, toId);
      for (const edge of this.edges.get(current) ?? []) {
        const nextCost = (cost.get(current) ?? Infinity) + edge.cost;
        if (nextCost >= (cost.get(edge.to) ?? Infinity)) continue;
        cost.set(edge.to, nextCost);
        cameFrom.set(edge.to, current);
        frontier.add(edge.to);
      }
    }
    return null;
  }

  /** Deterministic proximity query used by squad planning. */
  nodesWithinRadius(position: Vec3, radius: number): NavigationNode[] {
    return [...this.nodes.values()]
      .filter((node) => distance(node.position, position) <= radius)
      .sort((a, b) => distance(a.position, position) - distance(b.position, position)
        || a.id.localeCompare(b.id))
      .map((node) => ({ id: node.id, position: copy(node.position) }));
  }

  /**
   * Picks a traversable node that attacks the threat from off the current
   * engagement axis. Nodes level with or behind the threat score best, which is
   * what turns a static firing line into a squad that works around the player.
   */
  findFlankNode(origin: Vec3, threat: Vec3, options: FlankNodeOptions = {}): NavigationNode | null {
    const minThreatDistance = options.minThreatDistance ?? 6;
    const maxThreatDistance = options.maxThreatDistance ?? 22;
    const maxTravelDistance = options.maxTravelDistance ?? 34;
    const axis = normalize(subtract(origin, threat));
    if (axis === null) return null;

    const ranked = [...this.nodes.values()]
      .map((node) => {
        const threatDistance = distance(node.position, threat);
        const travel = distance(node.position, origin);
        const bearing = normalize(subtract(node.position, threat));
        if (
          bearing === null
          || threatDistance < minThreatDistance
          || threatDistance > maxThreatDistance
          || travel > maxTravelDistance
        ) return null;
        // 1 means "stand where we already are", 0 is a clean flank, -1 is rear.
        const alignment = dot(bearing, axis);
        const lateral = axis.x * bearing.z - axis.z * bearing.x;
        const sidePenalty = options.side && Math.sign(lateral) !== options.side ? 0.55 : 0;
        return {
          node,
          score: alignment + sidePenalty + travel * 0.02,
        };
      })
      .filter((entry): entry is { node: NavigationNode; score: number } => entry !== null)
      .sort((a, b) => a.score - b.score || a.node.id.localeCompare(b.node.id));

    if (options.requireReachable === false) {
      const first = ranked[0]?.node;
      return first ? { id: first.id, position: copy(first.position) } : null;
    }
    const from = this.nearestNode(origin);
    if (!from) return null;
    // Reachability is the expensive half of the query, so only the strongest
    // candidates are path-checked instead of every node in the graph.
    for (const entry of ranked.slice(0, 6)) {
      if (entry.node.id === from.id) continue;
      if (this.findPath(from.id, entry.node.id)) {
        return { id: entry.node.id, position: copy(entry.node.position) };
      }
    }
    return null;
  }

  private addValidatedEdge(
    edge: NavigationEdge,
    physics: PhysicsWorld,
    options: { radius?: number; halfHeight?: number },
  ): void {
    const from = this.nodes.get(edge.from);
    const to = this.nodes.get(edge.to);
    if (!from || !to) throw new Error(`Navigation edge "${edge.from}" → "${edge.to}" references an unknown node`);
    const delta = subtract(to.position, from.position);
    const length = magnitude(delta);
    const blocked = length > 1e-5 && physics.sweepCapsule({
      position: from.position,
      direction: delta,
      maxDistance: length,
      radius: options.radius ?? 0.32,
      halfHeight: options.halfHeight ?? 0.9,
      includeCharacters: false,
    });
    if (blocked) return;
    this.edges.get(from.id)!.push({ to: to.id, cost: edge.cost ?? length });
  }

  private makePath(
    cameFrom: ReadonlyMap<string, string>,
    cost: number,
    fromId: string,
    toId: string,
  ): NavigationPath {
    const nodeIds = [toId];
    let current = toId;
    while (current !== fromId) {
      current = cameFrom.get(current)!;
      nodeIds.unshift(current);
    }
    return {
      nodeIds,
      points: nodeIds.map((id) => copy(this.nodes.get(id)!.position)),
      cost,
    };
  }
}

/** Exclusive, explicit cover reservations prevent a squad clumping into one prop. */
export class CoverSlots {
  private readonly slots = new Map<string, CoverSlotDefinition>();
  private readonly reservations = new Map<string, string>();

  constructor(slots: readonly CoverSlotDefinition[]) {
    for (const slot of slots) {
      if (this.slots.has(slot.id)) throw new Error(`Duplicate cover slot "${slot.id}"`);
      this.slots.set(slot.id, {
        id: slot.id,
        position: copy(slot.position),
        peekPosition: slot.peekPosition ? copy(slot.peekPosition) : undefined,
      });
    }
  }

  reserve(slotId: string, ownerId: string): CoverReservation | null {
    if (!this.slots.has(slotId)) return null;
    const current = this.reservations.get(slotId);
    if (current && current !== ownerId) return null;
    this.releaseOwner(ownerId);
    this.reservations.set(slotId, ownerId);
    return { slotId, ownerId };
  }

  reserveNearest(ownerId: string, origin: Vec3): CoverReservation | null {
    const candidate = [...this.slots.values()]
      .filter((slot) => {
        const existing = this.reservations.get(slot.id);
        return !existing || existing === ownerId;
      })
      .sort((a, b) => distance(a.position, origin) - distance(b.position, origin) || a.id.localeCompare(b.id))[0];
    return candidate ? this.reserve(candidate.id, ownerId) : null;
  }

  /**
   * Threat-aware variant of {@link reserveNearest}. Slots that are close to the
   * occupant, hold a usable standoff from the threat, expose a peek position,
   * and sit off the current engagement axis win, so a squad spreads into a
   * crossfire instead of stacking on the nearest crate.
   */
  reserveBestAgainst(
    ownerId: string,
    origin: Vec3,
    threat: Vec3,
    options: CoverScoringOptions = {},
  ): CoverReservation | null {
    const minThreatDistance = options.minThreatDistance ?? 4.5;
    const maxTravelDistance = options.maxTravelDistance ?? Infinity;
    const axis = normalize(subtract(origin, threat));
    const candidate = [...this.slots.values()]
      .map((slot) => {
        const existing = this.reservations.get(slot.id);
        if (existing && existing !== ownerId) return null;
        const travel = distance(slot.position, origin);
        if (travel > maxTravelDistance) return null;
        const threatDistance = distance(slot.position, threat);
        const bearing = axis ? normalize(subtract(slot.position, threat)) : null;
        const alignment = axis && bearing ? dot(bearing, axis) : 0;
        const exposure = threatDistance < minThreatDistance
          ? (minThreatDistance - threatDistance) * 1.2
          : 0;
        return {
          slot,
          score: travel * 0.1 + exposure + alignment * 0.5 - (slot.peekPosition ? 0.3 : 0),
        };
      })
      .filter((entry): entry is { slot: CoverSlotDefinition; score: number } => entry !== null)
      .sort((a, b) => a.score - b.score || a.slot.id.localeCompare(b.slot.id))[0];
    return candidate ? this.reserve(candidate.slot.id, ownerId) : null;
  }

  release(slotId: string, ownerId?: string): boolean {
    const current = this.reservations.get(slotId);
    if (!current || (ownerId && current !== ownerId)) return false;
    this.reservations.delete(slotId);
    return true;
  }

  releaseOwner(ownerId: string): void {
    for (const [slotId, owner] of this.reservations) {
      if (owner === ownerId) this.reservations.delete(slotId);
    }
  }

  getReservation(slotId: string): CoverReservation | null {
    const ownerId = this.reservations.get(slotId);
    return ownerId ? { slotId, ownerId } : null;
  }

  getReservationForOwner(ownerId: string): CoverReservation | null {
    for (const [slotId, owner] of this.reservations) {
      if (owner === ownerId) return { slotId, ownerId };
    }
    return null;
  }

  getSlot(slotId: string): CoverSlotDefinition | null {
    const slot = this.slots.get(slotId);
    return slot
      ? {
        id: slot.id,
        position: copy(slot.position),
        peekPosition: slot.peekPosition ? copy(slot.peekPosition) : undefined,
      }
      : null;
  }

  snapshot(): CoverReservation[] {
    return [...this.reservations]
      .map(([slotId, ownerId]) => ({ slotId, ownerId }))
      .sort((a, b) => a.slotId.localeCompare(b.slotId));
  }

  restore(reservations: readonly CoverReservation[]): void {
    this.reservations.clear();
    for (const reservation of reservations) {
      if (!this.slots.has(reservation.slotId)) continue;
      if (this.getReservationForOwner(reservation.ownerId)) continue;
      this.reservations.set(reservation.slotId, reservation.ownerId);
    }
  }
}

export interface SquadAgent {
  id: string;
  position: Vec3;
  alive: boolean;
}

export interface SquadAssignment {
  agentId: string;
  cover: CoverReservation | null;
  path: NavigationPath | null;
  role?: SquadRole;
  side?: -1 | 1;
  flankNodeId?: string | null;
}

export interface SquadAssignOptions extends SquadRoleOptions {
  /** Enabling threat-aware planning switches on roles, flank nodes and crossfire cover. */
  threat?: Vec3;
}

/**
 * Deterministic role split for a squad engaging one threat.
 *
 * The nearest hostile pins the threat in place, the outermost hostiles peel off
 * to opposite sides, and a middle hostile keeps volume of fire up. Ordering is
 * by threat distance with an id tie-break so the same roster always produces
 * the same plan, which keeps replays and checkpoints stable.
 */
export function planSquadRoles(
  agents: readonly SquadAgent[],
  threat: Vec3,
  options: SquadRoleOptions = {},
): SquadRolePlan[] {
  const living = [...agents]
    .filter((agent) => agent.alive)
    .sort((a, b) => distance(a.position, threat) - distance(b.position, threat)
      || a.id.localeCompare(b.id));
  if (living.length === 0) return [];

  const facing = normalize(options.threatFacing ?? { x: 0, y: 0, z: 1 }) ?? { x: 0, y: 0, z: 1 };
  const maxFlankers = Math.max(0, Math.min(
    options.maxFlankers ?? (living.length >= 3 ? Math.min(2, Math.floor(living.length / 3)) : 0),
    Math.max(0, living.length - 1),
  ));
  const maxSuppressors = Math.max(0, Math.min(
    options.maxSuppressors ?? (living.length >= 4 ? 1 : 0),
    Math.max(0, living.length - 1 - maxFlankers),
  ));

  const roles = new Map<string, SquadRole>();
  // Farthest hostiles have the most room to work around the threat.
  for (let index = 0; index < maxFlankers; index += 1) {
    roles.set(living[living.length - 1 - index].id, 'flanker');
  }
  for (let index = 0; index < maxSuppressors; index += 1) {
    const candidate = living[living.length - 1 - maxFlankers - index];
    if (candidate) roles.set(candidate.id, 'suppressor');
  }
  if (living.length >= 3 && !roles.has(living[0].id)) roles.set(living[0].id, 'anchor');

  const used: Array<-1 | 1> = [];
  return living.map((agent) => {
    const relative = subtract(agent.position, threat);
    const lateral = facing.x * relative.z - facing.z * relative.x;
    let side: -1 | 1 = lateral >= 0 ? 1 : -1;
    const role = roles.get(agent.id) ?? 'assault';
    // Two flankers on the same side is just a second frontal push, so split them.
    if (role === 'flanker') {
      if (used.includes(side)) side = side === 1 ? -1 : 1;
      used.push(side);
    }
    return { agentId: agent.id, role, side };
  });
}

/** Small deterministic squad layer that assigns unique cover and graph paths. */
export class SquadDirector {
  constructor(
    private readonly graph: NavigationGraph,
    private readonly cover: CoverSlots,
  ) {}

  assign(
    agents: readonly SquadAgent[],
    preferredNodeId: string,
    options: SquadAssignOptions = {},
  ): SquadAssignment[] {
    const threat = options.threat;
    const plans = threat
      ? new Map(planSquadRoles(agents, threat, options).map((plan) => [plan.agentId, plan]))
      : null;
    return [...agents]
      .filter((agent) => agent.alive)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((agent) => {
        const plan = plans?.get(agent.id);
        let reservation: CoverReservation | null;
        if (!threat || !plan) {
          reservation = this.cover.reserveNearest(agent.id, agent.position);
        } else if (plan.role === 'flanker') {
          // A flanker on the move must not hold a slot a defender could use.
          this.cover.releaseOwner(agent.id);
          reservation = null;
        } else {
          reservation = this.cover.reserveBestAgainst(agent.id, agent.position, threat);
        }
        const target = reservation
          ? this.graph.getNode(preferredNodeId)
          : null;
        const origin = nearestNode(this.graph, agent.position);
        const flankNode = threat && plan?.role === 'flanker'
          ? this.graph.findFlankNode(agent.position, threat, { side: plan.side })
          : null;
        const destination = flankNode ?? target;
        const path = origin && destination
          ? this.graph.findPath(origin.id, destination.id)
          : null;
        return {
          agentId: agent.id,
          cover: reservation,
          path,
          ...(plan ? { role: plan.role, side: plan.side } : {}),
          ...(threat ? { flankNodeId: flankNode?.id ?? null } : {}),
        };
      });
  }

  releaseAgent(agentId: string): void {
    this.cover.releaseOwner(agentId);
  }
}

function lowestPriority(values: ReadonlySet<string>, priority: (value: string) => number): string {
  return [...values].sort((a, b) => priority(a) - priority(b) || a.localeCompare(b))[0]!;
}

function nearestNode(graph: NavigationGraph, position: Vec3): NavigationNode | null {
  return graph.nearestNode(position);
}

function copy(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

function subtract(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function magnitude(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

function distance(left: Vec3, right: Vec3): number {
  return magnitude(subtract(left, right));
}

/** Planar normalize; tactical scoring works on the ground plane only. */
function normalize(value: Vec3): Vec3 | null {
  const length = Math.hypot(value.x, value.z);
  if (length < 1e-6) return null;
  return { x: value.x / length, y: 0, z: value.z / length };
}

function dot(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.z * right.z;
}
