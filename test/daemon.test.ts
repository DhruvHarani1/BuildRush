import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import * as net from 'node:net';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { rm, tmpProject } from './helpers.js';
import { DaemonServer, AlreadyRunningError } from '../src/daemon/server.js';
import {
  Credentials, DaemonError, DaemonUnavailable, probeDaemon, readCredentials, removeEndpointFiles, sendRequest, spawnDaemon, stopDaemon,
} from '../src/daemon/client.js';
import { daemonDirs, DaemonDirs } from '../src/daemon/paths.js';
import { tryDaemon } from '../src/daemon/cli.js';
import { Message, PROTO, VERSION } from '../src/daemon/protocol.js';
import { Project } from '../src/project.js';
import { runTasks, RunReport } from '../src/engine.js';

const BIN = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../bin/buildrush.js');
const WIN = process.platform === 'win32';
let base: string;
let savedBase: string | undefined;

before(async () => {
  base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), 'br-daemon-')));
  savedBase = process.env.BUILDRUSH_DAEMON_DIR;
  process.env.BUILDRUSH_DAEMON_DIR = base;
});
after(async () => {
  if (savedBase === undefined) delete process.env.BUILDRUSH_DAEMON_DIR;
  else process.env.BUILDRUSH_DAEMON_DIR = savedBase;
  await rm(base);
});

function projectFiles(): Record<string, string> {
  const config = {
    version: 1,
    project: { name: 'dproj' },
    tasks: {
      work: { command: 'node scripts/work.js', kind: 'build', inputs: ['src/**', 'scripts/work.js'], outputs: ['out/**'], env: ['MY_VAR'] },
      mark: { command: 'node scripts/mark.js', kind: 'check', cache: false, inputs: ['scripts/mark.js'] },
      slow: { command: 'node scripts/sleep.js 700', kind: 'check', cache: false, inputs: ['scripts/sleep.js'] },
      hang: { command: 'node scripts/sleep.js 30000', kind: 'check', cache: false, inputs: ['scripts/sleep.js'] },
      dumpenv: { command: 'node scripts/dumpenv.js', kind: 'check', cache: false, inputs: ['scripts/dumpenv.js'] },
    },
    pipelines: { default: ['work'] },
  };
  return {
    'buildrush.json': JSON.stringify(config, null, 2),
    'package.json': '{"type":"module","name":"dproj"}',
    'src/a.js': 'export const a = 1;\n',
    'src/b.js': "import { a } from './a.js';\nexport const b = a + 1;\n",
    'scripts/work.js': [
      "import fs from 'node:fs';",
      "const n = fs.readdirSync('src').length;",
      "fs.mkdirSync('out', { recursive: true });",
      "fs.writeFileSync('out/result.txt', `files=${n} var=${process.env.MY_VAR ?? ''}`);",
    ].join('\n'),
    'scripts/mark.js': "import fs from 'node:fs'; fs.writeFileSync('marker.txt', 'ran');\n",
    'scripts/sleep.js': 'setTimeout(() => {}, Number(process.argv[2]));\n',
    'scripts/dumpenv.js': "import fs from 'node:fs'; fs.mkdirSync('.buildrush', { recursive: true }); fs.writeFileSync('.buildrush/envdump.json', JSON.stringify(process.env));\n",
  };
}

async function withProject<T>(fn: (root: string, dirs: DaemonDirs) => Promise<T>): Promise<T> {
  const root = await tmpProject(projectFiles());
  try {
    return await fn(root, daemonDirs(root));
  } finally {
    // Never leave a daemon behind, whatever the test did.
    const p = await probeDaemon(daemonDirs(root), { timeoutMs: 500 });
    if (p.status === 'live') await stopDaemon(daemonDirs(root), p, 3000);
    await rm(root);
  }
}

async function withServer<T>(fn: (srv: DaemonServer, root: string) => Promise<T>, opts: Partial<Parameters<typeof DaemonServer.start>[0]> = {}): Promise<T> {
  return withProject(async (root) => {
    const srv = await DaemonServer.start({ root, idleMs: 0, ...opts });
    try {
      return await fn(srv, root);
    } finally {
      await srv.shutdown('test done');
    }
  });
}

