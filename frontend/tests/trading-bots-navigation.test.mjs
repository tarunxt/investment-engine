import assert from "node:assert/strict";
import test from "node:test";
import { readFileSync } from "node:fs";

function readSource(relativePath) {
  return readFileSync(new URL(relativePath, import.meta.url), "utf8");
}

function getMatch(source, pattern, message) {
  const match = source.match(pattern);
  assert.ok(match, message);
  return match;
}

test("Sidebar navigation config defines the redesigned sections, labels, and route mappings", () => {
  const configSource = readSource(
    "../app/console/_components/sidebarNavigationConfig.ts",
  );
  const sidebarSectionsSource = getMatch(
    configSource,
    /export const SIDEBAR_SECTIONS = \[(?<body>[\s\S]*?)\] satisfies readonly NavigationSection\[];/,
    "Expected SIDEBAR_SECTIONS configuration block",
  ).groups.body;

  for (const label of [
    "Overview",
    "Portfolios",
    "India Portfolio",
    "US Portfolio",
    "Trading Bots",
    "Bot Overview",
    "Bullpen AI Review",
    "Bullpen AI Live",
    "Bullpen Copy Trader",
    "Polymarket Direct",
    "Market Scanner",
    "AI Studio",
    "Run History",
    "Prompt Library",
    "AI Models",
    "Integrations",
    "API Connections",
    "Google Sheets",
    "Usage & Costs",
  ]) {
    assert.match(configSource, new RegExp(`name: '${label}'`));
  }

  for (const sectionLabel of [
    "label: 'Overview'",
    "label: 'Investing'",
    "label: 'AI Workspace'",
    "label: 'Platform'",
  ]) {
    assert.match(configSource, new RegExp(sectionLabel));
  }

  for (const legacyLabel of [
    "name: 'Dashboard'",
    "name: 'Portfolio'",
    "name: 'Zerodha'",
    "name: 'IndMoney US'",
    "name: 'Runs'",
    "name: 'Prompts'",
    "name: 'LLMs'",
    "name: 'APIs'",
    "name: 'Technical Setups'",
    "name: 'Platform Cost Drivers'",
    "name: 'Settings'",
    "name: 'Bullpen x AI'",
    "name: 'Bullpen AI Auto-Live'",
    "name: 'Bullpen x Polymarket'",
  ]) {
    assert.doesNotMatch(sidebarSectionsSource, new RegExp(legacyLabel));
  }

  for (const routeExpression of [
    "URLs.routes.console.dashboard()",
    "URLs.routes.console.zerodha()",
    "URLs.routes.console.indmoneyUs()",
    "URLs.routes.console.tradingBots()",
    "URLs.routes.console.bullpenAi()",
    "URLs.routes.console.bullpenAiAutoLive()",
    "URLs.routes.console.polymarketBot()",
    "URLs.routes.console.polymarketDirectBot()",
    "URLs.routes.console.technicalSetups()",
    "URLs.routes.console.runs()",
    "URLs.routes.console.prompts()",
    "URLs.routes.console.llms()",
    "URLs.routes.console.apis()",
    "URLs.routes.console.googleSheets()",
    "URLs.routes.profile.costDrivers()",
  ]) {
    assert.match(
      configSource,
      new RegExp(
        routeExpression
          .replaceAll(".", "\\.")
          .replaceAll("(", "\\(")
          .replaceAll(")", "\\)"),
      ),
    );
  }
});

