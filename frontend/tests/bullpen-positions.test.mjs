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
      end_date: "2027-07-25",
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
      end_date: "2027-07-25",
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
          end_date: "2099-07-30",
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
      slug: "trump-netanyahu-august-24-2026",
      market: "Will Trump meet with Netanyahu by August 24, 2026?",
      outcome: "No",
      shares: 4.5,
      avg_price: 0.61,
      current_price: 0.64,
      current_value: 2.88,
      expected_payout_usdc: 0,
      redeemable: false,
      upstream_redeemable: false,
      resolution_status: "open",
      end_date: "2027-07-24",
    },
  ];

  const positions = rows.map((row) => normalizeBullpenPosition(row, () => null));
  const visiblePositions = filterDisplayBullpenPositions(positions);
  const diagnostics = buildBullpenPositionsDiagnostics(positions);
  const summary = summarizeBullpenPositions(visiblePositions, null);

  assert.equal(visiblePositions.length, 1);
  assert.equal(
    visiblePositions[0].marketTitle,
    "Will Trump meet with Netanyahu by August 24, 2026?",
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

test("authoritative open-market enrichment overrides stale redeemable and past-date hints", async () => {
  const {
    applyBullpenPositionMarketData,
    normalizeBullpenPosition,
  } = await loadBullpenPositionsModule();
  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-27T00:00:00.000Z");

  try {
    const conditionId =
      "0x2222222222222222222222222222222222222222222222222222222222222222";
    const position = normalizeBullpenPosition(
      {
        marketSlug: "iran-action-july-25-no",
        event_slug: "iran-action-july-25",
        condition_id: conditionId,
        market: "Iran military action against a Gulf State on July 25?",
        outcome: "No",
        shares: 4.737,
        avg_price: 0.38,
        current_price: 0.99,
        current_value: 4.69,
        expected_payout_usdc: 4.69,
        redeemable: true,
        upstream_redeemable: true,
        status: "redeemable",
        end_date: "2026-07-25",
      },
      (eventSlug) =>
        eventSlug ? `https://polymarket.com/event/${eventSlug}` : null,
    );

    assert.equal(position.economicClassification, "positive_payout_claimable");

    const refreshed = applyBullpenPositionMarketData(position, {
      marketSlug: "iran-action-july-25-no",
      eventSlug: "iran-action-july-25",
      slug: "iran-action-july-25-no",
      marketUrl: "https://polymarket.com/event/iran-action-july-25",
      noOdds: 99,
      yesOdds: 1,
      authoritativeMarketOpen: true,
    });

    assert.equal(refreshed.economicClassification, "active");
    assert.equal(refreshed.isClaimable, false);
    assert.equal(refreshed.marketSlug, "iran-action-july-25-no");
    assert.equal(refreshed.eventSlug, "iran-action-july-25");
    assert.equal(refreshed.slug, "iran-action-july-25-no");
    assert.equal(refreshed.conditionId, conditionId);
  } finally {
    Date.now = originalNow;
  }
});

test("authoritative closed-market enrichment never leaves a row active", async () => {
  const {
    applyBullpenPositionMarketData,
    normalizeBullpenPosition,
  } = await loadBullpenPositionsModule();
  const position = normalizeBullpenPosition(
    {
      slug: "closed-market",
      event_slug: "closed-event",
      market: "Explicitly closed market",
      outcome: "No",
      shares: 5,
      current_price: 0.6,
      current_value: 3,
      resolution_status: "open",
      end_date: "2027-08-01",
    },
    () => null,
  );

  const refreshed = applyBullpenPositionMarketData(position, {
    authoritativeMarketOpen: false,
    noOdds: 60,
    yesOdds: 40,
  });

  assert.equal(refreshed.economicClassification, "stale_or_unknown");
  assert.equal(refreshed.isClaimable, false);
  assert.match(refreshed.classificationReason, /not open/i);
});

test("non-authoritative question fallback cannot reclassify a claimable row", async () => {
  const {
    applyBullpenPositionMarketData,
    normalizeBullpenPosition,
  } = await loadBullpenPositionsModule();
  const position = normalizeBullpenPosition(
    {
      slug: "resolved-market",
      market: "A duplicated question title",
      outcome: "Yes",
      shares: 5,
      current_price: 1,
      current_value: 5,
      expected_payout_usdc: 5,
      resolution_status: "resolved",
      redeemable: true,
    },
    () => null,
  );

  assert.equal(position.economicClassification, "positive_payout_claimable");

  const refreshed = applyBullpenPositionMarketData(position, {
    marketSlug: "different-market-with-the-same-question",
    authoritativeMarketOpen: null,
    yesOdds: 45,
    noOdds: 55,
  });

  assert.equal(refreshed.economicClassification, "positive_payout_claimable");
  assert.equal(refreshed.isClaimable, true);
});

test("unresolved redeemable hints alone do not promote a live row to claimable", async () => {
  const { normalizeBullpenPosition } = await loadBullpenPositionsModule();

  const position = normalizeBullpenPosition(
    {
      slug: "still-open-market",
      event_slug: "still-open-event",
      market: "Still-open market",
      outcome: "Yes",
      shares: 5,
      current_price: 0.6,
      current_value: 3,
      redeemable: true,
      upstream_redeemable: true,
      resolution_status: "open",
      end_date: "2027-08-01",
    },
    () => null,
  );

  assert.equal(position.economicClassification, "active");
  assert.equal(position.isClaimable, false);
});

test("empty degraded tracked fallback preserves a loaded wallet snapshot", async () => {
  const {
    isUsableBullpenPositionsSnapshot,
    normalizeBullpenPosition,
    shouldPreserveBullpenPositionsOnRefresh,
    summarizeBullpenPositions,
  } = await loadBullpenPositionsModule();
  const position = normalizeBullpenPosition(
    {
      slug: "open-market",
      event_slug: "open-event",
      market: "Open market",
      outcome: "No",
      shares: 5,
      current_price: 0.5,
      current_value: 2.5,
      resolution_status: "open",
      end_date: "2027-08-01",
    },
    () => null,
  );
  const lastSuccessfulLiveSnapshot = {
    positions: [position],
    summary: summarizeBullpenPositions([position], {}),
    diagnostics: {
      excludedPositionCount: 0,
      diagnosticPositionCount: 0,
      settlementPendingCount: 0,
      staleOrUnknownCount: 0,
      closedPositionCount: 0,
      resolvedZeroPayoutCount: 0,
      settlementPendingPositions: [],
      diagnosticPositions: [],
      excludedPositions: [],
    },
    fetchedAt: "2026-07-27T00:00:00.000Z",
    source: "live-cli",
  };

  assert.equal(
    isUsableBullpenPositionsSnapshot({
      positionsSource: "tracked-positions",
      liveAvailable: false,
    }),
    false,
  );
  assert.equal(
    shouldPreserveBullpenPositionsOnRefresh({
      incomingPositions: [],
      incomingSource: "tracked-positions",
      liveAvailable: false,
      currentPositions: [],
      currentSource: null,
      lastSuccessfulLiveSnapshot,
    }),
    true,
  );
});

test("wallet snapshot lineage safely auto-rebaselines only complete fresh same-account live rotations", async () => {
  const {
    canAutoRebaselineBullpenPositionsLineage,
    getBullpenPositionsLineageMismatchFields,
  } =
    await loadBullpenPositionsModule();
  const current = {
    accountIdentity: "0xABCDEF",
    credentialArtifact: {
      inode: 10,
      mtimeNs: 20,
      size: 30,
    },
    positionClassifierVersion: 4,
    source: "live-cli",
    freshnessState: "fresh",
  };

  assert.deepEqual(
    getBullpenPositionsLineageMismatchFields({
      current,
      incoming: {
        accountIdentity: "0xabcdef",
        credentialArtifact: {
          inode: 10,
          mtimeNs: 20,
          size: 30,
        },
        positionClassifierVersion: 4,
        source: "redis-cache",
        freshnessState: "stale",
      },
    }),
    [],
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: 5,
        freshnessState: "fresh",
      },
      incomingIsFreshLive: true,
    }),
    true,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        accountIdentity: "0x999999",
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        freshnessState: "fresh",
      },
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: 5,
        source: "redis-cache",
        freshnessState: "fresh",
      },
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        credentialArtifact: {
          inode: null,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: 5,
        freshnessState: "fresh",
      },
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: null,
        freshnessState: "fresh",
      },
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: {
        ...current,
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: 5,
        freshnessState: "stale",
      },
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.equal(
    canAutoRebaselineBullpenPositionsLineage({
      current,
      incoming: null,
      incomingIsFreshLive: true,
    }),
    false,
  );
  assert.deepEqual(
    getBullpenPositionsLineageMismatchFields({
      current,
      incoming: {
        accountIdentity: "0x999999",
        credentialArtifact: {
          inode: 11,
          mtimeNs: 21,
          size: 31,
        },
        positionClassifierVersion: 5,
        source: "live-cli",
        freshnessState: "fresh",
      },
    }),
    [
      "account-identity",
      "credential-inode",
      "credential-mtime",
      "credential-size",
      "position-classifier",
    ],
  );
  assert.deepEqual(
    getBullpenPositionsLineageMismatchFields({
      current,
      incoming: null,
    }),
    ["lineage"],
  );
  assert.deepEqual(
    getBullpenPositionsLineageMismatchFields({
      current: null,
      incoming: current,
    }),
    [],
  );
});

