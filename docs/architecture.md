# Architecture

```
cli.ts ──► Project (config + FileIndex + Cache + graph)
              │
              ├─ config.ts     strict schema, shell-free command tokenizer
              ├─ fsindex.ts    SHA-256 content index; metadata only as a racy-safe hint
              ├─ graph.ts      import graph, tsconfig paths, workspaces, impact + chains
              ├─ affected.ts   git changes ► test selection (conservative on doubt)
              ├─ cache.ts      CAS blobs + action records, verify/gc/restore
              ├─ scheduler.ts  bounded DAG scheduler (critical path, cancel, fail-skip)
              ├─ fswatch.ts    fs.watch wrapper (recursive / per-directory), raw hints only
              ├─ watch.ts      watch session: debounce, reconcile, cancel, re-run
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

## Watch mode (`--watch`)

`watch.ts` owns one long-lived session; the Project (config, FileIndex, graph) stays in memory and `runTasks` is called once per cycle.

* **Events are hints, content decides.** `fswatch.ts` only reports "something under here may have changed". Each cycle runs `FileIndex.scan()` and diffs content digests against the previous cycle's snapshot, so a missed, duplicated or spurious event can cost time but never produce a stale result. Source changes (task outputs excluded) are what get reported as `changed`; a scan that finds none starts no cycle.
* **Watcher backends.** Windows/macOS: one native recursive `fs.watch`. Linux: Node's recursive `fs.watch` is a userland emulation that watches every directory including `node_modules` and `.git`, so we register one non-recursive watcher per directory instead, skipping ignored trees and adding watchers for new directories. `per-directory` is also selectable on any platform (used by the tests).
* **Debounce.** Leading + trailing: the first event after idle triggers immediately (no added latency); events inside the quiet window (default 50 ms) coalesce into one trailing trigger.
* **Recovery.** A periodic reconciliation scan (default 30 s) catches dropped events. Any watcher error (inotify overflow/limits, handle loss) triggers an immediate forced rehash scan and degrades the period to 2 s. Metadata (mtime/size/inode) is only used as the existing racy-safe hint inside `scan`.
* **No self-triggering.** Events under `.git`, `node_modules`, `.buildrush`, config `ignore` globs and any task's declared `outputs` are dropped, and output files are excluded from the change set. Files a task writes that are *not* declared as outputs or ignored will show up as changes; they only cause one extra all-cached cycle if their content is stable, so declare them or add them to `ignore`.
* **Cancellation.** If an event arrives mid-run, a side-scan (a separate FileIndex, so the engine's index is untouched) checks whether a source file really changed; if so the run's AbortSignal fires. Cancelled tasks are never cached and the cycle is reported as `superseded`. The engine's existing post-run input check still refuses to cache results whose inputs changed during execution.
* **Config.** A change to `buildrush.json` or any `package.json` re-opens the Project (adapters re-resolved). A config that fails to load is reported and nothing runs until the next change.
* **Shutdown.** Ctrl+C aborts in-flight tasks, closes watchers and exits 0; a second Ctrl+C force-quits.
* **`--affected` in watch mode** keeps its one-shot meaning (changes relative to git `--since`, default HEAD); the module graph is rebuilt from the refreshed index each cycle. Unchanged tasks are still `[cached]` through their fingerprints.

## Design decisions

* **TypeScript on Node, zero runtime deps.** Smallest audit surface, runs where the target ecosystem already is, and avoids a second toolchain for contributors. A Rust/Go core remains possible behind the same on-disk formats if profiling shows Node is the bottleneck; we will not guess before measuring.
* **No daemon yet.** A daemon adds an IPC attack surface and crash/stale-state handling; the persisted file index already makes warm runs cheap (~0.2 s for BuildRush's own pipeline). `--watch` keeps state in the foreground process instead. A daemon (so separate invocations share warm state) remains to do, with peer-credential-checked Unix sockets / named pipes.
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
