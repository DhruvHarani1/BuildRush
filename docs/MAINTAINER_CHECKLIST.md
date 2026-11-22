# Maintainer checklist (things code cannot do for you)

Do these once, on GitHub, before promoting the project. Several are required
for the OpenSSF Scorecard checks in `.github/workflows/scorecard.yml` to pass.

**Account & repository**
- [ ] Enable 2FA (prefer hardware keys / passkeys) for every maintainer; require it for the org if one is created.
- [ ] Settings ▸ Code security: enable **private vulnerability reporting**, **Dependabot alerts + security updates**, **secret scanning + push protection**, **code scanning (CodeQL)**.
- [ ] Settings ▸ Branches: protect `main`: require PR + 1 approval (CODEOWNERS), require status checks (`CI`, `CodeQL`, `dependency-review`), require linear history, block force-push and deletion, require signed commits (optional but recommended), dismiss stale approvals.
- [ ] Settings ▸ Actions ▸ General: default workflow token = **read-only**; require approval for workflows from first-time contributors; allow only GitHub-owned + pinned third-party actions.
- [ ] Create a protected **`release` environment** with required reviewers (used by `release.yml`).
- [ ] Add repo topics, a description, and enable Discussions.

**Publishing**
- [ ] Reserve the npm name `buildrush`; configure npm **trusted publishing (OIDC)** for this repo/workflow, or add an automation-scoped `NPM_TOKEN` secret to the `release` environment only.
- [ ] Decide the container registry (workflow targets `ghcr.io/dhruvharani1/buildrush`).
- [ ] Pin every action in `.github/workflows` to a full commit SHA (`npx pin-github-action .github/workflows/*.yml` or let Dependabot do it) **before the first release**.
- [ ] Pin the Dockerfile base image by digest (`docker buildx imagetools inspect node:22-slim`).

**Project health**
- [ ] Confirm the license choice (MIT is in `LICENSE`; Apache-2.0 adds an explicit patent grant and may suit a tool aimed at large companies). Change it **before** accepting outside contributions.
- [ ] Check trademark availability for "BuildRush" and the domain / npm scope you want.
- [ ] Add a `SECURITY` contact alias if you want email in addition to advisories.
- [ ] Recruit a second maintainer so security fixes and releases do not depend on one person.
