import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import ts from 'typescript';
const base = new URL('../app/console/bullpen-ai/_components/', import.meta.url);
const read = name => readFileSync(new URL(name, base), 'utf8');
function imports(source) {
 return ts.createSourceFile('fixture.tsx', source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX).statements
  .filter(ts.isImportDeclaration).map(node => node.moduleSpecifier.text);
}
test('live schedule remains the state/effect owner and does not statically import closed details', () => {
 const live = read('BullpenAutoRunScheduleCard.tsx');
 for (const name of ['BullpenScheduleDetails','BullpenRunHistoryContent','BullpenStageOneExcelHistoryDialog','BullpenAutoRunBadgeRationaleDialog']) assert.ok(!imports(live).includes('./'+name));
 for (const name of ['getPersistedAutoRunStatus','handleStage3Retry','setInterval','getBullpenAutoLiveDashboardSummary']) assert.ok(live.includes(name));
 assert.match(live,/isRunHistoryDialogOpen \?/);
 assert.match(live,/hasOpenedExcelHistoryDialog \? <BullpenStageOneExcelHistoryDialog/);
});
test('details and shared helpers have no static import back to the live schedule owner', () => {
 for (const name of ['BullpenScheduleDetails.tsx','bullpenScheduleShared.tsx']) assert.ok(!imports(read(name)).includes('./BullpenAutoRunScheduleCard'));
 assert.match(read('BullpenScheduleLazyDetails.tsx'),/import\("\.\/BullpenScheduleDetails"\)/);
 const route = readFileSync(new URL('../app/console/bullpen-ai/runs/[runId]/RunDetailClient.tsx',import.meta.url),'utf8');
 assert.match(route,/from "\.\.\/\.\.\/_components\/BullpenScheduleDetails"/);
});
test('table dialogs load on demand without a remaining static import path', () => {
 const source=read('BullpenQuestionsTable.tsx');
 for (const name of ['BullpenLlmBreakdownDialog','BullpenInvestmentMathDialog','BullpenStage3ShortlistReasonDialog']) {
  assert.ok(!imports(source).includes('./'+name));assert.ok(source.includes('import("./'+name+'")'));
 }
});
