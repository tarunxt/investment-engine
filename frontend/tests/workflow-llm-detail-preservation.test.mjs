import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import ts from 'typescript';
const root = new URL('../../', import.meta.url);
const relative = 'frontend/app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge.tsx';
const before = execFileSync('git', ['show', 'b23a75f8a011cece525b68a1c3f387123f4e5e26:' + relative], { cwd: root, encoding: 'utf8' });
const after = readFileSync(new URL(relative, root), 'utf8');
const allowed = new Set(['inferMetricContext', 'collectStageJobs', 'loadThreatFallback', 'loadRecentRunFallback', 'loadSavedStageJobs', 'LlmDetailsDialog']);
const functions = text => {
  const ast = ts.createSourceFile('bridge.tsx', text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  return new Map(ast.statements.filter(ts.isFunctionDeclaration).map(n => [n.name.text, n.getText(ast)]));
};
test('all unrelated bridge functions including runtime/cost, cache/hydration, owner and keyboard handlers are byte-identical', () => {
  const a = functions(before), b = functions(after);
  assert.deepEqual([...a.keys()], [...b.keys()]);
  for (const [name, source] of a) if (!allowed.has(name)) assert.equal(b.get(name), source, name);
});
test('backend contract, financial workflow, opener metrics and deployed Audit3 files outside the separately covered A6-06 Schedule Card remain unchanged', () => {
  const excluded = ['backend', 'frontend/auth.ts', 'frontend/providers', 'frontend/services', 'frontend/types', 'frontend/hooks', 'frontend/package-lock.json', 'frontend/package.json', 'frontend/app/console/dashboard', 'frontend/app/console/bullpen-ai', ':(exclude)frontend/app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx', 'frontend/app/console/sports-rankings', 'frontend/components/shared/WorkflowStageTile.tsx', 'frontend/components/shared/WorkflowStageLedger.tsx'];
  assert.equal(execFileSync('git', ['diff', '--name-only', 'b23a75f8a011cece525b68a1c3f387123f4e5e26', '--', ...excluded], { cwd: root, encoding: 'utf8' }), '');
});
