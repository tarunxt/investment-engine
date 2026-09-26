import assert from "node:assert/strict";
import { readFileSync, mkdtempSync, writeFileSync, existsSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import test from "node:test";
import ts from "typescript";

test("read-side lookup preserves in-flight orphans and incomplete Universal ownership", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ups-retention-"));
  const oldDirectory = process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY;
  process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY = directory;
  try {
    const source = readFileSync(new URL("../app/api/bullpen-ai/_lib/stageOneGammaExport.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
    const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
    const id = "00000000-0000-0000-0000-000000000042";
    const rows = join(directory, `${id}.jsonl`);
    writeFileSync(rows, "writing in progress\n");
    const old = new Date(Date.now() - 48 * 60 * 60 * 1000);
    utimesSync(rows, old, old);
    await module.openLatestStageOneGammaExport({ ownerKey: "42:universal" });
    assert.ok(existsSync(rows), "orphan file must not be deleted by a read");
    writeFileSync(join(directory, `${id}.json`), JSON.stringify({
      exportId: id, ownerHash: createHash("sha256").update("42:universal").digest("hex"),
      universalSource: true, completed: false,
    }));
    await module.openLatestStageOneGammaExport({ ownerKey: "42:universal" });
    assert.ok(existsSync(rows), "running Universal capture must survive read-side cleanup");
  } finally {
    if (oldDirectory === undefined) delete process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY;
    else process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY = oldDirectory;
  }
});

test("latest export lookup reuses unchanged metadata and detects a newer completed export", async () => {
  const directory = mkdtempSync(join(tmpdir(), "ups-metadata-index-"));
  const oldDirectory = process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY;
  process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY = directory;
  try {
    const source = readFileSync(new URL("../app/api/bullpen-ai/_lib/stageOneGammaExport.ts", import.meta.url), "utf8");
    const { outputText } = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } });
    const module = await import(`data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`);
    const ownerKey = "metadata-index-owner";
    const ownerHash = createHash("sha256").update(ownerKey).digest("hex");
    const firstId = "00000000-0000-0000-0000-000000000051";
    const secondId = "00000000-0000-0000-0000-000000000052";
    writeFileSync(join(directory, `${firstId}.json`), JSON.stringify({
      exportId: firstId, ownerHash, completed: true, updatedAt: "2026-09-24T00:00:00Z",
      identityKeys: Array.from({ length: 5000 }, (_, i) => `market-${i}`),
    }));
    const first = await module.openLatestStageOneGammaExport({ ownerKey });
    const repeated = await module.openLatestStageOneGammaExport({ ownerKey });
    assert.strictEqual(repeated.metadata, first.metadata, "unchanged large metadata should be reused");
    writeFileSync(join(directory, `${secondId}.json`), JSON.stringify({
      exportId: secondId, ownerHash, completed: true, updatedAt: "2026-09-25T00:00:00Z",
    }));
    const newer = await module.openLatestStageOneGammaExport({ ownerKey });
    assert.equal(newer.metadata.exportId, secondId);
  } finally {
    if (oldDirectory === undefined) delete process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY;
    else process.env.BULLPEN_STAGE_ONE_EXPORT_DIRECTORY = oldDirectory;
  }
});

test("failed filters render unavailable counts and blocked downstream stages", () => {
  const source = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx", import.meta.url), "utf8");
  assert.match(source, /function stageOneNotEvaluated/);
  assert.match(source, /Not evaluated/);
  assert.match(source, /Blocked by upstream failure/);
  assert.match(source, /notEvaluated \? 0 : isStageOneActive/);
});
