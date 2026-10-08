// Seeded, serializable PRNG (mulberry32). All game logic randomness goes through an Rng
// instance so seasons and plays are reproducible and testable. Never use Math.random in logic.

export class Rng {
  /** @param {number} [seed] */
  constructor(seed = 0x2f6b9a1d) {
    this.state = seed >>> 0;
  }

  /** @returns {number} float in [0, 1) */
  next() {
    let t = (this.state = (this.state + 0x6d2b79f5) >>> 0);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }

  /** float in [a, b) */
  float(a = 0, b = 1) {
    return a + (b - a) * this.next();
  }

  /** integer in [a, b] inclusive */
  int(a, b) {
    return a + Math.floor(this.next() * (b - a + 1));
  }

  /** true with probability p */
  chance(p) {
    return this.next() < p;
  }

  /** @template T @param {T[]} arr @returns {T} */
  pick(arr) {
    return arr[Math.floor(this.next() * arr.length)];
  }

  /** Fisher-Yates in place; returns arr. @template T @param {T[]} arr */
  shuffle(arr) {
    for (let i = arr.length - 1; i > 0; i--) {
      const j = Math.floor(this.next() * (i + 1));
      [arr[i], arr[j]] = [arr[j], arr[i]];
    }
    return arr;
  }

  /** Gaussian via Box-Muller. */
  normal(mean = 0, sd = 1) {
    const u = 1 - this.next();
    const v = this.next();
    return mean + sd * Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
  }

  /** Pick index by weights. @param {number[]} weights */
  weightedIndex(weights) {
    const total = weights.reduce((a, b) => a + b, 0);
    let r = this.next() * total;
    for (let i = 0; i < weights.length; i++) {
      r -= weights[i];
      if (r < 0) return i;
    }
    return weights.length - 1;
  }

  /** @template T @param {T[]} items @param {number[]} weights @returns {T} */
  weighted(items, weights) {
    return items[this.weightedIndex(weights)];
  }

  /** Derive an independent child generator (e.g. one per play or per game). */
  fork(salt = 0) {
    const s = (Math.imul(this.state ^ 0x9e3779b9, 0x85ebca6b) + Math.imul(salt + 1, 0xc2b2ae35)) >>> 0;
    this.next();
    return new Rng(s);
  }

  getState() {
    return this.state;
  }

  setState(s) {
    this.state = s >>> 0;
  }
}

/** Seed from wall clock; only for creating NEW franchises/sessions, never inside logic. */
export function freshSeed() {
  return ((Date.now() ^ (performance.now() * 1000)) >>> 0) || 1;
}
