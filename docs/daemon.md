# ADR: the optional local daemon

Status: accepted, implemented in `src/daemon/`. Tests: `test/daemon.test.ts`.
Measurements: `bench/daemon.mjs`.

## Context

Every `buildrush` command is a one-shot process. A daemon lets separate invocations share
warm state. It also adds the first IPC surface BuildRush has ever had, plus stale-state and
crash handling. The decisions below keep the security model unchanged
(see [security.md](security.md): same-user attacker is out of scope, nothing else may drive the engine).

## Decisions

1. **Opt-in, and it can never be required.** `buildrush run` etc. never look for a daemon
   unless `--daemon` or `BUILDRUSH_DAEMON=1` is given (`--no-daemon` wins). Auto-start is
   **off by default**: a background process surprising people (CI, containers, `npx`) costs more
   than the measured saving (see Measurements). With the opt-in, the daemon is started on demand.
2. **Every failure BEFORE a run begins falls back to a normal one-shot run.** Connection refused,
   stale files, bad token, version mismatch, handshake or protocol error, unknown task: the CLI runs the
   same command in-process (usage/config errors are always reported by that path, so messages and
   exit codes are identical). **Once the daemon has sent `begin` for a `run`, failures are NOT retried
   silently**: tasks may already have executed (and orphaned children may still be writing), so a
   silent re-run could repeat non-cacheable side effects. The CLI prints that the daemon failed
   mid-run and exits 3; re-run explicitly (the cache makes that cheap), with `--no-daemon` if it recurs.
   `analyze` and `cache stats` are read-only and always fall back.
3. **No network listener, ever.** Unix domain socket (POSIX) / named pipe (Windows). No TCP,
   no `0.0.0.0`, no localhost port.
4. **One daemon per project root**, keyed by `sha256(realpath(root))[0..16]` (lower-cased on
   Windows). It serves only that project; a request whose `cwd` resolves to another root is
   refused (`wrong_root`).
5. **Authentication is a per-daemon random token**, 32 bytes from `crypto.randomBytes`
   (64 hex chars), regenerated at every daemon start, never in argv or environment, stored in a
   `0600` file inside a per-user `0700` directory. **Every connection must present it in its
   first line**, compared in constant time (`timingSafeEqual` over SHA-256 digests, so lengths do
   not leak). A missing/wrong token closes the connection with **no reply** (no oracle), executes
   nothing, and is logged as a fixed string.
