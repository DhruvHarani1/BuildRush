import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { findProjectRoot } from '../config.js';
import { closure, expandNames, runTasks } from '../engine.js';
import { Project, WarmState } from '../project.js';
import { writeFileAtomic } from '../util/fsx.js';
import { analyze, cacheStats, writeLastRun } from './ops.js';
import {
  AUTH_TIMEOUT_MS, ErrorCode, LineReader, MAX_CONNECTIONS, MAX_ENV_CHARS, MAX_REQUEST_CHARS, MAX_UNAUTHENTICATED,
  Message, Op, OPS, PROTO, tokenMatches, VERSION, VERSION_AGNOSTIC_OPS,
} from './protocol.js';
import {
  assertSocketPathFits, DaemonDirs, daemonDirs, DaemonMeta, ensureSecureDir, newPipeName, normalizeRoot, writeSecretFile,
} from './paths.js';
import { acquireLock, probeDaemon, removeEndpointFiles } from './client.js';

export class AlreadyRunningError extends Error {
  constructor(readonly meta: DaemonMeta) {
    super(`a daemon is already running for this project (pid ${meta.pid})`);
  }
}

export interface ServerOptions {
  root: string; // realpath of the project root
  env?: NodeJS.ProcessEnv;
  /** Exit after this long with no connection and no queued/running work. 0 disables. */
  idleMs: number;
  /** Test hooks: pretend to be a different build. */
  versionOverride?: string;
  protoOverride?: number;
  /** How long a connection may take to deliver its first (authenticating) line. */
  authTimeoutMs?: number;
  /** Test hook: extra files whose change retires the daemon (like package.json does). */
  extraWatch?: string[];
}

const MAX_LOG_BYTES = 1024 * 1024;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** A file's identity as seen now; if it changes under a running daemon the daemon is stale. */
async function sig(file: string): Promise<string> {
  try {
    const st = await fs.stat(file);
    return `${st.size}:${st.mtimeMs}:${st.ino}`;
  } catch {
    return 'missing';
  }
}

export class DaemonServer {
  readonly dirs: DaemonDirs;
  readonly token: string;
  readonly endpoint: string;
  readonly closed: Promise<void>;
  /** Warm, re-validated-on-every-use state (file index, dependency graph). */
  private readonly warm: WarmState = {};
  private readonly conns = new Set<net.Socket>();
  private readonly runs = new Set<AbortController>();
  private unauth = 0;
  private pending = 0;
  private queue: Promise<void> = Promise.resolve();
  private idleTimer: NodeJS.Timeout | null = null;
  private stopping = false;
  private resolveClosed!: () => void;
  private runCount = 0;
  private readonly startedAt = Date.now();
  private readonly proto: number;
  private readonly version: string;
  private baseSig = '';
  private staleCheckedAt = 0;
  private logBytes = 0;

  private constructor(
    private readonly opts: ServerOptions,
    dirs: DaemonDirs,
    token: string,
    endpoint: string,
    private readonly server: net.Server,
  ) {
    this.dirs = dirs;
    this.token = token;
    this.endpoint = endpoint;
    this.proto = opts.protoOverride ?? PROTO;
    this.version = opts.versionOverride ?? VERSION;
    this.closed = new Promise((r) => (this.resolveClosed = r));
  }

