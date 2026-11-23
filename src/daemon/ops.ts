import * as path from 'node:path';
import { detectProject } from '../detect.js';
import { readStats, RunReport } from '../engine.js';
import { DepGraph } from '../graph.js';
import { Project } from '../project.js';
import { writeFileAtomic } from '../util/fsx.js';

/**
 * Operations shared verbatim by the one-shot CLI and the daemon, so both produce byte-identical
 * results from the same code (the daemon never has its own copy of the logic).
 */

/** Package -> packages it imports from, as observed in the module graph (sorted, for display). */
export function packageImportEdges(g: DepGraph): Map<string, string[]> {
  return new Map([...g.packageEdges()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, [...v].sort()]));
}

export async function analyze(p: Project) {
  const det = await detectProject(p.root);
  const g = await p.graph();
  await p.saveGraph(g);
  const cycles = g.cycles();
  const uncertain = [...g.modules.values()].filter((m) => m.uncertain.length);
  const edges = [...g.deps.values()].reduce((n, m) => n + m.size, 0);
  const result = {
    project: p.config.project.name,
    root: p.root,
    packageManager: det.packageManager,
    tools: det.tools,
    workspacePackages: Object.fromEntries(g.workspacePackages),
    workspace: p.workspace ? { ...p.workspace.summary(), importEdges: Object.fromEntries(packageImportEdges(g)), cycle: p.workspace.findCycle() } : null,
    files: p.index.files.size,
    modules: g.modules.size,
    edges,
    tests: g.testFiles().length,
    importCycles: cycles,
    uncertainModules: uncertain.map((m) => ({ path: m.path, reasons: m.uncertain })),
    skippedSymlinks: p.index.skippedSymlinks.length,
    tasks: Object.fromEntries(Object.values(p.config.tasks).map((t) => [t.name, { kind: t.kind, dependsOn: t.dependsOn, cache: t.cache }])),
  };
  return { result, det, g, uncertain, cycles, edges };
}

export async function cacheStats(p: Project) {
  const stats = await p.cache.stats();
  const lifetime = await readStats(p);
  return { stats, lifetime, maxSizeMB: p.config.cache.maxSizeMB };
}

/** What `buildrush explain` reads back; written after every run, in-process or via the daemon. */
export async function writeLastRun(p: Project, requested: string[], report: RunReport): Promise<void> {
  await writeFileAtomic(
    path.join(p.stateDir, 'last-run.json'),
    JSON.stringify({ at: Date.now(), requested, tasks: report.tasks.map((t) => ({ ...t, log: undefined })), selection: report.selection, packages: report.packages ?? null }),
  );
}
