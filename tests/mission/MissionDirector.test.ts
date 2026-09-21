import { describe, expect, it } from 'vitest';
import { MissionDirector, SeededRandom, shouldApplyCombatDamage } from '../../src/mission';

const at = (x: number, z: number) => ({ x, y: 0, z });

describe('MissionDirector', () => {
  it('requires both authored trigger entry and encounter completion', () => {
    const mission = new MissionDirector({ defenseDuration: 2 });

    mission.update(1 / 60, { playerPosition: at(0, 7) });
    expect(mission.getBeat()).toBe('insertion');
    mission.update(1 / 60, {
      playerPosition: at(30, 7),
      firstContactComplete: true,
    });
    expect(mission.getBeat()).toBe('insertion');

    mission.update(1 / 60, {
      playerPosition: at(0, 7),
      firstContactComplete: true,
    });
    expect(mission.getBeat()).toBe('intersection');
    mission.update(1 / 60, {
      playerPosition: at(0, 18),
      intersectionClear: true,
    });
    expect(mission.getBeat()).toBe('jammer');
    mission.update(1 / 60, {
      playerPosition: at(1, 19),
      jammerDisabled: true,
    });
    expect(mission.getBeat()).toBe('defense');
    mission.update(2, { playerPosition: at(1, 19) });
    expect(mission.getBeat()).toBe('extraction');
    mission.update(1 / 60, { playerPosition: at(0, 30) });
    expect(mission.getBeat()).toBe('complete');
  });

  it('keeps the defense timer ticking after the player briefly leaves the zone', () => {
    const mission = new MissionDirector({ defenseDuration: 10, encounterLull: 0 });
    mission.update(1 / 60, { playerPosition: at(0, 7), firstContactComplete: true });
    mission.update(1 / 60, { playerPosition: at(0, 18), intersectionClear: true });
    mission.update(1 / 60, { playerPosition: at(1, 19), jammerDisabled: true });
    expect(mission.getBeat()).toBe('defense');
    expect(mission.getDebugState().defenseRemaining).toBeCloseTo(10, 5);

    // Step outside the authored defense radius — CoD-style hold keeps counting.
    mission.update(3, { playerPosition: at(40, 19) });
    expect(mission.getBeat()).toBe('defense');
    expect(mission.getDebugState().defenseRemaining).toBeCloseTo(7, 5);
    expect(mission.getDebugState().encounters.defenseStarted).toBe(true);

    mission.update(7, { playerPosition: at(40, -20) });
    expect(mission.getBeat()).toBe('extraction');
  });
});

