import assert from "node:assert/strict";
import { readFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import ts from "typescript";

const source = await readFile(new URL("../app/api/bullpen-ai/_lib/stageOneGammaExport.ts", import.meta.url), "utf8");
const scratch = await mkdtemp(join(tmpdir(), "universal-scan-test-"));
const js = ts.transpileModule(source.replace('join(tmpdir(), "credx-bullpen-stage-one-exports")', JSON.stringify(scratch)), { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const ledger = await import(`data:text/javascript;base64,${Buffer.from(js).toString("base64")}`);

test("workflow filters are isolated and incomplete scans never replace a completed universal capture", async () => {
  try {
    const rows = ["a", "b"].map(id => ({ candidate: { id, question: id }, event: {}, market: {}, scanStatus: "passed", filterReasons: [] }));
    const raw = await ledger.appendStageOneGammaExportPage({ exportId: null, ownerKey: "test:universal", pageKey: "first", rows, completed: true });
    const first = await ledger.forkUniversalScan("test");
    const second = await ledger.forkUniversalScan("test");
    const one = await ledger.reapplyStageOneGammaExportFilters({ exportId: first, ownerKey: "test", filters: {}, evaluate: q => q.id === "a" ? [] : ["excluded"] });
    const two = await ledger.reapplyStageOneGammaExportFilters({ exportId: second, ownerKey: "test", filters: {}, evaluate: q => q.id === "b" ? [] : ["excluded"] });
    assert.equal(one.metadata.acceptedSample[0].id, "a");
    assert.equal(two.metadata.acceptedSample[0].id, "b");
    assert.equal(one.metadata.sourceScanExportId, raw.exportId);
    const universal = await ledger.openLatestStageOneGammaExport({ ownerKey: "test:universal" });
    assert.equal(universal.metadata.acceptedCount, 2);
    await ledger.appendStageOneGammaExportPage({ exportId: null, ownerKey: "test:universal", pageKey: "first", rows: [], completed: false });
    assert.equal((await ledger.openLatestStageOneGammaExport({ ownerKey: "test:universal" })).metadata.exportId, raw.exportId);
    await assert.rejects(ledger.forkUniversalScan("other", raw.exportId), /does not belong/);
  } finally { await rm(scratch, { recursive: true, force: true }); }
});
