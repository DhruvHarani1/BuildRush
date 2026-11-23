import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { canonical, sha256 } from './util/hash.js';
import { readJson, writeFileAtomic } from './util/fsx.js';

/**
 * Persistent STATE for `tsc --incremental --noEmit` (the .tsbuildinfo file).
 *
 * State is deliberately neither a fingerprint input nor a cached output:
 *   - cache keys stay a pure function of declared inputs (the state file is never hashed);
 *   - a cache hit never restores it, a cache miss may merely run faster because of it.
 * tsc validates the buildinfo against file hashes and compiler options itself; on top of that we
 * discard it whenever the tsc version, tsconfig content, command or Node/platform change, whenever
 * it is not valid JSON, and after ANY run that did not succeed. Writes go to a private work copy
 * that is atomically renamed over the committed file only after a successful run.
 */

/** Oldest TypeScript where we enable this: `--incremental` + `--noEmit` is supported since 4.0; 5.x is what we validate. */
const MIN_MAJOR = 5;

/** Flags that mean the user manages incremental/emit/watch behaviour themselves. */
const SELF_MANAGED_FLAGS = new Set([
  '-b', '--build', '-w', '--watch', '--incremental', '--composite', '--tsBuildInfoFile', '--generateTrace', '--listEmittedFiles',
]);

export function supportsTscIncremental(version: string | null): boolean {
  if (!version) return false;
  const m = /^(\d+)\.(\d+)/.exec(version);
  return !!m && Number(m[1]) >= MIN_MAJOR;
}

/** True when argv uses a mode that has its own incremental handling (-b, watch, explicit incremental flags). */
export function hasSelfManagedIncremental(argv: string[]): boolean {
  return argv.some((a) => SELF_MANAGED_FLAGS.has(a.split('=')[0]!));
}

export interface IncrementalRun {
  /** Extra argv for tsc (appended after the declared command; NOT part of the fingerprint). */
  args: string[];
  /** Human-readable explanation of what state was used (shown as a task note). */
  note: string;
  /** Commit the work copy on success; discard all state otherwise. Never throws. */
  finish(success: boolean): Promise<void>;
}

export interface IncrementalStamp {
  version: string;
  command: string[];
  args: string[];
  cwd: string;
  executable: string;
  /** Content digests of every tsconfig/jsconfig in the project (covers `extends`). */
  configs: Record<string, string>;
}

export function stampOf(s: IncrementalStamp): string {
  return sha256(canonical({ v: 1, node: process.version, platform: process.platform, arch: process.arch, ...s }));
}

interface Meta { v: 1; stamp: string }

const FILE = 'tsc.tsbuildinfo';
const META = 'meta.json';
const STALE_WORK_MS = 60 * 60 * 1000;

export function incrementalDir(stateDir: string, task: string): string {
  return path.join(stateDir, 'incremental', encodeURIComponent(task));
}

async function discard(dir: string): Promise<void> {
  await fs.rm(path.join(dir, META), { force: true }).catch(() => undefined);
  await fs.rm(path.join(dir, FILE), { force: true }).catch(() => undefined);
}

async function validJson(file: string): Promise<boolean> {
  try {
    const v: unknown = JSON.parse(await fs.readFile(file, 'utf8'));
    return typeof v === 'object' && v !== null && !Array.isArray(v);
  } catch {
    return false;
  }
}

export async function beginTscIncremental(stateDir: string, task: string, stamp: IncrementalStamp): Promise<IncrementalRun> {
  const dir = incrementalDir(stateDir, task);
  await fs.mkdir(dir, { recursive: true, mode: 0o700 });
  const cur = path.join(dir, FILE);
  const work = path.join(dir, `work-${process.pid}-${randomBytes(6).toString('hex')}.tsbuildinfo`);
  const want = stampOf(stamp);

  // Opportunistically remove work copies left behind by crashed runs.
  try {
    for (const e of await fs.readdir(dir)) {
      if (!e.startsWith('work-')) continue;
      const st = await fs.stat(path.join(dir, e)).catch(() => null);
      if (st && Date.now() - st.mtimeMs > STALE_WORK_MS) await fs.rm(path.join(dir, e), { force: true });
    }
  } catch { /* best effort */ }

  const meta = await readJson<Meta>(path.join(dir, META));
  let note: string;
  if (!meta || meta.v !== 1 || !(await fs.stat(cur).then((s) => s.isFile(), () => false))) {
    await discard(dir);
    note = 'incremental tsc: no previous state, full check (state saved on success)';
  } else if (meta.stamp !== want) {
    await discard(dir);
    note = 'incremental tsc: tsc version, tsconfig, command or platform changed, previous state discarded, full check';
  } else if (!(await validJson(cur))) {
    await discard(dir);
    note = 'incremental tsc: previous state was corrupt, discarded, full check';
  } else {
    try {
      await fs.copyFile(cur, work);
      note = 'incremental tsc: reusing previous .tsbuildinfo (tsc revalidates it against file hashes)';
    } catch {
      await discard(dir);
      note = 'incremental tsc: could not read previous state, full check';
    }
  }

  let done = false;
  return {
    args: ['--incremental', '--tsBuildInfoFile', work],
    note,
    async finish(success: boolean) {
      if (done) return;
      done = true;
      try {
        if (success && (await fs.stat(work).then((s) => s.isFile(), () => false)) && (await validJson(work))) {
          await fs.rm(cur, { force: true });
          await fs.rename(work, cur);
          await writeFileAtomic(path.join(dir, META), JSON.stringify({ v: 1, stamp: want } satisfies Meta));
        } else {
          await discard(dir);
          await fs.rm(work, { force: true });
        }
      } catch {
        await discard(dir).catch(() => undefined);
        await fs.rm(work, { force: true }).catch(() => undefined);
      }
    },
  };
}
