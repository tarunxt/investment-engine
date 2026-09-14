import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

function simulate(scenario, args = []) {
  const dir = mkdtempSync(join(tmpdir(), 'pg-recovery-'));
  const scripts = {
    pg_lsclusters: 'echo "18 main 5432 online postgres data log"',
    pg_isready: '[ "$SCENARIO" = healthy ] || [ -f "$TEST_DIR/ready" ]',
    timeout: 'shift; exec "$@"',
    sudo: `echo "$*" >> "$TEST_DIR/commands"
case "$*" in
  "systemctl show "*"-p Result --value") if [ "$SCENARIO" = maintenance ]; then echo success; else echo oom-kill; fi ;;
  "systemctl show "*"-p ActiveState --value") echo deactivating ;;
  *"pg_ctl "*"-m fast "*) exit 1 ;;
  *"pg_ctl "*"-m immediate "*) exit 0 ;;
  "systemctl start "*) touch "$TEST_DIR/ready" ;;
  "tee "*) cat > "$TEST_DIR/dropin" ;;
esac`,
  };
  try {
    for (const [name, body] of Object.entries(scripts)) writeFileSync(join(dir, name), '#!/bin/bash\n' + body + '\n', { mode: 0o755 });
    const result = spawnSync('bash', ['deploy/no-docker/scripts/configure-postgres-recovery.sh', ...args], {
      cwd: new URL('../../', import.meta.url), encoding: 'utf8',
      env: { ...process.env, PATH: dir + ':' + process.env.PATH, TEST_DIR: dir, SCENARIO: scenario },
    });
    return { status: result.status, commands: readFileSync(join(dir, 'commands'), 'utf8'), dropin: readFileSync(join(dir, 'dropin'), 'utf8') };
  } finally { rmSync(dir, { recursive: true, force: true }); }
}

test('healthy PostgreSQL receives recovery policy without a restart', () => {
  const result = simulate('healthy');
  assert.equal(result.status, 0);
  assert.match(result.dropin, /OOMPolicy=continue/);
  assert.match(result.dropin, /Restart=on-failure/);
  assert.doesNotMatch(result.commands, /pg_ctl|systemctl start /);
});
test('confirmed stuck OOM uses native shutdown and restart', () => {
  const result = simulate('oom');
  assert.equal(result.status, 0);
  assert.ok(result.commands.indexOf('-m fast') < result.commands.indexOf('-m immediate'));
  assert.match(result.commands, /systemctl start postgresql@18-main.service/);
  assert.doesNotMatch(result.commands, /SIGKILL|rm |resetwal/);
});
test('intentional maintenance stop is left stopped', () => {
  const result = simulate('maintenance');
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(result.commands, /pg_ctl|systemctl start /);
});
test('deployment replaces the failing HTTP process before database recovery', () => {
  const result = simulate('oom', ['--restart-backend']);
  assert.equal(result.status, 0);
  assert.ok(result.commands.indexOf('restart --no-block investor-backend.service') < result.commands.indexOf('-m fast'));
});
