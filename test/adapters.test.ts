import { test } from 'node:test';
import assert from 'node:assert/strict';
import { diagnostics } from '../src/adapters.js';
import { Project } from '../src/project.js';
import { runTasks } from '../src/engine.js';
import { rm, tmpProject } from './helpers.js';

const cfg = (tasks: object) => JSON.stringify({ version: 1, project: { name: 'a' }, tasks });
const open = async (files: Record<string, string>, tasks: object) => {
  const dir = await tmpProject({ 'buildrush.json': cfg(tasks), 'package.json': '{}', ...files });
  return { dir, p: await Project.open(dir) };
};

test('vite adapter: sane defaults incl. hidden inputs (.env*, VITE_* env) and outDir', async () => {
  const { dir, p } = await open({ 'vite.config.ts': 'export default {}' }, { build: { adapter: 'vite' } });
  try {
    const t = p.config.tasks.build!;
    assert.deepEqual(t.command, ['vite', 'build']);
    assert.equal(t.kind, 'build');
    assert.deepEqual(t.outputs, ['dist/**']);
    assert.ok(t.inputs!.includes('.env.*') && t.inputs!.includes('vite.config.ts') && t.inputs!.includes('package-lock.json'));
    assert.deepEqual(t.envPrefixes, ['VITE_']);
    assert.ok(t.env.includes('NODE_ENV'));
  } finally { await rm(dir); }
});

test('vite adapter: literal outDir is honoured; computed outDir disables caching instead of guessing', async () => {
  const lit = await open({ 'vite.config.ts': "export default { build: { outDir: 'build/web' } }" }, { build: { adapter: 'vite' } });
  const dyn = await open({ 'vite.config.ts': 'export default { build: { outDir: process.env.OUT } }' }, { build: { adapter: 'vite' } });
  const explicit = await open({ 'vite.config.ts': 'export default { build: { outDir: process.env.OUT } }' }, { build: { adapter: 'vite', outputs: ['out/**'] } });
  try {
    assert.deepEqual(lit.p.config.tasks.build!.outputs, ['build/web/**']);
    assert.equal(dyn.p.config.tasks.build!.cache, false);
    assert.match(dyn.p.config.tasks.build!.notes.join(' '), /outDir/);
    assert.equal(explicit.p.config.tasks.build!.cache, true, 'user-declared outputs resolve the ambiguity');
  } finally { await rm(lit.dir); await rm(dyn.dir); await rm(explicit.dir); }
});

test('vite adapter: configs that reach outside src widen inputs to the whole project (correctness over speed)', async () => {
  const { dir, p } = await open({ 'vite.config.ts': "export default { publicDir: '../shared/public' }" }, { build: { adapter: 'vite' } });
  try {
    assert.equal(p.config.tasks.build!.inputs, null);
    assert.match(p.config.tasks.build!.notes.join(' '), /whole project/);
  } finally { await rm(dir); }
});

test('vite adapter refuses dev/preview servers', async () => {
  const dir = await tmpProject({ 'buildrush.json': cfg({ dev: { adapter: 'vite', command: 'vite preview' } }) });
  try {
    await assert.rejects(Project.open(dir), /only supports "vite build"/);
  } finally { await rm(dir); }
});

test('vitest adapter: coverage enabled in the config (not on the command line) is an output too', async () => {
  const on = await open({ 'vitest.config.ts': "export default { test: { coverage: { enabled: true, provider: 'istanbul' } } }" }, { t: { adapter: 'vitest' } });
  const custom = await open({ 'vitest.config.ts': "export default { test: { coverage: { enabled: true, reportsDirectory: './out/cov' } } }" }, { t: { adapter: 'vitest' } });
  const dyn = await open({ 'vitest.config.ts': 'export default { test: { coverage: { enabled: true, reportsDirectory: process.env.COV } } }' }, { t: { adapter: 'vitest' } });
  const off = await open({ 'vitest.config.ts': "export default { test: { coverage: { provider: 'v8' } } }" }, { t: { adapter: 'vitest' } });
  try {
    assert.deepEqual(on.p.config.tasks.t!.outputs, ['coverage/**']);
    assert.deepEqual(custom.p.config.tasks.t!.outputs, ['out/cov/**']);
    assert.equal(dyn.p.config.tasks.t!.cache, false);
    assert.match(dyn.p.config.tasks.t!.notes.join(' '), /reportsDirectory/);
    assert.deepEqual(off.p.config.tasks.t!.outputs, []);
  } finally { for (const x of [on, custom, dyn, off]) await rm(x.dir); }
});