  static async start(opts: ServerOptions): Promise<DaemonServer> {
    const dirs = daemonDirs(opts.root, opts.env);
    await ensureSecureDir(dirs.base);
    await ensureSecureDir(dirs.dir);
    const release = await acquireLock(dirs, {
      onWait: async () => {
        const live = await probeDaemon(dirs);
        if (live.status === 'live') throw new AlreadyRunningError(live.meta);
      },
    });
    try {
      const live = await probeDaemon(dirs);
      if (live.status === 'live') throw new AlreadyRunningError(live.meta);
      if (live.status === 'unreachable') throw new Error(`an existing daemon endpoint is not answering (${live.reason}); not touching it`);
      await removeEndpointFiles(dirs); // 'absent' or 'stale': leftovers from a crashed daemon

      const endpoint = process.platform === 'win32' ? newPipeName(dirs.key) : dirs.socket;
      assertSocketPathFits(endpoint);
      const token = randomBytes(32).toString('hex'); // 256 bits from the OS CSPRNG
      const server = net.createServer();
      server.maxConnections = MAX_CONNECTIONS;
      const self = new DaemonServer(opts, dirs, token, endpoint, server);
      server.on('connection', (s) => self.onConnection(s));
      server.on('error', (e) => void self.log(`server error: ${(e as Error).message}`));

      // Owner-only from the first instant: the socket inherits the umask, and the directory is 0700 anyway.
      const oldUmask = process.platform === 'win32' ? 0 : process.umask(0o177);
      try {
        await new Promise<void>((resolve, reject) => {
          server.once('error', reject);
          server.listen({ path: endpoint }, () => {
            server.off('error', reject);
            resolve();
          });
        });
      } finally {
        if (process.platform !== 'win32') process.umask(oldUmask);
      }
      if (process.platform !== 'win32') await fs.chmod(endpoint, 0o600).catch(() => undefined);

      await fs.rename(dirs.log, `${dirs.log}.old`).catch(() => undefined); // bounded: at most two log generations
      await writeSecretFile(dirs.token, token);
      const meta: DaemonMeta = {
        proto: self.proto, version: self.version, pid: process.pid, root: opts.root, endpoint,
        startedAt: self.startedAt, node: process.version,
      };
      await writeFileAtomic(dirs.meta, JSON.stringify(meta), 0o600); // its presence means "ready"
      self.baseSig = await self.installSig();
      await self.log(`listening (pid ${process.pid}, proto ${self.proto}, version ${self.version})`);
      self.touch();
      return self;
    } finally {
      await release();
    }
  }

  /**
   * Identity of everything this daemon was loaded from: the Node binary, package.json, the newest
   * mtime and file count across dist/src (so a partial rebuild also counts), plus test-injected files.
   */
  private async installSig(): Promise<string> {
    const srcDir = fileURLToPath(new URL('..', import.meta.url));
    const parts = [process.execPath, fileURLToPath(new URL('../../../package.json', import.meta.url)), ...(this.opts.extraWatch ?? [])];
    const sigs = await Promise.all(parts.map((f) => sig(f)));
    let newest = 0;
    let count = 0;
    const walk = async (d: string): Promise<void> => {
      for (const e of await fs.readdir(d, { withFileTypes: true }).catch(() => [])) {
        const p = path.join(d, e.name);
        if (e.isDirectory()) await walk(p);
        else {
          count++;
          newest = Math.max(newest, (await fs.stat(p).catch(() => null))?.mtimeMs ?? 0);
        }
      }
    };
    await walk(srcDir);
    return `${sigs.join('|')}|${count}:${newest}`;
  }

  // ---- lifecycle -------------------------------------------------------------------------------

  private touch(): void {
    if (this.idleTimer) clearTimeout(this.idleTimer);
    this.idleTimer = null;
    if (this.stopping || this.opts.idleMs <= 0) return;
    if (this.pending > 0 || this.conns.size > 0) return;
    this.idleTimer = setTimeout(() => void this.shutdown('idle timeout'), this.opts.idleMs);
  }

  async shutdown(reason: string): Promise<void> {
    if (this.stopping) return this.closed;
    this.stopping = true;
    if (this.idleTimer) clearTimeout(this.idleTimer);
    await this.log(`shutting down: ${reason}`);
    this.server.close();
    for (const ctl of this.runs) ctl.abort();
    await Promise.race([this.queue, sleep(5000)]); // let aborted work wind down; never hang forever
    for (const s of this.conns) s.destroy();
    await removeEndpointFiles(this.dirs, process.pid);
    this.resolveClosed();
    return this.closed;
  }

