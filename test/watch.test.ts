import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/project.js';
import { Debouncer, makeEventFilter, startWatch, WatchCycle, WatchOptions, WatchSession } from '../src/watch.js';
import { WatcherFactory, WatcherOptions, WatchMode } from '../src/fswatch.js';
import { sha256 } from '../src/util/hash.js';
import { fixtureFiles, rm, tmpProject } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/buildrush.js');
const TIMEOUT = 30_000;

async function waitFor(cond: () => boolean | Promise<boolean>, what: string, ms = TIMEOUT): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await cond()) return;
    await new Promise((r) => setTimeout(r, 15));
  }
  throw new Error(`timed out waiting for: ${what}`);
}

interface Harness {
  session: WatchSession;
  cycles: WatchCycle[];
  notices: string[];
  write: (rel: string, content: string) => Promise<void>;
  close: () => Promise<void>;
}

async function begin(dir: string, o: Partial<WatchOptions> = {}, tasks = ['default']): Promise<Harness> {
  const project = await Project.open(dir);
  const cycles: WatchCycle[] = [];
  const notices: string[] = [];
  const session = await startWatch(project, {
    tasks,
    debounceMs: 20,
    reconcileMs: 600_000,
    ...o,
    onCycle: (c) => cycles.push(c),
    onNotice: (m) => notices.push(m),
  });
  return {
    session, cycles, notices,
    write: async (rel, content) => {
      await fs.mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
      await fs.writeFile(path.join(dir, rel), content);
    },
    close: () => session.stop(),
  };
}

const states = (c: WatchCycle) => Object.fromEntries((c.report?.tasks ?? []).map((t) => [t.task, t.state]));

/** A watcher that reports nothing on its own: tests drive (or withhold) events by hand. */
function manualWatcher() {
  let opts: WatcherOptions | null = null;
  const factory: WatcherFactory = (o) => { opts = o; return { mode: 'recursive', close: () => {} }; };
  return { factory, emit: (rel: string | null) => opts!.onEvent(rel), error: (e: Error) => opts!.onError(e) };
}

const modes: WatchMode[] = process.platform === 'linux' ? ['per-directory', 'recursive'] : ['recursive', 'per-directory'];

for (const mode of modes) {
  test(`watch (${mode}): an edit reruns exactly the tasks that read the file; new dirs are watched`, { timeout: 90_000 }, async () => {
    const dir = await tmpProject(fixtureFiles());
    const h = await begin(dir, { watchMode: mode });
    try {
      await waitFor(() => h.cycles.length >= 1, 'initial cycle');
      assert.equal(h.cycles[0]!.trigger, 'initial');
      assert.deepEqual(states(h.cycles[0]!), { lint: 'succeeded', compile: 'succeeded', test: 'succeeded' });

      // Only lint reads scripts/lint.js.
      await h.write('scripts/lint.js', "console.log('lint ok v2');\n");
      await waitFor(() => h.cycles.length >= 2, 'cycle after lint.js edit');
      const c2 = h.cycles[1]!;
      assert.equal(c2.trigger, 'change');
      assert.deepEqual(c2.changed, { added: [], modified: ['scripts/lint.js'], removed: [] });
      assert.deepEqual(states(c2), { lint: 'succeeded', compile: 'cached', test: 'cached' });

      // A file no task reads: a cycle happens (it was a change) but everything is reused.
      await h.write('README.md', 'docs');
      await waitFor(() => h.cycles.length >= 3, 'cycle after README edit');
      assert.deepEqual(states(h.cycles[2]!), { lint: 'cached', compile: 'cached', test: 'cached' });

      // A brand-new directory, then an edit inside it (needs a watcher on the new directory).
      await h.write('src/sub/d.js', 'export const d = 1;\n');
      await waitFor(() => h.cycles.length >= 4, 'cycle after new dir');
      assert.deepEqual(h.cycles[3]!.changed.added, ['src/sub/d.js']);
      await h.write('src/sub/d.js', 'export const d = 2;\n');
      await waitFor(() => h.cycles.length >= 5, 'cycle after edit in new dir');
      assert.deepEqual(h.cycles[4]!.changed.modified, ['src/sub/d.js']);
      assert.ok(h.session.stats.events > 0);
    } finally {
      await h.close();
      await rm(dir);
    }
  });
}

