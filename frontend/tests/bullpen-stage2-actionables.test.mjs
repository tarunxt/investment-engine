import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadActionablesModule() {
  const source = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/bullpenStage2Actionables.ts",
      import.meta.url,
    ),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenStage2Actionables.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`
  );
}

function activePosition({ marketId, title, claimable = false }) {
  return {
    positionKey: `${marketId}::YES`,
    marketId,
    marketTitle: title,
    marketUrl: `https://polymarket.com/event/${marketId}`,
    slug: marketId,
    theme: "Test",
    side: "YES",
    shares: 10,
    exposureUsd: 12,
    averagePriceCents: 42,
    currentYesOdds: 44,
    currentNoOdds: 56,
    closeTime: "2026-08-01T00:00:00Z",
    conditionId: null,
    isClaimable: claimable,
    classification: claimable ? "positive_payout_claimable" : "active",
  };
}

function selectedRow({ marketId, title }) {
  return {
    id: marketId,
    marketId,
    question: title,
    marketUrl: `https://polymarket.com/event/${marketId}`,
    slug: marketId,
    category: "Test",
    llmYesOdds: 76,
    llmNoOdds: 24,
    amountToBeInvested: 20,
    returnsPerDay: 2.5,
  };
}

function decision({
  marketId,
  title,
  decision: decisionValue,
  action = null,
  rank = null,
}) {
  return {
    id: `decision-${marketId}-${decisionValue}`,
    market_id: marketId,
    market_title: title,
    market_url: `https://polymarket.com/event/${marketId}`,
    slug: marketId,
    theme: "Test",
    side: "YES",
    decision: decisionValue,
    reason: `${decisionValue} reason`,
    order_plan: action ? { action, status: "planned" } : null,
    stage3_final_rank: rank,
    current_exposure_usd: decisionValue === "BUY_NEW" ? 0 : 12,
    target_exposure_usd: decisionValue === "BUY_NEW" ? 20 : 0,
    fair_yes_probability_pct: 76,
    fair_no_probability_pct: 24,
  };
}

test("Stage 2 actionables separate displaced exits, new buys, and retained holds", async () => {
  const { buildBullpenStage2Actionables } = await loadActionablesModule();
  const result = buildBullpenStage2Actionables({
    activePositions: [
      activePosition({ marketId: "active-hold", title: "Active Hold" }),
      activePosition({ marketId: "active-exit", title: "Active Exit" }),
      activePosition({
        marketId: "claimable",
        title: "Claimable Position",
        claimable: true,
      }),
    ],
    decisions: [],
    selectedRows: [
      selectedRow({ marketId: "active-hold", title: "Active Hold" }),
      selectedRow({ marketId: "new-buy", title: "New Buy" }),
    ],
  });

  assert.deepEqual(result.eventExits.map((item) => item.marketId), ["active-exit"]);
  assert.deepEqual(result.buyNew.map((item) => item.marketId), ["new-buy"]);
  assert.deepEqual(result.hold.map((item) => item.marketId), ["active-hold"]);
  assert.doesNotMatch(
    JSON.stringify(result),
    /claimable/i,
    "claimable positions must not be included in Exit or Hold",
  );
});

test("explicit sell and buy decisions remain actionable when no selected portfolio rows are saved", async () => {
  const { buildBullpenStage2Actionables } = await loadActionablesModule();
  const result = buildBullpenStage2Actionables({
    activePositions: [
      activePosition({ marketId: "explicit-exit", title: "Explicit Exit" }),
      activePosition({ marketId: "default-hold", title: "Default Hold" }),
    ],
    decisions: [
      decision({
        marketId: "explicit-exit",
        title: "Explicit Exit",
        decision: "EXIT",
        action: "sell",
      }),
      decision({
        marketId: "explicit-buy",
        title: "Explicit Buy",
        decision: "BUY_NEW",
        action: "buy",
        rank: 1,
      }),
    ],
    selectedRows: [],
  });

  assert.deepEqual(result.eventExits.map((item) => item.marketId), ["explicit-exit"]);
  assert.deepEqual(result.buyNew.map((item) => item.marketId), ["explicit-buy"]);
  assert.deepEqual(result.hold.map((item) => item.marketId), ["default-hold"]);
});


test("persisted Stage 2 Exit and Buy IDs override all frontend inference", async () => {
  const { buildBullpenStage2Actionables } = await loadActionablesModule();
  const result = buildBullpenStage2Actionables({
    activePositions: [
      activePosition({ marketId: "active-exit", title: "Active Exit" }),
      activePosition({ marketId: "active-hold", title: "Active Hold" }),
    ],
    decisions: [
      decision({
        marketId: "non-authoritative-buy",
        title: "Ignored Buy Decision",
        decision: "BUY_NEW",
        action: "buy",
      }),
    ],
    selectedRows: [
      selectedRow({ marketId: "active-hold", title: "Active Hold" }),
      selectedRow({ marketId: "authoritative-buy-2", title: "Buy Two" }),
      selectedRow({ marketId: "authoritative-buy-1", title: "Buy One" }),
      selectedRow({ marketId: "inferred-only-buy", title: "Ignored Inferred Buy" }),
    ],
    authoritativeActionables: {
      exitMarketIds: ["active-exit"],
      buyMarketIds: ["authoritative-buy-1", "authoritative-buy-2"],
    },
  });

  assert.deepEqual(result.eventExits.map((item) => item.marketId), [
    "active-exit",
  ]);
  assert.deepEqual(result.buyNew.map((item) => item.marketId), [
    "authoritative-buy-1",
    "authoritative-buy-2",
  ]);
  assert.deepEqual(result.hold.map((item) => item.marketId), ["active-hold"]);
  assert.doesNotMatch(JSON.stringify(result), /inferred-only-buy/);
  assert.doesNotMatch(JSON.stringify(result), /non-authoritative-buy/);
});

