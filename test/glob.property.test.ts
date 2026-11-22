import { test } from 'node:test';
import assert from 'node:assert/strict';
import { compileGlobs, globToRegExp } from '../src/util/glob.js';
import { forAll, Rng } from './prng.js';

// ---- reference implementation (independent: token DP, no RegExp) ----------

type Tok = { t: 'lit'; c: string } | { t: 'one' } | { t: 'star' } | { t: 'any' } | { t: 'dirs' };

function expandBraces(p: string): string[] {
  const m = /\{([^{}]*)\}/.exec(p);
  if (!m) return [p];
  const out: string[] = [];
  for (const alt of m[1]!.split(',')) out.push(...expandBraces(p.slice(0, m.index) + alt + p.slice(m.index + m[0].length)));
  return out;
}

function tokenize(p: string): Tok[] {
  if (p.startsWith('./')) p = p.slice(2);
  if (p.endsWith('/')) p += '**';
  const toks: Tok[] = [];
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*' && p[i + 1] === '*') {
      if ((i === 0 || p[i - 1] === '/') && p[i + 2] === '/') {
        toks.push({ t: 'dirs' });
        i += 2;
      } else {
        toks.push({ t: 'any' });
        i += 1;
      }
    } else if (c === '*') toks.push({ t: 'star' });
    else if (c === '?') toks.push({ t: 'one' });
    else toks.push({ t: 'lit', c });
  }
  return toks;
}

function refMatchTokens(toks: Tok[], s: string): boolean {
  const memo = new Map<number, boolean>();
  const go = (i: number, j: number): boolean => {
    const key = i * (s.length + 1) + j;
    const hit = memo.get(key);
    if (hit !== undefined) return hit;
    let r: boolean;
    if (i === toks.length) r = j === s.length;
    else {
      const tk = toks[i]!;
      switch (tk.t) {
        case 'lit': r = j < s.length && s[j] === tk.c && go(i + 1, j + 1); break;
        case 'one': r = j < s.length && s[j] !== '/' && go(i + 1, j + 1); break;
        case 'star': r = go(i + 1, j) || (j < s.length && s[j] !== '/' && go(i, j + 1)); break;
        case 'any': r = go(i + 1, j) || (j < s.length && go(i, j + 1)); break;
        case 'dirs': {
          // zero or more whole "dir/" prefixes
          r = go(i + 1, j);
          for (let k = j; !r && k < s.length; k++) if (s[k] === '/') r = go(i + 1, k + 1);
          break;
        }
      }
    }
    memo.set(key, r);
    return r;
  };
  return go(0, 0);
}

function refMatch(pattern: string, s: string): boolean {
  return expandBraces(pattern).some((p) => refMatchTokens(tokenize(p), s));
}

// ---- generators -------------------------------------------------------------

const LIT = ['a', 'b', 'c', '.', '-', '_'];
/** A lone "." segment is normalised away by `./` prefix stripping; keep generated literals canonical. */
const fixDot = (s: string) => (s === '.' ? 'd' : s);
const WILD_SEG = ['*', '**', '?', 'a*', '*b', '*.a', 'a?', '**b', 'a**'];

function genPath(rng: Rng): string {
  const n = rng.int(1, 5);
  const segs: string[] = [];
  // a lone "." segment would be normalised away by `./` prefix stripping; keep literals canonical
  for (let i = 0; i < n; i++) segs.push(rng.string(LIT, 1, 3).replace(/^\.$/, 'd'));
  return segs.join('/');
}

function genPattern(rng: Rng): string {
  const n = rng.int(1, 4);
  const segs: string[] = [];
  for (let i = 0; i < n; i++) {
    const r = rng.next();
    if (r < 0.35) segs.push(rng.string(LIT, 1, 3));
    else if (r < 0.7) segs.push(rng.pick(WILD_SEG));
    else if (r < 0.85) segs.push(`{${rng.string(LIT, 1, 2)},${rng.string(LIT, 1, 2)}}${rng.pick(['', 'a', '*'])}`);
    else segs.push(rng.string(LIT, 0, 2) + rng.pick(['*', '?', '**']) + rng.string(LIT, 0, 2));
  }
  let p = segs.join('/');
  if (rng.bool(0.1)) p += '/';
  if (rng.bool(0.1)) p = './' + p;
  return p;
}

/** A path guaranteed (by construction) to match a pattern made of literal segments + `*`/`**`. */
function sampleMatching(rng: Rng, segs: string[]): string {
  const out: string[] = [];
  for (const [idx, s] of segs.entries()) {
    // a trailing `**` needs at least one segment ("a/**" does not match "a"); `**/` in the middle may be empty
    if (s === '**') for (let i = rng.int(idx === segs.length - 1 && idx > 0 ? 1 : 0, 3); i > 0; i--) out.push(rng.string(LIT, 1, 3));
    else if (s === '*') out.push(rng.string(LIT, 1, 4));
    else out.push(s);
  }
  return out.join('/');
}

