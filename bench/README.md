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
```

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