test("portfolio values respect source authority and reconcile verified components", async () => {
  const {
    resolveBullpenPreferredPortfolioValue,
    resolveBullpenTotalPortfolioValue,
    sumBullpenPortfolioPositionValue,
    sumCurrentPositionValue,
  } = await loadBullpenPositionsModule();

  assert.equal(resolveBullpenPreferredPortfolioValue([0, 3.44, null]), 0);
  assert.equal(resolveBullpenPreferredPortfolioValue([null, 3.44, 0]), 3.44);
  assert.equal(
    resolveBullpenTotalPortfolioValue({
      walletValue: 0,
      accountValue: 18.69,
      summaryTotalValue: 0,
      cashBalance: 3.44,
      positionsValue: 0,
      hasPositionsSnapshot: true,
    }),
    3.44,
  );
  assert.equal(
    resolveBullpenTotalPortfolioValue({
      walletValue: 0,
      accountValue: null,
      summaryTotalValue: 0,
      cashBalance: 3.44,
      positionsValue: 0,
      hasPositionsSnapshot: true,
    }),
    3.44,
  );
  assert.equal(
    resolveBullpenTotalPortfolioValue({
      walletValue: 18.69,
      accountValue: 18.69,
      summaryTotalValue: 18.69,
      cashBalance: 0,
      positionsValue: 0,
      hasPositionsSnapshot: true,
    }),
    0,
  );
  assert.equal(
    resolveBullpenTotalPortfolioValue({
      walletValue: 18.69,
      accountValue: 18.69,
      summaryTotalValue: 0,
      cashBalance: null,
      positionsValue: 0,
      hasPositionsSnapshot: true,
    }),
    18.69,
  );
  assert.equal(
    sumCurrentPositionValue([
      {
        currentValue: null,
        costBasis: 4.25,
      },
      {
        currentValue: 2.5,
        costBasis: 2,
      },
    ]),
    6.75,
  );
  assert.equal(
    sumBullpenPortfolioPositionValue([
      {
        economicClassification: "active",
        currentValue: 2.5,
        costBasis: 2,
      },
      {
        economicClassification: "positive_payout_claimable",
        isClaimable: true,
        claimableValue: 3.33,
        expectedPayoutUsd: 3,
        currentValue: 1,
        costBasis: 0.5,
      },
    ]),
    5.83,
  );
});


