# Roadmap

Status key: ✅ shipped & tested · 🟡 partial · ⬜ not started. Nothing is marked
shipped unless tests exercise it.

| Milestone | Status | Notes |
| --- | --- | --- |
| M1 CLI, config, init/analyze/doctor | ✅ | strict schema, shell-free commands |
| M2 Task graph, scheduler, execution, cancellation | ✅ | bounded, critical-path first |
| M3 Persistent CAS cache + explanations | ✅ | verify/repair/gc, corruption + traversal + symlink tests |
| M4 Vite adapter + baseline benchmarks | ✅ | `vite`/`tsc`/`eslint` adapters (hidden-input handling, outDir discovery, VITE_* env); benchmark suite with parallel-native baseline, correctness gate, median/p95. Still missing: memory/CPU sampling, real-monorepo and slow-install workloads |
| M5 Vitest adapter | 🟡 | adapter + `--affected` selection shipped and benchmarked; opt-in per-test-file result caching (`testCache`, tested with node-script runners, not yet benchmarked with real vitest); missing: coverage-informed and risk-based modes, sharding, flaky-test policy, duration history |
| M6 Watch mode + daemon | ⬜ | needs watcher w/ overflow recovery, debounce, authenticated local IPC |
| M7 Hardening & release | 🟡 | security docs, CI, CodeQL, Scorecard, provenance release written; macOS test matrix (Windows added to CI; local suite passes), fuzzing of the import scanner, npm/Docker publication still to do |
| Workspaces | 🟡 | npm/yarn/bun/pnpm detection, per-package task expansion with `^` ordering, package-aware module graph and `--affected` implemented and tested on a script-based fixture. Not done: validation against real-world monorepos, `--filter`, package-manager-aware task defaults, partial restore of a package's outputs, benchmarks |
| Property-based + fuzz tests | ✅ | seeded property/fuzz tests for glob matcher (reference-equivalence, linear-time), path validation, cache keys, import scanner |
| Remote cache | ⬜ | opt-in only. Prereqs: signed manifests, tenant isolation, TLS auth, retention policy (ADR first) |
| More ecosystems | ⬜ | Python, Go, Rust adapters only after JS/TS is solid |

## Near-term performance ideas (measure first)

1. Per-package task splitting for workspaces is implemented (see Workspaces row); measure it on real monorepos before claiming a win.
2. Parallel/streaming blob restore and hardlink/reflink restore where safe.
3. Persisting the module graph incrementally instead of rebuilding it.
4. Tool-native incremental modes (`tsc --incremental`) with their state dirs as declared outputs.
