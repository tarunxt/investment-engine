#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { classifyDeploymentScope, combineDeploymentScopes } from './detect-deploy-scope.mjs';

// These exact orchestration/test files require a reviewed manual release. They
// are not classified as frontend runtime by the general fail-closed classifier.
export const REVIEWED_ORCHESTRATION_PATHS = new Set([
  '.github/workflows/deploy.yml',
  '.github/workflows/pr-checks.yml',
  'scripts/resolve-deploy-scope.mjs',
  'scripts/detect-deploy-scope.test.mjs',
  'deploy/no-docker/test_contained_recovery_deployment.py',
  'deploy/no-docker/deploy-storage-safety.test.mjs',
]);
const shaPattern = /^[0-9a-f]{40}$/;
export function frontendProofPaths(paths) {
  return paths.every(path =>
    (path.startsWith('frontend/') && !path.endsWith('.env.example')) ||
    path.startsWith('docs/') || path === 'README.md' ||
    REVIEWED_ORCHESTRATION_PATHS.has(path));
}
export function resolveReleaseScope(input, io) {
  const { sha, before, event, ref, requestedScope = 'auto', repository } = input;
  if (!shaPattern.test(sha || '') || io.git(['rev-parse', 'HEAD']).trim() !== sha) throw new Error('Checkout SHA mismatch');
  const changed = base => io.git(['diff', '--no-renames', '--name-only', '-z', base, sha]).split('\0').filter(Boolean);
  const runs = query => io.api(`/repos/${repository}/actions/workflows/deploy.yml/runs?${query}&per_page=20`).workflow_runs || [];
  const deployed = run => ['push', 'workflow_dispatch'].includes(run.event) && run.head_branch === 'main' && run.conclusion === 'success' && shaPattern.test(run.head_sha || '') &&
    (io.api(`/repos/${repository}/actions/runs/${run.id}/jobs?per_page=100`).jobs || []).some(job =>
      /^Deploy (frontend-only|backend-only|full-stack)$/.test(job.name) && job.conclusion === 'success');
  const result = (scope, base = '', reason = '') => ({ scope, frontend_base_sha: base, reason });
  if (event === 'workflow_dispatch') {
    if (ref !== 'refs/heads/main') throw new Error('Manual deployment requires main');
    if (!['auto', 'frontend', 'backend', 'full'].includes(requestedScope)) throw new Error('Unknown manual scope');
    if (requestedScope === 'frontend') {
      if (input.expectedSha !== sha) throw new Error('Frontend release requires the exact reviewed SHA');
      // Successful scope-detection-only holds are not deployment evidence.
      const baseline = runs('status=success').find(deployed)?.head_sha;
      if (!baseline) throw new Error('No successful deployed baseline; frontend release held');
      io.git(['merge-base', '--is-ancestor', baseline, sha]);
      if (!frontendProofPaths(changed(baseline))) throw new Error('Frontend proof includes backend/shared/unknown changes');
      return result('frontend-only', baseline, 'Verified exact frontend/orchestration diff');
    }
    if (requestedScope === 'auto' || requestedScope === 'full') return result('full-stack');
    let currentDeployed = false;
    try { currentDeployed = runs(`head_sha=${sha}&event=push`).some(run => run.head_sha === sha && deployed(run)); } catch { /* existing contained full-stack recovery */ }
    return result(currentDeployed ? 'backend-only' : 'full-stack');
  }
  if (event !== 'push' || ref !== 'refs/heads/main') throw new Error('Unsupported production event');
  if (!shaPattern.test(before || '') || /^0+$/.test(before)) return result('held', '', 'Missing reliable previous SHA');
  const paths = changed(before);
  if (paths.some(path => REVIEWED_ORCHESTRATION_PATHS.has(path))) return result('held', '', 'Orchestration change requires reviewed manual scope');
  let scope = classifyDeploymentScope(paths);
  let previousDeployed = false;
  try { previousDeployed = runs(`head_sha=${before}&event=push`).some(run => run.head_sha === before && deployed(run)); } catch { /* fail closed for frontend */ }
  if (scope === 'frontend-only' && !previousDeployed) return result('held', '', 'Previous deployment unverified; frontend scope will not broaden');
  if (scope !== 'none' && !previousDeployed) scope = 'full-stack';
  const directive = io.git(['log', '-1', '--pretty=%B']).match(/^\[deploy-scope:(frontend|backend|full)\]$/gm)?.at(-1);
  if (directive) {
    const requested = { frontend: 'frontend-only', backend: 'backend-only', full: 'full-stack' }[directive.slice(14, -1)];
    scope = combineDeploymentScopes(scope, requested);
  }
  return result(scope, scope === 'frontend-only' ? before : '');
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const result = resolveReleaseScope({ sha: process.env.GITHUB_SHA, before: process.env.BEFORE_SHA,
      event: process.env.GITHUB_EVENT_NAME, ref: process.env.GITHUB_REF,
      requestedScope: process.env.REQUESTED_SCOPE, expectedSha: process.env.EXPECTED_RELEASE_SHA, repository: process.env.GITHUB_REPOSITORY }, {
      git: args => execFileSync('git', args, { encoding: 'utf8' }),
      api: path => JSON.parse(execFileSync('gh', ['api', path], { encoding: 'utf8' })),
    });
    for (const [key, value] of Object.entries(result)) console.log(`${key}=${value}`);
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
