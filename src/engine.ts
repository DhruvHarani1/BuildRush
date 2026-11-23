import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Components, ManifestEntry, CacheCorruptError, ActionRecord } from './cache.js';
import { TaskConfig } from './config.js';
import { ADAPTER_PACKAGE, diagnostics as adapterDiagnostics, toolVersion } from './adapters.js';
import { Project } from './project.js';
import { isSecretName, makeRedactor, resolveExecutable, runCommand } from './runner.js';
import { detectCycle, schedule, TaskState } from './scheduler.js';
import { changedFilesFromGit, selectTests, Selection } from './affected.js';
import { canonical, hashFile, hmac256, mapLimit, sha256 } from './util/hash.js';
import { readJson, writeFileAtomic } from './util/fsx.js';
import { compileGlobs } from './util/glob.js';
import { beginTscIncremental, IncrementalRun, supportsTscIncremental } from './tsc-state.js';
import { assertNoSymlinkInPath, resolveInside, toPosix, UnsafePathError } from './util/paths.js';

export interface TaskReport {
  task: string;
  state: TaskState;
  cache: 'hit' | 'miss' | 'disabled' | 'uncacheable' | 'n/a';
  reasons: string[];
  notes: string[];
  fingerprint: string | null;
  durationMs: number;
  restoredBytes: number;
  storedBytes: number;
  savedMsEstimate: number;
  exitCode: number | null;
  log: string;
  /** Concise, tool-aware failure summary (display only). */
  diagnostics: string[];
}

export interface RunReport {
  ok: boolean;
  cancelled: boolean;
  durationMs: number;
  tasks: TaskReport[];
  selection: Selection | null;
}

export interface RunOptions {
  noCache?: boolean;
  concurrency?: number;
  bail?: boolean;
  affected?: { since?: string } | null;
  signal?: AbortSignal;
  onTaskDone?: (r: TaskReport) => void;
}

interface TaskState_ {
  fingerprint: string;
  components: Components;
  outputs: string[];
  at: number;
}