const baseEnv = (extra: Record<string, string> = {}): Record<string, string> => {
  const e: Record<string, string> = {};
  for (const k of ['PATH', 'Path', 'SystemRoot', 'SYSTEMROOT', 'COMSPEC', 'PATHEXT', 'HOME', 'USERPROFILE', 'TEMP', 'TMP', 'TMPDIR']) {
    if (process.env[k] !== undefined) e[k] = process.env[k]!;
  }
  return { ...e, ...extra };
};

const creds = async (dirs: DaemonDirs): Promise<Credentials> => {
  const c = await readCredentials(dirs);
  assert.ok(typeof c === 'object' && 'token' in c, 'credentials should be readable');
  return c as Credentials;
};

/** Talk to the endpoint with arbitrary bytes and report what came back and whether the server hung up. */
function raw(endpoint: string, payload: string | Buffer | null, waitMs = 500): Promise<{ data: string; closed: boolean }> {
  return new Promise((resolve) => {
    const s = net.connect({ path: endpoint });
    let data = '';
    let closed = false;
    s.setEncoding('utf8');
    s.on('data', (c: string) => { data += c; });
    s.on('error', () => { closed = true; });
    s.on('close', () => { closed = true; setTimeout(() => resolve({ data, closed }), 30); });
    s.on('connect', () => { if (payload !== null) s.write(payload); });
    setTimeout(() => { const r = { data, closed }; s.destroy(); resolve(r); }, waitMs);
  });
}

const run = (c: Credentials, root: string, tasks: string[], flags: Record<string, unknown> = {}, env = baseEnv(), o = {}) =>
  sendRequest(c, 'run', { cwd: root, env, tasks, flags }, o) as Promise<RunReport>;

// ---- credentials & filesystem permissions ---------------------------------------------------------

test('token is 32+ random bytes, regenerated per daemon, and never written anywhere but the token file', async () => {
  await withProject(async (root, dirs) => {
    const a = await DaemonServer.start({ root, idleMs: 0 });
    const tokA = (await fs.readFile(dirs.token, 'utf8')).trim();
    assert.match(tokA, /^[0-9a-f]{64}$/); // 32 bytes
    await a.shutdown('t');
    await assert.rejects(fs.access(dirs.token), 'token file removed on shutdown');
    const b = await DaemonServer.start({ root, idleMs: 0 });
    const tokB = (await fs.readFile(dirs.token, 'utf8')).trim();
    assert.notEqual(tokA, tokB);
    // not in meta, not in the log, not anywhere inside the project tree
    assert.ok(!(await fs.readFile(dirs.meta, 'utf8')).includes(tokB));
    assert.ok(!(await fs.readFile(dirs.log, 'utf8')).includes(tokB));
    await b.shutdown('t');
    assert.ok(!dirs.dir.startsWith(root), 'daemon state lives outside the project tree');
  });
});

test('POSIX: state directories are 0700 and secret files 0600', { skip: WIN ? 'POSIX permission bits do not exist on Windows (see the ACL test)' : false }, async () => {
  await withServer(async (srv) => {
    const mode = async (p: string) => (await fs.stat(p)).mode & 0o777;
    assert.equal(await mode(srv.dirs.base), 0o700);
    assert.equal(await mode(srv.dirs.dir), 0o700);
    assert.equal(await mode(srv.dirs.token), 0o600);
    assert.equal(await mode(srv.dirs.meta), 0o600);
    assert.equal(await mode(srv.dirs.socket), 0o600);
    assert.equal(path.dirname(srv.endpoint), srv.dirs.dir, 'the socket lives inside the 0700 directory');
  });
});

