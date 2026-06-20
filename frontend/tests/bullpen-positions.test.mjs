import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";
import ts from "typescript";

async function loadBullpenPositionsModule() {
  const source = readFileSync(
    new URL("../lib/bullpenPositions.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenPositions.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

test("claimable Bullpen rows are normalized and summarized correctly", async () => {
  const {
    buildClaimableBullpenSignature,
    normalizeBullpenPosition,
    summarizeBullpenPositions,
  } = await loadBullpenPositionsModule();

  const openPosition = normalizeBullpenPosition(
    {
      slug: "open-market",
      market: "Open market",
      outcome: "No",
      shares: "10",
      avg_price: "0.45",
      current_price: "0.50",
      current_value: "5.00",
      end_date: "2026-06-25",
      status: "open",
    },
    () => null,
  );
  const claimablePosition = normalizeBullpenPosition(
    {
      slug: "resolved-market",
      event_slug: "resolved-market",
      market: "Resolved market",
      outcome: "OG",
      shares: "3.334",
      avg_price: "0.8997",
      current_price: "1.00",
      current_value: "3.33",
      end_date: "2026-06-20",
      action: "Redeem",
    },
    (eventSlug) => (eventSlug ? `https://example.com/${eventSlug}` : null),
  );

  assert.equal(openPosition.isClaimable, false);
  assert.equal(openPosition.claimableValue, null);
  assert.equal(claimablePosition.isClaimable, true);
  assert.equal(claimablePosition.claimableValue, 3.33);
  assert.equal(
    claimablePosition.marketUrl,
    "https://example.com/resolved-market",
  );

  const summary = summarizeBullpenPositions(
    [openPosition, claimablePosition],
    { active_count: 2 },
  );

  assert.equal(summary.activeCount, 2);
  assert.equal(summary.claimableCount, 1);
  assert.equal(summary.claimableValue, 3.33);
  assert.equal(
    buildClaimableBullpenSignature([openPosition, claimablePosition]),
    claimablePosition.key,
  );
});
