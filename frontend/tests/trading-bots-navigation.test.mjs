import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

test('Sidebar uses "Trading Bots" and points the parent item at the overview page', () => {
  const source = readSource("../app/console/_components/SidebarNavigation.tsx");

  assert.match(source, /name: 'Trading Bots'/);
  assert.doesNotMatch(source, /Copy Trading Bots/);
  assert.match(
    source,
    /const TRADING_BOTS_OVERVIEW_HREF = URLs\.routes\.console\.tradingBots\(\);/,
  );
  assert.match(source, /id: 'portfolio-trading-bots'[\s\S]*href: TRADING_BOTS_OVERVIEW_HREF/);
});

test("Trading bot ordering keeps Bullpen AI Auto-Live below Bullpen x AI and the overview exposes four cards", () => {
  const sidebarSource = readSource("../app/console/_components/SidebarNavigation.tsx");
  const tradingBotsSource = readSource("../lib/tradingBots.ts");

  assert.ok(
    sidebarSource.indexOf("name: 'Bullpen x AI'") <
      sidebarSource.indexOf("name: 'Bullpen AI Auto-Live'"),
  );
  assert.match(
    tradingBotsSource,
    /export const TRADING_BOT_CARD_ORDER:[\s\S]*"bullpen-x-polymarket"[\s\S]*"polymarket-direct"[\s\S]*"bullpen-x-ai"[\s\S]*"bullpen-ai-auto-live"/,
  );
});

test("Trading Bots overview page and Bullpen AI Auto-Live page stay wired to their console entrypoints", () => {
  const overviewPageSource = readSource("../app/console/trading-bots/page.tsx");
  const autoLivePageSource = readSource(
    "../app/console/trading-bots/bullpen-ai-auto-live/page.tsx",
  );

  assert.match(overviewPageSource, /TradingBotsOverviewPage/);
  assert.match(overviewPageSource, /return <TradingBotsOverviewPage \/>;/);

  assert.match(autoLivePageSource, /BullpenAiAutoLiveConsole/);
  assert.match(autoLivePageSource, /return <BullpenAiAutoLiveConsole \/>;/);
});

test("Legacy Bullpen AI Auto-Live route redirects to the Trading Bots parent route", () => {
  const legacyPageSource = readSource("../app/console/bullpen-ai-auto-live/page.tsx");

  assert.match(legacyPageSource, /redirect/);
  assert.match(
    legacyPageSource,
    /redirect\(URLs\.routes\.console\.bullpenAiAutoLive\(\)\);/,
  );
});
