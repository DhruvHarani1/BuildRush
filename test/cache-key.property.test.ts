import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canonical, sha256 } from '../src/util/hash.js';
import type { Components } from '../src/cache.js';
import { forAll, Rng } from './prng.js';

/** Mirrors engine.ts: the cache key is sha256(canonical(components)). */
const keyOf = (c: unknown) => sha256(canonical(c));

const WORDS = ['a', 'b', 'src', 'x.ts', 'NODE_ENV', 'PATH', '--flag', 'é', 'a b', '', '"q"', '\\', '{}', ','];
const digest = (rng: Rng) => sha256(rng.string(WORDS, 1, 4) + rng.int(0, 1e9));

function uniq(rng: Rng, n: number): string[] {
  const s = new Set<string>();
  while (s.size < n) s.add(rng.string(WORDS, 1, 3) + rng.int(0, 99));
  return [...s];
}

function genComponents(rng: Rng): Components {
  const rec = <T>(n: number, v: () => T) => Object.fromEntries(uniq(rng, n).map((k) => [k, v()]));
  return {
    schema: 1,
    task: 'task' + rng.int(0, 9),
    command: uniq(rng, rng.int(1, 4)),
    cwd: rng.pick(['.', 'pkg/a', 'pkg/b']),
    env: rec(rng.int(0, 4), () => (rng.bool(0.2) ? null : rng.string(WORDS, 0, 3))),
    toolchain: rec(rng.int(0, 3), () => (rng.bool(0.2) ? null : 'v' + rng.int(1, 30))),
    inputs: rec(rng.int(0, 6), () => digest(rng)),
    deps: rec(rng.int(0, 3), () => digest(rng)),
    outputs: uniq(rng, rng.int(0, 3)),
    args: uniq(rng, rng.int(0, 3)),
  };
}

/** Deep-copy with every object's key insertion order randomly permuted (arrays keep order). */
function permuteKeys(rng: Rng, v: unknown): unknown {
  if (Array.isArray(v)) return v.map((x) => permuteKeys(rng, x));
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of rng.shuffle(Object.keys(v))) out[k] = permuteKeys(rng, (v as Record<string, unknown>)[k]);
    return out;
  }
  return v;
}

const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v)) as T;

test('cache key: stable under object key-order permutation', () => {
  forAll('key-permute', 100, 500, (rng) => {
    const c = genComponents(rng);
    const k = keyOf(c);
    for (let i = 0; i < 5; i++) {
      const p = permuteKeys(rng, c);
      assert.equal(keyOf(p), k);
      assert.equal(canonical(p), canonical(c));
    }
    // and stable across a serialise/parse round trip (what the on-disk record does)
    assert.equal(keyOf(JSON.parse(JSON.stringify(c))), k);
  });
});

test('cache key: any single component change changes the key', () => {
  forAll('key-mutate', 200, 500, (rng) => {
    const base = genComponents(rng);
    const k = keyOf(base);
    const changed: { what: string; c: Components }[] = [];
    const mut = (what: string, f: (c: Components) => void) => {
      const c = clone(base);
      f(c);
      changed.push({ what, c });
    };

    mut('task', (c) => { c.task += 'x'; });
    mut('cwd', (c) => { c.cwd += '/x'; });
    mut('command append', (c) => { c.command.push('extra'); });
    mut('command element', (c) => { c.command[0] += 'x'; });
    mut('command split', (c) => { c.command = [c.command.join(' ')]; if (c.command.length === base.command.length) c.command.push(''); });
    mut('output added', (c) => { c.outputs.push('dist/**'); });
    mut('args added', (c) => { c.args.push('--only'); });
    mut('env added', (c) => { c.env['NEW_VAR'] = 'v'; });
    mut('toolchain added', (c) => { c.toolchain['tool'] = '1'; });
    mut('input added', (c) => { c.inputs['new/file.ts'] = digest(rng); });
    mut('dep added', (c) => { c.deps['dep:task'] = digest(rng); });
    for (const group of ['env', 'toolchain', 'inputs', 'deps'] as const) {
      const keys = Object.keys(base[group]);
      if (keys.length === 0) continue;
      const key = rng.pick(keys);
      mut(`${group} value`, (c) => {
        const cur = (c[group] as Record<string, string | null>)[key];
        (c[group] as Record<string, string | null>)[key] = cur === null ? 'now-set' : cur + '!';
      });
      mut(`${group} removed`, (c) => { delete (c[group] as Record<string, unknown>)[key]; });
      mut(`${group} renamed`, (c) => {
        const g = c[group] as Record<string, unknown>;
        g[key + '_renamed'] = g[key];
        delete g[key];
      });
    }
    // null vs empty string vs absent must all be distinguishable for env
    const envKeys = Object.keys(base.env);
    if (envKeys.length > 0) {
      const key = rng.pick(envKeys);
      const cur = base.env[key];
      mut('env null<->empty', (c) => { c.env[key] = cur === null ? '' : null; });
    }
    if (base.command.length >= 2 && new Set(base.command).size >= 2) {
      mut('command reorder', (c) => { c.command = c.command.slice().reverse(); });
    }
    if (base.outputs.length >= 2) mut('outputs reorder', (c) => { c.outputs = c.outputs.slice().reverse(); });

    for (const { what, c } of changed) {
      assert.notEqual(keyOf(c), k, `changing "${what}" did not change the key\nbase=${canonical(base)}\nmut =${canonical(c)}`);
    }
  });
});

test('cache key: distinct random components collide only if canonically identical', () => {
  const seen = new Map<string, string>();
  forAll('key-collision', 300, 1500, (rng) => {
    const c = genComponents(rng);
    const canon = canonical(c);
    const k = sha256(canon);
    const prev = seen.get(k);
    if (prev !== undefined) assert.equal(prev, canon, 'two different canonical forms produced one key');
    seen.set(k, canon);
  });
});

test('canonical: nested objects are sorted recursively and arrays keep order', () => {
  forAll('canonical-nested', 400, 300, (rng) => {
    const mk = (d: number): unknown => {
      if (d === 0 || rng.bool(0.3)) return rng.pick([1, 'x', null, true, 0, -1.5, 'é']);
      if (rng.bool(0.4)) return Array.from({ length: rng.int(0, 3) }, () => mk(d - 1));
      return Object.fromEntries(uniq(rng, rng.int(0, 4)).map((k) => [k, mk(d - 1)]));
    };
    const v = mk(4);
    assert.equal(canonical(permuteKeys(rng, v)), canonical(v));
    assert.deepEqual(JSON.parse(canonical(v)), JSON.parse(JSON.stringify(v)));
  });
  assert.notEqual(canonical([1, 2]), canonical([2, 1]));
});

test('cache key: hostile key names ("__proto__", "constructor", "toString") still influence the key', () => {
  // Inputs are keyed by project file path; a file literally named __proto__ must not vanish from the key.
  for (const name of ['__proto__', 'constructor', 'toString', 'hasOwnProperty', 'prototype']) {
    const mk = (digestValue: string) => JSON.parse(`{"schema":1,"inputs":{${JSON.stringify(name)}:${JSON.stringify(digestValue)}}}`) as unknown;
    const a = keyOf(mk('a'.repeat(64)));
    const b = keyOf(mk('b'.repeat(64)));
    assert.notEqual(a, b, `a change to input file "${name}" did not change the cache key`);
    assert.notEqual(a, keyOf({ schema: 1, inputs: {} }), `input file "${name}" is missing from the key`);
  }
});
