#!/usr/bin/env bash

set -euo pipefail

ROOT_DIR="$(git rev-parse --show-toplevel 2>/dev/null || true)"

if [[ -z "$ROOT_DIR" ]]; then
  echo "Run this script from inside the git repository." >&2
  exit 1
fi

cd "$ROOT_DIR"

if [[ -f "$ROOT_DIR/.release.env" ]]; then
  set -a
  # shellcheck disable=SC1091
  source "$ROOT_DIR/.release.env"
  set +a
fi

RELEASE_REMOTE="${RELEASE_REMOTE:-origin}"
RELEASE_BRANCH="${RELEASE_BRANCH:-main}"
DEPLOY_WORKFLOW="${DEPLOY_WORKFLOW:-deploy.yml}"
DEPLOY_SCOPE="${DEPLOY_SCOPE:-auto}"
DEPLOY_WAIT_TIMEOUT_SECONDS="${DEPLOY_WAIT_TIMEOUT_SECONDS:-5400}"
DEPLOY_POLL_INTERVAL_SECONDS="${DEPLOY_POLL_INTERVAL_SECONDS:-5}"
SMOKE_TIMEOUT_SECONDS="${SMOKE_TIMEOUT_SECONDS:-20}"
PROD_FRONTEND_URL="${PROD_FRONTEND_URL:-}"
PROD_API_HEALTH_URL="${PROD_API_HEALTH_URL:-}"

MESSAGE=""
STAGE_ALL="false"
RUN_SMOKE="true"
declare -a FILES=()

usage() {
  cat <<'EOF'
Usage:
  scripts/release-prod.sh --message "commit message" [--scope auto|frontend|backend|full] [--all] [--no-smoke] [--] [paths...]

Examples:
  scripts/release-prod.sh --message "Improve Zerodha onboarding" frontend/app/console/zerodha/page.tsx frontend/app/zerodha/callback/page.tsx
  scripts/release-prod.sh --message "Ship all local changes" --all

Behavior:
  - Stages the provided paths, or all files with --all, or uses already-staged files.
  - Creates a commit and pushes to origin/main by default.
  - Lets the push workflow detect the production deployment scope.
  - An explicit --scope adds a commit directive that is safely combined with
    detected changes, so it can broaden but never mask the required scope.
  - Waits for that push-triggered deploy to finish and optionally runs smoke checks.
  - Manual workflow dispatch still supports auto, frontend, backend, and full.
EOF
}

print_pr_release_hint() {
  cat >&2 <<EOF
If you're working from a Codex/browser task environment or any non-$RELEASE_BRANCH checkout,
use the PR release path instead:
  1. Commit the task branch.
  2. Open a PR.
  3. Merge into $RELEASE_BRANCH.
  4. Monitor the deploy triggered by the push to $RELEASE_BRANCH in GitHub Actions.
EOF
}

require_command() {
  local name="$1"
  if ! command -v "$name" >/dev/null 2>&1; then
    echo "Required command not found: $name" >&2
    if [[ "$name" == "gh" ]]; then
      echo "This script needs GitHub CLI to dispatch and monitor the production workflow." >&2
      print_pr_release_hint
    fi
    exit 1
  fi
}

derive_repo_slug() {
  local remote_url
  remote_url="$(git remote get-url "$RELEASE_REMOTE")"

  case "$remote_url" in
    git@github.com:*.git)
      printf '%s\n' "${remote_url#git@github.com:}" | sed 's/\.git$//'
      ;;
    git@github.com:*)
      printf '%s\n' "${remote_url#git@github.com:}"
      ;;
    https://github.com/*.git)
      printf '%s\n' "${remote_url#https://github.com/}" | sed 's/\.git$//'
      ;;
    https://github.com/*)
      printf '%s\n' "${remote_url#https://github.com/}"
      ;;
    *)
      echo "Could not derive GitHub repo from remote URL: $remote_url" >&2
      exit 1
      ;;
  esac
}

smoke_check() {
  local label="$1"
  local url="$2"

  echo "==> Smoke check: $label ($url)"
  curl --fail --silent --show-error --location --max-time "$SMOKE_TIMEOUT_SECONDS" "$url" >/dev/null
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -m|--message)
      MESSAGE="${2:-}"
      shift 2
      ;;
    --scope)
      DEPLOY_SCOPE="${2:-}"
      shift 2
      ;;
    --all)
      STAGE_ALL="true"
      shift
      ;;
    --no-smoke)
      RUN_SMOKE="false"
      shift
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    --)
      shift
      FILES+=("$@")
      break
      ;;
    *)
      FILES+=("$1")
      shift
      ;;
  esac
