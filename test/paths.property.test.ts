import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'node:path';
import * as os from 'node:os';
import { resolveInside, safeRelative, UnsafePathError } from '../src/util/paths.js';
import { forAll, Rng } from './prng.js';

const ROOT = path.resolve(os.tmpdir(), 'buildrush-fuzz-root');

const PIECES = [
  '..', '.', '...', '/', '//', '\\', '\\\\', 'a', 'b', 'src', 'C:', 'c:', 'Z:', 'C:\\', '\0', '~', '%2e%2e', '%2F',
  '\u2025', '\u202e', 'é', '\u{1F600}', 'ａ', '\uFF0E\uFF0E', ' ', '\t', '\n', ':', 'CON', 'NUL', '..\\', '../', './', '/..', '\\..',
];

function insideRoot(abs: string): boolean {
  return abs === ROOT || abs.startsWith(ROOT + path.sep);
}

test('paths: random hostile strings never resolve outside the root', () => {
  forAll('paths-fuzz', 100, 5000, (rng) => {
    const s = rng.string(PIECES, 0, 8);
    let abs: string;
    try {
      abs = resolveInside(ROOT, s);
    } catch (e) {
      assert.ok(e instanceof UnsafePathError, `non-UnsafePathError thrown for ${JSON.stringify(s)}: ${String(e)}`);
      return;
    }
    assert.ok(insideRoot(abs), `${JSON.stringify(s)} resolved to ${abs}, outside ${ROOT}`);
    assert.notEqual(abs, ROOT, `${JSON.stringify(s)} must not resolve to the root itself`);
  });
});

test('paths: accepted paths are normalised, relative, forward-slash and never traverse', () => {
  forAll('paths-accepted', 200, 5000, (rng) => {
    const s = rng.string(PIECES, 1, 6);
    let n: string;
    try {
      n = safeRelative(s);
    } catch (e) {
      assert.ok(e instanceof UnsafePathError);
      return;
    }
    assert.ok(!n.includes('\0') && !n.includes('\\'), `accepted ${JSON.stringify(s)} -> ${JSON.stringify(n)}`);
    assert.ok(!n.startsWith('/') && !/^[a-zA-Z]:/.test(n), `accepted absolute ${JSON.stringify(s)} -> ${n}`);
    assert.ok(!n.split('/').includes('..'), `accepted traversal ${JSON.stringify(s)} -> ${n}`);
    assert.ok(!n.split('/').some((seg) => /^[a-zA-Z]:/.test(seg)), `accepted drive-like segment ${JSON.stringify(s)} -> ${n}`);
    assert.equal(path.posix.normalize(n), n, 'result is already normalised');
    assert.ok(n.length > 0 && n !== '.');
  });
});

test('paths: well-formed relative paths are accepted and stay inside', () => {
  const seg = ['a', 'b', 'src', 'x.ts', '.hidden', 'é', 'dir-1', 'file name', '\u{1F600}'];
  forAll('paths-valid', 300, 500, (rng) => {
    const parts: string[] = [];
    for (let i = rng.int(1, 6); i > 0; i--) parts.push(rng.pick(seg));
    const rel = parts.join('/');
    assert.equal(safeRelative(rel), rel);
    const abs = resolveInside(ROOT, rel);
    assert.equal(abs, path.resolve(ROOT, ...parts));
    assert.ok(insideRoot(abs));
  });
});

test('paths: ".." embedded anywhere in an otherwise valid path is contained', () => {
  forAll('paths-dotdot', 400, 2000, (rng) => {
    // Random walk of segments and ".." that may or may not climb above the root.
    const parts: string[] = [];
    for (let i = rng.int(1, 8); i > 0; i--) parts.push(rng.pick(['..', '..', 'a', 'b', '.', 'c']));
    const rel = parts.join('/');
    // Reference: net depth must stay >= 0 at every step AND end >= 1 for it to be acceptable.
    let depth = 0;
    let escapes = false;
    for (const p of parts) {
      if (p === '..') depth--;
      else if (p !== '.') depth++;
      if (depth < 0) escapes = true;
    }
    if (!escapes && depth >= 1) {
      assert.ok(insideRoot(resolveInside(ROOT, rel)), rel);
    } else if (escapes && depth < 0) {
      assert.throws(() => resolveInside(ROOT, rel), UnsafePathError, rel);
    }
    // whatever happened, it must never land outside:
    try {
      assert.ok(insideRoot(resolveInside(ROOT, rel)), rel);
    } catch (e) {
      assert.ok(e instanceof UnsafePathError);
    }
  });
});

test('paths: known-bad classes are always rejected', () => {
  const bad = (s: string) => assert.throws(() => safeRelative(s), UnsafePathError, JSON.stringify(s));
  forAll('paths-known-bad', 500, 300, (rng) => {
    const tail = rng.string(['a', 'b', '/', '.'], 0, 5);
    bad('/' + tail + 'a');
    bad('//' + tail + 'a');
    bad('\\' + tail);
    bad('a\\' + tail);
    bad('C:' + tail);
    bad(rng.pick(['c', 'Z', 'a']) + ':\\' + tail);
    bad('a\0' + tail);
    bad('\0');
    bad('../' + tail + 'a');
    bad('a/../../' + tail + 'a');
    bad('..');
    bad('.');
    bad('');
  });
  // Regressions found by fuzzing: these used to be accepted.
  bad('./');
  bad('a/../');
  bad('./c:x');
  bad('a/C:..');
  bad('a/b/d:');
  // A relative interior ".." that stays inside is fine
  assert.equal(safeRelative('a/../b'), 'b');
  assert.throws(() => safeRelative(undefined as unknown as string), UnsafePathError);
  assert.throws(() => safeRelative(42 as unknown as string), UnsafePathError);
});

test('paths: a root that is a prefix of a sibling directory is not confused for it', () => {
  // "/tmp/root" vs "/tmp/root-evil": resolveInside must use a separator-aware prefix check.
  forAll('paths-sibling', 600, 300, (rng) => {
    const sibling = path.basename(ROOT) + rng.string(['-', 'x', 'evil'], 1, 3);
    const rel = '../' + sibling + '/f';
    assert.throws(() => resolveInside(ROOT, rel), UnsafePathError, rel);
  });
});
