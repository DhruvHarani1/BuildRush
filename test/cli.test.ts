import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { fixtureFiles, rm, tmpProject } from './helpers.js';
import { parseArgs } from '../src/cli.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/buildrush.js');
const cli = (cwd: string, ...args: string[]) => spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp' } });

test('arg parsing rejects unknown flags and missing values', () => {
  assert.throws(() => parseArgs(['--nope']), /unknown option/);
  assert.throws(() => parseArgs(['--since']), /requires a value/);
  assert.throws(() => parseArgs(['--concurrency', '0']), /positive integer/);
  assert.deepEqual(parseArgs(['run', 'a', '--json', '--', '--weird']).positional, ['run', 'a', '--weird']);
});

test('exit codes: 0 ok, 1 task failure, 2 usage/config, and JSON output is parseable', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    assert.equal(cli(dir, '--version').status, 0);
    assert.equal(cli(dir, 'bogus').status, 2);
    assert.equal(cli(dir, 'run', 'nope').status, 2);
    const ok = cli(dir, 'run', '--json');
    assert.equal(ok.status, 0, ok.stderr);
    const parsed = JSON.parse(ok.stdout);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.tasks.map((t: { task: string }) => t.task).sort(), ['compile', 'lint', 'test']);
    const human = cli(dir, 'run');
    assert.match(human.stdout, /\[cached\]\s+compile/);
    assert.match(human.stdout, /BuildRush succeeded: 0 ran, 3 cached/);
    await fs.writeFile(path.join(dir, 'scripts/lint.js'), 'process.exit(1)');
    const bad = cli(dir, 'run');
    assert.equal(bad.status, 1);
    assert.match(bad.stdout, /\[FAILED\]\s+lint/);
    assert.match(bad.stdout, /BuildRush FAILED/);
    await fs.writeFile(path.join(dir, 'buildrush.json'), '{ "version": 1, ');
    const cfg = cli(dir, 'config', 'validate');
    assert.equal(cfg.status, 2);
    assert.match(cfg.stderr, /not valid JSON/);
  } finally { await rm(dir); }
});

test('init detects tools, refuses to overwrite, and writes a valid config', async () => {
  const dir = await tmpProject({
    'package.json': JSON.stringify({ name: 'demo', devDependencies: { vite: '^5', vitest: '^2', typescript: '^5', eslint: '^9' } }),
    'package-lock.json': '{}', 'tsconfig.json': '{}',
  });
  try {
    const r = cli(dir, 'init');
    assert.equal(r.status, 0, r.stderr);
    const cfg = JSON.parse(await fs.readFile(path.join(dir, 'buildrush.json'), 'utf8'));
    assert.deepEqual(Object.keys(cfg.tasks).sort(), ['build', 'lint', 'test', 'typecheck']);
    assert.deepEqual(cfg.tasks.build.dependsOn, ['typecheck']);
    assert.equal(cli(dir, 'init').status, 2, 'must not overwrite');
    assert.equal(cli(dir, 'config', 'validate').status, 0);
  } finally { await rm(dir); }
});

test('init in an empty project fails honestly instead of inventing tasks', async () => {
  const dir = await tmpProject({ 'package.json': '{"name":"empty"}' });
  try {
    const r = cli(dir, 'init');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /no supported tools/);
    await assert.rejects(fs.access(path.join(dir, 'buildrush.json')));
  } finally { await rm(dir); }
});

test('analyze, explain (file & task), cache stats/verify/clean, doctor all work end to end', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    cli(dir, 'run');
    const a = JSON.parse(cli(dir, 'analyze', '--json').stdout);
    assert.equal(a.tests, 2);
    assert.equal(a.importCycles.length, 0);
    const e = cli(dir, 'explain', 'src/a.js');
    assert.match(e.stdout, /test\/a\.test\.js\s+->\s+src\/b\.js\s+->\s+src\/a\.js/);
    assert.match(e.stdout, /tasks affected : lint, compile, test/);
    const t = cli(dir, 'explain', 'compile');
    assert.match(t.stdout, /last state : succeeded/);
    const s = JSON.parse(cli(dir, 'cache', 'stats', '--json').stdout);
    assert.ok(s.entries >= 3 && s.lifetime.hits >= 0);
    assert.equal(cli(dir, 'cache', 'verify').status, 0);
    assert.equal(cli(dir, 'cache', 'clean').status, 0);
    assert.equal(JSON.parse(cli(dir, 'cache', 'stats', '--json').stdout).entries, 0);
    const d = cli(dir, 'doctor', '--json');
    const checks = JSON.parse(d.stdout) as { name: string; status: string }[];
    assert.ok(checks.find((c) => c.name === 'config')!.status === 'ok');
    assert.ok(checks.find((c) => c.name === 'cache health')!.status === 'ok');
    const g = cli(dir, 'graph', '--dot');
    assert.match(g.stdout, /"src\/b.js" -> "src\/a.js"/);
  } finally { await rm(dir); }
});
