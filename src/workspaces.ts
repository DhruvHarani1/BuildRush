import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Config, ConfigError, findTaskCycle, TaskConfig } from './config.js';
import { readJson } from './util/fsx.js';
import { compileGlobs } from './util/glob.js';
import type { DepGraph } from './graph.js';

/**
 * Workspace (monorepo) support: detection of npm/yarn/bun (`package.json` "workspaces") and pnpm
 * (`pnpm-workspace.yaml`) layouts, package discovery, per-package task expansion and
 * package-level change impact. Everything here is dependency-free and never follows symlinks.
 */

export interface WorkspacePackage {
  name: string;
  version: string | null;
  /** Project-relative POSIX directory. */
  dir: string;
  /** Project-relative POSIX path of the package.json. */
  manifest: string;
  /** dependencies + devDependencies + optionalDependencies, name -> declared range. */
  dependencies: Record<string, string>;
  /** Names of OTHER workspace packages this package depends on (sorted). */
  workspaceDeps: string[];
  /** Entry-point fields used to map imports of this package onto its sources. */
  entry: { main: string | null; module: string | null; types: string | null; source: string | null; exports: unknown };
}

export type WorkspaceManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

/** Files at the workspace root whose content can change every package's build. */
export const ROOT_SHARED = [
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'pnpm-workspace.yaml', '.npmrc', '.yarnrc', '.yarnrc.yml', '.nvmrc', '.node-version', 'tsconfig*.json',
];
const isRootShared = compileGlobs(ROOT_SHARED);

export class Workspace {
  private readonly byName = new Map<string, WorkspacePackage>();

  constructor(
    readonly manager: WorkspaceManager,
    /** Where the package globs came from. */
    readonly source: string,
    readonly patterns: string[],
    readonly packages: WorkspacePackage[],
    readonly warnings: string[],
  ) {
    for (const p of packages) this.byName.set(p.name, p);
  }

  get(name: string): WorkspacePackage | undefined {
    return this.byName.get(name);
  }

  /** The package whose directory contains `file` (innermost wins), or null. */
  packageOfFile(file: string): WorkspacePackage | null {
    let best: WorkspacePackage | null = null;
    for (const p of this.packages) {
      if (file.startsWith(p.dir + '/') && (!best || p.dir.length > best.dir.length)) best = p;
    }
    return best;
  }

  /** Direct dependents (packages that declare `name` as a dependency). */
  dependentsOf(name: string): string[] {
    return this.packages.filter((p) => p.workspaceDeps.includes(name)).map((p) => p.name);
  }

  transitiveDeps(name: string): string[] {
    const seen = new Set<string>();
    const visit = (n: string) => {
      for (const d of this.get(n)?.workspaceDeps ?? []) {
        if (!seen.has(d)) {
          seen.add(d);
          visit(d);
        }
      }
    };
    visit(name);
    seen.delete(name);
    return [...seen].sort();
  }

  /** Package dependency cycle as a path (a -> b -> a), or null. */
  findCycle(): string[] | null {
    return findTaskCycle(Object.fromEntries(this.packages.map((p) => [p.name, { dependsOn: p.workspaceDeps }])));
  }

  summary() {
    return {
      manager: this.manager,
      source: this.source,
      patterns: this.patterns,
      warnings: this.warnings,
      packages: this.packages.map((p) => ({
        name: p.name,
        version: p.version,
        dir: p.dir,
        dependsOn: p.workspaceDeps,
        dependents: this.dependentsOf(p.name),
      })),
    };
  }
}

/**
 * Extract the `packages:` list from a pnpm-workspace.yaml. Supports block lists and single-line flow
 * lists (`packages: ['a', 'b']`), quotes and comments. Anything fancier (anchors, multi-line flow
 * sequences) is NOT supported; use the `workspaces` key in buildrush.json for those.
 */
