import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Project } from '../src/project.js';
import { runTasks, RunReport } from '../src/engine.js';
import { ConfigError, validateConfig } from '../src/config.js';
import { discoverWorkspaces, parsePnpmWorkspaceYaml, selectPackages } from '../src/workspaces.js';
import { git, rm, tmpProject, writeFiles } from './helpers.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/buildrush.js');
const cli = (cwd: string, ...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: process.env.HOME ?? '/tmp' } });

/**
 * Monorepo fixture. Package graph:   app -> util -> core      docs (unrelated)
 * Tasks are plain node scripts: `build` concatenates src/*.js into dist/out.txt; `test` just echoes
 * the test files it was asked to run (so --affected selection is observable in the task log).
 */
function monorepo(over: { config?: Record<string, unknown>; files?: Record<string, string> } = {}): Record<string, string> {
  const pkg = (name: string, deps: string[] = [], extra: Record<string, unknown> = {}) =>
    JSON.stringify({ name, version: '1.0.0', type: 'module', main: 'src/index.js', dependencies: Object.fromEntries(deps.map((d) => [d, 'workspace:*'])), ...extra });
  const config = {
    version: 1,
    project: { name: 'mono' },
    concurrency: 4,
    tasks: {
      build: { scope: 'packages', command: 'node ../../scripts/build.js', inputs: ['src/**'], outputs: ['dist/**'], dependsOn: ['^build'] },
      test: { scope: 'packages', kind: 'test', affected: true, command: 'node ../../scripts/runtests.js', dependsOn: ['build'], inputs: ['src/**', 'test/**'] },
    },
    pipelines: { default: ['build', 'test'] },
    ...over.config,
  };
  const testFile = (importLine: string) => `${importLine}\n`;
  return {
    'buildrush.json': JSON.stringify(config, null, 2),
    'package.json': JSON.stringify({ name: 'root', private: true, workspaces: ['packages/*'] }),
    'package-lock.json': '{"lockfileVersion":3}',
    'scripts/build.js': [
      "import fs from 'node:fs';",
      "const parts = fs.readdirSync('src').sort().map((f) => fs.readFileSync('src/' + f, 'utf8'));",
      "fs.mkdirSync('dist', { recursive: true });",
      "fs.writeFileSync('dist/out.txt', parts.join('---'));",
    ].join('\n'),
    'scripts/runtests.js': "console.log('tests:', process.argv.slice(2).join(','));\n",
    'packages/core/package.json': pkg('@fx/core'),
    'packages/core/src/index.js': 'export const core = 1;\n',
    'packages/core/test/core.test.js': testFile("import { core } from '../src/index.js';"),
    'packages/util/package.json': pkg('@fx/util', ['@fx/core']),
    'packages/util/src/index.js': "import { core } from '@fx/core';\nexport const util = core + 1;\n",
    'packages/util/test/util.test.js': testFile("import { util } from '../src/index.js';"),
    'packages/app/package.json': pkg('@fx/app', ['@fx/util']),
    'packages/app/src/index.js': "import { util } from '@fx/util';\nexport const app = util + 1;\n",
    'packages/app/test/app.test.js': testFile("import { app } from '../src/index.js';"),
    'packages/docs/package.json': pkg('@fx/docs'),
    'packages/docs/src/index.js': 'export const docs = 1;\n',
    'packages/docs/test/docs.test.js': testFile("import { docs } from '../src/index.js';"),
    '.gitignore': 'node_modules/\ndist/\n.buildrush/\n',
    ...over.files,
  };
}

async function run(dir: string, names: string[] = ['default'], opts: Parameters<typeof runTasks>[2] = {}): Promise<RunReport> {
  const p = await Project.open(dir);
  return runTasks(p, names, opts);
}
const states = (r: RunReport) => Object.fromEntries(r.tasks.map((t) => [t.task, t.state]));
const only = (r: RunReport, state: string) => r.tasks.filter((t) => t.state === state).map((t) => t.task).sort();
const ALL = ['@fx/app:build', '@fx/app:test', '@fx/core:build', '@fx/core:test', '@fx/docs:build', '@fx/docs:test', '@fx/util:build', '@fx/util:test'];

