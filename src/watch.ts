import * as path from 'node:path';
import { CONFIG_FILE } from './config.js';
import { FileEntry, FileIndex } from './fsindex.js';
import { Project } from './project.js';
import { RunOptions, RunReport, runTasks, TaskReport } from './engine.js';
import { createFsWatcher, WatcherFactory, WatcherHandle, WatchMode, whenArmed } from './fswatch.js';

export interface WatchChanges {
  added: string[];
  modified: string[];
  removed: string[];
}

/** Why a cycle started. `reconcile`/`error` mean the watcher did not (or could not) report it. */
export type CycleTrigger = 'initial' | 'change' | 'reconcile' | 'error';

export interface WatchCycle {
  n: number;
  trigger: CycleTrigger;
  /** Source-file changes (task outputs excluded) found by content-digest reconciliation. */
  changed: WatchChanges;
  /** Null when no run happened (config reload failed, or the engine threw). */
  report: RunReport | null;
  /** A newer change arrived mid-run: the run was cancelled and its results were not published. */
  superseded: boolean;
  configReloaded: boolean;
  error: string | null;
  /** Time spent reconciling the file index before the run. */
  scanMs: number;
  /** Wall time of the whole cycle (reconcile + run). */
  durationMs: number;
}

export interface WatchStats {
  /** Raw watcher events that reached the session (after the watcher's own ignore filter). */
  events: number;
  /** Events dropped by the session's filter (ignored dirs, task outputs). */
  ignoredEvents: number;
  watcherErrors: number;
  /** Index reconciliation scans performed (including no-op ones). */
  scans: number;
  /** Scans that found no source change and therefore started no cycle. */
  noopScans: number;
  cycles: number;
}

export interface WatchOptions {
  tasks: string[];
  run?: Omit<RunOptions, 'signal' | 'onTaskDone'>;
  /** Quiet window for coalescing bursts; the first event after idle is never delayed. Default 50. */
  debounceMs?: number;
  /** Periodic full reconciliation, so dropped events cannot cause stale results. Default 30000. */
  reconcileMs?: number;
  /** Reconciliation period once the watcher has reported an error (degraded to polling). Default 2000. */
  degradedReconcileMs?: number;
  /** Graceful shutdown: aborts in-flight work, closes watchers, resolves `done`. */
  signal?: AbortSignal;
  watcherFactory?: WatcherFactory;
  watchMode?: WatchMode;
  onCycleStart?: (info: { n: number; trigger: CycleTrigger; changed: WatchChanges }) => void;
  onTaskDone?: (r: TaskReport) => void;
  onCycle?: (c: WatchCycle) => void;
  onNotice?: (msg: string) => void;
}

export interface WatchSession {
  readonly stats: Readonly<WatchStats>;
  readonly mode: WatchMode | 'custom';
  readonly project: Project;
  /** Resolves when the session has fully stopped. Rejects only on an unexpected internal error. */
  readonly done: Promise<void>;
  stop(): Promise<void>;
}

/**
 * Leading + trailing debounce. When idle the first trigger fires immediately (zero added
 * latency); triggers inside the quiet window coalesce into one trailing fire after the window.
 */
export class Debouncer {
  private timer: NodeJS.Timeout | null = null;
  private pending = false;

  constructor(private quietMs: number, private fire: () => void) {}

  trigger(): void {
    if (this.timer === null) {
      this.fire();
      this.timer = setTimeout(this.expire, this.quietMs);
    } else {
      this.pending = true;
      clearTimeout(this.timer);
      this.timer = setTimeout(this.expire, this.quietMs);
    }
  }

  private expire = (): void => {
    this.timer = null;
    if (this.pending) {
      this.pending = false;
      this.fire();
      this.timer = setTimeout(this.expire, this.quietMs);
    }
  };

  cancel(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending = false;
  }
}

/**
 * Paths whose events must never start work: ignored directories (.git, node_modules, .buildrush,
 * config `ignore`) anywhere along the path, and files matching any task's declared outputs (so
 * BuildRush's own writes cannot retrigger it).
 */
