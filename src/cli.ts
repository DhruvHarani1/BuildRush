import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { createRequire } from 'node:module';
import { CONFIG_FILE, ConfigError, findProjectRoot, loadConfig } from './config.js';
import { detectProject, starterConfig } from './detect.js';
import { closure, expandNames, loadTaskState, readStats, RunReport, runTasks, TaskReport } from './engine.js';
import { Project } from './project.js';
import { selectTests } from './affected.js';
import { runDoctor } from './doctor.js';
import { readJson, writeFileAtomic } from './util/fsx.js';
import { compileGlobs } from './util/glob.js';

export const EXIT = { OK: 0, FAILED: 1, USAGE: 2, INTERNAL: 3, CANCELLED: 130 } as const;

const VERSION: string = (createRequire(import.meta.url)('../../package.json') as { version: string }).version;

const HELP = `buildrush ${VERSION} - local-first incremental build & test engine

Usage: buildrush <command> [options]

Commands:
  init                     Create ${CONFIG_FILE} from the detected project
  analyze                  Summarise the project, tasks and module graph
  graph [--dot]            Print the module dependency graph (JSON, or Graphviz with --dot)
  run [task|pipeline...]   Run tasks (default pipeline "default") with caching
  build | test | check     Shortcuts for the task or pipeline of that name
  explain [task|file]      Why tasks ran or were reused; what a file change affects
  cache stats|verify|clean Inspect, verify (--repair) or empty the local cache
  doctor                   Diagnose environment, config and cache problems
  config validate          Validate ${CONFIG_FILE}

Options:
  --affected               Run only tests affected by changes (test tasks; falls back to all tests when unsure)
  --since <git-ref>        Baseline for --affected (default HEAD)
  --no-cache               Execute everything; do not read or write the cache
  --bail                   Cancel remaining work after the first failure
  --concurrency <n>        Max parallel resource units
  --root <dir>             Project directory (default: nearest ${CONFIG_FILE})
  --json                   Machine-readable output
  --verbose, -v            Show task logs and details
  --quiet, -q              Only print failures and the final summary
  -h, --help               Show help        --version  Show version

Exit codes: 0 success, 1 task failure, 2 usage/config error, 3 internal error, 130 cancelled.
`;

interface Flags {
  json: boolean; verbose: boolean; quiet: boolean; affected: boolean; noCache: boolean; bail: boolean;
  force: boolean; repair: boolean; dot: boolean; help: boolean; version: boolean;
  since?: string; concurrency?: number; root?: string;
}

export function parseArgs(argv: string[]): { positional: string[]; flags: Flags } {
  const flags: Flags = {
    json: false, verbose: false, quiet: false, affected: false, noCache: false, bail: false,
    force: false, repair: false, dot: false, help: false, version: false,
  };
  const positional: string[] = [];
  const need = (i: number, name: string): string => {
    const v = argv[i + 1];
    if (v === undefined || v.startsWith('--')) throw new UsageError(`${name} requires a value`);
    return v;
  };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!;
    switch (a) {
      case '--json': flags.json = true; break;
      case '--verbose': case '-v': flags.verbose = true; break;
      case '--quiet': case '-q': flags.quiet = true; break;
      case '--affected': flags.affected = true; break;
      case '--no-cache': flags.noCache = true; break;
      case '--bail': flags.bail = true; break;
      case '--force': flags.force = true; break;
      case '--repair': flags.repair = true; break;
      case '--dot': flags.dot = true; break;
      case '--help': case '-h': flags.help = true; break;
      case '--version': flags.version = true; break;
      case '--since': flags.since = need(i++, a); break;
      case '--root': flags.root = need(i++, a); break;
      case '--concurrency': {
        const n = Number(need(i++, a));
        if (!Number.isInteger(n) || n < 1) throw new UsageError('--concurrency must be a positive integer');
        flags.concurrency = n;
        break;
      }
      case '--': positional.push(...argv.slice(i + 1)); i = argv.length; break;
      default:
        if (a.startsWith('-') && a.length > 1) throw new UsageError(`unknown option ${a}`);
        positional.push(a);
    }
  }
  return { positional, flags };
}

class UsageError extends Error {}

const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== 'dumb';
const paint = (code: number, s: string) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const dim = (s: string) => paint(2, s);

function fmtMs(ms: number): string {
  return ms < 1000 ? `${Math.round(ms)}ms` : `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)}s`;
}
function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const u = ['KiB', 'MiB', 'GiB', 'TiB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return `${v.toFixed(1)} ${u[i]}`;
}

