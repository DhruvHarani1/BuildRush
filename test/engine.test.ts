import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Project } from '../src/project.js';
import { runTasks, RunReport } from '../src/engine.js';
import { fixtureFiles, git, rm, tmpProject, writeFiles } from './helpers.js';

async function run(dir: string, names: string[] = ['default'], opts: Parameters<typeof runTasks>[2] = {}): Promise<RunReport> {
  const p = await Project.open(dir);
  return runTasks(p, names, opts);
}
const states = (r: RunReport) => Object.fromEntries(r.tasks.map((t) => [t.task, t.state]));
const task = (r: RunReport, n: string) => r.tasks.find((t) => t.task === n)!;

test('cold run executes everything; unchanged re-run reuses everything', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok, JSON.stringify(r1.tasks.map((t) => [t.task, t.state, t.notes, t.log])));
    assert.deepEqual(states(r1), { lint: 'succeeded', compile: 'succeeded', test: 'succeeded' });
    assert.match(task(r1, 'compile').reasons[0]!, /no previous successful run/);
    const r2 = await run(dir);
    assert.deepEqual(states(r2), { lint: 'cached', compile: 'cached', test: 'cached' });
    assert.equal(task(r2, 'compile').cache, 'hit');
  } finally { await rm(dir); }
});

test('changing one source file reruns exactly the tasks whose inputs contain it, and says why', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    await run(dir);
    await fs.writeFile(path.join(dir, 'src/c.js'), 'export const c = 3; // edited\n');
    const r = await run(dir);
    assert.deepEqual(states(r), { lint: 'succeeded', compile: 'succeeded', test: 'succeeded' });
    assert.ok(task(r, 'lint').reasons.includes('input changed: src/c.js'), task(r, 'lint').reasons.join('|'));
    assert.ok(task(r, 'test').reasons.some((x) => /dependency task "compile"/.test(x) || /input changed/.test(x)));
    // A file no task reads must not invalidate anything.
    await fs.writeFile(path.join(dir, 'README.md'), 'docs');
    const r2 = await run(dir);
    assert.deepEqual(states(r2), { lint: 'cached', compile: 'cached', test: 'cached' });
    // Touching mtime without changing content must not invalidate.
    const now = new Date();
    await fs.utimes(path.join(dir, 'src/a.js'), now, now);
    assert.deepEqual(states(await run(dir)), { lint: 'cached', compile: 'cached', test: 'cached' });
  } finally { await rm(dir); }
});

test('deleted outputs are restored byte-for-byte from the cache', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    await run(dir);
    const want = await fs.readFile(path.join(dir, 'dist/bundle.txt'), 'utf8');
    await fs.rm(path.join(dir, 'dist'), { recursive: true });
    const r = await run(dir);
    assert.equal(task(r, 'compile').state, 'cached');
    assert.equal(await fs.readFile(path.join(dir, 'dist/bundle.txt'), 'utf8'), want);
    assert.ok(task(r, 'compile').restoredBytes > 0);
  } finally { await rm(dir); }
});

test('config, env and toolchain changes invalidate; the explanation names the cause', async () => {
  const files = fixtureFiles();
  const cfg = JSON.parse(files['buildrush.json']!);
  cfg.tasks.compile.env = ['MY_FLAG'];
  files['buildrush.json'] = JSON.stringify(cfg);
  const dir = await tmpProject(files);
  const saved = process.env.MY_FLAG;
  try {
    delete process.env.MY_FLAG;
    await run(dir, ['compile']);
    assert.equal(task(await run(dir, ['compile']), 'compile').state, 'cached');
    process.env.MY_FLAG = 'on';
    const r = await run(dir, ['compile']);
    assert.equal(task(r, 'compile').state, 'succeeded');
    assert.ok(task(r, 'compile').reasons.includes('environment variable MY_FLAG changed'));
    assert.equal(task(await run(dir, ['compile']), 'compile').state, 'cached');
    // command change
    cfg.tasks.compile.command = 'node scripts/compile.js --extra';
    await fs.writeFile(path.join(dir, 'buildrush.json'), JSON.stringify(cfg));
    const r3 = await run(dir, ['compile']);
    assert.equal(task(r3, 'compile').state, 'succeeded');
    assert.ok(task(r3, 'compile').reasons.includes('command changed'));
  } finally { if (saved === undefined) delete process.env.MY_FLAG; else process.env.MY_FLAG = saved; await rm(dir); }
});

