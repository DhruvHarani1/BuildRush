import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { availableParallelism } from 'node:os';
import { safeRelative } from './util/paths.js';
import { globToRegExp } from './util/glob.js';
import { ADAPTER_KIND, ADAPTER_NAMES, AdapterName } from './adapters.js';

export const CONFIG_FILE = 'buildrush.json';

export type TaskKind = 'build' | 'test' | 'check' | 'run';

export interface TaskConfig {
  name: string;
  /** argv, executed WITHOUT a shell. */
  command: string[];
  dependsOn: string[];
  /** null = every non-ignored project file except declared outputs of any task. */
  inputs: string[] | null;
  outputs: string[];
  /** Env vars that are passed AND fingerprinted (name -> value hashed into the key). */
  env: string[];
  /** Env vars passed through but NOT fingerprinted. Use sparingly. */
  passEnv: string[];
  cache: boolean;
  kind: TaskKind;
  cwd: string;
  cpu: number;
  timeoutMs: number | null;
  /** For test tasks: append selected test files to argv under --affected. */
  affected: boolean;
  adapter: AdapterName | null;
  /** User option (tsc adapter): false disables tsc incremental state. null = unset (automatic). */
  incremental: boolean | null;
  /** Set by the adapter: this task may safely use tsc incremental state (see tsc-state.ts). */
  incrementalEligible: boolean;
  /** Env var name prefixes whose present variables are passed AND fingerprinted (set by adapters). */
  envPrefixes: string[];
  /** Adapter findings shown by `doctor` / `explain`. */
  notes: string[];
}

export interface Config {
  version: 1;
  project: { name: string };
  tasks: Record<string, TaskConfig>;
  pipelines: Record<string, string[]>;
  ignore: string[];
  concurrency: number;
  cache: { dir: string | null; maxSizeMB: number };
  tests: { patterns: string[] };
}