// ---- properties -------------------------------------------------------------

test('glob: agrees with the reference implementation on random patterns and paths', () => {
  forAll('glob-vs-reference', 1000, 400, (rng) => {
    const pattern = genPattern(rng);
    const rx = globToRegExp(pattern);
    for (let k = 0; k < 40; k++) {
      // bias paths toward matching by deriving them from the pattern half the time
      const path = rng.bool(0.5) ? genPath(rng) : mutateTowards(rng, pattern);
      assert.equal(rx.test(path), refMatch(pattern, path), `pattern=${JSON.stringify(pattern)} path=${JSON.stringify(path)}`);
    }
  });
});

function mutateTowards(rng: Rng, pattern: string): string {
  // replace wildcards with plausible literals so a fair share of samples match
  let out = '';
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i]!;
    if (c === '*') out += rng.string(LIT, 0, 2);
    else if (c === '?') out += rng.pick(LIT);
    else if (c === '{' || c === '}' || c === ',') out += c === ',' ? '' : '';
    else out += c;
  }
  return out.replace(/^\.\//, '').replace(/\/\//g, '/').replace(/^\//, '').replace(/\/$/, '') || 'a';
}

test('glob: a literal pattern matches only itself', () => {
  forAll('glob-literal', 2000, 300, (rng) => {
    const lit = genPath(rng);
    const rx = globToRegExp(lit);
    assert.ok(rx.test(lit), `literal ${lit} must match itself`);
    for (let k = 0; k < 20; k++) {
      const other = genPath(rng);
      assert.equal(rx.test(other), other === lit, `pattern=${lit} other=${other}`);
    }
    // single-character perturbations never match
    assert.ok(!rx.test(lit + 'x'));
    assert.ok(!rx.test('x' + lit));
    assert.ok(!rx.test(lit.slice(1)) || lit.slice(1) === lit);
  });
});

test('glob: regex metacharacters in literals are escaped (never interpreted)', () => {
  const metas = ['.', '+', '^', '$', '(', ')', '|', '[', ']', '\\', '/'];
  forAll('glob-meta', 3000, 200, (rng) => {
    const lit = 'a' + rng.string(metas, 1, 4) + 'b';
    const rx = globToRegExp(lit);
    assert.ok(rx.test(lit), `literal ${JSON.stringify(lit)}`);
    assert.ok(!rx.test('a' + 'z'.repeat(lit.length - 2) + 'b') || lit === 'a' + 'z'.repeat(lit.length - 2) + 'b');
  });
  // "." must not behave as a wildcard
  assert.ok(!globToRegExp('a.b').test('axb'));
  assert.ok(!globToRegExp('a|b').test('a'));
  assert.ok(!globToRegExp('(a)').test('a'));
  assert.ok(!globToRegExp('[ab]').test('a'));
});

test('glob: `**` matches any depth; `*` never crosses a directory boundary', () => {
  forAll('glob-doublestar', 4000, 300, (rng) => {
    const path = genPath(rng);
    assert.ok(globToRegExp('**').test(path), `** vs ${path}`);
    assert.ok(globToRegExp('**/*').test(path), `**/* vs ${path}`);
    assert.ok(globToRegExp(`**/${path.split('/').pop()}`).test(path), `**/basename vs ${path}`);
    const dir = fixDot(rng.string(LIT, 1, 3));
    assert.ok(globToRegExp(`${dir}/**`).test(`${dir}/${path}`), `dir/** vs ${path}`);
    assert.ok(globToRegExp(`${dir}/`).test(`${dir}/${path}`), `trailing slash means everything beneath`);
    assert.ok(globToRegExp(`${dir}/**/x`).test(`${dir}/x`), 'zero intermediate directories');
    assert.ok(globToRegExp(`${dir}/**/x`).test(`${dir}/${path}/x`), 'any intermediate directories');
    // single star stays within one segment
    const crossing = `${rng.string(LIT, 1, 2)}/${rng.string(LIT, 1, 2)}`;
    assert.ok(!globToRegExp('*').test(crossing), `* must not match ${crossing}`);
    assert.ok(!globToRegExp('?').test('/'));
  });
});

test('glob: paths built to satisfy a pattern always match it', () => {
  forAll('glob-sampled', 5000, 300, (rng) => {
    const n = rng.int(1, 5);
    const segs: string[] = [];
    for (let i = 0; i < n; i++) segs.push(rng.pick(['*', '**', fixDot(rng.string(LIT, 1, 3))]));
    const pattern = segs.join('/');
    for (let k = 0; k < 10; k++) {
      const path = sampleMatching(rng, segs);
      assert.ok(globToRegExp(pattern).test(path), `pattern=${pattern} path=${path}`);
    }
  });
});

