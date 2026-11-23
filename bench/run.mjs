#!/usr/bin/env node
// BuildRush benchmark suite. Zero dependencies. Measures real commands; never fabricates numbers.
//
//   node bench/run.mjs --workload small --runs 5
//   node bench/run.mjs --workload medium --runs 7 --scenarios cold,nochange
//
// Requires network for `npm install` of vite/vitest/typescript into bench/.work/<workload>.
import { spawn, execFileSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { PRESETS, generate } from './workload.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const BR = path.resolve(HERE, '../bin/buildrush.js');
const args = new Map(process.argv.slice(2).map((a, i, all) => (a.startsWith('--') ? [a.slice(2), all[i + 1]?.startsWith('--') ? 'true' : (all[i + 1] ?? 'true')] : null)).filter(Boolean));
const WORKLOAD = args.get('workload') ?? 'small';
const RUNS = Number(args.get('runs') ?? 5);
const WANT = (args.get('scenarios') ?? 'all').split(',');
if (!PRESETS[WORKLOAD]) throw new Error(`unknown workload ${WORKLOAD}; choose ${Object.keys(PRESETS).join(', ')}`);
const dir = path.join(HERE, '.work', WORKLOAD);
const WIN = process.platform === 'win32';
// On Windows, npm and node_modules/.bin entries are .cmd shims, which spawn() can only run through a shell (all args here are fixed literals).
const bin = (n) => path.join(dir, 'node_modules/.bin', WIN ? n + '.cmd' : n);

// Windows tools need SystemRoot, TEMP, etc.; keep the whole environment there.
const ENV = WIN ? { ...process.env, NO_COLOR: '1', CI: '1' } : { PATH: process.env.PATH, HOME: process.env.HOME, NO_COLOR: '1', CI: '1' };
function run(cmd, argv, { allowFail = false, env = ENV } = {}) {
  return new Promise((resolve, reject) => {
    const t0 = process.hrtime.bigint();
    const c = spawn(cmd, argv, { cwd: dir, env, stdio: ['ignore', 'pipe', 'pipe'], shell: WIN && cmd !== 'node', windowsHide: true });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d));
    c.stderr.on('data', (d) => (err += d));
    c.on('close', (code) => {
      const ms = Number(process.hrtime.bigint() - t0) / 1e6;
      if (code !== 0 && !allowFail) return reject(new Error(`${cmd} ${argv.join(' ')} exited ${code}\n${out.slice(-800)}\n${err.slice(-800)}`));
      resolve({ ms, out, err, code });
    });
  });
}
const br = (...a) => run('node', [BR, ...a]);
const git = (...a) => execFileSync('git', ['-c', 'user.name=b', '-c', 'user.email=b@b', ...a], { cwd: dir, stdio: 'pipe' });
const rmrf = (...p) => p.forEach((x) => fs.rmSync(path.join(dir, x), { recursive: true, force: true }));
const bump = (() => { let n = 0; return (file) => fs.appendFileSync(path.join(dir, file), `\nexport const __bump${++n}_${Date.now()} = ${n};\n`); })();
const revert = () => git('checkout', '--', '.');

// Native baselines a developer would actually use.
const nativeSeq = async () => { const t = performance.now(); await run(bin('tsc'), ['--noEmit']); await run(bin('vite'), ['build']); await run(bin('vitest'), ['run']); return performance.now() - t; };
const nativePar = async () => { const t = performance.now(); await Promise.all([(async () => { await run(bin('tsc'), ['--noEmit']); await run(bin('vite'), ['build']); })(), run(bin('vitest'), ['run'])]); return performance.now() - t; };
async function brRun(expect, ...extra) {
  const r = await br('run', '--json', ...extra);
  const rep = JSON.parse(r.out);
  const got = Object.fromEntries(rep.tasks.map((t) => [t.task, t.state]));
  for (const [t, s] of Object.entries(expect)) if (got[t] !== s) throw new Error(`UNEXPECTED: task ${t} was ${got[t]}, expected ${s} (scenario would measure the wrong thing)\n${JSON.stringify(rep.tasks.map((x) => [x.task, x.state, x.reasons, x.notes]))}`);
  return { ms: r.ms, rep };
}

function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const q = (p) => s[Math.min(s.length - 1, Math.ceil(p * s.length) - 1)];
  return { n: s.length, median: q(0.5), p95: q(0.95), min: s[0], max: s.at(-1) };
}
async function sample(fn, { before, after } = {}) {
  const xs = [];
  for (let i = 0; i < RUNS; i++) { await before?.(i); xs.push(await fn(i)); await after?.(i); }
  return stats(xs);
}
const hashDir = (d) => { const h = createHash('sha256'); const walk = (p) => fs.readdirSync(p, { withFileTypes: true }).sort((a, b) => a.name < b.name ? -1 : 1).forEach((e) => { const f = path.join(p, e.name); if (e.isDirectory()) walk(f); else h.update(path.relative(d, f)).update(fs.readFileSync(f)); }); walk(d); return h.digest('hex'); };
const dirSize = (d) => { let n = 0; const walk = (p) => fs.readdirSync(p, { withFileTypes: true }).forEach((e) => { const f = path.join(p, e.name); e.isDirectory() ? walk(f) : (n += fs.statSync(f).size); }); return fs.existsSync(d) ? (walk(d), n) : 0; };

