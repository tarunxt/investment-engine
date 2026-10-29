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
test("server-owned capture control stays separate from read-only completed snapshot loading", () => {
  const controls = read("../app/console/trading-bots/_components/UniversalScanAutoRunCard.tsx");
  assert.match(shared, /fetch\("\/api\/universal-polymarket-scan\/auto-run"/);
  assert.match(shared, /JSON\.stringify\(\{ action: "run-now" \}\)/);
  assert.match(shared, /fetch\("\/api\/bullpen-ai\/stage-one-snapshot\?universal=true", \{ cache: "no-store", signal \}\)/);
  assert.match(controls, /act\("kill"\)/);
  assert.match(controls, /status\.kill_requested/);
  assert.match(shared, /autoRunRefreshController\.current\?\.abort\(\)/);
  assert.match(shared, /No replacement scan was started/);
  // This checks frontend control composition only; server completion receipt
  // policy is a separate contract, not proved by browser retry-loop text.
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


test("server-owned kill sends only cancellation intent and retains returned completion evidence", async () => {
  const source = read("../app/console/trading-bots/_components/UniversalScanAutoRunCard.tsx");
  const ast = ts.createSourceFile("control.tsx", source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const component = ast.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "UniversalScanAutoRunCard");
  const act = component.body.statements.find(node => ts.isFunctionDeclaration(node) && node.name?.text === "act");
  assert.ok(act);
  const calls = [], applied = [], errors = [], busy = [];
  const priorCompleted = {running:false,kill_requested:true,last_completed_at:"2026-10-01T02:00:00Z",last_completed_run_started_at:"2026-10-01T01:00:00Z",last_total_events:7};
  const dependencies = {requestStatus:async body=>{calls.push(body);return priorCompleted;},apply:status=>applied.push(status),setBusy:value=>busy.push(value),setError:value=>errors.push(value),normalizeAutoRunError:error=>({message:error.message}),istInputToIso:()=>{throw Error("kill must not alter schedule");},startInput:"",refreshMinutes:360};
  const js = ts.transpileModule(act.getText(ast), {compilerOptions:{target:ts.ScriptTarget.ES2022}}).outputText;
  await new Function(...Object.keys(dependencies), js+";return act;")(...Object.values(dependencies))("kill");
  assert.deepEqual(calls,[{action:"kill"}]);
  assert.deepEqual(applied,[priorCompleted]);
  assert.deepEqual(busy,["kill",null]);assert.deepEqual(errors,[null]);
});

test("actual Stage 1 tile state preserves not-evaluated failure before live working state", () => {
  const ast = ts.createSourceFile("card.tsx", card, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  let expression;
  const visit = node => {
    if (ts.isJsxOpeningElement(node) && node.attributes.properties.some(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(ast)==="data-testid"&&attribute.initializer?.text==="bullpen-stage-one-filters")) {
      expression=node.attributes.properties.find(attribute=>ts.isJsxAttribute(attribute)&&attribute.name.getText(ast)==="data-stage-state").initializer.expression.getText(ast);
    }
    ts.forEachChild(node,visit);
  };visit(ast);assert.ok(expression);
  const state = new Function("notEvaluated","isStageOneActive","stage",`return (${expression});`);
  assert.equal(state(true,true,{state:"finished"}),"failed");
  assert.equal(state(false,true,{state:"finished"}),"working");
  assert.equal(state(false,false,{state:"finished"}),"finished");
});
