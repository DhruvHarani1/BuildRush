# Governance

BuildRush is currently led by its founder-maintainer, with the goal of moving
to a multi-maintainer model as soon as there are regular contributors.

* **Maintainers** merge changes, cut releases and handle security reports.
  Becoming a maintainer: sustained, high-quality contributions plus an
  invitation from existing maintainers. Inactive maintainers (12 months) move to
  emeritus status.
* **Decisions** are made by lazy consensus in public issues/PRs. Changes that
  affect cache correctness, the security model, the config schema or the CLI
  surface need a written rationale (an ADR in `docs/adr/`) and review from a
  maintainer who did not author the change.
* **Releases** follow semver once 1.0 ships. Until then, minor versions may
  contain breaking changes; each is called out in the CHANGELOG.
* **Security** reports follow SECURITY.md and are never discussed publicly
  before a fix is available.
* **Trademark / name**: the maintainers will register and document usage
  guidelines for the BuildRush name before wide distribution (see
  docs/MAINTAINER_CHECKLIST.md).
