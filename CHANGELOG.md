# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versioning: [SemVer](https://semver.org) (pre-1.0: minor versions may break).

## [Unreleased]

### Added
- Optional local daemon: `buildrush daemon start|stop|status` and `--daemon` / `BUILDRUSH_DAEMON=1` (off by default) for `run/build/test/check`, `analyze --json` and `cache stats`. Unix socket / named pipe only, per-daemon token (0600 file in a 0700 per-user dir), closed op set, same engine path, serialised runs, stale-state recovery, idle exit, version handshake, one-shot fallback on any error. Design and threat model: docs/daemon.md; benchmark: `bench/daemon.mjs`.
- `RunOptions.env` and `Project.open({ env, warm })` (library API) so a long-lived host can run with the caller's environment and reuse a re-validated index/graph.
- Workspaces: detection of npm/yarn/bun (`package.json` `workspaces`) and pnpm (`pnpm-workspace.yaml`) layouts, package discovery, per-package task expansion (`"scope": "packages"`, `"packages"` name filter, `^task` dependencies ordered by the package graph, package dependency cycle errors), package-aware module graph (imports of workspace packages resolve via `exports`/`main` onto sources), package-scoped `--affected` (changed packages plus transitive dependents), `graph --packages`, and workspace info in `analyze`/`explain`. See docs/configuration.md.
- CLI: `init`, `analyze`, `graph`, `run`, `build`, `test`, `check`, `explain`, `cache stats|verify|clean`, `doctor`, `config validate`.
- Strict `buildrush.json` schema with path-qualified validation errors; commands run without a shell.
- SHA-256 content-addressed local cache with atomic writes, corruption detection, safe restore, LRU eviction.
- Fingerprints over inputs, dependency fingerprints, env (keyed digests for secret-like names), toolchain and arguments; miss explanations.
- Detection of inputs changing during a run (result is not cached).
- Bounded, critical-path-aware DAG scheduler with cancellation and failure propagation.
- JS/TS import graph (relative, tsconfig paths, workspaces, re-exports, dynamic imports) and `--affected` test selection with conservative fallbacks.
- Security docs, CI, CodeQL, OpenSSF Scorecard, dependency review, provenance-enabled release workflow, hardened Dockerfile.

- Adapters (`vite`, `vitest`, `tsc`, `eslint`): tool-aware inputs (incl. `.env*`, `VITE_*`), outDir discovery, tool-version fingerprinting, refusal of uncacheable modes, failure diagnostics. See docs/adapters.md.
- Opt-in per-test-file result caching for test tasks (`"testCache": true`): unchanged test files (own content + import closure + global config + env + toolchain) are skipped after a prior passing run, with per-file skip reasons; uncertain imports always run. See docs/configuration.md.
- Benchmark suite (`bench/`) with native-sequential and native-parallel baselines and a restored-build equality check.
- `scripts/apply-github-security.sh`: idempotent repository hardening (branch protection, rulesets, Actions policy).

- Watch mode: `run|build|test|check --watch` keeps the Project, index and graph in memory, re-runs only affected work on each change (unchanged tasks are `[cached]`), cancels obsolete in-flight runs, reconciles by content digest on a timer and after watcher errors, and with `--json` prints one object per cycle. See docs/architecture.md.

### Fixed
- A long-lived process could reuse a stale executable digest after the binary was replaced: the digest memo is now keyed by file identity.
- A task's inputs could include another, unrelated task's outputs (found by the benchmark suite).

### Not yet implemented
Daemon peer-credential checks and daemon-hosted watch (watch mode and an opt-in daemon are shipped), Vite/Vitest-specific adapters, coverage-informed selection, remote cache, Windows support. See ROADMAP.md.
