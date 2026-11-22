import { spawn } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';

export interface RunResult {
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  log: string;
  timedOut: boolean;
  cancelled: boolean;
  spawnError: string | null;
}

const SECRET_NAME = /(TOKEN|SECRET|PASSWORD|PASSWD|CREDENTIAL|API_?KEY|PRIVATE_?KEY|AUTH|COOKIE|SESSION)/i;
const MAX_LOG_BYTES = 8 * 1024 * 1024;
const KILL_GRACE_MS = 5000;

export function isSecretName(name: string): boolean {
  return SECRET_NAME.test(name);
}

/** Replace the values of secret-looking env vars wherever they appear in `text`. */
export function makeRedactor(env: Record<string, string | undefined>): (text: string) => string {
  const secrets = Object.entries(env)
    .filter(([k, v]) => isSecretName(k) && typeof v === 'string' && v.length >= 6)
    .map(([, v]) => v as string)
    .sort((a, b) => b.length - a.length);
  if (secrets.length === 0) return (t) => t;
  return (t) => {
    let out = t;
    for (const s of secrets) out = out.split(s).join('***');
    return out;
  };
}

/** Find an executable without a shell: explicit path, project node_modules/.bin, then PATH. */
export function resolveExecutable(cmd: string, cwd: string, root: string, pathEnv: string): string | null {
  const isExec = (p: string) => {
    try {
      fs.accessSync(p, fs.constants.X_OK);
      return fs.statSync(p).isFile();
    } catch {
      return false;
    }
  };
  if (cmd.includes('/') || cmd.includes(path.sep)) {
    const abs = path.resolve(cwd, cmd);
    return isExec(abs) ? abs : null;
  }
  const dirs = [path.join(cwd, 'node_modules', '.bin'), path.join(root, 'node_modules', '.bin'), ...pathEnv.split(path.delimiter)];
  const exts = process.platform === 'win32' ? ['.exe', '.cmd', '.bat', ''] : [''];
  for (const d of dirs) {
    if (!d) continue;
    for (const e of exts) {
      const p = path.join(d, cmd + e);
      if (isExec(p)) return p;
    }
  }
  return null;
}

export function runCommand(opts: {
  file: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number | null;
  redact: (s: string) => string;
}): Promise<RunResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(opts.file, opts.args, {
        cwd: opts.cwd,
        env: opts.env,
        stdio: ['ignore', 'pipe', 'pipe'],
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
      });
    } catch (e) {
      resolve({ exitCode: null, signal: null, durationMs: 0, log: '', timedOut: false, cancelled: false, spawnError: (e as Error).message });
      return;
    }
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    const onData = (d: Buffer) => {
      if (size >= MAX_LOG_BYTES) {
        truncated = true;
        return;
      }
      chunks.push(d);
      size += d.length;
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    let timedOut = false;
    let cancelled = false;
    let spawnError: string | null = null;
    let killTimer: NodeJS.Timeout | undefined;
    const kill = (sig: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch { /* already gone */ }
    };
    const terminate = () => {
      kill('SIGTERM');
      killTimer = setTimeout(() => kill('SIGKILL'), KILL_GRACE_MS);
      killTimer.unref();
    };
    const onAbort = () => {
      cancelled = true;
      terminate();
    };
    if (opts.signal) {
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    }
    const timer = opts.timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          terminate();
        }, opts.timeoutMs)
      : undefined;
    child.on('error', (e) => {
      spawnError = e.message;
    });
    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      opts.signal?.removeEventListener('abort', onAbort);
      let log = opts.redact(Buffer.concat(chunks).toString('utf8'));
      if (truncated) log += '\n[buildrush: output truncated at 8 MiB]\n';
      resolve({ exitCode: code, signal, durationMs: Date.now() - start, log, timedOut, cancelled, spawnError });
    });
  });
}