function commit(dir: string, msg = 'c') {
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', msg);
}

test('package tasks expand per package, run in package-dependency order, and re-run from cache', async () => {
  const dir = await tmpProject(monorepo());
  try {
    const r1 = await run(dir);
    assert.ok(r1.ok, JSON.stringify(r1.tasks.map((t) => [t.task, t.state, t.notes, t.log])));
    assert.deepEqual(r1.tasks.map((t) => t.task).sort(), ALL);
    assert.deepEqual(only(r1, 'succeeded'), ALL);
    const order = r1.tasks.map((t) => t.task);
    assert.ok(order.indexOf('@fx/core:build') < order.indexOf('@fx/util:build'));
    assert.ok(order.indexOf('@fx/util:build') < order.indexOf('@fx/app:build'));
    // Each instance runs in its own package and writes its own outputs.
    assert.match(await fs.readFile(path.join(dir, 'packages/util/dist/out.txt'), 'utf8'), /util = core/);
    await assert.rejects(fs.access(path.join(dir, 'dist')));
    const r2 = await run(dir);
    assert.deepEqual(only(r2, 'cached'), ALL);
    // The group name and a single instance are both addressable.
    const one = await run(dir, ['@fx/app:build']);
    assert.deepEqual(one.tasks.map((t) => t.task), ['@fx/core:build', '@fx/util:build', '@fx/app:build']);
  } finally { await rm(dir); }
});

test('change in a leaf package re-runs its dependents; unrelated packages stay cached', async () => {
  const dir = await tmpProject(monorepo());
  try {
    await run(dir);
    await fs.writeFile(path.join(dir, 'packages/core/src/index.js'), 'export const core = 2;\n');
    const r = await run(dir);
    assert.deepEqual(only(r, 'cached'), ['@fx/docs:build', '@fx/docs:test']);
    assert.deepEqual(only(r, 'succeeded'), ['@fx/app:build', '@fx/app:test', '@fx/core:build', '@fx/core:test', '@fx/util:build', '@fx/util:test']);
    const why = r.tasks.find((t) => t.task === '@fx/util:build')!.reasons.join('|');
    assert.match(why, /dependency task "@fx\/core:build"/);
    // A change at the top only re-runs the top.
    await fs.writeFile(path.join(dir, 'packages/app/src/index.js'), "import { util } from '@fx/util';\nexport const app = util + 2;\n");
    const r2 = await run(dir);
    assert.deepEqual(only(r2, 'succeeded'), ['@fx/app:build', '@fx/app:test']);
    assert.equal(only(r2, 'cached').length, 6);
  } finally { await rm(dir); }
});

test('root lockfile, root package.json and a package manifest invalidate as documented', async () => {
  const dir = await tmpProject(monorepo());
  try {
    await run(dir);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"changed":true}');
    assert.deepEqual(only(await run(dir), 'succeeded'), ALL);
    assert.deepEqual(only(await run(dir), 'cached'), ALL);
    // A package's own package.json only invalidates that package and its dependents.
    await fs.writeFile(path.join(dir, 'packages/docs/package.json'), JSON.stringify({ name: '@fx/docs', version: '1.0.1', type: 'module', main: 'src/index.js' }));
    const r = await run(dir);
    assert.deepEqual(only(r, 'succeeded'), ['@fx/docs:build', '@fx/docs:test']);
  } finally { await rm(dir); }
});

