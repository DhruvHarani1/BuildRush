import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { DIGEST_RE, hashFile, sha256 } from './util/hash.js';
import { assertNoSymlinkInPath, resolveInside, safeRelative, UnsafePathError } from './util/paths.js';
import { readJson, renameRetry, tmpName, writeFileAtomic } from './util/fsx.js';

export interface ManifestEntry {
  path: string;
  digest: string;
  size: number;
  /** Permission bits only (0o777 mask); setuid/setgid/sticky are never stored or restored. */
  mode: number;
}

/** Non-secret, digest-only description of every fingerprint input (used for miss explanations). */
export interface Components {
  schema: 1;
  task: string;
  command: string[];
  cwd: string;
  env: Record<string, string | null>;
  toolchain: Record<string, string | null>;
  inputs: Record<string, string>;
  deps: Record<string, string>;
  outputs: string[];
  args: string[];
}

export interface ActionRecord {
  v: 1;
  key: string;
  task: string;
  createdAt: number;
  durationMs: number;
  outputs: ManifestEntry[];
  logDigest: string | null;
  components: Components;
}

export interface CacheStats {
  dir: string;
  entries: number;
  blobs: number;
  bytes: number;
}

export interface VerifyReport {
  entries: number;
  blobs: number;
  corruptBlobs: string[];
  badEntries: string[];
  missingBlobs: { entry: string; digest: string }[];
  repaired: number;
}

const MAX_ENTRY_BYTES = 8 * 1024 * 1024;

export class Cache {
  constructor(readonly dir: string) {}

  private get blobs() { return path.join(this.dir, 'blobs'); }
  private get actions() { return path.join(this.dir, 'actions'); }
  private get tmp() { return path.join(this.dir, 'tmp'); }
  blobPath(digest: string) {
    if (!DIGEST_RE.test(digest)) throw new UnsafePathError(`bad digest ${JSON.stringify(digest)}`);
    return path.join(this.blobs, digest.slice(0, 2), digest);
  }

  async init(): Promise<void> {
    for (const d of [this.dir, this.blobs, this.actions, this.tmp]) {
      await fs.mkdir(d, { recursive: true, mode: 0o700 });
    }
    if (process.platform !== 'win32') await fs.chmod(this.dir, 0o700).catch(() => undefined);
  }

