import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { DepGraph } from './graph.js';

const pexec = promisify(execFile);

export interface Selection {
  mode: 'affected' | 'all';
  /** Why every test was selected (mode "all"). */
  reason: string | null;
  changed: string[];
  selected: string[];
  skipped: { test: string; reason: string }[];
  /** selected test -> import chain from the test down to the changed file. */
  chains: Record<string, string[]>;
}

export interface ChangedFiles {
  ok: boolean;
  files: string[];
  error?: string;
}

/** Files changed relative to `since` (default HEAD), including untracked files. Never uses a shell. */
export async function changedFilesFromGit(root: string, since = 'HEAD'): Promise<ChangedFiles> {
  if (since.startsWith('-')) return { ok: false, files: [], error: `invalid git ref ${JSON.stringify(since)}` };
  try {
    const opts = { cwd: root, maxBuffer: 64 * 1024 * 1024 };
    const tracked = await pexec('git', ['diff', '--name-only', '-z', '--no-renames', '--relative', since, '--'], opts);
    const untracked = await pexec('git', ['ls-files', '--others', '--exclude-standard', '-z'], opts);
    const files = new Set<string>();
    for (const out of [tracked.stdout, untracked.stdout]) for (const f of out.split('\0')) if (f) files.add(f);
    return { ok: true, files: [...files].sort() };
  } catch (e) {
    return { ok: false, files: [], error: `git failed: ${(e as Error).message.split('\n')[0]}` };
  }
}

/**
 * Select the tests that could be affected by `changed`. Correctness rules:
 *  - any unbounded change (global config, lockfile, uncertain imports) selects ALL tests;
 *  - tests whose own imports cannot be resolved are always selected;
 *  - deleted files are expanded using the previous graph's reverse edges.
 */
export function selectTests(graph: DepGraph, prev: DepGraph | null, changed: string[]): Selection {
  const all = graph.testFiles();
  const base = { changed, chains: {} as Record<string, string[]> };
  if (changed.length === 0) {
    return { mode: 'affected', reason: null, ...base, selected: [], skipped: all.map((test) => ({ test, reason: 'no files changed' })) };
  }
  const { reached, conservative } = graph.impact(changed, prev);
  if (conservative) {
    return { mode: 'all', reason: conservative, ...base, selected: all, skipped: [] };
  }
  const selected: string[] = [];
  const skipped: Selection['skipped'] = [];
  for (const t of all) {
    const mod = graph.modules.get(t)!;
    if (reached.has(t)) {
      selected.push(t);
      base.chains[t] = graph.chain(reached, t);
    } else if (mod.uncertain.length) {
      selected.push(t);
      base.chains[t] = [t, `(always runs: ${mod.uncertain[0]})`];
    } else skipped.push({ test: t, reason: 'no import path to any changed file' });
  }
  return { mode: 'affected', reason: null, ...base, selected, skipped };
}