export async function main(argv: string[]): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (e) {
    console.error(`buildrush: ${(e as Error).message}\nRun \`buildrush --help\` for usage.`);
    return EXIT.USAGE;
  }
  const { positional, flags } = parsed;
  if (flags.version) { console.log(VERSION); return EXIT.OK; }
  const [cmd, ...rest] = positional;
  if (flags.help || !cmd || cmd === 'help') { console.log(HELP); return cmd || flags.help ? EXIT.OK : EXIT.USAGE; }

  const ac = new AbortController();
  let interrupted = 0;
  const onSig = () => {
    if (++interrupted > 1) process.exit(EXIT.CANCELLED);
    if (!flags.json) console.error('\nbuildrush: cancelling (press Ctrl+C again to force quit)...');
    ac.abort();
  };
  process.on('SIGINT', onSig);
  process.on('SIGTERM', onSig);

  try {
    switch (cmd) {
      case 'init': return await cmdInit(flags);
      case 'analyze': return await cmdAnalyze(flags);
      case 'graph': return await cmdGraph(flags);
      case 'run': return await cmdRun(rest.length ? rest : ['default'], flags, ac.signal);
      case 'build': case 'test': case 'check': return await cmdRun([cmd], flags, ac.signal);
      case 'explain': return await cmdExplain(rest[0], flags);
      case 'cache': return await cmdCache(rest[0], flags);
      case 'doctor': return await cmdDoctor(flags);
      case 'config':
        if (rest[0] === 'validate') return await cmdValidate(flags);
        throw new UsageError('usage: buildrush config validate');
      default: throw new UsageError(`unknown command ${JSON.stringify(cmd)}`);
    }
  } catch (e) {
    if (e instanceof UsageError || e instanceof ConfigError) {
      console.error(`buildrush: ${(e as Error).message}${e instanceof UsageError ? '\nRun `buildrush --help` for usage.' : ''}`);
      return EXIT.USAGE;
    }
    if (e instanceof Error && /no buildrush\.json|unknown task|dependency cycle/.test(e.message)) {
      console.error(`buildrush: ${e.message}`);
      return EXIT.USAGE;
    }
    throw e;
  } finally {
    process.off('SIGINT', onSig);
    process.off('SIGTERM', onSig);
  }
}

const startDir = (f: Flags) => path.resolve(f.root ?? process.cwd());
const open = (f: Flags, scan = true) => Project.open(startDir(f), { scan });
const printJson = (v: unknown) => console.log(JSON.stringify(v, null, 2));

async function cmdInit(f: Flags): Promise<number> {
  const root = startDir(f);
  const file = path.join(root, CONFIG_FILE);
  if (!f.force && (await fs.access(file).then(() => true, () => false))) {
    console.error(`buildrush: ${CONFIG_FILE} already exists (use --force to overwrite)`);
    return EXIT.USAGE;
  }
  const det = await detectProject(root);
  const cfg = starterConfig(det);
  if (Object.keys(cfg.tasks as object).length === 0) {
    console.error(
      'buildrush: no supported tools or package scripts detected (looked for vite, vitest, eslint, typescript and build/test/lint scripts).\n' +
        `Create ${CONFIG_FILE} by hand; see docs/configuration.md.`,
    );
    return EXIT.USAGE;
  }
  await writeFileAtomic(file, JSON.stringify(cfg, null, 2) + '\n', 0o644);
  if (f.json) printJson({ created: file, detected: det });
  else {
    console.log(`Created ${CONFIG_FILE} (${Object.keys(cfg.tasks as object).join(', ')}).`);
    console.log(`Detected: ${det.packageManager ?? 'no lockfile'}, tools: ${det.tools.join(', ') || 'none'}.`);
    console.log('Next: add ".buildrush/" to .gitignore, review the file, then run `buildrush doctor` and `buildrush run`.');
  }
  return EXIT.OK;
}

async function cmdValidate(f: Flags): Promise<number> {
  const root = await findProjectRoot(startDir(f));
  if (!root) throw new Error(`no ${CONFIG_FILE} found`);
  const cfg = await loadConfig(root);
  if (f.json) printJson({ ok: true, tasks: Object.keys(cfg.tasks) });
  else console.log(`${CONFIG_FILE} is valid (${Object.keys(cfg.tasks).length} tasks).`);
  return EXIT.OK;
}

