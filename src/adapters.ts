import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import type { TaskConfig } from './config.js';
import { parseJsonc } from './graph.js';
import { readJson } from './util/fsx.js';

export type AdapterName = 'vite' | 'vitest' | 'tsc' | 'eslint';
export const ADAPTER_NAMES: readonly AdapterName[] = ['vite', 'vitest', 'tsc', 'eslint'];
export const ADAPTER_KIND: Record<AdapterName, 'build' | 'test' | 'check'> = { vite: 'build', vitest: 'test', tsc: 'check', eslint: 'check' };

const PM_FILES = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb', '.npmrc', '.nvmrc', '.node-version'];
const SRC_EXT = '{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}';

/** What an adapter contributes to a task. Explicit user config always wins over these defaults. */
export interface Resolved {
  command: string[];
  /** null = hash the whole project (used when the tool config makes the real inputs unknowable). */
  inputs: string[] | null;
  outputs: string[];
  env: string[];
  /** Every process env var whose NAME starts with one of these is passed AND fingerprinted. */
  envPrefixes: string[];
  /** false = adapter cannot make this task safely cacheable. */
  cache: boolean;
  notes: string[];
}

async function firstExisting(dir: string, names: string[]): Promise<{ file: string; text: string } | null> {
  for (const n of names) {
    try {
      return { file: n, text: await fs.readFile(path.join(dir, n), 'utf8') };
    } catch { /* next */ }
  }
  return null;
}

const exts = (base: string) => ['ts', 'js', 'mjs', 'mts', 'cjs', 'cts'].map((e) => `${base}.${e}`);

/** Config keys that can pull inputs from places we cannot enumerate statically. */
const RISKY_CONFIG = /\b(root|envDir|publicDir|cacheDir|include|setupFiles|globalSetup|dir)\s*:|['"`]\.\.\//;

function flagValue(argv: string[], flag: string): string | null {
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    if (a === flag) return argv[i + 1] ?? null;
    if (a.startsWith(flag + '=')) return a.slice(flag.length + 1);
  }
  return null;
}

