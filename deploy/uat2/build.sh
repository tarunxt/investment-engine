#!/usr/bin/env bash
# Local/CI build only; does not transfer, deploy, migrate or call AWS.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
test -z "$(git status --porcelain)" || { echo 'Build requires a committed clean checkout' >&2; exit 1; }
SHA="$(git rev-parse HEAD)"
docker build --platform linux/amd64 --build-arg "UAT2_SOURCE_COMMIT=$SHA" -f deploy/uat2/backend.Dockerfile -t "credx-uat2-backend:$SHA" .
docker build --platform linux/amd64 --build-arg "UAT2_SOURCE_COMMIT=$SHA" -f deploy/uat2/frontend.Dockerfile -t "credx-uat2-frontend:$SHA" .
printf 'Built source %s. Publish through the approved transfer route and pin registry digests before deployment.\n' "$SHA"