describe('MissionDirector combat pacing', () => {
  it('exposes the post-transition combat directive on the same update that clears the jammer', () => {
    const mission = new MissionDirector({ encounterLull: 0 });
    mission.update(1 / 60, { playerPosition: at(0, 7), firstContactComplete: true });
    mission.update(1 / 60, { playerPosition: at(0, 18), intersectionClear: true });
    expect(mission.getCombatDirective().beat).toBe('jammer');

    // Fixed-tick contract (main.updateNavigationAndAI): mission.update runs
    // before applyCombatDirective so defense pressure applies the same step
    // the jammer clears — not deferred to the following tick.
    mission.update(1 / 60, { playerPosition: at(1, 19), jammerDisabled: true });
    const sameTick = mission.getCombatDirective();
    expect(sameTick.beat).toBe('defense');
    expect(sameTick.aggression).toBeGreaterThan(0);
    expect(sameTick.lullRemaining).toBe(0);
  });

  it('grants the encounter lull when disableJammer clears via the live side door', () => {
    const mission = new MissionDirector({ encounterLull: 4 });
    mission.update(1 / 60, { playerPosition: at(0, 7), firstContactComplete: true });
    mission.update(1 / 60, { playerPosition: at(0, 18), intersectionClear: true });
    expect(mission.getBeat()).toBe('jammer');

    // Historical live path: interact called disableJammer() then update() without
    // jammerDisabled on the frame. That must still earn the defense breather.
    mission.disableJammer();
    mission.update(1 / 60, { playerPosition: at(1, 19) });
    const sameTick = mission.getCombatDirective();
    expect(sameTick.beat).toBe('defense');
    expect(sameTick.lullRemaining).toBeCloseTo(4 - 1 / 60, 5);

    const noLull = new MissionDirector({ encounterLull: 0 });
    noLull.update(1 / 60, { playerPosition: at(0, 7), firstContactComplete: true });
    noLull.update(1 / 60, { playerPosition: at(0, 18), intersectionClear: true });
    noLull.update(1 / 60, { playerPosition: at(1, 19), jammerDisabled: true });
    expect(sameTick.aggression).toBeLessThan(noLull.getCombatDirective().aggression);
  });

  it('escalates squad pressure beat by beat and peaks late in the defense', () => {
    const mission = new MissionDirector({ defenseDuration: 100, encounterLull: 0 });
    const insertion = mission.getCombatDirective();
    expect(insertion.beat).toBe('insertion');
    expect(insertion.allowFlanking).toBe(false);

    mission.update(1 / 60, { playerPosition: at(0, 7), firstContactComplete: true });
    const intersection = mission.getCombatDirective();
    expect(intersection.beat).toBe('intersection');
    expect(intersection.aggression).toBeGreaterThan(insertion.aggression);
    expect(intersection.allowFlanking).toBe(true);

    mission.update(1 / 60, { playerPosition: at(0, 18), intersectionClear: true });
    mission.update(1 / 60, { playerPosition: at(1, 19), jammerDisabled: true });
    expect(mission.getBeat()).toBe('defense');
    const defenseOpening = mission.getCombatDirective();

    // Hold the objective until the clock is nearly out.
    mission.update(85, { playerPosition: at(1, 19) });
    const defenseFinale = mission.getCombatDirective();
    expect(defenseFinale.aggression).toBeGreaterThan(defenseOpening.aggression);
    expect(defenseFinale.aliveTarget).toBeGreaterThan(defenseOpening.aliveTarget);
    expect(defenseFinale.reinforcementDelay).toBeLessThan(defenseOpening.reinforcementDelay);
    expect(defenseFinale.maxFireSlots).toBeGreaterThanOrEqual(defenseOpening.maxFireSlots);
  });

  it('grants a breather after a cleared encounter and to a badly hurt player', () => {
    const mission = new MissionDirector({ encounterLull: 5 });
    mission.update(1 / 60, { playerPosition: at(0, 40) });
    const committed = mission.getCombatDirective();
    expect(committed.lullRemaining).toBe(0);

    mission.update(1 / 60, { playerPosition: at(0, 40), firstContactComplete: true });
    const lull = mission.getCombatDirective();
    expect(lull.lullRemaining).toBeGreaterThan(0);
    expect(lull.aggression).toBeLessThan(committed.aggression);
    expect(lull.aliveTarget).toBeLessThan(committed.aliveTarget);
    expect(lull.reinforcementDelay).toBeGreaterThan(committed.reinforcementDelay);

    // Running the lull out restores the beat's authored pressure.
    mission.update(5, { playerPosition: at(0, 40) });
    expect(mission.getCombatDirective().aggression).toBe(committed.aggression);

    mission.update(1 / 60, { playerPosition: at(0, 40), playerHealthFraction: 0.2 });
    expect(mission.getCombatDirective().aggression).toBeLessThan(committed.aggression);
  });

  it('slows reinforcements while the fight is already crowded', () => {
    const mission = new MissionDirector({ encounterLull: 0 });
    mission.update(1 / 60, { playerPosition: at(0, 40), hostilesAlive: 1 });
    const calm = mission.getCombatDirective();
    mission.update(1 / 60, { playerPosition: at(0, 40), hostilesAlive: calm.aliveTarget + 3 });
    const crowded = mission.getCombatDirective();
    expect(crowded.reinforcementDelay).toBeGreaterThan(calm.reinforcementDelay);
    expect(crowded.aliveTarget).toBe(calm.aliveTarget);
  });

  it('round-trips the pacing lull through snapshot and checkpoint restore', () => {
    const mission = new MissionDirector({ encounterLull: 6 });
    mission.update(0.1, { playerPosition: at(0, 7), firstContactComplete: true });
    mission.update(0.1, { playerPosition: at(0, 18), intersectionClear: true });
    mission.update(0.1, { playerPosition: at(2, 19), jammerDisabled: true });
    mission.update(4, { playerPosition: at(2, 19) });
    const state = mission.snapshot();
    expect(state.lullRemaining).toBeCloseTo(2, 5);

    mission.update(10, { playerPosition: at(2, 19) });
    expect(mission.getCombatDirective().lullRemaining).toBe(0);
    mission.restore(state);
    expect(mission.snapshot()).toEqual(state);
    expect(mission.getCombatDirective().lullRemaining).toBeCloseTo(2, 5);

    // A restore always hands the player the same breather as a cleared fight.
    mission.restoreCheckpoint();
    expect(mission.getCombatDirective().lullRemaining).toBe(6);
  });

  it('round-trips hostilesAlive and playerHealthFraction for combat directives', () => {
    const mission = new MissionDirector({ encounterLull: 0 });
    mission.update(1 / 60, {
      playerPosition: at(0, 40),
      hostilesAlive: 9,
      playerHealthFraction: 0.2,
    });
    const directive = mission.getCombatDirective();
    const state = mission.snapshot();
    expect(state.hostilesAlive).toBe(9);
    expect(state.playerHealthFraction).toBeCloseTo(0.2, 5);

    // Mutate telemetry so a blind restore is the only way back.
    mission.update(1 / 60, {
      playerPosition: at(0, 40),
      hostilesAlive: 1,
      playerHealthFraction: 1,
    });
    expect(mission.getCombatDirective().aggression).toBeGreaterThan(directive.aggression);
    expect(mission.getCombatDirective().reinforcementDelay).toBeLessThan(directive.reinforcementDelay);

    mission.restore(state);
    expect(mission.snapshot()).toEqual(state);
    expect(mission.getCombatDirective()).toEqual(directive);
  });
});

