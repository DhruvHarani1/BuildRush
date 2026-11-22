import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { Cache } from './cache.js';
import { Config, findProjectRoot, loadConfig } from './config.js';
import { FileIndex } from './fsindex.js';
import { DepGraph, SerializedGraph } from './graph.js';
import { readJson, writeFileAtomic } from './util/fsx.js';
import { compileGlobs } from './util/glob.js';

export class Project {
  readonly stateDir: string;
  private graphCache: DepGraph | null = null;

  private constructor(
    readonly root: string,
    readonly config: Config,
    readonly index: FileIndex,
    readonly cache: Cache,
  ) {
    this.stateDir = path.join(root, '.buildrush', 'state');
  }

  static async open(start: string, opts: { scan?: boolean } = {}): Promise<Project> {
    const found = await findProjectRoot(start);
    if (!found) throw new Error(`no buildrush.json found in ${start} or any parent directory (run \`buildrush init\`)`);
    const root = await fs.realpath(found);
    const config = await loadConfig(root);
    const stateDir = path.join(root, '.buildrush', 'state');
    const cacheDir = process.env.BUILDRUSH_CACHE_DIR
      ? path.resolve(process.env.BUILDRUSH_CACHE_DIR)
      : config.cache.dir
        ? path.resolve(root, config.cache.dir)
        : path.join(root, '.buildrush', 'cache');
    const index = new FileIndex(root, config.ignore, path.join(stateDir, 'index.json'));
    const cache = new Cache(cacheDir);
    await cache.init();
    await fs.mkdir(stateDir, { recursive: true, mode: 0o700 });
    const p = new Project(root, config, index, cache);
    if (opts.scan !== false) {
      await index.load();
      await index.scan();
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
    this.graphCache = await DepGraph.build(this.root, files, {
      testPatterns: this.config.tests.patterns,
      cachePath: path.join(this.stateDir, 'scan-cache.json'),
    });
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
