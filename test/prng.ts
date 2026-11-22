/**
 * Tiny seeded PRNG (mulberry32) for deterministic property/fuzz tests.
 * Tests use fixed seeds by default; set BUILDRUSH_FUZZ_SEED to explore other
 * seeds. A failing property reports the seed and iteration so it reproduces.
 */
export class Rng {
  private s: number;
  constructor(readonly seed: number) {
    this.s = seed >>> 0;
  }
  /** Float in [0, 1). */
  next(): number {
    this.s = (this.s + 0x6d2b79f5) >>> 0;
    let t = this.s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  }
  /** Integer in [lo, hi] inclusive. */
  int(lo: number, hi: number): number {
    return lo + Math.floor(this.next() * (hi - lo + 1));
  }
  bool(p = 0.5): boolean {
    return this.next() < p;
  }
  pick<T>(xs: readonly T[]): T {
    return xs[this.int(0, xs.length - 1)]!;
  }
  /** Fisher-Yates shuffle (returns a new array). */
  shuffle<T>(xs: readonly T[]): T[] {
    const a = xs.slice();
    for (let i = a.length - 1; i > 0; i--) {
      const j = this.int(0, i);
      [a[i], a[j]] = [a[j]!, a[i]!];
    }
    return a;
  }
  string(alphabet: readonly string[], minLen: number, maxLen: number): string {
    const n = this.int(minLen, maxLen);
    let out = '';
    for (let i = 0; i < n; i++) out += this.pick(alphabet);
    return out;
  }
}

const ONLY_SEED = process.env['BUILDRUSH_FUZZ_SEED'] ? Number(process.env['BUILDRUSH_FUZZ_SEED']) : undefined;

/**
 * Run `body` for `iterations` iterations, each with its own deterministic Rng.
 * On failure the error is rethrown with the seed; set BUILDRUSH_FUZZ_SEED=<seed>
 * to replay exactly that one case.
 */
export function forAll(name: string, baseSeed: number, iterations: number, body: (rng: Rng, i: number) => void): void {
  const count = ONLY_SEED === undefined ? iterations : 1;
  for (let i = 0; i < count; i++) {
    const seed = ONLY_SEED === undefined ? (baseSeed + i) >>> 0 : ONLY_SEED >>> 0;
    const rng = new Rng(seed);
    try {
      body(rng, i);
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      err.message = `[${name}] FAILED seed=${seed} (iteration ${i}; replay: BUILDRUSH_FUZZ_SEED=${seed}) -- ${err.message}`;
      throw err;
    }
  }
}
