# Security model

> BuildRush is **not a sandbox**. It runs commands from your project's
> configuration as your OS user. Treat `buildrush.json` like a `Makefile`.

## Trust model

| Party | Trusted? | Notes |
| --- | --- | --- |
| The user running `buildrush` | yes | |
| `buildrush.json` and project sources | **as trusted as the repo** | Running BuildRush on a repo you do not trust executes its commands. Review config first, or use a container/VM. |
| Tools resolved from `node_modules/.bin` / `PATH` | as trusted as your environment | |
| The local cache directory | trusted **only against accidental damage** | Entries are not signed. An attacker who can already write to your cache as your user can also edit your sources and tools. Shared/remote caches will require signed entries (roadmap). |
| Cache contents on restore | **verified** | Digest-checked, path-validated, symlink-checked, permission-masked (see below). |
| Child process output | untrusted data | Redacted, size-capped, never executed. |

There is **no daemon, no network listener and no IPC surface** in this version:
every command is a one-shot process. BuildRush makes no network requests and
sends no telemetry.

## Controls implemented (and where they are tested)

| Threat | Control | Test |
| --- | --- | --- |
| Shell injection via config | Commands are argv arrays; the string form is tokenised without a shell and any unquoted metacharacter (`; & \| > < $ \` * ...`) is rejected | `glob-config.test.ts` |
| Option injection into `git` | `--since` refs starting with `-` are refused; `--` separates refs from paths; `execFile`, no shell | `engine.test.ts` |
| Env leakage to tasks | Child env is an allow-list (`PATH`, `HOME`, `TMPDIR`...) plus names declared in `env`/`passEnv`; `BUILDRUSH_*` is never passed | `engine.test.ts` (secrets) |
| Secrets in logs | Values of secret-named vars (`*TOKEN*`, `*SECRET*`, `*PASSWORD*`, `*KEY*`...) are redacted from captured output | `engine.test.ts` |
| Secrets in cache metadata | Env values are stored only as digests; secret-named vars use HMAC-SHA-256 with a per-cache random key (mode 0600), so low-entropy secrets cannot be brute-forced from metadata | `engine.test.ts` (greps the whole `.buildrush` tree) |
| Path traversal on restore | Manifest paths must be relative, normalised, free of `..`, backslashes, NUL, drive letters; re-validated at lookup **and** restore | `cache.test.ts` |
| Symlink escape on restore | Every existing path component is `lstat`ed; restore refuses to write through any symlink; symlinked outputs are never cached; symlinks in the project are never followed or indexed | `cache.test.ts`, `graph.test.ts` |
| Privilege escalation via restored files | Only the `0777` permission bits are stored/restored; setuid/setgid/sticky are dropped | `cache.test.ts` |
| Corrupt / tampered blobs | Blobs are named by SHA-256 and re-hashed **before the first byte is written** on restore (no half-restored trees); `cache verify --repair` | `cache.test.ts`, `engine.test.ts` |
| Cache poisoning by racing writers | Content-addressed immutable blobs; writes are temp-file + `rename`; the file is re-hashed after copy so mislabelled content is never stored | `cache.test.ts` |
| Caching a wrong result | Failed/cancelled/timed-out runs are never cached; inputs are re-scanned after the run and any change makes the result uncacheable | `engine.test.ts` |
| Cache dir exposure | Directory `0700`, blobs/entries `0600`; `doctor` warns on loose permissions | `cli.test.ts` |
| Resource exhaustion | Bounded scheduler; 8 MiB log cap per task; 8 MiB cap on entry metadata; optional per-task timeout; LRU size cap | `scheduler.test.ts` |
| Orphaned processes | Tasks run in their own process group; cancellation sends SIGTERM then SIGKILL after 5 s | `engine.test.ts` |
| Running as root | `doctor` warns | `doctor` |
| Supply chain | **Zero runtime dependencies**; `.npmrc` disables lifecycle scripts; locked dev deps; Dependabot; dependency review; npm provenance; SBOM on release | CI |

## Known limitations (read these)

1. **Same-user attacker**: not defended against (see trust model).
2. **TOCTOU between blob verification and copy during restore.** Requires an
   attacker able to modify the cache concurrently; same-user only.
3. **Log redaction is best-effort**: it matches exact secret values. Encoded or
   transformed secrets (base64, split across lines) are not detected.
4. **`PATH` is passed but not fingerprinted.** The *resolved executable* is
   fingerprinted (content digest, or `node:<version>`); binaries over 64 MiB use
   size+mtime.
5. **Undeclared inputs** (files a task reads but that are not in `inputs`) are
   invisible. The default (`inputs` omitted) hashes the whole project to stay
   safe. See [cache-correctness.md](cache-correctness.md).
6. **Windows** is untested. `.cmd` shims cannot be spawned without a shell, so
   npm-installed tools may not resolve; BuildRush will not fall back to a shell.
7. **Remote/shared cache** does not exist yet and must not be bolted on without
   signed manifests, tenant isolation and authenticated transport (design notes
   in ROADMAP.md).

## Release & supply-chain controls

* GitHub Actions: least-privilege `permissions`, `persist-credentials: false`,
  concurrency control, Dependabot for Actions, CodeQL, OpenSSF Scorecard,
  dependency review on PRs.
* Releases are built in CI from a tag, published to npm with `--provenance`
  (OIDC-attested build), with a CycloneDX SBOM attached to the GitHub release
  and a container image published with provenance and SBOM attestations.
* Maintainers must enable the repository settings in
  [MAINTAINER_CHECKLIST.md](MAINTAINER_CHECKLIST.md) (branch protection, 2FA,
  private vulnerability reporting, secret scanning). Code cannot do that for you.
* **Action pinning**: workflows reference actions by version tag. Before the
  first release, pin them to full commit SHAs (Dependabot then keeps SHAs
  current). We deliberately did not hand-write SHAs we could not verify.
