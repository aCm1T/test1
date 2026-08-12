import { describe, expect, it } from 'vitest';
import {
  CoverSlots,
  NavigationGraph,
  SquadDirector,
  planSquadRoles,
  type CapsuleSweep,
  type CharacterId,
  type CharacterIntent,
  type CharacterMoveResult,
  type InteractionQuery,
  type NavPath,
  type PathOptions,
  type PhysicsWorld,
  type RayHit,
  type RayQuery,
  type SurfaceTag,
  type SweepHit,
  type Vec3,
} from '../../src/simulation';

class SweepPhysics implements PhysicsWorld {
  constructor(private readonly blocked: ReadonlySet<string> = new Set()) {}
  step(): void {}
  moveCharacter(_body: CharacterId, _intent: CharacterIntent): CharacterMoveResult {
    throw new Error('not used');
  }
  castRay(_query: RayQuery): RayHit | null { return null; }
  sweepCapsule(query: CapsuleSweep): SweepHit | null {
    const key = `${query.position.x}:${query.position.z}->${query.position.x + query.direction.x}:${query.position.z + query.direction.z}`;
    return this.blocked.has(key)
      ? { colliderId: 'wall', point: query.position, normal: { x: 1, y: 0, z: 0 }, distance: 1, surface: 'concrete' }
      : null;
  }
  queryNavigation(_from: Vec3, _to: Vec3, _options?: PathOptions): NavPath | null { return null; }
  queryInteraction(_query: InteractionQuery): boolean { return false; }
  getSurfaceAt(_position: Vec3): SurfaceTag { return 'concrete'; }
}

describe('NavigationGraph', () => {
  it('rejects a graph edge when the shared capsule sweep is blocked', () => {
    const graph = new NavigationGraph(
      [
        { id: 'a', position: { x: 0, y: 0, z: 0 } },
        { id: 'b', position: { x: 2, y: 0, z: 0 } },
        { id: 'c', position: { x: 0, y: 0, z: 2 } },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'a', to: 'c' },
        { from: 'c', to: 'b' },
      ],
      new SweepPhysics(new Set(['0:0->2:0'])),
    );
    expect(graph.findPath('a', 'b')?.nodeIds).toEqual(['a', 'c', 'b']);
  });

  it('keeps cover reservations exclusive and deterministic', () => {
    const cover = new CoverSlots([
      { id: 'north', position: { x: 0, y: 0, z: 5 } },
      { id: 'south', position: { x: 0, y: 0, z: -5 } },
    ]);
    expect(cover.reserve('north', 'alpha')).toEqual({ slotId: 'north', ownerId: 'alpha' });
    expect(cover.reserve('north', 'bravo')).toBeNull();
    expect(cover.reserveNearest('bravo', { x: 0, y: 0, z: 3 })).toEqual({
      slotId: 'south', ownerId: 'bravo',
    });
    cover.releaseOwner('alpha');
    expect(cover.getReservation('north')).toBeNull();
  });

  it('prefers geometric proximity before using IDs as a deterministic tie-breaker', () => {
    const cover = new CoverSlots([
      { id: 'alpha-far', position: { x: 0, y: 0, z: 10 } },
      { id: 'zulu-near', position: { x: 0, y: 0, z: 1 } },
    ]);
    expect(cover.reserveNearest('alpha', { x: 0, y: 0, z: 0 })).toEqual({
      slotId: 'zulu-near',
      ownerId: 'alpha',
    });
  });

  it('round-trips cover ownership without allowing duplicate owners', () => {
    const cover = new CoverSlots([
      { id: 'left', position: { x: -1, y: 0, z: 0 } },
      { id: 'right', position: { x: 1, y: 0, z: 0 } },
    ]);
    cover.restore([
      { slotId: 'right', ownerId: 'bravo' },
      { slotId: 'left', ownerId: 'bravo' },
    ]);
    expect(cover.snapshot()).toEqual([{ slotId: 'right', ownerId: 'bravo' }]);
    expect(cover.getSlot('right')?.position).toEqual({ x: 1, y: 0, z: 0 });
  });

  it('gives a squad unique slots and graph paths', () => {
    const graph = new NavigationGraph(
      [
        { id: 'spawn', position: { x: 0, y: 0, z: 0 } },
        { id: 'cover', position: { x: 0, y: 0, z: 4 } },
      ],
      [{ from: 'spawn', to: 'cover' }],
      new SweepPhysics(),
    );
    const director = new SquadDirector(graph, new CoverSlots([
      { id: 'left', position: { x: -1, y: 0, z: 4 } },
      { id: 'right', position: { x: 1, y: 0, z: 4 } },
    ]));
    const assignments = director.assign([
      { id: 'bravo', position: { x: 0, y: 0, z: 0 }, alive: true },
      { id: 'alpha', position: { x: 0, y: 0, z: 0 }, alive: true },
    ], 'cover');
    expect(assignments.map((assignment) => assignment.cover?.slotId)).toEqual(['left', 'right']);
    expect(assignments.every((assignment) => assignment.path?.nodeIds.join(',') === 'spawn,cover')).toBe(true);
  });
});