test('root tool configs and declared rootInputs invalidate package tasks that declare package-relative inputs', async () => {
  const dir = await tmpProject(monorepo({
    config: {
      tasks: {
        build: { scope: 'packages', command: 'node ../../scripts/build.js', inputs: ['src/**'], outputs: ['dist/**'], rootInputs: ['scripts/**'], dependsOn: ['^build'] },
      },
      pipelines: { default: ['build'] },
    },
    files: { 'vitest.config.mjs': 'export default {};\n', 'notes.md': 'hello\n' },
  }));
  const ALL_BUILD = ALL.filter((t) => t.endsWith(':build'));
  try {
    await run(dir);
    // Unrelated root file: nothing re-runs.
    await fs.writeFile(path.join(dir, 'notes.md'), 'changed\n');
    assert.deepEqual(only(await run(dir), 'cached'), ALL_BUILD);
    // A root tool config (vitest/vite/jest/eslint/babel/...) is shared by every package.
    await fs.writeFile(path.join(dir, 'vitest.config.mjs'), 'export default { test: {} };\n');
    assert.deepEqual(only(await run(dir), 'succeeded'), ALL_BUILD);
    assert.deepEqual(only(await run(dir), 'cached'), ALL_BUILD);
    // The task's own script outside the packages is declared with rootInputs.
    await fs.appendFile(path.join(dir, 'scripts/build.js'), '\n// edited\n');
    assert.deepEqual(only(await run(dir), 'succeeded'), ALL_BUILD);
  } finally { await rm(dir); }
});

test('rootInputs: only valid on package tasks, project-relative, no "..", validated like inputs', () => {
  const base = { command: 'node -v', scope: 'packages' };
  const bad = (t: Record<string, unknown>) => validateConfig({ version: 1, project: { name: 'x' }, tasks: { t } });
  assert.throws(() => bad({ command: 'node -v', rootInputs: ['a'] }), /rootInputs.*only valid.*scope "packages"/);
  assert.throws(() => bad({ ...base, rootInputs: ['../a'] }), /rootInputs/);
  assert.throws(() => bad({ ...base, rootInputs: 'a' }), /rootInputs/);
  assert.doesNotThrow(() => bad({ ...base, rootInputs: ['scripts/**'] }));
});

test('--affected selects changed packages and their dependents (transitively), pulling dependencies from cache', async () => {
  const dir = await tmpProject(monorepo());
  try {
    git(dir, 'init', '-q');
    await run(dir);
    commit(dir);
    // Nothing changed: no package is selected.
    const none = await run(dir, ['default'], { affected: {} });
    assert.equal(none.packages?.mode, 'affected');
    assert.deepEqual(none.tasks, []);

    await fs.writeFile(path.join(dir, 'packages/util/src/index.js'), "import { core } from '@fx/core';\nexport const util = core + 10;\n");
    const r = await run(dir, ['default'], { affected: {} });
    assert.deepEqual(r.packages?.affected, ['@fx/app', '@fx/util']);
    assert.deepEqual(r.packages?.skipped, ['@fx/core', '@fx/docs']);
    assert.ok(r.ok, JSON.stringify(r.tasks.map((t) => [t.task, t.state, t.notes, t.log])));
    // core:build is only here as a dependency of util:build and comes from the cache.
    assert.deepEqual(states(r), {
      '@fx/core:build': 'cached', '@fx/util:build': 'succeeded', '@fx/app:build': 'succeeded', '@fx/util:test': 'succeeded', '@fx/app:test': 'succeeded',
    });
    // Each package's test task only receives the selected tests of its own package.
    assert.match(r.tasks.find((t) => t.task === '@fx/util:test')!.log, /tests: test\/util\.test\.js\s*$/);
    assert.match(r.tasks.find((t) => t.task === '@fx/app:test')!.log, /tests: test\/app\.test\.js\s*$/);

    // A change only in docs selects only docs.
    git(dir, 'checkout', '-q', '--', 'packages/util/src/index.js');
    await fs.writeFile(path.join(dir, 'packages/docs/src/index.js'), 'export const docs = 2;\n');
    const d = await run(dir, ['default'], { affected: {} });
    assert.deepEqual(d.packages?.affected, ['@fx/docs']);
    assert.deepEqual(d.tasks.map((t) => t.task).sort(), ['@fx/docs:build', '@fx/docs:test']);
  } finally { await rm(dir); }
});

