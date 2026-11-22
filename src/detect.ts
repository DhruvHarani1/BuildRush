import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { readJson } from './util/fsx.js';

export interface Detection {
  name: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'bun' | null;
  lockfiles: string[];
  tools: string[];
  workspaces: string[];
  scripts: Record<string, string>;
  hasTypeScript: boolean;
}

const LOCKS: [string, Detection['packageManager']][] = [
  ['package-lock.json', 'npm'], ['npm-shrinkwrap.json', 'npm'], ['pnpm-lock.yaml', 'pnpm'], ['yarn.lock', 'yarn'], ['bun.lock', 'bun'], ['bun.lockb', 'bun'],
];
const KNOWN_TOOLS = ['vite', 'vitest', 'eslint', 'typescript', 'jest', 'react', 'next', 'webpack', 'esbuild', 'rollup', 'prettier', 'playwright', 'cypress'];

export async function detectProject(root: string): Promise<Detection> {
  const pkg = (await readJson<{
    name?: string; scripts?: Record<string, string>; workspaces?: string[] | { packages?: string[] };
    dependencies?: Record<string, string>; devDependencies?: Record<string, string>;
  }>(path.join(root, 'package.json'))) ?? {};
  const lockfiles: string[] = [];
  let pm: Detection['packageManager'] = null;
  for (const [f, m] of LOCKS) {
    try {
      await fs.access(path.join(root, f));
      lockfiles.push(f);
      pm ??= m;
    } catch { /* absent */ }
  }
  const deps = { ...pkg.dependencies, ...pkg.devDependencies };
  const ws = Array.isArray(pkg.workspaces) ? pkg.workspaces : (pkg.workspaces?.packages ?? []);
  let hasTs = 'typescript' in deps;
  try {
    await fs.access(path.join(root, 'tsconfig.json'));
    hasTs = true;
  } catch { /* no tsconfig */ }
  return {
    name: pkg.name ?? path.basename(root),
    packageManager: pm,
    lockfiles,
    tools: KNOWN_TOOLS.filter((t) => t in deps),
    workspaces: ws,
    scripts: pkg.scripts ?? {},
    hasTypeScript: hasTs,
  };
}

/** Starter config derived from what is actually installed; conservative defaults. */
export function starterConfig(d: Detection): Record<string, unknown> {
  const lock = d.lockfiles.length ? d.lockfiles : ['package.json'];
  const common = ['package.json', ...lock, '.nvmrc', '.node-version'];
  const tasks: Record<string, unknown> = {};
  const has = (t: string) => d.tools.includes(t);
  if (d.hasTypeScript && has('typescript')) {
    tasks.typecheck = { command: 'tsc --noEmit', kind: 'check', inputs: ['src/**', 'test/**', 'tests/**', 'tsconfig*.json', ...common] };
  }
  if (has('eslint')) {
    tasks.lint = { command: 'eslint .', kind: 'check', inputs: ['src/**', 'test/**', 'tests/**', 'eslint.config.*', '.eslintrc*', ...common] };
  }
  if (has('vitest')) {
    tasks.test = {
      command: 'vitest run', kind: 'test', affected: true,
      inputs: ['src/**', 'test/**', 'tests/**', 'vitest.config.*', 'vite.config.*', 'tsconfig*.json', ...common],
    };
  }
  if (has('vite')) {
    tasks.build = {
      command: 'vite build', kind: 'build', dependsOn: Object.keys(tasks).filter((t) => t === 'typecheck'),
      inputs: ['src/**', 'public/**', 'index.html', 'vite.config.*', 'tsconfig*.json', ...common], outputs: ['dist/**'],
    };
  }
  if (Object.keys(tasks).length === 0) {
    // No recognised tool: fall back to package scripts. These are opaque to BuildRush, so they
    // run uncached-by-default knowledge-wise: inputs default to the whole project (safe, coarse).
    const pm = d.packageManager ?? 'npm';
    for (const [script, kind] of [['lint', 'check'], ['typecheck', 'check'], ['test', 'test'], ['build', 'build']] as const) {
      if (d.scripts[script]) tasks[script] = { command: [pm, 'run', script], kind, ...(script === 'build' ? { outputs: ['dist/**'] } : {}) };
    }
  }
  const names = Object.keys(tasks);
  return {
    version: 1,
    project: { name: d.name },
    tasks,
    pipelines: { default: names, check: names.filter((n) => tasks[n] && (tasks[n] as { kind: string }).kind === 'check') },
  };
}
