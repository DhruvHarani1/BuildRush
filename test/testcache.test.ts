import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../src/project.js';
import { runTasks, RunReport } from '../src/engine.js';
import { rm, tmpProject, writeFiles } from './helpers.js';

const RUNNER = [
  "import path from 'node:path'; import { pathToFileURL } from 'node:url';",
  "import fs from 'node:fs';",
  'const given = process.argv.slice(2);',
  "const files = given.length ? given : fs.readdirSync('test').filter((f) => f.endsWith('.test.js')).sort().map((f) => 'test/' + f);",
  'for (const f of files) {',
  "  console.log('RUN ' + f);",
  "  try { await import(pathToFileURL(path.resolve(f)).href); console.log('PASS ' + f); }",
  "  catch (e) { console.log('FAIL ' + f + ' ' + e.message); process.exitCode = 1; }",
  '}',
].join('\n');

function files(task: Record<string, unknown> = {}): Record<string, string> {
  return {
    'buildrush.json': JSON.stringify({
      version: 1,
      project: { name: 'tc' },
      concurrency: 2,
      tasks: {
        test: {
          command: 'node scripts/run-tests.js',
          kind: 'test',
          testCache: true,
          inputs: ['src/**', 'test/**', 'scripts/**', 'package.json'],
          ...task,
        },
      },
    }),
    'package.json': '{"type":"module","name":"tc"}',
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
    'src/c.js': 'export const c = 3;\n',
    'scripts/run-tests.js': RUNNER,
    'test/a.test.js': "import { b } from '../src/b.js';\nif (b !== 2) throw new Error('b wrong');\n",
    'test/c.test.js': "import { c } from '../src/c.js';\nif (c !== 3) throw new Error('c wrong');\n",
  };
}

async function run(dir: string, opts: Parameters<typeof runTasks>[2] = {}): Promise<RunReport> {
  const p = await Project.open(dir);
  return runTasks(p, ['test'], opts);
}
const ranFiles = (r: RunReport) => [...r.tasks[0]!.log.matchAll(/^RUN (\S+)/gm)].map((m) => m[1]!).sort();
const skipped = (r: RunReport) => (r.tasks[0]!.testCache?.skipped ?? []).map((s) => s.test).sort();

test('one-file edit re-runs only tests whose import closure changed, and reports skip reasons', async () => {
  const dir = await tmpProject(files());
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok, r1.tasks[0]!.log);
    assert.deepEqual(ranFiles(r1), ['test/a.test.js', 'test/c.test.js']);
    assert.equal(r1.tasks[0]!.testCache!.recorded, 2);

    // direct edit of a leaf used by only one test
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r2 = await run(dir);
    assert.ok(r2.ok);
    assert.deepEqual(ranFiles(r2), ['test/c.test.js']);
    assert.deepEqual(skipped(r2), ['test/a.test.js']);
    assert.match(r2.tasks[0]!.testCache!.skipped[0]!.reason, /unchanged since passing run/);
    assert.match(r2.tasks[0]!.notes.join('\n'), /skipped 1 of 2/);

    // transitive edit: a.test imports b which imports a
    await writeFiles(dir, { 'src/a.js': 'export const a = 1; // edit\n' });
    const r3 = await run(dir);
    assert.deepEqual(ranFiles(r3), ['test/a.test.js']);
    assert.deepEqual(skipped(r3), ['test/c.test.js']);

    // nothing changed: whole task is served from the cache, nothing executes
    const r4 = await run(dir);
    assert.equal(r4.tasks[0]!.state, 'cached');
    assert.deepEqual(ranFiles(r4), []);
  } finally { await rm(dir); }
});

test('reverting to a previously passing state skips the test again', async () => {
  const dir = await tmpProject(files());
  try {
    await run(dir);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    await run(dir);
    await writeFiles(dir, { 'src/a.js': 'export const a = 1; // edit\n' });
    await run(dir);
    await writeFiles(dir, { 'src/a.js': 'export const a = 1;\n', 'src/c.js': 'export const c = 3;\n' });
    const r = await run(dir);
    assert.deepEqual(skipped(r), ['test/a.test.js', 'test/c.test.js']);
    assert.equal(r.tasks[0]!.state, 'cached');
  } finally { await rm(dir); }
});