test('--affected is conservative: lockfile change and unresolvable workspace imports select every package', async () => {
  const dir = await tmpProject(monorepo());
  try {
    git(dir, 'init', '-q');
    await run(dir);
    commit(dir);
    await fs.writeFile(path.join(dir, 'package-lock.json'), '{"lockfileVersion":3,"x":1}');
    const lock = await run(dir, ['default'], { affected: {} });
    assert.equal(lock.packages?.mode, 'all');
    assert.match(lock.packages?.reason ?? '', /package-lock\.json/);
    assert.equal(lock.tasks.length, ALL.length);
    commit(dir);

    // app imports a subpath of a workspace package that does not exist -> cannot bound its dependencies.
    await fs.writeFile(path.join(dir, 'packages/app/src/index.js'), "import { util } from '@fx/util';\nimport('@fx/util/missing.js');\nexport const app = util + 1;\nimport { x } from '@fx/util/missing';\n");
    const p = await Project.open(dir);
    const g = await p.graph();
    const mod = g.modules.get('packages/app/src/index.js')!;
    assert.ok(mod.uncertain.some((u) => /unresolved import "@fx\/util\/missing"/.test(u)), mod.uncertain.join('|'));
    const sel = selectPackages(p.workspace!, g, null, ['packages/app/src/index.js']);
    assert.equal(sel.mode, 'all');
    assert.match(sel.reason ?? '', /uncertain dependencies/);
    const r = await runTasks(p, ['default'], { affected: {} });
    assert.equal(r.packages?.mode, 'all');
    assert.ok(r.tasks.some((t) => t.task === '@fx/docs:build'));
  } finally { await rm(dir); }
});

test('package dependency cycles are reported with the cycle path', async () => {
  const files = monorepo({
    files: {
      'packages/core/package.json': JSON.stringify({ name: '@fx/core', version: '1.0.0', dependencies: { '@fx/app': '*' } }),
    },
  });
  const dir = await tmpProject(files);
  try {
    await assert.rejects(Project.open(dir), (e: Error) => {
      assert.ok(e instanceof ConfigError);
      assert.match(e.message, /workspace package dependency cycle: (@fx\/app -> @fx\/util -> @fx\/core -> @fx\/app|@fx\/core -> @fx\/app -> @fx\/util -> @fx\/core|@fx\/util -> @fx\/core -> @fx\/app -> @fx\/util)/);
      return true;
    });
    const r = cli(dir, 'run');
    assert.equal(r.status, 2);
    assert.match(r.stderr, /dependency cycle/);
  } finally { await rm(dir); }
});

test('a package filter limits where a task runs; ordering skips through packages that do not run it', async () => {
  const base = JSON.parse(monorepo()['buildrush.json']!);
  base.tasks.build.packages = ['@fx/core', '@fx/app']; // util does not build
  base.tasks.test.packages = ['@fx/app'];
  base.tasks.test.dependsOn = ['build'];
  const dir = await tmpProject(monorepo({ config: { tasks: base.tasks } }));
  try {
    const r = await run(dir);
    assert.ok(r.ok, JSON.stringify(r.tasks.map((t) => [t.task, t.state, t.notes])));
    assert.deepEqual(r.tasks.map((t) => t.task).sort(), ['@fx/app:build', '@fx/app:test', '@fx/core:build']);
    // app:build still orders after core:build (through util, which has no build).
    const app = r.tasks.findIndex((t) => t.task === '@fx/app:build');
    assert.ok(r.tasks.findIndex((t) => t.task === '@fx/core:build') < app);
    await fs.writeFile(path.join(dir, 'packages/core/src/index.js'), 'export const core = 5;\n');
    assert.deepEqual(only(await run(dir), 'succeeded'), ['@fx/app:build', '@fx/app:test', '@fx/core:build']);
  } finally { await rm(dir); }
});