const tacticalGraph = (edges?: readonly { from: string; to: string }[]) => new NavigationGraph(
  [
    { id: 'hold', position: { x: 0, y: 0, z: 14 } },
    { id: 'rally', position: { x: 0, y: 0, z: 10 } },
    { id: 'east', position: { x: 12, y: 0, z: 2 } },
    { id: 'west', position: { x: -12, y: 0, z: 2 } },
  ],
  edges ?? [
    { from: 'hold', to: 'rally' },
    { from: 'hold', to: 'east' },
    { from: 'hold', to: 'west' },
  ],
  new SweepPhysics(),
);

describe('tactical navigation queries', () => {
  it('answers a flank request with an off-axis node on the requested side', () => {
    const graph = tacticalGraph();
    const origin = { x: 0, y: 0, z: 14 };
    const threat = { x: 0, y: 0, z: 0 };

    expect(graph.findFlankNode(origin, threat, { side: 1 })?.id).toBe('west');
    expect(graph.findFlankNode(origin, threat, { side: -1 })?.id).toBe('east');
    // The node straight down the engagement axis is never a flank.
    expect(graph.findFlankNode(origin, threat)?.id).not.toBe('rally');
  });

  it('rejects flank nodes that are unreachable or too close to the threat', () => {
    const isolated = tacticalGraph([
      { from: 'hold', to: 'rally' },
      { from: 'hold', to: 'west' },
    ]);
    expect(isolated.findFlankNode({ x: 0, y: 0, z: 14 }, { x: 0, y: 0, z: 0 }, { side: -1 })?.id)
      .toBe('west');
    expect(isolated.findFlankNode(
      { x: 0, y: 0, z: 14 },
      { x: 0, y: 0, z: 0 },
      { side: -1, requireReachable: false },
    )?.id).toBe('east');

    // A threat standing on top of the only lateral nodes leaves no usable flank.
    expect(isolated.findFlankNode({ x: 0, y: 0, z: 14 }, { x: 0, y: 0, z: 0 }, {
      minThreatDistance: 30,
    })).toBeNull();
  });

  it('reports node neighbourhoods nearest-first for squad planning', () => {
    const graph = tacticalGraph();
    expect(graph.nodesWithinRadius({ x: 0, y: 0, z: 11 }, 5).map((node) => node.id))
      .toEqual(['rally', 'hold']);
    expect(graph.nodesWithinRadius({ x: 0, y: 0, z: 11 }, 0.5)).toEqual([]);
    // Equal distance falls back to the id tie-break so replays stay stable.
    expect(graph.nodesWithinRadius({ x: 0, y: 0, z: 12 }, 5).map((node) => node.id))
      .toEqual(['hold', 'rally']);
  });

  it('takes standoff cover with a peek instead of the slot in the threat’s lap', () => {
    const cover = new CoverSlots([
      { id: 'muzzle', position: { x: 0, y: 0, z: 1.5 } },
      { id: 'standoff', position: { x: 0, y: 0, z: 9 }, peekPosition: { x: 0.6, y: 0, z: 8.6 } },
    ]);
    expect(cover.reserveBestAgainst('alpha', { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 0 })?.slotId)
      .toBe('standoff');
    // Exclusivity still holds, so the squadmate takes the remaining slot.
    expect(cover.reserveBestAgainst('bravo', { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 0 })?.slotId)
      .toBe('muzzle');
  });

  it('breaks equally good cover in favour of a slot that can actually shoot', () => {
    const cover = new CoverSlots([
      { id: 'bare', position: { x: 5, y: 0, z: 7 } },
      { id: 'peeker', position: { x: -5, y: 0, z: 7 }, peekPosition: { x: -4.4, y: 0, z: 7 } },
    ]);
    expect(cover.reserveBestAgainst('alpha', { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 0 })?.slotId)
      .toBe('peeker');
  });

  it('ignores slots beyond the distance a hostile is willing to run', () => {
    const cover = new CoverSlots([{ id: 'far', position: { x: 0, y: 0, z: 40 } }]);
    expect(cover.reserveBestAgainst('alpha', { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 0 }, {
      maxTravelDistance: 10,
    })).toBeNull();
    expect(cover.reserveBestAgainst('alpha', { x: 0, y: 0, z: 12 }, { x: 0, y: 0, z: 0 })?.slotId)
      .toBe('far');
  });
});

