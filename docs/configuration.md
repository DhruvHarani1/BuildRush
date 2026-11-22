# Configuration reference (`buildrush.json`)

One format on purpose: strict JSON, zero parser dependencies, validated at load
with path-qualified errors (`tasks.build.dependsOn: unknown task "x"`).
Unknown keys are errors, not silently ignored. Run `buildrush config validate`.

```jsonc
{
  "version": 1,                         // required, must be 1
  "project": { "name": "my-app" },
  "concurrency": 4,                     // default: CPU count - 1
  "ignore": ["tmp/**"],                 // never indexed (always ignored: .git, node_modules, .buildrush)
  "cache": { "dir": null, "maxSizeMB": 2048 },  // dir default: .buildrush/cache; env BUILDRUSH_CACHE_DIR overrides
  "tests": { "patterns": ["**/*.{test,spec}.{ts,tsx,js,jsx}"] },
  "tasks": {
    "build": {
      "adapter": "vite",                // optional: vite | vitest | tsc | eslint (see adapters.md). With an adapter, command/inputs/outputs/env default sensibly
      "command": "vite build",          // string (no shell syntax allowed) or ["argv", "array"]
      "kind": "build",                  // build | test | check | run (default run)
      "dependsOn": ["typecheck"],
      "inputs": ["src/**", "package.json", "package-lock.json"], // omit = whole project except task outputs
      "outputs": ["dist/**"],
      "env": ["NODE_ENV"],              // passed AND part of the cache key
      "passEnv": [],                    // passed, NOT part of the key
      "cache": true,
      "cwd": ".",                       // project-relative
      "cpu": 1,                         // scheduler weight
      "timeoutMs": 600000,
      "affected": false,                // test tasks: receive selected test files under --affected (default true for kind "test")
      "testCache": false                // test tasks only, opt-in: skip individual test files unchanged since a passing run (see below)
    }
  },
  "pipelines": { "default": ["typecheck", "build"] }
}
```

**Inputs and other tasks' outputs.** A task never sees another task's declared `outputs` as inputs unless it (transitively) `dependsOn` that task.

Globs: `**`, `*`, `?`, `{a,b}`; a trailing `/` means "everything beneath".
Patterns must be project-relative and may not contain `..`.

## Commands

| Command | Purpose |
| --- | --- |
| `buildrush init [--force]` | Generate a starter config from detected tools (fails if nothing is detected) |
| `buildrush analyze [--json]` | Project summary, module graph stats, cycles, uncertain modules |
| `buildrush graph [--dot]` | Module dependency graph |
| `buildrush run [task\|pipeline...]` | Run with caching (default pipeline `default`) |
| `buildrush build\|test\|check` | Run the task/pipeline with that name |
| `--affected [--since <ref>]` | Select tests affected by changes vs a git ref (default `HEAD`, includes untracked) |
| `--no-cache`, `--bail`, `--concurrency n` | Execution controls |
| `buildrush explain [task\|file]` | Why things ran; what a file change affects, with import chains |
| `buildrush cache stats\|verify [--repair]\|clean` | Cache management |
| `buildrush doctor` | Environment/config/cache diagnostics |
| `--json`, `--verbose`, `--quiet`, `--root` | Output & location |

Exit codes: `0` success, `1` task failure, `2` usage/config error, `3` internal error, `130` cancelled.

## Affected-test selection rules

A test is selected when it (transitively) imports a changed file. **All tests**
run when the change is global (`package.json`, lockfiles, `tsconfig*.json`,
`.env*`, vite/vitest/jest configs, `buildrush.json`), when any affected module
has non-literal dynamic loading, `import.meta.glob`, `require.context` or an
unresolved alias, or when git cannot be queried. Tests with unresolved imports
always run. Deleted files are expanded using the previous graph. Imports inside
comments/strings can add edges (extra work, never skipped work).

## Per-test-file result caching (`testCache`)

Opt-in (`"testCache": true`, default `false`, only valid for `kind: "test"`). Without it
the whole test task is one cache unit, so a one-file edit re-runs every test. With it,
when the task misses the whole-task cache, each test file (from `tests.patterns`,
inside the task `cwd`; under `--affected`, the selected files) is looked up on its own.
A file is **skipped** only if a prior **passing** run recorded the identical key:

- the test file's content digest and the digests of its whole transitive import closure (module graph);
- every global config file (`package.json`, lockfiles, `tsconfig*.json`, vite/vitest/jest configs, `.env*`, `.npmrc`, `.nvmrc`, `buildrush.json`): any change invalidates all tests;
- the task command, cwd, declared `env` (secret-named values are HMAC'd; no env values are stored) and toolchain (node, adapter version, executable digest).

Rules that keep it safe:

- A test whose closure contains any **uncertain** import (non-literal `import()`/`require()`, `import.meta.glob`, `require.context`, any unresolved import, including generated files that are task outputs) **always runs**.
- Only runs that exit 0 record results. Failed, timed-out and cancelled runs record nothing, even for files that passed inside them.
- After a passing run the files are re-scanned; a result is recorded only if that file's key is unchanged since the run started.
- `--no-cache` and `"cache": false` disable it. With the `vitest` adapter it is disabled automatically when the vitest config customises `root/include/setupFiles/globalSetup/dir` or the command uses `--config/--root/--dir/--workspace/--project`.
- Skips are reported per file with a reason (`[cached]`/`skip <file>: unchanged since passing run ...` in the CLI; `testCache.skipped` / `testCache.ran` in `--json`). If every file is skipped nothing is executed.

Requirements and limits (be honest with yourself before enabling):

- The test command must accept test file paths as trailing arguments (as `vitest run <files>` and `node --test <files>` do) and must fail if a given file does not run. With `testCache`, BuildRush always passes the explicit list of files to run, so discovery is defined by `tests.patterns`, not by the runner's own include rules.
- Dependencies the graph cannot see are not tracked: files read at runtime (`fs.readFile`, fixtures, snapshots), network, time, randomness, and setup files/globals that are not imported by the test. Keep those tests out of `testCache` tasks or list them via a separate task with `"cache": false`.
- Results are stored under `.buildrush/state/testcache/` (not in the content-addressed cache); up to 4 keys are kept per test file.
- Verified by tests against plain node-script runners; it has not been benchmarked with a real vitest install.
