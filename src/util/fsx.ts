import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { randomBytes } from 'node:crypto';

export function tmpName(dir: string): string {
  return path.join(dir, `.tmp-${process.pid}-${randomBytes(6).toString('hex')}`);
}

/** Write a file atomically (temp file in same directory + rename). */
export async function writeFileAtomic(file: string, data: string | Uint8Array, mode = 0o600): Promise<void> {
  const tmp = tmpName(path.dirname(file));
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  try {
    await fs.writeFile(tmp, data, { mode });
    await fs.rename(tmp, file);
  } catch (e) {
    await fs.rm(tmp, { force: true });
    throw e;
  }
}

export async function readJson<T>(file: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(file, 'utf8')) as T;
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || e instanceof SyntaxError) return null;
    throw e;
  }
}

export async function exists(p: string): Promise<boolean> {
  try {
    await fs.lstat(p);
    return true;
  } catch {
    return false;
  }
}