test('secret-looking env values never reach cache metadata, logs, or children by default', async () => {
  const files = fixtureFiles();
  const cfg = JSON.parse(files['buildrush.json']!);
  cfg.tasks.lint.env = ['API_TOKEN'];
  cfg.tasks.lint.command = 'node scripts/leak.js';
  cfg.tasks.lint.inputs = ['scripts/leak.js'];
  files['buildrush.json'] = JSON.stringify(cfg);
  files['scripts/leak.js'] = "console.log('token=' + process.env.API_TOKEN, 'other=' + process.env.UNDECLARED, 'ci=' + process.env.BUILDRUSH_INTERNAL);\n";
  const dir = await tmpProject(files);
  const SECRET = 'sup3r-s3cret-value-123';
  const saved = { ...process.env };
  try {
    process.env.API_TOKEN = SECRET;
    process.env.UNDECLARED = 'leaked';
    process.env.BUILDRUSH_INTERNAL = 'internal';
    const r = await run(dir, ['lint']);
    assert.equal(task(r, 'lint').state, 'succeeded');
    assert.ok(!task(r, 'lint').log.includes(SECRET), 'secret redacted from log');
    assert.match(task(r, 'lint').log, /token=\*\*\*/);
    assert.match(task(r, 'lint').log, /other=undefined/, 'undeclared env is not inherited');
    assert.match(task(r, 'lint').log, /ci=undefined/, 'BUILDRUSH_* never passed');
    const cacheDir = path.join(dir, '.buildrush');
    const grep = async (d: string): Promise<boolean> => {
      for (const e of await fs.readdir(d, { withFileTypes: true })) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) { if (await grep(p)) return true; } else if ((await fs.readFile(p, 'utf8').catch(() => '')).includes(SECRET)) return true;
      }
      return false;
    };
    assert.equal(await grep(cacheDir), false, 'secret must not appear anywhere under .buildrush');
    // value changes still invalidate (keyed digest)
    process.env.API_TOKEN = SECRET + 'x';
    assert.equal(task(await run(dir, ['lint']), 'lint').state, 'succeeded');
  } finally { for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k]; Object.assign(process.env, saved); await rm(dir); }
});

test('failed tasks are never cached; dependents are skipped and reported', async () => {
  const files = fixtureFiles();
  files['scripts/compile.js'] = "console.error('boom'); process.exit(2);\n";
  const dir = await tmpProject(files);
  try {
    const r = await run(dir);
    assert.equal(r.ok, false);
    assert.deepEqual(states(r), { lint: 'succeeded', compile: 'failed', test: 'skipped' });
    assert.equal(task(r, 'compile').exitCode, 2);
    assert.match(task(r, 'compile').log, /boom/);
    const r2 = await run(dir);
    assert.equal(task(r2, 'compile').state, 'failed', 'a failure must not be served from cache');
    assert.equal(task(r2, 'lint').state, 'cached');
  } finally { await rm(dir); }
});

test('inputs modified while a task runs: result is NOT cached', async () => {
  const files = fixtureFiles();
  files['scripts/compile.js'] = [
    "import fs from 'node:fs';",
    "fs.appendFileSync('src/c.js', '// touched during build\\n');",
    "fs.mkdirSync('dist', { recursive: true }); fs.writeFileSync('dist/bundle.txt', 'x');",
  ].join('\n');
  const dir = await tmpProject(files);
  try {
    const r = await run(dir, ['compile']);
    assert.equal(task(r, 'compile').state, 'succeeded');
    assert.equal(task(r, 'compile').cache, 'uncacheable');
    assert.ok(task(r, 'compile').notes.some((n) => /inputs changed during execution/.test(n)), task(r, 'compile').notes.join('|'));
    const stats = await Project.open(dir).then((p) => p.cache.stats());
    assert.equal(stats.entries, 0);
  } finally { await rm(dir); }
});

test('declared outputs that are missing, or symlinks, make the result uncacheable (never silently reused)', { skip: process.platform === 'win32' }, async () => {
  const files = fixtureFiles();
  files['scripts/compile.js'] = "import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('real.txt','x'); fs.rmSync('dist/link.txt',{force:true}); fs.symlinkSync('../real.txt','dist/link.txt');\n";
  const dir = await tmpProject(files);
  try {
    const r = await run(dir, ['compile']);
    assert.equal(task(r, 'compile').cache, 'uncacheable');
    assert.ok(task(r, 'compile').notes.some((n) => /symlink/.test(n)));
    assert.equal(task(await run(dir, ['compile']), 'compile').state, 'succeeded', 'reruns every time');
  } finally { await rm(dir); }
});

test('--no-cache and cache:false always execute and explain why', async () => {
  const files = fixtureFiles();
  const cfg = JSON.parse(files['buildrush.json']!);
  cfg.tasks.lint.cache = false;
  files['buildrush.json'] = JSON.stringify(cfg);
  const dir = await tmpProject(files);
  try {
    await run(dir);
    const r = await run(dir);
    assert.equal(task(r, 'lint').state, 'succeeded');
    assert.match(task(r, 'lint').reasons[0]!, /cache: false/);
    const r2 = await run(dir, ['compile'], { noCache: true });
    assert.equal(task(r2, 'compile').state, 'succeeded');
    assert.match(task(r2, 'compile').reasons[0]!, /--no-cache/);
  } finally { await rm(dir); }
});

