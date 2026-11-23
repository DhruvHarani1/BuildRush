# Benchmark suite

Measures **real** commands on **generated, deterministic** TypeScript apps and
compares BuildRush with native tooling. Nothing here is estimated or
hard-coded; results are written to `bench/results/*.json` (raw) and `*.md`.

```bash
npm run build
node bench/run.mjs --workload small  --runs 5      # 60 modules, 12 tests
node bench/run.mjs --workload medium --runs 7      # 400 modules, 60 tests
node bench/run.mjs --workload assets --runs 5      # 600 generated JSON assets
node bench/run.mjs --workload small --scenarios cold,nochange,edit-narrow
node bench/run.mjs --workload small --scenarios testcache-narrow,testcache-wide,testcache-nochange
```

Result files are only comparable on the same machine class: do not commit
`bench/results` produced on a laptop or Windows next to Linux CI numbers.

Needs network once per workload (`npm install` of typescript/vite/vitest into
`bench/.work/<workload>`, git-ignored). Run on an otherwise idle machine.

## Method

* **Baselines.** `native sequential` = `tsc --noEmit && vite build && vitest run`
  (what an npm-script chain does). `native parallel` = the same, with typecheck→build
  and tests run concurrently (what a careful developer scripts). **Compare
  BuildRush with the parallel one**: the sequential one flatters any tool that parallelises.
  For tests-only edits we also compare with `vitest related`.
* **Scenarios.** cold full run · no-change · one-file edit (narrow vs wide impact:
  a leaf module vs the module everything imports) · tests-only after an edit ·
  config change · lockfile change · cache restore after deleting `dist/` · graph
  construction · cache size on disk.
* **testCache scenarios** (keys `testcache-narrow`, `testcache-wide`,
  `testcache-nochange`; run last). The suite commits a copy of `buildrush.json` with
  `testCache: true` on the test task, then restores the original, so the other
  scenarios are unaffected. A full `buildrush run` is compared with native parallel,
  `vitest run` (all tests) and `vitest related`. Note the full pipeline also includes
  typecheck and build; the existing `edit-*` scenarios are the testCache-OFF
  reference for it. Wide impact (`m0`) is expected to run *all* tests and is
  reported as such: testCache cannot help there.
  Guards (abort the suite if violated): testCache is actually active (the JSON
  report has `testCache`; it auto-disables if the generated vitest config gets
  `root/include/setupFiles/globalSetup/dir`, so the bench project config must stay
  free of those); in every iteration the number of test files executed equals the
  number whose import closure contains the edited module (derived from the
  generated tests) and the rest are skipped; and a deliberately failing test fails
  identically under native vitest and BuildRush, twice in a row (a failure is never
  served from the cache).
* **Every iteration changes content** (unique edits), because a repeated
  identical edit is *correctly* a cache hit and would measure the wrong thing.
* **Guards.** Every BuildRush run asserts the expected per-task state (`cached` /
  `succeeded`); a mismatch aborts the suite rather than reporting a misleading
  number. Before timing, the suite verifies that a **cache-restored `dist/` is
  byte-identical to a native `vite build`**.
* **Statistics.** median and p95 (nearest rank) over `--runs` samples. With fewer
  than 20 runs, p95 is effectively the maximum. Wall-clock, includes process start-up.
* **Not measured (yet):** peak memory/CPU (needs a portable sampler), Windows,
  a real monorepo (needs workspace task expansion), slow-install workloads,
  comparisons with Nx/Turborepo/Bazel. Treat any claim about those as unproven.

Workloads are synthetic: they exercise the engine, not framework-specific
bundler cost. Report results with the machine info the suite records.
