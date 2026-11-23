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
  "pipelines": { "default": ["typecheck", "build"] },
  "workspaces": null                    // null/omitted = auto-detect; false = off; ["packages/*", "!packages/legacy"] = explicit globs
}
```

**Inputs and other tasks' outputs.** A task never sees another task's declared `outputs` as inputs unless it (transitively) `dependsOn` that task.

Globs: `**`, `*`, `?`, `{a,b}`; a trailing `/` means "everything beneath".
Patterns must be project-relative and may not contain `..`.

## Workspaces (monorepos)

BuildRush detects npm, yarn and bun workspaces (`workspaces` array or
`{ "packages": [...] }` in the root `package.json`) and pnpm workspaces
(`pnpm-workspace.yaml`, simple `packages:` list: block or single-line flow
style, quotes, comments and `!negation`; anchors and multi-line flow lists are
not parsed, use the `workspaces` key above for those). Package globs are
resolved to directories with a `package.json` that has a `name`; the root is not
a package, `node_modules` and symlinks are never followed, duplicate names are
an error. Each package records its name, version and which other workspace
packages it depends on (`dependencies`, `devDependencies`,
`optionalDependencies`; any declared range counts, `workspace:*` or not).
`peerDependencies` on another workspace package are also ordering edges (every
package manager links them, and the package compiles against that package's
output), except a peer edge that would close a cycle with declared dependencies:
that one is dropped with a warning instead of becoming a cycle error (plugin /
host pairs). As in pnpm, a trailing `/**` in a package glob also matches the
directory itself (`docs/**` includes `docs/package.json`).

A task with `"scope": "packages"` is a **template**: it is expanded into one
task per package, named `<package>:<task>` (e.g. `@acme/core:build`).

```jsonc
"tasks": {
  "build": {
    "scope": "packages",
    "packages": ["@acme/*"],            // optional: package-name globs; default every package
    "command": "tsc -p .",              // runs with the package directory as cwd
    "inputs": ["src/**", "tsconfig.json"],   // relative to the package
    "outputs": ["dist/**"],             // relative to the package
    "rootInputs": ["scripts/**"],       // optional: project-relative files OUTSIDE the package that every instance also hashes
    "dependsOn": ["^build"]             // "^build": build of this package's workspace dependencies
  },
  "test": { "scope": "packages", "kind": "test", "adapter": "vitest", "dependsOn": ["build"] }  // "build": this package's build
},
"pipelines": { "default": ["build", "test"] }
```

* `buildrush run build` runs every instance; `buildrush run @acme/core:build` runs one (plus what it depends on). Pipelines and root tasks may name a template and get all its instances.
* `dependsOn` in a package task: `"x"` = the same package's `x` (if `x` is a package task; error if the `packages` filter excludes it there) or the root task `x`; `"^x"` = `x` in each workspace dependency, skipping through dependency packages that do not run `x` so ordering still follows the package graph. `^` is only valid between package tasks. A package dependency cycle is a config error naming the cycle (`workspace package dependency cycle: a -> b -> a`) whenever a `^` dependency is used.
* `cwd` is not allowed on package tasks (every instance runs in its package directory). `inputs`/`outputs` globs are package-relative and cannot contain `..`.
* Everything else (`env`, `cache`, `kind`, `cpu`, `adapter`, ...) applies per instance, and each instance has its own fingerprint, cache entry and outputs.
* A package task with `scope: "packages"` and no workspace is an error.

**What a package task's fingerprint covers.** Its command, env, toolchain,
fingerprints of its `dependsOn` instances (so a change in package B invalidates
everything downstream that depends on B's task), and its input files:

| `inputs` | Files hashed |
| --- | --- |
| declared | those globs in the package, the package's `package.json`, and the root-shared files |
| omitted (no adapter) | the whole package, **all transitive workspace dependency packages' directories**, and the root-shared files |
| omitted (adapter) | the adapter's inputs for the package, the dependency packages' directories, and the root-shared files; if the adapter cannot bound its inputs the whole project is hashed |

Root-shared files: root `package.json`, every lockfile (`package-lock.json`,
`npm-shrinkwrap.json`, `pnpm-lock.yaml`, `yarn.lock`, `bun.lock[b]`),
`pnpm-workspace.yaml`, `.npmrc`, `.yarnrc[.yml]`, `.nvmrc`, `.node-version`,
root `tsconfig*.json` and root tool configs (`vitest.config.*`,
`vitest.workspace.*`, `vite.config.*`, `jest.config.*`, `jest.*.config.*`,
`eslint.config.*`, `.eslintrc*`, `babel.config.*`, `.babelrc[.*]`,
`rollup.config.*`, `tsup.config.*`, `webpack.config.*`, `esbuild.config.*`).
Changing any of them invalidates **every** package task. Anything else outside
the packages that a task reads (a shared `scripts/` directory, a JSON file a root
config loads, a config helper it imports) is **not** tracked automatically:
list it in the task's `rootInputs`, otherwise editing it does not re-run the
package tasks that declared their own `inputs`.
Another task's outputs are still never inputs unless depended on.

**`--affected` in a workspace.** Selected packages = packages containing changed
files, packages whose modules (transitively) import changed code, and every
package that depends on those through `package.json` dependencies or imports
observed in the module graph. Only those packages' tasks are scheduled; tasks of
unaffected packages that a selected task depends on (`^build`) are still pulled
in and normally come from the cache. Test tasks additionally receive only the
selected test files located in their own package. Everything is selected
(reason reported) when a root-shared file, `buildrush.json` or global config
changes, when git cannot be queried, or when a changed module has uncertain
dependencies. A change to a package's own `package.json` is scoped to that
package and its dependents instead of selecting everything.

**Imports of workspace packages** (`import "@acme/core"`) resolve into the
package's sources: every file named by `exports` (conditions and `*` subpath
patterns), `main`, `module`, `types` that exists, with build-output directories
(`dist/`, `lib/`, `build/`, `out/`, ...) also mapped to `src/` and `.js`
mapped to `.ts`; failing that `src/index`, `index`, `lib/index`. An import of a
workspace package that cannot be resolved is recorded as uncertain and handled
conservatively (see rules below).

### Validated on real repositories, and known limitations

Workspace support was run (Windows, Node 24, shallow clones, installs with
`--ignore-scripts`, tasks limited to tools already installed in the clone) on
three open-source monorepos: **mobxjs/mobx** (npm `workspaces`, 6 packages,
`exports` maps, `dist` -> `src`), **preactjs/signals** (pnpm, 15 packages incl.
nested packages `packages/preact/utils`, root tsconfig `paths`) and
**TanStack/store** (pnpm, `packages/**` globs, 45 packages incl. examples,
`exports` + `workspace:*`/`catalog:`). In each, the package list and
dependency edges matched the package manager's own view (`pnpm ls -r`, or the
package.json files for npm) once the bugs below were fixed, module-to-package
ownership and cross-package import resolution (including `dist` -> `src` and
tsconfig `paths`) were correct on every edge inspected, a one-file edit in a leaf
package re-ran exactly that package's tasks plus tasks of dependents, and
`--affected` selected the expected packages. Not validated: TypeScript project
references (`tsc -b`; none of the three repos uses them), yarn berry/bun
layouts, Linux/macOS. Bugs found and fixed: `docs/**` did not match `docs/`
itself; workspace `peerDependencies` were not ordering edges; root tool configs
(`vitest.config.*` etc.) and shared root scripts were not fingerprinted by
package tasks with declared `inputs` (new `rootInputs`); vitest coverage enabled
in the config was not captured as an output.

Known limitations (not fixed):

* **Package tasks always run in the package directory.** Tools whose config assumes the repo root as cwd (signals' root `vitest.config.mjs` reads `./mangle.json`) fail; run them through the package manager, e.g. `pnpm -C ../.. exec vitest run packages/core/test`. There is no `$PACKAGE` substitution in commands, so a root config that selects tests by path needs one task template per package (use `packages` filters).
* **`--affected` over-selects.** Imports in test fixtures/strings (mobx-undecorate "imports" mobx-react only inside test sources), `import type`, and import cycles all create package edges (editing `packages/preact/src/index.ts` in signals selected 12 of 15 packages because a type-only import closes a cycle through `debug`). Over-selection costs time, never correctness.
* **Without declared `inputs`, tasks hash the dependency packages' whole directories** (including their build output), so a comment-only edit in a core package re-runs every dependent package's typecheck.
* **Files outside the packages that a task reads** (shared scripts, files a root config imports) are tracked only if listed in `rootInputs`.
* **Restoring cached outputs copies them**: on Windows a fully cached run of three `dist/` directories took several seconds in TanStack/store.
* A tool that rewrites a tracked input during a task (pnpm 11 modified `pnpm-lock.yaml` while the TanStack/store tasks ran) is detected (`inputs changed during execution; result not cached`) but it makes that task, and then everything downstream, re-run each time.

## Commands

| Command | Purpose |
| --- | --- |
| `buildrush init [--force]` | Generate a starter config from detected tools (fails if nothing is detected) |
| `buildrush analyze [--json]` | Project summary, module graph stats, cycles, uncertain modules; workspace packages and their edges |
| `buildrush graph [--dot\|--packages]` | Module dependency graph; in a workspace also packages (`--packages`: package graph only, declared and import edges) |
| `buildrush run [task\|pipeline...]` | Run with caching (default pipeline `default`) |
| `buildrush build\|test\|check` | Run the task/pipeline with that name |
| `--affected [--since <ref>]` | Select tests affected by changes vs a git ref (default `HEAD`, includes untracked); in a workspace also selects packages |
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
- Verified by tests against plain node-script runners, and benchmarked with real vitest on a Linux CI runner (issue #10): a narrow one-file edit took 3.7 s for the full pipeline vs 15.1 s for a native parallel script; a wide edit (every test affected) gave no speedup. Numbers are from a shared runner, n=7.
