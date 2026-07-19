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
    aggregateBullpenPositionViews,
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
      end_date: "2026-07-25",
      status: "open",
    },
    () => null,
  );
  const claimablePosition = normalizeBullpenPosition(
    {
      slug: "resolved-market",
      condition_id:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
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
    claimablePosition.conditionId,
    "0x1111111111111111111111111111111111111111111111111111111111111111",
  );
  assert.equal(
    claimablePosition.marketUrl,
    "https://example.com/resolved-market",
  );

  const summary = summarizeBullpenPositions(
    [openPosition, claimablePosition],
    { active_count: 2 },
  );

  assert.equal(summary.activeCount, 1);
  assert.equal(summary.claimableCount, 1);
  assert.equal(summary.claimableValue, 3.33);
  assert.equal(
    buildClaimableBullpenSignature([openPosition, claimablePosition]),
    claimablePosition.key,
  );

  const duplicatedOpenLot = normalizeBullpenPosition(
    {
      condition_id:
        "0x1111111111111111111111111111111111111111111111111111111111111111",
      slug: "open-market",
      market: "Open market",
      outcome: "No",
      shares: "5",
      avg_price: "0.55",
      current_price: "0.50",
      current_value: "2.50",
      invested_usd: "2.75",
      end_date: "2026-07-25",
      status: "open",
    },
    () => null,
  );
  const aggregated = aggregateBullpenPositionViews([openPosition, duplicatedOpenLot]);

  assert.equal(aggregated.length, 1);
  assert.equal(aggregated[0].shares, 15);
  assert.equal(aggregated[0].costBasis, 7.25);
  assert.equal(aggregated[0].currentValue, 7.5);
  assert.equal(aggregated[0].averagePrice, 0.4833);
});

test("Bullpen positions do not treat plain won status as claimable", async () => {
  const { normalizeBullpenPosition } = await loadBullpenPositionsModule();

  const wonHistoryPosition = normalizeBullpenPosition(
    {
      slug: "closed-history-row",
      market: "Historical winning position",
      outcome: "No",
      shares: "6",
      avg_price: "0.92",
      status: "won",
    },
    () => null,
  );
  const redeemablePosition = normalizeBullpenPosition(
    {
      slug: "redeemable-row",
      market: "Redeemable position",
      outcome: "No",
      shares: "3",
      avg_price: "0.8",
      status: "won",
      redeemable: true,
      claimable_value: "3",
    },
    () => null,
  );

  assert.equal(wonHistoryPosition.isClaimable, false);
  assert.equal(wonHistoryPosition.claimableValue, null);
  assert.equal(redeemablePosition.isClaimable, true);
  assert.equal(redeemablePosition.claimableValue, 3);
});


test("Bullpen CLI position extraction ignores nested history and activity rows", async () => {
  const {
    extractBullpenCliPositionRows,
    normalizeBullpenPosition,
    summarizeBullpenPositions,
  } = await loadBullpenPositionsModule();

  const rows = extractBullpenCliPositionRows({
    data: {
      positions: [
        {
          slug: "active-open-row",
          market: "Active open position",
          outcome: "No",
          shares: 5,
          avg_price: 0.44,
          current_price: 0.41,
          invested_usd: 2.2,
          end_date: "2026-07-30",
        },
      ],
      history: [
        {
          slug: "stale-history-claim",
          market: "Historical resolved position",
          outcome: "No",
          shares: 3,
          avg_price: 0.88,
          current_price: 1,
          status: "won",
          redeemable: true,
        },
      ],
      activities: [
        {
          slug: "stale-activity-claim",
          market: "Historical activity row",
          outcome: "Yes",
          shares: 2,
          avg_price: 0.73,
          current_price: 1,
          action: "Redeem",
        },
      ],
    },
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].slug, "active-open-row");

  const positions = rows.map((row) => normalizeBullpenPosition(row, () => null));
  const summary = summarizeBullpenPositions(positions, null);

  assert.equal(summary.claimableCount, 0);
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
      rules:
        'This market will resolve to "Yes" if Keir Starmer ceases to be PM by June 26, 2026.',
      marketContext:
        "Experimental AI-generated summary referencing Polymarket data. Starmer is under mounting pressure.",
      resolutionSource:
        "The resolution source for this market will be the government of the UK.",
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
    assert.match(refreshed.rules || "", /ceases to be PM/);
    assert.match(
      refreshed.marketContext || "",
      /Experimental AI-generated summary referencing Polymarket data\./,
    );
    assert.match(refreshed.resolutionSource || "", /government of the UK/);
  } finally {
    Date.now = originalNow;
  }
});

