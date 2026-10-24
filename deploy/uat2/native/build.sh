#!/usr/bin/env bash
# Build on Linux x86_64 with Python3.12/Node22. No secrets, AWS or deployment.
set -euo pipefail
ROOT="$(git rev-parse --show-toplevel)"
cd "$ROOT"
test -z "$(git status --porcelain)" || { echo 'Use a clean committed checkout' >&2; exit 1; }
[[ "$(uname -s)" == Linux && "$(uname -m)" == x86_64 ]] || { echo 'Native artifact build requires Linux x86_64' >&2; exit 1; }
python3 -c 'import sys; assert sys.version_info[:2] == (3,12), "Python3.12 required"'
node -e 'if(process.versions.node.split(".")[0]!=="22") process.exit(1)'
SHA="$(git rev-parse HEAD)"
OUTPUT="${1:?Usage: build.sh /absolute/output-directory}"
[[ "$OUTPUT" == /* ]] && test ! -e "$OUTPUT" || { echo 'Use a new absolute output directory' >&2; exit 1; }
mkdir -p "$OUTPUT/wheels"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
git archive "$SHA" | tar -x -C "$WORK"
python3 -m venv "$WORK/build-venv"
"$WORK/build-venv/bin/pip" wheel --wheel-dir "$OUTPUT/wheels" -r "$WORK/backend/requirements.txt"
export NEXT_STANDALONE_BUILD=true NEXT_TELEMETRY_DISABLED=1
export NEXT_PUBLIC_API_URL=https://uat2.cred-x.in/backend-api
export NEXT_PUBLIC_FRONTEND_URL=https://uat2.cred-x.in
export NEXT_PUBLIC_DISABLE_AUTH=false NEXT_PUBLIC_DISABLE_API_PROXY=false
export NEXT_PUBLIC_UAT2=true NEXT_PUBLIC_UAT2_COMMIT="$SHA"
node "$WORK/scripts/stamp-frontend-build.mjs" "$WORK/frontend/lib/generatedBuildInfo.ts" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)"
(cd "$WORK/frontend" && npm ci --include=dev --no-audit --fund=false && npm run build)
"$WORK/deploy/no-docker/package-frontend-artifact.sh" "$WORK/frontend/.next" "$OUTPUT/frontend.tar.gz" "$SHA" "$(date -u +%Y-%m-%dT%H:%M:%SZ)" webpack
git archive --format=tar.gz -o "$OUTPUT/application.tar.gz" "$SHA" backend deploy/uat2/native deploy/uat2/validate.py
python3 "$WORK/deploy/uat2/native/package.py" "$OUTPUT" "$SHA"
echo "Native UAT2 bundle built for source $SHA in $OUTPUT"