const BASE_ENV = ['PATH', 'HOME', 'USER', 'LOGNAME', 'TMPDIR', 'TEMP', 'TMP', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT'];
const MAX_STORED_LOG = 1024 * 1024;
const binDigestMemo = new Map<string, string>();

/** All tasks needed to run `names`, in dependency order. */
export function closure(project: Project, names: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const visit = (n: string) => {
    if (seen.has(n)) return;
    seen.add(n);
    const t = project.config.tasks[n];
    if (!t) throw new Error(`unknown task ${JSON.stringify(n)} (known: ${Object.keys(project.config.tasks).join(', ')})`);
    t.dependsOn.forEach(visit);
    out.push(n);
  };
  names.forEach(visit);
  return out;
}

/** Expand a task name that may also be a pipeline name. */
export function expandNames(project: Project, names: string[]): string[] {
  const out: string[] = [];
  for (const n of names) {
    if (project.config.pipelines[n] && !project.config.tasks[n]) out.push(...project.config.pipelines[n]!);
    else out.push(n);
  }
  return out;
}

export async function runTasks(project: Project, requested: string[], opts: RunOptions = {}): Promise<RunReport> {
  const started = Date.now();
  const { config, root, cache } = project;
  const order = closure(project, expandNames(project, requested));
  const cycle = detectCycle(order.map((id) => ({ id, deps: config.tasks[id]!.dependsOn })));
  if (cycle) throw new Error(`task dependency cycle: ${cycle.join(' -> ')}`);

  const history = (await readJson<Record<string, number>>(path.join(project.stateDir, 'history.json'))) ?? {};
  const secretKey = await cache.secretKey();
  // A task may only consume another task's outputs if it (transitively) depends on that task.
  // Everything else's artifacts (and its own outputs) are never inputs, whatever the globs match.
  const transitiveDeps = (n: string, acc = new Set<string>()): Set<string> => {
    for (const d of config.tasks[n]!.dependsOn) if (!acc.has(d)) { acc.add(d); transitiveDeps(d, acc); }
    return acc;
  };
  const foreignOutputs = new Map<string, (rel: string) => boolean>();
  const isOutputOf = (name: string) => {
    let m = foreignOutputs.get(name);
    if (!m) {
      const deps = transitiveDeps(name);
      m = compileGlobs(Object.values(config.tasks).filter((x) => x.name === name || !deps.has(x.name)).flatMap((x) => x.outputs));
      foreignOutputs.set(name, m);
    }
    return m;
  };

  // ---- affected-test selection (before scheduling) -------------------------------------------
  let selection: Selection | null = null;
  const extraArgs = new Map<string, string[]>();
  const skipReason = new Map<string, string>();
  if (opts.affected) {
    const testTasks = order.filter((n) => config.tasks[n]!.kind === 'test' && config.tasks[n]!.affected);
    if (testTasks.length) {
      const graph = await project.graph();
      const prev = await project.loadPreviousGraph();
      const ch = await changedFilesFromGit(root, opts.affected.since);
      selection = ch.ok
        ? selectTests(graph, prev, ch.files)
        : { mode: 'all', reason: `${ch.error}; cannot compute changes, running every test`, changed: [], selected: graph.testFiles(), skipped: [], chains: {} };
      await project.saveGraph(graph);
      for (const n of testTasks) {
        if (selection.mode === 'all') continue; // run the task's own full command
        if (selection.selected.length === 0) skipReason.set(n, 'no tests are affected by the changes');
        else {
          const cwd = path.join(root, config.tasks[n]!.cwd);
          extraArgs.set(n, selection.selected.map((t) => toPosix(path.relative(cwd, path.join(root, t)))));
        }
      }
    }
  }

  // ---- shared state --------------------------------------------------------------------------
  let dirty = false;
  let scanLock: Promise<unknown> = Promise.resolve();
  const lockedScan = () => {
    const p = scanLock.then(() => project.index.scan());
    scanLock = p.catch(() => undefined);
    return p;
  };
  const ensureFresh = async () => {
    if (dirty) {
      dirty = false;
      await lockedScan();
    }
  };

  const reports = new Map<string, TaskReport>();
  const fingerprints = new Map<string, string>();
  const stats = { hits: 0, misses: 0, restored: 0, stored: 0, savedMs: 0 };

  const finish = (r: TaskReport) => {
    reports.set(r.task, r);
    opts.onTaskDone?.(r);
  };
  const blank = (task: string): TaskReport => ({
    task, state: 'pending', cache: 'n/a', reasons: [], notes: [], fingerprint: null, durationMs: 0,
    restoredBytes: 0, storedBytes: 0, savedMsEstimate: 0, exitCode: null, log: '', diagnostics: [],
  });

  const exec = async (name: string, signal: AbortSignal): Promise<'succeeded' | 'cached' | 'failed' | 'skipped'> => {
    const declared = config.tasks[name]!;
    // Adapter env prefixes (e.g. VITE_) expand to every matching variable that is actually set.
    const t: TaskConfig = {
      ...declared,
      env: [...new Set([...declared.env, ...Object.keys(process.env).filter((k) => declared.envPrefixes.some((p) => k.startsWith(p)))])].sort(),
    };
    const rep = blank(name);
    const t0 = Date.now();
    try {
      if (skipReason.has(name)) {
        rep.state = 'skipped';
        rep.notes.push(skipReason.get(name)!);
        finish(rep);
        return 'skipped';
      }
      await ensureFresh();
      const taskCwd = t.cwd === '.' ? root : resolveInside(root, t.cwd);
      const env = buildEnv(t, process.env);
      const exe = resolveExecutable(t.command[0]!, taskCwd, root, env.PATH ?? '');
      if (!exe) {
        rep.state = 'failed';
        rep.exitCode = 127;
        rep.notes.push(`executable ${JSON.stringify(t.command[0])} not found (searched node_modules/.bin and PATH)`);
        finish(rep);
        return 'failed';
      }
      const args = extraArgs.get(name) ?? [];
      const inputs = resolveInputs(project, t, isOutputOf(name));
      const components = await buildComponents(project, t, args, inputs, exe, fingerprints, secretKey);
      if (t.adapter) components.toolchain[t.adapter] = await toolVersion(root, taskCwd, ADAPTER_PACKAGE[t.adapter]);
      const fp = sha256(canonical(components));
      rep.fingerprint = fp;
      fingerprints.set(name, fp);
      const prev = await readJson<TaskState_>(taskStatePath(project, name));

      const cacheOn = t.cache && !opts.noCache;
      if (!cacheOn) {
        rep.cache = 'disabled';
        rep.reasons.push(!t.cache ? 'caching disabled for this task (cache: false)' : 'caching disabled by --no-cache');
      } else {
        const rec = await cache.lookup(fp);
        if (rec) {
          try {
            const r0 = Date.now();
            const restored = await cache.restore(rec, root);
            await removeStale(root, prev?.outputs ?? [], rec.outputs.map((o) => o.path));
            await cache.touch(fp);
            rep.state = 'cached';
            rep.cache = 'hit';
            rep.restoredBytes = restored.bytes;
            rep.savedMsEstimate = rec.durationMs;
            rep.durationMs = Date.now() - r0;
            rep.notes.push(`restored ${restored.files} file(s) in ${rep.durationMs}ms`);
            if (rec.logDigest) rep.log = (await cache.readBlob(rec.logDigest))?.toString('utf8') ?? '';
            stats.hits++;
            stats.restored += restored.bytes;
            stats.savedMs += rec.durationMs;
            if (restored.files) dirty = true;
            await saveTaskState(project, name, { fingerprint: fp, components, outputs: rec.outputs.map((o) => o.path), at: Date.now() });
            finish(rep);
            return 'cached';
          } catch (e) {
            if (!(e instanceof CacheCorruptError || e instanceof UnsafePathError)) throw e;
            rep.reasons.push(`cache entry unusable (${(e as Error).message}); entry discarded`);
            await cache.deleteEntry(fp);
          }
        }
        rep.cache = 'miss';
        if (rep.reasons.length === 0) rep.reasons.push(...explainMiss(prev?.components ?? null, components));
        stats.misses++;
      }

      // ---- execute -------------------------------------------------------------------------
      const redact = makeRedactor(env);
      // Engine-managed tsc state: never part of the fingerprint, never a cached output.
      let inc: IncrementalRun | null = null;
      const tscVersion = components.toolchain.tsc;
      if (t.adapter === 'tsc' && t.incrementalEligible && t.incremental !== false && typeof tscVersion === 'string' && supportsTscIncremental(tscVersion)) {
        try {
          const configs: Record<string, string> = {};
          for (const [p, f] of project.index.files) if (/(^|\/)[jt]sconfig[^/]*\.json$/.test(p)) configs[p] = f.digest;
          inc = await beginTscIncremental(project.stateDir, name, {
            version: tscVersion, command: t.command, args, cwd: t.cwd, executable: String(components.toolchain.executable), configs,
          });
          rep.notes.push(inc.note);
        } catch (e) {
          inc = null;
          rep.notes.push(`incremental tsc unavailable (${(e as Error).message}); running a full check`);
        }
      }
      let res;
      try {
        res = await runCommand({
          file: exe,
          args: [...t.command.slice(1), ...(inc?.args ?? []), ...args],
          cwd: taskCwd,
          env,
          signal,
          timeoutMs: t.timeoutMs,
          redact,
        });
      } catch (e) {
        await inc?.finish(false);
        throw e;
      }
      await inc?.finish(res.exitCode === 0 && !res.cancelled && !res.timedOut && !res.spawnError);
      rep.durationMs = res.durationMs;
      rep.exitCode = res.exitCode;
      rep.log = res.log;
      if (res.exitCode !== 0) rep.diagnostics = adapterDiagnostics(t.adapter, res.log);
      if (res.spawnError) rep.notes.push(`failed to start: ${res.spawnError}`);
      if (res.timedOut) rep.notes.push(`timed out after ${t.timeoutMs}ms`);
      if (res.cancelled) {
        rep.state = 'cancelled';
        finish(rep);
        return 'failed';
      }
      if (res.exitCode !== 0) {
        rep.state = 'failed';
        if (res.signal) rep.notes.push(`terminated by ${res.signal}`);
        finish(rep);
        return 'failed';
      }

      // ---- success: validate outputs and inputs, then commit atomically -----------------------
      dirty = true;
      rep.state = 'succeeded';
      history[name] = res.durationMs;
      const cacheable = cacheOn;
      let manifest: ManifestEntry[] | null = null;
      if (t.outputs.length) {
        const found = await captureOutputs(root, t.outputs);
        if (found.problems.length) {
          rep.cache = 'uncacheable';
          rep.notes.push(...found.problems);
        } else manifest = found.entries;
      } else manifest = [];
      if (cacheable && manifest) {
        await lockedScan();
        dirty = false;
        const after = resolveInputs(project, t, isOutputOf(name));
        const changed = diffInputs(components.inputs, after.map((p) => [p, project.index.files.get(p)!.digest] as const));
        if (changed.length) {
          rep.cache = 'uncacheable';
          rep.notes.push(`inputs changed during execution (${changed.slice(0, 3).join(', ')}${changed.length > 3 ? ', ...' : ''}); result not cached`);
        } else {
          const logData = Buffer.from(res.log.length > MAX_STORED_LOG ? res.log.slice(-MAX_STORED_LOG) : res.log);
          const logDigest = await cache.putBlobData(logData);
          const record: ActionRecord = {
            v: 1, key: fp, task: name, createdAt: Date.now(), durationMs: res.durationMs,
            outputs: manifest, logDigest, components,
          };
          const stored = await cache.store(record, root);
          rep.storedBytes = stored.bytes;
          stats.stored += stored.bytes;
          await saveTaskState(project, name, { fingerprint: fp, components, outputs: manifest.map((o) => o.path), at: Date.now() });
        }
      }
      finish(rep);
      return 'succeeded';
    } catch (e) {
      rep.state = 'failed';
      rep.notes.push(`internal error: ${(e as Error).message}`);
      rep.durationMs ||= Date.now() - t0;
      finish(rep);
      return 'failed';
    }
  };

  const states = await schedule(
    order.map((id) => ({
      id,
      deps: config.tasks[id]!.dependsOn,
      weight: config.tasks[id]!.cpu,
      estimateMs: history[id] ?? 1000,
    })),
    exec,
    { capacity: opts.concurrency ?? config.concurrency, signal: opts.signal, bail: opts.bail },
  );

  for (const id of order) {
    if (!reports.has(id)) {
      const r = blank(id);
      r.state = states.get(id)!;
      if (r.state === 'skipped') r.notes.push('a dependency did not succeed');
      if (r.state === 'cancelled') r.notes.push('cancelled before start');
      finish(r);
    }
  }
  await project.index.save();
  await writeFileAtomic(path.join(project.stateDir, 'history.json'), JSON.stringify(history));
  await bumpStats(project, stats);
  if (project.config.cache.maxSizeMB > 0) await cache.gc(project.config.cache.maxSizeMB * 1024 * 1024);

  const tasks = order.map((id) => reports.get(id)!);
  return {
    ok: tasks.every((r) => ['succeeded', 'cached', 'skipped'].includes(r.state) && !(r.state === 'skipped' && r.notes.includes('a dependency did not succeed'))),
    cancelled: tasks.some((r) => r.state === 'cancelled'),
    durationMs: Date.now() - started,
    tasks,
    selection,
  };
}

// ---------------------------------------------------------------------------------------------

export function buildEnv(t: TaskConfig, parent: NodeJS.ProcessEnv): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of BASE_ENV) if (parent[k] !== undefined) env[k] = parent[k]!;
  // Pin sources of nondeterminism unless the task explicitly declares them as inputs.
  env.TZ = 'UTC';
  env.LANG = 'C.UTF-8';
  env.NO_COLOR = '1';
  env.FORCE_COLOR = '0';
  env.CI = parent.CI ?? '';
  if (env.CI === '') delete env.CI;
  for (const k of [...t.env, ...t.passEnv]) if (parent[k] !== undefined) env[k] = parent[k]!;
  for (const k of Object.keys(env)) if (k.startsWith('BUILDRUSH_')) delete env[k]; // never leak internals
  return env;
}