  private async log(msg: string): Promise<void> {
    // Fixed event text only: never request contents, tokens, environments or paths from clients.
    try {
      const line = `${new Date().toISOString()} ${msg}\n`;
      this.logBytes += line.length;
      if (this.logBytes > MAX_LOG_BYTES) {
        this.logBytes = line.length;
        await fs.rename(this.dirs.log, `${this.dirs.log}.old`).catch(() => undefined);
      }
      await fs.appendFile(this.dirs.log, line, { mode: 0o600 });
    } catch { /* logging must never break the daemon */ }
  }

  // ---- connections -----------------------------------------------------------------------------

  private onConnection(sock: net.Socket): void {
    if (this.stopping || this.unauth >= MAX_UNAUTHENTICATED) {
      sock.destroy();
      return;
    }
    this.conns.add(sock);
    this.unauth++;
    this.touch();
    sock.setEncoding('utf8');
    let authed = false;
    const ctl = new AbortController();
    const authTimer = setTimeout(() => sock.destroy(), this.opts.authTimeoutMs ?? AUTH_TIMEOUT_MS);
    const markAuthed = () => {
      authed = true;
      clearTimeout(authTimer);
      this.unauth--;
    };
    const reader = new LineReader(MAX_REQUEST_CHARS, (line) => {
      if (authed) {
        // After the request the only thing a client may say is "cancel".
        try {
          const m = JSON.parse(line) as { type?: unknown };
          if (m && m.type === 'cancel') ctl.abort();
        } catch { /* ignore */ }
        return;
      }
      if (!this.authenticate(line)) {
        void this.log('rejected a connection (bad or missing token)');
        sock.destroy(); // no reply: no oracle, nothing executed
        return;
      }
      markAuthed();
      void this.dispatch(JSON.parse(line) as Record<string, unknown>, sock, ctl);
    }, () => sock.destroy());
    sock.on('data', (c: string) => reader.push(c));
    sock.on('error', () => undefined);
    sock.on('close', () => {
      clearTimeout(authTimer);
      if (!authed) this.unauth--;
      ctl.abort(); // a vanished client cancels its own work
      this.conns.delete(sock);
      this.touch();
    });
  }

  private authenticate(line: string): boolean {
    let req: unknown;
    try {
      req = JSON.parse(line);
    } catch {
      return false;
    }
    if (typeof req !== 'object' || req === null || Array.isArray(req)) return false;
    return tokenMatches((req as { token?: unknown }).token, this.token);
  }

  private send(sock: net.Socket, m: Message, end = false): void {
    if (sock.destroyed) return;
    const line = JSON.stringify(m) + '\n';
    if (end) sock.end(line);
    else sock.write(line);
  }

  private fail(sock: net.Socket, code: ErrorCode, message: string, extra: Partial<Message> = {}): void {
    this.send(sock, { type: 'error', code, message, ...extra } as Message, true);
  }

  private async dispatch(req: Record<string, unknown>, sock: net.Socket, ctl: AbortController): Promise<void> {
    const op = req.op;
    if (typeof op !== 'string' || !(OPS as readonly string[]).includes(op)) return this.fail(sock, 'bad_request', 'unknown operation');
    const o = op as Op;
    if (!VERSION_AGNOSTIC_OPS.includes(o) && (req.proto !== this.proto || req.client !== this.version)) {
      return this.fail(sock, 'version_mismatch', `daemon is proto ${this.proto} / BuildRush ${this.version}`, { proto: this.proto, version: this.version });
    }
    if (this.stopping) return this.fail(sock, 'shutting_down', 'daemon is shutting down');
    try {
      switch (o) {
        case 'ping':
        case 'status':
          return this.send(sock, { type: 'result', data: this.status() }, true);
        case 'stop':
          this.send(sock, { type: 'result', data: { stopping: true } }, true);
          setImmediate(() => void this.shutdown('stop requested'));
          return;
        default:
          if (await this.isStale()) {
            this.fail(sock, 'stale_daemon', 'the BuildRush install or Node binary changed under this daemon; it is exiting');
            setImmediate(() => void this.shutdown('stale install'));
            return;
          }
          return this.enqueue(sock, ctl, () => this.projectOp(o, req.args, sock, ctl));
      }
    } catch (e) {
      this.fail(sock, 'failed', (e as Error).message);
    }
  }

