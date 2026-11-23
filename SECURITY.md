# Security Policy

BuildRush executes commands defined by a project's configuration and manages a
cache that is later written back into the working tree. Both are security
sensitive, so we treat reports seriously. See [docs/security.md](docs/security.md)
for the trust model, the controls we implement, and the known limits.

## Reporting a vulnerability

**Do not open a public issue for a security problem.**

Use GitHub's private vulnerability reporting:
<https://github.com/DhruvHarani1/BuildRush/security/advisories/new>

Please include the BuildRush version (`buildrush --version`), Node version and
OS, a minimal reproduction (ideally a fixture project), and the impact you
believe it has.

Targets (best effort, maintained by volunteers):

| Step | Target |
| --- | --- |
| Acknowledge the report | 3 business days |
| Initial assessment and severity | 7 days |
| Fix or mitigation for High/Critical | 30 days |
| Public advisory + CVE (where applicable) | on release of the fix |

We credit reporters in the advisory unless you ask us not to. We will not
pursue good-faith research that follows this policy.

## Supported versions

Only the latest minor release receives security fixes while the project is
pre-1.0. After 1.0 the latest two minor lines will be supported.

## In scope

* Cache poisoning / false cache hits that reuse a result for different inputs
* Path traversal, symlink or archive-style escapes when restoring cached outputs
* Secret disclosure through logs, cache metadata or child-process environments
* Command or argument injection in BuildRush's own subprocess calls
* Anything that makes BuildRush execute code the project config did not request
* The optional local daemon ([docs/daemon.md](docs/daemon.md)): reaching it, or making it run
  anything, as a different local user or without its token; token/endpoint disclosure to tasks or
  logs; a way to make it serve stale results; a network listener of any kind
* Supply-chain weaknesses in our release pipeline or published artifacts

## Out of scope

* "A malicious `buildrush.json` runs commands." That is the product: the config
  is code, like a Makefile or `package.json` scripts. Do not run BuildRush on
  repositories you do not trust, outside a sandbox. BuildRush is **not** a
  sandbox for hostile code.
* Attacks that require write access to the victim's cache directory or home
  directory as the same OS user (see the trust model for why, and for the
  planned signed-entry design that will cover shared caches).
* Findings in third-party tools BuildRush merely invokes (tsc, vite, vitest ...).