export class ConfigError extends Error {
  constructor(public readonly issues: string[]) {
    super(`invalid ${CONFIG_FILE}:\n${issues.map((i) => `  - ${i}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

const SHELL_META = /[|&;<>`$()*?{}\\!#~\n\r]/;

/**
 * Tokenise a command string into argv WITHOUT a shell. Single and double
 * quotes group words. Any unquoted shell metacharacter is rejected so a
 * config can never silently depend on shell semantics.
 */
export function splitCommand(cmd: string): string[] {
  const out: string[] = [];
  let cur = '';
  let has = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < cmd.length; i++) {
    const c = cmd[i]!;
    if (quote) {
      if (c === quote) quote = null;
      else cur += c;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
    } else if (c === ' ' || c === '\t') {
      if (has || cur) out.push(cur);
      cur = '';
      has = false;
    } else if (SHELL_META.test(c)) {
      throw new Error(
        `unquoted shell metacharacter ${JSON.stringify(c)} in command ${JSON.stringify(cmd)}; ` +
          'BuildRush never uses a shell. Use an argv array, quote the argument, or call a script file.',
      );
    } else {
      cur += c;
    }
  }
  if (quote) throw new Error(`unterminated quote in command ${JSON.stringify(cmd)}`);
  if (has || cur) out.push(cur);
  return out;
}

const TASK_KEYS = new Set([
  'command', 'dependsOn', 'inputs', 'outputs', 'env', 'passEnv', 'cache', 'kind', 'cwd', 'cpu', 'timeoutMs', 'affected', 'adapter', 'incremental',
]);
const TOP_KEYS = new Set(['$schema', 'version', 'project', 'tasks', 'pipelines', 'ignore', 'concurrency', 'cache', 'tests']);
const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const TASK_NAME = /^[A-Za-z0-9][A-Za-z0-9:_-]*$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function strArray(v: unknown, where: string, issues: string[]): string[] | null {
  if (!Array.isArray(v) || v.some((x) => typeof x !== 'string' || x.length === 0)) {
    issues.push(`${where}: expected an array of non-empty strings`);
    return null;
  }
  return v as string[];
}

function checkGlobs(globs: string[], where: string, issues: string[]) {
  for (const g of globs) {
    try {
      if (g.startsWith('/') || g.includes('..')) throw new Error('must be project-relative without ".."');
      globToRegExp(g);
    } catch (e) {
      issues.push(`${where}: bad glob ${JSON.stringify(g)} (${(e as Error).message})`);
    }
  }
}

export function validateConfig(raw: unknown): Config {
  const issues: string[] = [];
  if (!isObj(raw)) throw new ConfigError(['top level must be a JSON object']);
  for (const k of Object.keys(raw)) if (!TOP_KEYS.has(k)) issues.push(`${k}: unknown key`);
  if (raw.version !== 1) issues.push('version: must be 1');

  const project = isObj(raw.project) ? raw.project : {};
  if (typeof project.name !== 'string' || !project.name) issues.push('project.name: required string');

  const tasks: Record<string, TaskConfig> = {};
  if (!isObj(raw.tasks) || Object.keys(raw.tasks).length === 0) {
    issues.push('tasks: at least one task is required');
  } else {
    for (const [name, t] of Object.entries(raw.tasks)) {
      const w = `tasks.${name}`;
      if (!TASK_NAME.test(name)) issues.push(`${w}: invalid task name`);
      if (!isObj(t)) {
        issues.push(`${w}: must be an object`);
        continue;
      }
      for (const k of Object.keys(t)) if (!TASK_KEYS.has(k)) issues.push(`${w}.${k}: unknown key`);
      let adapter: AdapterName | null = null;
      if (t.adapter !== undefined) {
        if (typeof t.adapter === 'string' && (ADAPTER_NAMES as readonly string[]).includes(t.adapter)) adapter = t.adapter as AdapterName;
        else issues.push(`${w}.adapter: must be one of ${ADAPTER_NAMES.join(', ')}`);
      }
      if (t.incremental !== undefined) {
        if (typeof t.incremental !== 'boolean') issues.push(`${w}.incremental: must be boolean`);
        else if (adapter !== 'tsc') issues.push(`${w}.incremental: only supported with "adapter": "tsc"`);
      }
      let command: string[] = [];
      if (t.command === undefined && adapter) {
        command = [];
      } else if (typeof t.command === 'string') {
        try {
          command = splitCommand(t.command);
        } catch (e) {
          issues.push(`${w}.command: ${(e as Error).message}`);
        }
      } else if (Array.isArray(t.command)) {
        command = strArray(t.command, `${w}.command`, issues) ?? [];
      } else {
        issues.push(`${w}.command: required (string or argv array)`);
      }
      if (command.length === 0 && typeof t.command !== 'undefined' && !issues.some((i) => i.startsWith(`${w}.command`))) {
        issues.push(`${w}.command: must not be empty`);
      }
      const dependsOn = t.dependsOn === undefined ? [] : (strArray(t.dependsOn, `${w}.dependsOn`, issues) ?? []);
      const inputs = t.inputs === undefined ? null : strArray(t.inputs, `${w}.inputs`, issues);
      const outputs = t.outputs === undefined ? [] : (strArray(t.outputs, `${w}.outputs`, issues) ?? []);
      if (inputs) checkGlobs(inputs, `${w}.inputs`, issues);
      checkGlobs(outputs, `${w}.outputs`, issues);
      const env = t.env === undefined ? [] : (strArray(t.env, `${w}.env`, issues) ?? []);
      const passEnv = t.passEnv === undefined ? [] : (strArray(t.passEnv, `${w}.passEnv`, issues) ?? []);
      for (const e of [...env, ...passEnv]) if (!ENV_NAME.test(e)) issues.push(`${w}: invalid env var name ${JSON.stringify(e)}`);
      if (t.cache !== undefined && typeof t.cache !== 'boolean') issues.push(`${w}.cache: must be boolean`);
      const kind = (t.kind ?? (adapter ? ADAPTER_KIND[adapter] : 'run')) as TaskKind;
      if (!['build', 'test', 'check', 'run'].includes(kind)) issues.push(`${w}.kind: must be build|test|check|run`);
      let cwd = '.';
      if (t.cwd !== undefined) {
        if (typeof t.cwd !== 'string') issues.push(`${w}.cwd: must be a string`);
        else {
          try {
            cwd = t.cwd === '.' ? '.' : safeRelative(t.cwd);
          } catch (e) {
            issues.push(`${w}.cwd: ${(e as Error).message}`);
          }
        }
      }
      const cpu = t.cpu === undefined ? 1 : t.cpu;
      if (typeof cpu !== 'number' || !Number.isInteger(cpu) || cpu < 1) issues.push(`${w}.cpu: must be a positive integer`);
      const timeoutMs = t.timeoutMs === undefined ? null : t.timeoutMs;
      if (timeoutMs !== null && (typeof timeoutMs !== 'number' || timeoutMs <= 0)) issues.push(`${w}.timeoutMs: must be a positive number`);
      if (t.affected !== undefined && typeof t.affected !== 'boolean') issues.push(`${w}.affected: must be boolean`);
      tasks[name] = {
        name,
        command,
        dependsOn,
        inputs,
        outputs,
        env,
        passEnv,
        cache: t.cache === undefined ? true : (t.cache as boolean),
        kind,
        cwd,
        cpu: typeof cpu === 'number' ? cpu : 1,
        timeoutMs: timeoutMs as number | null,
        affected: t.affected === undefined ? kind === 'test' : (t.affected as boolean),
        adapter,
        incremental: typeof t.incremental === 'boolean' ? t.incremental : null,
        incrementalEligible: false,
        envPrefixes: [],
        notes: [],
      };
    }
  }
  for (const t of Object.values(tasks)) {
    for (const d of t.dependsOn) if (!tasks[d]) issues.push(`tasks.${t.name}.dependsOn: unknown task ${JSON.stringify(d)}`);
  }

  const pipelines: Record<string, string[]> = {};
  if (raw.pipelines !== undefined) {
    if (!isObj(raw.pipelines)) issues.push('pipelines: must be an object');
    else {
      for (const [n, list] of Object.entries(raw.pipelines)) {
        const l = strArray(list, `pipelines.${n}`, issues);
        if (!l) continue;
        for (const x of l) if (!tasks[x]) issues.push(`pipelines.${n}: unknown task ${JSON.stringify(x)}`);
        pipelines[n] = l;
      }
    }
  }

  const ignore = raw.ignore === undefined ? [] : (strArray(raw.ignore, 'ignore', issues) ?? []);
  checkGlobs(ignore, 'ignore', issues);

  let concurrency = Math.max(1, availableParallelism() - 1);
  if (raw.concurrency !== undefined) {
    if (typeof raw.concurrency !== 'number' || !Number.isInteger(raw.concurrency) || raw.concurrency < 1) {
      issues.push('concurrency: must be a positive integer');
    } else concurrency = raw.concurrency;
  }

  const cacheRaw = isObj(raw.cache) ? raw.cache : {};
  if (raw.cache !== undefined && !isObj(raw.cache)) issues.push('cache: must be an object');
  for (const k of Object.keys(cacheRaw)) if (!['dir', 'maxSizeMB'].includes(k)) issues.push(`cache.${k}: unknown key`);
  const maxSizeMB = cacheRaw.maxSizeMB === undefined ? 2048 : cacheRaw.maxSizeMB;
  if (typeof maxSizeMB !== 'number' || maxSizeMB <= 0) issues.push('cache.maxSizeMB: must be a positive number');
  if (cacheRaw.dir !== undefined && typeof cacheRaw.dir !== 'string') issues.push('cache.dir: must be a string');

  const testsRaw = isObj(raw.tests) ? raw.tests : {};
  const patterns =
    testsRaw.patterns === undefined
      ? ['**/*.{test,spec}.{js,jsx,ts,tsx,mjs,cjs,mts,cts}', '**/__tests__/**/*.{js,jsx,ts,tsx,mjs,cjs,mts,cts}']
      : (strArray(testsRaw.patterns, 'tests.patterns', issues) ?? []);
  checkGlobs(patterns, 'tests.patterns', issues);

  const cycle = findTaskCycle(tasks);
  if (cycle) issues.push(`tasks: dependency cycle ${cycle.join(' -> ')}`);

  if (issues.length) throw new ConfigError(issues);
  return {
    version: 1,
    project: { name: project.name as string },
    tasks,
    pipelines,
    ignore,
    concurrency,
    cache: { dir: (cacheRaw.dir as string | undefined) ?? null, maxSizeMB: maxSizeMB as number },
    tests: { patterns },
  };
}

export function findTaskCycle(tasks: Record<string, { dependsOn: string[] }>): string[] | null {
  const state = new Map<string, 1 | 2>();
  const stack: string[] = [];
  const visit = (n: string): string[] | null => {
    if (state.get(n) === 2) return null;
    if (state.get(n) === 1) return [...stack.slice(stack.indexOf(n)), n];
    state.set(n, 1);
    stack.push(n);
    for (const d of tasks[n]?.dependsOn ?? []) {
      const c = visit(d);
      if (c) return c;
    }
    stack.pop();
    state.set(n, 2);
    return null;
  };
  for (const n of Object.keys(tasks)) {
    const c = visit(n);
    if (c) return c;
  }
  return null;
}

export async function findProjectRoot(start: string): Promise<string | null> {
  let dir = path.resolve(start);
  for (;;) {
    try {
      await fs.access(path.join(dir, CONFIG_FILE));
      return dir;
    } catch {
      const parent = path.dirname(dir);
      if (parent === dir) return null;
      dir = parent;
    }
  }
}

export async function loadConfig(root: string): Promise<Config> {
  const file = path.join(root, CONFIG_FILE);
  let text: string;
  try {
    text = await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new ConfigError([`${CONFIG_FILE} not found in ${root} (run \`buildrush init\`)`]);
    }
    throw e;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    const m = /position (\d+)/.exec((e as Error).message);
    let where = '';
    if (m) {
      const pos = Number(m[1]);
      const before = text.slice(0, pos);
      where = ` (line ${before.split('\n').length}, column ${pos - before.lastIndexOf('\n')})`;
    }
    throw new ConfigError([`${CONFIG_FILE} is not valid JSON${where}: ${(e as Error).message}`]);
  }
  return validateConfig(raw);
}