async function cmdAnalyze(f: Flags): Promise<number> {
  const p = await open(f);
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
    files: p.index.files.size,
    modules: g.modules.size,
    edges,
    tests: g.testFiles().length,
    importCycles: cycles,
    uncertainModules: uncertain.map((m) => ({ path: m.path, reasons: m.uncertain })),
    skippedSymlinks: p.index.skippedSymlinks.length,
    tasks: Object.fromEntries(Object.values(p.config.tasks).map((t) => [t.name, { kind: t.kind, dependsOn: t.dependsOn, cache: t.cache }])),
  };
  if (f.json) { printJson(result); return EXIT.OK; }
  console.log(`${result.project}  (${p.root})`);
  console.log(`  package manager : ${det.packageManager ?? 'none detected'}${det.lockfiles.length > 1 ? `  (WARNING: multiple lockfiles: ${det.lockfiles.join(', ')})` : ''}`);
  console.log(`  tools           : ${det.tools.join(', ') || 'none detected'}`);
  console.log(`  files indexed   : ${result.files}   modules: ${result.modules}   import edges: ${edges}   tests: ${result.tests}`);
  if (g.workspacePackages.size > 1) console.log(`  workspace pkgs  : ${[...g.workspacePackages.keys()].join(', ')}`);
  console.log(`  tasks           : ${Object.keys(p.config.tasks).join(', ')}`);
  console.log(`  import cycles   : ${cycles.length}`);
  for (const c of cycles.slice(0, 5)) console.log(`    - ${c.join(' <-> ')}`);
  console.log(`  uncertain       : ${uncertain.length} module(s) with dynamic/unresolved imports (handled conservatively)`);
  for (const m of uncertain.slice(0, 5)) console.log(`    - ${m.path}: ${m.uncertain[0]}`);
  if (p.index.skippedSymlinks.length) console.log(`  symlinks        : ${p.index.skippedSymlinks.length} skipped (never followed)`);
  return EXIT.OK;
}

async function cmdGraph(f: Flags): Promise<number> {
  const p = await open(f);
  const g = await p.graph();
  if (f.dot) {
    const lines = ['digraph buildrush {', '  rankdir=LR;'];
    for (const [from, m] of g.deps) for (const [to, kind] of m) lines.push(`  ${JSON.stringify(from)} -> ${JSON.stringify(to)} [label=${JSON.stringify(kind)}];`);
    lines.push('}');
    console.log(lines.join('\n'));
  } else printJson(g.serialize());
  return EXIT.OK;
}

function line(r: TaskReport, verbose: boolean): string {
  const label = { cached: '[cached]', succeeded: '[ran]', failed: '[FAILED]', skipped: '[skipped]', cancelled: '[cancelled]', pending: '[pending]', ready: '[ready]', running: '[running]' }[r.state];
  const colored = r.state === 'failed' ? paint(31, label) : r.state === 'cached' ? paint(32, label) : r.state === 'succeeded' ? paint(36, label) : paint(33, label);
  const pad = ' '.repeat(Math.max(0, 11 - label.length));
  let s = `${colored}${pad} ${r.task.padEnd(14)} ${fmtMs(r.durationMs).padStart(7)}`;
  if (r.state === 'cached') s += `  ${dim(`restored ${fmtBytes(r.restoredBytes)}`)}`;
  if (r.state === 'succeeded' && r.reasons.length) s += `  ${dim('why: ' + r.reasons[0] + (r.reasons.length > 1 ? ` (+${r.reasons.length - 1} more)` : ''))}`;
  if (r.notes.length && (verbose || r.state !== 'cached')) for (const n of r.notes) s += `\n             ${dim('note: ' + n)}`;
  if (verbose && r.reasons.length > 1) for (const x of r.reasons.slice(1)) s += `\n             ${dim('why: ' + x)}`;
  return s;
}