function safeOutDir(dir: string): string | null {
  const n = path.posix.normalize(dir.replace(/^\.\//, ''));
  if (!n || n === '.' || n.startsWith('..') || path.posix.isAbsolute(n)) return null;
  return n.replace(/\/$/, '');
}

export async function resolveAdapter(name: AdapterName, cwd: string, t: TaskConfig): Promise<Resolved> {
  const notes: string[] = [];
  const base = { env: ['NODE_ENV'], envPrefixes: [] as string[], cache: true, notes };
  const argv = t.command;
  const sub = (i: number) => argv[i];

  if (name === 'vite') {
    const command = argv.length ? [...argv] : ['vite', 'build'];
    if (command.length === 1) command.push('build');
    if (command[0] === 'vite' && !['build', undefined].includes(command[1]) && !command[1]!.startsWith('-')) {
      throw new Error(`vite adapter only supports "vite build" (got "vite ${command[1]}"): dev/preview servers are long-running and cannot be cached`);
    }
    const cfg = await firstExisting(cwd, exts('vite.config'));
    const text = cfg?.text ?? '';
    let inputs: string[] | null = [
      'src/**', 'public/**', '*.html', ...exts('vite.config'), 'tsconfig*.json', '.env', '.env.*', ...PM_FILES,
    ];
    if (RISKY_CONFIG.test(text) || flagValue(command, '--config') || flagValue(command, '-c')) {
      inputs = null;
      notes.push('vite config sets root/envDir/publicDir/include or reaches outside the project (or a custom --config is used): hashing the whole project to stay correct. List inputs explicitly to narrow.');
    }
    const cliOut = flagValue(command, '--outDir');
    const lit = /outDir\s*:\s*(['"`])([^'"`$\n]+)\1/.exec(text);
    const dir = cliOut ?? lit?.[2] ?? (/outDir\s*:/.test(text) ? null : 'dist');
    const out = dir === null ? null : safeOutDir(dir);
    let cache = true;
    let outputs: string[] = [];
    if (out === null) {
      cache = false;
      notes.push('vite build.outDir is not a plain project-relative literal: outputs cannot be determined, caching disabled for this task. Set "outputs" explicitly to enable it.');
    } else outputs = [`${out}/**`];
    base.env.push('MODE');
    notes.push('Vite exposes VITE_* env vars to the bundle: every VITE_* variable present is passed and fingerprinted; .env* files are inputs.');
    return { command, inputs, outputs, ...base, envPrefixes: ['VITE_'], cache, notes };
  }

  if (name === 'vitest') {
    const command = argv.length ? [...argv] : ['vitest', 'run'];
    if (command.length === 1 || (command[0] === 'vitest' && command[1]!.startsWith('-') && !command.includes('run'))) command.splice(1, 0, 'run');
    if (['watch', 'dev', 'bench', 'ui'].includes(command[1] ?? '') || command.some((a) => a === '--watch' || a === '-w' || a === '--ui')) {
      throw new Error('vitest adapter requires a single-shot run ("vitest run"); watch/ui modes cannot be cached');
    }
    const cfg = await firstExisting(cwd, [...exts('vitest.config'), ...exts('vitest.workspace'), ...exts('vite.config')]);
    let inputs: string[] | null = [
      'src/**', 'test/**', 'tests/**', '**/__tests__/**', `**/*.{test,spec}.${SRC_EXT}`, ...exts('vitest.config'), ...exts('vitest.workspace'),
      ...exts('vite.config'), 'tsconfig*.json', '.env', '.env.*', ...PM_FILES,
    ];
    if (cfg && RISKY_CONFIG.test(cfg.text)) {
      inputs = null;
      notes.push(`${cfg.file} customises include/root/setupFiles/dir or reaches outside the project: hashing the whole project to stay correct. List inputs explicitly to narrow.`);
    }
    let outputs = command.some((a) => a === '--coverage' || a.startsWith('--coverage.')) ? ['coverage/**'] : [];
    if (outputs.length) notes.push('coverage enabled: coverage/** is captured as an output.');
    let cache = true;
    // Coverage switched on in the config (found on a real monorepo: `coverage: { enabled: true }` in every
    // package) writes its report just like --coverage; undeclared, it would pollute other tasks' inputs.
    const covBlock = /\bcoverage\s*:\s*\{[^}]*\benabled\s*:\s*true/.test(cfg?.text ?? '');
    if (covBlock && !outputs.length) {
      const rd = /\breportsDirectory\s*:\s*(['"`])([^'"`$\n]+)\1/.exec(cfg!.text);
      const dir = rd ? safeOutDir(rd[2]!) : /\breportsDirectory\s*:/.test(cfg!.text) ? null : 'coverage';
      if (dir === null) {
        cache = false;
        notes.push('coverage is enabled in the config but reportsDirectory is not a plain project-relative literal: outputs cannot be determined, caching disabled for this task. Set "outputs" explicitly to enable it.');
      } else {
        outputs = [`${dir}/**`];
        notes.push(`coverage is enabled in ${cfg!.file}: ${dir}/** is captured as an output.`);
      }
    }
    notes.push('Test results are only reusable if tests are deterministic. Tests that use network, time or randomness must set "cache": false.');
    return { command, inputs, outputs, ...base, envPrefixes: ['VITE_', 'VITEST_'], cache, notes };
  }

  if (name === 'tsc') {
    const command = argv.length ? [...argv] : ['tsc', '--noEmit'];
    const project = flagValue(command, '-p') ?? flagValue(command, '--project') ?? 'tsconfig.json';
    let noEmit = command.includes('--noEmit');
    let outDir: string | null = flagValue(command, '--outDir');
    const ts = (await readJson<unknown>(path.join(cwd, project)).catch(() => null)) ?? (await fs.readFile(path.join(cwd, project), 'utf8').then(parseJsonc, () => null));
    const co = (ts as { compilerOptions?: { noEmit?: boolean; outDir?: string; incremental?: boolean; composite?: boolean; tsBuildInfoFile?: string } } | null)?.compilerOptions;
    if (co?.noEmit) noEmit = true;
    outDir ??= co?.outDir ?? null;
    let cache = true;
    let outputs: string[] = [];
    if (!noEmit) {
      const o = outDir ? safeOutDir(outDir) : null;
      if (!o) {
        cache = false;
        notes.push('tsc emits but no project-relative outDir was found: it would write next to sources, so caching is disabled. Add "outDir" or use --noEmit.');
      } else outputs = [`${o}/**`];
      if (co?.incremental || co?.composite) notes.push('incremental/composite builds write .tsbuildinfo, which is not captured; consider "noEmit" for checks.');
    }
    void sub;
    return { command, inputs: [`**/*.${SRC_EXT}`, ...PM_FILES], outputs, ...base, env: [], cache, notes };
  }

  // eslint
  const command = argv.length ? [...argv] : ['eslint', '.'];
  notes.push('eslint plugins/configs outside the project are only tracked through the lockfile.');
  return {
    command,
    inputs: [`**/*.{js,jsx,mjs,cjs,ts,tsx,mts,cts,json,vue,svelte,astro}`, '.eslintrc*', 'eslint.config.*', '.eslintignore', ...PM_FILES],
    outputs: [], ...base, env: [], cache: true, notes,
  };
}

/** Installed version of an npm tool, looked up from `cwd` upward; null when not installed. */
export async function toolVersion(root: string, cwd: string, pkg: string): Promise<string | null> {
  let dir = cwd;
  for (;;) {
    const j = await readJson<{ version?: string }>(path.join(dir, 'node_modules', pkg, 'package.json'));
    if (j?.version) return j.version;
    if (dir === root || path.dirname(dir) === dir) return null;
    dir = path.dirname(dir);
  }
}

export const ADAPTER_PACKAGE: Record<AdapterName, string> = { vite: 'vite', vitest: 'vitest', tsc: 'typescript', eslint: 'eslint' };

/** Pull concise failure information out of tool output (display only; never affects caching). */
export function diagnostics(name: AdapterName | null, log: string): string[] {
  const out = new Set<string>();
  if (name === 'vitest') {
    for (const m of log.matchAll(/^\s*(?:FAIL|❯|×)\s+(\S+\.(?:test|spec)\.[cm]?[jt]sx?)/gm)) out.add(`failed test file: ${m[1]}`);
  } else if (name === 'tsc') {
    for (const m of log.matchAll(/^(\S+?)\((\d+),(\d+)\): error (TS\d+): (.+)$/gm)) out.add(`${m[1]}:${m[2]}:${m[3]} ${m[4]} ${m[5]}`);
  } else if (name === 'eslint') {
    let file = '';
    for (const line of log.split('\n')) {
      if (/^\/|^[A-Za-z]:\\|^\S+\.[cm]?[jt]sx?$/.test(line.trim()) && !line.startsWith(' ')) file = line.trim();
      const m = /^\s+(\d+):(\d+)\s+error\s+(.+?)\s{2,}(\S+)$/.exec(line);
      if (m) out.add(`${file}:${m[1]}:${m[2]} ${m[4]} ${m[3]}`);
    }
  } else if (name === 'vite') {
    for (const m of log.matchAll(/^error during build:\n?(.+)$/gm)) out.add(m[1]!);
  }
  return [...out].slice(0, 50);
}
