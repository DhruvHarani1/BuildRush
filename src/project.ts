import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { Cache } from './cache.js';
import { Config, findProjectRoot, loadConfig } from './config.js';
import { resolveAdapter } from './adapters.js';
import { FileIndex } from './fsindex.js';
import { DepGraph, SerializedGraph } from './graph.js';
import { readJson, writeFileAtomic } from './util/fsx.js';
import { compileGlobs } from './util/glob.js';
import { discoverWorkspaces, expandWorkspaceTasks, finalizePackageTasks, Workspace } from './workspaces.js';

/**
 * State a long-lived process (the daemon) may carry between Project.open calls. Everything here is
 * either validated on reuse (index: re-scanned by stat/content every time; graph: keyed by the
 * digests of every input) or discarded when its key changes. Nothing here may skip validation.
 */
export interface WarmState {
  index?: FileIndex;
  /** Identity of what the index was built for (root + ignore globs); a mismatch drops it. */
  indexKey?: string;
  graph?: { key: string; graph: DepGraph };
}

export class Project {
  readonly stateDir: string;
  private graphCache: DepGraph | null = null;
  private warm: WarmState | null = null;

  private constructor(
    readonly root: string,
    readonly config: Config,
    readonly index: FileIndex,
    readonly cache: Cache,
    /** Detected workspace (monorepo), or null. */
    readonly workspace: Workspace | null = null,
    /** Package-task template name -> its per-package instance ids. */
    readonly taskGroups: Record<string, string[]> = {},
  ) {
    this.stateDir = path.join(root, '.buildrush', 'state');
  }

  static async open(start: string, opts: { scan?: boolean; env?: NodeJS.ProcessEnv; warm?: WarmState } = {}): Promise<Project> {
    const found = await findProjectRoot(start);
    if (!found) throw new Error(`no buildrush.json found in ${start} or any parent directory (run \`buildrush init\`)`);
    const root = await fs.realpath(found);
    const config = await loadConfig(root);
    const workspace = await discoverWorkspaces(root, config.workspaces);
    const taskGroups = expandWorkspaceTasks(config, workspace);
    for (const t of Object.values(config.tasks)) {
      if (!t.adapter) continue;
      const cwd = t.cwd === '.' ? root : path.join(root, t.cwd);
      let r;
      try {
        r = await resolveAdapter(t.adapter, cwd, t);
      } catch (e) {
        throw new Error(`tasks.${t.name} (adapter ${t.adapter}): ${(e as Error).message}`);
      }
      t.command = r.command;
      t.inputs ??= r.inputs;
      const userOutputs = t.outputs.length > 0;
      if (!userOutputs) t.outputs = r.outputs;
      t.env = [...new Set([...t.env, ...r.env])];
      t.envPrefixes = r.envPrefixes;
      if (!r.cache && !userOutputs) t.cache = false;
      t.notes = r.notes;
      if (t.testCache && t.adapter === 'vitest') {
        const customised = r.inputs === null || t.command.some((a) => /^(--config|-c|--root|-r|--dir|--workspace|--project)(=|$)/.test(a));
        if (customised) {
          t.testCache = false;
          t.notes.push('testCache disabled: the vitest config/command customises root/include/setupFiles/dir, so per-file inputs cannot be bounded safely.');
        }
      }
    }
    finalizePackageTasks(config);
    const stateDir = path.join(root, '.buildrush', 'state');
    const envCacheDir = (opts.env ?? process.env).BUILDRUSH_CACHE_DIR;
    const cacheDir = envCacheDir
      ? path.resolve(envCacheDir)
      : config.cache.dir
        ? path.resolve(root, config.cache.dir)
        : path.join(root, '.buildrush', 'cache');
    const indexKey = JSON.stringify([root, config.ignore]);
    const reuse = opts.warm?.index && opts.warm.indexKey === indexKey ? opts.warm.index : null;
    const index = reuse ?? new FileIndex(root, config.ignore, path.join(stateDir, 'index.json'));
    const cache = new Cache(cacheDir);
    await cache.init();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const p = new Project(root, config, index, cache, workspace, taskGroups);
    if (opts.warm) p.warm = opts.warm;
    if (opts.scan !== false) {
      if (!reuse) await index.load();
      await index.scan(); // always: a warm index is a starting point, never an answer
      if (opts.warm) {
        opts.warm.index = index;
        opts.warm.indexKey = indexKey;
      }
    }
    return p;
  }

  /** Union of every task's output globs: files BuildRush itself produces. */
  outputMatcher(): (rel: string) => boolean {
    return compileGlobs(Object.values(this.config.tasks).flatMap((t) => t.outputs));
  }

  async graph(opts: { fresh?: boolean } = {}): Promise<DepGraph> {
    if (this.graphCache && !opts.fresh) return this.graphCache;
    const isOutput = this.outputMatcher();
    // Generated outputs are not source: keep them out of the module graph.
    const files = new Map([...this.index.files].filter(([f]) => !isOutput(f)));
    let key = '';
    if (this.warm) {
      // The graph is a pure function of (file digests, test patterns, workspace layout).
      const h = createHash('sha256');
      h.update(JSON.stringify([this.root, this.config.tests.patterns, this.workspace]));
      for (const f of [...files.keys()].sort()) h.update(`\0${f}\0${files.get(f)!.digest}`);
      key = h.digest('hex');
      if (!opts.fresh && this.warm.graph?.key === key) return (this.graphCache = this.warm.graph.graph);
    }
    this.graphCache = await DepGraph.build(this.root, files, {
      testPatterns: this.config.tests.patterns,
      cachePath: path.join(this.stateDir, 'scan-cache.json'),
      workspace: this.workspace,
    });
    if (this.warm) this.warm.graph = { key, graph: this.graphCache };
    return this.graphCache;
  }

  async loadPreviousGraph(): Promise<DepGraph | null> {
    const s = await readJson<SerializedGraph>(path.join(this.stateDir, 'graph.json'));
    return s && s.version === 1 ? DepGraph.deserialize(s) : null;
  }

  async saveGraph(g: DepGraph): Promise<void> {
    await writeFileAtomic(path.join(this.stateDir, 'graph.json'), JSON.stringify(g.serialize()));
  }
}