function resolveInputs(project: Project, t: TaskConfig, isExcludedOutput: (rel: string) => boolean): string[] {
  const all = [...project.index.files.keys()];
  if (t.inputs === null) return all.filter((f) => !isExcludedOutput(f));
  const match = compileGlobs(t.inputs);
  return all.filter((f) => match(f) && !isExcludedOutput(f));
}

async function buildComponents(
  project: Project,
  t: TaskConfig,
  args: string[],
  inputs: string[],
  exe: string,
  fingerprints: Map<string, string>,
  secretKey: Buffer,
): Promise<Components> {
  const env: Record<string, string | null> = {};
  for (const name of [...t.env].sort()) {
    const v = process.env[name];
    env[name] = v === undefined ? null : isSecretName(name) ? 'hmac:' + hmac256(secretKey, `${name}=${v}`) : sha256(`${name}=${v}`);
  }
  const inputDigests: Record<string, string> = {};
  for (const p of inputs) inputDigests[p] = project.index.files.get(p)!.digest;
  const deps: Record<string, string> = {};
  for (const d of [...t.dependsOn].sort()) {
    const fp = fingerprints.get(d);
    if (fp) deps[d] = fp;
  }
  return {
    schema: 1,
    task: t.name,
    command: t.command,
    cwd: t.cwd,
    env,
    toolchain: {
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      executable: await executableDigest(exe),
    },
    inputs: inputDigests,
    deps,
    outputs: [...t.outputs].sort(),
    args,
  };
}

