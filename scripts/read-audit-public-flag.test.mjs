import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseAuditPublicFlag } from './read-audit-public-flag.mjs';

test('actual SSH duplicate markers resolve to their one agreed public value', () => {
  const stdout = 'CREDX_PUBLIC_AUDIT_FLAG=false\nCREDX_PUBLIC_AUDIT_FLAG=false\n===============================================\n✅ Successfully executed commands to all hosts.\n===============================================\n';
  assert.equal(parseAuditPublicFlag(stdout), 'false');
  assert.equal(parseAuditPublicFlag(stdout.replaceAll('false', 'true')), 'true');
});

test('conflicting, malformed, absent and excessive flag output fail closed', () => {
  for (const stdout of [
    'CREDX_PUBLIC_AUDIT_FLAG=true\nCREDX_PUBLIC_AUDIT_FLAG=false\n',
    'CREDX_PUBLIC_AUDIT_FLAG=false\nCREDX_PUBLIC_AUDIT_FLAG=unknown\n',
    'CREDX_PUBLIC_AUDIT_FLAG=false trailing-value\n',
    'no marker\n',
    'x'.repeat(65537),
    '😀'.repeat(20000) + '\nCREDX_PUBLIC_AUDIT_FLAG=false\n',
  ]) assert.throws(() => parseAuditPublicFlag(stdout), /^Error: Invalid public audit build flag$/);
});

test('CLI returns only an agreed value and never echoes malformed input', () => {
  const script = fileURLToPath(new URL('./read-audit-public-flag.mjs', import.meta.url));
  const accepted = spawnSync(process.execPath, [script], { input: 'CREDX_PUBLIC_AUDIT_FLAG=false\r\nCREDX_PUBLIC_AUDIT_FLAG=false\r\n', encoding: 'utf8' });
  assert.equal(accepted.status, 0); assert.equal(accepted.stdout, 'false\n'); assert.equal(accepted.stderr, '');
  const blocked = spawnSync(process.execPath, [script], { input: 'CREDX_PUBLIC_AUDIT_FLAG=synthetic-private-canary\n', encoding: 'utf8' });
  assert.equal(blocked.status, 1); assert.equal(blocked.stdout, '');
  assert.equal(blocked.stderr, 'Invalid public audit build flag\n');
  const excessive = spawnSync(process.execPath, [script], { input: '😀'.repeat(20000) + '\nCREDX_PUBLIC_AUDIT_FLAG=false\n', encoding: 'utf8' });
  assert.equal(excessive.status, 1); assert.equal(excessive.stdout, '');
  assert.equal(excessive.stderr, 'Invalid public audit build flag\n');
});
