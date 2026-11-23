import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { Project } from '../src/project.js';
import { loadTaskState, runTasks } from '../src/engine.js';
import { validateConfig } from '../src/config.js';
import { beginTscIncremental, incrementalDir, stampOf, supportsTscIncremental, hasSelfManagedIncremental } from '../src/tsc-state.js';
import { rm, tmpProject, writeFiles } from './helpers.js';

const cfg = (tasks: object) => JSON.stringify({ version: 1, project: { name: 'inc' }, tasks });

// A stand-in for tsc: records every invocation, "type checks" by looking for the word ERROR in src/*.ts,
// and keeps a tiny JSON buildinfo at --tsBuildInfoFile so tests can see whether state was reused.
const FAKE_TSC = `
import fs from 'node:fs'; import path from 'node:path';
const argv = process.argv.slice(2);
const i = argv.indexOf('--tsBuildInfoFile');
const info = i >= 0 ? argv[i + 1] : null;
let reused = false;
if (info && fs.existsSync(info)) { try { JSON.parse(fs.readFileSync(info, 'utf8')); reused = true; } catch { /* corrupt */ } }
fs.appendFileSync('.calls', JSON.stringify({ argv, reused }) + '\\n');
const bad = fs.readdirSync('src').filter((f) => fs.readFileSync(path.join('src', f), 'utf8').includes('ERROR'));
if (bad.length) { console.log('src/' + bad[0] + '(1,1): error TS9999: fake failure'); process.exit(2); }
if (info) fs.writeFileSync(info, JSON.stringify({ version: 'fake', at: Date.now() }));
`;

const calls = async (dir: string) =>
  (await fs.readFile(path.join(dir, '.calls'), 'utf8').catch(() => '')).split('\n').filter(Boolean).map((l) => JSON.parse(l) as { argv: string[]; reused: boolean });

const fakeFiles = (version = '5.4.0', tsconfig = '{"compilerOptions":{"noEmit":true}}'): Record<string, string> => ({
  'buildrush.json': cfg({ check: { adapter: 'tsc', command: ['node', 'scripts/fake-tsc.mjs', '--noEmit', '-p', 'tsconfig.json'] } }),
  'package.json': '{"type":"module"}',
  'tsconfig.json': tsconfig,
  'scripts/fake-tsc.mjs': FAKE_TSC,
  'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version }),
  'src/a.ts': 'export const a = 1;\n',
  'src/b.ts': 'export const b = 2;\n',
});

const run = async (dir: string, task = 'check') => {
  const p = await Project.open(dir);
  const r = await runTasks(p, [task]);
  return { p, r: r.tasks[0]! };
};
const stateFiles = (dir: string) => path.join(dir, '.buildrush', 'state', 'incremental', 'check');
const exists = (f: string) => fs.stat(f).then(() => true, () => false);

test('incremental tsc: passes state flags, unchanged rerun is a cache hit, state is not an input or an output', async () => {
  const dir = await tmpProject(fakeFiles());
  try {
    const a = await run(dir);
    assert.equal(a.r.state, 'succeeded');
    let c = await calls(dir);
    assert.equal(c.length, 1);
    assert.ok(c[0]!.argv.includes('--incremental'));
    const info = c[0]!.argv[c[0]!.argv.indexOf('--tsBuildInfoFile') + 1]!;
    assert.ok(info.includes('.buildrush'), 'state lives under .buildrush');
    assert.equal(c[0]!.reused, false);
    assert.ok(await exists(path.join(stateFiles(dir), 'tsc.tsbuildinfo')));

    const b = await run(dir);
    assert.equal(b.r.cache, 'hit');
    assert.equal((await calls(dir)).length, 1, 'tsc was not invoked on an unchanged rerun');

    const st = await loadTaskState(b.p, 'check');
    assert.ok(!Object.keys(st!.components.inputs).some((k) => k.includes('tsbuildinfo')));
    assert.ok(!st!.components.command.some((x) => x.includes('--incremental')), 'flags are not in the fingerprint');
    assert.deepEqual(st!.outputs, []);

    // One-file edit: miss, tsc reuses the state.
    await writeFiles(dir, { 'src/a.ts': 'export const a = 11;\n' });
    const d = await run(dir);
    assert.equal(d.r.state, 'succeeded');
    assert.equal(d.r.cache, 'miss');
    c = await calls(dir);
    assert.equal(c.length, 2);
    assert.equal(c[1]!.reused, true);
    assert.ok(d.r.notes.some((n) => n.includes('reusing previous')));
  } finally { await rm(dir); }
});