async function cmdRun(names: string[], f: Flags, signal: AbortSignal): Promise<number> {
  const p = await open(f);
  for (const n of names) {
    if (!p.config.tasks[n] && !p.config.pipelines[n]) {
      throw new Error(`unknown task ${JSON.stringify(n)} (tasks: ${Object.keys(p.config.tasks).join(', ')}; pipelines: ${Object.keys(p.config.pipelines).join(', ') || 'none'})`);
    }
  }
  if (!f.json && !f.quiet) console.log(dim(`BuildRush ${VERSION} · ${p.config.project.name} · ${closure(p, expandNames(p, names)).length} task(s)`));
  const report: RunReport = await runTasks(p, names, {
    noCache: f.noCache,
    bail: f.bail,
    concurrency: f.concurrency,
    affected: f.affected ? { since: f.since } : null,
    signal,
    onTaskDone: (r) => {
      if (f.json) return;
      const bad = r.state === 'failed' || r.state === 'cancelled';
      if (f.quiet && !bad) return;
      console.log(line(r, f.verbose));
      for (const d of r.diagnostics.slice(0, 10)) console.log(`    ! ${d}`);
      if (r.log && (r.state === 'failed' || f.verbose)) console.log(r.log.replace(/\n$/, '').split('\n').map((l) => '    | ' + l).join('\n'));
    },
  });
  await writeFileAtomic(
    path.join(p.stateDir, 'last-run.json'),
    JSON.stringify({ at: Date.now(), requested: names, tasks: report.tasks.map((t) => ({ ...t, log: undefined })), selection: report.selection }),
  );
  const count = (s: string) => report.tasks.filter((t) => t.state === s).length;
  const saved = report.tasks.reduce((n, t) => n + t.savedMsEstimate, 0);
  if (f.json) {
    printJson({ ok: report.ok, cancelled: report.cancelled, durationMs: report.durationMs, selection: report.selection, tasks: report.tasks.map((t) => ({ ...t, log: f.verbose ? t.log : undefined })) });
  } else if (!f.quiet || !report.ok) {
    if (report.selection && !f.quiet) {
      const s = report.selection;
      console.log(dim(s.mode === 'all' ? `test selection: ALL tests (${s.reason})` : `test selection: ${s.selected.length} selected, ${s.skipped.length} skipped, ${s.changed.length} changed file(s)`));
    }
    console.log(
      `\n${report.ok ? 'BuildRush succeeded' : report.cancelled ? 'BuildRush cancelled' : 'BuildRush FAILED'}: ` +
        `${count('succeeded')} ran, ${count('cached')} cached, ${count('failed')} failed, ${count('skipped')} skipped` +
        `${count('cancelled') ? `, ${count('cancelled')} cancelled` : ''} in ${fmtMs(report.durationMs)}` +
        (saved > 0 ? dim(`  (estimated time saved by cache: ${fmtMs(saved)}; estimate = original run duration)`) : ''),
    );
  }
  return report.ok ? EXIT.OK : report.cancelled ? EXIT.CANCELLED : EXIT.FAILED;
}

