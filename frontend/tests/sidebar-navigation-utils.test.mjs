import assert from "node:assert/strict";
import test from "node:test";

import {
  buildSidebarOrderStorageKey,
  collectEntrySectionIds,
  collectLeafEntries,
  createDefaultSidebarOrder,
  findActiveGroupIds,
  isEntryActive,
  isRouteActive,
  orderNavigationSections,
  reconcileSidebarOrder,
} from "../app/console/_components/sidebarNavigationUtils.ts";

const SAMPLE_SECTIONS = [
  {
    id: "overview",
    label: "Overview",
    entries: [
      {
        type: "item",
        id: "overview",
        name: "Overview",
        href: "/console/dashboard",
        matchMode: "exact",
      },
    ],
  },
  {
    id: "investing",
    label: "Investing",
    entries: [
      {
        type: "group",
        id: "portfolios",
        name: "Portfolios",
        children: [
          {
            type: "item",
            id: "india-portfolio",
            name: "India Portfolio",
            href: "/console/zerodha",
            matchMode: "prefix",
          },
          {
            type: "item",
            id: "us-portfolio",
            name: "US Portfolio",
            href: "/console/indmoney-us",
            matchMode: "prefix",
          },
        ],
      },
      {
        type: "group",
        id: "trading-bots",
        name: "Trading Bots",
        children: [
          {
            type: "item",
            id: "bot-overview",
            name: "Bot Overview",
            href: "/console/trading-bots",
            matchMode: "exact",
          },
          {
            type: "item",
            id: "bullpen-ai-review",
            name: "Bullpen AI Review",
            href: "/console/bullpen-ai",
            matchMode: "prefix",
          },
          {
            type: "item",
            id: "bullpen-ai-live",
            name: "Bullpen AI Live",
            href: "/console/trading-bots/bullpen-ai-auto-live",
            matchMode: "prefix",
          },
        ],
      },
      {
        type: "item",
        id: "market-scanner",
        name: "Market Scanner",
        href: "/console/technical-setups",
        matchMode: "prefix",
      },
    ],
  },
  {
    id: "ai-workspace",
    label: "AI Workspace",
    entries: [
      {
        type: "group",
        id: "ai-studio",
        name: "AI Studio",
        children: [
          {
            type: "item",
            id: "run-history",
            name: "Run History",
            href: "/console/runs",
            matchMode: "prefix",
          },
          {
            type: "item",
            id: "prompt-library",
            name: "Prompt Library",
            href: "/console/prompts",
            matchMode: "prefix",
          },
        ],
      },
    ],
  },
  {
    id: "platform",
    label: "Platform",
    entries: [
      {
        type: "group",
        id: "integrations",
        name: "Integrations",
        children: [
          {
            type: "item",
            id: "api-connections",
            name: "API Connections",
            href: "/console/apis",
            matchMode: "prefix",
          },
          {
            type: "item",
            id: "google-sheets",
            name: "Google Sheets",
            href: "/console/google-sheets",
            matchMode: "prefix",
          },
        ],
      },
      {
        type: "item",
        id: "usage-costs",
        name: "Usage & Costs",
        href: "/console/profile/cost-drivers",
        matchMode: "prefix",
      },
    ],
  },
];

const DEFAULT_ORDER = createDefaultSidebarOrder(SAMPLE_SECTIONS);
const ENTRY_SECTION_BY_ID = collectEntrySectionIds(SAMPLE_SECTIONS);

test("Sidebar order storage keys use the v2 schema and distinguish guest from authenticated users", () => {
  assert.equal(
    buildSidebarOrderStorageKey(),
    "investment-engine:console-sidebar-order:user:guest:v2",
  );
  assert.equal(
    buildSidebarOrderStorageKey(42),
    "investment-engine:console-sidebar-order:user:42:v2",
  );
  assert.notEqual(buildSidebarOrderStorageKey(), buildSidebarOrderStorageKey(42));
});

test("Route matching is exact where needed and boundary-aware for nested pages", () => {
  assert.equal(
    isRouteActive("/console/dashboard", "/console/dashboard", "exact"),
    true,
  );
  assert.equal(
    isRouteActive("/console/dashboard/detail", "/console/dashboard", "exact"),
    false,
  );
  assert.equal(
    isRouteActive("/console/zerodha/events", "/console/zerodha", "prefix"),
    true,
  );
  assert.equal(
    isRouteActive("/console/profile-preferences", "/console/profile", "prefix"),
    false,
  );
});

test("Entry active-state detection and active group resolution stay generic across sections", () => {
  const investingSection = SAMPLE_SECTIONS[1];
  const portfolios = investingSection.entries[0];
  const tradingBots = investingSection.entries[1];
  const aiStudio = SAMPLE_SECTIONS[2].entries[0];

  assert.equal(isEntryActive("/console/zerodha/threats", portfolios), true);
  assert.equal(isEntryActive("/console/bullpen-ai/analyse-events", tradingBots), true);
  assert.equal(isEntryActive("/console/runs/123", aiStudio), true);
  assert.deepEqual(
    findActiveGroupIds("/console/trading-bots/bullpen-ai-auto-live", SAMPLE_SECTIONS),
    ["trading-bots"],
  );
  assert.deepEqual(
    findActiveGroupIds("/console/google-sheets", SAMPLE_SECTIONS),
    ["integrations"],
  );
});

test("Ordering helpers preserve section boundaries and leaf collection remains one-to-one", () => {
  const reorderedSections = orderNavigationSections(SAMPLE_SECTIONS, {
    ...DEFAULT_ORDER,
    investing: ["market-scanner", "trading-bots", "portfolios"],
  });
  const leafEntries = collectLeafEntries(SAMPLE_SECTIONS);

  assert.deepEqual(
    reorderedSections[1].entries.map((entry) => entry.id),
    ["market-scanner", "trading-bots", "portfolios"],
  );
  assert.equal(leafEntries.length, 12);
  assert.equal(
    new Set(leafEntries.map((entry) => entry.href)).size,
    leafEntries.length,
  );
});

test("V2 sidebar order reconciliation ignores malformed data, duplicates, unknown ids, and cross-section moves while restoring defaults", () => {
  const reconciled = reconcileSidebarOrder(
    {
      overview: ["overview", "overview", "ghost"],
      investing: [
        "trading-bots",
        "overview",
        "trading-bots",
        "market-scanner",
      ],
      "ai-workspace": ["prompt-library"],
      platform: "wrong-shape",
      unknown: ["market-scanner"],
    },
    DEFAULT_ORDER,
    ENTRY_SECTION_BY_ID,
  );

  assert.deepEqual(reconciled.overview, ["overview"]);
  assert.deepEqual(reconciled.investing, [
    "trading-bots",
    "market-scanner",
    "portfolios",
  ]);
  assert.deepEqual(reconciled["ai-workspace"], ["ai-studio"]);
  assert.deepEqual(reconciled.platform, ["integrations", "usage-costs"]);

  assert.deepEqual(
    reconcileSidebarOrder("bad-json-shape", DEFAULT_ORDER, ENTRY_SECTION_BY_ID),
    DEFAULT_ORDER,
  );
});
