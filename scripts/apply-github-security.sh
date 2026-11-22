#!/usr/bin/env bash
# Applies BuildRush's repository security policy to GitHub. Idempotent.
#
#   scripts/apply-github-security.sh            # dry run: prints every API call, changes nothing
#   scripts/apply-github-security.sh --apply    # performs them (needs `gh auth login` as a repo ADMIN)
#
# Env: REPO=owner/name (default: from `gh repo view`), REQUIRE_SIGNED=1 to require signed commits.
set -uo pipefail

APPLY=0; [[ "${1:-}" == "--apply" ]] && APPLY=1
REPO="${REPO:-$(gh repo view --json nameWithOwner -q .nameWithOwner 2>/dev/null || echo DhruvHarani1/BuildRush)}"
BRANCH=main
FAILED=0

call() { # call <METHOD> <path> [json-body]
  local method=$1 path=$2 body=${3:-} url="repos/$REPO${2:+/$2}"
  if (( ! APPLY )); then echo "DRY  $method /$url"; [[ -n $body ]] && echo "$body" | sed 's/^/       /'; return 0; fi
  local out
  if [[ -n $body ]]; then out=$(printf '%s' "$body" | gh api -X "$method" "$url" --input - 2>&1)
  else out=$(gh api -X "$method" "$url" 2>&1); fi
  if [[ $? -eq 0 ]]; then echo "ok   $method $path"; else echo "FAIL $method $path: $(echo "$out" | head -c 300)"; FAILED=$((FAILED+1)); fi
}

echo "Repository: $REPO  ($([[ $APPLY == 1 ]] && echo APPLY || echo DRY RUN))"

# 1. Make sure `main` exists and is the default branch.
if (( APPLY )) && ! gh api "repos/$REPO/branches/$BRANCH" >/dev/null 2>&1; then
  DEFAULT=$(gh api "repos/$REPO" -q .default_branch); SHA=$(gh api "repos/$REPO/branches/$DEFAULT" -q .commit.sha)
  call POST git/refs "{\"ref\":\"refs/heads/$BRANCH\",\"sha\":\"$SHA\"}"
fi
call PATCH "" '{"default_branch":"main","delete_branch_on_merge":true,"allow_squash_merge":true,"allow_merge_commit":false,"allow_rebase_merge":false,"allow_auto_merge":false,"has_wiki":false,"has_projects":false,"web_commit_signoff_required":true,"security_and_analysis":{"secret_scanning":{"status":"enabled"},"secret_scanning_push_protection":{"status":"enabled"}}}'

# 2. Vulnerability handling.
call PUT private-vulnerability-reporting
call PUT vulnerability-alerts
call PUT automated-security-fixes

# 3. Branch protection: nobody (outsiders, bots, contributors) can push to main or merge unreviewed code.
#    enforce_admins=false keeps the sole owner able to merge when no second reviewer exists yet;
#    flip to true once there is a second maintainer.
call PUT "branches/$BRANCH/protection" '{
  "required_status_checks": {"strict": true, "contexts": [
    "test (ubuntu-latest, node 22)", "test (ubuntu-latest, node 24)",
    "test (macos-latest, node 22)", "test (macos-latest, node 24)",
    "audit", "analyze", "review"]},
  "enforce_admins": false,
  "required_pull_request_reviews": {"required_approving_review_count": 1, "require_code_owner_reviews": true,
    "dismiss_stale_reviews": true, "require_last_push_approval": true},
  "restrictions": null,
  "required_linear_history": true,
  "allow_force_pushes": false,
  "allow_deletions": false,
  "required_conversation_resolution": true,
  "block_creations": false
}'
[[ "${REQUIRE_SIGNED:-0}" == 1 ]] && call POST "branches/$BRANCH/protection/required_signatures"

# 4. Release tags are immutable: no deleting, moving or force-pushing v* tags.
call POST rulesets '{"name":"protect-release-tags","target":"tag","enforcement":"active",
  "conditions":{"ref_name":{"include":["refs/tags/v*"],"exclude":[]}},
  "rules":[{"type":"deletion"},{"type":"update"},{"type":"non_fast_forward"}]}'

# 5. Actions: read-only token, no self-approving bots, outside contributors' workflows need approval,
#    only GitHub-owned actions plus the specific third parties we use.
call PUT actions/permissions '{"enabled":true,"allowed_actions":"selected"}'
call PUT actions/permissions/selected-actions '{"github_owned_allowed":true,"verified_allowed":false,
  "patterns_allowed":["ossf/scorecard-action@*","docker/*@*"]}'
call PUT actions/permissions/workflow '{"default_workflow_permissions":"read","can_approve_pull_request_reviews":false}'
call PUT actions/permissions/fork-pr-contributor-approval '{"approval_policy":"all_external_contributors"}'

if (( APPLY )); then
  echo; echo "Done with $FAILED failure(s)."
  echo "Verify in the UI: Settings > Branches, Rules, Actions > General, Code security."
  echo "Still manual (no API): 2FA enforcement, npm trusted publishing, 'release' environment reviewers."
  exit $(( FAILED > 0 ))
else
  echo; echo "Dry run only. Re-run with --apply."
fi
