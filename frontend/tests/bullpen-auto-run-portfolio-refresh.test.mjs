import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const source = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAutoRunScheduleCard.tsx",
    import.meta.url,
  ),
  "utf8",
);
const pageSource = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenAiPageClient.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("Bullpen auto-run completion refreshes the live portfolio snapshot once per run", () => {
  assert.match(
    source,
    /postCompletionPortfolioRefreshRunIdsRef\s*=\s*useRef<Set<string>>/,
  );
  assert.match(
    source,
    /postCompletionPortfolioRefreshRunIdsRef\.current\.has\(runId\)/,
  );
  assert.match(source, /await refreshPortfolioSnapshot\(true\)/);
});

test("portfolio refresh keeps balance and wallet positions in one refresh lifecycle", () => {
  assert.match(
    source,
    /onRefreshPortfolioPositionsRef\s*=\s*useRef\(onRefreshPortfolioPositions\)/,
  );
  assert.match(
    source,
    /forceBalanceRefresh && onRefreshPortfolioPositionsRef\.current/,
  );
  assert.match(source, /await positionsRefreshTask/);
  assert.match(pageSource, /onRefreshPortfolioPositions=\{async \(\) =>/);
  assert.match(pageSource, /callerSource:\s*"ui-portfolio-refresh"/);
});

test("empty tracked fallback cannot supersede a last-good or Stage 1 portfolio", () => {
  assert.match(pageSource, /shouldPreserveBullpenPositionsOnRefresh/);
  assert.match(pageSource, /setHasUsablePositionsSnapshot/);
  assert.match(
    pageSource,
    /hasActivePositionsSnapshot=\{hasUsablePositionsSnapshot\}/,
  );
  assert.match(
    source,
    /const activePositionCount = hasActivePositionsSnapshot[\s\S]*verifiedActivePositionsTotal[\s\S]*verifiedActivePositions\.length/,
  );
});

test("fresh same-account passive/run refreshes may rotate lineage while account changes preserve", () => {
  assert.match(pageSource, /getBullpenPositionsLineageMismatchFields/);
  assert.match(pageSource, /preservingForLineageMismatch/);
  assert.match(pageSource, /canAutoRebaselineBullpenPositionsLineage/);
  assert.match(pageSource, /incomingIsFreshUsableLive/);
  assert.match(
    pageSource,
    /positionsSource === "live-cli"[\s\S]*!livePositionsPayload\.error\?\.trim\(\)[\s\S]*fallback\?\.active !== true/,
  );
  const rebaselineBlock = pageSource.match(
    /const canEstablishFreshLineageBaseline[\s\S]*?const preservingForLineageMismatch/,
  )?.[0];
  assert.ok(rebaselineBlock);
  assert.doesNotMatch(rebaselineBlock, /refreshMode === "manual"/);
  assert.doesNotMatch(rebaselineBlock, /allowFreshLineageRebaseline/);
  assert.doesNotMatch(pageSource, /allowFreshLineageRebaseline/);
  assert.match(
    pageSource,
    /previousLiveSnapshot && !incomingIsFreshUsableLive/,
  );
  assert.match(
    pageSource,
    /setLastSuccessfulLiveSnapshot\([\s\S]*preserveLastGoodPositions[\s\S]*previousLiveSnapshot/,
  );
  assert.match(pageSource, /callerSource:\s*"ui-run-completed"/);
  assert.match(pageSource, /accountIdentityChanged/);
  assert.match(pageSource, /will not re-baseline an account change automatically/);
  assert.match(pageSource, /previous verified wallet snapshot remains displayed/i);
  assert.match(source, /positionsLineage/);
  assert.match(source, /classifier v/);
});
