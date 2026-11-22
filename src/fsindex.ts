import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { hashFile, mapLimit } from './util/hash.js';
import { compileGlobs } from './util/glob.js';
import { readJson, writeFileAtomic } from './util/fsx.js';

export interface FileEntry {
  size: number;
  mtimeMs: number;
  ctimeMs: number;
  ino: number;
  /** SHA-256 of content: the only value that ever feeds a cache key. */
  digest: string;
  /** When the digest was computed (ms). Used to reject "racy" metadata hints. */
  hashedAt: number;
}

interface Snapshot {
  version: 1;
  files: Record<string, FileEntry>;
}

export const BUILTIN_IGNORED_DIRS = new Set(['.git', 'node_modules', '.buildrush']);
/** A file modified this close to being hashed cannot be trusted by metadata alone. */
const RACY_WINDOW_MS = 2000;

export interface ScanDiff {
  added: string[];
  modified: string[];
  removed: string[];
}

export class FileIndex {
  files = new Map<string, FileEntry>();
  /** Symlinks are never followed or indexed (explicit policy); listed for diagnostics. */
  skippedSymlinks: string[] = [];
  private isIgnoredGlob: (rel: string) => boolean;

  constructor(
    readonly root: string,
    ignoreGlobs: string[],
    private statePath: string,
  ) {
    this.isIgnoredGlob = compileGlobs(ignoreGlobs);
  }

  isIgnored(rel: string, isDir: boolean): boolean {
    const base = rel.slice(rel.lastIndexOf('/') + 1);
    if (isDir && BUILTIN_IGNORED_DIRS.has(base)) return true;
    return this.isIgnoredGlob(rel) || (isDir && this.isIgnoredGlob(rel + '/'));
  }

  async load(): Promise<void> {
    const snap = await readJson<Snapshot>(this.statePath);
    if (snap && snap.version === 1) this.files = new Map(Object.entries(snap.files));
  }

  async save(): Promise<void> {
    const snap: Snapshot = { version: 1, files: Object.fromEntries(this.files) };
    await writeFileAtomic(this.statePath, JSON.stringify(snap));
  }

  /**
   * Reconcile the in-memory index with the filesystem. Content is re-hashed
   * unless size, mtime, ctime and inode are all unchanged AND the file was
   * already stable (not modified within the racy window) when last hashed.
   * `force` ignores all hints.
   */
  async scan(opts: { force?: boolean } = {}): Promise<ScanDiff> {
    const prev = this.files;
    const seen: { rel: string; st: import('node:fs').Stats }[] = [];
    this.skippedSymlinks = [];
    const walk = async (dirRel: string) => {
      const abs = dirRel ? path.join(this.root, dirRel) : this.root;
      let entries;
      try {
        entries = await fs.readdir(abs, { withFileTypes: true });
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'EACCES') return;
        throw e;
      }
      const subdirs: string[] = [];
      await Promise.all(
        entries.map(async (ent) => {
          const rel = dirRel ? `${dirRel}/${ent.name}` : ent.name;
          if (ent.isSymbolicLink()) {
            this.skippedSymlinks.push(rel);
            return;
          }
          if (ent.isDirectory()) {
            if (!this.isIgnored(rel, true)) subdirs.push(rel);
          } else if (ent.isFile()) {
            if (this.isIgnored(rel, false)) return;
            try {
              seen.push({ rel, st: await fs.lstat(path.join(this.root, rel)) });
            } catch (e) {
              if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e;
            }
          }
        }),
      );
      for (const d of subdirs.sort()) await walk(d);
    };
    await walk('');

    const next = new Map<string, FileEntry>();
    const scanStart = Date.now();
    await mapLimit(seen, 32, async ({ rel, st }) => {
      const old = prev.get(rel);
      if (
        !opts.force &&
        old &&
        old.size === st.size &&
        old.mtimeMs === st.mtimeMs &&
        old.ctimeMs === st.ctimeMs &&
        old.ino === st.ino &&
        st.mtimeMs < old.hashedAt - RACY_WINDOW_MS
      ) {
        next.set(rel, old);
        return;
      }
      let digest: string;
      try {
        digest = await hashFile(path.join(this.root, rel));
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === 'ENOENT') return; // vanished mid-scan
        throw e;
      }
      next.set(rel, { size: st.size, mtimeMs: st.mtimeMs, ctimeMs: st.ctimeMs, ino: st.ino, digest, hashedAt: scanStart });
    });

    const diff: ScanDiff = { added: [], modified: [], removed: [] };
    for (const [rel, e] of next) {
      const o = prev.get(rel);
      if (!o) diff.added.push(rel);
      else if (o.digest !== e.digest) diff.modified.push(rel);
    }
    for (const rel of prev.keys()) if (!next.has(rel)) diff.removed.push(rel);
    diff.added.sort();
    diff.modified.sort();
    diff.removed.sort();
    this.files = new Map([...next.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
    return diff;
  }
}
