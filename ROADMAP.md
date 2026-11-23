# Roadmap

Status key: ✅ shipped & tested · 🟡 partial · ⬜ not started. Nothing is marked
shipped unless tests exercise it.

| Milestone | Status | Notes |
| --- | --- | --- |
| M1 CLI, config, init/analyze/doctor | ✅ | strict schema, shell-free commands |
| M2 Task graph, scheduler, execution, cancellation | ✅ | bounded, critical-path first |
| M3 Persistent CAS cache + explanations | ✅ | verify/repair/gc, corruption + traversal + symlink tests |
| M4 Vite adapter + baseline benchmarks | ✅ | `vite`/`tsc`/`eslint` adapters (hidden-input handling, outDir discovery, VITE_* env); benchmark suite with parallel-native baseline, correctness gate, median/p95. Still missing: memory/CPU sampling, real-monorepo and slow-install workloads |
| M5 Vitest adapter | 🟡 | adapter + `--affected` selection shipped and benchmarked; opt-in per-test-file result caching (`testCache`, tested with node-script runners and benchmarked with real vitest on a Linux CI runner: narrow one-file edit 3.7 s vs 15.1 s native parallel, wide edit no gain; see issue #10); missing: coverage-informed and risk-based modes, sharding, flaky-test policy, duration history |
| M6 Watch mode + daemon | 🟡 | **Done and tested:** `run/build/test/check --watch` (+ `--json` NDJSON): `fs.watch` (native recursive on Windows/macOS, per-directory watchers on Linux that skip ignored trees), leading+trailing debounce, content-digest reconciliation (periodic, and forced after watcher errors), task-output/ignored-dir filtering, cancellation of obsolete runs (never cached), config/package.json reload, graceful shutdown. **Daemon (opt-in, `--daemon`; docs/daemon.md):** per-project daemon on a Unix socket / named pipe, per-start 256-bit token in a 0600 file in a 0700 per-user directory, closed op set (ping/status/run/analyze/cacheStats/stop), same engine path as one-shot, serialised runs, stale-endpoint recovery by authenticated liveness probe, idle exit, version handshake, one-shot fallback on every error; tested on Windows (named pipe) and in CI for the Unix socket path. Warm state = file index + dependency graph, re-validated every request. **Measured gain is small:** ~3-5 % for a no-change `run`, 35-125 ms for graph work, so it stays off by default. **Not done:** peer-credential checks (Node exposes none; protection is directory/ACL + token), using the file watcher to skip scans (deliberately not done: digests decide), daemon-hosted watch mode, a lighter client that avoids loading the whole CLI, Linux/macOS measurements, inotify-limit handling beyond falling back to polling reconciliation, watch-mode benchmarks (watch tests run in CI on Linux, macOS and Windows) |
| M7 Hardening & release | 🟡 | security docs, CI, CodeQL, Scorecard, provenance release written; macOS test matrix (Windows added to CI; local suite passes), fuzzing of the import scanner, npm/Docker publication still to do |
| Workspaces | 🟡 | npm/yarn/bun/pnpm detection, per-package task expansion with `^` ordering, package-aware module graph and `--affected` implemented and tested on a script-based fixture and run on three real monorepos (mobx, preactjs/signals, TanStack/store; Windows only; see [docs/configuration.md](docs/configuration.md#validated-on-real-repositories-and-known-limitations): four bugs found and fixed, limitations documented). Not done: TypeScript project references and yarn berry/bun layouts unvalidated, `--filter`, package-manager-aware task defaults, partial restore of a package's outputs, benchmarks |
| Property-based + fuzz tests | ✅ | seeded property/fuzz tests for glob matcher (reference-equivalence, linear-time), path validation, cache keys, import scanner |
| Remote cache | ⬜ | opt-in only. Prereqs: signed manifests, tenant isolation, TLS auth, retention policy (ADR first) |
| More ecosystems | ⬜ | Python, Go, Rust adapters only after JS/TS is solid |

## Near-term performance ideas (measure first)

1. Per-package task splitting for workspaces is implemented (see Workspaces row); measure it on real monorepos before claiming a win.
2. Parallel/streaming blob restore and hardlink/reflink restore where safe.
3. Persisting the module graph incrementally instead of rebuilding it.
4. Tool-native incremental modes (`tsc --incremental`) with their state dirs as declared outputs.
