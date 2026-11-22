import * as path from 'node:path';
import type { DepGraph } from './graph.js';
import { GLOBAL_CONFIG } from './graph.js';
import { canonical, sha256 } from './util/hash.js';
import { compileGlobs } from './util/glob.js';
import { readJson, writeFileAtomic } from './util/fsx.js';

/**
 * Per-test-file result caching ("testCache"). A test file may be skipped only when a prior PASSING run
 * recorded exactly the same key. The key covers:
 *   - the test file's own content digest and the digests of its whole transitive import closure;
 *   - every global configuration file (package.json, lockfiles, tsconfig, vitest/vite config, .env, ...);
 *   - the task command, cwd, declared env (secret values are HMAC'd by the engine, never stored) and toolchain.
 * A test whose closure contains ANY uncertain import (non-literal dynamic loading, unresolved import,
 * import.meta.glob, ...) has no key and always runs: it may depend on files the graph cannot see.
 */

export interface TestKey {
  /** null = never cacheable (see reason). */
  key: string | null;
  reason: string | null;
}

export interface TestCacheReport {
  /** Test files not executed because an identical earlier run passed. */
  skipped: { test: string; reason: string }[];
  /** Test files executed, with why. */
  ran: { test: string; reason: string }[];
  /** Number of passing results recorded after this run. */
  recorded: number;
}

export interface KeyBase {
  task: string;
  command: string[];
  cwd: string;
  env: Record<string, string | null>;
  toolchain: Record<string, string | null>;
}

const GLOBAL_FILES = [...GLOBAL_CONFIG, '**/vitest.workspace.*', '**/.npmrc', '**/.nvmrc', '**/.node-version'];

/** Digest of every global configuration file in the index plus the task-level key components. */
export function baseDigest(base: KeyBase, files: ReadonlyMap<string, { digest: string }>): string {
  const isGlobal = compileGlobs(GLOBAL_FILES);
  const global: Record<string, string> = {};
  for (const [p, f] of files) if (isGlobal(p)) global[p] = f.digest;
  return sha256(canonical({ schema: 1, ...base, global }));
}

export function computeKeys(
  graph: DepGraph,
  files: ReadonlyMap<string, { digest: string }>,
  tests: string[],
  baseHash: string,
): Map<string, TestKey> {
  const out = new Map<string, TestKey>();
  for (const t of tests) {
    if (!graph.modules.has(t)) {
      out.set(t, { key: null, reason: 'not in the module graph' });
      continue;
    }
    const seen = new Set<string>([t]);
    const queue = [t];
    let bad: string | null = null;
    for (let i = 0; i < queue.length && !bad; i++) {
      const cur = queue[i]!;
      const mod = graph.modules.get(cur);
      if (mod?.uncertain.length) bad = `${cur} has uncertain imports (${mod.uncertain[0]})`;
      else if (!files.has(cur)) bad = `${cur} is not an indexed file`;
      for (const d of graph.deps.get(cur)?.keys() ?? []) {
        if (!seen.has(d)) {
          seen.add(d);
          queue.push(d);
        }
      }
    }
    if (bad) {
      out.set(t, { key: null, reason: bad });
      continue;
    }
    const closure: Record<string, string> = {};
    for (const p of [...seen].sort()) closure[p] = files.get(p)!.digest;
    out.set(t, { key: sha256(canonical({ base: baseHash, test: t, closure })), reason: null });
  }
  return out;
}

// ---- persistence -----------------------------------------------------------------------------

interface Rec {
  test: string;
  at: number;
  durationMs: number;
}
interface StoreFile {
  v: 1;
  /** key -> record. Only keys of PASSING runs are ever written. */
  entries: Record<string, Rec>;
}

const MAX_PER_TEST = 4;

export class TestResultStore {
  private data: StoreFile = { v: 1, entries: {} };
  constructor(private readonly file: string) {}

  async load(): Promise<void> {
    const d = await readJson<StoreFile>(this.file).catch(() => null);
    if (d && d.v === 1 && d.entries && typeof d.entries === 'object') this.data = d;
  }

  has(key: string): Rec | null {
    const r = this.data.entries[key];
    return r && typeof r.test === 'string' ? r : null;
  }

  knowsTest(test: string): boolean {
    return Object.values(this.data.entries).some((r) => r.test === test);
  }

  add(key: string, rec: Rec): void {
    this.data.entries[key] = rec;
  }

  async save(): Promise<void> {
    const byTest = new Map<string, [string, Rec][]>();
    for (const [k, r] of Object.entries(this.data.entries)) {
      if (!byTest.has(r.test)) byTest.set(r.test, []);
      byTest.get(r.test)!.push([k, r]);
    }
    const kept: Record<string, Rec> = {};
    for (const list of byTest.values()) {
      list.sort((a, b) => b[1].at - a[1].at);
      for (const [k, r] of list.slice(0, MAX_PER_TEST)) kept[k] = r;
    }
    this.data.entries = kept;
    await writeFileAtomic(this.file, JSON.stringify(this.data));
  }
}

export function storePath(stateDir: string, task: string): string {
  return path.join(stateDir, 'testcache', encodeURIComponent(task) + '.json');
}