test('incremental tsc: a failing run discards state; fixing it passes from a clean full check', async () => {
  const dir = await tmpProject(fakeFiles());
  try {
    await run(dir);
    await writeFiles(dir, { 'src/a.ts': 'export const a: number = ERROR;\n' });
    const bad = await run(dir);
    assert.equal(bad.r.state, 'failed');
    assert.ok(!(await exists(path.join(stateFiles(dir), 'tsc.tsbuildinfo'))));
    assert.ok(!(await exists(path.join(stateFiles(dir), 'meta.json'))));
    assert.deepEqual((await fs.readdir(stateFiles(dir))).filter((f) => f.startsWith('work-')), []);

    await writeFiles(dir, { 'src/a.ts': 'export const a = 2;\n' });
    const ok = await run(dir);
    assert.equal(ok.r.state, 'succeeded');
    const c = await calls(dir);
    assert.equal(c[c.length - 1]!.reused, false);
  } finally { await rm(dir); }
});

test('incremental tsc: corrupt buildinfo is ignored and healed', async () => {
  const dir = await tmpProject(fakeFiles());
  try {
    await run(dir);
    const f = path.join(stateFiles(dir), 'tsc.tsbuildinfo');
    for (const junk of ['{"version": "5.4', '', 'not json at all', '[]']) {
      await fs.writeFile(f, junk);
      await writeFiles(dir, { 'src/a.ts': `export const a = ${Math.random()};\n` });
      const r = await run(dir);
      assert.equal(r.r.state, 'succeeded', JSON.stringify(junk));
      assert.equal((await calls(dir)).pop()!.reused, false, `corrupt state ${JSON.stringify(junk)} must not be reused`);
      JSON.parse(await fs.readFile(f, 'utf8')); // healed: valid JSON again
    }
    // healed: next edit reuses the freshly written state
    await writeFiles(dir, { 'src/a.ts': 'export const a = 99;\n' });
    await run(dir);
    assert.equal((await calls(dir)).pop()!.reused, true);
  } finally { await rm(dir); }
});

test('incremental tsc: tsc version change and tsconfig change discard state', async () => {
  const dir = await tmpProject(fakeFiles());
  try {
    await run(dir);
    await writeFiles(dir, { 'node_modules/typescript/package.json': JSON.stringify({ name: 'typescript', version: '5.5.1' }) });
    const v = await run(dir);
    assert.equal(v.r.state, 'succeeded');
    assert.equal((await calls(dir)).pop()!.reused, false);
    assert.ok(v.r.notes.some((n) => n.includes('discarded')));

    await writeFiles(dir, { 'tsconfig.json': '{"compilerOptions":{"noEmit":true,"strict":true}}' });
    const t = await run(dir);
    assert.equal(t.r.state, 'succeeded');
    assert.equal((await calls(dir)).pop()!.reused, false);

    // sanity: with nothing changed except a source edit, state IS reused again
    await writeFiles(dir, { 'src/a.ts': 'export const a = 5;\n' });
    await run(dir);
    assert.equal((await calls(dir)).pop()!.reused, true);
  } finally { await rm(dir); }
});

