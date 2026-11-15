import assert from "node:assert/strict";
import fs from "node:fs";
import test from "node:test";
import ts from "typescript";
const read = path => fs.readFileSync(new URL(path, import.meta.url), "utf8");
const card = read("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx");
const page = read("../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx");
const shared = read("../app/console/trading-bots/_components/UniversalPolymarketScan.tsx");
const route = read("../app/api/bullpen-ai/route.ts");
const snapshotRoute = read("../app/api/bullpen-ai/stage-one-snapshot/route.ts");

test("shared scan controls live in Trading Bots, while Bullpen Stage 1 is filters only", () => {
  assert.match(shared, /Universal Polymarket Scan/);
  assert.match(shared, /Scan Now/);
  assert.match(shared, /Open latest saved Universal Polymarket Scan/);
  assert.doesNotMatch(card, />\s*Original\s*</);
  assert.match(card, /data-testid="bullpen-stage-one-filters"/);
  assert.match(card, /filtersOnly renderInteractiveRows/);
});
test("backend-owned captures remain separate from workflow inputs", () => {
  assert.match(shared, /fetch\("\/api\/universal-polymarket-scan\/auto-run"/);
  assert.match(shared, /JSON.stringify\(\{ action: "run-now" \}\)/);
  assert.match(shared, /if \(running \|\| autoRunRunning\) return/);
  assert.match(shared, /autoRunRefreshController.current\?\.abort\(\)/);
  assert.match(shared, /attempt <= 64/);
  assert.match(shared, /signal.aborted \|\| attempt === 64/);
  assert.match(shared, /setSnapshot\(payload.snapshot \?\? null\)/);
  assert.match(snapshotRoute, /openUniversalScan\(sessionOwner\)/);
  assert.match(route, /forkUniversalScan\(sessionOwner\)/);
  assert.match(route, /Universal captures cannot be filtered in place/);
});
test("Bullpen manual actions filter a shared capture with an isolated continuation ID", () => {
  assert.match(page, /params\.set\("useUniversal", "true"\)/);
  assert.match(page, /params\.set\("reapplyExportId", result\.payload\.scanExportId\)/);
  assert.match(route, /forkUniversalScan\(sessionOwner\)/);
  assert.match(route, /Universal captures cannot be filtered in place/);
  assert.match(route, /unfiltered: universal/);
});
test("filtered evidence retains source lineage and server synchronization", () => {
  assert.match(card, /source_scan_export_id: snapshot\.sourceScanExportId/);
  assert.match(card, /source_scan_completed_at: snapshot\.sourceScanCompletedAt/);
  assert.match(card, /filters_completed_at: snapshot\.filtersCompletedAt/);
  assert.match(card, /Universal Polymarket Scan:/);
  assert.match(card, /Filters run:/);
  assert.match(page, /\/api\/bullpen-ai\/stage-one-snapshot/);
  assert.match(
    page,
    /sourceScanCompletedAt: serverSnapshot\.sourceScanCompletedAt/,
  );
  assert.match(route, /sourceScanExportId: metadata\.sourceScanExportId/);
  assert.match(route, /sourceScanCompletedAt: metadata\.sourceScanCompletedAt/);
  assert.match(route, /filtersCompletedAt: metadata\.filtersCompletedAt/);
  assert.match(snapshotRoute, /openStageOneGammaExport/);
  assert.match(snapshotRoute, /sourceScanCompletedAt = source\?\.metadata\.updatedAt/);
  assert.match(snapshotRoute, /openUniversalScan\(sessionOwner\)/);
});

test("an active workflow owns its yellow Stage 1 tile and reports live progress", () => {
  assert.match(card, /selectStageOneDisplayStage/);
  assert.match(card, /const filterStage = stage/);
  assert.match(card, /setStageOneResultSource\("original"\)/);
  assert.match(card, /data-stage-state=\{notEvaluated \? "failed" : isStageOneActive \? "working" : stage\.state\}/);
  const ast = ts.createSourceFile("schedule.tsx", read("../app/console/bullpen-ai/_components/bullpenScheduleShared.tsx"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const predicate = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "stageOneNotEvaluated");
  assert.ok(predicate);
  const body = ts.transpileModule(predicate.getText(ast).replace(/^export /, ""), {compilerOptions:{target:ts.ScriptTarget.ES2020}}).outputText;
  const expression = card.match(/data-stage-state=\{(notEvaluated \? "failed"[^}]+)\}/)[1];
  const displayState = new Function("stage", "isStageOneActive", `${body}const notEvaluated=stageOneNotEvaluated(stage); return ${expression};`);
  assert.equal(displayState({state:"working",outputs:{}},true),"working");
  assert.equal(displayState({state:"finished",outputs:{phase_status:"completed"}},false),"finished");
  assert.equal(displayState({state:"working",outputs:{phase_status:"failed"}},true),"failed");
  assert.equal(displayState({state:"working",outputs:{phase_status:"blocked"}},false),"failed");
  assert.match(card, /data-testid="bullpen-stage-one-live-progress"/);
  assert.match(card, /scanProgressPercent/);
  assert.match(card, /Filter progress/);
  assert.match(card, /totalMarkets/);
  assert.match(
    card,
    /workflowRunForMonitor\?\.request_context\?\.console_profile\?\.scanned_at/,
  );
  assert.match(card, /universalTriggerStatus\?\.last_completed_run_started_at/);
  assert.match(card, /Last stage run:/);
  assert.match(card, /universalScanStartedAt \?\?/);
  assert.doesNotMatch(card, /latestUniversalScanPredatesWorkflow/);
});

test("live run selection is isolated to the current workflow", () => {
  assert.match(card, /function runBelongsToWorkspace/);
  assert.match(card, /run\.workspace_profile \?\?/);
  assert.match(card, /runWorkspace \?\? "bullpen007"/);
  assert.match(card, /getVisibleRun\(\s*summary,\s*pendingRunId,\s*workspaceProfile/);
  assert.match(card, /runBelongsToWorkspace\(run, workspaceProfile\)/);
});