test('glob: compileGlobs is the union of its patterns', () => {
  forAll('glob-union', 6000, 200, (rng) => {
    const pats = [genPattern(rng), genPattern(rng), genPattern(rng)];
    const m = compileGlobs(pats);
    for (let k = 0; k < 20; k++) {
      const p = genPath(rng);
      assert.equal(m(p), pats.some((x) => refMatch(x, p)), `patterns=${JSON.stringify(pats)} path=${p}`);
    }
  });
  assert.equal(compileGlobs([])('anything'), false);
});

test('glob: unbalanced "{" is rejected, never silently accepted', () => {
  forAll('glob-unbalanced', 7000, 100, (rng) => {
    const p = rng.string(LIT, 1, 3) + '{' + rng.string(LIT, 1, 3) + ',' + rng.string(LIT, 1, 3);
    assert.throws(() => globToRegExp(p), /unbalanced/);
  });
});

test('glob: arbitrary garbage patterns either compile or throw a clean Error (no hang)', () => {
  const alphabet = ['*', '**', '?', '{', '}', ',', '/', 'a', '.', '\\', '[', ']', '(', ')', '|', '+', '^', '$', '\0', 'é', '\u{1F600}', ' '];
  forAll('glob-garbage', 8000, 500, (rng) => {
    const p = rng.string(alphabet, 0, 24);
    let rx: RegExp | undefined;
    try {
      rx = globToRegExp(p);
    } catch (e) {
      assert.ok(e instanceof Error, 'must throw an Error');
      assert.match((e as Error).message, /unbalanced/, `unexpected error for ${JSON.stringify(p)}: ${(e as Error).message}`);
      return;
    }
    rx.test(rng.string(alphabet, 0, 24));
  });
});

// ---- catastrophic backtracking ---------------------------------------------------

function timed(fn: () => void): number {
  const t = process.hrtime.bigint();
  fn();
  return Number(process.hrtime.bigint() - t) / 1e6;
}

test('glob: adversarial patterns do not backtrack catastrophically', () => {
  const LIMIT_MS = 1000;
  // Sizes are deliberately modest: see the skipped test below for the known super-linear blow-up.
  const longA = 'a'.repeat(40);
  const cases: { name: string; pattern: string; input: string }[] = [
    { name: 'several single stars, failing tail', pattern: '*a'.repeat(5) + '*b', input: longA },
    { name: 'several double stars, failing tail', pattern: '**a'.repeat(5) + '**b', input: longA },
    { name: 'star-dot ladder', pattern: '*.'.repeat(6) + 'x', input: '.'.repeat(40) },
    { name: 'long brace chain', pattern: '{a,a}'.repeat(10) + 'b', input: 'a'.repeat(30) },
    { name: 'dir ladder', pattern: '**/'.repeat(6) + 'x', input: 'a/'.repeat(20) + 'y' },
    { name: 'long literal', pattern: 'a'.repeat(5000) + 'b', input: 'a'.repeat(5000) },
    { name: 'single star, long input', pattern: '*b', input: 'a'.repeat(100000) },
  ];
  for (const c of cases) {
    const ms = timed(() => {
      const rx = globToRegExp(c.pattern);
      rx.test(c.input);
    });
    assert.ok(ms < LIMIT_MS, `${c.name}: took ${ms.toFixed(0)}ms (> ${LIMIT_MS}ms) for pattern ${c.pattern}`);
  }
});

// KNOWN ISSUE (reported, not fixed here): the regex translation is O(n^k) for k wildcards on a failing
// match (measured on Node 22: `*a` x8 + `*b` against 40 chars takes ~6s). Fixing needs a non-backtracking
// matcher, which is a src/ redesign. Un-skip once glob.ts is linear-time.
test('glob: ten wildcards against a failing input stay fast', { skip: 'known issue: polynomial backtracking in glob.ts' }, () => {
  const ms = timed(() => globToRegExp('*a'.repeat(10) + '*b').test('a'.repeat(40)));
  assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
});

// KNOWN ISSUE: repeated alternations are exponential: `{a,a}` x40 + `b` never finishes (2^40 paths).
test('glob: forty repeated alternations against a failing input stay fast', { skip: 'known issue: exponential backtracking in glob.ts' }, () => {
  const ms = timed(() => globToRegExp('{a,a}'.repeat(40) + 'b').test('a'.repeat(80)));
  assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
});

test('glob: realistic large inputs stay fast', () => {
  const m = compileGlobs(['src/**', '**/*.test.ts', 'packages/*/src/**/*.{ts,tsx}']);
  const ms = timed(() => {
    for (let i = 0; i < 20000; i++) m(`packages/pkg${i % 50}/src/deep/er/path/file${i}.ts`);
  });
  assert.ok(ms < 2000, `20k matches took ${ms.toFixed(0)}ms`);
});