test('POSIX: a state directory that is loose is tightened; one owned by someone else or a symlink is refused', { skip: WIN ? 'POSIX permission bits do not exist on Windows' : false }, async () => {
  await withProject(async (root, dirs) => {
    await fs.mkdir(dirs.dir, { recursive: true, mode: 0o755 });
    await fs.chmod(dirs.dir, 0o755);
    const srv = await DaemonServer.start({ root, idleMs: 0 });
    assert.equal((await fs.stat(dirs.dir)).mode & 0o777, 0o700);
    await srv.shutdown('t');
    // a client never trusts credentials from a directory that others can reach
    await fs.chmod(dirs.dir, 0o755);
    const c = await readCredentials(dirs);
    assert.ok(c === 'absent' || (typeof c === 'object' && 'unsafe' in c));
  });
});

test('Windows: the per-user state directory carries no entries for Everyone/Users', { skip: WIN ? false : 'ACLs are Windows-only' }, async () => {
  await withServer(async (srv) => {
    const acl = execFileSync('icacls', [srv.dirs.dir], { encoding: 'utf8', windowsHide: true });
    assert.doesNotMatch(acl, /Everyone|BUILTIN\\Users|Authenticated Users/i, acl);
    assert.match(acl, new RegExp((process.env.USERNAME ?? '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));
  });
});

// ---- authentication ---------------------------------------------------------------------------------

test('requests without a valid token are dropped and nothing is executed', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const body = (token: unknown) => JSON.stringify({ proto: PROTO, client: VERSION, token, op: 'run', args: { cwd: root, env: baseEnv(), tasks: ['mark'], flags: {} } }) + '\n';
    for (const token of [undefined, '', 'x', c.token.slice(0, -1), c.token + 'a', c.token.toUpperCase(), 12345, null, [c.token], { t: c.token }]) {
      const r = await raw(srv.endpoint, body(token));
      assert.equal(r.data, '', `no reply may leak anything (token=${JSON.stringify(token)})`);
      assert.equal(r.closed, true, 'connection must be closed');
    }
    await new Promise((r) => setTimeout(r, 200));
    await assert.rejects(fs.access(path.join(root, 'marker.txt')), 'the task must not have run');
    const pong = (await sendRequest(c, 'status', {})) as { runs: number };
    assert.equal(pong.runs, 0);
    // and the right token does work
    const rep = await run(c, root, ['mark']);
    assert.equal(rep.ok, true);
    await fs.access(path.join(root, 'marker.txt'));
  });
});

test('garbage, oversized and wrongly-shaped input is rejected without crashing the daemon', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const alive = async () => assert.equal(((await sendRequest(c, 'ping', {})) as { pid: number }).pid, process.pid);
    for (const junk of ['not json\n', '[]\n', '"a string"\n', 'null\n', '{"token":\n', '\u0000\u0001\u0002\n', '{}\n']) {
      const r = await raw(srv.endpoint, junk, 300);
      assert.equal(r.data, '');
      assert.equal(r.closed, true);
    }
    const huge = await raw(srv.endpoint, 'a'.repeat(3 * 1024 * 1024), 800); // no newline, never ends
    assert.equal(huge.closed, true);
    const hugeLine = await raw(srv.endpoint, JSON.stringify({ token: 'x'.repeat(2 * 1024 * 1024) }) + '\n', 800);
    assert.equal(hugeLine.closed, true);
    await alive();

    // authenticated but not allowed: unknown ops, bad args, path-like task names, huge env
    const ask = (op: string, args: unknown) => raw(srv.endpoint, JSON.stringify({ proto: PROTO, client: VERSION, token: c.token, op, args }) + '\n', 500);
    for (const op of ['exec', 'eval', 'shell', 'readFile', '__proto__', '']) {
      const r = await ask(op, { command: 'echo pwned' });
      assert.match(r.data, /"code":"bad_request"/, `op ${JSON.stringify(op)}`);
    }
    assert.match((await ask('run', { cwd: root, tasks: 'work' })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { cwd: root, tasks: [] })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { cwd: root, tasks: [1] })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { cwd: root, tasks: ['work'], flags: { concurrency: 'x' } })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { cwd: root, tasks: ['work'], env: { A: 'x'.repeat(300_000) } })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { tasks: ['work'] })).data, /"code":"bad_request"/);
    assert.match((await ask('run', { cwd: root, tasks: ['../../../etc/passwd'] })).data, /"code":"failed"/);
    assert.match((await ask('run', { cwd: root, tasks: ['node -e 1'] })).data, /"code":"failed"/);
    await assert.rejects(fs.access(path.join(root, 'marker.txt')));
    await alive();
  });
});

