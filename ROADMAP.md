# Roadmap

Status key: ✅ shipped & tested · 🟡 partial · ⬜ not started. Nothing is marked
shipped unless tests exercise it.

| Milestone | Status | Notes |
| --- | --- | --- |
| M1 CLI, config, init/analyze/doctor | ✅ | strict schema, shell-free commands |
| M2 Task graph, scheduler, execution, cancellation | ✅ | bounded, critical-path first |
| M3 Persistent CAS cache + explanations | ✅ | verify/repair/gc, corruption + traversal + symlink tests |
| M4 Vite adapter + baseline benchmarks | ⬜ | today Vite runs as a generic task; need declared-output discovery and a benchmark suite (cold/warm/1-file/lockfile) vs native commands, median + p95 |
| M5 Vitest adapter | 🟡 | `--affected` file selection works generically; missing: coverage-informed and risk-based modes, per-file result caching, sharding, flaky-test policy, duration history |
| M6 Watch mode + daemon | ⬜ | needs watcher w/ overflow recovery, debounce, authenticated local IPC |
| M7 Hardening & release | 🟡 | security docs, CI, CodeQL, Scorecard, provenance release written; macOS/Windows test matrix, fuzzing of the import scanner, npm/Docker publication still to do |
| Workspaces | ⬜ | per-package task expansion (`build` in every package, ordered by package deps) |
| Property-based + fuzz tests | ⬜ | cache keys, glob matcher, path validation |
| Remote cache | ⬜ | opt-in only. Prereqs: signed manifests, tenant isolation, TLS auth, retention policy (ADR first) |
| More ecosystems | ⬜ | Python, Go, Rust adapters only after JS/TS is solid |

## Near-term performance ideas (measure first)

1. Per-package task splitting for workspaces (biggest real-world win).
2. Parallel/streaming blob restore and hardlink/reflink restore where safe.
3. Persisting the module graph incrementally instead of rebuilding it.
4. Tool-native incremental modes (`tsc --incremental`) with their state dirs as declared outputs.
