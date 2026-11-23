import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { checkSecureDir, DaemonDirs, DaemonMeta, readSecureFile, resolveBaseDir } from './paths.js';
import { LineReader, MAX_MESSAGE_CHARS, Message, Op, PROTO, VERSION } from './protocol.js';

export interface Credentials {
  meta: DaemonMeta;
  token: string;
}

/** The daemon could not be used (transport problem). Callers fall back to a one-shot run. */
export class DaemonUnavailable extends Error {
  constructor(message: string, readonly errno: string | null = null, readonly sawOutput = false) {
    super(message);
  }
}

/** The daemon understood the request and refused or failed it. */
export class DaemonError extends Error {
  constructor(readonly code: string, message: string, readonly proto?: number, readonly version?: string) {
    super(message);
  }
}

export interface Pong {
  pid: number; proto: number; version: string; root: string; node: string; startedAt: number; uptimeMs: number;
  runs: number; queued: number; busy: boolean; warm: { index: number; graph: boolean }; idleMs: number;
}

export type Probe =
  | { status: 'live'; meta: DaemonMeta; pong: Pong; compatible: boolean; creds: Credentials }
  | { status: 'absent' }
  /** Files exist but nothing answers at the endpoint: a crashed daemon. Safe to clean up. */
  | { status: 'stale'; meta: DaemonMeta; reason: string }
  /** Something is there but we could not talk to it (busy, wrong token, wrong owner): never touch it. */
  | { status: 'unreachable'; reason: string };

const STALE_ERRNO = new Set(['ECONNREFUSED', 'ENOENT', 'ENOTSOCK']);

function isMeta(v: unknown): v is DaemonMeta {
  const m = v as DaemonMeta;
  return typeof m === 'object' && m !== null && typeof m.endpoint === 'string' && typeof m.pid === 'number' &&
    typeof m.proto === 'number' && typeof m.version === 'string' && typeof m.root === 'string';
}

export async function readCredentials(dirs: DaemonDirs): Promise<Credentials | 'absent' | { unsafe: string }> {
  const dirIssue = await checkSecureDir(dirs.dir);
  if (dirIssue === 'absent') return 'absent';
  if (dirIssue) return { unsafe: dirIssue };
  let meta: unknown;
  try {
    meta = JSON.parse(await fs.readFile(dirs.meta, 'utf8'));
  } catch {
    return 'absent';
  }
  if (!isMeta(meta)) return 'absent';
  const tokText = await readSecureFile(dirs.token);
  if (tokText === 'absent') return 'absent';
  if (typeof tokText !== 'string') return tokText;
  const token = tokText.trim();
  if (token.length < 32) return { unsafe: 'token file is malformed' };
  return { meta, token };
}

export interface RequestOptions {
  /** Pretend to be another client build (tests). */
  proto?: number;
  version?: string;
  signal?: AbortSignal;
  connectTimeoutMs?: number;
  /** Abort the whole exchange after this long (ping/stop); runs have no overall limit. */
  totalTimeoutMs?: number;
  onMessage?: (m: Message) => void;
}

