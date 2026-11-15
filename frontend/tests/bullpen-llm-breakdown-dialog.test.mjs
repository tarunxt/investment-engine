import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

test("Bullpen LLM breakdown dialog shows the latest LLM update timestamp", () => {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenLlmBreakdownDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(source, /Latest LLM update:/);
  assert.match(source, /question\.llmCompletedAt/);
});
