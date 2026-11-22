import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { findProjectRoot, loadConfig } from './config.js';
import { detectProject } from './detect.js';
import { Cache } from './cache.js';
import { resolveExecutable } from './runner.js';

const pexec = promisify(execFile);

export interface Check {
  name: string;
  status: 'ok' | 'warn' | 'fail';
  detail: string;
}

export async function runDoctor(start: string): Promise<Check[]> {
  const out: Check[] = [];
  const add = (name: string, status: Check['status'], detail: string) => out.push({ name, status, detail });

  const major = Number(process.versions.node.split('.')[0]);
  add('node', major >= 22 ? 'ok' : 'fail', `v${process.versions.node}${major >= 22 ? '' : ' (BuildRush requires >= 22)'}`);
  add('platform', process.platform === 'win32' ? 'warn' : 'ok', process.platform === 'win32'
    ? 'Windows is untested: .cmd shims cannot be spawned without a shell, so npm-installed tools may not resolve'
    : `${process.platform}/${process.arch}`);
  if (typeof process.getuid === 'function' && process.getuid() === 0) {
    add('privileges', 'warn', 'running as root: task commands from the project config will run as root. Use an unprivileged user.');
  } else add('privileges', 'ok', 'not running as root');

  const root = await findProjectRoot(start);
  if (!root) {
    add('config', 'fail', 'no buildrush.json found (run `buildrush init`)');
    return out;
  }
  let config;
  try {
    config = await loadConfig(root);
    add('config', 'ok', `${path.join(root, 'buildrush.json')} valid, ${Object.keys(config.tasks).length} task(s)`);
  } catch (e) {
    add('config', 'fail', (e as Error).message);
    return out;
  }

  const det = await detectProject(root);
  if (det.lockfiles.length === 0) add('lockfile', 'warn', 'no lockfile found: dependency changes cannot be tracked precisely');
  else if (det.lockfiles.length > 1) add('lockfile', 'warn', `multiple lockfiles (${det.lockfiles.join(', ')}); pick one package manager`);
  else add('lockfile', 'ok', det.lockfiles[0]!);

  for (const t of Object.values(config.tasks)) {
    const cwd = path.join(root, t.cwd);
    if (!resolveExecutable(t.command[0]!, cwd, root, process.env.PATH ?? '')) {
      add(`task:${t.name}`, 'fail', `executable ${JSON.stringify(t.command[0])} not found (node_modules/.bin or PATH). Did you run your package manager install?`);
      continue;
    }
    const notes: string[] = [];
    if (!t.cache) notes.push('caching disabled by config');
    else if (t.kind === 'build' && t.outputs.length === 0) notes.push('build task declares no outputs: results are cached as success markers only');
    if (t.inputs === null) notes.push('no inputs declared: whole project is hashed (correct but invalidates broadly)');
    if (t.passEnv.length) notes.push(`passEnv ${t.passEnv.join(',')} is NOT part of the cache key`);
    add(`task:${t.name}`, notes.length ? 'warn' : 'ok', notes.join('; ') || 'ready, cacheable');
  }

  const cacheDir = process.env.BUILDRUSH_CACHE_DIR ?? config.cache.dir ?? path.join(root, '.buildrush', 'cache');
  try {
    const cache = new Cache(path.resolve(root, cacheDir));
    await cache.init();
    const st = await fs.stat(cache.dir);
    const perm = st.mode & 0o777;
    if (process.platform !== 'win32' && perm & 0o077) add('cache permissions', 'warn', `${cache.dir} is mode ${perm.toString(8)}; expected 700`);
    else add('cache permissions', 'ok', `${cache.dir} (private)`);
    const v = await cache.verify();
    const bad = v.corruptBlobs.length + v.badEntries.length + v.missingBlobs.length;
    add('cache health', bad ? 'fail' : 'ok', bad ? `${bad} problem(s); run \`buildrush cache verify --repair\`` : `${v.entries} entries, ${v.blobs} blobs verified`);
    const sf = await fs.statfs(cache.dir);
    const free = sf.bavail * sf.bsize;
    add('disk space', free < 1024 ** 3 ? 'warn' : 'ok', `${(free / 1024 ** 3).toFixed(1)} GiB free`);
  } catch (e) {
    add('cache', 'fail', `cannot use cache directory: ${(e as Error).message}`);
  }

  try {
    await pexec('git', ['--version']);
    const r = await pexec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: root }).then(() => true, () => false);
    add('git', r ? 'ok' : 'warn', r ? 'available; --affected can diff against git refs' : 'git present but project is not a repository: --affected falls back to running all tests');
  } catch {
    add('git', 'warn', 'git not found: --affected falls back to running all tests');
  }
  add('watch mode', 'warn', 'not implemented in this version (see ROADMAP.md)');
  add('daemon', 'ok', 'not used: every command runs one-shot (no background process, no IPC surface)');
  return out;
}
