#!/usr/bin/env node
// Strict offline adapter around the existing budget implementation, not a new gate.
import { readFileSync } from 'node:fs';
import { checkJavaScriptBudgets } from '../check-javascript-budgets.mjs';
const [baselinePath, candidatePath, expectedSha] = process.argv.slice(2);
if (!baselinePath || !candidatePath || !/^[a-f0-9]{40}$/.test(expectedSha ?? '')) {
  throw Error('Usage: candidate-budget.mjs baseline.json candidate.json expected-source-sha');
}
const baseline = JSON.parse(readFileSync(baselinePath, 'utf8'));
const report = JSON.parse(readFileSync(candidatePath, 'utf8'));
for (const key of ['sourceCommit', 'build', 'environment', 'window']) {
  if (typeof report[key] !== 'string' || !report[key].trim()) throw Error(`Missing ${key}`);
}
if (report.sourceCommit !== expectedSha) throw Error('Candidate source identity mismatch');
for (const target of ['login', 'dashboard', 'bullpen']) {
  const samples = (report.profiles ?? []).flatMap(p => p.samples ?? []).filter(s => s.target === target);
  if (!samples.length) throw Error(`Not measured: ${target}`);
  for (const sample of samples) {
    for (const key of ['jsTransferBytes', 'jsDecodedBytes']) {
      const value = sample.metrics?.[key];
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) throw Error(`Invalid ${target} ${key}`);
    }
  }
}
const result = checkJavaScriptBudgets(baseline, report);
console.log(JSON.stringify({sourceCommit: report.sourceCommit, ...result}, null, 2));
if (result.failures.length) process.exitCode = 1;
