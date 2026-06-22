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
  assert.equal(openPosition.yesOdds, 50);
  assert.equal(openPosition.noOdds, 50);
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

test("Bullpen positions refresh current odds and use end-of-day ET for returns/day", async () => {
  const {
    applyBullpenPositionMarketData,
    buildBullpenCloseTimeFromDateOnly,
    normalizeBullpenPosition,
  } = await loadBullpenPositionsModule();

  assert.equal(
    buildBullpenCloseTimeFromDateOnly("2026-06-26"),
    "2026-06-27T03:59:59.999Z",
  );

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-06-22T06:00:00.000Z");

  try {
    const position = normalizeBullpenPosition(
      {
        slug: "starmer-out-by-june-26-2026-959-792-935",
        market: "Starmer out by June 26, 2026?",
        outcome: "No",
        shares: 13.2033,
        avg_price: 0.5899,
        current_price: 0.135,
        current_value: 1.7824,
        invested_usd: 7.7899,
        end_date: "2026-06-26",
        status: "open",
      },
      () => null,
    );

    assert.equal(position.closeTime, "2026-06-27T03:59:59.999Z");
    assert.equal(position.yesOdds, 86.5);
    assert.equal(position.noOdds, 13.5);
    assert.equal(position.returnsPerDay, 17.65);

    const refreshed = applyBullpenPositionMarketData(position, {
      noOdds: 11.5,
      marketUrl: "https://polymarket.com/event/starmer-out-in-2025",
    });

    assert.equal(refreshed.yesOdds, 88.5);
    assert.equal(refreshed.noOdds, 11.5);
    assert.equal(refreshed.currentPrice, 0.115);
    assert.equal(refreshed.currentValue, 1.52);
    assert.equal(refreshed.unrealizedPnl, -6.27);
    assert.equal(refreshed.returnsPerDay, 18.06);
    assert.equal(
      refreshed.marketUrl,
      "https://polymarket.com/event/starmer-out-in-2025",
    );
  } finally {
    Date.now = originalNow;
  }
});