async function executableDigest(exe: string): Promise<string> {
  let real = exe;
  try {
    real = await fs.realpath(exe);
  } catch { /* keep */ }
  if (real === process.execPath) return `node:${process.version}`;
  const memo = binDigestMemo.get(real);
  if (memo) return memo;
  const st = await fs.stat(real);
  const d = st.size > 64 * 1024 * 1024 ? `meta:${st.size}:${Math.floor(st.mtimeMs)}` : await hashFile(real);
  binDigestMemo.set(real, d);
  return d;
}

function diffInputs(before: Record<string, string>, after: readonly (readonly [string, string])[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const [p, d] of after) {
    seen.add(p);
    if (!(p in before)) out.push(`+${p}`);
    else if (before[p] !== d) out.push(`~${p}`);
  }
  for (const p of Object.keys(before)) if (!seen.has(p)) out.push(`-${p}`);
  return out;
}

/** Human-readable reasons a task could not be served from the cache. */
export function explainMiss(prev: Components | null, cur: Components): string[] {
  if (!prev) return ['no previous successful run recorded for this task'];
  const out: string[] = [];
  if (canonical(prev.command) !== canonical(cur.command)) out.push('command changed');
  if (canonical(prev.args) !== canonical(cur.args)) out.push('selected arguments changed (different test selection)');
  if (prev.cwd !== cur.cwd) out.push('working directory changed');
  if (canonical(prev.outputs) !== canonical(cur.outputs)) out.push('declared outputs changed');
  for (const k of new Set([...Object.keys(prev.env), ...Object.keys(cur.env)])) {
    if (prev.env[k] !== cur.env[k]) out.push(`environment variable ${k} changed`);
  }
  for (const k of new Set([...Object.keys(prev.toolchain), ...Object.keys(cur.toolchain)])) {
    if (prev.toolchain[k] !== cur.toolchain[k]) out.push(`toolchain ${k} changed`);
  }
  const changes = diffInputs(prev.inputs, Object.entries(cur.inputs));
  const label = (c: string) => (c[0] === '+' ? `input added: ${c.slice(1)}` : c[0] === '-' ? `input removed: ${c.slice(1)}` : `input changed: ${c.slice(1)}`);
  changes.slice(0, 5).forEach((c) => out.push(label(c)));
  if (changes.length > 5) out.push(`...and ${changes.length - 5} more input change(s)`);
  for (const k of new Set([...Object.keys(prev.deps), ...Object.keys(cur.deps)])) {
    if (prev.deps[k] !== cur.deps[k]) out.push(`dependency task "${k}" has a different fingerprint`);
  }
  if (out.length === 0) out.push('cache entry missing (evicted, cleaned, or never stored)');
  return out;
}

