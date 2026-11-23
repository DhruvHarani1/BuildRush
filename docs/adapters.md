# Adapters

An adapter tells BuildRush what a specific tool **actually reads and writes**, so
you do not have to rediscover hidden inputs by hand. Adapters only fill in what
you omitted: **explicit config always wins**. Adapters cannot weaken core safety
(no shell, env allow-list, cache validation); they only supply defaults.

```json
{ "tasks": {
  "typecheck": { "adapter": "tsc" },
  "build":     { "adapter": "vite",   "dependsOn": ["typecheck"] },
  "test":      { "adapter": "vitest", "affected": true }
} }
```

`buildrush doctor` prints every adapter note (e.g. "inputs widened to the whole
project because vite.config sets `publicDir`").

| Adapter | Default command | Inputs (when omitted) | Outputs | Env fingerprinted | Cache disabled when |
| --- | --- | --- | --- | --- | --- |
| `vite` | `vite build` | `src/**`, `public/**`, `*.html`, `vite.config.*`, `tsconfig*.json`, **`.env`, `.env.*`**, lockfiles | `<outDir>/**` (from `--outDir` or a literal `build.outDir`, else `dist`) | `NODE_ENV`, `MODE`, **every `VITE_*` variable present** | `outDir` is computed/unsafe and no `outputs` given |
| `vitest` | `vitest run` | `src/**`, `test/**`, `tests/**`, `__tests__`, `*.{test,spec}.*`, vitest/vite config, `.env*`, lockfiles | `coverage/**` only with `--coverage` | `NODE_ENV`, `VITE_*`, `VITEST_*` | never automatically (see determinism note) |
| `tsc` | `tsc --noEmit` | every `*.{ts,tsx,mts,cts,js,jsx,mjs,cjs,json}`, lockfiles | `<outDir>/**` when emitting | none | emitting without a project-relative `outDir` |
| `eslint` | `eslint .` | source/config files, `.eslintrc*`, `eslint.config.*`, lockfiles | none | none | never |

## tsc incremental mode (state, not input, not output)

For plain `tsc --noEmit` checks the `tsc` adapter appends
`--incremental --tsBuildInfoFile <.buildrush/state/incremental/<task>/...>` so a
cache **miss** (e.g. a one-file edit) can reuse TypeScript's own semantic
analysis instead of re-checking everything. The `.tsbuildinfo` is **task state**:

* it is **not** hashed into the fingerprint, and the extra flags are not part of
  the fingerprinted command, so cache keys remain a pure function of declared inputs;
* it is **not** a cached output: a cache hit never restores it, and it is never
  stored in the cache. If it is missing or discarded, the only effect is a slower run;
* tsc itself validates it against file hashes and compiler options; BuildRush
  additionally discards it when the TypeScript version, any `tsconfig*.json`
  content, the command, or Node/platform change, when it is not valid JSON, and
  after **any** run that did not succeed (type errors, timeout, cancellation);
* tsc writes to a private copy that is atomically renamed into place only after a
  successful run, so an interrupted or superseded run cannot leave a half-written file.

Enabled only when all hold: adapter `tsc`; effective `--noEmit`; installed
TypeScript major >= 5 (detected from `node_modules`); no `-b/--build`, `--watch`,
`--incremental`, `--composite`, `--tsBuildInfoFile` flags; tsconfig has no
`composite`, `incremental`, `tsBuildInfoFile` or `references`. Otherwise the
command runs exactly as written (`-b` and project-reference builds keep their own mode).
Opt out per task with `"incremental": false` (valid only with `"adapter": "tsc"`).
The task notes in the run report say whether state was reused or discarded.

**Expect modest gains.** Incremental mode skips re-*checking* unchanged files but
still parses, binds and builds the program, which dominate on small and medium
projects. On Windows with TypeScript 5.9 we measured roughly 0-15% on 60-1000 module synthetic apps; do not expect more than the
check phase to disappear.

## Safety behaviour you should know

* **Widening instead of guessing.** If the tool config contains `root`, `envDir`,
  `publicDir`, `include`, `setupFiles`, `dir`, a `../` path, or a custom
  `--config`, the adapter hashes the **whole project** rather than risk missing
  an input. Narrow it by listing `inputs` yourself.
* **Tool version is part of the key** (`vite`, `vitest`, `typescript`, `eslint`
  version from `node_modules`), in addition to the executable's digest and your lockfile.
* **No long-running modes.** `vite dev/preview`, `vitest watch/--ui` are rejected
  at load time with an explanation: they cannot be cached.
* **Vitest affected selection.** Under `--affected`, BuildRush computes the test
  files from its own import graph and passes them as positional filters
  (`vitest run a.test.ts b.test.ts`). Vitest treats filters as substring matches,
  so the selection can only be a *superset* of what was chosen, never a subset.
  Global config changes, dynamic imports etc. still run everything
  ([configuration.md](configuration.md#affected-test-selection-rules)).
* **Determinism is your responsibility for tests.** A cached passing result is
  only valid if the tests are deterministic. Tests that touch the network, clock
  or randomness need `"cache": false`.
* **A task's inputs never include another task's outputs unless it depends on
  that task.** (Found by the benchmark suite: a `**/*.js` input glob was
  swallowing the Vite bundle and invalidating `typecheck`.)

## Writing a new adapter

Add a branch to `resolveAdapter` in `src/adapters.ts` returning `Resolved`
(command, inputs, outputs, env, envPrefixes, cache, notes), a package name in
`ADAPTER_PACKAGE` for version fingerprinting, and optionally a `diagnostics`
parser. Every adapter needs tests in `test/adapters.test.ts` for: defaults,
explicit-config-wins, each "widen/disable" safety path, and refusal of
non-cacheable modes. Planned: Jest, Playwright, Cypress, webpack, esbuild.