async function cmdExplain(target: string | undefined, f: Flags): Promise<number> {
  const p = await open(f);
  type Last = { tasks: TaskReport[]; selection: unknown; at: number };
  const last = await readJson<Last>(path.join(p.stateDir, 'last-run.json'));
  if (!target) {
    if (!last) { console.log('No run recorded yet. Run `buildrush run` first.'); return EXIT.OK; }
    if (f.json) { printJson(last); return EXIT.OK; }
    console.log(`Last run: ${new Date(last.at).toISOString()}`);
    for (const t of last.tasks) {
      console.log(`  ${t.task}: ${t.state}${t.cache === 'hit' ? ' (cache hit)' : ''}`);
      for (const r of t.reasons) console.log(`      why it ran: ${r}`);
      for (const n of t.notes) console.log(`      note: ${n}`);
    }
    return EXIT.OK;
  }
  if (p.config.tasks[target]) {
    const t = p.config.tasks[target]!;
    const st = await loadTaskState(p, target);
    const lastRep = last?.tasks.find((x) => x.task === target);
    const info = {
      task: target, command: t.command, dependsOn: t.dependsOn, cache: t.cache,
      lastState: lastRep?.state ?? null, lastReasons: lastRep?.reasons ?? [], lastNotes: lastRep?.notes ?? [],
      lastSuccessfulFingerprint: st?.fingerprint ?? null, inputsAtLastSuccess: st ? Object.keys(st.components.inputs).length : null,
    };
    if (f.json) printJson(info);
    else {
      console.log(`${target}: ${t.command.join(' ')}`);
      console.log(`  depends on : ${t.dependsOn.join(', ') || '-'}`);
      console.log(`  last state : ${info.lastState ?? 'never run'}`);
      for (const r of info.lastReasons) console.log(`    why it ran: ${r}`);
      for (const n of info.lastNotes) console.log(`    note: ${n}`);
      if (st) console.log(`  last good fingerprint: ${st.fingerprint.slice(0, 16)}  (${info.inputsAtLastSuccess} input files)`);
    }
    return EXIT.OK;
  }
  // A file: show what it affects.
  const rel = path.relative(p.root, path.resolve(startDir(f), target)).split(path.sep).join('/');
  if (rel.startsWith('..')) throw new UsageError(`${target} is outside the project`);
  const g = await p.graph();
  const { reached, conservative } = g.impact([rel]);
  const direct = Object.values(p.config.tasks).filter((t) => t.inputs === null || compileGlobs(t.inputs)(rel)).map((t) => t.name);
  const affectedTasks = new Set<string>(direct);
  for (let grew = true; grew; ) {
    grew = false;
    for (const t of Object.values(p.config.tasks)) if (!affectedTasks.has(t.name) && t.dependsOn.some((d) => affectedTasks.has(d))) { affectedTasks.add(t.name); grew = true; }
  }
  const sel = selectTests(g, null, [rel]);
  const out = {
    file: rel, known: p.index.files.has(rel), affectedTasks: [...affectedTasks], conservative,
    importedBy: [...reached.keys()].filter((k) => k !== rel).map((k) => ({ module: k, chain: g.chain(reached, k) })),
    tests: { mode: sel.mode, selected: sel.selected, chains: sel.chains },
  };
  if (f.json) { printJson(out); return EXIT.OK; }
  console.log(`${rel}${out.known ? '' : '  (not in the index: new, deleted, ignored or outside the project)'}`);
  console.log(`  tasks affected : ${out.affectedTasks.join(', ') || 'none'}`);
  if (conservative) console.log(`  CONSERVATIVE   : ${conservative} -> all tests run`);
  console.log(`  modules affected (${out.importedBy.length}):`);
  for (const m of out.importedBy.slice(0, 15)) console.log(`    ${m.chain.join('  ->  ')}`);
  if (out.importedBy.length > 15) console.log(`    ...and ${out.importedBy.length - 15} more`);
  console.log(`  tests selected (${sel.selected.length}${sel.mode === 'all' ? ', all' : ''}): ${sel.selected.slice(0, 10).join(', ') || 'none'}`);
  return EXIT.OK;
}

async function cmdCache(sub: string | undefined, f: Flags): Promise<number> {
  const p = await open(f, false);
  switch (sub) {
    case 'stats': {
      const s = await p.cache.stats();
      const life = await readStats(p);
      if (f.json) { printJson({ ...s, lifetime: life }); break; }
      console.log(`cache: ${s.dir}`);
      console.log(`  entries ${s.entries}, blobs ${s.blobs}, size ${fmtBytes(s.bytes)} (limit ${p.config.cache.maxSizeMB} MiB)`);
      console.log(`  lifetime: ${life.hits} hit(s), ${life.misses} miss(es), restored ${fmtBytes(life.bytesRestored)}, stored ${fmtBytes(life.bytesStored)}`);
      console.log(`  estimated time saved: ${fmtMs(life.estimatedSavedMs)}  (estimate: sum of original durations of reused results)`);
      break;
    }
    case 'verify': {
      const r = await p.cache.verify({ repair: f.repair });
      if (f.json) printJson(r);
      else {
        console.log(`verified ${r.entries} entries, ${r.blobs} blobs: ${r.corruptBlobs.length} corrupt blob(s), ${r.badEntries.length} bad entr(ies), ${r.missingBlobs.length} missing blob reference(s)`);
        if (f.repair) console.log(`repaired: ${r.repaired}`);
      }
      return r.corruptBlobs.length + r.badEntries.length + r.missingBlobs.length > 0 && !f.repair ? EXIT.FAILED : EXIT.OK;
    }
    case 'clean': {
      await p.cache.clean();
      await fs.rm(path.join(p.stateDir, 'tasks'), { recursive: true, force: true });
      if (f.json) printJson({ cleaned: true });
      else console.log('cache cleaned.');
      break;
    }
    default: throw new UsageError('usage: buildrush cache stats|verify|clean');
  }
  return EXIT.OK;
}

async function cmdDoctor(f: Flags): Promise<number> {
  const checks = await runDoctor(startDir(f));
  if (f.json) printJson(checks);
  else {
    for (const c of checks) console.log(`${{ ok: '[ok]  ', warn: '[warn]', fail: '[FAIL]' }[c.status]} ${c.name}: ${c.detail}`);
  }
  return checks.some((c) => c.status === 'fail') ? EXIT.FAILED : EXIT.OK;
}