/** Send one authenticated request; resolves with the `result` payload. */
export function sendRequest(creds: Credentials, op: Op, args: Record<string, unknown>, o: RequestOptions = {}): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: creds.meta.endpoint });
    sock.setEncoding('utf8');
    let settled = false;
    let sawOutput = false;
    const timers: NodeJS.Timeout[] = [];
    const done = (fn: () => void) => {
      if (settled) return;
      settled = true;
      timers.forEach(clearTimeout);
      o.signal?.removeEventListener('abort', onAbort);
      sock.destroy();
      fn();
    };
    const fail = (e: DaemonUnavailable | DaemonError) => done(() => reject(e));
    const connectTimer = setTimeout(() => fail(new DaemonUnavailable('timed out connecting to the daemon', 'ETIMEDOUT')), o.connectTimeoutMs ?? 2000);
    timers.push(connectTimer);
    if (o.totalTimeoutMs) timers.push(setTimeout(() => fail(new DaemonUnavailable('daemon did not answer in time', 'ETIMEDOUT', sawOutput)), o.totalTimeoutMs));
    const onAbort = () => {
      if (!sock.destroyed && sock.writable) sock.write(JSON.stringify({ type: 'cancel' }) + '\n');
    };
    o.signal?.addEventListener('abort', onAbort);

    const reader = new LineReader(MAX_MESSAGE_CHARS, (line) => {
      let m: Message;
      try {
        m = JSON.parse(line) as Message;
      } catch {
        return fail(new DaemonUnavailable('daemon sent invalid data', 'EPROTO', sawOutput));
      }
      sawOutput = true;
      if (m.type === 'result') return done(() => resolve(m.data));
      if (m.type === 'error') return fail(new DaemonError(m.code, m.message, m.proto, m.version));
      o.onMessage?.(m);
    }, () => fail(new DaemonUnavailable('daemon sent an oversized message', 'EPROTO', sawOutput)));

    sock.on('connect', () => {
      clearTimeout(connectTimer);
      sock.write(JSON.stringify({ proto: o.proto ?? PROTO, client: o.version ?? VERSION, token: creds.token, op, args }) + '\n');
      if (o.signal?.aborted) onAbort();
    });
    sock.on('data', (c: string) => reader.push(c));
    sock.on('error', (e) => fail(new DaemonUnavailable(`daemon connection failed: ${e.message}`, (e as NodeJS.ErrnoException).code ?? null, sawOutput)));
    sock.on('close', () => fail(new DaemonUnavailable('daemon closed the connection without answering', 'ECLOSED', sawOutput)));
  });
}

/** Liveness is decided by an authenticated round trip, never by file existence or a pid. */
export async function probeDaemon(dirs: DaemonDirs, o: { timeoutMs?: number } = {}): Promise<Probe> {
  const c = await readCredentials(dirs);
  if (c === 'absent') return { status: 'absent' };
  if ('unsafe' in c) return { status: 'unreachable', reason: c.unsafe };
  try {
    const pong = (await sendRequest(c, 'ping', {}, { totalTimeoutMs: o.timeoutMs ?? 3000 })) as Pong;
    return { status: 'live', meta: c.meta, pong, compatible: pong.proto === PROTO && pong.version === VERSION, creds: c };
  } catch (e) {
    if (e instanceof DaemonUnavailable && e.errno && STALE_ERRNO.has(e.errno)) {
      return { status: 'stale', meta: c.meta, reason: `nothing is listening (${e.errno})` };
    }
    return { status: 'unreachable', reason: (e as Error).message };
  }
}

/**
 * Remove the endpoint, token and metadata. With `onlyPid`, only if the metadata still names that
 * pid, so we cannot delete the files of a daemon that started after we looked.
 */
export async function removeEndpointFiles(dirs: DaemonDirs, onlyPid?: number): Promise<void> {
  if (onlyPid !== undefined) {
    try {
      const meta = JSON.parse(await fs.readFile(dirs.meta, 'utf8')) as { pid?: number };
      if (meta.pid !== onlyPid) return;
    } catch { /* unreadable: ours or nobody's; fall through only if it is gone */ return; }
  }
  await fs.rm(dirs.meta, { force: true });
  await fs.rm(dirs.token, { force: true });
  if (process.platform !== 'win32') await fs.rm(dirs.socket, { force: true });
}

const sleepMs = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/**
 * Take the per-project lifecycle lock (a directory holding an owner nonce). `onWait` runs while
 * another holder has it (the daemon uses it to notice that a live daemon appeared). A lock older than
 * 15 s is considered abandoned and is moved aside atomically (only one breaker wins). The returned
 * release removes the lock only if it still carries OUR nonce, so a lock that was broken and re-taken
 * is never released by its previous owner. Residual: breaking races the stat with the rename; the
 * effect is limited to two starters briefly overlapping, which the atomic endpoint bind still serialises.
 */
