# BuildRush

**Local-first incremental build & test engine.** Change a small part of a
project and BuildRush runs only the work that is provably necessary, reuses
valid previous results, runs independent tasks in parallel, and tells you
exactly why anything ran.

> **Status: early (0.1).** The core engine is real and tested (49 tests,
> including adversarial cache/path/secret tests). Watch mode, daemon,
> tool-specific adapters and Windows support are **not built yet**; see
> [ROADMAP.md](ROADMAP.md). No benchmark claims are made until the benchmark
> suite exists.

## Quick start

```bash
npm install --save-dev buildrush      # once published; today: clone + `npm ci && npm run build`
npx buildrush init                    # detects vite/vitest/eslint/tsc and writes buildrush.json
npx buildrush run                     # runs the default pipeline with caching
npx buildrush run                     # again: everything is [cached]
npx buildrush test --affected         # only tests that (transitively) import what you changed
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

## Measured so far (honest numbers)

BuildRush building and testing **itself** (typecheck + build + 49 tests), one run each on a shared 1-machine sandbox, *not* a benchmark:

| Scenario | Wall time |
| --- | --- |
| Cold | ~6.1 s |
| Nothing changed | ~0.21 s |
| `touch` only (mtime changed, content same) | ~0.22 s (no rebuild) |
| One source line edited | ~6.1 s (all three tasks list `src/**` as inputs; cache granularity is per task) |

Proper medians/p95 vs native commands on documented workloads are on the roadmap.

## Docs

[Configuration & commands](docs/configuration.md) · [Architecture & prior art](docs/architecture.md) · [Security model](docs/security.md) · [Cache correctness](docs/cache-correctness.md) · [Roadmap](ROADMAP.md) · [Contributing](CONTRIBUTING.md) · [Governance](GOVERNANCE.md) · [Security policy](SECURITY.md)

## Requirements

Node.js ≥ 22 on Linux or macOS (Windows untested). Zero runtime dependencies.
**Do not run BuildRush on repositories you do not trust**: the config runs commands as you.

## License

MIT. See [LICENSE](LICENSE).
