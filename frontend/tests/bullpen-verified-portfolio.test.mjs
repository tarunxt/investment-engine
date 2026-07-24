import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import ts from "typescript";

function transpile(source, fileName) {
  return ts.transpileModule(source, {
    compilerOptions: {
      module: ts.ModuleKind.ESNext,
      target: ts.ScriptTarget.ES2020,
    },
    fileName,
  }).outputText;
}

async function loadVerifiedPortfolioModule() {
  const tempDirectory = mkdtempSync(
    path.join(tmpdir(), "bullpen-verified-portfolio-"),
  );
  const positionsPath = path.join(tempDirectory, "bullpenPositions.mjs");
  writeFileSync(
    positionsPath,
    transpile(
      readFileSync(
        new URL("../lib/bullpenPositions.ts", import.meta.url),
        "utf8",
      ),
      "bullpenPositions.ts",
    ),
    "utf8",
  );

  const modulePath = path.join(tempDirectory, "bullpenVerifiedPortfolio.mjs");
  writeFileSync(
    modulePath,
    transpile(
      readFileSync(
        new URL("../lib/bullpenVerifiedPortfolio.ts", import.meta.url),
        "utf8",
      ),
      "bullpenVerifiedPortfolio.ts",
    ).replace(
      'from "./bullpenPositions";',
      `from ${JSON.stringify(pathToFileURL(positionsPath).href)};`,
    ),
    "utf8",
  );
  return import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`);
}

function stageOne({
  completedAt,
  positions,
  activePositions = positions.length,
}) {
  return {
    stage_number: 1,
    stage_name: "Stage 1",
    status: "pass",
    reason: "Wallet scan completed.",
    inputs: {},
    outputs: {
      workflow_stage_key: "scan",
      phase_status: "completed",
      active_positions_found: positions,
      console_trade_cash_in_hand_usd: 1.85,
      console_trade_occupied_positions: activePositions,
      console_trade_active_positions: activePositions,
      console_trade_available_slots: 10 - activePositions,
      console_trade_max_positions: 10,
      console_trade_amount_usd:
        activePositions < 10
          ? Number((1.85 / (10 - activePositions)).toFixed(2))
          : 0,
    },
    guardrails_checked: [],
    hard_block: false,
    started_at: completedAt,
    completed_at: completedAt,
  };
}

function run(id, completedAt, positions, activePositions = positions.length) {
  return {
    id,
    triggered_by: "scheduled",
    status: "completed",
    dry_run: false,
    started_at: completedAt,
    completed_at: completedAt,
    summary: "Completed.",
    live_execution_requested: true,
    live_execution_attempted: false,
    decisions_count: 0,
    orders_planned: 0,
    orders_submitted: 0,
    error_message: null,
    guardrail_checks: [],
    decision_ids: [],
    stage_results: [stageOne({ completedAt, positions, activePositions })],
  };
}

function position(index) {
  return {
    position_key: `market-${index}::NO`,
    market_id: `market-${index}`,
    market_title: `Market ${index}`,
    side: "NO",
    shares: 2,
    exposure_usd: 1.8,
    average_price_cents: 90,
    current_price_cents: 95,
    current_value_usd: 1.9,
    current_yes_odds: 5,
    current_no_odds: 95,
    classification: "active",
    classification_reason: "Positive live economic exposure.",
    is_claimable: false,
  };
}

test("latest completed Stage 1 snapshot verifies portfolio rows and occupied slots", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const older = run("older", "2026-07-20T10:00:00Z", [position(1)]);
  const latestPositions = Array.from({ length: 6 }, (_, index) =>
    position(index + 1),
  );
  // The contradictory scalar reproduces the bad zero-position flow. The
  // serialized verified evidence must win.
  const latest = run(
    "latest",
    "2026-07-20T13:23:34Z",
    latestPositions,
    0,
  );

  const snapshot = resolveLatestVerifiedStage1Portfolio([older, latest]);

  assert.equal(snapshot.runId, "latest");
  assert.equal(snapshot.activePositions.length, 6);
  assert.equal(snapshot.occupiedPositions, 6);
  assert.equal(snapshot.availableSlots, 4);
  assert.equal(Number((1.85 / snapshot.availableSlots).toFixed(2)), 0.46);
  assert.equal(snapshot.activePositions[0].currentValue, 1.9);
  assert.equal(snapshot.activePositions[0].costBasis, 1.8);
  assert.equal(snapshot.activePositions[0].unrealizedPnl, 0.1);
});

test("an explicit newer empty Stage 1 snapshot supersedes older positions", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const older = run("older", "2026-07-20T10:00:00Z", [position(1)]);
  const latest = run("latest", "2026-07-20T14:00:00Z", []);

  const snapshot = resolveLatestVerifiedStage1Portfolio([older, latest]);

  assert.equal(snapshot.runId, "latest");
  assert.equal(snapshot.occupiedPositions, 0);
  assert.equal(snapshot.availableSlots, 10);
});

test("incomplete Stage 1 data never overrides the live portfolio flow", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const incomplete = run("incomplete", "2026-07-20T14:00:00Z", []);
  incomplete.stage_results[0].status = "pending";
  incomplete.stage_results[0].completed_at = null;
  incomplete.stage_results[0].outputs.phase_status = "running";

  assert.equal(resolveLatestVerifiedStage1Portfolio([incomplete]), null);
});


test("live positions snapshot takes precedence over historical Stage 1 portfolio", async () => {
  const {
    resolveLatestVerifiedStage1Portfolio,
    shouldUseVerifiedStage1PortfolioFallback,
  } = await loadVerifiedPortfolioModule();
  const verifiedPortfolio = resolveLatestVerifiedStage1Portfolio([
    run("verified", "2026-07-24T03:13:46Z", []),
  ]);

  assert.equal(
    shouldUseVerifiedStage1PortfolioFallback({
      hasActivePositionsSnapshot: true,
      verifiedPortfolio,
    }),
    false,
  );
  assert.equal(
    shouldUseVerifiedStage1PortfolioFallback({
      hasActivePositionsSnapshot: false,
      verifiedPortfolio,
    }),
    true,
  );
  assert.equal(
    shouldUseVerifiedStage1PortfolioFallback({
      hasActivePositionsSnapshot: false,
      verifiedPortfolio: null,
    }),
    false,
  );
});
