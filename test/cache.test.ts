import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Cache, ActionRecord, CacheCorruptError, Components } from '../src/cache.js';
import { hashFile, sha256 } from '../src/util/hash.js';
import { UnsafePathError } from '../src/util/paths.js';
import { rm, tmpProject } from './helpers.js';

const comps: Components = { schema: 1, task: 't', command: ['x'], cwd: '.', env: {}, toolchain: {}, inputs: {}, deps: {}, outputs: [], args: [] };

async function setup() {
  const root = await tmpProject({ 'dist/a.txt': 'hello', 'dist/sub/b.txt': 'world' });
  const cacheDir = await tmpProject({});
  const cache = new Cache(path.join(cacheDir, 'c'));
  await cache.init();
  const outputs = [];
  for (const p of ['dist/a.txt', 'dist/sub/b.txt']) {
    const abs = path.join(root, p);
    outputs.push({ path: p, digest: await hashFile(abs), size: (await fs.stat(abs)).size, mode: 0o644 });
  }
  const key = sha256('key1');
  const rec: ActionRecord = { v: 1, key, task: 't', createdAt: 1, durationMs: 5, outputs, logDigest: null, components: comps };
  return { root, cacheDir, cache, rec, key, cleanup: async () => { await rm(root); await rm(cacheDir); } };
}

test('store -> lookup -> restore round trip, cache dir is private', async () => {
  const s = await setup();
  try {
    await s.cache.store(s.rec, s.root);
    if (process.platform !== 'win32') assert.equal((await fs.stat(s.cache.dir)).mode & 0o777, 0o700);
    await fs.rm(path.join(s.root, 'dist'), { recursive: true });
    const rec = await s.cache.lookup(s.key);
    assert.ok(rec);
    const r = await s.cache.restore(rec, s.root);
    assert.equal(r.files, 2);
    assert.equal(await fs.readFile(path.join(s.root, 'dist/sub/b.txt'), 'utf8'), 'world');
  } finally { await s.cleanup(); }
});

test('corrupt blob is detected; NOTHING is half-restored; verify --repair removes it', async () => {
  const s = await setup();
  try {
    await s.cache.store(s.rec, s.root);
    await fs.rm(path.join(s.root, 'dist'), { recursive: true });
    const victim = s.cache.blobPath(s.rec.outputs[1]!.digest);
    await fs.chmod(victim, 0o600);
    await fs.writeFile(victim, 'tampered');
    await assert.rejects(s.cache.restore(s.rec, s.root), CacheCorruptError);
    await assert.rejects(fs.access(path.join(s.root, 'dist/a.txt')), 'good file must not be written when another blob is bad');
    const v = await s.cache.verify();
    assert.equal(v.corruptBlobs.length, 1);
    const fixed = await s.cache.verify({ repair: true });
    assert.ok(fixed.repaired >= 1);
    assert.equal(await s.cache.lookup(s.key), null, 'entry referencing a deleted corrupt blob must be removed by repair');
    const after = await s.cache.verify();
    assert.equal(after.corruptBlobs.length + after.badEntries.length + after.missingBlobs.length, 0);
  } finally { await s.cleanup(); }
});

test('malicious manifests are rejected (traversal, absolute, backslash, bad digest)', async () => {
  const s = await setup();
  try {
    await s.cache.store(s.rec, s.root);
    const good = s.rec.outputs[0]!;
    for (const evil of ['../escape.txt', '/tmp/abs.txt', 'a/../../up.txt', 'dist\\x']) {
      const rec = { ...s.rec, key: sha256('evil' + evil), outputs: [{ ...good, path: evil }] };
      await fs.writeFile(path.join(s.cache.dir, 'actions', rec.key + '.json'), JSON.stringify(rec));
      assert.equal(await s.cache.lookup(rec.key), null, `lookup must reject ${evil}`);
      await assert.rejects(s.cache.restore(rec, s.root), UnsafePathError, `restore must reject ${evil}`);
    }
    const bad = { ...s.rec, key: sha256('bad'), outputs: [{ ...good, digest: '../../etc/passwd' }] };
    await fs.writeFile(path.join(s.cache.dir, 'actions', bad.key + '.json'), JSON.stringify(bad));
    assert.equal(await s.cache.lookup(bad.key), null);
  } finally { await s.cleanup(); }
});