async function captureOutputs(root: string, patterns: string[]): Promise<{ entries: ManifestEntry[]; problems: string[] }> {
  const problems: string[] = [];
  const entries: ManifestEntry[] = [];
  const seen = new Set<string>();
  for (const pattern of patterns) {
    const match = compileGlobs([pattern]);
    const segs = pattern.replace(/^\.\//, '').split('/');
    const stat: string[] = [];
    for (const s of segs.slice(0, -1)) {
      if (/[*?{]/.test(s)) break;
      stat.push(s);
    }
    const baseRel = stat.join('/');
    const found: string[] = [];
    const walk = async (rel: string) => {
      const abs = rel ? path.join(root, rel) : root;
      let ents;
      try {
        ents = await fs.readdir(abs, { withFileTypes: true });
      } catch { return; }
      for (const e of ents) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isSymbolicLink()) {
          if (match(r)) problems.push(`output ${r} is a symlink; symlinked outputs are never cached`);
        } else if (e.isDirectory()) {
          if (e.name !== '.git' && e.name !== '.buildrush' && (e.name !== 'node_modules' || baseRel.includes('node_modules'))) await walk(r);
        } else if (e.isFile() && match(r)) found.push(r);
      }
    };
    await walk(baseRel);
    if (found.length === 0) problems.push(`declared output ${JSON.stringify(pattern)} matched no files; result not cached`);
    for (const f of found) {
      if (seen.has(f)) continue;
      seen.add(f);
    }
  }
  const files = [...seen].sort();
  const hashed = await mapLimit(files, 16, async (rel) => {
    const abs = resolveInside(root, rel);
    const st = await fs.lstat(abs);
    return { path: rel, digest: await hashFile(abs), size: st.size, mode: st.mode & 0o777 } as ManifestEntry;
  });
  entries.push(...hashed);
  return { entries, problems };
}

