import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import ts from "typescript";

async function loadEventExitModule() {
  const source = readFileSync(
    new URL("../lib/bullpenEventExits.ts", import.meta.url),
    "utf8",
  );
  const { outputText } = ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName: "bullpenEventExits.ts",
  });

  return import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString("base64")}`,
  );
}

function createPosition({
  key = "position-1",
  marketId = "market-1",
  marketTitle = "Will event one happen?",
  outcome = "NO",
  shares = 100,
  averagePrice = 0.82,
  yesOdds,
  noOdds,
  currentPrice = outcome === "YES" ? yesOdds / 100 : noOdds / 100,
  bestBidPrice = currentPrice,
  bestAskPrice = outcome === "NO" ? 1 - currentPrice : 1 - currentPrice,
  returnsPerDay = 5,
  closeTime = "2026-07-20T12:00:00.000Z",
} = {}) {
  return {
    key,
    marketId,
    conditionId: null,
    marketTitle,
    outcome,
    heldSide: outcome,
    shares,
    averagePrice,
    costBasis: Number((shares * averagePrice).toFixed(2)),
    yesOdds,
    noOdds,
    bestBidPrice,
    bestAskPrice,
    currentPrice,
    currentValue: Number((shares * currentPrice).toFixed(2)),
    unrealizedPnl: 0,
    unrealizedPnlPercent: 0,
    marketUrl: `https://example.com/${marketId}`,
    closeTime,
    isClaimable: false,
    claimableValue: null,
    returnsPerDay,
    rules: null,
    marketContext: null,
    resolutionSource: null,
  };
}

function createQuestion({
  id = "position-1",
  llmYesOdds = 50,
  llmNoOdds = 50,
} = {}) {
  return {
    id,
    llmYesOdds,
    llmNoOdds,
  };
}

function historySnapshot({
  positionId = "position-1",
  heldProbability,
  adverseProbability,
  timestamp,
}) {
  return {
    positionId,
    marketId: "market-1",
    tokenId: `token::${positionId}`,
    timestamp,
    currentYes: heldProbability,
    currentNo: adverseProbability,
    heldProbability,
    adverseProbability,
  };
}

test("frontend event exit evaluator flags virtually lost NO holders", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "NO",
      yesOdds: 99.95,
      noOdds: 0.05,
      currentPrice: 0.0005,
      bestBidPrice: 0.0005,
      bestAskPrice: 0.9995,
    }),
    question: createQuestion({ llmYesOdds: 10, llmNoOdds: 90 }),
    topActivePositionKeys: new Set(["position-1"]),
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.some(
      (signal) => signal.strategy === "CAPITAL_AWARE_FORCED_EXIT",
    ),
  );
  assert.ok(
    evaluation.exitSignals.some(
      (signal) =>
        signal.reasonCode === "ADVERSE_MARKET_99_5" ||
        signal.reasonCode === "HELD_SIDE_BID_BELOW_0_5_CENTS",
    ),
  );
  assert.ok(
    evaluation.exitState === "EVENT_EXIT_PLANNED" ||
      evaluation.exitState === "DUST_LOST",
  );
});

test("frontend event exit evaluator recognizes adverse odds against YES holders", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "YES",
      yesOdds: 0.4,
      noOdds: 99.6,
      currentPrice: 0.004,
      bestBidPrice: 0.004,
      bestAskPrice: 0.996,
    }),
    question: createQuestion({ llmYesOdds: 15, llmNoOdds: 85 }),
    topActivePositionKeys: new Set(["position-1"]),
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.some(
      (signal) => signal.reasonCode === "ADVERSE_MARKET_99_5",
    ),
  );
});

test("frontend event exit evaluator keeps 98.5 percent adverse positions out of the 99.5 override", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "NO",
      yesOdds: 98.5,
      noOdds: 1.5,
      currentPrice: 0.015,
      bestBidPrice: 0.015,
      bestAskPrice: 0.985,
    }),
    question: createQuestion({ llmYesOdds: 25, llmNoOdds: 75 }),
    topActivePositionKeys: new Set(["position-1"]),
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.every(
      (signal) => signal.reasonCode !== "ADVERSE_MARKET_99_5",
    ),
  );
});

test("frontend event exit evaluator uses momentum to trigger watch fast only when adverse side is still moderate", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "YES",
      yesOdds: 54,
      noOdds: 46,
      currentPrice: 0.54,
      bestBidPrice: 0.54,
      bestAskPrice: 0.46,
    }),
    question: createQuestion({ llmYesOdds: 82, llmNoOdds: 18 }),
    topActivePositionKeys: new Set(["position-1"]),
    priceHistory: [
      historySnapshot({
        heldProbability: 0.7,
        adverseProbability: 0.3,
        timestamp: "2026-07-02T11:59:00.000Z",
      }),
    ],
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.some(
      (signal) =>
        signal.reasonCode === "HELD_SIDE_DROP_10_POINTS_1M" &&
        signal.severity === "WATCH_FAST",
    ),
  );
  assert.ok(
    evaluation.exitSignals.every(
      (signal) => signal.reasonCode !== "HELD_SIDE_DROP_15_POINTS_1M",
    ),
  );
});

test("frontend event exit evaluator forces fast collapse exits when adverse side is heavy enough", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "YES",
      yesOdds: 14,
      noOdds: 86,
      currentPrice: 0.14,
      bestBidPrice: 0.14,
      bestAskPrice: 0.86,
    }),
    question: createQuestion({ llmYesOdds: 18, llmNoOdds: 82 }),
    topActivePositionKeys: new Set(["position-1"]),
    priceHistory: [
      historySnapshot({
        heldProbability: 0.3,
        adverseProbability: 0.7,
        timestamp: "2026-07-02T11:59:00.000Z",
      }),
    ],
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.some(
      (signal) => signal.reasonCode === "HELD_SIDE_DROP_15_POINTS_1M",
    ),
  );
  assert.equal(evaluation.exitState, "EVENT_EXIT_PLANNED");
});

test("frontend event exit evaluator preserves the ranking exit and capital accounting", async () => {
  const { evaluateBullpenEventExits } = await loadEventExitModule();

  const evaluation = evaluateBullpenEventExits({
    position: createPosition({
      outcome: "NO",
      yesOdds: 40,
      noOdds: 60,
      currentPrice: 0.6,
      bestBidPrice: 0.002,
      bestAskPrice: 0.998,
    }),
    question: createQuestion({ llmYesOdds: 12, llmNoOdds: 88 }),
    topActivePositionKeys: new Set(["another-position"]),
    now: new Date("2026-07-02T12:00:00.000Z"),
  });

  assert.ok(
    evaluation.exitSignals.some(
      (signal) => signal.reasonCode === "OUTSIDE_TOP_10_BY_RETURNS_DAY",
    ),
  );
  assert.equal(evaluation.estimatedFreeableValue, 0.2);
});