describe('planSquadRoles', () => {
  const threat = { x: 0, y: 0, z: 0 };
  const squad = [
    { id: 'echo', position: { x: 0, y: 0, z: 26 }, alive: true },
    { id: 'alpha', position: { x: 0, y: 0, z: 6 }, alive: true },
    { id: 'delta', position: { x: -8, y: 0, z: 20 }, alive: true },
    { id: 'bravo', position: { x: 0, y: 0, z: 12 }, alive: true },
    { id: 'charlie', position: { x: 6, y: 0, z: 16 }, alive: true },
  ];

  it('pins with the nearest hostile and peels the outermost ones off the axis', () => {
    const plans = planSquadRoles(squad, threat, { threatFacing: { x: 0, y: 0, z: 1 } });
    expect(plans.map((plan) => `${plan.agentId}:${plan.role}`)).toEqual([
      'alpha:anchor',
      'bravo:assault',
      'charlie:assault',
      'delta:suppressor',
      'echo:flanker',
    ]);
  });

  it('never sends two flankers around the same side', () => {
    const plans = planSquadRoles(squad, threat, {
      maxFlankers: 2,
      threatFacing: { x: 0, y: 0, z: 1 },
    });
    const flankers = plans.filter((plan) => plan.role === 'flanker');
    expect(flankers.map((plan) => plan.agentId)).toEqual(['delta', 'echo']);
    expect(flankers[0].side).toBe(-flankers[1].side);
  });

  it('keeps at least one hostile on the threat and skips the dead', () => {
    const pair = planSquadRoles(squad.slice(0, 2), threat, { maxFlankers: 5 });
    expect(pair.filter((plan) => plan.role === 'flanker')).toHaveLength(1);

    const thinned = planSquadRoles(
      squad.map((agent) => (agent.id === 'echo' ? { ...agent, alive: false } : agent)),
      threat,
    );
    expect(thinned.map((plan) => plan.agentId)).not.toContain('echo');
    expect(thinned.map((plan) => plan.role)).toContain('flanker');
  });

  it('replays identically for the same roster', () => {
    const options = { threatFacing: { x: 0.3, y: 0, z: 0.9 } };
    expect(planSquadRoles(squad, threat, options))
      .toEqual(planSquadRoles([...squad].reverse(), threat, options));
  });
});

describe('SquadDirector threat-aware assignment', () => {
  it('routes the flanker wide and puts the rest into crossfire cover', () => {
    const graph = tacticalGraph();
    const cover = new CoverSlots([
      { id: 'left', position: { x: -1, y: 0, z: 10 } },
      { id: 'right', position: { x: 1, y: 0, z: 10 } },
      { id: 'deep', position: { x: 3, y: 0, z: 12 } },
    ]);
    const director = new SquadDirector(graph, cover);
    cover.reserve('deep', 'charlie');

    const assignments = director.assign([
      { id: 'charlie', position: { x: 0, y: 0, z: 20 }, alive: true },
      { id: 'alpha', position: { x: 0, y: 0, z: 9 }, alive: true },
      { id: 'bravo', position: { x: 0, y: 0, z: 13 }, alive: true },
    ], 'rally', { threat: { x: 0, y: 0, z: 0 }, threatFacing: { x: 0, y: 0, z: 1 } });

    const byId = new Map(assignments.map((assignment) => [assignment.agentId, assignment]));
    expect(byId.get('alpha')?.role).toBe('anchor');
    expect(byId.get('charlie')?.role).toBe('flanker');
    // A moving flanker must not sit on a slot a defender could use.
    expect(byId.get('charlie')?.cover).toBeNull();
    expect(cover.getReservationForOwner('charlie')).toBeNull();
    expect(byId.get('charlie')?.flankNodeId).toBe('west');
    expect(byId.get('charlie')?.path?.nodeIds).toEqual(['hold', 'west']);
    expect([byId.get('alpha')?.cover?.slotId, byId.get('bravo')?.cover?.slotId])
      .toEqual(['left', 'right']);
  });

  it('falls back to plain nearest-cover holding when no threat is known', () => {
    const director = new SquadDirector(tacticalGraph(), new CoverSlots([
      { id: 'left', position: { x: -1, y: 0, z: 10 } },
      { id: 'right', position: { x: 1, y: 0, z: 10 } },
    ]));
    const assignments = director.assign([
      { id: 'alpha', position: { x: 0, y: 0, z: 14 }, alive: true },
    ], 'rally');
    expect(assignments[0].role).toBeUndefined();
    expect(assignments[0].flankNodeId).toBeUndefined();
    expect(assignments[0].cover?.slotId).toBe('left');
  });
});