test("explicit empty Stage 2 contract never invents exits or buys", async () => {
  const { buildBullpenStage2Actionables } = await loadActionablesModule();
  const result = buildBullpenStage2Actionables({
    activePositions: [
      activePosition({ marketId: "active-hold", title: "Active Hold" }),
    ],
    decisions: [
      decision({
        marketId: "legacy-buy",
        title: "Legacy Buy",
        decision: "BUY_NEW",
        action: "buy",
      }),
    ],
    selectedRows: [selectedRow({ marketId: "legacy-buy", title: "Legacy Buy" })],
    authoritativeActionables: { exitMarketIds: [], buyMarketIds: [] },
  });

  assert.deepEqual(result.eventExits, []);
  assert.deepEqual(result.buyNew, []);
  assert.deepEqual(result.hold.map((item) => item.marketId), ["active-hold"]);
});

test("authoritative exit IDs resolve through saved active-position question identities", async () => {
  const { buildBullpenStage2Actionables } = await loadActionablesModule();
  const exitPosition = activePosition({
    marketId: "condition-exit",
    title: "Named Active Exit",
  });
  const holdPosition = activePosition({
    marketId: "condition-hold",
    title: "Named Active Hold",
  });
  const result = buildBullpenStage2Actionables({
    activePositions: [exitPosition, holdPosition],
    activePositionQuestions: [
      {
        ...selectedRow({ marketId: "3253026", title: "Named Active Exit" }),
        id: exitPosition.positionKey,
        positionKey: exitPosition.positionKey,
        conditionId: "condition-exit",
      },
      {
        ...selectedRow({ marketId: "3253027", title: "Named Active Hold" }),
        id: holdPosition.positionKey,
        positionKey: holdPosition.positionKey,
        conditionId: "condition-hold",
      },
    ],
    decisions: [],
    selectedRows: [],
    authoritativeActionables: {
      exitMarketIds: ["3253026"],
      buyMarketIds: [],
    },
  });

  assert.deepEqual(result.eventExits.map((item) => item.title), [
    "Named Active Exit",
  ]);
  assert.deepEqual(result.hold.map((item) => item.title), ["Named Active Hold"]);
  assert.doesNotMatch(JSON.stringify(result.eventExits), /metadata is unavailable/);
});

test("the actionables dialog keeps the required red, green, and yellow sections", () => {
  const dialogSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenStage2ActionablesDialog.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  assert.match(dialogSource, /title="Event Exits"/);
  assert.match(dialogSource, /tone="exit"/);
  assert.match(dialogSource, /title="Buy New"/);
  assert.match(dialogSource, /tone="buy"/);
  assert.match(dialogSource, /title="Hold"/);
  assert.match(dialogSource, /tone="hold"/);
  assert.match(dialogSource, /Active Bullpen positions not included in Event Exits/);
  assert.match(dialogSource, /marketTitles/);
  assert.match(dialogSource, /market-urls/);
  assert.match(dialogSource, /visibleActionables\.hold/);
  assert.match(dialogSource, /Event URLs group multiple dated markets/);
  assert.match(dialogSource, /historicalHoldCount/);
  assert.match(dialogSource, /matchedHold\.slice\(0, historicalHoldCount\)/);
  assert.doesNotMatch(dialogSource, /exitKeys\.has/);
});

test("the Stage 2 monitor renders the clickable Actionables line below New Events", () => {
  const scheduleCardSource = readFileSync(
    new URL(
      "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
      import.meta.url,
    ),
    "utf8",
  );

  const newEventsIndex = scheduleCardSource.indexOf("New Events to Invest in:");
  const actionablesIndex = scheduleCardSource.indexOf("Actionables: Exit=");
  assert.ok(newEventsIndex >= 0, "New Events line must remain present");
  assert.ok(actionablesIndex > newEventsIndex, "Actionables must render below New Events");
  assert.match(scheduleCardSource, /BullpenStage2ActionablesDialog/);
  assert.match(scheduleCardSource, /setIsActionablesDialogOpen\(true\)/);
  assert.match(scheduleCardSource, /aria-haspopup="dialog"/);
  assert.match(
    scheduleCardSource,
    /stage2_actionable_contract_authoritative/,
  );
  assert.match(scheduleCardSource, /stage2_actionable_exit_market_ids/);
  assert.match(scheduleCardSource, /stage2_actionable_buy_market_ids/);
  assert.match(
    scheduleCardSource,
    /Actionables: awaiting authoritative Stage 2 contract/,
  );
  assert.doesNotMatch(
    scheduleCardSource,
    /getBullpenTopTenStrongestLlmOddsRows/,
  );
  assert.match(scheduleCardSource, /HistoricalPlannedContractRows/);
  assert.match(scheduleCardSource, /stage2_actionable_exit_market_ids/);
  assert.match(scheduleCardSource, /stage2_actionable_buy_market_ids/);
  assert.match(
    scheduleCardSource,
    /Preserved from the completed Stage 2 actionable contract/,
  );
});
