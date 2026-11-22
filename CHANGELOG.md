# Changelog

All notable changes are documented here. Format: [Keep a Changelog](https://keepachangelog.com), versioning: [SemVer](https://semver.org) (pre-1.0: minor versions may break).

## [Unreleased]

### Added
- CLI: `init`, `analyze`, `graph`, `run`, `build`, `test`, `check`, `explain`, `cache stats|verify|clean`, `doctor`, `config validate`.
- Strict `buildrush.json` schema with path-qualified validation errors; commands run without a shell.
- SHA-256 content-addressed local cache with atomic writes, corruption detection, safe restore, LRU eviction.
- Fingerprints over inputs, dependency fingerprints, env (keyed digests for secret-like names), toolchain and arguments; miss explanations.
- Detection of inputs changing during a run (result is not cached).
- Bounded, critical-path-aware DAG scheduler with cancellation and failure propagation.
- JS/TS import graph (relative, tsconfig paths, workspaces, re-exports, dynamic imports) and `--affected` test selection with conservative fallbacks.
- Security docs, CI, CodeQL, OpenSSF Scorecard, dependency review, provenance-enabled release workflow, hardened Dockerfile.

### Not yet implemented
Watch mode, daemon, Vite/Vitest-specific adapters, coverage-informed selection, remote cache, Windows support. See ROADMAP.md.
