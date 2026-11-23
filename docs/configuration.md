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
      "affected": false                 // test tasks: receive selected test files under --affected (default true for kind "test")
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
`optionalDependencies`; any declared range counts, `workspace:*` or not;
`peerDependencies` are not ordering edges).

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
`pnpm-workspace.yaml`, `.npmrc`, `.yarnrc[.yml]`, `.nvmrc`, `.node-version` and
root `tsconfig*.json`. Changing any of them invalidates **every** package task.
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