test("Trading Bots is a sibling group with explicit Bot Overview and badges, while Profile and Preferences stay out of primary navigation", () => {
  const configSource = readSource(
    "../app/console/_components/sidebarNavigationConfig.ts",
  );
  const sidebarSectionsSource = getMatch(
    configSource,
    /export const SIDEBAR_SECTIONS = \[(?<body>[\s\S]*?)\] satisfies readonly NavigationSection\[];/,
    "Expected SIDEBAR_SECTIONS configuration block",
  ).groups.body;
  const portfoliosChildrenSource = getMatch(
    configSource,
    /id: 'portfolios'[\s\S]*?children: \[(?<children>[\s\S]*?)\n\s*\],\n\s*\},\n\s*\{/,
    "Expected Portfolios group children",
  ).groups.children;
  const tradingBotsChildrenSource = getMatch(
    configSource,
    /id: 'trading-bots'[\s\S]*?children: \[(?<children>[\s\S]*?)\n\s*\],\n\s*\},\n\s*\{/,
    "Expected Trading Bots group children",
  ).groups.children;
  const accountNavigationSource = getMatch(
    configSource,
    /export const ACCOUNT_NAVIGATION = \[(?<body>[\s\S]*?)\] satisfies readonly AccountNavigationItem\[];/,
    "Expected ACCOUNT_NAVIGATION configuration block",
  ).groups.body;

  assert.match(portfoliosChildrenSource, /id: 'india-portfolio'/);
  assert.match(portfoliosChildrenSource, /id: 'us-portfolio'/);
  assert.doesNotMatch(portfoliosChildrenSource, /trading-bots|bot-overview/);

  assert.match(tradingBotsChildrenSource, /id: 'bot-overview'/);
  assert.match(
    tradingBotsChildrenSource,
    /id: 'bot-overview'[\s\S]*?href: URLs\.routes\.console\.tradingBots\(\)/,
  );
  assert.match(
    tradingBotsChildrenSource,
    /id: 'bullpen-ai-review'[\s\S]*?badge: \{\s*label: 'Review',\s*variant: 'review'/,
  );
  assert.match(
    tradingBotsChildrenSource,
    /id: 'bullpen-ai-live'[\s\S]*?badge: \{\s*label: 'Live',\s*variant: 'live'/,
  );
  assert.match(
    tradingBotsChildrenSource,
    /id: 'polymarket-direct'[\s\S]*?badge: \{\s*label: 'Direct',\s*variant: 'direct'/,
  );

  assert.doesNotMatch(sidebarSectionsSource, /name: 'Profile'|name: 'Preferences'/);
  assert.match(accountNavigationSource, /name: 'Profile'/);
  assert.match(accountNavigationSource, /name: 'Preferences'/);
});

test("Sidebar component keeps the accessibility, footer, and reorder hooks required by the redesign", () => {
  const sidebarSource = readSource("../app/console/_components/SidebarNavigation.tsx");
  const utilsSource = readSource(
    "../app/console/_components/sidebarNavigationUtils.ts",
  );
  const preferencesSource = readSource(
    "../app/console/_components/sidebarNavigationPreferences.ts",
  );

  assert.match(sidebarSource, /aria-label="Console navigation"/);
  assert.match(sidebarSource, /aria-current=\{active \? 'page' : undefined\}/);
  assert.match(sidebarSource, /aria-expanded=\{expanded\}/);
  assert.match(sidebarSource, /Drag folders or items within their current section\./);
  assert.match(sidebarSource, /Nested items can be reordered inside their folder\./);
  assert.match(sidebarSource, /Restore default name/);
  assert.match(sidebarSource, /onContextMenu/);
  assert.match(sidebarSource, /SidebarThemeToggle/);
  assert.match(sidebarSource, /ACCOUNT_ACTIONS\.logout\.label/);
  assert.match(sidebarSource, /buildSidebarOrderStorageKey\(userId\)/);
  assert.match(utilsSource, /console-sidebar-order:user:\$\{userId \?\? 'guest'\}:v2/);
  assert.match(preferencesSource, /console-sidebar-names:user:\$\{userId \?\? 'guest'\}:v1/);
  assert.match(preferencesSource, /console-sidebar-child-order:user:\$\{userId \?\? 'guest'\}:v1/);
  assert.doesNotMatch(sidebarSource, /isPortfolioActive|isTradingBotsActive|onTogglePortfolio|onToggleTradingBots/);
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
