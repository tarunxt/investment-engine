import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function transpileModuleSource(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
}

async function loadTimerModule() {
  const tempDir = mkdtempSync(path.join(tmpdir(), "bullpen-auto-run-timers-"));
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenAutoRunTimers.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const modulePath = path.join(tempDir, "bullpenAutoRunTimers.mjs");
  writeFileSync(
    modulePath,
    transpileModuleSource(source, "bullpenAutoRunTimers.ts"),
    "utf8",
  );

  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

test("Bullpen auto-run timers clamp completed sub-second stages to one second", async () => {
  const { formatStageElapsedTime } = await loadTimerModule();

  const label = formatStageElapsedTime(
    "2026-06-26T05:00:00.000Z",
    "2026-06-26T05:00:00.000Z",
    Date.parse("2026-06-26T05:00:05.000Z"),
  );

  assert.equal(label, "0:01");
});

test("Bullpen auto-run timers still show in-flight sub-second stages as less than one second", async () => {
  const { formatStageElapsedTime } = await loadTimerModule();

  const label = formatStageElapsedTime(
    "2026-06-26T05:00:00.000Z",
    null,
    Date.parse("2026-06-26T05:00:00.500Z"),
  );

  assert.equal(label, "<0:01");
});
