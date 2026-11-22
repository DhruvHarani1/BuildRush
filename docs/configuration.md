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
