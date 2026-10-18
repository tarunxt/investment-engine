#!/usr/bin/env bash
set -euo pipefail
# Only on the disposable public-repository hosted runner. No host/server controls.
test "${GITHUB_ACTIONS:-}" = true
test "${RUNNER_ENVIRONMENT:-}" = github-hosted
test "${GITHUB_REPOSITORY:-}" = tarunxt/investment-engine
test "${GITHUB_REF:-}" = refs/heads/codex/uat-real-engines-ci
prefix="uat-ci-${GITHUB_RUN_ID}-${GITHUB_RUN_ATTEMPT}"
work=$(mktemp -d)
cleanup() {
  docker rm -f "$prefix-test" "$prefix-pg" "$prefix-redis" >/dev/null 2>&1 || true
  docker volume rm "$prefix-pg-socket" "$prefix-redis-socket" >/dev/null 2>&1 || true
}
trap cleanup EXIT
# Dependency acquisition happens before candidate execution. No secrets passed.
cp ci/uat-real-engines/candidate/requirements-lock.txt "$work/requirements.txt"
cat > "$work/Dockerfile" <<'EOF'
FROM python:3.13-slim-bookworm
COPY requirements.txt /requirements.txt
RUN pip install --no-cache-dir --index-url https://pypi.org/simple -r /requirements.txt
ENV PYTHONDONTWRITEBYTECODE=1
EOF
docker build --quiet -t "$prefix-python" "$work"
docker pull postgres:17-bookworm >/dev/null
docker pull redis:7.4-bookworm >/dev/null
docker image inspect "$prefix-python" postgres:17-bookworm redis:7.4-bookworm --format '{{.Id}} {{json .RepoDigests}}'
docker volume create "$prefix-pg-socket" >/dev/null
docker volume create "$prefix-redis-socket" >/dev/null
docker run -d --name "$prefix-pg" --network none --memory 512m --memory-swap 512m --cpus 1 --pids-limit 128 \
  --mount "type=volume,src=$prefix-pg-socket,dst=/var/run/postgresql" \
  --tmpfs /var/lib/postgresql/data:rw,size=268435456 \
  -e POSTGRES_HOST_AUTH_METHOD=trust -e POSTGRES_DB=uat_ci_disposable \
  postgres:17-bookworm -c listen_addresses= -c unix_socket_permissions=0777 -c statement_timeout=3000 -c lock_timeout=1000 >/dev/null
docker run -d --name "$prefix-redis" --network none --memory 128m --memory-swap 128m --cpus 0.5 --pids-limit 32 \
  --mount "type=volume,src=$prefix-redis-socket,dst=/socket" \
  redis:7.4-bookworm sh -c 'chown redis:redis /socket; exec docker-entrypoint.sh redis-server --port 0 --unixsocket /socket/redis.sock --unixsocketperm 777 --save "" --appendonly no --maxmemory 32mb --maxmemory-policy noeviction' >/dev/null
for i in $(seq 1 30); do
  if docker exec "$prefix-pg" pg_isready -U postgres -d uat_ci_disposable >/dev/null && docker exec "$prefix-redis" redis-cli -s /socket/redis.sock ping | grep -q PONG; then break; fi
  sleep 1
done
docker exec "$prefix-pg" pg_isready -U postgres -d uat_ci_disposable
docker exec "$prefix-redis" redis-cli -s /socket/redis.sock ping
docker create --name "$prefix-test" --network none --read-only --user 65534:65534 \
  --cap-drop ALL --security-opt no-new-privileges --memory 512m --memory-swap 512m --cpus 1 --pids-limit 64 \
  --tmpfs /tmp:rw,size=67108864 \
  --mount "type=bind,src=$PWD/ci/uat-real-engines,dst=/suite,readonly" \
  --mount "type=bind,src=$PWD/backend/app/uat,dst=/base/app/uat,readonly" \
  --mount "type=volume,src=$prefix-pg-socket,dst=/pg" \
  --mount "type=volume,src=$prefix-redis-socket,dst=/redis" \
  -e PYTHONPATH=/suite/candidate:/base \
  "$prefix-python" python /suite/test_real.py >/dev/null
for name in "$prefix-pg" "$prefix-redis" "$prefix-test"; do
  test "$(docker inspect --format '{{.HostConfig.NetworkMode}}' "$name")" = none
  test "$(docker inspect --format '{{len .HostConfig.PortBindings}}' "$name")" = 0
done
docker start -a "$prefix-test"
test "$(docker inspect --format '{{.State.ExitCode}}' "$prefix-test")" = 0
echo 'ISOLATED_REAL_ENGINES_PASS; production activation remains blocked'