export function makeEventFilter(project: Project): (rel: string) => boolean {
  const isOutput = project.outputMatcher();
  return (rel) => {
    const segs = rel.split('/').filter(Boolean);
    let prefix = '';
    for (const s of segs) {
      prefix = prefix ? `${prefix}/${s}` : s;
      if (project.index.isIgnored(prefix, true)) return true;
    }
    return project.index.isIgnored(rel, false) || isOutput(rel);
  };
}

export function diffFiles(before: Map<string, FileEntry>, after: Map<string, FileEntry>): WatchChanges {
  const d: WatchChanges = { added: [], modified: [], removed: [] };
  for (const [rel, e] of after) {
    const o = before.get(rel);
    if (!o) d.added.push(rel);
    else if (o.digest !== e.digest) d.modified.push(rel);
  }
  for (const rel of before.keys()) if (!after.has(rel)) d.removed.push(rel);
  d.added.sort();
  d.modified.sort();
  d.removed.sort();
  return d;
}

const countChanges = (c: WatchChanges) => c.added.length + c.modified.length + c.removed.length;
const withoutOutputs = (c: WatchChanges, isOutput: (rel: string) => boolean): WatchChanges => ({
  added: c.added.filter((f) => !isOutput(f)),
  modified: c.modified.filter((f) => !isOutput(f)),
  removed: c.removed.filter((f) => !isOutput(f)),
});

/**
 * Start watching. The Project (config, file index, graph) stays in memory for the whole session;
 * nothing is re-opened per change except when buildrush.json / package.json themselves change.
 *
 * Correctness model: watcher events are only a wake-up hint. What changed is always determined by
 * reconciling the FileIndex (content digests) against the previous cycle's snapshot, so a missed,
 * duplicated or spurious event can delay or waste work but never produce a stale result. A
 * periodic reconciliation (and an immediate forced one after any watcher error) bounds the delay
 * for dropped events.
 */
