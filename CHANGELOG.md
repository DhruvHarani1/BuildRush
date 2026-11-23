# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versioning: [SemVer](https://semver.org) (pre-1.0: minor versions may break).

## [Unreleased]

### Added
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
- Benchmark suite (`bench/`) with native-sequential and native-parallel baselines and a restored-build equality check.
- `scripts/apply-github-security.sh`: idempotent repository hardening (branch protection, rulesets, Actions policy).

### Fixed
- A task's inputs could include another, unrelated task's outputs (found by the benchmark suite).

### Not yet implemented
Watch mode, daemon, Vite/Vitest-specific adapters, coverage-informed selection, remote cache, Windows support. See ROADMAP.md.