test('config validation: scope, packages, cwd and ^ dependencies', () => {
  const t = (tasks: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({ version: 1, project: { name: 'p' }, tasks, ...extra });
  assert.throws(() => validateConfig(t({ a: { command: 'x', scope: 'galaxy' } })), /scope: must be "root" or "packages"/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', packages: ['a'] } })), /packages: only valid together with scope/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', scope: 'packages', cwd: 'sub' } })), /cwd: not allowed with scope "packages"/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', dependsOn: ['^b'] }, b: { command: 'x', scope: 'packages' } })), /only valid on tasks with scope "packages"/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', scope: 'packages', dependsOn: ['^b'] }, b: { command: 'x' } })), /does not have scope "packages"/);
  assert.throws(() => validateConfig(t({ a: { command: 'x', scope: 'packages', dependsOn: ['^zzz'] } })), /unknown task "zzz"/);
  assert.throws(() => validateConfig(t({ a: { command: 'x' } }, { workspaces: 'yes' })), /workspaces/);
  // "^a" on a itself is a package-graph question, not a task-name cycle.
  const ok = validateConfig(t({ a: { command: 'x', scope: 'packages', dependsOn: ['^a'] } }, { workspaces: ['pkgs/*', '!pkgs/skip'] }));
  assert.equal(ok.tasks.a!.scope, 'packages');
  assert.deepEqual(ok.workspaces, ['pkgs/*', '!pkgs/skip']);
});

test('scope "packages" without a workspace is a clear config error', async () => {
  const dir = await tmpProject({
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'x' }, tasks: { build: { command: 'node -v', scope: 'packages' } } }),
    'package.json': '{"name":"x"}',
  });
  try {
    await assert.rejects(Project.open(dir), /tasks\.build\.scope is "packages" but no workspace was found/);
  } finally { await rm(dir); }
});

test('pnpm-workspace.yaml: block and flow lists, quotes, comments, negation, nested globs', async () => {
  assert.deepEqual(parsePnpmWorkspaceYaml("packages:\n  - 'apps/*'\n  - \"libs/**\"   # all libs\n  - !libs/legacy\n  # comment\n  - tools/cli\ncatalog:\n  - nope\n"), ['apps/*', 'libs/**', '!libs/legacy', 'tools/cli']);
  assert.deepEqual(parsePnpmWorkspaceYaml("packages: ['a/*', \"b\"]\r\nother: 1\r\n"), ['a/*', 'b']);
  assert.deepEqual(parsePnpmWorkspaceYaml('packages:\n- a\n- b\n'), ['a', 'b']);
  assert.deepEqual(parsePnpmWorkspaceYaml('name: x\n'), []);

  const dir = await tmpProject({
    'pnpm-workspace.yaml': "packages:\n  - 'apps/*'\n  - 'libs/**'\n  - '!libs/legacy'\n",
    'package.json': '{"name":"root"}',
    'pnpm-lock.yaml': 'lockfileVersion: 9\n',
    'apps/web/package.json': '{"name":"web","version":"2.0.0","dependencies":{"ui":"workspace:^","react":"^18"}}',
    'libs/ui/package.json': '{"name":"ui","version":"1.2.3"}',
    'libs/deep/er/package.json': '{"name":"deeper"}',
    'libs/legacy/package.json': '{"name":"legacy"}',
    'libs/noname/package.json': '{"version":"1.0.0"}',
    'apps/web/node_modules/ghost/package.json': '{"name":"ghost"}',
  });
  try {
    const ws = (await discoverWorkspaces(dir))!;
    assert.equal(ws.manager, 'pnpm');
    assert.equal(ws.source, 'pnpm-workspace.yaml');
    assert.deepEqual(ws.packages.map((p) => [p.name, p.dir, p.version]), [['web', 'apps/web', '2.0.0'], ['deeper', 'libs/deep/er', null], ['ui', 'libs/ui', '1.2.3']]);
    assert.deepEqual(ws.get('web')!.workspaceDeps, ['ui']);
    assert.deepEqual(ws.dependentsOf('ui'), ['web']);
    assert.equal(ws.warnings.length, 1);
    assert.equal(await discoverWorkspaces(dir, false), null);
  } finally { await rm(dir); }
});

