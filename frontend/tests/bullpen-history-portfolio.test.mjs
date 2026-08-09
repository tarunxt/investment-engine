import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

const component = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenHistoryPortfolio.tsx", import.meta.url), "utf8");
const screen = readFileSync(new URL("../app/console/bullpen-ai/_components/BullpenRunHistoryScreen.tsx", import.meta.url), "utf8");

test("history renders the Bullpen portfolio before run history", () => {
  assert.ok(screen.indexOf("<BullpenHistoryPortfolio />") < screen.indexOf("<BullpenRunHistoryContent"));
});

test("manual portfolio refresh bypasses caches and refreshes balance and positions", () => {
  assert.match(component, /polymarketLiveBalanceRefresh/);
  assert.match(component, /force_fresh/);
  assert.match(component, /max_age_seconds[^\n]*forceFresh \? "0"/);
  assert.match(component, /request_id: crypto\.randomUUID\(\)/);
  assert.match(component, /cache: "no-store"/);
  assert.match(component, /apiService\.polymarketState/);
  assert.match(component, /Promise\.allSettled/);
});
