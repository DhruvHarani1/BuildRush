# Architecture

```
cli.ts ──► Project (config + FileIndex + Cache + graph)
              │
              ├─ config.ts     strict schema, shell-free command tokenizer
              ├─ fsindex.ts    SHA-256 content index; metadata only as a racy-safe hint
              ├─ graph.ts      import graph, tsconfig paths, workspaces, impact + chains
              ├─ workspaces.ts workspace detection, per-package task expansion, package impact
              ├─ affected.ts   git changes ► test selection (conservative on doubt)
              ├─ cache.ts      CAS blobs + action records, verify/gc/restore
              ├─ scheduler.ts  bounded DAG scheduler (critical path, cancel, fail-skip)
              ├─ runner.ts     spawn (no shell), env allow-list, redaction, kill group
              └─ engine.ts     fingerprint ► lookup ► run ► validate ► commit; explanations
```

State lives in `.buildrush/` (git-ignored): `cache/` (blobs, actions, tmp),
`state/` (file index, import-scan cache keyed by content digest, previous graph,
last-run report, per-task last-good components, duration history, stats).

## Data flow for one task

1. Rescan the index if an earlier task produced files (hint-based; content is re-hashed when metadata is untrustworthy).
2. Resolve inputs, compute components and fingerprint (dependency fingerprints first).
3. Cache lookup: validate record shape and every path; verify all blobs; restore atomically ► `cached`.
4. Otherwise explain the miss (diff against the last successful components), spawn the command.
5. On exit 0: capture declared outputs (refusing symlinks / empty matches), rescan inputs, and only if unchanged commit blobs then the action record (record last, so a crash never leaves a record pointing at missing blobs).

## Workspaces

`Project.open` runs `discoverWorkspaces` (package.json `workspaces`,
`pnpm-workspace.yaml`, or `workspaces` globs in buildrush.json) and then
`expandWorkspaceTasks`, which replaces every `scope: "packages"` task template
in `config.tasks` with one ordinary task per package (`<pkg>:<task>`, `cwd` =
package dir, `dependsOn` resolved through the package graph). After adapters have
filled in commands/inputs/outputs, `finalizePackageTasks` makes globs
project-relative and adds the implicit inputs. From that point the engine,
scheduler and cache see plain tasks: the per-package behaviour (separate
fingerprints, dependency fingerprints as components, per-instance outputs) is
the existing task machinery, not a second code path. `Project.taskGroups` maps a
template name to its instance ids so `run build` and pipelines fan out.

`graph.ts` receives the workspace so imports of package names follow
`package.json` entry points onto sources, modules carry their package, and a
package-level `package.json` change is scoped to its package. `--affected` first
selects packages (`selectPackages`: changed files, reached modules, reverse
package edges from manifests and observed imports), schedules only those
packages' tasks (dependencies come in through `closure()`), and filters test
selection per package.

## Design decisions

* **TypeScript on Node, zero runtime deps.** Smallest audit surface, runs where the target ecosystem already is, and avoids a second toolchain for contributors. A Rust/Go core remains possible behind the same on-disk formats if profiling shows Node is the bottleneck; we will not guess before measuring.
* **One-shot, no daemon yet.** A daemon adds an IPC attack surface and crash/stale-state handling; the persisted file index already makes warm runs cheap (~0.2 s for BuildRush's own pipeline). We will add one only when watch mode needs it, with peer-credential-checked Unix sockets / named pipes.
* **Whole-task cache granularity** (see cache-correctness.md).
* **JSON config**, to avoid a YAML dependency and ambiguity.

## Prior art we learned from

| System | Borrowed | Where we differ (today) |
| --- | --- | --- |
| Bazel / Buck2 | content-addressed action cache, explicit inputs/outputs, hermeticity mindset, remote-cache-ready key design | no sandboxing; adopts existing tools as-is |
| Nx / Turborepo | task graph + input hashing, affected computation, cache restore + log replay | graph is import-level, not just package-level; explains every decision |
| Gradle build cache | up-to-date checks, output capture/restore, "why did it run" | no daemon yet |
| ccache / sccache | CAS storage, LRU eviction, integrity verification | task-level not compiler-level |
| Vitest `--related`, Jest `--findRelatedTests` | reverse-import test selection | conservative fallbacks are explicit and reported |

We make **no claim** of being faster than these tools. Benchmarks against them
on documented workloads are roadmap item M4/M7; see ROADMAP.md.
