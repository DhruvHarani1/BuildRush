import * as fs from 'node:fs/promises';
import { findProjectRoot } from '../config.js';
import {
  DaemonError, DaemonUnavailable, Probe, probeDaemon, removeEndpointFiles, sendRequest, spawnDaemon, stopDaemon, StartOptions,
} from './client.js';
import { DaemonDirs, daemonDirs } from './paths.js';
import { Message, Op, VERSION } from './protocol.js';
import { AlreadyRunningError, DaemonServer } from './server.js';

export interface DaemonFlags {
  daemon?: boolean;
  noDaemon?: boolean;
  json: boolean;
  verbose: boolean;
  quiet: boolean;
}

export const DEFAULT_IDLE_MS = 10 * 60 * 1000;

/** Opt-in only: a plain `buildrush run` never looks for, starts or talks to a daemon. */
export function daemonWanted(f: Pick<DaemonFlags, 'daemon' | 'noDaemon'>, env: NodeJS.ProcessEnv = process.env): boolean {
  if (f.noDaemon) return false;
  if (f.daemon) return true;
  return env.BUILDRUSH_DAEMON === '1' || env.BUILDRUSH_DAEMON === 'true';
}

export function idleMsFromEnv(env: NodeJS.ProcessEnv = process.env): number {
  const n = Number(env.BUILDRUSH_DAEMON_IDLE_MS);
  return env.BUILDRUSH_DAEMON_IDLE_MS !== undefined && Number.isFinite(n) && n >= 0 ? n : DEFAULT_IDLE_MS;
}

async function locate(startDir: string): Promise<{ root: string; dirs: DaemonDirs } | null> {
  const found = await findProjectRoot(startDir);
  if (!found) return null;
  const root = await fs.realpath(found);
  return { root, dirs: daemonDirs(root) };
}

export type DaemonOutcome<T> = { ok: true; data: T } | { ok: false; reason: string };

/**
 * Try to serve `op` from the project's daemon (starting it if needed). Never throws and never
 * has side effects on the project: ANY failure is reported as `ok: false` and the caller simply
 * runs the same operation in-process.
 */
export async function tryDaemon<T>(
  startDir: string,
  op: Extract<Op, 'run' | 'analyze' | 'cacheStats'>,
  args: Record<string, unknown>,
  hooks: { signal?: AbortSignal; onMessage?: (m: Message) => void; start?: StartOptions; version?: string; proto?: number } = {},
): Promise<DaemonOutcome<T>> {
  try {
    const loc = await locate(startDir);
    if (!loc) return { ok: false, reason: 'no project' };
    const { root, dirs } = loc;
    let pr: Probe = await probeDaemon(dirs);
    if (pr.status === 'stale') {
      await removeEndpointFiles(dirs, pr.meta.pid);
      pr = { status: 'absent' };
    }
    if (pr.status === 'live' && !pr.compatible) {
      // An older/newer daemon: ask it to exit, then start one that matches this client.
      await stopDaemon(dirs, pr);
      pr = { status: 'absent' };
    }
    if (pr.status === 'absent') pr = await spawnDaemon(root, dirs, hooks.start);
    if (pr.status !== 'live') return { ok: false, reason: pr.status === 'unreachable' ? pr.reason : 'daemon did not start' };
    if (!pr.compatible) return { ok: false, reason: 'daemon version mismatch' };
    const data = await sendRequest(pr.creds, op, { cwd: startDir, env: process.env, ...args }, {
      signal: hooks.signal, onMessage: hooks.onMessage, version: hooks.version, proto: hooks.proto,
    });
    return { ok: true, data: data as T };
  } catch (e) {
    if (e instanceof DaemonError && e.code === 'version_mismatch') {
      try {
        const loc = await locate(startDir);
        if (loc) {
          const p = await probeDaemon(loc.dirs);
          if (p.status === 'live') await stopDaemon(loc.dirs, p);
        }
      } catch { /* best effort */ }
    }
    const partial = e instanceof DaemonUnavailable && e.sawOutput;
    return { ok: false, reason: `${(e as Error).message}${partial ? ' (mid-run)' : ''}` };
  }
}

// ---- `buildrush daemon start|stop|status` --------------------------------------------------------