test('package.json workspaces: array and object form; duplicate names are rejected', async () => {
  const dir = await tmpProject({
    'package.json': JSON.stringify({ name: 'root', workspaces: { packages: ['pkgs/*'] } }),
    'yarn.lock': '',
    'pkgs/a/package.json': '{"name":"a","devDependencies":{"b":"*"}}',
    'pkgs/b/package.json': '{"name":"b"}',
  });
  try {
    const ws = (await discoverWorkspaces(dir))!;
    assert.equal(ws.manager, 'yarn');
    assert.deepEqual(ws.get('a')!.workspaceDeps, ['b']);
    await writeFiles(dir, { 'pkgs/c/package.json': '{"name":"a"}' });
    await assert.rejects(discoverWorkspaces(dir), /duplicate package name "a" in pkgs\/a and pkgs\/c/);
    // Explicit globs in buildrush.json override detection.
    const explicit = (await discoverWorkspaces(dir, ['pkgs/b']))!;
    assert.deepEqual(explicit.packages.map((p) => p.name), ['b']);
  } finally { await rm(dir); }
});

test('workspace imports resolve through package.json exports/main onto sources (dist -> src)', async () => {
  const dir = await tmpProject({
    'buildrush.json': JSON.stringify({ version: 1, project: { name: 'x' }, tasks: { t: { command: 'node -v' } } }),
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'packages/lib/package.json': JSON.stringify({
      name: '@w/lib', version: '1.0.0',
      exports: { '.': { types: './dist/index.d.ts', import: './dist/index.js' }, './feature': './dist/feature.js', './utils/*': './dist/utils/*.js' },
    }),
    'packages/lib/src/index.ts': 'export const a = 1;\n',
    'packages/lib/src/feature.ts': 'export const f = 1;\n',
    'packages/lib/src/utils/str.ts': 'export const s = 1;\n',
    'packages/main/package.json': JSON.stringify({ name: '@w/main', version: '1.0.0', main: './lib/entry.cjs' }),
    'packages/main/lib/entry.cjs': 'module.exports = 1;\n',
    'packages/consumer/package.json': JSON.stringify({ name: '@w/consumer', version: '1.0.0', dependencies: { '@w/lib': '*', '@w/main': '*' } }),
    'packages/consumer/src/a.ts': "import { a } from '@w/lib';\nimport { f } from '@w/lib/feature';\nimport { s } from '@w/lib/utils/str';\nconst m = require('@w/main');\nexport { a, f, s, m };\n",
  });
  try {
    const p = await Project.open(dir);
    const g = await p.graph();
    const deps = [...(g.deps.get('packages/consumer/src/a.ts')?.keys() ?? [])].sort();
    assert.deepEqual(deps, ['packages/lib/src/feature.ts', 'packages/lib/src/index.ts', 'packages/lib/src/utils/str.ts', 'packages/main/lib/entry.cjs']);
    assert.equal(g.modules.get('packages/consumer/src/a.ts')!.uncertain.length, 0);
    assert.deepEqual([...g.packageEdges().get('@w/consumer')!].sort(), ['@w/lib', '@w/main']);
    // A change deep in lib reaches the consumer's module and so the consumer package.
    const sel = selectPackages(p.workspace!, g, null, ['packages/lib/src/utils/str.ts']);
    assert.deepEqual(sel.affected, ['@w/consumer', '@w/lib']);
    assert.deepEqual(sel.skipped, ['@w/main']);
  } finally { await rm(dir); }
});

test('a trailing "/**" pattern also matches the directory itself (pnpm: "docs/**" includes docs/package.json)', async () => {
  const dir = await tmpProject({
    'pnpm-workspace.yaml': "packages:\n  - 'packages/*'\n  - 'docs/**'\n  - '!**/test/**'\n",
    'package.json': '{"name":"root"}',
    'packages/a/package.json': '{"name":"a"}',
    'docs/package.json': '{"name":"docs-site"}',
    'docs/demos/x/package.json': '{"name":"demo-x"}',
    'packages/a/test/fixture/package.json': '{"name":"fixture"}',
    'packages/a/test/package.json': '{"name":"test-dir-itself"}',
  });
  try {
    const ws = (await discoverWorkspaces(dir))!;
    assert.deepEqual(ws.packages.map((p) => p.name), ['docs-site', 'demo-x', 'a']);
  } finally { await rm(dir); }
});

