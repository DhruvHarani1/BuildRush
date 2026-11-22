import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { compileGlobs } from './util/glob.js';
import { mapLimit } from './util/hash.js';
import { readJson, writeFileAtomic } from './util/fsx.js';

export type EdgeKind = 'import' | 'dynamic-import' | 'require' | 'package';

export const CODE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'];
const RESOLVE_EXT = ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs', '.json'];
const JS_TO_TS: Record<string, string[]> = {
  '.js': ['.ts', '.tsx'],
  '.jsx': ['.tsx'],
  '.mjs': ['.mts'],
  '.cjs': ['.cts'],
};

export interface ScanResult {
  specs: { spec: string; kind: EdgeKind }[];
  /** Reasons this file's dependencies cannot be fully determined statically. */
  uncertain: string[];
}

/**
 * Extract module specifiers. This deliberately OVER-approximates: text in
 * comments or strings can create extra edges (which only ever causes extra
 * work, never skipped work). Non-literal dynamic loading is reported as
 * uncertainty so callers can fall back to conservative selection.
 */
export function scanSource(src: string): ScanResult {
  const specs: ScanResult['specs'] = [];
  const uncertain: string[] = [];
  const add = (spec: string, kind: EdgeKind) => specs.push({ spec, kind });
  let m: RegExpExecArray | null;
  // `\s+(?=\S)` makes the whitespace run atomic: without it `import` + N spaces backtracks cubically.
  // The lookahead alternative also accepts minified forms such as `import{a}from"x"` / `import"x"`.
  const stat = /\b(?:import|export)(?:\s+(?=\S)|(?=[{*'"]))(?:type\s+)?(?:[^'"`;]*?\bfrom\s*|\s*)(['"])([^'"\n]+)\1/g;
  while ((m = stat.exec(src))) add(m[2]!, 'import');
  const dyn = /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*[,)]/g;
  while ((m = dyn.exec(src))) add(m[2]!, 'dynamic-import');
  const req = /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = req.exec(src))) add(m[2]!, 'require');
  const impEq = /\bimport\s+\w+\s*=\s*require\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g;
  while ((m = impEq.exec(src))) add(m[2]!, 'require');
  if (/\bimport\s*\(\s*(?![\s'"])/.test(src)) uncertain.push('dynamic import() with non-literal specifier');
  if (/(?<![\w.$])require\s*\(\s*(?![\s'"])/.test(src)) uncertain.push('require() with non-literal specifier');
  if (/\bimport\.meta\.glob(?:Eager)?\s*\(/.test(src)) uncertain.push('import.meta.glob()');
  if (/\brequire\.context\s*\(/.test(src)) uncertain.push('require.context()');
  return { specs, uncertain };
}

/** Strip comments and trailing commas so tsconfig.json can be parsed. */
export function parseJsonc(text: string): unknown {
  let out = '';
  let inStr = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!;
    if (inStr) {
      out += c;
      if (c === '\\') out += text[++i] ?? '';
      else if (c === '"') inStr = false;
    } else if (c === '"') {
      inStr = true;
      out += c;
    } else if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      out += '\n';
    } else if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i++;
    } else out += c;
  }
  return JSON.parse(out.replace(/,(\s*[}\]])/g, '$1'));
}

export interface GraphModule {
  path: string;
  uncertain: string[];
  isTest: boolean;
  pkg: string | null;
}

interface PathsConfig {
  baseUrl: string | null;
  paths: Record<string, string[]>;
}

export interface SerializedGraph {
  version: 1;
  modules: Record<string, { uncertain: string[]; isTest: boolean; pkg: string | null }>;
  edges: Record<string, Record<string, EdgeKind>>;
}

export interface ImpactResult {
  /** module -> predecessor on the shortest path back to a changed file (null for changed files). */
  reached: Map<string, string | null>;
  /** Set when the change cannot be bounded statically; value is the reason. */
  conservative: string | null;
}

/** Files whose change can alter ANY task or test in ways imports cannot express. */
export const GLOBAL_CONFIG = [
  'package.json', '**/package.json', 'package-lock.json', 'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'bun.lockb',
  'tsconfig*.json', '**/tsconfig*.json', 'buildrush.json', '.env', '.env.*', '**/.env', '**/.env.*',
  'vitest.config.*', 'vite.config.*', 'jest.config.*', '**/vitest.config.*', '**/vite.config.*', '**/jest.config.*',
  'vitest.workspace.*', '.npmrc', '.nvmrc', '.node-version',
];

export class DepGraph {
  modules = new Map<string, GraphModule>();
  deps = new Map<string, Map<string, EdgeKind>>();
  rdeps = new Map<string, Map<string, EdgeKind>>();
  externals = new Map<string, Set<string>>();
  workspacePackages = new Map<string, string>(); // name -> dir (rel)

  static async build(
    root: string,
    files: ReadonlyMap<string, { digest: string }>,
    opts: { testPatterns: string[]; cachePath?: string },
  ): Promise<DepGraph> {
    const g = new DepGraph();
    const isTest = compileGlobs(opts.testPatterns);
    const codeFiles = [...files.keys()].filter((f) => CODE_EXT.includes(path.extname(f)));
    const known = new Set(files.keys());

    await g.loadWorkspaces(root, files.keys());
    const ts = await loadTsPaths(root);

    // Scanning is cached by content digest so unchanged files are never re-read.
    const scanCache = (opts.cachePath ? await readJson<Record<string, ScanResult>>(opts.cachePath) : null) ?? {};
    const nextCache: Record<string, ScanResult> = {};
    const scans = new Map<string, ScanResult>();
    await mapLimit(codeFiles, 16, async (f) => {
      const digest = files.get(f)!.digest;
      let r = scanCache[digest];
      if (!r) r = scanSource(await fs.readFile(path.join(root, f), 'utf8'));
      nextCache[digest] = r;
      scans.set(f, r);
    });
    if (opts.cachePath) await writeFileAtomic(opts.cachePath, JSON.stringify(nextCache)).catch(() => undefined);

    for (const f of codeFiles) {
      const scan = scans.get(f)!;
      const uncertain = [...scan.uncertain];
      g.modules.set(f, { path: f, uncertain, isTest: isTest(f), pkg: g.packageOf(f) });
    }
    for (const f of codeFiles) {
      const scan = scans.get(f)!;
      const mod = g.modules.get(f)!;
      for (const { spec, kind } of scan.specs) {
        const r = g.resolve(f, spec, known, ts);
        if (r.type === 'internal') {
          if (!g.modules.has(r.path)) {
            g.modules.set(r.path, { path: r.path, uncertain: [], isTest: false, pkg: g.packageOf(r.path) });
          }
          g.addEdge(f, r.path, r.viaPackage ? 'package' : kind);
        } else if (r.type === 'external') {
          if (!g.externals.has(f)) g.externals.set(f, new Set());
          g.externals.get(f)!.add(r.name);
        } else {
          mod.uncertain.push(`unresolved import ${JSON.stringify(spec)}`);
        }
      }
    }
    return g;
  }

  private addEdge(from: string, to: string, kind: EdgeKind) {
    if (!this.deps.has(from)) this.deps.set(from, new Map());
    this.deps.get(from)!.set(to, kind);
    if (!this.rdeps.has(to)) this.rdeps.set(to, new Map());
    this.rdeps.get(to)!.set(from, kind);
  }

  private packageOf(file: string): string | null {
    let best: string | null = null;
    let bestLen = -1;
    for (const [name, dir] of this.workspacePackages) {
      if ((dir === '.' || file.startsWith(dir + '/')) && dir.length > bestLen) {
        best = name;
        bestLen = dir.length;
      }
    }
    return best;
  }

  private async loadWorkspaces(root: string, files: Iterable<string>) {
    for (const f of files) {
      if (path.posix.basename(f) !== 'package.json') continue;
      const pkg = await readJson<{ name?: string }>(path.join(root, f));
      if (pkg && typeof pkg.name === 'string') {
        const dir = path.posix.dirname(f);
        this.workspacePackages.set(pkg.name, dir === '.' ? '.' : dir);
      }
    }
  }

  private resolve(
    from: string,
    spec: string,
    known: Set<string>,
    ts: PathsConfig,
  ): { type: 'internal'; path: string; viaPackage?: boolean } | { type: 'external'; name: string } | { type: 'unresolved' } {
    if (spec.startsWith('node:')) return { type: 'external', name: spec };
    if (spec.startsWith('./') || spec.startsWith('../') || spec === '.' || spec === '..') {
      const base = path.posix.normalize(path.posix.join(path.posix.dirname(from), spec));
      const hit = tryFile(base, known);
      return hit ? { type: 'internal', path: hit } : { type: 'unresolved' };
    }
    if (spec.startsWith('#') || spec.startsWith('@/') || spec.startsWith('~/') || spec.startsWith('/')) {
      // Package imports / bundler aliases we cannot fully model: try tsconfig paths, else uncertain.
      const viaPaths = resolveTsPaths(spec, ts, known);
      return viaPaths ? { type: 'internal', path: viaPaths } : { type: 'unresolved' };
    }
    const viaPaths = resolveTsPaths(spec, ts, known);
    if (viaPaths) return { type: 'internal', path: viaPaths };
    const name = spec.startsWith('@') ? spec.split('/').slice(0, 2).join('/') : spec.split('/')[0]!;
    const wsDir = this.workspacePackages.get(name);
    if (wsDir !== undefined && wsDir !== '.') {
      const sub = spec.slice(name.length + 1);
      const candidates = sub
        ? [path.posix.join(wsDir, sub), path.posix.join(wsDir, 'src', sub)]
        : [path.posix.join(wsDir, 'src/index'), path.posix.join(wsDir, 'index'), path.posix.join(wsDir, 'lib/index')];
      for (const c of candidates) {
        const hit = tryFile(c, known);
        if (hit) return { type: 'internal', path: hit, viaPackage: true };
      }
      return { type: 'unresolved' };
    }
    return { type: 'external', name };
  }

  /** Reverse transitive closure with parent pointers (shortest chain back to a changed file). */
  impact(changed: string[], prev?: DepGraph | null): ImpactResult {
    const reached = new Map<string, string | null>();
    const queue: string[] = [];
    let conservative: string | null = null;
    const isGlobalConfig = compileGlobs(GLOBAL_CONFIG);
    for (const c of changed) {
      if (!conservative && isGlobalConfig(c)) conservative = `global configuration changed: ${c}`;
      reached.set(c, null);
      queue.push(c);
    }
    for (let i = 0; i < queue.length; i++) {
      const cur = queue[i]!;
      const importers = new Set<string>([...(this.rdeps.get(cur)?.keys() ?? []), ...(prev?.rdeps.get(cur)?.keys() ?? [])]);
      for (const imp of importers) {
        if (!reached.has(imp)) {
          reached.set(imp, cur);
          queue.push(imp);
        }
      }
    }
    if (!conservative) {
      for (const m of reached.keys()) {
        const mod = this.modules.get(m);
        // An unresolved RELATIVE import cannot hide a dependency on another file (its target does
        // not exist). Unresolved aliases and non-literal dynamic loading can, so they are unbounded.
        const unbounded = mod?.uncertain.find((u) => !/^unresolved import "\.\.?\//.test(u));
        if (mod && unbounded && !mod.isTest) {
          conservative = `${m} has uncertain dependencies (${unbounded})`;
          break;
        }
      }
    }
    return { reached, conservative };
  }

  chain(reached: Map<string, string | null>, node: string): string[] {
    const out = [node];
    let cur = reached.get(node);
    while (cur) {
      out.push(cur);
      cur = reached.get(cur);
    }
    return out; // node -> ... -> changed file
  }

  testFiles(): string[] {
    return [...this.modules.values()].filter((m) => m.isTest).map((m) => m.path).sort();
  }

  /** Import cycles (strongly connected components of size > 1), via Tarjan. */
  cycles(): string[][] {
    let idx = 0;
    const stack: string[] = [];
    const on = new Set<string>();
    const num = new Map<string, number>();
    const low = new Map<string, number>();
    const out: string[][] = [];
    const strong = (v: string) => {
      num.set(v, idx);
      low.set(v, idx++);
      stack.push(v);
      on.add(v);
      for (const w of this.deps.get(v)?.keys() ?? []) {
        if (!num.has(w)) {
          strong(w);
          low.set(v, Math.min(low.get(v)!, low.get(w)!));
        } else if (on.has(w)) low.set(v, Math.min(low.get(v)!, num.get(w)!));
      }
      if (low.get(v) === num.get(v)) {
        const comp: string[] = [];
        let w: string;
        do {
          w = stack.pop()!;
          on.delete(w);
          comp.push(w);
        } while (w !== v);
        if (comp.length > 1) out.push(comp.sort());
      }
    };
    for (const v of [...this.modules.keys()].sort()) if (!num.has(v)) strong(v);
    return out;
  }

  serialize(): SerializedGraph {
    const modules: SerializedGraph['modules'] = {};
    for (const [k, m] of [...this.modules].sort(([a], [b]) => (a < b ? -1 : 1))) {
      modules[k] = { uncertain: m.uncertain, isTest: m.isTest, pkg: m.pkg };
    }
    const edges: SerializedGraph['edges'] = {};
    for (const [k, m] of [...this.deps].sort(([a], [b]) => (a < b ? -1 : 1))) edges[k] = Object.fromEntries([...m].sort());
    return { version: 1, modules, edges };
  }

  static deserialize(s: SerializedGraph): DepGraph {
    const g = new DepGraph();
    for (const [k, m] of Object.entries(s.modules)) g.modules.set(k, { path: k, ...m });
    for (const [from, m] of Object.entries(s.edges)) for (const [to, kind] of Object.entries(m)) g.addEdge(from, to, kind);
    return g;
  }
}

function tryFile(base: string, known: Set<string>): string | null {
  if (known.has(base)) return base;
  const ext = path.posix.extname(base);
  const stem = ext ? base.slice(0, -ext.length) : base;
  for (const e of JS_TO_TS[ext] ?? []) if (known.has(stem + e)) return stem + e;
  for (const e of RESOLVE_EXT) if (known.has(base + e)) return base + e;
  for (const e of RESOLVE_EXT) if (known.has(`${base}/index${e}`)) return `${base}/index${e}`;
  return null;
}

async function loadTsPaths(root: string): Promise<PathsConfig> {
  const result: PathsConfig = { baseUrl: null, paths: {} };
  let file = path.join(root, 'tsconfig.json');
  for (let depth = 0; depth < 5; depth++) {
    let cfg: { extends?: string; compilerOptions?: { baseUrl?: string; paths?: Record<string, string[]> } };
    try {
      cfg = parseJsonc(await fs.readFile(file, 'utf8')) as typeof cfg;
    } catch {
      break;
    }
    const co = cfg.compilerOptions ?? {};
    const dir = path.dirname(file);
    if (result.baseUrl === null && co.baseUrl !== undefined) {
      result.baseUrl = path.posix.normalize(path.relative(root, path.resolve(dir, co.baseUrl)).split(path.sep).join('/') || '.');
    }
    if (co.paths && Object.keys(result.paths).length === 0) {
      const base = result.baseUrl ?? (path.relative(root, dir).split(path.sep).join('/') || '.');
      for (const [k, v] of Object.entries(co.paths)) result.paths[k] = v.map((t) => path.posix.normalize(path.posix.join(base, t)));
    }
    if (typeof cfg.extends === 'string' && cfg.extends.startsWith('.')) {
      file = path.resolve(dir, cfg.extends.endsWith('.json') ? cfg.extends : cfg.extends + '.json');
    } else break;
  }
  return result;
}

function resolveTsPaths(spec: string, ts: PathsConfig, known: Set<string>): string | null {
  for (const [pat, targets] of Object.entries(ts.paths)) {
    const star = pat.indexOf('*');
    let captured: string | null = null;
    if (star === -1) captured = pat === spec ? '' : null;
    else if (spec.startsWith(pat.slice(0, star)) && spec.endsWith(pat.slice(star + 1)) && spec.length >= pat.length - 1) {
      captured = spec.slice(star, spec.length - (pat.length - star - 1));
    }
    if (captured === null) continue;
    for (const t of targets) {
      const hit = tryFile(path.posix.normalize(t.replace('*', captured)), known);
      if (hit) return hit;
    }
  }
  if (ts.baseUrl !== null && !spec.startsWith('.')) {
    const hit = tryFile(path.posix.normalize(path.posix.join(ts.baseUrl, spec)), known);
    if (hit) return hit;
  }
  return null;
}
