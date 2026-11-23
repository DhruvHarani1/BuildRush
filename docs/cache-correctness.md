# Cache correctness & hermeticity

A cache is only correct if every meaningful input is part of the key.
**A false cache hit is a correctness bug.**

## What is in a task's fingerprint

`key = SHA-256(canonical JSON of)`:

* task name, argv (including `--affected` file arguments), working directory, declared output globs
* SHA-256 of every input file's content (never mtime)
* the final fingerprints of every `dependsOn` task
* every variable listed in `env` (digest of `NAME=value`; HMAC for secret-like names; `null` if unset)
* Node version, platform, architecture
* digest of the resolved executable (`node:<version>` for Node itself)

Everything above is stored in the entry as **digests only**, which is what lets
`buildrush explain` say *"input changed: src/a.ts"* or *"environment variable X
changed"* instead of just "cache miss".

## What BuildRush pins for you

Child processes get `TZ=UTC`, `LANG=C.UTF-8`, `NO_COLOR=1`, `FORCE_COLOR=0`
unless you list those names in `env`/`passEnv`. Other environment variables are
**not inherited** unless declared.

## What is NOT captured (you must account for it)

| Gap | Mitigation |
| --- | --- |
| Files the task reads but you did not list in `inputs` | Omit `inputs` (hash everything) or list them; always include the lockfile and tool configs |
| Tool internals beyond the executable file (plugins, `node_modules` contents) | Include the lockfile in `inputs` |
| Network, wall-clock time, randomness, external services | `"cache": false` for that task |
| `passEnv` variables | Not fingerprinted by design; prefer `env` |
| `PATH` contents | Resolved executable is fingerprinted instead |

## When a result is not cached (and why you are told)

* the task failed, timed out or was cancelled
* an input changed **during** the run (re-scanned after exit)
* a declared output matched no files, or is a symlink
* `cache: false` or `--no-cache`
* an output copy changed between hashing and storing

## Restore semantics

All blobs are verified before the first write; each file is written to a temp
name and renamed into place; outputs recorded by the previous successful run
that are not part of the restored set are removed. Corrupt entries are
discarded and the task is simply re-run.

## State vs input vs output

* **Input**: contributes to the fingerprint (file contents, env, tool versions, dependency fingerprints).
* **Output**: declared, captured after success, stored in the cache, restored on a hit.
* **State**: persists between runs under `.buildrush/state/`, is **neither** of the above.
  It may only make a cache *miss* faster; removing it must never change a result.
  Example: the `tsc` adapter's `.tsbuildinfo` (see [adapters.md](adapters.md#tsc-incremental-mode-state-not-input-not-output)).
  A tool is only given state if it validates the state itself AND BuildRush drops it on
  tool-version/config/command change, on corruption, and after any non-successful run.
  State is written to a work copy and committed by atomic rename only on success.

## Limits of incremental builds

Cached units are **whole tasks**. A one-line edit to a file listed in a build
task's inputs re-runs that task (the underlying tool may still be incremental internally; for `tsc --noEmit` BuildRush manages that state itself, see above). Finer granularity (per-package,
per-module) comes from workspace-aware task splitting and tool adapters; it is
roadmap work, not a claim of this version. Final bundles are never patched
in place.
