import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
test('offline candidate adapter rejects absent identity, malformed bytes and both budget violations', () => {
  const dir = mkdtempSync(join(tmpdir(), 'synthetic-budget-'));
  const sha = 'a'.repeat(40);
  const report = {sourceCommit: sha, build: 'synthetic', environment: 'offline', window: 'synthetic-window',
    evidence: {sha, buildId: 'synthetic', environment: 'offline', windowStart: '2026-11-01T00:00:00Z', windowEnd: '2026-11-01T00:01:00Z'},
    profiles: [{samples: ['login', 'dashboard', 'bullpen'].map(target => ({target, metrics: {jsTransferBytes: 100, jsDecodedBytes: 100}}))}]};
  const file = join(dir, 'candidate.json');
  const run = () => { writeFileSync(file, JSON.stringify(report)); return spawnSync(process.execPath,
    ['scripts/offline_evidence/candidate-budget.mjs', 'performance-results/javascript-budget-baseline.json', file, sha], {encoding:'utf8'}); };
  try {
    assert.equal(run().status, 0); // Synthetic validator check, never current candidate evidence.
    const evidence = report.evidence;
    delete report.evidence; assert.notEqual(run().status, 0); report.evidence = evidence;
    for (const key of ['sha', 'buildId', 'environment', 'windowStart', 'windowEnd']) {
      const previous = evidence[key]; delete evidence[key]; assert.notEqual(run().status, 0); evidence[key] = previous;
    }
    evidence.sha = 'b'.repeat(40); assert.notEqual(run().status, 0); evidence.sha = sha;
    evidence.windowEnd = '2026-10-31T00:00:00Z'; assert.notEqual(run().status, 0); evidence.windowEnd = '2026-11-01T00:01:00Z';
    report.sourceCommit = 'b'.repeat(40); assert.notEqual(run().status, 0); report.sourceCommit = sha;
    for (const value of [null, -1, '100', 0]) {
      report.profiles[0].samples[0].metrics.jsTransferBytes = value; assert.notEqual(run().status, 0);
    }
    report.profiles[0].samples[0].metrics.jsTransferBytes = 1000000;
    const result = run(); assert.notEqual(result.status, 0);
    assert.match(result.stdout, /fixed maximum/); assert.match(result.stdout, /baseline-relative/);
    report.profiles[0].samples.pop(); assert.notEqual(run().status, 0);
  } finally { rmSync(dir, {recursive:true}); }
});
