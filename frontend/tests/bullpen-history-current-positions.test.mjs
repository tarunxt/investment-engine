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
const scheduleCard = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const dedicatedRunPage = readFileSync(
  new URL(
    "../app/console/bullpen-ai/runs/[runId]/RunDetailClient.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("History opens a dedicated run-details screen instead of a popup", () => {
  assert.match(
    historyScreen,
    /\/console\/bullpen-ai\/runs\/\$\{encodeURIComponent\(run\.id\)\}/,
  );
  assert.doesNotMatch(historyScreen, /runDetails=/);
  assert.doesNotMatch(
    historyScreen,
    /analyse-runs\/\$\{encodeURIComponent\(run\.id\)\}/,
  );
  assert.match(dedicatedRunPage, /useParams/);
  assert.match(
    dedicatedRunPage,
    /<BullpenRunDetailScreen runId=\{runId \?\? ""\} \/>/,
  );
  assert.match(scheduleCard, /export function BullpenRunDetailScreen/);
  assert.match(scheduleCard, /presentation="page"/);
  assert.match(scheduleCard, /Back to run history/);
  assert.match(scheduleCard, /isPage[\s\S]*min-h-screen bg-slate-100/);
  assert.match(
    scheduleCard,
    /onOpenScanCandidateDialog=\{openScanCandidateDialog\}/,
  );
  assert.match(
    scheduleCard,
    /onOpenStageTwoLlmRunDetails=\{setStageTwoLlmRunDialog\}/,
  );
  assert.match(
    scheduleCard,
    /onOpenMetricDetails=\{openInvestMetricDialog\}/,
  );
  assert.match(scheduleCard, /<StageOneOutputDialog/);
  assert.match(scheduleCard, /<StageTwoLlmRunDetailsDialog/);
  assert.match(scheduleCard, /<InvestMetricDetailsDialog/);
  assert.match(scheduleCard, /renderInteractiveRows/);
});
test("History keeps usable run or trend data when the sibling request times out", () => {
  assert.match(historyScreen, /Promise\.allSettled/);
  assert.match(historyScreen, /historyRequestOptions = \{ timeoutMs: 10_000 \}/);
  assert.match(historyScreen, /pageResult\.status === "fulfilled"/);
  assert.match(historyScreen, /trendsResult\.status === "fulfilled"/);
  assert.match(historyScreen, /setTrendsError/);
});

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
  assert.match(historyScreen, /\.filter\(\s*isBullpenHistoryActivePosition/);
  assert.match(historyScreen, /BullpenEventIdentityResolver\.resolveMatch/);
  assert.match(historyScreen, /getIdentity: BullpenEventIdentityResolver\.fromPosition/);
  assert.match(historyScreen, /is_active_position: activePosition !== null/);
  assert.match(historyScreen, /active_position_side: activePosition/);
  assert.match(historyScreen, /hasUsableCurrentPositions && currentPositions/);
});

test("History keeps deadlines and Returns/day when the latest LLM scan is uncovered", () => {
  assert.match(
    historyScreen,
    /close_time: event\.close_time \?\? currentPosition\?\.closeTime \?\? null/,
  );
  assert.match(
    historyScreen,
    /currentReturnsPerDay\([\s\S]*?reconciledEvent[\s\S]*?activePosition\?\.returnsPerDay/,
  );
  assert.match(
    historyScreen,
    /const positionTrends =[\s\S]*?applyCurrentBullpenPositionsToEventTrends/,
  );
  assert.match(
    historyScreen,
    /applyCurrentOrderBookOddsToEventTrends\(\s*positionTrends,/,
  );
  assert.match(
    historyScreen,
    /event\.llm_yes_odds != null && event\.llm_no_odds != null/,
  );
  assert.match(historyScreen, /if \(chosenSide === null\)/);
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