export async function startWatch(initial: Project, opts: WatchOptions): Promise<WatchSession> {
  let project = initial;
  let filter = makeEventFilter(project);
  let snapshot = new Map(project.index.files);
  let stopped = false;
  let degraded = false;
  let handle: WatcherHandle | null = null;
  let runCtl: AbortController | null = null;
  let superseded = false;
  let verifying = false;
  let verifyAgain = false;
  let wake: (() => void) | null = null;
  let reconcileTimer: NodeJS.Timeout | null = null;
  const reasons = new Set<CycleTrigger>();
  const stats: WatchStats = { events: 0, ignoredEvents: 0, watcherErrors: 0, scans: 0, noopScans: 0, cycles: 0 };
  const stopCtl = new AbortController();
  const notice = (m: string) => opts.onNotice?.(m);

  /**
   * While a run is in flight, check (without touching the shared index the engine is using)
   * whether a source file really changed; if so, cancel the now-obsolete run.
   */
  const verify = async (): Promise<void> => {
    if (verifying) { verifyAgain = true; return; }
    verifying = true;
    try {
      do {
        verifyAgain = false;
        const ctl = runCtl;
        if (!ctl || ctl.signal.aborted) break;
        const probe = new FileIndex(project.root, project.config.ignore, path.join(project.stateDir, 'watch-probe-unused.json'));
        probe.files = new Map(snapshot);
        await probe.scan();
        stats.scans++;
        const isOutput = project.outputMatcher();
        if (runCtl === ctl && !ctl.signal.aborted && countChanges(withoutOutputs(diffFiles(snapshot, probe.files), isOutput)) > 0) {
          superseded = true;
          ctl.abort();
        }
      } while (verifyAgain && !stopped);
    } catch {
      /* the post-run reconciliation scan is authoritative */
    } finally {
      verifying = false;
    }
  };

  const request = (reason: CycleTrigger): void => {
    if (stopped) return;
    reasons.add(reason);
    wake?.();
    if (runCtl) void verify();
  };

  const debouncer = new Debouncer(opts.debounceMs ?? 50, () => request('change'));

  const onEvent = (rel: string | null): void => {
    if (stopped) return;
    if (rel !== null && filter(rel)) { stats.ignoredEvents++; return; }
    stats.events++;
    debouncer.trigger();
  };
  const onError = (e: Error): void => {
    if (stopped) return;
    stats.watcherErrors++;
    if (!degraded) notice(`watcher error (${e.message}); events may have been lost, falling back to periodic full reconciliation`);
    degraded = true;
    request('error');
  };

  const scheduleReconcile = (): void => {
    if (stopped) return;
    const ms = degraded ? (opts.degradedReconcileMs ?? 2000) : (opts.reconcileMs ?? 30_000);
    reconcileTimer = setTimeout(() => { request('reconcile'); scheduleReconcile(); }, ms);
  };

  const cycle = async (first: CycleTrigger): Promise<void> => {
    const t0 = Date.now();
    const trigger = first;
    let configReloaded = false;
    let error: string | null = null;

    // Reconcile: content digests decide what changed; events never do. Forced rehash after errors.
    await project.index.scan({ force: trigger === 'error' });
    stats.scans++;
    const scanMs = Date.now() - t0;
    const isOutput = project.outputMatcher();
    const changed = withoutOutputs(diffFiles(snapshot, project.index.files), isOutput);
    snapshot = new Map(project.index.files);
    if (trigger !== 'initial' && countChanges(changed) === 0) { stats.noopScans++; return; }

    const touched = [...changed.added, ...changed.modified, ...changed.removed];
    if (touched.some((f) => f === CONFIG_FILE || f === 'package.json' || f.endsWith('/package.json'))) {
      try {
        project = await Project.open(project.root);
        filter = makeEventFilter(project);
        snapshot = new Map(project.index.files);
        configReloaded = true;
      } catch (e) {
        error = `configuration reload failed, waiting for the next change: ${(e as Error).message}`;
      }
    }

    const n = ++stats.cycles;
    opts.onCycleStart?.({ n, trigger, changed });
    let report: RunReport | null = null;
    const ctl = new AbortController();
    const onStop = () => ctl.abort();
    if (stopCtl.signal.aborted) ctl.abort();
    else stopCtl.signal.addEventListener('abort', onStop, { once: true });
    superseded = false;
    if (!error) {
      runCtl = ctl;
      try {
        // The engine's graph is memoised on the Project; rebuild it from the refreshed index.
        if (opts.run?.affected) await project.graph({ fresh: true });
        report = await runTasks(project, opts.tasks, { ...opts.run, signal: ctl.signal, onTaskDone: opts.onTaskDone });
      } catch (e) {
        error = (e as Error).message;
      } finally {
        runCtl = null;
        stopCtl.signal.removeEventListener('abort', onStop);
      }
    }
    opts.onCycle?.({ n, trigger, changed, report, superseded, configReloaded, error, scanMs, durationMs: Date.now() - t0 });
  };

  const rank: CycleTrigger[] = ['error', 'change', 'reconcile'];
  const loop = async (): Promise<void> => {
    await cycle('initial');
    while (!stopped) {
      if (reasons.size === 0) await new Promise<void>((resolve) => { wake = resolve; });
      wake = null;
      if (stopped) break;
      const trigger = rank.find((r) => reasons.has(r)) ?? 'change';
      reasons.clear();
      await cycle(trigger);
    }
  };

  const factory = opts.watcherFactory ?? createFsWatcher;
  handle = await factory({ root: project.root, isIgnored: (rel) => filter(rel), onEvent, onError, mode: opts.watchMode });
  await whenArmed(handle);
  scheduleReconcile();

  const stop = async (): Promise<void> => {
    if (!stopped) {
      stopped = true;
      stopCtl.abort();
      if (reconcileTimer) clearTimeout(reconcileTimer);
      debouncer.cancel();
      handle?.close();
      wake?.();
    }
    await done.catch(() => undefined);
  };
  const done: Promise<void> = loop().finally(() => {
    stopped = true;
    if (reconcileTimer) clearTimeout(reconcileTimer);
    debouncer.cancel();
    handle?.close();
  });
  if (opts.signal) {
    if (opts.signal.aborted) void stop();
    else opts.signal.addEventListener('abort', () => void stop(), { once: true });
  }

  return {
    stats,
    mode: handle.mode,
    get project() { return project; },
    done,
    stop,
  };
}