test('incremental tsc: only enabled where safe (opt-out, old TypeScript, -b, composite, own incremental flags, emitting)', async () => {
  const flags = async (files: Record<string, string>) => {
    const dir = await tmpProject(files);
    try {
      await run(dir);
      return (await calls(dir))[0]?.argv ?? null;
    } finally { await rm(dir); }
  };
  const base = fakeFiles();
  const withTask = (task: object, version = '5.4.0', tsconfig?: string) => ({ ...fakeFiles(version, tsconfig), 'buildrush.json': cfg({ check: task }) });
  const cmd = (...extra: string[]) => ['node', 'scripts/fake-tsc.mjs', '--noEmit', '-p', 'tsconfig.json', ...extra];

  assert.ok((await flags(base))!.includes('--incremental'));
  assert.ok(!(await flags(withTask({ adapter: 'tsc', incremental: false, command: cmd() })))!.includes('--incremental'));
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: cmd() }, '4.9.5')))!.includes('--incremental'), 'old TypeScript falls back');
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: ['node', 'scripts/fake-tsc.mjs', '-b'] })))!.includes('--incremental'), '-b untouched');
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: cmd('--incremental') })))!.includes('--tsBuildInfoFile'), 'user flags win');
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: cmd() }, '5.4.0', '{"compilerOptions":{"noEmit":true,"composite":true}}')))!.includes('--incremental'));
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: cmd() }, '5.4.0', '{"compilerOptions":{"noEmit":true,"incremental":true}}')))!.includes('--incremental'));
  assert.ok(!(await flags(withTask({ adapter: 'tsc', command: cmd() }, '5.4.0', '{"compilerOptions":{"noEmit":true},"references":[{"path":"./x"}]}')))!.includes('--incremental'));
  assert.ok(!(await flags(withTask({ adapter: 'tsc', outputs: ['dist/**'], command: ['node', 'scripts/fake-tsc.mjs', '-p', 'tsconfig.json'] }, '5.4.0', '{"compilerOptions":{"outDir":"dist"}}')))!.includes('--incremental'), 'emitting builds unchanged');
});

test('config: incremental must be boolean and only valid with the tsc adapter', () => {
  const mk = (task: object) => () => validateConfig({ version: 1, project: { name: 'x' }, tasks: { t: task } });
  assert.doesNotThrow(mk({ adapter: 'tsc', incremental: false }));
  assert.throws(mk({ adapter: 'tsc', incremental: 'no' }), /incremental: must be boolean/);
  assert.throws(mk({ adapter: 'eslint', incremental: false }), /only supported with "adapter": "tsc"/);
  assert.throws(mk({ command: 'tsc', incremental: false }), /only supported with "adapter": "tsc"/);
});

test('tsc-state: version gate, flag detection, non-success finish discards, success commits atomically', async () => {
  assert.ok(!supportsTscIncremental(null) && !supportsTscIncremental('4.9.5') && supportsTscIncremental('5.0.2') && supportsTscIncremental('7.0.0-dev.20260101.1'));
  assert.ok(hasSelfManagedIncremental(['tsc', '-b']) && hasSelfManagedIncremental(['tsc', '--tsBuildInfoFile=x']) && !hasSelfManagedIncremental(['tsc', '--noEmit']));
  const dir = await tmpProject({ 'x': '' });
  try {
    const stamp = { version: '5.4.0', command: ['tsc'], args: [], cwd: '.', executable: 'e', configs: {} };
    assert.notEqual(stampOf(stamp), stampOf({ ...stamp, version: '5.4.1' }));
    assert.notEqual(stampOf(stamp), stampOf({ ...stamp, configs: { 'tsconfig.json': 'd' } }));
    const d = incrementalDir(dir, 'check');
    const r1 = await beginTscIncremental(dir, 'check', stamp);
    await fs.writeFile(r1.args[2]!, '{"a":1}');
    await r1.finish(true);
    assert.ok(await exists(path.join(d, 'tsc.tsbuildinfo')));
    const r2 = await beginTscIncremental(dir, 'check', stamp);
    assert.ok(await exists(r2.args[2]!), 'work copy seeded from committed state');
    await fs.writeFile(r2.args[2]!, '{"half":'); // cancelled mid-write
    await r2.finish(false);
    assert.deepEqual(await fs.readdir(d), [], 'cancelled run leaves no state and no work files');
  } finally { await rm(dir); }
});

