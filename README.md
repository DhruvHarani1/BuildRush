# BuildRush

**Local-first incremental build & test engine.** Change a small part of a
project and BuildRush runs only the work that is provably necessary, reuses
valid previous results, runs independent tasks in parallel, and tells you
exactly why anything ran.

> **Status: early (0.1).** The core engine is real and tested (60 tests,
> including adversarial cache/path/secret tests). Watch mode (`--watch`) is
> available; the daemon is **not built yet**; see
> [ROADMAP.md](ROADMAP.md). No benchmark claims are made until the benchmark
> suite exists.

## Quick start

```bash
npm install --save-dev buildrush      # once published; today: clone + `npm ci && npm run build`
npx buildrush init                    # detects vite/vitest/eslint/tsc and writes buildrush.json
npx buildrush run                     # runs the default pipeline with caching
npx buildrush run                     # again: everything is [cached]
npx buildrush test --affected         # only tests that (transitively) import what you changed
npx buildrush test --watch            # stay running; re-run only what each file change affects (also run/build/check)
npx buildrush run --watch --json      # one JSON object per cycle (NDJSON) for editors and scripts
npx buildrush explain src/Button.tsx  # tasks, modules and tests this file affects, with import chains
```

```
[ran]       typecheck        1.88s  why: input changed: src/util/glob.ts
[cached]    build              91ms  restored 368.6 KiB
[ran]       test             3.91s  why: dependency task "build" has a different fingerprint
BuildRush succeeded: 2 ran, 1 cached, 0 failed, 0 skipped in 6.0s
```

## Why trust the cache

* Keys are SHA-256 over **file contents** (never mtimes), dependency fingerprints, declared env, toolchain and arguments.
* Failed, cancelled, timed-out runs and runs whose inputs changed *while running* are **never cached**.
* Restores verify every blob before writing, refuse traversal and symlinks, and drop setuid bits.
* If BuildRush cannot prove something is unaffected (global config, dynamic imports, no git) it runs more, and says why.

Details: [docs/cache-correctness.md](docs/cache-correctness.md) · [docs/security.md](docs/security.md).

## Measured results (and where BuildRush does *not* win)

Generated TypeScript apps, Vite 6 + Vitest 3 + tsc 5.9, 4-core shared sandbox, 5 runs each, median. Reproduce with `node bench/run.mjs` ([method](bench/README.md)). "Native parallel" is `tsc && vite build` running alongside `vitest run`; compare against that, not the sequential chain.

| Scenario (medium: 400 modules, 60 tests) | Native parallel | BuildRush |
| --- | --- | --- |
| Cold full run | 10.5 s | 11.3 s (~8% slower) |
| **No change** | 10.9 s | **0.11 s (~100x faster)** |
| One-file edit, full pipeline | 10.5 s | 10.6 s (equal) |
| **Restore deleted `dist/`** | 0.95 s (rebuild) | **0.12 s** |
| Tests only after a narrow edit | `vitest related` 2.08 s | `test --affected` 2.87 s (**slower**), vs 9.45 s for all tests |
| Tests only after a wide edit | `vitest related` 9.62 s | 10.3 s (**slower**; all tests selected) |

The small workload (60 modules) shows the same shape: no-change 86 ms vs 2.0 s, cold 2.09 s vs 1.93 s.

What this says honestly: the cache pays off when nothing relevant changed (the common case between edits, branch switches and CI reruns). When real work must happen, BuildRush costs roughly 0-8% more than a well-written parallel script, and `--affected` currently carries ~0.8 s of overhead versus Vitest's own `related`. Reducing that overhead is the next optimisation target. Memory/CPU, Windows and real monorepos are **not measured**; there are no comparisons with Nx/Turborepo/Bazel.

## Docs

[Configuration & commands](docs/configuration.md) · [Adapters](docs/adapters.md) · [Benchmarks](bench/README.md) · [Architecture & prior art](docs/architecture.md) · [Security model](docs/security.md) · [Cache correctness](docs/cache-correctness.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Security policy](SECURITY.md)

## Requirements

Node.js ≥ 22 on Linux, macOS and Windows (CI runs all three). On Windows, npm `.cmd` shims are unwrapped and their Node target is run directly; arguments are never passed through `cmd.exe`. Zero runtime dependencies.
**Do not run BuildRush on repositories you do not trust**: the config runs commands as you.

## License

MIT. See [LICENSE](LICENSE).