test('a failed run never records a pass', async () => {
  const dir = await tmpProject(files());
  try {
    await run(dir);
    await writeFiles(dir, { 'src/c.js': 'export const c = 4;\n' }); // c.test now fails
    const r2 = await run(dir);
    assert.equal(r2.ok, false);
    assert.equal(r2.tasks[0]!.testCache!.recorded, 0);
    assert.deepEqual(skipped(r2), ['test/a.test.js']);
    const r3 = await run(dir); // same failing state: must run (and fail) again, not be skipped
    assert.equal(r3.ok, false);
    assert.deepEqual(ranFiles(r3), ['test/c.test.js']);
    assert.deepEqual(skipped(r3), ['test/a.test.js']);
  } finally { await rm(dir); }
});

test('a failure in one file prevents recording passes of the other files in that run', async () => {
  const dir = await tmpProject(files());
  try {
    await writeFiles(dir, { 'src/c.js': 'export const c = 4;\n' });
    const r1 = await run(dir);
    assert.equal(r1.ok, false);
    assert.equal(r1.tasks[0]!.testCache!.recorded, 0);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3;\n' });
    const r2 = await run(dir);
    assert.ok(r2.ok);
    assert.deepEqual(ranFiles(r2), ['test/a.test.js', 'test/c.test.js']);
  } finally { await rm(dir); }
});

test('tests with uncertain imports always run', async () => {
  const dir = await tmpProject({
    ...files(),
    'test/dyn.test.js': "const n = '../src/a.js';\nawait import(n);\n",
  });
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok, r1.tasks[0]!.log);
    assert.equal(r1.tasks[0]!.testCache!.recorded, 2);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r2 = await run(dir);
    assert.deepEqual(ranFiles(r2), ['test/c.test.js', 'test/dyn.test.js']);
    assert.deepEqual(skipped(r2), ['test/a.test.js']);
    const why = r2.tasks[0]!.testCache!.ran.find((x) => x.test === 'test/dyn.test.js')!.reason;
    assert.match(why, /always runs: .*uncertain imports/);
  } finally { await rm(dir); }
});

test('a test whose transitive import is uncertain always runs', async () => {
  const dir = await tmpProject({
    ...files(),
    'src/loader.js': "export const load = (n) => import(n);\n",
    'test/deep.test.js': "import { load } from '../src/loader.js';\nif (typeof load !== 'function') throw new Error('x');\n",
  });
  try {
    await run(dir);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r2 = await run(dir);
    assert.ok(r2.tasks[0]!.testCache!.ran.some((x) => x.test === 'test/deep.test.js' && /always runs/.test(x.reason)));
  } finally { await rm(dir); }
});

test('global config or lockfile changes invalidate every test', async () => {
  const dir = await tmpProject({ ...files(), 'package-lock.json': '{"lockfileVersion":3}' });
  try {
    await run(dir);
    await writeFiles(dir, { 'package-lock.json': '{"lockfileVersion":3,"x":1}' });
    const r2 = await run(dir);
    assert.deepEqual(ranFiles(r2), ['test/a.test.js', 'test/c.test.js']);
    assert.deepEqual(skipped(r2), []);
    await writeFiles(dir, { 'package.json': '{"type":"module","name":"tc","version":"2"}' });
    const r3 = await run(dir);
    assert.deepEqual(ranFiles(r3), ['test/a.test.js', 'test/c.test.js']);
    await writeFiles(dir, { 'tsconfig.json': '{}' });
    await run(dir);
    await writeFiles(dir, { 'tsconfig.json': '{"compilerOptions":{}}' });
    const r5 = await run(dir);
    assert.deepEqual(skipped(r5), []);
  } finally { await rm(dir); }
});

test('declared env participates in the key; secret values are never stored', async () => {
  const dir = await tmpProject(files({ env: ['TC_MODE', 'TC_API_TOKEN'] }));
  const saved = { m: process.env.TC_MODE, t: process.env.TC_API_TOKEN };
  try {
    process.env.TC_MODE = 'one';
    process.env.TC_API_TOKEN = 'super-secret-value-123';
    await run(dir);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r2 = await run(dir);
    assert.deepEqual(skipped(r2), ['test/a.test.js']);

    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit2\n' });
    process.env.TC_MODE = 'two';
    const r3 = await run(dir);
    assert.deepEqual(skipped(r3), []);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit3\n' });
    process.env.TC_API_TOKEN = 'another-secret-value-456';
    const r4 = await run(dir);
    assert.deepEqual(skipped(r4), []);

    const store = await fs.readFile(path.join(dir, '.buildrush', 'state', 'testcache', 'test.json'), 'utf8');
    for (const secret of ['super-secret-value-123', 'another-secret-value-456']) {
      assert.ok(!store.includes(secret), `store leaks ${secret}`);
    }
  } finally {
    for (const [k, v] of [['TC_MODE', saved.m], ['TC_API_TOKEN', saved.t]] as const) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
    await rm(dir);
  }
});

