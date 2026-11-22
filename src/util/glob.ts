/**
 * Minimal, dependency-free glob matcher for project-relative POSIX paths.
 *
 * Supported: `**` (any depth), `*`, `?`, `{a,b}` alternation. A trailing `/`
 * means "everything beneath". Dotfiles ARE matched (conservative for inputs).
 * Everything else is literal. No negation: use `ignore` for exclusion.
 *
 * Matching simulates a Thompson NFA, so it runs in O(path length x pattern size) with no
 * backtracking. Globs come from project configuration, which is untrusted input; the previous
 * regex translation took exponential time on adversarial patterns (e.g. `{a,a}` repeated).
 */

export interface GlobMatcher {
  test(path: string): boolean;
}

// ---- tokens -----------------------------------------------------------------------------------
type Tok =
  | { t: 'lit'; c: string }
  | { t: 'any1' } //   ?    one char, not "/"
  | { t: 'star' } //   *    any run without "/"
  | { t: 'dstar' } //  **   any run, "/" included
  | { t: 'dslash' } // **/  zero or more whole directories
  | { t: 'open' }
  | { t: 'close' }
  | { t: 'comma' };

function tokenize(pattern: string): Tok[] {
  let p = pattern.replace(/^\.\//, '');
  if (p.endsWith('/')) p += '**';
  const out: Tok[] = [];
  let depth = 0;
  for (let i = 0; i < p.length; i++) {
    const c = p[i]!;
    if (c === '*') {
      if (p[i + 1] === '*') {
        const atStart = i === 0 || p[i - 1] === '/';
        if (atStart && p[i + 2] === '/') {
          out.push({ t: 'dslash' });
          i += 2; // the "/" after "**" belongs to the token
        } else {
          out.push({ t: 'dstar' });
          i += 1;
        }
      } else out.push({ t: 'star' });
    } else if (c === '?') out.push({ t: 'any1' });
    else if (c === '{') {
      depth++;
      out.push({ t: 'open' });
    } else if (c === '}' && depth > 0) {
      depth--;
      out.push({ t: 'close' });
    } else if (c === ',' && depth > 0) out.push({ t: 'comma' });
    else out.push({ t: 'lit', c });
  }
  if (depth !== 0) throw new Error(`unbalanced "{" in glob: ${pattern}`);
  return out;
}

// ---- syntax tree ------------------------------------------------------------------------------
type Node = Tok | { t: 'alt'; alts: Node[][] };

function parse(toks: Tok[]): Node[] {
  let pos = 0;
  const seq = (): Node[] => {
    const items: Node[] = [];
    while (pos < toks.length) {
      const k = toks[pos]!;
      if (k.t === 'close' || k.t === 'comma') break;
      pos++;
      if (k.t === 'open') {
        const alts: Node[][] = [seq()];
        while (toks[pos]?.t === 'comma') {
          pos++;
          alts.push(seq());
        }
        pos++; // the matching "close" (guaranteed by tokenize's balance check)
        items.push({ t: 'alt', alts });
      } else items.push(k);
    }
    return items;
  };
  return seq();
}

// ---- NFA --------------------------------------------------------------------------------------
const CHAR = 0; //      consume exactly `ch`
const NOT_SLASH = 1; // consume any one char except "/"
const NOT_EOL = 2; //   consume any one char except line terminators (what regex `.` accepts)
const SPLIT = 3; //     epsilon to `a` and `b`
const MATCH = 4;

class Nfa {
  kind: number[] = [];
  ch: string[] = [];
  a: number[] = [];
  b: number[] = [];
  start = 0;

  add(kind: number, a = -1, b = -1, ch = ''): number {
    this.kind.push(kind);
    this.a.push(a);
    this.b.push(b);
    this.ch.push(ch);
    return this.kind.length - 1;
  }

  /** Emit `nodes` so that they continue into state `next`; returns the entry state. */
  emit(nodes: Node[], next: number): number {
    let cur = next;
    for (let i = nodes.length - 1; i >= 0; i--) cur = this.emitOne(nodes[i]!, cur);
    return cur;
  }

  private loop(consumer: number, next: number): number {
    const s = this.add(SPLIT, -1, next);
    const body = this.add(consumer, s);
    this.a[s] = body;
    return s;
  }

  private emitOne(n: Node, next: number): number {
    switch (n.t) {
      case 'lit':
        return this.add(CHAR, next, -1, n.c);
      case 'any1':
        return this.add(NOT_SLASH, next);
      case 'star':
        return this.loop(NOT_SLASH, next);
      case 'dstar':
        return this.loop(NOT_EOL, next);
      case 'dslash': {
        // (?:.*/)?  =  skip, or: any run, then "/"
        const slash = this.add(CHAR, next, -1, '/');
        const run = this.add(SPLIT, -1, slash);
        const dot = this.add(NOT_EOL, run);
        this.a[run] = dot;
        return this.add(SPLIT, run, next);
      }
      case 'alt': {
        let entry = this.emit(n.alts[n.alts.length - 1]!, next);
        for (let i = n.alts.length - 2; i >= 0; i--) entry = this.add(SPLIT, this.emit(n.alts[i]!, next), entry);
        return entry;
      }
      default:
        throw new Error(`internal glob error: unexpected token ${n.t}`);
    }
  }

  test(input: string): boolean {
    const seen = new Int32Array(this.kind.length).fill(-1);
    const stack: number[] = [];
    const closure = (s0: number, list: number[], gen: number) => {
      stack.push(s0);
      while (stack.length) {
        const s = stack.pop()!;
        if (s < 0 || seen[s] === gen) continue;
        seen[s] = gen;
        if (this.kind[s] === SPLIT) stack.push(this.a[s]!, this.b[s]!);
        else list.push(s);
      }
    };
    let cur: number[] = [];
    closure(this.start, cur, 0);
    for (let i = 0; i < input.length; i++) {
      if (cur.length === 0) return false;
      const c = input[i]!;
      const nxt: number[] = [];
      for (const s of cur) {
        const k = this.kind[s]!;
        if (
          (k === CHAR && this.ch[s] === c) ||
          (k === NOT_SLASH && c !== '/') ||
          (k === NOT_EOL && c !== '\n' && c !== '\r' && c !== '\u2028' && c !== '\u2029')
        ) closure(this.a[s]!, nxt, i + 1);
      }
      cur = nxt;
    }
    return cur.some((s) => this.kind[s] === MATCH);
  }
}

const cache = new Map<string, GlobMatcher>();

/** Compile one glob. Throws on an unbalanced `{`. */
export function compileGlob(pattern: string): GlobMatcher {
  const hit = cache.get(pattern);
  if (hit) return hit;
  const nfa = new Nfa();
  const match = nfa.add(MATCH);
  nfa.start = nfa.emit(parse(tokenize(pattern)), match);
  const m: GlobMatcher = { test: (s) => nfa.test(s) };
  cache.set(pattern, m);
  return m;
}

/** Kept for existing callers: returns a matcher with `.test(path)` (no longer a RegExp). */
export const globToRegExp = compileGlob;

export function compileGlobs(patterns: string[]): (rel: string) => boolean {
  const ms = patterns.map(compileGlob);
  return (rel) => ms.some((m) => m.test(rel));
}