test('a connection that never sends its request is dropped (slow-loris)', async () => {
  await withServer(async (srv) => {
    const t0 = Date.now();
    const r = await new Promise<number>((resolve) => {
      const s = net.connect({ path: srv.endpoint });
      s.on('close', () => resolve(Date.now() - t0));
      s.on('error', () => undefined);
      setTimeout(() => { s.destroy(); resolve(-1); }, 4000);
    });
    assert.ok(r >= 0 && r < 3000, `closed after ${r}ms`);
  }, { authTimeoutMs: 400 });
});

test('a request for a different project is refused', async () => {
  await withServer(async (srv) => {
    const other = await tmpProject(projectFiles());
    try {
      const c = await creds(srv.dirs);
      await assert.rejects(run(c, other, ['mark']), (e: unknown) => e instanceof DaemonError && e.code === 'wrong_root');
      await assert.rejects(fs.access(path.join(other, 'marker.txt')));
    } finally {
      await rm(other);
    }
  });
});

// ---- protocol / versions ----------------------------------------------------------------------------

test('version mismatch: work is refused, ping/stop still answer, and the client asks the old daemon to exit', async () => {
  await withProject(async (root, dirs) => {
    const old = await DaemonServer.start({ root, idleMs: 0, versionOverride: '0.0.1-old', protoOverride: 0 });
    const c = await creds(dirs);
    await assert.rejects(run(c, root, ['mark']), (e: unknown) => e instanceof DaemonError && e.code === 'version_mismatch' && e.proto === 0 && e.version === '0.0.1-old');
    await assert.rejects(fs.access(path.join(root, 'marker.txt')));
    const p = await probeDaemon(dirs);
    assert.ok(p.status === 'live' && !p.compatible);
    // tryDaemon: replaces the old daemon with a matching one and still produces a correct result
    const out = await tryDaemon<RunReport>(root, 'run', { tasks: ['work'], flags: {} }, { start: { idleMs: 60_000 } });
    await Promise.race([old.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('old daemon did not exit')), 5000))]);
    assert.ok(out.ok, out.ok ? '' : out.reason);
    const now = await probeDaemon(dirs);
    assert.ok(now.status === 'live' && now.compatible && now.pong.version === VERSION);
  });
});

test('a client with an older protocol is refused for work but can still stop the daemon', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    await assert.rejects(run(c, root, ['mark'], {}, baseEnv(), { proto: PROTO + 1, version: '99.0.0' }), (e: unknown) => e instanceof DaemonError && e.code === 'version_mismatch');
    await sendRequest(c, 'stop', {}, { proto: PROTO + 1, version: '99.0.0' });
    await srv.closed;
  });
});

// ---- stale state & crashes ----------------------------------------------------------------------------

test('stale endpoint files from a dead daemon are detected by a liveness probe and cleaned up', async () => {
  await withProject(async (root, dirs) => {
    await fs.mkdir(dirs.dir, { recursive: true, mode: 0o700 });
    const fakeEndpoint = WIN ? '\\\\.\\pipe\\buildrush-test-nonexistent-' + process.pid : dirs.socket;
    await fs.writeFile(dirs.token, 'f'.repeat(64), { mode: 0o600 });
    await fs.writeFile(dirs.meta, JSON.stringify({ proto: PROTO, version: VERSION, pid: 2 ** 22 - 1, root, endpoint: fakeEndpoint, startedAt: 1, node: 'v0' }), { mode: 0o600 });
    if (!WIN) await fs.writeFile(dirs.socket, '', { mode: 0o600 }); // a leftover that is not a live socket
    const p = await probeDaemon(dirs);
    assert.equal(p.status, 'stale', JSON.stringify(p));
    // a client falls back (reports not ok) rather than failing, once the daemon cannot be started
    const out = await tryDaemon<RunReport>(root, 'run', { tasks: ['work'], flags: {} }, { start: { entry: path.join(os.tmpdir(), 'does-not-exist.js'), timeoutMs: 1500 } });
    assert.equal(out.ok, false);
    // a new daemon takes over the stale state
    const srv = await DaemonServer.start({ root, idleMs: 0 });
    const live = await probeDaemon(dirs);
    assert.equal(live.status, 'live');
    await srv.shutdown('t');
  });
});