// ---- setup -----------------------------------------------------------------------------------
console.error(`# workload=${WORKLOAD} runs=${RUNS}`);
fs.rmSync(dir, { recursive: true, force: true });
const { narrowModule, wideModule } = generate(dir, PRESETS[WORKLOAD]);
console.error('# installing tools (npm install)...');
await run(WIN ? 'npm.cmd' : 'npm', ['install', '--no-audit', '--no-fund', '--ignore-scripts', '--loglevel=error'], { env: process.env });
git('init', '-q'); git('add', '-A'); git('commit', '-qm', 'bench');
const versions = Object.fromEntries(['typescript', 'vite', 'vitest'].map((p) => [p, JSON.parse(fs.readFileSync(path.join(dir, 'node_modules', p, 'package.json'), 'utf8')).version]));
const machine = { cpu: os.cpus()[0]?.model, cores: os.cpus().length, memGiB: +(os.totalmem() / 2 ** 30).toFixed(1), os: `${os.type()} ${os.release()}`, node: process.version, tools: versions, buildrush: JSON.parse(fs.readFileSync(path.resolve(HERE, '../package.json'), 'utf8')).version, gitSha: (() => { try { return execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: HERE }).toString().trim(); } catch { return null; } })() };
const results = { machine, workload: WORKLOAD, preset: PRESETS[WORKLOAD], runs: RUNS, at: new Date().toISOString(), scenarios: {}, checks: {} };

// ---- correctness gate: cached output must equal a native build, byte for byte --------------------
await run(bin('vite'), ['build']); const nativeHash = hashDir(path.join(dir, 'dist'));
rmrf('dist', '.buildrush'); await brRun({ build: 'succeeded' });
rmrf('dist'); await brRun({ build: 'cached' }); const restoredHash = hashDir(path.join(dir, 'dist'));
results.checks.restoredBuildEqualsNativeBuild = nativeHash === restoredHash;
if (!results.checks.restoredBuildEqualsNativeBuild) throw new Error('CORRECTNESS FAILURE: restored dist differs from a native build');
console.error('# check ok: cache-restored dist is byte-identical to a native vite build');

const want = (s) => WANT.includes('all') || WANT.includes(s);
const record = (name, variants) => { results.scenarios[name] = variants; console.error(`# done ${name}`); };
const reset = () => { revert(); rmrf('dist', '.buildrush'); };