export function parsePnpmWorkspaceYaml(text: string): string[] {
  const out: string[] = [];
  const unquote = (v: string): string => {
    let s = v.trim();
    if (s.startsWith('"') || s.startsWith("'")) {
      const q = s[0]!;
      const end = s.indexOf(q, 1);
      return end === -1 ? s.slice(1) : s.slice(1, end);
    }
    const hash = s.indexOf(' #');
    if (hash !== -1) s = s.slice(0, hash);
    return s.trim();
  };
  let inList = false;
  for (const raw of text.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    const trimmed = line.trim();
    if (trimmed === '' || trimmed.startsWith('#')) continue;
    const indented = line.startsWith(' ') || line.startsWith('\t');
    if (!indented && trimmed.startsWith('packages:')) {
      const rest = trimmed.slice('packages:'.length).trim();
      if (rest.startsWith('[')) {
        const close = rest.indexOf(']');
        const body = rest.slice(1, close === -1 ? undefined : close);
        // Split on commas that are not inside quotes.
        let cur = '';
        let q: string | null = null;
        for (const c of body) {
          if (q) {
            if (c === q) q = null;
            cur += c;
          } else if (c === '"' || c === "'") {
            q = c;
            cur += c;
          } else if (c === ',') {
            if (cur.trim()) out.push(unquote(cur));
            cur = '';
          } else cur += c;
        }
        if (cur.trim()) out.push(unquote(cur));
        inList = false;
      } else inList = rest === '' || rest.startsWith('#');
      continue;
    }
    if (inList) {
      if (trimmed.startsWith('-')) {
        const v = unquote(trimmed.slice(1));
        if (v) out.push(v);
      } else if (!indented) inList = false; // next top-level key
    }
  }
  return out;
}

async function readText(file: string): Promise<string | null> {
  try {
    return await fs.readFile(file, 'utf8');
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw e;
  }
}

async function detectManager(root: string): Promise<WorkspaceManager> {
  const has = (f: string) => fs.access(path.join(root, f)).then(() => true, () => false);
  if ((await has('pnpm-lock.yaml')) || (await has('pnpm-workspace.yaml'))) return 'pnpm';
  if (await has('yarn.lock')) return 'yarn';
  if ((await has('bun.lock')) || (await has('bun.lockb'))) return 'bun';
  return 'npm';
}

const SKIP_DIRS = new Set(['node_modules', '.git', '.buildrush']);
const normalizePattern = (p: string) =>
  p.split('/').filter((s) => s !== '' && s !== '.').join('/').replace(/\/package\.json$/, '');

/**
 * Detect the workspace layout at `root` and resolve its packages.
 * `override`: false disables detection, an array supplies the package globs explicitly.
 * Returns null when the project is not a workspace.
 */