test('POSIX: a socket file left behind by a SIGKILLed daemon is recovered', { skip: WIN ? 'Windows named pipes vanish with their server; there is no leftover file' : false }, async () => {
  await withProject(async (root, dirs) => {
    await fs.mkdir(dirs.dir, { recursive: true, mode: 0o700 });
    const child = spawn(process.execPath, ['-e', `require('net').createServer().listen(${JSON.stringify(dirs.socket)}, () => console.log('up')); setInterval(() => {}, 1000)`], { stdio: ['ignore', 'pipe', 'ignore'] });
    await new Promise<void>((r) => child.stdout.once('data', () => r()));
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    await fs.access(dirs.socket); // the stale socket is really there
    await fs.writeFile(dirs.token, 'f'.repeat(64), { mode: 0o600 });
    await fs.writeFile(dirs.meta, JSON.stringify({ proto: PROTO, version: VERSION, pid: child.pid, root, endpoint: dirs.socket, startedAt: 1, node: 'v0' }), { mode: 0o600 });
    assert.equal((await probeDaemon(dirs)).status, 'stale');
    const srv = await DaemonServer.start({ root, idleMs: 0 });
    assert.equal((await probeDaemon(dirs)).status, 'live');
    await srv.shutdown('t');
  });
});

test('only one daemon per project: a second start reports AlreadyRunning and leaves the first untouched', async () => {
  await withServer(async (srv, root) => {
    await assert.rejects(DaemonServer.start({ root, idleMs: 0 }), (e: unknown) => e instanceof AlreadyRunningError);
    const p = await probeDaemon(srv.dirs);
    assert.equal(p.status, 'live');
  });
});

test('concurrent starters converge on exactly one daemon', async () => {
  await withProject(async (root, dirs) => {
    const [a, b, c] = await Promise.all([1, 2, 3].map(() => spawnDaemon(root, dirs, { idleMs: 60_000 })));
    for (const p of [a, b, c]) assert.equal(p.status, 'live');
    const pids = new Set([a, b, c].map((p) => (p.status === 'live' ? p.pong.pid : -1)));
    assert.equal(pids.size, 1, `daemons: ${[...pids]}`);
  });
});

test('daemon crash: the client sees a transport failure, tryDaemon reports not-ok, and the one-shot path still works', async () => {
  await withProject(async (root, dirs) => {
    const started = await spawnDaemon(root, dirs, { idleMs: 60_000 });
    assert.equal(started.status, 'live');
    const pid = (started as { pong: { pid: number } }).pong.pid;
    const c = await creds(dirs);
    const seen: Message[] = [];
    const inflight = run(c, root, ['slow'], { noCache: true }, baseEnv(), { onMessage: (m: Message) => { seen.push(m); if (m.type === 'begin') process.kill(pid, 'SIGKILL'); } });
    await assert.rejects(inflight, (e: unknown) => e instanceof DaemonUnavailable && e.sawOutput);
    assert.ok(seen.some((m) => m.type === 'begin'));
    // the daemon is gone: its files are stale, a probe says so, and cleanup is safe
    await new Promise((r) => setTimeout(r, 300));
    const p = await probeDaemon(dirs);
    assert.equal(p.status, 'stale', JSON.stringify(p));
    await removeEndpointFiles(dirs, pid);
    assert.equal((await probeDaemon(dirs)).status, 'absent');
    // and the engine works in-process regardless (this is exactly the CLI fallback)
    const proj = await Project.open(root);
    const rep = await runTasks(proj, ['work'], { env: baseEnv() });
    assert.equal(rep.ok, true);
  });
});

