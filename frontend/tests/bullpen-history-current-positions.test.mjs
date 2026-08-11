import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const historyScreen = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenRunHistoryScreen.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("History primes the shared portfolio from a forced current wallet refresh", () => {
  assert.match(historyScreen, /caller_source: "ui-history-portfolio-refresh"/);
  assert.match(historyScreen, /force_fresh: "true"/);
  assert.match(historyScreen, /max_age_seconds: "0"/);
  assert.match(historyScreen, /fetchCurrentBullpenPositions\(\)\.catch\(\(\) => null\)/);
  assert.match(historyScreen, /isUsableBullpenPositionsSnapshot/);
  assert.match(historyScreen, /portfolioReady \? \(/);
  assert.match(historyScreen, /<BullpenHistoryPortfolio key=\{portfolioVersion\} \/>/);
});

test("History active-event ticks are reconciled against current active positions", () => {
  assert.match(historyScreen, /applyCurrentBullpenPositionsToEventTrends/);
  assert.match(historyScreen, /\.filter\(\s*isActiveBullpenPosition/);
  assert.match(historyScreen, /BullpenEventIdentityResolver\.resolveMatch/);
  assert.match(historyScreen, /getIdentity: BullpenEventIdentityResolver\.fromPosition/);
  assert.match(historyScreen, /is_active_position: activePosition !== null/);
  assert.match(historyScreen, /active_position_side: activePosition/);
  assert.match(historyScreen, /hasUsableCurrentPositions && currentPositions/);
});

test("History does not treat a shared parent market id as an active contract match", () => {
  assert.match(historyScreen, /function isSameBullpenContract/);
  assert.match(historyScreen, /eventMarketId === conditionId/);
  assert.match(historyScreen, /eventMarketId === positionKey/);
  assert.match(historyScreen, /eventTitle === positionTitle/);
  assert.doesNotMatch(
    historyScreen,
    /eventMarketId === normalizeBullpenContractIdentity\(position\.marketId\)/,
  );
  assert.match(
    historyScreen,
    /const contractCandidates = activePositions\.filter\(\(position\) =>\s*isSameBullpenContract\(event, position\)/,
  );
  assert.match(historyScreen, /candidates: contractCandidates/);
});
