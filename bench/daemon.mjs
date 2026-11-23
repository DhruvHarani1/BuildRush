// Measures what the optional daemon actually saves, on a generated project (bench/workload.mjs).
//   npm run build && node bench/daemon.mjs [--workload medium|small|assets] [--modules N] [--runs N]
// Tasks are trivial `node` scripts (no npm install needed), so the numbers isolate BuildRush's own
// per-invocation overhead: process start, config load, index load + scan, graph build, cache lookup.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { generate, PRESETS } from './workload.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.resolve(here, '../bin/buildrush.js');
const arg = (n, d) => { const i = process.argv.indexOf(`--${n}`); return i < 0 ? d : process.argv[i + 1]; };
const preset = { ...PRESETS[arg('workload', 'medium')] };
if (arg('modules')) preset.modules = Number(arg('modules'));
const RUNS = Number(arg('runs', '25'));

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'br-bench-daemon-'));
const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'br-bench-dd-'));
generate(root, preset);
fs.mkdirSync(path.join(root, 'scripts'));
fs.writeFileSync(path.join(root, 'scripts/noop.js'), "console.log('ok');\n");
fs.writeFileSync(path.join(root, 'buildrush.json'), JSON.stringify({
  version: 1, project: { name: 'bench-daemon' },
  // inputs omitted => the whole project is hashed: the worst (and most honest) case for scan cost
  tasks: { noop: { command: 'node scripts/noop.js', kind: 'check' } },
  pipelines: { default: ['noop'] },
}));
const env = { ...process.env, BUILDRUSH_DAEMON_DIR: stateDir, BUILDRUSH_DAEMON_IDLE_MS: '300000' };
delete env.BUILDRUSH_DAEMON;

const cli = (...args) => {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [BIN, ...args], { cwd: root, env, encoding: 'utf8' });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  if (r.status !== 0) throw new Error(`buildrush ${args.join(' ')} failed: ${r.stderr || r.stdout}`);
  return ms;
};
const q = (a, p) => [...a].sort((x, y) => x - y)[Math.min(a.length - 1, Math.floor(a.length * p))];
const fmt = (a) => `median ${q(a, 0.5).toFixed(0)} ms  p25 ${q(a, 0.25).toFixed(0)}  min ${Math.min(...a).toFixed(0)}  max ${Math.max(...a).toFixed(0)}`;
// Interleaved, so machine-wide noise (antivirus, thermal, background load) hits every row equally.
const measureAll = (rows) => {
  const out = rows.map(() => []);
  for (let i = 0; i < RUNS; i++) rows.forEach(([, args], k) => out[k].push(cli(...args)));
  rows.forEach(([label], k) => console.log(`${label.padEnd(44)} ${fmt(out[k])}`));
  return out;
};

try {
  const files = fs.readdirSync(root, { recursive: true }).filter((f) => fs.statSync(path.join(root, f)).isFile()).length;
  console.log(`generated ${files} files (${preset.modules} modules, ${preset.tests} tests) in ${root}`);
  console.log(`node ${process.version}, ${os.platform()} ${os.arch()}, ${os.cpus().length} cpus, ${RUNS} interleaved runs per row\n`);
  cli('run', 'noop', '--quiet'); // populate the cache and the on-disk index: everything below is a no-change run
  const t0 = Date.now();
  cli('daemon', 'start');
  console.log(`daemon start (spawn + listen): ${Date.now() - t0} ms`);
  cli('run', 'noop', '--quiet', '--daemon'); // first request pays the cold scan inside the daemon
  cli('analyze', '--json', '--daemon');
  const [base, oneRun, dRun, oneAn, dAn] = measureAll([
    ['process start only (--version)', ['--version']],
    ['one-shot  run noop (no change, all cached)', ['run', 'noop', '--quiet']],
    ['daemon    run noop (no change, all cached)', ['run', 'noop', '--quiet', '--daemon']],
    ['one-shot  analyze --json', ['analyze', '--json']],
    ['daemon    analyze --json', ['analyze', '--json', '--daemon']],
  ]);
  const d = (a, b) => `${(q(a, 0.5) - q(b, 0.5)).toFixed(0)} ms (${(q(a, 0.5) / q(b, 0.5)).toFixed(2)}x)`;
  console.log(`\nrun:     median saved per no-change invocation: ${d(oneRun, dRun)}`);
  console.log(`         above bare process start: one-shot ${(q(oneRun, 0.5) - q(base, 0.5)).toFixed(0)} ms, daemon ${(q(dRun, 0.5) - q(base, 0.5)).toFixed(0)} ms`);
  console.log(`analyze: median saved per invocation: ${d(oneAn, dAn)}`);
} finally {
  cli('daemon', 'stop');
  fs.rmSync(root, { recursive: true, force: true });
  fs.rmSync(stateDir, { recursive: true, force: true });
}
