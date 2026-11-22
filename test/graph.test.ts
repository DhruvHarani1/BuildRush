import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { scanSource, DepGraph, parseJsonc } from '../src/graph.js';
import { Project } from '../src/project.js';
import { selectTests } from '../src/affected.js';
import { rm, tmpProject, writeFiles } from './helpers.js';

const cfg = (extra = {}) => JSON.stringify({ version: 1, project: { name: 'g' }, tasks: { t: { command: 'node -v' } }, ...extra });

test('scanSource finds static, re-export, dynamic and require specifiers; flags non-literal loads', () => {
  const r = scanSource(`
    import a from './a'; import type { T } from "./types";
    import './side-effect.css';
    export * from './re'; export { x } from './re2';
    const m = await import('./lazy'); const c = require('./cjs');
    const dyn = import(name); const r2 = require(path);
    const g = import.meta.glob('./x/*.ts');
  `);
  const specs = r.specs.map((s) => s.spec).sort();
  assert.deepEqual(specs, ['./a', './cjs', './lazy', './re', './re2', './side-effect.css', './types']);
  assert.equal(r.uncertain.length, 3);
});

test('parseJsonc handles comments and trailing commas', () => {
  assert.deepEqual(parseJsonc('{ // c\n "a": [1,2,], /* x */ "b": "//not a comment", }'), { a: [1, 2], b: '//not a comment' });
});

test('graph: resolution, tsconfig paths, barrels, workspaces, reverse impact with chains', async () => {
  const dir = await tmpProject({
    'buildrush.json': cfg(),
    'tsconfig.json': '{ // comment\n "compilerOptions": { "baseUrl": ".", "paths": { "@lib/*": ["packages/lib/src/*"] } } }',
    'package.json': '{"name":"root"}',
    'packages/lib/package.json': '{"name":"@acme/lib"}',
    'packages/lib/src/index.ts': "export * from './util';\n",
    'packages/lib/src/util.ts': 'export const u = 1;\n',
    'packages/lib/src/other.ts': 'export const o = 1;\n',
    'src/app.ts': "import { u } from '@acme/lib';\nimport { o } from '@lib/other';\nimport fs from 'node:fs'; import React from 'react';\n",
    'src/app.test.ts': "import './app.js';\n",
    'src/unrelated.ts': 'export const z = 1;\n',
    'src/unrelated.test.ts': "import './unrelated';\n",
  });
  try {
    const p = await Project.open(dir);
    const g = await p.graph();
    assert.ok(g.deps.get('src/app.ts')!.has('packages/lib/src/index.ts'), 'workspace package import');
    assert.ok(g.deps.get('src/app.ts')!.has('packages/lib/src/other.ts'), 'tsconfig paths');
    assert.ok(g.deps.get('src/app.test.ts')!.has('src/app.ts'), './app.js -> app.ts');
    assert.deepEqual([...g.externals.get('src/app.ts')!].sort(), ['node:fs', 'react']);
    const { reached, conservative } = g.impact(['packages/lib/src/util.ts']);
    assert.equal(conservative, null);
    assert.deepEqual(g.chain(reached, 'src/app.test.ts'), ['src/app.test.ts', 'src/app.ts', 'packages/lib/src/index.ts', 'packages/lib/src/util.ts']);
    const sel = selectTests(g, null, ['packages/lib/src/util.ts']);
    assert.deepEqual(sel.selected, ['src/app.test.ts']);
    assert.deepEqual(sel.skipped.map((s) => s.test), ['src/unrelated.test.ts']);
  } finally { await rm(dir); }
});

test('conservative: global config change, uncertain modules and unresolved test imports select tests', async () => {
  const dir = await tmpProject({
    'buildrush.json': cfg(),
    'src/dyn.ts': 'export const load = (n: string) => import(n);\n',
    'src/dyn.test.ts': "import './dyn';\n",
    'src/plain.ts': 'export const p = 1;\n',
    'src/plain.test.ts': "import './plain';\n",
    'src/weird.test.ts': "import './does-not-exist';\n",
  });
  try {
    const p = await Project.open(dir);
    const g = await p.graph();
    const all = g.testFiles();
    assert.equal(selectTests(g, null, ['package.json']).mode, 'all', 'package.json is global');
    assert.equal(selectTests(g, null, ['vitest.config.ts']).mode, 'all');
    const dyn = selectTests(g, null, ['src/dyn.ts']);
    assert.equal(dyn.mode, 'all');
    assert.match(dyn.reason!, /uncertain/);
    const plain = selectTests(g, null, ['src/plain.ts']);
    assert.equal(plain.mode, 'affected');
    assert.deepEqual(plain.selected, ['src/plain.test.ts', 'src/weird.test.ts'], 'unresolvable test always runs');
    assert.equal(all.length, 3);
    assert.deepEqual(selectTests(g, null, []).selected, []);
  } finally { await rm(dir); }
});

test('deleted files expand through the PREVIOUS graph', async () => {
  const dir = await tmpProject({
    'buildrush.json': cfg(),
    'src/gone.ts': 'export const g = 1;\n',
    'src/user.ts': "import { g } from './gone';\nexport const u = g;\n",
    'src/user.test.ts': "import './user';\n",
    'src/other.test.ts': 'export {};\n',
  });
  try {
    const before = await (await Project.open(dir)).graph();
    await fs.rm(path.join(dir, 'src/gone.ts'));
    const after = await (await Project.open(dir)).graph();
    const sel = selectTests(after, DepGraph.deserialize(before.serialize()), ['src/gone.ts']);
    assert.ok(sel.selected.includes('src/user.test.ts'), 'importer of deleted file must be re-tested');
    assert.ok(!sel.selected.includes('src/other.test.ts'));
  } finally { await rm(dir); }
});

test('import cycles are reported', async () => {
  const dir = await tmpProject({
    'buildrush.json': cfg(),
    'src/x.ts': "import './y';\n", 'src/y.ts': "import './x';\n", 'src/z.ts': 'export {};\n',
  });
  try {
    const g = await (await Project.open(dir)).graph();
    assert.deepEqual(g.cycles(), [['src/x.ts', 'src/y.ts']]);
  } finally { await rm(dir); }
});

test('index detects content changes even when mtime is preserved', async () => {
  const dir = await tmpProject({ 'buildrush.json': cfg(), 'src/f.ts': 'aaaa' });
  try {
    const p = await Project.open(dir);
    const before = p.index.files.get('src/f.ts')!.digest;
    const file = path.join(dir, 'src/f.ts');
    const st = await fs.stat(file);
    await fs.writeFile(file, 'bbbb'); // same size
    await fs.utimes(file, st.atime, st.mtime); // restore mtime
    const diff = await p.index.scan();
    assert.deepEqual(diff.modified, ['src/f.ts']);
    assert.notEqual(p.index.files.get('src/f.ts')!.digest, before);
  } finally { await rm(dir); }
});

test('symlinks are never followed or indexed', async () => {
  const dir = await tmpProject({ 'buildrush.json': cfg(), 'src/real.ts': 'x' });
  const outside = await tmpProject({ 'secret.txt': 'top secret' });
  try {
    await fs.symlink(path.join(outside, 'secret.txt'), path.join(dir, 'src/link.txt'));
    await fs.symlink(outside, path.join(dir, 'src/linkdir'));
    const p = await Project.open(dir);
    assert.ok(![...p.index.files.keys()].some((k) => k.includes('link') || k.includes('secret')));
    assert.equal(p.index.skippedSymlinks.length, 2);
  } finally { await rm(dir); await rm(outside); }
});