test('corrupted cache entry falls back to a real run and heals the cache', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    await run(dir, ['compile']);
    const p = await Project.open(dir);
    const blobDir = path.join(p.cache.dir, 'blobs');
    for (const shard of await fs.readdir(blobDir)) for (const b of await fs.readdir(path.join(blobDir, shard))) {
      const f = path.join(blobDir, shard, b);
      if ((await fs.readFile(f, 'utf8')).includes('---') || (await fs.stat(f)).size > 0) { await fs.chmod(f, 0o600); await fs.writeFile(f, 'CORRUPT'); }
    }
    await fs.rm(path.join(dir, 'dist'), { recursive: true });
    const r = await run(dir, ['compile']);
    assert.equal(task(r, 'compile').state, 'succeeded');
    assert.ok(task(r, 'compile').reasons.some((x) => /cache entry unusable/.test(x)), task(r, 'compile').reasons.join('|'));
    assert.equal(await fs.readFile(path.join(dir, 'dist/bundle.txt'), 'utf8').then((s) => s.includes('export const a')), true);
  } finally { await rm(dir); }
});

test('independent tasks run concurrently, bounded by capacity', async () => {
  const mk = (n: string) => ({ command: `node scripts/slow.js ${n}`, inputs: ['scripts/slow.js'], cache: false });
  const files = {
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'p' }, concurrency: 2, tasks: { a: mk('a'), b: mk('b'), c: mk('c'), d: mk('d') } }),
    'scripts/slow.js': [
      "import fs from 'node:fs';",
      "const n = process.argv[2]; fs.writeFileSync(`../${process.env.LOGDIR ?? ''}x`, ''); ",
    ].join('\n'),
  };
  // simpler & robust: each task records its start/end timestamps in the log; compare windows.
  files['scripts/slow.js'] = "const s = Date.now(); await new Promise((r) => setTimeout(r, 300)); console.log(JSON.stringify([s, Date.now()]));\n";
  const dir = await tmpProject({ ...files, 'package.json': '{"type":"module"}' });
  try {
    const r = await run(dir, ['a', 'b', 'c', 'd']);
    assert.ok(r.ok);
    const win = r.tasks.map((t) => JSON.parse(t.log.trim()) as [number, number]);
    let peak = 0;
    for (const [s] of win) peak = Math.max(peak, win.filter(([s2, e2]) => s2 <= s && s < e2).length);
    assert.equal(peak, 2, 'exactly 2 overlap with capacity 2');
    assert.ok(r.durationMs < 1150, `4x300ms at width 2 should take ~600ms, took ${r.durationMs}`);
  } finally { await rm(dir); }
});

test('cancellation stops a running task and reports cancelled', async () => {
  const files = {
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'p' }, tasks: { hang: { command: 'node scripts/hang.js', inputs: ['scripts/**'], cache: false } } }),
    'scripts/hang.js': "setInterval(() => {}, 1000);\n",
  };
  const dir = await tmpProject(files);
  try {
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 400);
    const t0 = Date.now();
    const r = await run(dir, ['hang'], { signal: ac.signal });
    assert.equal(task(r, 'hang').state, 'cancelled');
    assert.ok(r.cancelled && !r.ok);
    assert.ok(Date.now() - t0 < 4000);
  } finally { await rm(dir); }
});

test('unknown executables fail clearly instead of being run through a shell', async () => {
  const dir = await tmpProject({ 'buildrush.json': JSON.stringify({ version: 1, project: { name: 'p' }, tasks: { x: { command: 'definitely-not-installed --flag' } } }) });
  try {
    const r = await run(dir, ['x']);
    assert.equal(task(r, 'x').state, 'failed');
    assert.match(task(r, 'x').notes[0]!, /not found/);
  } finally { await rm(dir); }
});