if (want('cold')) record('cold full run (typecheck+build+test)', {
  'native sequential': await sample(nativeSeq, { before: () => rmrf('dist') }),
  'native parallel': await sample(nativePar, { before: () => rmrf('dist') }),
  buildrush: await sample(async () => (await brRun({ typecheck: 'succeeded', build: 'succeeded', test: 'succeeded' })).ms, { before: reset }),
});
if (want('nochange')) { reset(); await brRun({}); record('no-change run', {
  'native sequential': await sample(nativeSeq),
  'native parallel': await sample(nativePar),
  buildrush: await sample(async () => (await brRun({ typecheck: 'cached', build: 'cached', test: 'cached' })).ms),
}); }
for (const [label, file] of [['narrow', narrowModule], ['wide', wideModule]]) {
  if (want(`edit-${label}`)) { reset(); await brRun({}); record(`one-file edit, ${label} impact (${file}), full pipeline`, {
    'native sequential': await sample(nativeSeq, { before: () => bump(file), after: revert }),
    'native parallel': await sample(nativePar, { before: () => bump(file), after: revert }),
    buildrush: await sample(async () => (await brRun({ typecheck: 'succeeded', build: 'succeeded', test: 'succeeded' })).ms, { before: () => bump(file), after: revert }),
  }); }
  if (want(`affected-${label}`)) { reset(); await brRun({}); const t = {}; record(`one-file edit, ${label} impact (${file}), TESTS ONLY`, {
    'native vitest run (all tests)': await sample(async () => (await run(bin('vitest'), ['run'])).ms, { before: () => bump(file), after: revert }),
    'native vitest related': await sample(async () => (await run(bin('vitest'), ['related', file, '--run'])).ms, { before: () => bump(file), after: revert }),
    'buildrush test --affected': await sample(async () => { const r = await brRun({ test: 'succeeded' }, 'test', '--affected'); t.sel = r.rep.selection?.selected.length; return r.ms; }, { before: () => bump(file), after: revert }),
  }); results.scenarios[`one-file edit, ${label} impact (${file}), TESTS ONLY`]['_buildrush tests selected'] = t.sel; }
}
if (want('config')) { reset(); await brRun({}); record('config change (vite.config.ts), full pipeline', {
  'native sequential': await sample(nativeSeq, { before: () => fs.appendFileSync(path.join(dir, 'vite.config.ts'), `// ${Math.random()}\n`), after: revert }),
  buildrush: await sample(async () => (await brRun({ build: 'succeeded' })).ms, { before: () => fs.appendFileSync(path.join(dir, 'vite.config.ts'), `// ${Math.random()}\n`), after: revert }),
}); }
if (want('lockfile')) { reset(); await brRun({}); record('lockfile change, full pipeline', {
  'native sequential': await sample(nativeSeq),
  buildrush: await sample(async () => (await brRun({ typecheck: 'succeeded', build: 'succeeded', test: 'succeeded' })).ms, { before: (i) => fs.appendFileSync(path.join(dir, 'package-lock.json'), ' '.repeat(i + 1) + '\n'), after: revert }),
}); }
if (want('restore')) { reset(); await brRun({}); const inner = []; record('cache restore after deleting dist/', {
  'native vite build': await sample(async () => (await run(bin('vite'), ['build'])).ms, { before: () => rmrf('dist') }),
  'buildrush (wall)': await sample(async () => { const r = await brRun({ build: 'cached' }); inner.push(r.rep.tasks.find((x) => x.task === 'build').durationMs); return r.ms; }, { before: () => rmrf('dist') }),
  'buildrush (restore step only)': stats(inner),
}); }
if (want('graph')) record('graph construction (buildrush analyze)', { buildrush: await sample(async () => (await br('analyze', '--json')).ms) });