test("Bullpen positions with custom outcomes still accept canonical Yes/No market refreshes", async () => {
  const { applyBullpenPositionMarketData, normalizeBullpenPosition } =
    await loadBullpenPositionsModule();

  const position = normalizeBullpenPosition(
    {
      slug: "egypt-vs-ir-iran-ou-05",
      market: "Egypt vs. IR Iran: O/U 0.5",
      outcome: "Under",
      shares: 5.882,
      avg_price: 0.1699,
      current_price: 0.1699,
      current_value: 1.0,
      end_date: "2026-06-28",
      status: "open",
    },
    () => null,
  );

  assert.equal(position.yesOdds, null);
  assert.equal(position.noOdds, null);

  const refreshed = applyBullpenPositionMarketData(position, {
    yesOdds: 83.5,
    noOdds: 16.5,
    marketUrl: "https://polymarket.com/event/egypt-vs-ir-iran-ou-05",
  });

  assert.equal(refreshed.yesOdds, 83.5);
  assert.equal(refreshed.noOdds, 16.5);
  assert.equal(
    refreshed.marketUrl,
    "https://polymarket.com/event/egypt-vs-ir-iran-ou-05",
  );
  assert.equal(refreshed.currentPrice, 0.1699);
  assert.equal(refreshed.currentValue, 1);
});

test("Bullpen zero-payout residues are excluded from headline positions and preserved in diagnostics", async () => {
  const {
    buildBullpenPositionsDiagnostics,
    filterDisplayBullpenPositions,
    normalizeBullpenPosition,
    summarizeBullpenPositions,
  } = await loadBullpenPositionsModule();

  const rows = [
    {
      slug: "claude-fable-july-3",
      market: "Will Claude Fable 5 be restored for US customers by July 3, 2026?",
      outcome: "No",
      shares: 6.0975,
      current_price: 0,
      current_value: 0,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: true,
      resolution_status: "unknown",
      end_date: "2026-07-03",
    },
    {
      slug: "claude-fable-july-2",
      market: "Will Claude Fable 5 be restored for US customers by July 2, 2026?",
      outcome: "No",
      shares: 5.4347,
      current_price: 0,
      current_value: 0,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: true,
      resolution_status: "unknown",
      end_date: "2026-07-02",
    },
    {
      slug: "claude-fable-july-1",
      market: "Will Claude Fable 5 be restored for US customers by July 1, 2026?",
      outcome: "No",
      shares: 5.3763,
      current_price: 0,
      current_value: 0,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: true,
      resolution_status: "unknown",
      end_date: "2026-07-01",
    },
    {
      slug: "senegal-vs-iraq-ou-25",
      market: "Senegal vs. Iraq: O/U 2.5",
      outcome: "Under",
      shares: 5.2631,
      current_price: 0,
      current_value: 0,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: true,
      resolution_status: "unknown",
      end_date: "2026-06-26",
    },
    {
      slug: "trump-netanyahu-july-24-2026",
      market: "Will Trump meet with Netanyahu by July 24, 2026?",
      outcome: "No",
      shares: 4.5,
      avg_price: 0.61,
      current_price: 0.64,
      current_value: 2.88,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: false,
      resolution_status: "open",
      end_date: "2026-07-24",
    },
  ];

  const positions = rows.map((row) => normalizeBullpenPosition(row, () => null));
  const visiblePositions = filterDisplayBullpenPositions(positions);
  const diagnostics = buildBullpenPositionsDiagnostics(positions);
  const summary = summarizeBullpenPositions(visiblePositions, null);

  assert.equal(visiblePositions.length, 1);
  assert.equal(
    visiblePositions[0].marketTitle,
    "Will Trump meet with Netanyahu by July 24, 2026?",
  );
  assert.equal(visiblePositions[0].economicClassification, "active");
  assert.equal(summary.activeCount, 1);
  assert.equal(summary.claimableCount, 0);
  assert.equal(summary.claimableValue, 0);
  assert.equal(diagnostics.excludedPositionCount, 4);
  assert.equal(diagnostics.resolvedZeroPayoutCount, 4);
  assert.equal(diagnostics.excludedPositions.length, 4);
  assert.ok(
    diagnostics.excludedPositions.every(
      (position) => position.economicClassification === "resolved_zero_payout",
    ),
  );
});

test("Bullpen unresolved positions with missing pricing stay stale instead of becoming zero-payout residues", async () => {
  const { normalizeBullpenPosition } = await loadBullpenPositionsModule();

  const position = normalizeBullpenPosition(
    {
      slug: "fresh-open-position",
      market: "Open position with temporary pricing gap",
      outcome: "No",
      shares: 4,
      avg_price: 0.41,
      current_price: null,
      current_value: null,
      resolution_status: "open",
      end_date: "2026-08-01",
    },
    () => null,
  );

  assert.equal(position.economicClassification, "stale_or_unknown");
  assert.equal(position.isClaimable, false);
});