  /** Per-cache random key used for keyed digests of secret-like env values. */
  async secretKey(): Promise<Buffer> {
    const f = path.join(this.dir, 'secret.key');
    try {
      return Buffer.from(await fs.readFile(f, 'utf8'), 'hex');
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
    }
    const key = randomBytes(32);
    try {
      await fs.writeFile(f, key.toString('hex'), { mode: 0o600, flag: 'wx' });
      return key;
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'EEXIST') return Buffer.from(await fs.readFile(f, 'utf8'), 'hex');
      throw e;
    }
  }

  async putBlobFromFile(abs: string, digest: string): Promise<boolean> {
    const dest = this.blobPath(digest);
    try {
      await fs.access(dest);
      return false;
    } catch { /* not present */ }
    await fs.mkdir(path.dirname(dest), { recursive: true, mode: 0o700 });
    const tmp = tmpName(this.tmp);
    try {
      await fs.copyFile(abs, tmp);
      // The file may have changed between hashing and copying: never store mislabelled content.
      if ((await hashFile(tmp)) !== digest) throw new Error(`file changed while being cached: ${abs}`);
      await fs.chmod(tmp, 0o600);
      try {
        await renameRetry(tmp, dest);
      } catch (e) {
        // Content-addressed: if a concurrent writer already committed identical, verified content, we are done.
        if (!(await hashFile(dest).then((h) => h === digest, () => false))) throw e;
        await fs.rm(tmp, { force: true });
        return false;
      }
      return true;
    } catch (e) {
      await fs.rm(tmp, { force: true });
      throw e;
    }
  }

  async putBlobData(data: Uint8Array): Promise<string> {
    const digest = sha256(data);
    const dest = this.blobPath(digest);
    try {
      await fs.access(dest);
      return digest;
    } catch { /* not present */ }
    await writeFileAtomic(dest, data, 0o600);
    return digest;
  }

  async readBlob(digest: string): Promise<Buffer | null> {
    try {
      const data = await fs.readFile(this.blobPath(digest));
      return sha256(data) === digest ? data : null;
    } catch {
      return null;
    }
  }

  /** Returns null for missing OR structurally invalid entries (never throws on corruption). */
  async lookup(key: string): Promise<ActionRecord | null> {
    if (!DIGEST_RE.test(key)) return null;
    const file = path.join(this.actions, key + '.json');
    try {
      const st = await fs.stat(file);
      if (st.size > MAX_ENTRY_BYTES) return null;
    } catch {
      return null;
    }
    const rec = await readJson<ActionRecord>(file);
    if (!rec || !validRecord(rec) || rec.key !== key) return null;
    return rec;
  }

  async store(rec: ActionRecord, root: string): Promise<{ bytes: number }> {
    let bytes = 0;
    for (const o of rec.outputs) {
      if (await this.putBlobFromFile(resolveInside(root, o.path), o.digest)) bytes += o.size;
    }
    await writeFileAtomic(path.join(this.actions, rec.key + '.json'), JSON.stringify(rec));
    return { bytes };
  }

  async touch(key: string): Promise<void> {
    const f = path.join(this.actions, key + '.json');
    const now = new Date();
    await fs.utimes(f, now, now).catch(() => undefined);
  }

  /**
   * Restore outputs into `root`. All blobs are verified BEFORE the first file
   * is written, so a corrupt entry never produces a half-restored tree.
   * Each file is written to a temp name and renamed into place.
   */
  async restore(rec: ActionRecord, root: string): Promise<{ bytes: number; files: number }> {
    const planned: { rel: string; abs: string; entry: ManifestEntry }[] = [];
    for (const o of rec.outputs) {
      const rel = safeRelative(o.path);
      planned.push({ rel, abs: resolveInside(root, rel), entry: o });
      await assertNoSymlinkInPath(root, rel);
    }
    for (const p of planned) {
      let got: string;
      try {
        got = await hashFile(this.blobPath(p.entry.digest));
      } catch {
        throw new CacheCorruptError(`missing blob for ${p.rel}`);
      }
      if (got !== p.entry.digest) throw new CacheCorruptError(`blob digest mismatch for ${p.rel}`);
    }
    let bytes = 0;
    for (const p of planned) {
      await fs.mkdir(path.dirname(p.abs), { recursive: true });
      await assertNoSymlinkInPath(root, p.rel);
      const tmp = tmpName(path.dirname(p.abs));
      try {
        await fs.copyFile(this.blobPath(p.entry.digest), tmp);
        await fs.chmod(tmp, p.entry.mode & 0o777);
        await renameRetry(tmp, p.abs);
      } catch (e) {
        await fs.rm(tmp, { force: true });
        throw e;
      }
      bytes += p.entry.size;
    }
    return { bytes, files: planned.length };
  }

  async deleteEntry(key: string): Promise<void> {
    if (DIGEST_RE.test(key)) await fs.rm(path.join(this.actions, key + '.json'), { force: true });
  }

  private async listActions(): Promise<{ key: string; file: string; mtimeMs: number }[]> {
    let names: string[] = [];
    try {
      names = await fs.readdir(this.actions);
    } catch { /* empty */ }
    const out = [];
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const file = path.join(this.actions, n);
      try {
        out.push({ key: n.slice(0, -5), file, mtimeMs: (await fs.stat(file)).mtimeMs });
      } catch { /* raced with delete */ }
    }
    return out;
  }

  private async listBlobs(): Promise<{ digest: string; file: string; size: number }[]> {
    const out = [];
    let shards: string[] = [];
    try {
      shards = await fs.readdir(this.blobs);
    } catch { /* empty */ }
    for (const s of shards) {
      let names: string[] = [];
      try {
        names = await fs.readdir(path.join(this.blobs, s));
      } catch { continue; }
      for (const n of names) {
        if (!DIGEST_RE.test(n)) continue;
        const file = path.join(this.blobs, s, n);
        try {
          out.push({ digest: n, file, size: (await fs.stat(file)).size });
        } catch { /* raced */ }
      }
    }
    return out;
  }

  async stats(): Promise<CacheStats> {
    const [a, b] = await Promise.all([this.listActions(), this.listBlobs()]);
    return { dir: this.dir, entries: a.length, blobs: b.length, bytes: b.reduce((n, x) => n + x.size, 0) };
  }

  /** Re-hash every blob and check every entry's references. With `repair`, remove what is broken. */
  async verify(opts: { repair?: boolean } = {}): Promise<VerifyReport> {
    const rep: VerifyReport = { entries: 0, blobs: 0, corruptBlobs: [], badEntries: [], missingBlobs: [], repaired: 0 };
    const blobs = await this.listBlobs();
    const present = new Set<string>();
    for (const b of blobs) {
      rep.blobs++;
      if ((await hashFile(b.file).catch(() => '')) !== b.digest) {
        rep.corruptBlobs.push(b.digest);
        if (opts.repair) {
          await fs.rm(b.file, { force: true });
          rep.repaired++;
        }
      } else present.add(b.digest);
    }
    for (const a of await this.listActions()) {
      rep.entries++;
      const rec = await this.lookup(a.key);
      if (!rec) {
        rep.badEntries.push(a.key);
        if (opts.repair) {
          await fs.rm(a.file, { force: true });
          rep.repaired++;
        }
        continue;
      }
      const missing = rec.outputs.filter((o) => !present.has(o.digest));
      if (missing.length) {
        for (const m of missing) rep.missingBlobs.push({ entry: a.key, digest: m.digest });
        if (opts.repair) {
          await fs.rm(a.file, { force: true });
          rep.repaired++;
        }
      }
    }
    return rep;
  }

  /** Evict least-recently-used entries until blobs fit in maxBytes, then drop unreferenced blobs. */
  async gc(maxBytes: number): Promise<{ evictedEntries: number; removedBlobs: number; freedBytes: number }> {
    const lock = path.join(this.dir, 'gc.lock');
    try {
      await fs.mkdir(lock);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
      const st = await fs.stat(lock).catch(() => null);
      if (st && Date.now() - st.mtimeMs < 10 * 60_000) return { evictedEntries: 0, removedBlobs: 0, freedBytes: 0 };
      await fs.rm(lock, { recursive: true, force: true });
      await fs.mkdir(lock);
    }
    try {
      let evicted = 0;
      const actions = (await this.listActions()).sort((a, b) => a.mtimeMs - b.mtimeMs);
      const sizes = new Map((await this.listBlobs()).map((b) => [b.digest, b.size]));
      const refs = new Map<string, number>();
      const recs = new Map<string, ActionRecord | null>();
      for (const a of actions) {
        const rec = await this.lookup(a.key);
        recs.set(a.key, rec);
        for (const o of rec?.outputs ?? []) refs.set(o.digest, (refs.get(o.digest) ?? 0) + 1);
      }
      let total = 0;
      for (const [d, n] of refs) if (n > 0) total += sizes.get(d) ?? 0;
      for (const a of actions) {
        const rec = recs.get(a.key);
        if (!rec) {
          await fs.rm(a.file, { force: true });
          evicted++;
          continue;
        }
        if (total <= maxBytes) continue;
        await fs.rm(a.file, { force: true });
        evicted++;
        for (const o of rec.outputs) {
          const n = (refs.get(o.digest) ?? 1) - 1;
          refs.set(o.digest, n);
          if (n === 0) total -= sizes.get(o.digest) ?? 0;
        }
      }
      let removed = 0;
      let freed = 0;
      for (const b of await this.listBlobs()) {
        if ((refs.get(b.digest) ?? 0) <= 0) {
          await fs.rm(b.file, { force: true });
          removed++;
          freed += b.size;
        }
      }
      return { evictedEntries: evicted, removedBlobs: removed, freedBytes: freed };
    } finally {
      await fs.rm(lock, { recursive: true, force: true });
    }
  }

  async clean(): Promise<void> {
    await fs.rm(this.actions, { recursive: true, force: true });
    await fs.rm(this.blobs, { recursive: true, force: true });
    await this.init();
  }
}

export class CacheCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CacheCorruptError';
  }
}

function validRecord(r: ActionRecord): boolean {
  if (r.v !== 1 || typeof r.key !== 'string' || typeof r.task !== 'string') return false;
  if (!Array.isArray(r.outputs) || typeof r.components !== 'object' || r.components === null) return false;
  for (const o of r.outputs) {
    if (!o || typeof o.path !== 'string' || !DIGEST_RE.test(o.digest) || !Number.isInteger(o.size) || o.size < 0) return false;
    if (!Number.isInteger(o.mode)) return false;
    try {
      safeRelative(o.path);
    } catch {
      return false;
    }
  }
  return r.logDigest === null || (typeof r.logDigest === 'string' && DIGEST_RE.test(r.logDigest));
}