// ---- opt-in per-test-file result caching (testCache: true on the test task) ---------------------
// These scenarios run last: they commit a testCache variant of buildrush.json, then restore the original.
const TC_KEYS = ['testcache-narrow', 'testcache-wide', 'testcache-nochange'];
if (TC_KEYS.some(want)) {
  const cfgPath = path.join(dir, 'buildrush.json');
  const origCfg = fs.readFileSync(cfgPath, 'utf8');
  const cfg = JSON.parse(origCfg); cfg.tasks.test.testCache = true;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));
  git('commit', '-qam', 'enable testCache');
  const testFiles = fs.readdirSync(path.join(dir, 'tests')).filter((n) => n.endsWith('.test.ts'));
  // Generated test k imports exactly one module m<i>; m<i> transitively imports every lower module (i-1, i-7 chain),
  // so an edit to m<j> can affect exactly the tests whose module index is >= j.
  const testModuleIdx = testFiles.map((n) => Number(/lib\/m(\d+)'/.exec(fs.readFileSync(path.join(dir, 'tests', n), 'utf8'))[1]));
  const modIdx = (file) => Number(/m(\d+)\.ts$/.exec(file)[1]);
  const expectedAffected = (file) => testModuleIdx.filter((i) => i >= modIdx(file)).length;
  const total = testFiles.length;
  // Run the full pipeline and assert testCache is active and ran/skipped are exactly as expected.
  const tcRun = async (expectRan) => {
    const { ms, rep } = await brRun({ typecheck: 'succeeded', build: 'succeeded', test: 'succeeded' });
    const tc = rep.tasks.find((x) => x.task === 'test').testCache;
    if (!tc) throw new Error('testCache is NOT active for the test task (auto-disabled or not configured); scenario would measure the wrong thing');
    if (tc.ran.length !== expectRan || tc.skipped.length !== total - expectRan) throw new Error(`UNEXPECTED testCache outcome: ran ${tc.ran.length} / skipped ${tc.skipped.length}, expected ran ${expectRan} / skipped ${total - expectRan} of ${total}`);
    return { ms, ran: tc.ran.length, skipped: tc.skipped.length };
  };
  // Activation check: the first run records every file; the second, after a content edit, must skip the unaffected ones.
  reset(); await brRun({});
  const probeRep = (await brRun({})).rep.tasks.find((x) => x.task === 'test');
  if (probeRep.state !== 'cached') throw new Error(`testCache setup: expected a whole-task cache hit, got ${probeRep.state}`);
  bump(narrowModule); await tcRun(expectedAffected(narrowModule)); revert();
  results.checks.testCacheActive = true;
  // Correctness gate: a failing test must fail identically to native and must never be recorded as a pass.
  fs.appendFileSync(path.join(dir, narrowModule), "\nthrow new Error('bench: intentional failure');\n");
  const nativeFail = await run(bin('vitest'), ['run'], { allowFail: true });
  const brFail = async () => JSON.parse((await run('node', [BR, 'run', '--json'], { allowFail: true })).out);
  const f1 = await brFail(); const f2 = await brFail();
  const brFailed = (rep) => rep.ok === false && rep.tasks.find((x) => x.task === 'test').state === 'failed';
  results.checks.testCacheFailureMatchesNative = nativeFail.code !== 0 && brFailed(f1) && brFailed(f2);
  if (!results.checks.testCacheFailureMatchesNative) throw new Error('CORRECTNESS FAILURE: a failing test did not fail identically (native exit ' + nativeFail.code + ') or a failure was served from the testCache');
  revert();
  console.error('# check ok: testCache active; a failing test fails like native twice in a row (failures are never cached)');

  const prepare = async () => { reset(); await brRun({}); await brRun({}); }; // warm: every test file has a recorded pass
  const info = {};
  if (want('testcache-narrow')) { await prepare(); const name = `tests: one-file edit, narrow impact (${narrowModule}), testCache ON, full pipeline`; const exp = expectedAffected(narrowModule); record(name, {
    'native parallel': await sample(nativePar, { before: () => bump(narrowModule), after: revert }),
    'native vitest run (all tests)': await sample(async () => (await run(bin('vitest'), ['run'])).ms, { before: () => bump(narrowModule), after: revert }),
    'native vitest related': await sample(async () => (await run(bin('vitest'), ['related', narrowModule, '--run'])).ms, { before: () => bump(narrowModule), after: revert }),
    'buildrush run (testCache ON)': await sample(async () => { const r = await tcRun(exp); info.n = r; return r.ms; }, { before: () => bump(narrowModule), after: revert }),
  }); results.scenarios[name]['_buildrush test files ran / skipped'] = `${info.n.ran} / ${info.n.skipped} of ${total}`; }
  if (want('testcache-wide')) { await prepare(); const name = `tests: one-file edit, wide impact (${wideModule}), testCache ON, full pipeline`; const exp = expectedAffected(wideModule); record(name, {
    'native parallel': await sample(nativePar, { before: () => bump(wideModule), after: revert }),
    'native vitest run (all tests)': await sample(async () => (await run(bin('vitest'), ['run'])).ms, { before: () => bump(wideModule), after: revert }),
    'native vitest related': await sample(async () => (await run(bin('vitest'), ['related', wideModule, '--run'])).ms, { before: () => bump(wideModule), after: revert }),
    'buildrush run (testCache ON)': await sample(async () => { const r = await tcRun(exp); info.w = r; return r.ms; }, { before: () => bump(wideModule), after: revert }),
  }); results.scenarios[name]['_buildrush test files ran / skipped'] = `${info.w.ran} / ${info.w.skipped} of ${total}`; }
  if (want('testcache-nochange')) { await prepare(); record('no-change run, testCache ON', {
    'native parallel': await sample(nativePar),
    buildrush: await sample(async () => (await brRun({ typecheck: 'cached', build: 'cached', test: 'cached' })).ms),
  }); }

  fs.writeFileSync(cfgPath, origCfg); git('commit', '-qam', 'restore config');
}
results.cacheDiskBytes = dirSize(path.join(dir, '.buildrush', 'cache'));
results.memory = 'not measured';

// ---- report -----------------------------------------------------------------------------------
fs.mkdirSync(path.join(HERE, 'results'), { recursive: true });
const file = path.join(HERE, 'results', `${results.at.replace(/[:.]/g, '-')}-${WORKLOAD}.json`);
fs.writeFileSync(file, JSON.stringify(results, null, 2));
const f = (x) => (x >= 1000 ? `${(x / 1000).toFixed(2)} s` : `${x.toFixed(0)} ms`);
let md = `### ${WORKLOAD}: ${JSON.stringify(PRESETS[WORKLOAD])}, ${RUNS} runs each\n${machine.cpu} x${machine.cores}, ${machine.memGiB} GiB, ${machine.os}, node ${machine.node}, vite ${versions.vite}, vitest ${versions.vitest}, tsc ${versions.typescript}\n\n| Scenario | Variant | median | p95 | n |\n|---|---|---|---|---|\n`;
for (const [sc, vs] of Object.entries(results.scenarios)) for (const [v, s] of Object.entries(vs)) if (s && typeof s === 'object' && 'median' in s) md += `| ${sc} | ${v} | ${f(s.median)} | ${f(s.p95)} | ${s.n} |\n`;
md += `\ncache size on disk: ${(results.cacheDiskBytes / 1024).toFixed(0)} KiB. memory: not measured. p95 with n<20 is effectively the max.\n`;
fs.writeFileSync(file.replace(/\.json$/, '.md'), md);
console.log(md);
console.error(`# wrote ${file}`);