test('restore refuses to write through symlinks (cannot be used to clobber files elsewhere)', { skip: process.platform === 'win32' }, async () => {
  const s = await setup();
  const outside = await tmpProject({ 'victim.txt': 'original' });
  try {
    await s.cache.store(s.rec, s.root);
    await fs.rm(path.join(s.root, 'dist'), { recursive: true });
    await fs.symlink(outside, path.join(s.root, 'dist'));
    await assert.rejects(s.cache.restore(s.rec, s.root), UnsafePathError);
    assert.deepEqual(await fs.readdir(outside), ['victim.txt'], 'nothing written outside the project');
    await fs.rm(path.join(s.root, 'dist'));
    await fs.mkdir(path.join(s.root, 'dist'));
    await fs.symlink(path.join(outside, 'victim.txt'), path.join(s.root, 'dist/a.txt'));
    await assert.rejects(s.cache.restore(s.rec, s.root), UnsafePathError);
    assert.equal(await fs.readFile(path.join(outside, 'victim.txt'), 'utf8'), 'original');
  } finally { await s.cleanup(); await rm(outside); }
});

test('setuid/setgid bits are never restored', { skip: process.platform === 'win32' }, async () => {
  const s = await setup();
  try {
    s.rec.outputs[0]!.mode = 0o4755;
    await s.cache.store(s.rec, s.root);
    await fs.rm(path.join(s.root, 'dist'), { recursive: true });
    await s.cache.restore(s.rec, s.root);
    assert.equal((await fs.stat(path.join(s.root, 'dist/a.txt'))).mode & 0o7777, 0o755);
  } finally { await s.cleanup(); }
});

test('concurrent stores of the same content are safe', async () => {
  const s = await setup();
  try {
    await Promise.all(Array.from({ length: 12 }, () => s.cache.store(s.rec, s.root)));
    const v = await s.cache.verify();
    assert.equal(v.corruptBlobs.length + v.badEntries.length + v.missingBlobs.length, 0);
    assert.equal(v.blobs, 2);
  } finally { await s.cleanup(); }
});

test('a file that changes between hashing and copying is never stored under the wrong digest', async () => {
  const s = await setup();
  try {
    await fs.writeFile(path.join(s.root, 'dist/a.txt'), 'changed after hashing');
    await assert.rejects(s.cache.store(s.rec, s.root), /changed while being cached/);
    await assert.rejects(fs.access(path.join(s.cache.dir, 'actions', s.key + '.json')), 'no entry may be committed');
  } finally { await s.cleanup(); }
});

test('gc evicts least recently used entries first and drops unreferenced blobs', async () => {
  const s = await setup();
  try {
    const mk = async (name: string, content: string, age: number) => {
      await fs.writeFile(path.join(s.root, name), content);
      const out = [{ path: name, digest: sha256(content), size: content.length, mode: 0o644 }];
      const rec: ActionRecord = { ...s.rec, key: sha256(name), outputs: out };
      await s.cache.store(rec, s.root);
      const t = new Date(Date.now() - age);
      await fs.utimes(path.join(s.cache.dir, 'actions', rec.key + '.json'), t, t);
      return rec.key;
    };
    const old = await mk('old.bin', 'x'.repeat(1000), 100_000);
    const fresh = await mk('new.bin', 'y'.repeat(1000), 1000);
    const r = await s.cache.gc(1200);
    assert.equal(r.evictedEntries, 1);
    assert.equal(await s.cache.lookup(old), null);
    assert.ok(await s.cache.lookup(fresh));
    assert.equal(r.removedBlobs, 1);
  } finally { await s.cleanup(); }
});