export async function cmdDaemon(sub: string | undefined, startDir: string, f: DaemonFlags, rest: string[]): Promise<number> {
  if (sub === '__serve') return serve(startDir);
  if (sub !== 'start' && sub !== 'stop' && sub !== 'status') throw new Error('usage: buildrush daemon start|stop|status');
  const loc = await locate(startDir);
  if (!loc) throw new Error('no buildrush.json found (run `buildrush init`)');
  const { root, dirs } = loc;
  const say = (human: string, json: unknown) => (f.json ? console.log(JSON.stringify(json, null, 2)) : console.log(human));
  void rest;

  let pr = await probeDaemon(dirs);
  if (pr.status === 'stale') {
    await removeEndpointFiles(dirs, pr.meta.pid);
    if (!f.json && sub !== 'status') console.log(`removed stale daemon files (${pr.reason})`);
    pr = { status: 'absent' };
  }

  if (sub === 'status') {
    if (pr.status === 'live') {
      const p = pr.pong;
      say(
        `daemon running for ${root}\n  pid ${p.pid}, up ${Math.round(p.uptimeMs / 1000)}s, ${p.runs} request(s), ${p.busy ? 'busy' : 'idle'}, ${p.queued} queued\n` +
          `  protocol ${p.proto}, BuildRush ${p.version}${pr.compatible ? '' : `  (this CLI is ${VERSION}: incompatible, will be replaced on next use)`}\n` +
          `  warm: ${p.warm.index} indexed file(s), dependency graph ${p.warm.graph ? 'cached' : 'not built yet'}; idle exit after ${Math.round(p.idleMs / 1000)}s`,
        { running: true, ...p, compatible: pr.compatible },
      );
      return 0;
    }
    if (pr.status === 'unreachable') {
      say(`daemon state unknown: ${pr.reason}`, { running: false, root, unreachable: pr.reason });
      return 1;
    }
    say('daemon not running', { running: false, root });
    return 1;
  }

  if (sub === 'stop') {
    if (pr.status === 'live') {
      const ok = await stopDaemon(dirs, pr);
      say(ok ? 'daemon stopped' : `daemon did not stop within the timeout (pid ${pr.pong.pid}); end that process manually`, { stopped: ok });
      return ok ? 0 : 1;
    }
    if (pr.status === 'unreachable') {
      say(`cannot stop: ${pr.reason}`, { stopped: false, reason: pr.reason });
      return 1;
    }
    say('daemon not running', { stopped: false, running: false });
    return 0;
  }

  // start
  if (pr.status === 'live' && pr.compatible) {
    say(`daemon already running (pid ${pr.pong.pid})`, { started: false, running: true, pid: pr.pong.pid });
    return 0;
  }
  if (pr.status === 'live') {
    if (!(await stopDaemon(dirs, pr))) {
      say(`an incompatible daemon (pid ${pr.pong.pid}, BuildRush ${pr.pong.version}) would not exit`, { started: false });
      return 1;
    }
  } else if (pr.status === 'unreachable') {
    say(`cannot start: an endpoint exists but is not answering (${pr.reason})`, { started: false, reason: pr.reason });
    return 1;
  }
  const started = await spawnDaemon(root, dirs);
  if (started.status === 'live') {
    say(`daemon started (pid ${started.pong.pid}); idle exit after ${Math.round(started.pong.idleMs / 1000)}s`, { started: true, pid: started.pong.pid });
    return 0;
  }
  say(`daemon failed to start; see ${dirs.log}`, { started: false, log: dirs.log });
  return 1;
}

/** The daemon process itself (`buildrush daemon __serve`, spawned detached by `daemon start`). */
async function serve(startDir: string): Promise<number> {
  const loc = await locate(startDir);
  if (!loc) return 2;
  let server: DaemonServer;
  try {
    server = await DaemonServer.start({ root: loc.root, idleMs: idleMsFromEnv() });
  } catch (e) {
    if (e instanceof AlreadyRunningError) return 0; // lost a harmless race with another starter
    try {
      await fs.appendFile(loc.dirs.log, `${new Date().toISOString()} failed to start: ${(e as Error).message}\n`, { mode: 0o600 });
    } catch { /* nowhere to report */ }
    return 1;
  }
  const down = (why: string) => void server.shutdown(why);
  process.on('SIGINT', () => down('SIGINT'));
  process.on('SIGTERM', () => down('SIGTERM'));
  process.on('uncaughtException', (e) => {
    void server.shutdown(`uncaught exception: ${e.message}`).finally(() => process.exit(1));
  });
  process.on('unhandledRejection', (e) => {
    void server.shutdown(`unhandled rejection: ${(e as Error)?.message ?? String(e)}`).finally(() => process.exit(1));
  });
  await server.closed;
  setTimeout(() => process.exit(0), 2000).unref(); // backstop: nothing may keep an exiting daemon alive
  return 0;
}