export async function discoverWorkspaces(root: string, override: false | string[] | null = null): Promise<Workspace | null> {
  if (override === false) return null;
  let patterns: string[] = [];
  let source = '';
  if (Array.isArray(override)) {
    patterns = override;
    source = 'buildrush.json';
  } else {
    const yaml = await readText(path.join(root, 'pnpm-workspace.yaml'));
    if (yaml !== null) {
      patterns = parsePnpmWorkspaceYaml(yaml);
      source = 'pnpm-workspace.yaml';
    }
    if (patterns.length === 0) {
      const pkg = await readJson<{ workspaces?: unknown }>(path.join(root, 'package.json'));
      const ws = pkg?.workspaces;
      const list = Array.isArray(ws) ? ws : isRecord(ws) && Array.isArray(ws.packages) ? ws.packages : [];
      patterns = list.filter((x): x is string => typeof x === 'string');
      source = 'package.json';
    }
  }
  if (patterns.length === 0) return null;

  const positive = patterns.filter((p) => !p.startsWith('!')).map(normalizePattern);
  const negative = patterns.filter((p) => p.startsWith('!')).map((p) => normalizePattern(p.slice(1)));
  const include = compileGlobs(positive);
  const exclude = negative.length ? compileGlobs(negative) : () => false;
  const maxDepth = positive.some((p) => p.includes('**')) ? Infinity : Math.max(0, ...positive.map((p) => p.split('/').length));

  const dirs: string[] = [];
  const walk = async (rel: string, depth: number): Promise<void> => {
    let ents;
    try {
      ents = await fs.readdir(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of ents) {
      if (!e.isDirectory() || e.isSymbolicLink() || SKIP_DIRS.has(e.name)) continue; // never follow symlinks
      const r = rel ? `${rel}/${e.name}` : e.name;
      if (include(r) && !exclude(r)) dirs.push(r);
      if (depth + 1 < maxDepth) await walk(r, depth + 1);
    }
  };
  await walk('', 0);
  dirs.sort();

  const warnings: string[] = [];
  const packages: WorkspacePackage[] = [];
  const seen = new Map<string, string>();
  const issues: string[] = [];
  for (const dir of dirs) {
    const manifest = `${dir}/package.json`;
    const pkg = await readJson<Record<string, unknown>>(path.join(root, manifest));
    if (!pkg) continue; // a directory without a readable package.json is not a package
    if (typeof pkg.name !== 'string' || pkg.name === '') {
      warnings.push(`${manifest}: no "name"; directory ignored`);
      continue;
    }
    if (/[*?{}]/.test(dir)) {
      issues.push(`workspace package directory ${JSON.stringify(dir)} contains a glob metacharacter (* ? { }); rename it`);
      continue;
    }
    if (seen.has(pkg.name)) {
      issues.push(`workspace: duplicate package name ${JSON.stringify(pkg.name)} in ${seen.get(pkg.name)} and ${dir}`);
      continue;
    }
    seen.set(pkg.name, dir);
    const dependencies: Record<string, string> = {};
    for (const field of ['optionalDependencies', 'devDependencies', 'dependencies']) {
      const v = pkg[field];
      if (isRecord(v)) for (const [k, range] of Object.entries(v)) dependencies[k] = String(range);
    }
    const str = (v: unknown) => (typeof v === 'string' ? v : null);
    packages.push({
      name: pkg.name,
      version: str(pkg.version),
      dir,
      manifest,
      dependencies,
      workspaceDeps: [],
      entry: { main: str(pkg.main), module: str(pkg.module), types: str(pkg.types) ?? str(pkg.typings), source: str(pkg.source), exports: pkg.exports ?? null },
    });
  }
  if (issues.length) throw new ConfigError(issues);
  for (const p of packages) {
    p.workspaceDeps = Object.keys(p.dependencies).filter((d) => d !== p.name && seen.has(d)).sort();
  }
  return new Workspace(await detectManager(root), source, patterns, packages, warnings);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

// ---------------------------------------------------------------------------------------------
// Task expansion

export const instanceId = (pkg: string, task: string) => `${pkg}:${task}`;

/**
 * Replace every `scope: "packages"` task template in `config.tasks` with one instance per package
 * (id `<package>:<task>`) and resolve `dependsOn`:
 *   "x"   same package's x if x is a package task, else the root task x
 *   "^x"  x in the package's workspace dependencies (skipping through packages that do not run x)
 * A root task depending on a package task template depends on all its instances.
 * Returns template name -> instance ids. Throws ConfigError on invalid combinations.
 */
export function expandWorkspaceTasks(config: Config, ws: Workspace | null): Record<string, string[]> {
  const groups: Record<string, string[]> = {};
  const templates = Object.values(config.tasks).filter((t) => t.scope === 'packages');
  if (templates.length === 0) return groups;
  if (!ws) {
    throw new ConfigError([
      `tasks.${templates[0]!.name}.scope is "packages" but no workspace was found ` +
        '(expected "workspaces" in package.json, a pnpm-workspace.yaml, or "workspaces" globs in buildrush.json)',
    ]);
  }
  const issues: string[] = [];
  if (templates.some((t) => t.dependsOn.some((d) => d.startsWith('^')))) {
    const cycle = ws.findCycle();
    if (cycle) {
      throw new ConfigError([
        `workspace package dependency cycle: ${cycle.join(' -> ')} ` +
          '(tasks using "^" dependencies cannot be ordered; break the cycle in the package.json files)',
      ]);
    }
  }

  const tpl = new Map(templates.map((t) => [t.name, t]));
  const instances = new Map<string, TaskConfig>();
  for (const t of templates) {
    const match = t.packages ? compileGlobs(t.packages) : () => true;
    const pkgs = ws.packages.filter((p) => match(p.name));
    if (pkgs.length === 0) {
      issues.push(`tasks.${t.name}: no workspace package matches ${t.packages ? JSON.stringify(t.packages) : '(the workspace has no packages)'}`);
      continue;
    }
    groups[t.name] = [];
    for (const p of pkgs) {
      const id = instanceId(p.name, t.name);
      groups[t.name]!.push(id);
      instances.set(id, {
        ...t,
        name: id,
        command: [...t.command],
        dependsOn: [],
        inputs: t.inputs ? [...t.inputs] : null,
        outputs: [...t.outputs],
        env: [...t.env],
        passEnv: [...t.passEnv],
        cwd: p.dir,
        notes: [],
        envPrefixes: [],
        package: {
          name: p.name,
          dir: p.dir,
          depDirs: ws.transitiveDeps(p.name).map((n) => ws.get(n)!.dir),
          explicitInputs: t.inputs !== null,
        },
      });
    }
  }
  if (issues.length) throw new ConfigError(issues);

  for (const inst of instances.values()) {
    const t = tpl.get(inst.name.slice(inst.package!.name.length + 1))!;
    const p = ws.get(inst.package!.name)!;
    const deps = new Set<string>();
    for (const d of t.dependsOn) {
      if (d.startsWith('^')) {
        const x = d.slice(1);
        const seen = new Set<string>();
        const walk = (name: string) => {
          for (const dep of ws.get(name)!.workspaceDeps) {
            if (seen.has(dep)) continue;
            seen.add(dep);
            const id = instanceId(dep, x);
            if (instances.has(id)) deps.add(id);
            else walk(dep); // package does not run x: order through to ITS dependencies
          }
        };
        walk(p.name);
      } else if (tpl.has(d)) {
        const id = instanceId(p.name, d);
        if (instances.has(id)) deps.add(id);
        else issues.push(`tasks.${t.name}.dependsOn: ${JSON.stringify(d)} has no instance in package ${p.name} (excluded by its "packages" filter)`);
      } else deps.add(d);
    }
    inst.dependsOn = [...deps].sort();
  }
  if (issues.length) throw new ConfigError(issues);

  const next: Record<string, TaskConfig> = {};
  for (const [name, t] of Object.entries(config.tasks)) {
    if (t.scope === 'packages') {
      for (const id of groups[name]!) next[id] = instances.get(id)!;
    } else {
      t.dependsOn = [...new Set(t.dependsOn.flatMap((d) => groups[d] ?? [d]))];
      next[name] = t;
    }
  }
  for (const k of Object.keys(config.tasks)) delete config.tasks[k];
  Object.assign(config.tasks, next);
  return groups;
}

/**
 * After adapters have filled in commands, inputs and outputs (relative to the package), make the
 * globs project-relative and add what a package task implicitly depends on:
 *  - the package's own package.json and every root-shared file (lockfiles, root package.json, ...),
 *  - unless the task declared `inputs` itself: the sources of every transitive workspace dependency.
 * An adapter that could not bound its inputs (null) keeps hashing the whole project.
 */
export function finalizePackageTasks(config: Config): void {
  for (const t of Object.values(config.tasks)) {
    const p = t.package;
    if (!p) continue;
    const at = (g: string) => `${p.dir}/${g.replace(/^\.\//, '')}`;
    t.outputs = t.outputs.map(at);
    if (t.inputs === null) {
      if (t.adapter) continue; // unknowable inputs: whole project (safe)
      t.inputs = [`${p.dir}/**`, ...p.depDirs.map((d) => `${d}/**`), ...ROOT_SHARED];
    } else if (p.explicitInputs) {
      t.inputs = [...t.inputs.map(at), `${p.dir}/package.json`, ...ROOT_SHARED];
    } else {
      t.inputs = [...t.inputs.map(at), ...p.depDirs.map((d) => `${d}/**`), ...ROOT_SHARED];
    }
  }
}

// ---------------------------------------------------------------------------------------------
// Resolving imports of workspace packages onto sources

function leaves(v: unknown, out: string[]): void {
  if (typeof v === 'string') out.push(v);
  else if (Array.isArray(v)) v.forEach((x) => leaves(x, out));
  else if (isRecord(v)) Object.values(v).forEach((x) => leaves(x, out));
}

/**
 * Candidate files (package-relative, extensionless or not) that an import of `<pkg>/<sub>` can land
 * on, per package.json "exports" / "main" / "module" / "types". Published entries usually point at
 * build output (dist/index.js); each is also tried with the output directory mapped to src/.
 * `declared` are entries the manifest names; `fallback` are conventional guesses.
 */
export function entryCandidates(pkg: WorkspacePackage, sub: string): { declared: string[]; fallback: string[] } {
  const declared: string[] = [];
  const subpath = sub === '' ? '.' : `./${sub}`;
  const ex = pkg.entry.exports;
  if (ex !== null && ex !== undefined) {
    const conditional = isRecord(ex) && !Object.keys(ex).some((k) => k.startsWith('.'));
    if (typeof ex === 'string' || Array.isArray(ex) || conditional) {
      if (sub === '') leaves(ex, declared);
    } else if (isRecord(ex)) {
      for (const [key, val] of Object.entries(ex)) {
        const star = key.indexOf('*');
        if (star === -1) {
          if (key === subpath) leaves(val, declared);
        } else if (subpath.startsWith(key.slice(0, star)) && subpath.endsWith(key.slice(star + 1)) && subpath.length >= key.length - 1) {
          const cap = subpath.slice(star, subpath.length - (key.length - star - 1));
          const hits: string[] = [];
          leaves(val, hits);
          // Node's package exports replace EVERY "*" in the target with the captured subpath.
          declared.push(...hits.map((h) => h.split('*').join(cap)));
        }
      }
    }
  }
  const fallback: string[] = [];
  if (sub === '') {
    for (const f of [pkg.entry.main, pkg.entry.module, pkg.entry.source, pkg.entry.types]) if (f) declared.push(f);
    fallback.push('src/index', 'index', 'lib/index');
  } else fallback.push(sub, `src/${sub}`);
  const expand = (c: string): string[] => {
    const n = path.posix.normalize(c.replace(/^\.\//, ''));
    if (n.startsWith('..') || path.posix.isAbsolute(n)) return [];
    const stem = n.replace(/\.d\.[cm]?ts$/, '');
    const variants = [n, stem];
    const m = /^(dist|lib|build|out|esm|cjs|types)\/(.*)$/.exec(stem);
    if (m) variants.push(`src/${m[2]}`);
    return variants;
  };
  return { declared: declared.flatMap(expand), fallback: fallback.flatMap(expand) };
}

// ---------------------------------------------------------------------------------------------
// Package-level change impact (--affected)

export interface PackageSelection {
  mode: 'affected' | 'all';
  /** Why every package was selected (mode "all"). */
  reason: string | null;
  affected: string[];
  skipped: string[];
  /** affected package -> why it is affected. */
  why: Record<string, string>;
}

/**
 * Packages whose tasks may be affected by `changed`: packages containing changed files or modules
 * reached from them through imports, plus everything that (transitively) depends on those, through
 * package.json dependencies or observed cross-package imports. Unboundable changes select all.
 */
export function selectPackages(ws: Workspace, graph: DepGraph, prev: DepGraph | null, changed: string[]): PackageSelection {
  const names = ws.packages.map((p) => p.name);
  const all = (reason: string): PackageSelection => ({
    mode: 'all', reason, affected: names, skipped: [], why: Object.fromEntries(names.map((n) => [n, reason])),
  });
  if (changed.length === 0) return { mode: 'affected', reason: null, affected: [], skipped: names, why: {} };
  const shared = changed.find((c) => isRootShared(c));
  if (shared) return all(`workspace-wide file changed: ${shared}`);
  const { reached, conservative } = graph.impact(changed, prev);
  if (conservative) return all(conservative);

  const why = new Map<string, string>();
  const queue: string[] = [];
  const mark = (pkg: string, reason: string) => {
    if (!why.has(pkg)) {
      why.set(pkg, reason);
      queue.push(pkg);
    }
  };
  for (const c of changed) {
    const p = ws.packageOfFile(c);
    if (p) mark(p.name, `changed file ${c}`);
  }
  for (const [m, pred] of reached) {
    const pk = graph.modules.get(m)?.pkg;
    if (pk && pred !== null) mark(pk, `${m} imports changed code`);
  }
  // Reverse edges: declared dependencies plus imports observed in the module graph.
  const rev = new Map<string, Set<string>>();
  const add = (from: string, to: string) => {
    if (!rev.has(to)) rev.set(to, new Set());
    rev.get(to)!.add(from);
  };
  for (const p of ws.packages) for (const d of p.workspaceDeps) add(p.name, d);
  for (const [from, tos] of graph.packageEdges()) for (const to of tos) add(from, to);
  for (let i = 0; i < queue.length; i++) {
    const cur = queue[i]!;
    for (const dep of [...(rev.get(cur) ?? [])].sort()) mark(dep, `depends on ${cur}`);
  }
  const affected = names.filter((n) => why.has(n));
  return {
    mode: 'affected',
    reason: null,
    affected,
    skipped: names.filter((n) => !why.has(n)),
    why: Object.fromEntries(affected.map((n) => [n, why.get(n)!])),
  };
}