test('--affected: selects only tests that import changed files; full run is the safe fallback', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    git(dir, 'init', '-q');
    await fs.writeFile(path.join(dir, '.gitignore'), '.buildrush/\ndist/\n');
    git(dir, 'add', '-A'); git(dir, 'commit', '-qm', 'init');

    // Edit only src/c.js: only test/c.test.js is affected.
    await fs.writeFile(path.join(dir, 'src/c.js'), 'export const c = 3; // v2\n');
    const r = await run(dir, ['test'], { affected: {} });
    assert.ok(r.ok, r.tasks.map((t) => t.log).join('\n'));
    assert.equal(r.selection!.mode, 'affected');
    assert.deepEqual(r.selection!.selected, ['test/c.test.js']);
    assert.deepEqual(r.selection!.skipped.map((s) => s.test), ['test/a.test.js']);
    assert.match(task(r, 'test').log, /tests 1/, 'only one test file executed');

    // Edit a.js: b.js imports it, a.test.js imports b.js -> transitive selection.
    git(dir, 'checkout', '-q', '--', 'src/c.js');
    await fs.writeFile(path.join(dir, 'src/a.js'), 'export const a = 1; // v2\n');
    const r2 = await run(dir, ['test'], { affected: {} });
    assert.deepEqual(r2.selection!.selected, ['test/a.test.js']);
    assert.deepEqual(r2.selection!.chains['test/a.test.js'], ['test/a.test.js', 'src/b.js', 'src/a.js']);

    // Global config change: everything runs.
    git(dir, 'checkout', '-q', '--', 'src/a.js');
    await fs.writeFile(path.join(dir, 'package.json'), '{"type":"module","name":"fixture","version":"2"}');
    const r3 = await run(dir, ['test'], { affected: {} });
    assert.equal(r3.selection!.mode, 'all');
    assert.match(r3.selection!.reason!, /package\.json/);
    assert.match(task(r3, 'test').log, /tests 2/);

    // No change at all: nothing to run, and that is reported as skipped (not failed).
    git(dir, 'checkout', '-q', '--', 'package.json');
    const r4 = await run(dir, ['test'], { affected: {} });
    assert.ok(r4.ok);
    assert.equal(task(r4, 'test').state, 'skipped');
  } finally { await rm(dir); }
});

test('--affected outside a git repo runs ALL tests (and says so)', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    const r = await run(dir, ['test'], { affected: {} });
    assert.equal(r.selection!.mode, 'all');
    assert.match(r.selection!.reason!, /git/);
    assert.match(task(r, 'test').log, /tests 2/);
  } finally { await rm(dir); }
});

test('git ref arguments cannot be used for option injection', async () => {
  const dir = await tmpProject(fixtureFiles());
  try {
    const r = await run(dir, ['test'], { affected: { since: '--output=/tmp/pwned' } });
    assert.equal(r.selection!.mode, 'all');
    assert.match(r.selection!.reason!, /invalid git ref/);
  } finally { await rm(dir); }
});

test('broad output globs never sweep node_modules, .git or the cache into the manifest', async () => {
  const files = fixtureFiles();
  const cfg = JSON.parse(files['buildrush.json']!);
  cfg.tasks.compile.outputs = ['dist/**', '**/*.txt'];
  files['buildrush.json'] = JSON.stringify(cfg);
  files['node_modules/dep/leak.txt'] = 'must not be captured';
  const dir = await tmpProject(files);
  try {
    const r = await run(dir, ['compile']);
    assert.equal(task(r, 'compile').state, 'succeeded');
    const p = await Project.open(dir);
    const rec = await p.cache.lookup(task(r, 'compile').fingerprint!);
    assert.ok(rec);
    assert.deepEqual(rec!.outputs.map((o) => o.path), ['dist/bundle.txt']);
  } finally { await rm(dir); }
});

test('a task never treats an unrelated task\'s outputs as inputs, but does for tasks it depends on', async () => {
  const files = {
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'p' }, tasks: {
      producer: { command: 'node make.js', inputs: ['make.js', 'seed.txt'], outputs: ['gen/**'] },
      bystander: { command: 'node -e 0', inputs: ['**/*.txt'] },            // glob also matches gen/out.txt
      consumer: { command: 'node -e 0', dependsOn: ['producer'], inputs: ['gen/**'] },
    } }),
    'make.js': "import fs from 'node:fs'; fs.mkdirSync('gen',{recursive:true}); fs.writeFileSync('gen/out.txt', fs.readFileSync('seed.txt'));\n",
    'seed.txt': 'v1', 'package.json': '{"type":"module"}',
  };
  const dir = await tmpProject(files);
  try {
    await run(dir, ['bystander']);
    await run(dir, ['consumer']);
    assert.equal(task(await run(dir, ['bystander']), 'bystander').state, 'cached', 'producer output must not leak into bystander inputs');
    await fs.writeFile(path.join(dir, 'seed.txt'), 'v2');
    const r = await run(dir, ['consumer']);
    assert.equal(task(r, 'producer').state, 'succeeded');
    assert.equal(task(r, 'consumer').state, 'succeeded', 'consumer depends on producer and reads gen/**');
    assert.equal(task(await run(dir, ['consumer']), 'consumer').state, 'cached');
  } finally { await rm(dir); }
});