export async function acquireLock(dirs: DaemonDirs, o: { timeoutMs?: number; onWait?: () => Promise<void> } = {}): Promise<() => Promise<void>> {
  const nonce = `${randomBytes(8).toString('hex')}:${Date.now()}`;
  const deadline = Date.now() + (o.timeoutMs ?? 10_000);
  let missingSince: number | null = null;
  while (Date.now() < deadline) {
    try {
      await fs.mkdir(dirs.lock);
      await fs.writeFile(`${dirs.lock}/owner`, nonce, { flag: 'wx', mode: 0o600 });
      return async () => {
        const cur = await fs.readFile(`${dirs.lock}/owner`, 'utf8').catch(() => null);
        if (cur === nonce) await fs.rm(dirs.lock, { recursive: true, force: true });
      };
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    }
    const owner = await fs.readFile(`${dirs.lock}/owner`, 'utf8').catch(() => null);
    if (owner === null) missingSince ??= Date.now();
    else missingSince = null;
    // A lock whose owner file never appeared (holder died between mkdir and write) ages from first sight.
    const ts = owner ? Number(owner.split(':')[1]) : (missingSince ?? NaN);
    if (Number.isFinite(ts) && Date.now() - ts > 15_000) {
      const aside = `${dirs.lock}.dead-${randomBytes(4).toString('hex')}`;
      try {
        await fs.rename(dirs.lock, aside); // atomic: exactly one breaker succeeds
        await fs.rm(aside, { recursive: true, force: true });
      } catch { /* someone else broke it first */ }
      continue;
    }
    await o.onWait?.();
    await sleepMs(100);
  }
  throw new Error('timed out waiting for the daemon lifecycle lock');
}

/** Remove a crashed daemon's files, under the lifecycle lock and only if it is still stale. */
export async function cleanupStale(dirs: DaemonDirs): Promise<void> {
  let release: (() => Promise<void>) | null = null;
  try {
    release = await acquireLock(dirs, { timeoutMs: 3000 });
  } catch {
    return; // someone is starting a daemon: leave everything alone
  }
  try {
    const p = await probeDaemon(dirs, { timeoutMs: 1000 });
    if (p.status === 'stale') await removeEndpointFiles(dirs, p.meta.pid);
  } finally {
    await release();
  }
}

export const defaultEntry = (): string => fileURLToPath(new URL('../../../bin/buildrush.js', import.meta.url));

export interface StartOptions {
  entry?: string;
  env?: NodeJS.ProcessEnv;
  idleMs?: number;
  timeoutMs?: number;
}

/** Spawn a detached daemon for `root` and wait until it answers a ping. */
export async function spawnDaemon(root: string, dirs: DaemonDirs, o: StartOptions = {}): Promise<Probe> {
  const env = { ...(o.env ?? process.env) };
  if (o.idleMs !== undefined) env.BUILDRUSH_DAEMON_IDLE_MS = String(o.idleMs);
  // The daemon runs with a different cwd: hand it the base directory this process resolved, never a relative one.
  if (env.BUILDRUSH_DAEMON_DIR) env.BUILDRUSH_DAEMON_DIR = resolveBaseDir(env);
  const child = spawn(process.execPath, [o.entry ?? defaultEntry(), 'daemon', '__serve', '--root', root], {
    // cwd is not the project: a daemon must never pin the project directory (Windows cannot delete it then).
    detached: true, stdio: 'ignore', windowsHide: true, env, cwd: os.tmpdir(),
  });
  let exited: number | null | undefined;
  child.once('exit', (code) => { exited = code; });
  child.once('error', () => { exited = -1; });
  child.unref();
  const deadline = Date.now() + (o.timeoutMs ?? 15_000);
  let last: Probe = { status: 'absent' };
  while (Date.now() < deadline) {
    last = await probeDaemon(dirs, { timeoutMs: 1000 });
    if (last.status === 'live') return last;
    // The child exits quietly with 0 when a concurrent starter won the race: keep probing for that daemon.
    if (exited !== undefined && exited !== 0) return last;
    await new Promise((r) => setTimeout(r, 50));
  }
  return last;
}

export async function stopDaemon(dirs: DaemonDirs, probe: Extract<Probe, { status: 'live' }>, waitMs = 8000): Promise<boolean> {
  try {
    await sendRequest(probe.creds, 'stop', {}, { totalTimeoutMs: 3000 });
  } catch (e) {
    if (e instanceof DaemonError) return false;
    /* the connection may drop as the daemon exits: verify below */
  }
  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    const p = await probeDaemon(dirs, { timeoutMs: 500 });
    if (p.status === 'absent' || p.status === 'stale') return true;
    await new Promise((r) => setTimeout(r, 50));
  }
  return false;
}
