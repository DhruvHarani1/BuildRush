import * as fs from 'node:fs';
import * as fsp from 'node:fs/promises';
import * as path from 'node:path';
import { toPosix } from './util/paths.js';

/**
 * Raw filesystem change notification. Events are only ever a *hint that something may have
 * changed*: consumers must reconcile against file content (FileIndex digests) before acting.
 */
export type WatchMode = 'recursive' | 'per-directory';

export interface WatcherHandle {
  mode: WatchMode;
  close(): void;
}

export interface WatcherOptions {
  root: string;
  /** True for project-relative POSIX paths that must not produce events (.git, outputs, ...). */
  isIgnored: (rel: string) => boolean;
  /** `rel` is project-relative (POSIX) or null when the OS did not say which path changed. */
  onEvent: (rel: string | null) => void;
  /** Watcher failure or possible event loss: the consumer must run a full reconciliation scan. */
  onError: (e: Error) => void;
  mode?: WatchMode;
}

export type WatcherFactory = (o: WatcherOptions) => WatcherHandle | Promise<WatcherHandle>;

/**
 * Windows and macOS have a native recursive watch (one handle for the whole tree). On Linux
 * Node's recursive fs.watch (Node >= 20) is a userland emulation that adds an inotify watch for
 * every directory it finds, including node_modules and .git, and cannot be told to skip them.
 * We therefore register one non-recursive watcher per directory there, skipping ignored trees.
 */
export function defaultWatchMode(): WatchMode {
  return process.platform === 'win32' || process.platform === 'darwin' ? 'recursive' : 'per-directory';
}

export const createFsWatcher: WatcherFactory = (o) => {
  const mode = o.mode ?? defaultWatchMode();
  return mode === 'recursive' ? watchRecursive(o) : watchPerDirectory(o);
};

function watchRecursive(o: WatcherOptions): WatcherHandle {
  let closed = false;
  const w = fs.watch(o.root, { recursive: true, persistent: true }, (_ev, filename) => {
    if (closed) return;
    if (filename === null || filename === undefined) return o.onEvent(null);
    const rel = toPosix(String(filename));
    if (!o.isIgnored(rel)) o.onEvent(rel);
  });
  w.on('error', (e) => { if (!closed) o.onError(e); });
  return { mode: 'recursive', close: () => { closed = true; w.close(); } };
}

function watchPerDirectory(o: WatcherOptions): WatcherHandle {
  let closed = false;
  const watchers = new Map<string, fs.FSWatcher>();
  const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);

  const dropTree = (rel: string) => {
    for (const [d, w] of watchers) {
      if (d === rel || d.startsWith(rel + '/')) { w.close(); watchers.delete(d); }
    }
  };

  const watchDir = (dirRel: string): void => {
    if (closed || watchers.has(dirRel)) return;
    let w: fs.FSWatcher;
    try {
      w = fs.watch(dirRel ? path.join(o.root, dirRel) : o.root, { persistent: true }, (_ev, filename) => {
        if (closed) return;
        if (filename === null || filename === undefined) return o.onEvent(null);
        const rel = join(dirRel, String(filename));
        if (o.isIgnored(rel)) return;
        void (async () => {
          // A new directory must be watched *before* we report, and anything created inside it
          // before the watcher attached is found by the reconciliation scan the event triggers.
          try {
            const st = await fsp.lstat(path.join(o.root, rel));
            if (st.isDirectory() && !watchers.has(rel)) await addTree(rel);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code === 'ENOENT') dropTree(rel);
          }
          if (!closed) o.onEvent(rel);
        })();
      });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') return; // vanished while walking
      o.onError(e as Error); // ENOSPC / EMFILE: inotify limits; degrade to polling reconciliation
      return;
    }
    w.on('error', (e) => {
      const code = (e as NodeJS.ErrnoException).code;
      w.close();
      watchers.delete(dirRel);
      if (closed) return;
      // The directory itself disappearing is normal churn, but the parent event covers it; any
      // other failure may have lost events.
      if (code !== 'ENOENT' && code !== 'EPERM') o.onError(e);
      else o.onEvent(dirRel || null);
    });
    watchers.set(dirRel, w);
  };

  const addTree = async (dirRel: string): Promise<void> => {
    if (closed) return;
    watchDir(dirRel);
    let ents: fs.Dirent[];
    try {
      ents = await fsp.readdir(dirRel ? path.join(o.root, dirRel) : o.root, { withFileTypes: true });
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT' || code === 'EACCES') return;
      throw e;
    }
    for (const ent of ents) {
      if (!ent.isDirectory()) continue; // symlinks are never followed (matches FileIndex)
      const rel = join(dirRel, ent.name);
      if (!o.isIgnored(rel)) await addTree(rel);
    }
  };

  // Arm synchronously for the root so no event window opens before the walk finishes; subdirs
  // follow. The session performs a reconciliation scan after arming, so nothing is lost.
  watchDir('');
  const armed = addTree('').catch((e) => o.onError(e as Error));
  const handle: WatcherHandle & { armed: Promise<void> } = {
    mode: 'per-directory',
    armed,
    close: () => {
      closed = true;
      for (const w of watchers.values()) w.close();
      watchers.clear();
    },
  };
  return handle;
}

/** Resolves once a handle's initial directory walk has registered all watchers (if it has one). */
export async function whenArmed(h: WatcherHandle): Promise<void> {
  const a = (h as { armed?: Promise<void> }).armed;
  if (a) await a;
}