6. **Where state lives** (never inside the project tree, so it is not committed, cached or
   hashed into a task input):

   | OS | Directory |
   | --- | --- |
   | Linux/macOS | `$XDG_RUNTIME_DIR/buildrush/<key>/` (only if that directory is owned by you and mode 0700), else `${XDG_CACHE_HOME:-~/.cache}/buildrush/run/<key>/` |
   | Windows | `%LOCALAPPDATA%\BuildRush\daemon\<key>\` |

   **The shared temp directory is never used**: it is world-writable and predictable. If no private
   per-user location can be determined (no `HOME`/`XDG_*`/`LOCALAPPDATA`), or the Unix socket path would exceed
   the OS limit (~104 bytes macOS, 108 Linux; a shorter `<base>/<key8>.s` name inside the 0700 base is tried
   first), the daemon is reported unavailable (`daemon start` says why; `--daemon` falls back to one-shot).

   `BUILDRUSH_DAEMON_DIR` overrides the base (tests, odd setups) and is validated identically.
   Contents: `token`, `daemon.json` (pid, endpoint, versions; its presence means "ready"),
   `log`, and on POSIX the socket `s`.
7. **Closed protocol, no code execution from requests.** Newline-delimited JSON. Operations:
   `ping`, `status`, `run {tasks, flags}`, `analyze`, `cacheStats`, `stop`. Nothing else
   parses. `run` takes task/pipeline **names** that must exist in `buildrush.json`, a fixed
   set of boolean/number/short-string flags, and the client's environment. No command, path to
   execute, script or config is ever accepted from a request.
8. **The daemon runs the same engine, not a copy.** `runTasks` with the same cache validation,
   resource limits, scheduler, timeouts and process-group cancellation. The only difference is
   that `RunOptions.env` (new, defaults to `process.env`) carries the **client's** environment, so
   fingerprints and child environments are what a one-shot run in the client's shell would use.
   Child environments remain the engine's allow-list; `BUILDRUSH_*` is still stripped, and the
   token/endpoint are in neither the daemon's environment nor argv, so no child can inherit them.
   On Windows the client's environment is exposed to the engine with case-insensitive lookups (`Path` is
   `PATH`), as `process.env` is. Path-valued settings are made absolute by the **client** against its own
   cwd (`BUILDRUSH_CACHE_DIR`); the daemon rejects a relative value (`bad_request`) because it would
   resolve against the daemon's cwd, split the cache from one-shot runs and could land in a shared
   directory. `BUILDRUSH_DAEMON_DIR` is likewise passed to the spawned daemon already absolute.
9. **What stays warm**: the `FileIndex` (not re-read from `index.json`), the dependency graph
   (keyed by a digest of every non-output file digest + test patterns + workspace layout, so it is
   rebuilt exactly when an input changed), the compiled-glob and executable-digest memos (the
   latter keyed by file identity). **What is never trusted warm**: the index is re-scanned
   (stat + content digest, racy-window rule included) at the start of every request; config,
   adapters and workspace layout are re-resolved every request; the cache is validated per
   restore. The watcher is deliberately **not** used to skip scans: BuildRush's rule is that
   content digests, not events, decide what changed (`watch.ts` reconciles the same way), and a
   dropped event must never produce a stale cache hit.
10. **Serialisation.** Project operations are queued per daemon (they share the working tree, the
    warm index and the cache). A second concurrent client receives `queued` and waits; a client that
    disconnects (or sends `cancel`) cancels its own work and its queue slot.
11. **Lifecycle.** Start is serialised by a lock directory plus a liveness probe, so concurrent
    starters converge on one daemon (losers exit 0). The lock carries an owner nonce, so a previous
    owner can never release a lock that was broken and re-taken; stale-file cleanup by clients takes the same lock
    and re-probes under it before deleting. Liveness is an **authenticated ping**, never
    "the file exists" or "that pid exists" (pids are reused). An unanswered endpoint that refuses
    connections (`ECONNREFUSED`/`ENOENT`/`ENOTSOCK`) is *stale*: its token, metadata and socket are
    removed (only if the metadata still names the pid we saw). An endpoint that exists but does not
    answer (busy, wrong owner, bad permissions) is *unreachable* and is never touched. Idle auto-exit
    after 10 minutes (`BUILDRUSH_DAEMON_IDLE_MS`, `0` disables), not while work is queued or a client
    is connected. `stop`, `SIGINT`, `SIGTERM`: stop accepting, cancel runs, wait up to 5 s, remove
    files. Uncaught errors clean up and exit 1. A daemon whose Node binary, `package.json` or
    anything under `dist/src` (newest mtime + file count, stat-walked at most once per second) changed
    reports `stale_daemon` and exits.
12. **Version handshake.** Every request carries `proto` and the client's BuildRush version. If either
    differs from the daemon's, work is refused with `version_mismatch` (carrying the daemon's values).
    `ping`, `status` and `stop` are served across versions, so the envelope fields `proto`,
    `token`, `op` are frozen forever. The client then asks the old daemon to exit and falls back
    (or, with the opt-in, starts a matching one). Never speak a newer protocol to an older daemon.
13. **Limits.** Request line 1 MiB (env 256 KiB), 5 s to deliver the first line, at most 32
    connections of which 8 unauthenticated, string/array/number bounds on every field. Responses may
    be large (task logs, already capped by the engine); the client accepts up to 128 MiB per line.
    There is deliberately no overall limit on a run: task `timeout`s are the engine's concern.

## Threat model

Protected against: other local users (socket/pipe and token unreachable), other processes of the
same user that do not hold the token file contents *and* cannot read a `0700` directory (POSIX),
network attackers (no listener), malformed/oversized/slow input, a stale or hijacked-by-name
endpoint, version skew, task children snooping credentials, and a hostile *project* trying to
reach the daemon (tasks get neither token nor endpoint).

**Not protected against**: any process running as the same OS user. It can read the token file,
connect, and ask for a run of tasks that already exist in the user's own `buildrush.json`, which
it could equally execute directly, or edit the config and the sources. This is the same
boundary as the rest of BuildRush ([security.md](security.md)).

## Platform guarantees (exactly)

* **POSIX.** The state directory is created `0700` (tightened if it pre-exists and is ours; refused
  if owned by another user or a symlink); token/metadata `0600`; the socket lives inside the `0700`
  directory and is made `0600` (`umask(0177)` around `listen`, then `chmod`). Clients refuse
  credentials from a directory or token file with group/other access or another owner.
  **Peer credentials are not verified**: Node exposes no `SO_PEERCRED`/`getpeereid`. The `0700`
  directory plus the token are what protect the socket.
* **Windows.** Node creates the pipe with the default DACL; Node/libuv offers no way to
  read the peer's SID, so **peer identity is not verified**. Protection is: (a) an unguessable per-daemon
  pipe name (`\\.\pipe\buildrush-<key>-<64 random bits>`, stored only in the user-private directory), and
  (b) the token. The state directory lives under `%LOCALAPPDATA%` (inherits the per-user profile ACL) and,
  when BuildRush creates it, is additionally restricted with `icacls` to the current user
  (`/grant:r` first, `/inheritance:r` only if that succeeded, so a failure cannot lock you out).
  That hardening is best effort: if `icacls` is unavailable the profile ACL is what remains. Administrators
  and SYSTEM can always read it. `NTFS` mode bits are not checked (they do not exist).

## Consequences / residual risks

* Lock breaking (abandoned lock older than 15 s) races a stat against a rename: worst case two starters
  briefly overlap, which the atomic endpoint bind still resolves. Availability only, never a security issue.
* A cache directory (`BUILDRUSH_CACHE_DIR` / config) owned by another user is not refused on POSIX; the
  daemon no longer resolves one against its own cwd, but a user-chosen shared path is the user's choice.
* State-directory and token checks use one no-follow file handle (no check-then-use window); the log is
  rotated by rename (two generations), not stat-then-delete.

* A same-user attacker is out of scope (see above). Token file read access equals daemon access.
* The daemon receives the client's whole environment (needed for fingerprints and `PATH`), in memory
  only; it is never logged and is forwarded to tasks only through the engine's allow-list.
* The daemon's own environment is used for `git` calls made by `--affected` (not the client's) and
  for the `node:<version>` shortcut in executable fingerprints. A different Node binary is hashed
  normally; a replaced Node binary or BuildRush install makes the daemon exit on the next request.
* Graph reuse assumes the graph is a function of file digests, patterns and workspace layout (true today).
  Resolution that consults files outside the index (e.g. a `tsconfig` `extends` outside the project) is
  subject to the same limitation as the on-disk scan cache.
* A crash mid-run re-executes unfinished tasks in-process; tasks must be safe to re-run, as they
  already are after any cancelled run.
* On Linux a run killed with the daemon (`SIGKILL`) can leave its task children running until they exit;
  graceful shutdown cancels them with the engine's SIGTERM-then-SIGKILL.
* Auth-failure and lifecycle events are logged to `log` (0600, trimmed at 1 MiB), as fixed strings only.

## Measurements (honest)

`node bench/daemon.mjs` (generated medium project, 468 files, no-change runs, Windows 11, Node 24).
On this noisy machine bare `node bin/buildrush.js --version` alone ranged 257-1154 ms, so
end-to-end CLI numbers were not distinguishable (median saving about 0-120 ms, inside the noise).
The in-process measurement, which removes process start, is stable:

| | one-shot | warm daemon | saved |
| --- | --- | --- | --- |
| medium (468 files) `run` no change | 101 ms | 98 ms | ~3 ms |
| medium `analyze` | 80 ms | 46 ms | ~35 ms |
| large (3,208 files) `run` no change | 242 ms | 229 ms | ~13 ms |
| large `analyze` | 301 ms | 175 ms | ~126 ms |

Conclusion: the **graph** is the part worth keeping warm (`analyze`, `explain`, `--affected`,
workspace selection). A no-change `run` saves about 3-5 %, because the daemon still re-scans on every
request by design and Node process start plus loading the CLI (not saved: the client is still a Node
process) dominate. This is why the daemon is opt-in.
Untested here: macOS, Linux (CI covers the Unix-socket path), and large real monorepos.