async function removeStale(root: string, previous: string[], current: string[]): Promise<void> {
  const keep = new Set(current);
  for (const rel of previous) {
    if (keep.has(rel)) continue;
    try {
      await assertNoSymlinkInPath(root, rel);
      await fs.rm(resolveInside(root, rel), { force: true });
    } catch { /* unsafe or already gone: leave it */ }
  }
}

function taskStatePath(project: Project, name: string): string {
  return path.join(project.stateDir, 'tasks', encodeURIComponent(name) + '.json');
}

async function saveTaskState(project: Project, name: string, s: TaskState_): Promise<void> {
  await writeFileAtomic(taskStatePath(project, name), JSON.stringify(s));
}

export async function loadTaskState(project: Project, name: string): Promise<TaskState_ | null> {
  return readJson<TaskState_>(taskStatePath(project, name));
}

export interface LifetimeStats {
  hits: number;
  misses: number;
  bytesRestored: number;
  bytesStored: number;
  estimatedSavedMs: number;
}

export async function readStats(project: Project): Promise<LifetimeStats> {
  return (
    (await readJson<LifetimeStats>(path.join(project.stateDir, 'stats.json'))) ?? {
      hits: 0, misses: 0, bytesRestored: 0, bytesStored: 0, estimatedSavedMs: 0,
    }
  );
}

async function bumpStats(project: Project, s: { hits: number; misses: number; restored: number; stored: number; savedMs: number }) {
  const cur = await readStats(project);
  await writeFileAtomic(
    path.join(project.stateDir, 'stats.json'),
    JSON.stringify({
      hits: cur.hits + s.hits,
      misses: cur.misses + s.misses,
      bytesRestored: cur.bytesRestored + s.restored,
      bytesStored: cur.bytesStored + s.stored,
      estimatedSavedMs: cur.estimatedSavedMs + s.savedMs,
    } satisfies LifetimeStats),
  );
}
