import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const deploy = readFileSync(new URL('../../.github/workflows/deploy.yml', import.meta.url), 'utf8');
const recovery = readFileSync(new URL('../../.github/workflows/production-disk-recovery.yml', import.meta.url), 'utf8');
const start = deploy.indexOf('            case "$DEPLOY_SCOPE" in', deploy.indexOf('Resolved deployment scope:'));
const end = deploy.indexOf('            source_sync_started_at=', start);
assert.ok(start > 0 && end > start);
const check = deploy.slice(start, end).split('\n').map(line => line.slice(12)).join('\n');

test('low disk blocks deployment without deleting logs, data, caches or rollback slots', () => {
  assert.doesNotMatch(check, /\brm\b|\bfind\b|vacuum|logrotate|apt-get|pip cache/);
  for (const [scope, free, expected] of [
    ['full-stack', 1_954_128, 1], ['full-stack', 2_097_152, 0],
    ['backend-only', 1_048_576, 0], ['frontend-only', 500_000, 1],
  ]) {
    const script = `set -eu\nDEPLOY_SCOPE=${scope}\nAPP_ROOT=/unused\ndf() { printf 'Filesystem Blocks Used Available Capacity Mount\\nx 5000000 0 ${free} 0%% /\\n'; }\n${check}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, expected, `${scope}/${free}: ${result.stderr}`);
    if (expected) assert.match(result.stderr, /STORAGE_BLOCKED.*No files or logs were deleted/);
  }
});

test('failed and scheduled deploys cannot launch destructive recovery', () => {
  const triggers = recovery.slice(0, recovery.indexOf('permissions:'));
  assert.match(triggers, /workflow_dispatch:/);
  assert.doesNotMatch(triggers, /workflow_run:|schedule:|cron:/);
  assert.match(recovery, /if: github\.event_name == 'workflow_dispatch'/);
});


test('recovery deployment never starts the normal financial service path', () => {
  const start = deploy.indexOf('            RECOVERY_DEPLOY=true');
  const end = deploy.indexOf('            if [[ "$DEPLOY_SCOPE" == backend-only ]]; then', start);
  assert.ok(start > 0 && end > start);
  const selection = deploy.slice(start, end).split('\n').map(line => line.slice(12)).join('\n');
  for (const [mode, scope, status, calls] of [
    ['1', 'full-stack', 0, ['recovery', 'redeploy:frontend-only']],
    ['1', 'backend-only', 0, ['recovery']],
    ['1', 'frontend-only', 0, ['recovery', 'redeploy:frontend-only']],
    ['0', 'backend-only', 1, []],
    ['invalid', 'full-stack', 1, []],
  ]) {
    const script = `set -euo pipefail
APP_ROOT=/unused APP_USER=test BACKEND_ENV_FILE=/unused.env
contained_driver=/unused
DEPLOY_SCOPE=${scope} remote_artifact=/unused EXPECTED_FRONTEND_SHA=test DEPLOY_COMMIT_SHA=test
bash() {
  case "$1" in
    */deploy-recovery.sh) if [[ "\${2:-}" == --preflight ]]; then [[ '${mode}' == 1 ]]; else echo recovery; fi ;;
    */configure-postgres-recovery.sh) echo postgres-policy ;;
    */redeploy.sh) echo "redeploy:$2" ;;
    *) echo unexpected-script; return 1 ;;
  esac
}
bash /unused/deploy-recovery.sh --preflight
${selection}`;
    const result = spawnSync('bash', ['-c', script], { encoding: 'utf8' });
    assert.equal(result.status, status, `${mode}/${scope}: ${result.stderr}`);
    assert.deepEqual(result.stdout.trim().split('\n').filter(Boolean), calls);
  }
  assert.doesNotMatch(deploy, /configure-postgres-recovery\.sh|sudo systemctl restart postgresql/);
});