// ---- real TypeScript ---------------------------------------------------------------------------

const tsPkgDir = path.dirname(createRequire(import.meta.url).resolve('typescript/package.json'));

async function realProject(): Promise<string> {
  const dir = await tmpProject({
    'buildrush.json': cfg({ typecheck: { adapter: 'tsc', command: ['node', 'node_modules/typescript/bin/tsc', '--noEmit', '-p', 'tsconfig.json'] } }),
    'package.json': '{"type":"module"}',
    'tsconfig.json': JSON.stringify({ compilerOptions: { noEmit: true, strict: true, target: 'es2022', module: 'esnext', moduleResolution: 'bundler', types: [] }, include: ['src'] }),
    'src/a.ts': 'export interface User { name: string }\nexport const u: User = { name: "x" };\n',
    'src/b.ts': 'import { u } from "./a";\nexport const n: string = u.name;\n',
    'src/c.ts': 'export const c: number = 3;\n',
  });
  await fs.mkdir(path.join(dir, 'node_modules'), { recursive: true });
  await fs.symlink(tsPkgDir, path.join(dir, 'node_modules', 'typescript'), 'junction');
  return dir;
}

test('REAL tsc: incremental never turns a type error into success (own edit and cross-file edit), fixing passes', async () => {
  const dir = await realProject();
  const info = path.join(dir, '.buildrush', 'state', 'incremental', 'typecheck', 'tsc.tsbuildinfo');
  try {
    const first = await run(dir, 'typecheck');
    assert.equal(first.r.state, 'succeeded', first.r.log);
    assert.ok(await exists(info), 'real tsc wrote a buildinfo under .buildrush state');

    assert.equal((await run(dir, 'typecheck')).r.cache, 'hit');

    // 1. introduce an error in the edited file itself
    await writeFiles(dir, { 'src/c.ts': 'export const c: number = "oops";\n' });
    const bad1 = await run(dir, 'typecheck');
    assert.equal(bad1.r.state, 'failed');
    assert.ok(bad1.r.diagnostics.some((d) => d.includes('TS2322')), bad1.r.log);
    await writeFiles(dir, { 'src/c.ts': 'export const c: number = 30;\n' });
    const fixed1 = await run(dir, 'typecheck');
    assert.equal(fixed1.r.state, 'succeeded', fixed1.r.log);

    // 2. edit a dependency so a DIFFERENT, untouched file breaks
    await writeFiles(dir, { 'src/a.ts': 'export interface User { name: number }\nexport const u: User = { name: 1 };\n' });
    const bad2 = await run(dir, 'typecheck');
    assert.equal(bad2.r.state, 'failed');
    assert.ok(bad2.r.log.includes('src/b.ts'), bad2.r.log);
    await writeFiles(dir, { 'src/a.ts': 'export interface User { name: string }\nexport const u: User = { name: "y" };\n' });
    assert.equal((await run(dir, 'typecheck')).r.state, 'succeeded');

    // 3. a passing one-file edit reuses the state and still passes
    await writeFiles(dir, { 'src/c.ts': 'export const c: number = 4;\n' });
    const inc = await run(dir, 'typecheck');
    assert.equal(inc.r.state, 'succeeded');
    assert.ok(inc.r.notes.some((n) => n.includes('reusing previous')), inc.r.notes.join('|'));

    // 4. corrupt real buildinfo: ignored/healed, and errors are still reported
    await fs.writeFile(info, '{"version":"' + 'x'.repeat(50));
    await writeFiles(dir, { 'src/c.ts': 'export const c: number = "bad again";\n' });
    const bad3 = await run(dir, 'typecheck');
    assert.equal(bad3.r.state, 'failed');
    await writeFiles(dir, { 'src/c.ts': 'export const c: number = 5;\n' });
    assert.equal((await run(dir, 'typecheck')).r.state, 'succeeded');
  } finally { await rm(dir); }
});
