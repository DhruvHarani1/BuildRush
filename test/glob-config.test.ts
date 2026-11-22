import { test } from 'node:test';
import assert from 'node:assert/strict';
import { globToRegExp } from '../src/util/glob.js';
import { splitCommand, validateConfig, ConfigError } from '../src/config.js';
import { safeRelative, UnsafePathError } from '../src/util/paths.js';

test('glob semantics', () => {
  const m = (p: string, s: string) => globToRegExp(p).test(s);
  assert.ok(m('src/**', 'src/a/b.ts'));
  assert.ok(!m('src/**', 'other/a.ts'));
  assert.ok(m('**/*.test.ts', 'a/b/c.test.ts'));
  assert.ok(m('**/*.test.ts', 'c.test.ts'));
  assert.ok(m('*.json', 'a.json') && !m('*.json', 'x/a.json'));
  assert.ok(m('vite.config.*', 'vite.config.ts'));
  assert.ok(m('src/**/*.{ts,tsx}', 'src/x/y.tsx') && !m('src/**/*.{ts,tsx}', 'src/x/y.js'));
  assert.ok(m('dist/', 'dist/a/b'));
  assert.ok(!m('a.b', 'aXb'), 'dot is literal');
  assert.throws(() => globToRegExp('{a,b'));
});

test('command tokenizer: no shell, quotes group, metacharacters rejected', () => {
  assert.deepEqual(splitCommand('vite build --mode "my mode"'), ['vite', 'build', '--mode', 'my mode']);
  assert.deepEqual(splitCommand("node -e 'a;b'"), ['node', '-e', 'a;b']);
  for (const bad of ['a && b', 'a | b', 'a; b', 'echo $HOME', 'a > out', 'a `b`', 'rm *']) {
    assert.throws(() => splitCommand(bad), /metacharacter/, bad);
  }
  assert.throws(() => splitCommand('a "b'), /unterminated/);
});

test('config validation reports every problem with its path', () => {
  assert.throws(
    () => validateConfig({ version: 2, project: {}, tasks: { a: { command: 'x', bogus: 1, dependsOn: ['nope'] }, b: { command: 'y' } }, extra: 1 }),
    (e: unknown) => {
      assert.ok(e instanceof ConfigError);
      const m = (e as ConfigError).issues.join('\n');
      for (const needle of ['version: must be 1', 'project.name', 'tasks.a.bogus: unknown key', 'unknown task "nope"', 'extra: unknown key']) assert.match(m, new RegExp(needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')));
      return true;
    },
  );
});

test('config rejects task cycles and unsafe paths', () => {
  const t = (o: object) => ({ version: 1, project: { name: 'x' }, tasks: o });
  assert.throws(() => validateConfig(t({ a: { command: 'x', dependsOn: ['b'] }, b: { command: 'x', dependsOn: ['a'] } })), /cycle/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', cwd: '../out' } })), /escapes/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', inputs: ['../secret'] } })), /bad glob/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', env: ['A-B'] } })), /invalid env var/);
});

test('safeRelative blocks traversal and absolute paths', () => {
  for (const bad of ['../x', 'a/../../x', '/etc/passwd', 'C:/x', 'a\\b', '', '.', 'a\0b']) assert.throws(() => safeRelative(bad), UnsafePathError, bad);
  assert.equal(safeRelative('a/./b//c'), 'a/b/c');
});