test('inputs that change during the run are not recorded', async () => {
  const dir = await tmpProject({
    ...files(),
    'src/m.js': 'export const m = 1;\n',
    'test/mut.test.js':
      "import fs from 'node:fs'; import { m } from '../src/m.js';\n" +
      "if (m !== 1) throw new Error('m');\nfs.appendFileSync('src/m.js', '// mutated mid-run\\n');\n",
  });
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok, r1.tasks[0]!.log);
    assert.equal(r1.tasks[0]!.testCache!.recorded, 2); // a.test and c.test only
    assert.match(r1.tasks[0]!.notes.join('\n'), /changed during execution.*test\/mut\.test\.js/);
    const r2 = await run(dir);
    assert.ok(!skipped(r2).includes('test/mut.test.js'));
  } finally { await rm(dir); }
});

test('cancelled runs never record', async () => {
  const dir = await tmpProject({
    ...files(),
    'test/slow.test.js': 'await new Promise((r) => setTimeout(r, 30000));\n',
  });
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 1500);
    const r = await run(dir, { signal: ac.signal });
    assert.equal(r.cancelled, true);
    const exists = await fs.stat(path.join(dir, '.buildrush', 'state', 'testcache', 'test.json')).then(() => true, () => false);
    assert.equal(exists, false);
  } finally { await rm(dir); }
});

test('opt-in only: default off, --no-cache and cache:false disable it', async () => {
  const off = await tmpProject(files({ testCache: false }));
  try {
    await run(off);
    await writeFiles(off, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r = await run(off);
    assert.equal(r.tasks[0]!.testCache, null);
    assert.deepEqual(ranFiles(r), ['test/a.test.js', 'test/c.test.js']);
  } finally { await rm(off); }

  const dir = await tmpProject(files());
  try {
    await run(dir);
    await writeFiles(dir, { 'src/c.js': 'export const c = 3; // edit\n' });
    const r = await run(dir, { noCache: true });
    assert.equal(r.tasks[0]!.testCache, null);
    assert.deepEqual(ranFiles(r), ['test/a.test.js', 'test/c.test.js']);
  } finally { await rm(dir); }
});

test('config validation: testCache must be boolean and only for test tasks', async () => {
  const bad = await tmpProject(files({ kind: 'build' }));
  try {
    await assert.rejects(() => Project.open(bad), /testCache: only valid for tasks of kind "test"/);
  } finally { await rm(bad); }
  const bad2 = await tmpProject(files({ testCache: 'yes' }));
  try {
    await assert.rejects(() => Project.open(bad2), /testCache: must be boolean/);
  } finally { await rm(bad2); }
});

test('vitest adapter: customised config disables testCache; plain config keeps it', async () => {
  const mk = (cfg: string) => ({
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'v' }, tasks: { test: { adapter: 'vitest', testCache: true } } }),
    'package.json': '{"type":"module"}',
    'vitest.config.js': cfg,
  });
  const risky = await tmpProject(mk("export default { test: { setupFiles: ['./setup.js'] } };\n"));
  const plain = await tmpProject(mk('export default { test: { globals: true } };\n'));
  try {
    const p1 = await Project.open(risky);
    assert.equal(p1.config.tasks.test!.testCache, false);
    assert.match(p1.config.tasks.test!.notes.join('\n'), /testCache disabled/);
    const p2 = await Project.open(plain);
    assert.equal(p2.config.tasks.test!.testCache, true);
  } finally { await rm(risky); await rm(plain); }
});

test('--affected combines with testCache', async () => {
  const dir = await tmpProject(files());
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok);
    const r2 = await run(dir, { affected: { since: 'HEAD' } }); // not a git repo: runs "all", testCache still applies
    assert.equal(r2.tasks[0]!.state, 'cached');
  } finally { await rm(dir); }
});
