import * as fs from 'node:fs/promises';
import { constants as fsc, lstatSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';

/**
 * Where a project's daemon keeps its endpoint, token and metadata.
 *
 * Everything lives in a per-user directory OUTSIDE the project tree:
 *   POSIX   $XDG_RUNTIME_DIR/buildrush            (only if that directory is ours and mode 0700), else
 *           ${XDG_CACHE_HOME:-~/.cache}/buildrush/run   (under the user's own home)
 *   Windows %LOCALAPPDATA%\BuildRush\daemon        (per-user profile ACL)
 * Never the shared temp directory: if no private per-user location exists the daemon is unavailable
 * (callers fall back to one-shot), it is not relocated to /tmp.
 *   override: BUILDRUSH_DAEMON_DIR (tests, unusual setups); validated exactly like the defaults.
 * Each project gets its own 0700 subdirectory keyed by a hash of its realpath.
 */
export interface DaemonDirs {
  base: string;
  /** Per-project directory (0700). */
  dir: string;
  key: string;
  token: string;
  meta: string;
  log: string;
  /** Held (as a directory) while a daemon is starting; serialises concurrent starters. */
  lock: string;
  /** POSIX: the Unix socket path (inside `dir`). Windows: unused (the pipe name is in meta). */
  socket: string;
}

export interface DaemonMeta {
  proto: number;
  version: string;
  pid: number;
  root: string;
  /** Unix socket path or Windows pipe name. */
  endpoint: string;
  startedAt: number;
  node: string;
}

const isWin = process.platform === 'win32';

export function normalizeRoot(root: string): string {
  return isWin ? root.toLowerCase() : root;
}

export function projectKey(root: string): string {
  return createHash('sha256').update('buildrush-daemon\0' + normalizeRoot(root)).digest('hex').slice(0, 16);
}

export function resolveBaseDir(env: NodeJS.ProcessEnv = process.env): string {
  if (env.BUILDRUSH_DAEMON_DIR) return path.resolve(env.BUILDRUSH_DAEMON_DIR);
  if (isWin) {
    if (env.LOCALAPPDATA && path.isAbsolute(env.LOCALAPPDATA)) return path.join(env.LOCALAPPDATA, 'BuildRush', 'daemon');
    throw new Error('no per-user location for daemon state (LOCALAPPDATA is not set)');
  }
  const rt = env.XDG_RUNTIME_DIR;
  if (rt && path.isAbsolute(rt) && privateOwnDir(rt)) return path.join(rt, 'buildrush');
  const cacheHome = env.XDG_CACHE_HOME && path.isAbsolute(env.XDG_CACHE_HOME) ? env.XDG_CACHE_HOME : env.HOME && path.isAbsolute(env.HOME) ? path.join(env.HOME, '.cache') : null;
  if (!cacheHome) throw new Error('no per-user location for daemon state (set XDG_RUNTIME_DIR, XDG_CACHE_HOME or HOME)');
  return path.join(cacheHome, 'buildrush', 'run');
}

/** XDG_RUNTIME_DIR is only trusted if it is a real directory owned by us with no group/other access. */
function privateOwnDir(dir: string): boolean {
  try {
    const st = lstatSync(dir);
    return st.isDirectory() && (typeof process.getuid !== 'function' || st.uid === process.getuid()) && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

/** sun_path is 104 bytes on macOS/BSD and 108 on Linux; stay below the smaller. */
const MAX_SOCKET_PATH = 100;

export function daemonDirs(root: string, env: NodeJS.ProcessEnv = process.env): DaemonDirs {
  const base = resolveBaseDir(env);
  const key = projectKey(root);
  const dir = path.join(base, key);
  let socket = path.join(dir, 's');
  if (!isWin && Buffer.byteLength(socket) > MAX_SOCKET_PATH) socket = path.join(base, `${key.slice(0, 8)}.s`); // shorter, still inside the 0700 base
  if (!isWin) assertSocketPathFits(socket); // too long even so: daemon unavailable, never relocated to /tmp
  return {
    base, dir, key,
    token: path.join(dir, 'token'),
    meta: path.join(dir, 'daemon.json'),
    log: path.join(dir, 'log'),
    lock: path.join(dir, 'starting'),
    socket,
  };
}

export function assertSocketPathFits(p: string): void {
  if (!isWin && Buffer.byteLength(p) > MAX_SOCKET_PATH) {
    throw new Error(`daemon socket path is too long for this OS (${Buffer.byteLength(p)} > ${MAX_SOCKET_PATH} bytes): ${p}; the daemon is disabled for this project (set BUILDRUSH_DAEMON_DIR to a shorter private directory)`);
  }
}

/** A fresh, unguessable Windows pipe name (pipes live in one global namespace). */
export function newPipeName(key: string): string {
  return `\\\\.\\pipe\\buildrush-${key}-${randomBytes(8).toString('hex')}`;
}

function posixOwnerCheck(st: import('node:fs').Stats, what: string): void {
  if (typeof process.getuid === 'function' && st.uid !== process.getuid()) {
    throw new Error(`${what} is not owned by the current user; refusing to use it`);
  }
}

/**
 * Create `dir` if needed and make sure it is a real directory, owned by us and (POSIX) mode 0700.
 * A pre-existing directory we own with loose permissions is tightened; anything else is refused.
 * Windows: a directory we create is restricted to the current user via icacls (best effort).
 */
export async function ensureSecureDir(dir: string): Promise<{ created: boolean; acl: 'restricted' | 'inherited' | 'n/a' }> {
  await fs.mkdir(path.dirname(dir), { recursive: true });
  let created = true;
  try {
    await fs.mkdir(dir, { mode: 0o700 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e;
    created = false;
  }
  if (isWin) return { created, acl: created ? ((await restrictWindowsAcl(dir)) ? 'restricted' : 'inherited') : 'inherited' };
  // Everything below goes through ONE directory handle opened without following symlinks, so the
  // checks and the chmod apply to the very object that was checked (no check-then-use race).
  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fs.open(dir, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0) | (fsc.O_DIRECTORY ?? 0));
  } catch (e) {
    throw new Error(`${dir} is not a plain directory; refusing to use it (${(e as NodeJS.ErrnoException).code})`);
  }
  try {
    let st = await fh.stat();
    if (!st.isDirectory()) throw new Error(`${dir} is not a plain directory; refusing to use it`);
    posixOwnerCheck(st, dir);
    if ((st.mode & 0o077) !== 0) {
      await fh.chmod(0o700);
      st = await fh.stat();
      if ((st.mode & 0o077) !== 0) throw new Error(`cannot restrict ${dir} to mode 0700`);
    }
  } finally {
    await fh.close();
  }
  return { created, acl: 'n/a' };
}

/** Read-only variant used by clients: never creates or repairs anything. Returns a reason when unsafe. */
export async function checkSecureDir(dir: string): Promise<string | null> {
  try {
    const st = await fs.lstat(dir);
    if (st.isSymbolicLink() || !st.isDirectory()) return `${dir} is not a plain directory`;
    if (!isWin) {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return `${dir} is owned by another user`;
      if ((st.mode & 0o077) !== 0) return `${dir} is accessible by other users (mode ${(st.mode & 0o777).toString(8)})`;
    }
    return null;
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === 'ENOENT' ? 'absent' : (e as Error).message;
  }
}

/**
 * Read a secret file through a single no-follow handle, verifying type, owner and mode on that same
 * handle (no check-then-use race). Returns the text, 'absent', or { unsafe: reason }.
 */
export async function readSecureFile(file: string): Promise<string | 'absent' | { unsafe: string }> {
  let fh: import('node:fs/promises').FileHandle;
  try {
    fh = await fs.open(file, fsc.O_RDONLY | (fsc.O_NOFOLLOW ?? 0));
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? 'absent' : { unsafe: `${file}: ${code}` };
  }
  try {
    const st = await fh.stat();
    if (!st.isFile()) return { unsafe: `${file} is not a regular file` };
    if (!isWin) {
      if (typeof process.getuid === 'function' && st.uid !== process.getuid()) return { unsafe: `${file} is owned by another user` };
      if ((st.mode & 0o077) !== 0) return { unsafe: `${file} is accessible by other users` };
    }
    return await fh.readFile('utf8');
  } finally {
    await fh.close();
  }
}

/** Write a secret: never follows an existing path, mode 0600 from the first byte. */
export async function writeSecretFile(file: string, data: string): Promise<void> {
  await fs.rm(file, { force: true });
  await fs.writeFile(file, data, { mode: 0o600, flag: 'wx' });
}

function run(cmd: string, args: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    try {
      execFile(cmd, args, { timeout: 10_000, windowsHide: true }, (err) => resolve(!err));
    } catch {
      resolve(false);
    }
  });
}

/**
 * Grant the current user full control, then drop inherited entries so only that user (plus the
 * ACEs we do not remove explicitly: none) remains. The grant happens first and the inheritance
 * change only if the grant worked, so a failure can never lock the user out of their own directory.
 */
async function restrictWindowsAcl(dir: string): Promise<boolean> {
  const name = process.env.USERNAME || os.userInfo().username;
  const account = process.env.USERDOMAIN ? `${process.env.USERDOMAIN}\\${name}` : name;
  if (!(await run('icacls', [dir, '/grant:r', `${account}:(OI)(CI)F`]))) return false;
  return run('icacls', [dir, '/inheritance:r']);
}