test("standard Polymarket payload aliases remain active Bullpen positions", async () => {
  const {
    extractBullpenCliPositionRows,
    filterDisplayBullpenPositions,
    normalizeBullpenPosition,
    summarizeBullpenPositions,
  } = await loadBullpenPositionsModule();

  const rows = extractBullpenCliPositionRows({
    positions: [
      {
        conditionId:
          "0x1111111111111111111111111111111111111111111111111111111111111111",
        title: "Iran full airspace closure by August 15, 2099?",
        slug: "iran-full-airspace-closure-by-august-15-2099",
        eventSlug: "iran-full-airspace-closure-by-august-15-2099",
        outcome: "No",
        size: "3.017",
        avgPrice: "0.60",
        initialValue: "1.81",
        curPrice: "0.855",
        currentValue: "2.58",
        cashPnl: "0.77",
        percentPnl: "42.5",
        endDate: "2099-08-15",
        redeemable: false,
      },
    ],
  });

  assert.equal(rows.length, 1);
  const position = normalizeBullpenPosition(rows[0], () => null);
  const visible = filterDisplayBullpenPositions([position]);
  const summary = summarizeBullpenPositions(visible, null);

  assert.equal(position.shares, 3.017);
  assert.equal(position.averagePrice, 0.6);
  assert.equal(position.costBasis, 1.81);
  assert.equal(position.currentPrice, 0.855);
  assert.equal(position.currentValue, 2.58);
  assert.equal(position.unrealizedPnl, 0.77);
  assert.equal(position.unrealizedPnlPercent, 42.5);
  assert.equal(position.economicClassification, "active");
  assert.equal(visible.length, 1);
  assert.equal(summary.activeCount, 1);
});


test("same-account Redis display cache can replace stale displayed live rows without replacing execution lineage", async () => {
  const { canUseBullpenDisplayCacheWithVerifiedLineage } =
    await loadBullpenPositionsModule();
  const current = {
    accountIdentity: "0xABC123",
    credentialArtifact: { inode: 10, mtimeNs: 20, size: 30 },
    positionClassifierVersion: 4,
    source: "live-cli",
    freshnessState: "fresh",
  };
  const sameWalletDisplay = {
    accountIdentity: "0xabc123",
    credentialArtifact: { inode: null, mtimeNs: null, size: null },
    positionClassifierVersion: 4,
    source: "redis-cache",
    freshnessState: "cached",
  };

  assert.equal(
    canUseBullpenDisplayCacheWithVerifiedLineage({
      current,
      incoming: sameWalletDisplay,
      incomingSource: "redis-cache",
    }),
    true,
  );
  assert.equal(
    canUseBullpenDisplayCacheWithVerifiedLineage({
      current,
      incoming: { ...sameWalletDisplay, accountIdentity: "0xdifferent" },
      incomingSource: "redis-cache",
    }),
    false,
  );
  assert.equal(
    canUseBullpenDisplayCacheWithVerifiedLineage({
      current,
      incoming: { ...sameWalletDisplay, positionClassifierVersion: 5 },
      incomingSource: "redis-cache",
    }),
    false,
  );
});