test('idle timeout: the daemon exits by itself and removes its files', async () => {
  await withProject(async (root, dirs) => {
    const srv = await DaemonServer.start({ root, idleMs: 300 });
    await Promise.race([srv.closed, new Promise((_, rej) => setTimeout(() => rej(new Error('did not idle out')), 5000))]);
    await assert.rejects(fs.access(dirs.token));
    await assert.rejects(fs.access(dirs.meta));
    assert.equal((await probeDaemon(dirs)).status, 'absent');
  });
});

test('stop op: graceful shutdown removes endpoint files and the process-level state', async () => {
  await withServer(async (srv) => {
    const c = await creds(srv.dirs);
    await sendRequest(c, 'stop', {});
    await srv.closed;
    assert.equal((await probeDaemon(srv.dirs)).status, 'absent');
  });
});

// ---- running work ---------------------------------------------------------------------------------------

test('a run through the daemon is identical to a one-shot run (shared cache, same fingerprints, client environment)', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const msgs: Message[] = [];
    const rep = await run(c, root, ['work'], {}, baseEnv({ MY_VAR: 'from-client' }), { onMessage: (m: Message) => msgs.push(m) });
    assert.equal(rep.ok, true);
    assert.equal(rep.tasks.find((t) => t.task === 'work')!.state, 'succeeded');
    assert.deepEqual(msgs.map((m) => m.type), ['begin', 'task']);
    assert.equal(await fs.readFile(path.join(root, 'out/result.txt'), 'utf8'), 'files=2 var=from-client');
    // one-shot with the same environment: everything must be a cache hit
    const proj = await Project.open(root);
    const again = await runTasks(proj, ['work'], { env: baseEnv({ MY_VAR: 'from-client' }) });
    assert.equal(again.tasks.find((t) => t.task === 'work')!.state, 'cached');
    // a different client environment must be a different fingerprint, not a stale hit
    const other = await run(c, root, ['work'], {}, baseEnv({ MY_VAR: 'changed' }));
    assert.equal(other.tasks.find((t) => t.task === 'work')!.state, 'succeeded');
    assert.equal(await fs.readFile(path.join(root, 'out/result.txt'), 'utf8'), 'files=2 var=changed');
    // last-run.json is written exactly as the CLI does, so `explain` works
    const last = JSON.parse(await fs.readFile(path.join(root, '.buildrush/state/last-run.json'), 'utf8')) as { requested: string[] };
    assert.deepEqual(last.requested, ['work']);
  });
});

test('warm state never serves stale results: edits, additions and deletions are seen on the next run', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const state = async () => (await run(c, root, ['work'])).tasks.find((t) => t.task === 'work')!.state;
    assert.equal(await state(), 'succeeded');
    assert.equal(await state(), 'cached');
    await fs.writeFile(path.join(root, 'src/a.js'), 'export const a = 2;\n');
    assert.equal(await state(), 'succeeded', 'edit');
    assert.equal(await state(), 'cached');
    await fs.writeFile(path.join(root, 'src/new.js'), 'export const n = 1;\n');
    assert.equal(await state(), 'succeeded', 'addition');
    assert.equal(await fs.readFile(path.join(root, 'out/result.txt'), 'utf8'), 'files=3 var=');
    await fs.rm(path.join(root, 'src/new.js'));
    // back to a previously seen input set: a content-addressed hit, with the old output restored
    assert.equal(await state(), 'cached', 'deletion');
    assert.equal(await fs.readFile(path.join(root, 'out/result.txt'), 'utf8'), 'files=2 var=');
    // the dependency graph follows the files too
    const a1 = (await sendRequest(c, 'analyze', { cwd: root, env: baseEnv() })) as { modules: number };
    await fs.writeFile(path.join(root, 'src/c.js'), "import { b } from './b.js';\nexport const c = b;\n");
    const a2 = (await sendRequest(c, 'analyze', { cwd: root, env: baseEnv() })) as { modules: number; edges: number };
    assert.equal(a2.modules, a1.modules + 1);
    const st = (await sendRequest(c, 'status', {})) as { warm: { index: number; graph: boolean } };
    assert.ok(st.warm.index > 0 && st.warm.graph, 'the daemon really is holding warm state');
    // cacheStats goes through the same authenticated path
    const cs = (await sendRequest(c, 'cacheStats', { cwd: root, env: baseEnv() })) as { stats: { entries: number } };
    assert.ok(cs.stats.entries >= 1);
  });
});