test('vitest adapter: forces single-shot run, refuses watch/ui, captures coverage output', async () => {
  const a = await open({}, { t: { adapter: 'vitest', command: 'vitest --coverage' } });
  const bare = await open({}, { t: { adapter: 'vitest' } });
  try {
    assert.deepEqual(bare.p.config.tasks.t!.command, ['vitest', 'run']);
    assert.equal(bare.p.config.tasks.t!.kind, 'test');
    assert.equal(bare.p.config.tasks.t!.affected, true);
    assert.deepEqual(a.p.config.tasks.t!.command.slice(0, 2), ['vitest', 'run']);
    assert.deepEqual(a.p.config.tasks.t!.outputs, ['coverage/**']);
    for (const bad of ['vitest watch', 'vitest --watch', 'vitest --ui']) {
      const dir = await tmpProject({ 'buildrush.json': cfg({ t: { adapter: 'vitest', command: bad } }) });
      await assert.rejects(Project.open(dir), /single-shot/, bad);
      await rm(dir);
    }
  } finally { await rm(a.dir); await rm(bare.dir); }
});

test('vitest adapter: custom include/setupFiles widens inputs', async () => {
  const { dir, p } = await open({ 'vitest.config.ts': "export default { test: { setupFiles: ['../shared/setup.ts'] } }" }, { t: { adapter: 'vitest' } });
  try { assert.equal(p.config.tasks.t!.inputs, null); } finally { await rm(dir); }
});

test('tsc adapter: --noEmit has no outputs; emitting without outDir is not cached', async () => {
  const check = await open({ 'tsconfig.json': '{"compilerOptions":{"noEmit":true}}' }, { c: { adapter: 'tsc' } });
  const emit = await open({ 'tsconfig.json': '{"compilerOptions":{}}' }, { c: { adapter: 'tsc', command: 'tsc -p tsconfig.json' } });
  const emitOut = await open({ 'tsconfig.json': '{ // c\n "compilerOptions":{"outDir":"./lib"}}' }, { c: { adapter: 'tsc', command: 'tsc -p tsconfig.json' } });
  try {
    assert.deepEqual(check.p.config.tasks.c!.outputs, []);
    assert.equal(emit.p.config.tasks.c!.cache, false);
    assert.deepEqual(emitOut.p.config.tasks.c!.outputs, ['lib/**']);
  } finally { await rm(check.dir); await rm(emit.dir); await rm(emitOut.dir); }
});

test('explicit user config always wins over adapter defaults', async () => {
  const { dir, p } = await open({}, { b: { adapter: 'vite', inputs: ['src/**'], outputs: ['out/**'], command: ['vite', 'build', '--mode', 'staging'] } });
  try {
    const t = p.config.tasks.b!;
    assert.deepEqual(t.inputs, ['src/**']);
    assert.deepEqual(t.outputs, ['out/**']);
    assert.deepEqual(t.command, ['vite', 'build', '--mode', 'staging']);
  } finally { await rm(dir); }
});

test('VITE_* env vars are fingerprinted: changing one invalidates, naming the variable', async () => {
  const dir = await tmpProject({
    'buildrush.json': cfg({ b: { adapter: 'vite', command: ['node', 'build.js'], inputs: ['build.js'], outputs: ['dist/**'] } }),
    'package.json': '{"type":"module"}',
    'build.js': "import fs from 'node:fs'; fs.mkdirSync('dist',{recursive:true}); fs.writeFileSync('dist/o.txt', process.env.VITE_API ?? 'none');\n",
  });
  const saved = process.env.VITE_API;
  try {
    // Re-open per run: env prefixes are resolved against the live environment.
    const go = async () => (await runTasks(await Project.open(dir), ['b'])).tasks[0]!;
    delete process.env.VITE_API;
    assert.equal((await go()).state, 'succeeded');
    assert.equal((await go()).state, 'cached');
    process.env.VITE_API = 'https://a.example';
    const r = await go();
    assert.equal(r.state, 'succeeded');
    assert.ok(r.reasons.includes('environment variable VITE_API changed'), r.reasons.join('|'));
    assert.equal((await go()).state, 'cached');
    process.env.VITE_API = 'https://b.example';
    assert.equal((await go()).state, 'succeeded');
  } finally { if (saved === undefined) delete process.env.VITE_API; else process.env.VITE_API = saved; await rm(dir); }
});

test('diagnostics extract concise failures', () => {
  assert.deepEqual(diagnostics('vitest', ' FAIL  src/a.test.ts > adds\n ❯ src/b.spec.tsx (2 tests | 1 failed)\n'), ['failed test file: src/a.test.ts', 'failed test file: src/b.spec.tsx']);
  assert.deepEqual(diagnostics('tsc', "src/x.ts(3,7): error TS2322: Type 'a' is not assignable.\n"), ["src/x.ts:3:7 TS2322 Type 'a' is not assignable."]);
  assert.deepEqual(diagnostics(null, 'whatever'), []);
});
