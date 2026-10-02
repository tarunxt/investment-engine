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
