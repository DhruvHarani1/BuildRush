# Contributing to BuildRush

Thanks for helping! The bar is **correctness first**: a false cache hit is a bug,
not a performance win.

## Setup

```bash
git clone https://github.com/DhruvHarani1/BuildRush && cd BuildRush
npm ci            # lifecycle scripts are disabled by .npmrc
npm test          # builds and runs the full suite (Node >= 22)
node bin/buildrush.js run   # dogfood: BuildRush builds and tests itself
```

## Ground rules

* **No new runtime dependencies** without a maintainer-approved ADR. The engine
  has zero today; that is a deliberate security and startup-time property.
* **No shell.** Subprocesses use `spawn`/`execFile` with an argv array.
* **Every cache-key, restore or path-handling change needs a test** that tries
  to break it (see `test/cache.test.ts`, `test/engine.test.ts`).
* Conservative on uncertainty: if the graph cannot prove something is
  unaffected, select it.
* Docs change with behaviour. Update `docs/` and `CHANGELOG.md` in the same PR.
* Never include secrets, real tokens or customer data in tests or fixtures.

## Pull requests

Small, focused PRs with a description of *why*. CI (typecheck, tests on Linux,
macOS and Windows, CodeQL, dependency review) must pass. Sign off commits with
`git commit -s` (Developer Certificate of Origin, <https://developercertificate.org>);
by doing so you certify you may submit the work under the project's MIT license.

## Reporting bugs / security issues

Bugs: use the issue templates. Security: **never** a public issue; see SECURITY.md.