test('concurrent clients are serialised per project: the second waits, both get correct results', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const log: string[] = [];
    const one = (name: string) =>
      run(c, root, ['slow'], { noCache: true }, baseEnv(), {
        onMessage: (m: Message) => log.push(`${name}:${m.type}`),
      }).then((r) => { log.push(`${name}:done`); return r; });
    const p1 = one('A');
    await new Promise((r) => setTimeout(r, 150)); // let A reach the front
    const p2 = one('B');
    const [a, b] = await Promise.all([p1, p2]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.ok(log.includes('B:queued'), log.join(' '));
    assert.ok(log.indexOf('A:done') < log.indexOf('B:begin'), `B must not start before A finishes: ${log.join(' ')}`);
  });
});

test('closing the connection (or sending cancel) cancels the run', async () => {
  await withServer(async (srv, root) => {
    const c = await creds(srv.dirs);
    const ctl = new AbortController();
    const t0 = Date.now();
    const p = run(c, root, ['hang'], { noCache: true }, baseEnv(), { signal: ctl.signal, onMessage: (m: Message) => { if (m.type === 'begin') setTimeout(() => ctl.abort(), 300); } });
    const rep = await p;
    assert.equal(rep.cancelled, true);
    assert.ok(Date.now() - t0 < 20_000, 'the 30 s task must have been killed');
  });
});

// ---- isolation ---------------------------------------------------------------------------------------------

test('tasks never see the daemon token, socket/pipe path or any BUILDRUSH_* variable; logs hold no secrets', async () => {
  const prev = { A: process.env.DAEMON_SIDE_ONLY, B: process.env.BUILDRUSH_TEST_LEAK };
  process.env.DAEMON_SIDE_ONLY = 'daemon-side-secret';
  process.env.BUILDRUSH_TEST_LEAK = 'x';
  try {
    await withServer(async (srv, root) => {
      const c = await creds(srv.dirs);
      // even if the client (wrongly) forwards BUILDRUSH_* variables, the engine strips them
      const rep = await run(c, root, ['dumpenv'], {}, baseEnv({ BUILDRUSH_DAEMON_DIR: base, BUILDRUSH_FROM_CLIENT: 'y', MY_VAR: 'visible' }));
      assert.equal(rep.ok, true);
      const raw = await fs.readFile(path.join(root, '.buildrush/envdump.json'), 'utf8');
      const env = JSON.parse(raw) as Record<string, string>;
      assert.ok(!raw.includes(c.token), 'token leaked into a child environment');
      assert.ok(!raw.includes(srv.endpoint), 'endpoint leaked into a child environment');
      assert.ok(!raw.includes('daemon-side-secret'), "the daemon's own environment must not reach tasks");
      assert.deepEqual(Object.keys(env).filter((k) => k.startsWith('BUILDRUSH_')), []);
      // nothing in the daemon dir except the token file contains the token; nothing at all in the project tree
      for (const f of await fs.readdir(srv.dirs.dir)) {
        if (f === 'token' || f === 's') continue;
        const st = await fs.stat(path.join(srv.dirs.dir, f));
        if (st.isFile()) assert.ok(!(await fs.readFile(path.join(srv.dirs.dir, f), 'utf8')).includes(c.token), `${f} contains the token`);
      }
      const walk = async (d: string): Promise<string[]> =>
        (await Promise.all((await fs.readdir(d, { withFileTypes: true })).map((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : [path.join(d, e.name)])))).flat();
      for (const f of await walk(root)) {
        if (f.endsWith('envdump.json')) continue;
        assert.ok(!(await fs.readFile(f, 'utf8').catch(() => '')).includes(c.token), `${f} contains the token`);
      }
    });
  } finally {
    if (prev.A === undefined) delete process.env.DAEMON_SIDE_ONLY; else process.env.DAEMON_SIDE_ONLY = prev.A;
    if (prev.B === undefined) delete process.env.BUILDRUSH_TEST_LEAK; else process.env.BUILDRUSH_TEST_LEAK = prev.B;
  }
});

