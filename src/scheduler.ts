export type TaskState = 'pending' | 'ready' | 'running' | 'cached' | 'succeeded' | 'failed' | 'cancelled' | 'skipped';
export type ExecResult = 'succeeded' | 'cached' | 'failed' | 'skipped';

export interface SchedNode {
  id: string;
  deps: string[];
  /** Resource units this task occupies (clamped to capacity). */
  weight: number;
  /** Historical duration estimate, used for critical-path priority. */
  estimateMs: number;
}

export interface ScheduleOptions {
  capacity: number;
  signal?: AbortSignal;
  /** Abort everything still running as soon as one task fails. */
  bail?: boolean;
  onState?: (id: string, state: TaskState) => void;
}

/**
 * Bounded DAG scheduler. Ready tasks are started highest critical-path first
 * while total running weight stays within `capacity`. A failed task blocks its
 * dependents (state "skipped"); independent branches continue unless `bail`.
 * `exec` may return "skipped" to mean "intentionally nothing to do": that
 * satisfies dependents, unlike a skip caused by an upstream failure.
 */
export async function schedule(
  nodes: SchedNode[],
  exec: (id: string, signal: AbortSignal) => Promise<ExecResult>,
  opts: ScheduleOptions,
): Promise<Map<string, TaskState>> {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  for (const n of nodes) for (const d of n.deps) if (!byId.has(d)) throw new Error(`task ${n.id} depends on unknown task ${d}`);

  const state = new Map<string, TaskState>(nodes.map((n) => [n.id, 'pending']));
  const blocked = new Set<string>();
  const set = (id: string, s: TaskState) => {
    state.set(id, s);
    opts.onState?.(id, s);
  };

  const dependents = new Map<string, string[]>(nodes.map((n) => [n.id, []]));
  for (const n of nodes) for (const d of n.deps) dependents.get(d)!.push(n.id);
  const prio = new Map<string, number>();
  const critical = (id: string): number => {
    const hit = prio.get(id);
    if (hit !== undefined) return hit;
    const p = byId.get(id)!.estimateMs + Math.max(0, ...dependents.get(id)!.map(critical));
    prio.set(id, p);
    return p;
  };

  const ctl = new AbortController();
  const onExternalAbort = () => ctl.abort();
  if (opts.signal) {
    if (opts.signal.aborted) ctl.abort();
    else opts.signal.addEventListener('abort', onExternalAbort, { once: true });
  }

  const capacity = Math.max(1, opts.capacity);
  let used = 0;
  const running = new Map<string, Promise<void>>();
  const satisfied = (id: string) => {
    const s = state.get(id);
    return s === 'succeeded' || s === 'cached' || (s === 'skipped' && !blocked.has(id));
  };

  const start = (id: string) => {
    const w = Math.min(capacity, byId.get(id)!.weight);
    used += w;
    set(id, 'running');
    const p = (async () => {
      let r: ExecResult;
      try {
        r = await exec(id, ctl.signal);
      } catch {
        r = 'failed';
      }
      used -= w;
      running.delete(id);
      if (ctl.signal.aborted && r === 'failed') set(id, 'cancelled');
      else set(id, r);
      if (r === 'failed' && opts.bail) ctl.abort();
    })();
    running.set(id, p);
  };

  try {
    for (;;) {
      // Propagate failures to dependents and cancel everything when aborted.
      let changed = true;
      while (changed) {
        changed = false;
        for (const n of nodes) {
          const s = state.get(n.id)!;
          if (s !== 'pending' && s !== 'ready') continue;
          if (ctl.signal.aborted) {
            set(n.id, 'cancelled');
            changed = true;
          } else if (n.deps.some((d) => ['failed', 'cancelled'].includes(state.get(d)!) || blocked.has(d))) {
            blocked.add(n.id);
            set(n.id, 'skipped');
            changed = true;
          }
        }
      }
      const ready = nodes
        .filter((n) => state.get(n.id) === 'pending' || state.get(n.id) === 'ready')
        .filter((n) => n.deps.every(satisfied))
        .sort((a, b) => critical(b.id) - critical(a.id) || (a.id < b.id ? -1 : 1));
      for (const n of ready) if (state.get(n.id) === 'pending') set(n.id, 'ready');
      for (const n of ready) {
        const w = Math.min(capacity, n.weight);
        if (used > 0 && used + w > capacity) continue;
        start(n.id);
      }
      if (running.size === 0) break;
      await Promise.race(running.values());
    }
  } finally {
    opts.signal?.removeEventListener('abort', onExternalAbort);
  }
  return state;
}

/** Returns the first dependency cycle found, as a path, or null. */
export function detectCycle(nodes: { id: string; deps: string[] }[]): string[] | null {
  const deps = new Map(nodes.map((n) => [n.id, n.deps]));
  const mark = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (id: string): string[] | null => {
    if (mark.get(id) === 2) return null;
    if (mark.get(id) === 1) return [...stack.slice(stack.indexOf(id)), id];
    mark.set(id, 1);
    stack.push(id);
    for (const d of deps.get(id) ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    mark.set(id, 2);
    return null;
  };
  for (const n of nodes) {
    const c = visit(n.id);
    if (c) return c;
  }
  return null;
}
