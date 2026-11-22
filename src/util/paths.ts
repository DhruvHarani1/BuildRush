import * as path from 'node:path';
import * as fs from 'node:fs/promises';

/** Thrown when a manifest/config path would escape its root or is otherwise malformed. */
export class UnsafePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UnsafePathError';
  }
}

export function toPosix(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

/**
 * Validate a project-relative POSIX path coming from an untrusted source
 * (cache manifest, config). Returns the normalised path or throws.
 */
export function safeRelative(rel: string): string {
  if (typeof rel !== 'string' || rel.length === 0) throw new UnsafePathError('empty path');
  if (rel.includes('\0')) throw new UnsafePathError('NUL byte in path');
  if (rel.includes('\\')) throw new UnsafePathError(`backslash in path: ${JSON.stringify(rel)}`);
  if (path.posix.isAbsolute(rel) || /^[a-zA-Z]:/.test(rel)) {
    throw new UnsafePathError(`absolute path not allowed: ${JSON.stringify(rel)}`);
  }
  const n = path.posix.normalize(rel);
  if (n === '.' || n === '..' || n.startsWith('../')) {
    throw new UnsafePathError(`path escapes project root: ${JSON.stringify(rel)}`);
  }
  return n;
}

/** Resolve a validated relative path inside `root` (which must already be a realpath). */
export function resolveInside(root: string, rel: string): string {
  const n = safeRelative(rel);
  const abs = path.resolve(root, ...n.split('/'));
  if (abs !== root && !abs.startsWith(root + path.sep)) {
    throw new UnsafePathError(`path escapes project root: ${JSON.stringify(rel)}`);
  }
  return abs;
}

/**
 * Refuse to write through a symlink: every existing component of `rel`
 * below `root` (including the final one) must not be a symlink.
 */
export async function assertNoSymlinkInPath(root: string, rel: string): Promise<void> {
  const parts = safeRelative(rel).split('/');
  let cur = root;
  for (const part of parts) {
    cur = path.join(cur, part);
    let st;
    try {
      st = await fs.lstat(cur);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw e;
    }
    if (st.isSymbolicLink()) {
      throw new UnsafePathError(`refusing to write through symlink: ${toPosix(path.relative(root, cur))}`);
    }
  }
}