test('peerDependencies on workspace packages are ordering edges, unless they would close a cycle', async () => {
  const dir = await tmpProject({
    'package.json': JSON.stringify({ name: 'root', workspaces: ['packages/*'] }),
    'packages/core/package.json': '{"name":"@p/core"}',
    'packages/ui/package.json': '{"name":"@p/ui","dependencies":{"@p/core":"workspace:^"}}',
    'packages/utils/package.json': '{"name":"@p/utils","dependencies":{"@p/core":"workspace:^"},"peerDependencies":{"@p/ui":"workspace:*","react":"^18"}}',
    'packages/host/package.json': '{"name":"@p/host","devDependencies":{"@p/plugin":"workspace:*"}}',
    'packages/plugin/package.json': '{"name":"@p/plugin","peerDependencies":{"@p/host":"workspace:*"}}',
  });
  try {
    const ws = (await discoverWorkspaces(dir))!;
    assert.deepEqual(ws.get('@p/utils')!.workspaceDeps, ['@p/core', '@p/ui']);
    assert.deepEqual(ws.transitiveDeps('@p/utils'), ['@p/core', '@p/ui']);
    assert.deepEqual(ws.dependentsOf('@p/ui'), ['@p/utils']);
    // host -> plugin is declared; plugin's peer on host would make a cycle, so it is dropped (with a warning).
    assert.deepEqual(ws.get('@p/host')!.workspaceDeps, ['@p/plugin']);
    assert.deepEqual(ws.get('@p/plugin')!.workspaceDeps, []);
    assert.equal(ws.findCycle(), null);
    assert.ok(ws.warnings.some((w) => /plugin\/package\.json.*peerDependency "@p\/host"/.test(w)), ws.warnings.join('|'));
  } finally { await rm(dir); }
});

test('CLI: analyze and graph show packages and package edges', async () => {
  const dir = await tmpProject(monorepo());
  try {
    const a = cli(dir, 'analyze', '--json');
    assert.equal(a.status, 0, a.stderr);
    const info = JSON.parse(a.stdout);
    assert.equal(info.workspace.manager, 'npm');
    assert.deepEqual(info.workspace.packages.map((x: { name: string }) => x.name), ['@fx/app', '@fx/core', '@fx/docs', '@fx/util']);
    assert.deepEqual(info.workspace.packages.find((x: { name: string }) => x.name === '@fx/app').dependsOn, ['@fx/util']);
    assert.deepEqual(info.workspace.importEdges['@fx/util'], ['@fx/core']);
    assert.ok(info.tasks['@fx/core:build'] && !info.tasks.build);
    const human = cli(dir, 'analyze');
    assert.match(human.stdout, /workspace\s+: npm \(package\.json\), 4 package\(s\)/);
    assert.match(human.stdout, /@fx\/app@1\.0\.0\s+packages\/app\s+-> @fx\/util/);
    const g = cli(dir, 'graph', '--packages');
    assert.equal(g.status, 0, g.stderr);
    const edges = JSON.parse(g.stdout).edges.map((e: { from: string; to: string }) => `${e.from}>${e.to}`).sort();
    assert.deepEqual(edges, ['@fx/app>@fx/util', '@fx/util>@fx/core']);
    assert.match(cli(dir, 'graph', '--packages', '--dot').stdout, /digraph packages/);
    assert.ok(JSON.parse(cli(dir, 'graph').stdout).workspace.packages.length === 4);
    const ex = cli(dir, 'explain', 'packages/core/src/index.js', '--json');
    assert.equal(JSON.parse(ex.stdout).package, '@fx/core');
    const bad = cli(dir, 'run', 'nonesuch');
    assert.equal(bad.status, 2);
    assert.match(bad.stderr, /per-package tasks: build, test/);
  } finally { await rm(dir); }
});
