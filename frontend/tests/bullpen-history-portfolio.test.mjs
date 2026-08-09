import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const component = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenHistoryPortfolio.tsx",
    import.meta.url,
  ),
  "utf8",
);
const screen = readFileSync(
  new URL(
    "../app/console/bullpen-ai/_components/BullpenRunHistoryScreen.tsx",
    import.meta.url,
  ),
  "utf8",
);

test("history renders the Bullpen portfolio before run history", () => {
  assert.ok(
    screen.indexOf("<BullpenHistoryPortfolio />") <
      screen.indexOf("<BullpenRunHistoryContent"),
  );
});

test("history uses the same verified Stage 1 fallback contract as the main Bullpen portfolio", () => {
  assert.match(component, /getBullpenAutoLiveSummary/);
  assert.match(component, /resolveVerifiedStage1PortfolioSnapshot/);
  assert.match(component, /resolveLatestVerifiedStage1Portfolio/);
  assert.match(component, /selectLatestVerifiedStage1Portfolio/);
  assert.match(component, /shouldUseVerifiedStage1PortfolioFallback/);
  assert.match(component, /verifiedStage1Portfolio\.activePositions/);
  assert.match(component, /verifiedStage1Portfolio\.claimablePositions/);
  assert.match(component, /Positions verified by Stage 1/);
  assert.match(component, /Available pUSD · Stage 1 snapshot/);
  assert.match(component, /preferVerifiedComponents: useVerifiedStage1Fallback/);
});

test("manual portfolio refresh bypasses caches without discarding the Stage 1 fallback", () => {
  assert.match(component, /polymarketLiveBalanceRefresh/);
  assert.match(component, /force_fresh/);
  assert.match(component, /max_age_seconds: forceFresh \? "0" : "20"/);
  assert.match(component, /request_id: crypto\.randomUUID\(\)/);
  assert.match(component, /cache: "no-store"/);
  assert.match(component, /apiService\.polymarketState/);
  assert.match(component, /Promise\.allSettled/);
  assert.match(component, /if \(!hasUsableLiveSnapshot && !verifiedStage1\)/);
});