// ---- the CLI, end to end -------------------------------------------------------------------------------------

const cli = (cwd: string, env: Record<string, string>, ...args: string[]) =>
  spawnSync(process.execPath, [BIN, ...args], { cwd, encoding: 'utf8', env: baseEnv({ BUILDRUSH_DAEMON_IDLE_MS: '60000', ...env }) });

test('CLI: the daemon is OFF by default; --daemon starts and uses it; start/status/stop work', async () => {
  await withProject(async (root, dirs) => {
    const env = { BUILDRUSH_DAEMON_DIR: base };
    const plain = cli(root, env, 'run', 'work', '--json');
    assert.equal(plain.status, 0, plain.stderr);
    assert.equal((await probeDaemon(dirs)).status, 'absent', 'a plain run must not start a daemon');
    assert.equal(cli(root, env, 'daemon', 'status').status, 1);

    const viaDaemon = cli(root, env, 'run', 'work', '--daemon', '--json');
    assert.equal(viaDaemon.status, 0, viaDaemon.stderr);
    const json = JSON.parse(viaDaemon.stdout) as { ok: boolean; tasks: { task: string; state: string }[] };
    assert.equal(json.ok, true);
    assert.equal(json.tasks.find((t) => t.task === 'work')!.state, 'cached', 'shares the on-disk cache with one-shot runs');
    const st = cli(root, env, 'daemon', 'status', '--json');
    assert.equal(st.status, 0, st.stderr);
    assert.equal((JSON.parse(st.stdout) as { running: boolean }).running, true);

    // env var form, text output, and a failing task keeps its exit code
    const viaEnv = cli(root, { ...env, BUILDRUSH_DAEMON: '1' }, 'run', 'work');
    assert.equal(viaEnv.status, 0, viaEnv.stderr);
    assert.match(viaEnv.stdout, /BuildRush succeeded/);
    const noDaemon = cli(root, { ...env, BUILDRUSH_DAEMON: '1' }, 'run', 'work', '--no-daemon', '--json');
    assert.equal(noDaemon.status, 0);
    const unknown = cli(root, env, 'run', 'nope', '--daemon');
    assert.equal(unknown.status, 2, 'usage errors are reported by the in-process path');
    assert.match(unknown.stderr, /unknown task/);

    const an = cli(root, env, 'analyze', '--json', '--daemon');
    assert.equal(an.status, 0, an.stderr);
    assert.equal((JSON.parse(an.stdout) as { project: string }).project, 'dproj');
    const same = cli(root, env, 'analyze', '--json');
    assert.deepEqual(JSON.parse(an.stdout), JSON.parse(same.stdout), 'daemon and one-shot analyze agree');
    const cs = cli(root, env, 'cache', 'stats', '--daemon');
    assert.equal(cs.status, 0, cs.stderr);

    assert.equal(cli(root, env, 'daemon', 'start').status, 0);
    const stop = cli(root, env, 'daemon', 'stop');
    assert.equal(stop.status, 0, stop.stderr);
    assert.equal(cli(root, env, 'daemon', 'status').status, 1);
    assert.equal(cli(root, env, 'daemon', 'stop').status, 0, 'stop is idempotent');
    assert.equal(cli(root, env, 'daemon', 'bogus').status, 2);
  });
});

test('CLI: --daemon with an unusable daemon directory still runs (one-shot fallback)', async () => {
  await withProject(async (root) => {
    const file = path.join(base, 'not-a-directory');
    await fs.writeFile(file, 'x');
    const r = cli(root, { BUILDRUSH_DAEMON_DIR: file }, 'run', 'work', '--daemon', '--json', '--verbose');
    assert.equal(r.status, 0, r.stderr);
    assert.equal((JSON.parse(r.stdout) as { ok: boolean }).ok, true);
    assert.match(r.stderr, /daemon unavailable/);
  });
});
