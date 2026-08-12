/** Small, serializable PRNG used by deterministic gameplay and QA scenarios. */
export class SeededRandom {
  private state: number;

  constructor(seed = 0x6d2b79f5) {
    this.state = seed >>> 0 || 0x6d2b79f5;
  }

  next(): number {
    let t = (this.state += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  range(min: number, max: number): number {
    return min + (max - min) * this.next();
  }

  integer(min: number, maxInclusive: number): number {
    return Math.floor(this.range(min, maxInclusive + 1));
  }

  chance(probability: number): boolean {
    return this.next() < Math.max(0, Math.min(1, probability));
  }

  fork(salt: number): SeededRandom {
    const mixed = Math.imul(this.state ^ (salt >>> 0), 0x9e3779b1);
    return new SeededRandom((mixed ^ (mixed >>> 16)) >>> 0);
  }

  snapshot(): number {
    return this.state >>> 0;
  }

  restore(state: number): void {
    this.state = state >>> 0 || 0x6d2b79f5;
  }
}

export type RandomSource = () => number;