done

if [[ -z "$MESSAGE" ]]; then
  echo "Commit message is required." >&2
  usage >&2
  exit 1
fi

case "$DEPLOY_SCOPE" in
  auto|frontend|full|backend)
    ;;
  *)
    echo "Invalid deploy scope: $DEPLOY_SCOPE" >&2
    exit 1
    ;;
esac

require_command git
require_command curl

CURRENT_BRANCH="$(git branch --show-current)"
if [[ "$CURRENT_BRANCH" != "$RELEASE_BRANCH" ]]; then
  echo "Current branch is '$CURRENT_BRANCH'. Switch to '$RELEASE_BRANCH' before releasing." >&2
  print_pr_release_hint
  exit 1
fi

require_command gh

if ! gh auth status >/dev/null 2>&1; then
  echo "GitHub CLI is not authenticated. Run: gh auth login" >&2
  print_pr_release_hint
  exit 1
fi

if [[ "$STAGE_ALL" == "true" ]]; then
  echo "==> Staging all local changes"
  git add -A
elif [[ "${#FILES[@]}" -gt 0 ]]; then
  echo "==> Staging selected files"
  git add -- "${FILES[@]}"
else
  echo "==> Using already-staged changes"
fi

if git diff --cached --quiet; then
  echo "No staged changes found. Pass file paths, use --all, or stage files first." >&2
  exit 1
fi

REPO_SLUG="$(derive_repo_slug)"

echo "==> Commit staged changes"
if [[ "$DEPLOY_SCOPE" == "auto" ]]; then
  git commit -m "$MESSAGE"
else
  git commit -m "$MESSAGE" -m "[deploy-scope:$DEPLOY_SCOPE]"
fi

HEAD_SHA="$(git rev-parse HEAD)"

echo "==> Push commit $HEAD_SHA to $RELEASE_REMOTE/$RELEASE_BRANCH"
git push "$RELEASE_REMOTE" "$RELEASE_BRANCH"

if [[ "$DEPLOY_SCOPE" != "auto" ]]; then
  echo "==> Requested deployment scope: $DEPLOY_SCOPE (combined with detected changes)"
fi

echo "==> Waiting for push-triggered deployment workflow to appear"
RUN_ID=""
START_TIME="$(date +%s)"

while [[ -z "$RUN_ID" ]]; do
  NOW="$(date +%s)"
  if (( NOW - START_TIME > DEPLOY_WAIT_TIMEOUT_SECONDS )); then
    echo "Timed out waiting for workflow run for commit $HEAD_SHA." >&2
    exit 1
  fi

  RUN_ID="$(
    gh run list \
      --repo "$REPO_SLUG" \
      --workflow "$DEPLOY_WORKFLOW" \
      --branch "$RELEASE_BRANCH" \
      --limit 20 \
      --json databaseId,event,headSha \
      --jq "map(select(.headSha == \"$HEAD_SHA\" and .event == \"push\"))[0].databaseId"
  )"

  if [[ -z "$RUN_ID" || "$RUN_ID" == "null" ]]; then
    RUN_ID=""
    sleep "$DEPLOY_POLL_INTERVAL_SECONDS"
  fi
done

RUN_URL="$(
  gh run view "$RUN_ID" \
    --repo "$REPO_SLUG" \
    --json url \
    --jq '.url'
)"

echo "==> Watching deploy run $RUN_ID"
if ! gh run watch "$RUN_ID" --repo "$REPO_SLUG" --interval "$DEPLOY_POLL_INTERVAL_SECONDS" --exit-status; then
  echo "==> Deploy failed. Fetching failed logs." >&2
  gh run view "$RUN_ID" --repo "$REPO_SLUG" --log-failed || true
  exit 1
fi

if [[ "$RUN_SMOKE" == "true" ]]; then
  if [[ -n "$PROD_FRONTEND_URL" ]]; then
    smoke_check "frontend" "$PROD_FRONTEND_URL"
  fi

  if [[ -n "$PROD_API_HEALTH_URL" ]]; then
    smoke_check "api health" "$PROD_API_HEALTH_URL"
  fi
fi

echo "==> Release complete"
echo "Commit: $HEAD_SHA"
echo "Workflow: $RUN_URL"
if [[ -n "$PROD_FRONTEND_URL" ]]; then
  echo "Frontend: $PROD_FRONTEND_URL"
fi
if [[ -n "$PROD_API_HEALTH_URL" ]]; then
  echo "API health: $PROD_API_HEALTH_URL"
fi