test('watch: task outputs and ignored directories never start a cycle', { timeout: 60_000 }, async () => {
  const dir = await tmpProject(fixtureFiles());
  const h = await begin(dir);
  try {
    await waitFor(() => h.cycles.length >= 1, 'initial cycle');
    // compile rewrites dist/bundle.txt on this edit; that write must not come back as a change.
    await h.write('src/c.js', 'export const c = 3; // v4\n');
    await waitFor(() => h.cycles.length >= 2, 'cycle after src edit');
    assert.deepEqual(h.cycles[1]!.changed, { added: [], modified: ['src/c.js'], removed: [] });
    assert.equal(h.cycles[1]!.report!.tasks.find((t) => t.task === 'compile')!.state, 'succeeded');

    await h.write('dist/bundle.txt', 'tampered output');
    await h.write('node_modules/x/index.js', 'ignored');
    await h.write('.git/hooks-note', 'ignored');
    await h.write('.buildrush/scratch', 'ignored');
    await h.write('scripts/lint.js', "console.log('lint ok v3');\n");
    await waitFor(() => h.cycles.length >= 3, 'cycle after lint edit');
    assert.deepEqual(h.cycles[2]!.changed, { added: [], modified: ['scripts/lint.js'], removed: [] });
    await h.close();
    assert.equal(h.cycles.length, 3, 'outputs / ignored dirs must not have started extra cycles');
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('event filter: ignored dirs, config ignore globs and declared outputs', async () => {
  const dir = await tmpProject(fixtureFiles({ ignore: ['tmp/**'] }));
  try {
    const p = await Project.open(dir);
    const f = makeEventFilter(p);
    for (const ig of ['.git/index', '.git', 'node_modules/a/b.js', 'sub/node_modules/x.js', '.buildrush/state/index.json', 'dist/bundle.txt', 'tmp/x.log']) {
      assert.equal(f(ig), true, ig);
    }
    for (const keep of ['src/a.js', 'scripts/lint.js', 'buildrush.json', 'test/a.test.js', 'README.md']) {
      assert.equal(f(keep), false, keep);
    }
  } finally { await rm(dir); }
});

test('watch: a dropped event is recovered by periodic reconciliation', { timeout: 60_000 }, async () => {
  const dir = await tmpProject(fixtureFiles());
  const mw = manualWatcher(); // never emits
  const h = await begin(dir, { watcherFactory: mw.factory, reconcileMs: 40 });
  try {
    await waitFor(() => h.cycles.length >= 1, 'initial cycle');
    await h.write('src/c.js', 'export const c = 3; // v5\n');
    await waitFor(() => h.cycles.length >= 2, 'reconciliation to notice the edit');
    const c = h.cycles[1]!;
    assert.equal(c.trigger, 'reconcile');
    assert.deepEqual(c.changed.modified, ['src/c.js']);
    assert.equal(h.session.stats.events, 0, 'the watcher reported nothing');
    assert.ok(c.report!.ok);
    // Reconciliation with nothing changed must not start cycles.
    await waitFor(() => h.session.stats.noopScans >= 2, 'no-op reconciliations');
    assert.equal(h.cycles.length, 2);
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('watch: a watcher error forces an immediate full reconciliation (no waiting for the timer)', { timeout: 60_000 }, async () => {
  const dir = await tmpProject(fixtureFiles());
  const mw = manualWatcher();
  const h = await begin(dir, { watcherFactory: mw.factory, reconcileMs: 600_000, degradedReconcileMs: 600_000 });
  try {
    await waitFor(() => h.cycles.length >= 1, 'initial cycle');
    await h.write('src/a.js', 'export const a = 1; // v10\n');
    mw.error(new Error('event queue overflow'));
    await waitFor(() => h.cycles.length >= 2, 'cycle after watcher error');
    assert.equal(h.cycles[1]!.trigger, 'error');
    assert.deepEqual(h.cycles[1]!.changed.modified, ['src/a.js']);
    assert.equal(h.session.stats.watcherErrors, 1);
    assert.match(h.notices[0]!, /event queue overflow/);
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('Debouncer: first trigger is immediate, a burst coalesces into one trailing fire', async () => {
  let fired = 0;
  const d = new Debouncer(30, () => { fired++; });
  for (let i = 0; i < 10; i++) d.trigger();
  assert.equal(fired, 1, 'no delay when idle');
  await waitFor(() => fired === 2, 'trailing fire');
  await new Promise((r) => setTimeout(r, 120));
  assert.equal(fired, 2, 'exactly one trailing fire for the whole burst');
  d.cancel();
});

test('watch: rapid edits coalesce and the final state is what ran', { timeout: 60_000 }, async () => {
  const dir = await tmpProject(fixtureFiles());
  const mw = manualWatcher();
  const h = await begin(dir, { watcherFactory: mw.factory, debounceMs: 50 });
  try {
    await waitFor(() => h.cycles.length >= 1, 'initial cycle');
    let last = '';
    for (let i = 0; i < 40; i++) {
      last = `export const c = 3; // edit ${i}\n`;
      await h.write('src/c.js', last);
      mw.emit('src/c.js');
    }
    const want = sha256(last);
    await waitFor(() => {
      const c = h.cycles.at(-1)!;
      return h.cycles.length >= 2 && !c.superseded && !!c.report?.ok && h.session.project.index.files.get('src/c.js')?.digest === want;
    }, 'final cycle');
    assert.ok(h.cycles.length <= 6, `40 edits produced ${h.cycles.length} cycles`);
  } finally {
    await h.close();
    await rm(dir);
  }
});

function slowFixture(): Record<string, string> {
  const files = fixtureFiles();
  const cfg = JSON.parse(files['buildrush.json']!);
  cfg.tasks.slow = { command: 'node scripts/slow.js', kind: 'build', inputs: ['src/go.txt', 'scripts/slow.js'] };
  files['buildrush.json'] = JSON.stringify(cfg);
  files['src/go.txt'] = 'hang';
  files['scripts/slow.js'] = [
    "import fs from 'node:fs';",
    "const mode = fs.readFileSync('src/go.txt', 'utf8').trim();",
    "fs.mkdirSync('.buildrush', { recursive: true });",
    "fs.writeFileSync('.buildrush/started-' + mode, '1');",
    "if (mode === 'hang') setTimeout(() => {}, 120000); else console.log('slow done');",
  ].join('\n');
  return files;
}
const exists = (p: string) => fs.access(p).then(() => true, () => false);

test('watch: an edit during a run cancels it; the partial run is never cached or published', { timeout: 90_000 }, async () => {
  const dir = await tmpProject(slowFixture());
  const h = await begin(dir, {}, ['slow']);
  try {
    await waitFor(() => exists(path.join(dir, '.buildrush/started-hang')), 'slow task to start');
    await h.write('src/go.txt', 'fast');
    await waitFor(() => h.cycles.length >= 2, 'restarted cycle');
    const [c1, c2] = h.cycles as [WatchCycle, WatchCycle];
    assert.equal(c1.superseded, true);
    assert.equal(c1.report!.cancelled, true);
    assert.equal(c1.report!.tasks[0]!.state, 'cancelled');
    assert.equal(c2.superseded, false);
    assert.equal(c2.report!.ok, true);
    assert.equal(c2.report!.tasks[0]!.state, 'succeeded');
    assert.deepEqual(c2.changed.modified, ['src/go.txt']);
    // The cancelled attempt left no cache entry or per-task last-good state behind: only the
    // fingerprint of the successful second run exists.
    const second = c2.report!.tasks[0]!.fingerprint!;
    assert.notEqual(c1.report!.tasks[0]!.fingerprint, second);
    assert.equal(await h.session.project.cache.lookup(c1.report!.tasks[0]!.fingerprint!), null);
    assert.ok(await h.session.project.cache.lookup(second));
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('watch: graceful shutdown cancels in-flight work, closes watchers and resolves', { timeout: 90_000 }, async () => {
  const dir = await tmpProject(slowFixture());
  const ctl = new AbortController();
  const h = await begin(dir, { signal: ctl.signal }, ['slow']);
  try {
    await waitFor(() => exists(path.join(dir, '.buildrush/started-hang')), 'slow task to start');
    ctl.abort();
    await h.session.done;
    assert.equal(h.cycles.length, 1);
    assert.equal(h.cycles[0]!.report!.cancelled, true);
    assert.equal(h.cycles[0]!.superseded, false);
    // Edits after stop do nothing.
    await h.write('src/go.txt', 'fast');
    await new Promise((r) => setTimeout(r, 150));
    assert.equal(h.cycles.length, 1);
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('watch: buildrush.json changes reload the configuration; a broken config is reported, not run', { timeout: 90_000 }, async () => {
  const files = fixtureFiles();
  files['scripts/lint2.js'] = "console.log('lint2 ok');\n";
  const dir = await tmpProject(files);
  const h = await begin(dir);
  try {
    await waitFor(() => h.cycles.length >= 1, 'initial cycle');
    const cfg = JSON.parse(files['buildrush.json']!);
    cfg.tasks.lint.command = 'node scripts/lint2.js';
    await h.write('buildrush.json', JSON.stringify(cfg));
    await waitFor(() => h.cycles.some((c) => c.configReloaded), 'config reload');
    const c = h.cycles.find((x) => x.configReloaded)!;
    assert.equal(c.report!.tasks.find((t) => t.task === 'lint')!.state, 'succeeded');
    assert.match(c.report!.tasks.find((t) => t.task === 'lint')!.log, /lint2 ok/);

    const before = h.cycles.length;
    await h.write('buildrush.json', '{ not json');
    await waitFor(() => h.cycles.length > before, 'cycle for broken config');
    const bad = h.cycles.at(-1)!;
    assert.equal(bad.report, null);
    assert.match(bad.error!, /reload failed/);

    await h.write('buildrush.json', JSON.stringify(cfg));
    await waitFor(() => h.cycles.at(-1)!.configReloaded && h.cycles.at(-1)!.report?.ok === true, 'recovery after fixing config');
  } finally {
    await h.close();
    await rm(dir);
  }
});

test('cli: --watch --json emits one JSON object per cycle (NDJSON) and rejects non-run commands', { timeout: 90_000 }, async () => {
  const dir = await tmpProject(fixtureFiles());
  const env = { PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp', SystemRoot: process.env.SystemRoot ?? '' };
  const bad = spawnSync(process.execPath, [BIN, 'explain', '--watch'], { cwd: dir, encoding: 'utf8', env });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /--watch only applies/);

  const child = spawn(process.execPath, [BIN, 'run', '--watch', '--json'], { cwd: dir, env });
  const lines: string[] = [];
  let buf = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (d: string) => {
    buf += d;
    let i;
    while ((i = buf.indexOf('\n')) >= 0) { lines.push(buf.slice(0, i)); buf = buf.slice(i + 1); }
  });
  const exited = new Promise<void>((r) => child.on('exit', () => r()));
  try {
    await waitFor(() => lines.length >= 1, 'first NDJSON line');
    const first = JSON.parse(lines[0]!);
    assert.equal(first.cycle, 1);
    assert.equal(first.trigger, 'initial');
    assert.equal(first.counts.ran, 3);
    await fs.writeFile(path.join(dir, 'scripts/lint.js'), "console.log('lint ok v2');\n");
    await waitFor(() => lines.length >= 2, 'second NDJSON line');
    const second = JSON.parse(lines[1]!);
    assert.equal(second.cycle, 2);
    assert.equal(second.trigger, 'change');
    assert.deepEqual(second.changed.modified, ['scripts/lint.js']);
    assert.equal(second.ok, true);
    assert.deepEqual(second.counts, { ran: 1, cached: 2, failed: 0, skipped: 0, cancelled: 0 });
    assert.ok(Array.isArray(second.tasks));
  } finally {
    child.kill();
    await exited;
    await rm(dir);
  }
});