  private status() {
    return {
      pid: process.pid, proto: this.proto, version: this.version, root: this.opts.root, node: process.version,
      startedAt: this.startedAt, uptimeMs: Date.now() - this.startedAt, runs: this.runCount,
      queued: Math.max(0, this.pending - (this.runs.size > 0 ? 1 : 0)), busy: this.runs.size > 0,
      warm: { index: this.warm.index?.files.size ?? 0, graph: !!this.warm.graph },
      idleMs: this.opts.idleMs,
    };
  }

  private async isStale(): Promise<boolean> {
    // The stat walk runs at most once per second; a stale verdict is sticky.
    if (this.staleCheckedAt === -1) return true;
    if (Date.now() - this.staleCheckedAt < 1000) return false;
    this.staleCheckedAt = Date.now();
    if ((await this.installSig()) !== this.baseSig) {
      this.staleCheckedAt = -1;
      return true;
    }
    return false;
  }

  /** One project operation at a time: they share the warm index, the cache and the working tree. */
  private enqueue(sock: net.Socket, ctl: AbortController, fn: () => Promise<void>): void {
    const ahead = this.pending;
    this.pending++;
    if (ahead > 0) this.send(sock, { type: 'queued', ahead });
    this.queue = this.queue.then(async () => {
      try {
        if (sock.destroyed || ctl.signal.aborted) return;
        this.runs.add(ctl);
        await fn();
      } catch (e) {
        this.fail(sock, 'failed', (e as Error).message);
      } finally {
        this.runs.delete(ctl);
        this.pending--;
        this.touch();
      }
    });
  }

  // ---- operations ------------------------------------------------------------------------------

  private async projectOp(op: Op, rawArgs: unknown, sock: net.Socket, ctl: AbortController): Promise<void> {
    const args = (typeof rawArgs === 'object' && rawArgs !== null && !Array.isArray(rawArgs) ? rawArgs : {}) as Record<string, unknown>;
    const parsed = parseCommon(args);
    if (typeof parsed === 'string') return this.fail(sock, 'bad_request', parsed);
    const found = await findProjectRoot(parsed.cwd);
    const real = found ? await fs.realpath(found) : null;
    if (!real || normalizeRoot(real) !== normalizeRoot(this.opts.root)) {
      return this.fail(sock, 'wrong_root', 'this daemon serves a different project');
    }
    this.runCount++;
    if (op === 'cacheStats') {
      const p = await Project.open(this.opts.root, { scan: false, env: parsed.env, warm: this.warm });
      return this.send(sock, { type: 'result', data: await cacheStats(p) }, true);
    }
    const p = await Project.open(this.opts.root, { env: parsed.env, warm: this.warm });
    if (op === 'analyze') {
      const { result } = await analyze(p);
      return this.send(sock, { type: 'result', data: result }, true);
    }
    // op === 'run'
    const run = parseRun(args);
    if (typeof run === 'string') return this.fail(sock, 'bad_request', run);
    for (const n of run.tasks) {
      if (!p.config.tasks[n] && !p.config.pipelines[n] && !p.taskGroups[n]) {
        return this.fail(sock, 'failed', `unknown task ${JSON.stringify(n)}`); // the client re-runs in-process for the canonical message
      }
    }
    this.send(sock, { type: 'begin', project: p.config.project.name, tasks: closure(p, expandNames(p, run.tasks)).length });
    // The exact engine path of a one-shot run, with the CLIENT's environment and its own cancel signal.
    const report = await runTasks(p, run.tasks, {
      noCache: run.noCache, bail: run.bail, concurrency: run.concurrency,
      affected: run.affected ? { since: run.since } : null,
      signal: ctl.signal, env: parsed.env,
      onTaskDone: (r) => this.send(sock, { type: 'task', report: r }),
    });
    await writeLastRun(p, run.tasks, report);
    this.send(sock, { type: 'result', data: report }, true);
  }
}