describe('combat damage after extract', () => {
  it('blocks combat damage once the mission is complete, paused, or failed', () => {
    const live = {
      playing: true,
      paused: false,
      playerDead: false,
      beat: 'extraction' as const,
    };
    expect(shouldApplyCombatDamage(live)).toBe(true);
    expect(shouldApplyCombatDamage({ ...live, beat: 'complete' })).toBe(false);
    expect(shouldApplyCombatDamage({ ...live, paused: true })).toBe(false);
    expect(shouldApplyCombatDamage({ ...live, beat: 'failed' })).toBe(false);
    expect(shouldApplyCombatDamage({ ...live, playerDead: true })).toBe(false);
    expect(shouldApplyCombatDamage({ ...live, playing: false })).toBe(false);
  });

  it('keeps opening gunfire warning-only for the deterministic grace window', () => {
    const opening = {
      playing: true,
      paused: false,
      playerDead: false,
      beat: 'insertion' as const,
      openingProtectionSeconds: 2.5,
    };
    expect(shouldApplyCombatDamage({ ...opening, missionElapsed: 0 })).toBe(false);
    expect(shouldApplyCombatDamage({ ...opening, missionElapsed: 2.49 })).toBe(false);
    expect(shouldApplyCombatDamage({ ...opening, missionElapsed: 2.5 })).toBe(true);
    expect(shouldApplyCombatDamage({ ...opening, missionElapsed: 10 })).toBe(true);
    expect(shouldApplyCombatDamage({ ...opening, beat: 'intersection' })).toBe(true);
  });
});

describe('SeededRandom', () => {
  it('replays the same sequence for the same seed', () => {
    const a = new SeededRandom(714);
    const b = new SeededRandom(714);
    expect(Array.from({ length: 12 }, () => a.next())).toEqual(
      Array.from({ length: 12 }, () => b.next()),
    );
  });
});