// ---- strict argument parsing (anything unexpected is a bad_request, never "best effort") --------

interface Common { cwd: string; env: NodeJS.ProcessEnv }
interface RunArgs { tasks: string[]; noCache: boolean; bail: boolean; affected: boolean; since?: string; concurrency?: number }

function parseCommon(a: Record<string, unknown>): Common | string {
  if (typeof a.cwd !== 'string' || a.cwd.length === 0 || a.cwd.length > 4096 || a.cwd.includes('\0')) return 'cwd must be a non-empty string';
  const env: NodeJS.ProcessEnv = {};
  if (a.env !== undefined) {
    if (typeof a.env !== 'object' || a.env === null || Array.isArray(a.env)) return 'env must be an object';
    let size = 0;
    for (const [k, v] of Object.entries(a.env)) {
      if (typeof v !== 'string') return 'env values must be strings';
      size += k.length + v.length;
      if (size > MAX_ENV_CHARS) return 'env is too large';
      if (k === '' || k === '__proto__' || k.includes('=') || k.includes('\0') || v.includes('\0')) continue;
      if (k.toUpperCase() === 'BUILDRUSH_CACHE_DIR' && !path.isAbsolute(v)) {
        // A relative path would resolve against the daemon's cwd, not the client's: split caches, wrong place.
        return 'BUILDRUSH_CACHE_DIR must be absolute (the client resolves it before sending)';
      }
      env[k] = v;
    }
  }
  return { cwd: a.cwd, env: process.platform === 'win32' ? caseInsensitiveEnv(env) : env };
}

/**
 * Windows environment names are case-insensitive (`Path` is `PATH`) but a plain object is not.
 * Reads resolve through a case-folded index; enumeration still yields the names as the client spelled them.
 */
export function caseInsensitiveEnv(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const folded = new Map<string, string>();
  for (const k of Object.keys(env)) folded.set(k.toUpperCase(), k);
  const real = (p: string | symbol): string | symbol => (typeof p === 'string' ? (folded.get(p.toUpperCase()) ?? p) : p);
  return new Proxy(env, {
    get: (t, p) => Reflect.get(t, real(p)),
    has: (t, p) => Reflect.has(t, real(p)),
    set: (t, p, v) => { folded.set(String(p).toUpperCase(), String(p)); return Reflect.set(t, p, v); },
  });
}

function parseRun(a: Record<string, unknown>): RunArgs | string {
  const { tasks, flags } = a as { tasks?: unknown; flags?: unknown };
  if (!Array.isArray(tasks) || tasks.length === 0 || tasks.length > 64) return 'tasks must be a non-empty array (max 64)';
  if (!tasks.every((t) => typeof t === 'string' && t.length > 0 && t.length <= 256 && !t.includes('\0'))) return 'task names must be short strings';
  const f = (typeof flags === 'object' && flags !== null && !Array.isArray(flags) ? flags : {}) as Record<string, unknown>;
  for (const k of ['noCache', 'bail', 'affected']) if (f[k] !== undefined && typeof f[k] !== 'boolean') return `flags.${k} must be a boolean`;
  if (f.since !== undefined && (typeof f.since !== 'string' || f.since.length > 256)) return 'flags.since must be a short string';
  if (f.concurrency !== undefined && (!Number.isInteger(f.concurrency) || (f.concurrency as number) < 1 || (f.concurrency as number) > 1024)) return 'flags.concurrency must be 1..1024';
  return {
    tasks: tasks as string[], noCache: f.noCache === true, bail: f.bail === true, affected: f.affected === true,
    since: f.since as string | undefined, concurrency: f.concurrency as number | undefined,
  };
}
