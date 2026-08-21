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
  const [verifiedPortfolioModule, positionsModule] = await Promise.all([
    import(`${pathToFileURL(modulePath).href}?t=${Date.now()}`),
    import(`${pathToFileURL(positionsPath).href}?t=${Date.now()}`),
  ]);
  return {
    ...verifiedPortfolioModule,
    isUsableBullpenPositionsSnapshot:
      positionsModule.isUsableBullpenPositionsSnapshot,
  };
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
      wallet_snapshot_status: "fresh",
      wallet_snapshot_freshness_state: "fresh",
      wallet_source: "live-cli",
      wallet_account_identity: "wallet-a",
      wallet_credential_artifact_inode: 11,
      wallet_credential_artifact_mtime_ns: 22,
      wallet_credential_artifact_size: 33,
      wallet_position_classifier_version: 4,
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
    market_slug: `market-${index}-slug`,
    event_slug: `event-${index}-slug`,
    condition_id: `condition-${index}`,
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
  assert.equal(snapshot.activePositionsTotal, 6);
  assert.equal(snapshot.activePositionsTruncated, false);
  assert.equal(snapshot.occupiedPositions, 6);
  assert.equal(snapshot.availableSlots, 4);
  assert.equal(Number((1.85 / snapshot.availableSlots).toFixed(2)), 0.46);
  assert.equal(snapshot.activePositions[0].currentValue, 1.9);
  assert.equal(snapshot.activePositions[0].costBasis, 1.8);
  assert.equal(snapshot.activePositions[0].unrealizedPnl, 0.1);
  assert.equal(snapshot.activePositions[0].marketSlug, "market-1-slug");
  assert.equal(snapshot.activePositions[0].eventSlug, "event-1-slug");
  assert.equal(snapshot.activePositions[0].slug, "market-1-slug");
  assert.equal(snapshot.activePositions[0].conditionId, "condition-1");
  assert.equal(snapshot.lineage.accountIdentity, "wallet-a");
  assert.equal(snapshot.lineage.credentialArtifact.inode, 11);
  assert.equal(snapshot.lineage.positionClassifierVersion, 4);
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

test("missing wallet freshness lineage cannot verify an empty portfolio", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const legacy = run("legacy", "2026-07-20T14:00:00Z", []);
  delete legacy.stage_results[0].outputs.wallet_snapshot_status;
  delete legacy.stage_results[0].outputs.wallet_snapshot_freshness_state;

  assert.equal(resolveLatestVerifiedStage1Portfolio([legacy]), null);
});

test("Stage 1 with a wallet refresh error or non-pass status is never canonical", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const refreshError = run("refresh-error", "2026-07-20T14:00:00Z", []);
  refreshError.stage_results[0].outputs.wallet_refresh_error =
    "wallet refresh failed";
  const failed = run("failed", "2026-07-20T14:01:00Z", []);
  failed.stage_results[0].status = "fail";
  const partial = run("partial", "2026-07-20T14:02:00Z", []);
  partial.stage_results[0].completed_at = null;
  partial.stage_results[0].outputs.phase_status = "partial";
  const enrichmentError = run(
    "enrichment-error",
    "2026-07-20T14:03:00Z",
    [],
  );
  enrichmentError.stage_results[0].outputs.wallet_market_enrichment_error =
    "market enrichment incomplete";

  assert.equal(
    resolveLatestVerifiedStage1Portfolio([
      refreshError,
      failed,
      partial,
      enrichmentError,
    ]),
    null,
  );
});

test("newer failed empty Stage 1 preserves the prior seven-row snapshot", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const newerFailed = run("newer-failed", "2026-07-20T14:05:00Z", []);
  newerFailed.stage_results[0].outputs.wallet_refresh_error =
    "wallet refresh failed";
  const prior = run(
    "prior-seven",
    "2026-07-20T14:00:00Z",
    Array.from({ length: 7 }, (_, index) => position(index + 1)),
  );

  const snapshot = resolveLatestVerifiedStage1Portfolio([
    newerFailed,
    prior,
  ]);

  assert.equal(snapshot.runId, "prior-seven");
  assert.equal(snapshot.activePositionsTotal, 7);
  assert.equal(snapshot.occupiedPositions, 7);
});

test("twelve active rows preserve total, truncation, and occupancy", async () => {
  const {
    resolveLatestVerifiedStage1Portfolio,
    resolveVerifiedStage1PortfolioSnapshot,
  } = await loadVerifiedPortfolioModule();
  const full = resolveLatestVerifiedStage1Portfolio([
    run(
      "twelve",
      "2026-07-20T14:00:00Z",
      Array.from({ length: 12 }, (_, index) => position(index + 1)),
      12,
    ),
  ]);
  const persisted = resolveVerifiedStage1PortfolioSnapshot({
    run_id: "twelve",
    verified_at: "2026-07-20T14:00:00Z",
    active_positions: Array.from({ length: 10 }, (_, index) =>
      position(index + 1),
    ),
    active_positions_total: 12,
    active_positions_truncated: true,
    occupied_positions: 12,
    available_slots: 8,
    max_positions: 20,
    wallet_source: "live-cli",
    wallet_freshness_state: "fresh",
    wallet_account_identity: "wallet-a",
    wallet_credential_artifact_inode: 11,
    wallet_credential_artifact_mtime_ns: 22,
    wallet_credential_artifact_size: 33,
    position_classifier_version: "4",
  });

  assert.equal(full.activePositions.length, 12);
  assert.equal(full.activePositionsTotal, 12);
  assert.equal(full.occupiedPositions, 12);
  assert.equal(persisted.activePositions.length, 10);
  assert.equal(persisted.activePositionsTotal, 12);
  assert.equal(persisted.activePositionsTruncated, true);
  assert.equal(persisted.occupiedPositions, 12);
  assert.equal(persisted.availableSlots, 8);
  assert.equal(persisted.lineage.accountIdentity, "wallet-a");
});

test("verified Stage 1 uses the largest additive active and occupied scalars", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const candidate = run(
    "scalar-precedence",
    "2026-07-20T14:00:00Z",
    Array.from({ length: 4 }, (_, index) => position(index + 1)),
  );
  candidate.stage_results[0].outputs.active_positions_total = 5;
  candidate.stage_results[0].outputs.console_trade_active_positions = 11;
  candidate.stage_results[0].outputs.console_trade_occupied_positions = 12;
  candidate.stage_results[0].outputs.console_trade_max_positions = 20;

  const snapshot = resolveLatestVerifiedStage1Portfolio([candidate]);

  assert.equal(snapshot.activePositionsTotal, 11);
  assert.equal(snapshot.occupiedPositions, 12);
  assert.equal(snapshot.availableSlots, 8);
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

test("nonempty tracked fallback cannot supersede a seven-row verified Stage 1 portfolio", async () => {
  const {
    isUsableBullpenPositionsSnapshot,
    resolveLatestVerifiedStage1Portfolio,
    shouldUseVerifiedStage1PortfolioFallback,
  } = await loadVerifiedPortfolioModule();
  const verifiedPortfolio = resolveLatestVerifiedStage1Portfolio([
    run(
      "verified-seven",
      "2026-07-27T00:00:00Z",
      Array.from({ length: 7 }, (_, index) => position(index + 1)),
    ),
  ]);
  const trackedSnapshotIsVerified = isUsableBullpenPositionsSnapshot({
    positionsSource: "tracked-positions",
    liveAvailable: false,
  });

  assert.equal(trackedSnapshotIsVerified, false);
  assert.equal(verifiedPortfolio.activePositions.length, 7);
  assert.equal(
    shouldUseVerifiedStage1PortfolioFallback({
      hasActivePositionsSnapshot: trackedSnapshotIsVerified,
      verifiedPortfolio,
    }),
    true,
  );
});

test("an active Stage 1 run keeps the prior verified seven-position portfolio", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const active = run("active", "2026-07-27T00:05:00Z", []);
  active.status = "running";
  active.completed_at = null;
  active.stage_results[0].status = "pending";
  active.stage_results[0].completed_at = null;
  active.stage_results[0].outputs.phase_status = "running";
  delete active.stage_results[0].outputs.active_positions_found;
  const priorVerified = run(
    "prior-verified",
    "2026-07-27T00:00:00Z",
    Array.from({ length: 7 }, (_, index) => position(index + 1)),
  );

  const snapshot = resolveLatestVerifiedStage1Portfolio([
    active,
    priorVerified,
  ]);

  assert.equal(snapshot.runId, "prior-verified");
  assert.equal(snapshot.activePositions.length, 7);
  assert.equal(snapshot.availableSlots, 3);
});

test("a degraded candidate-only Stage 1 cannot replace a prior verified portfolio", async () => {
  const { resolveLatestVerifiedStage1Portfolio } =
    await loadVerifiedPortfolioModule();
  const degraded = run("degraded", "2026-07-27T00:05:00Z", []);
  degraded.stage_results[0].outputs.wallet_snapshot_status = "unavailable";
  degraded.stage_results[0].outputs.stage2_candidate_only = true;
  const priorVerified = run(
    "prior-verified",
    "2026-07-27T00:00:00Z",
    [position(1)],
  );

  const snapshot = resolveLatestVerifiedStage1Portfolio([
    degraded,
    priorVerified,
  ]);

  assert.equal(snapshot.runId, "prior-verified");
  assert.equal(snapshot.activePositions.length, 1);
});

test("persisted Stage 1-only snapshot survives a newer active run", async () => {
  const {
    resolveLatestVerifiedStage1Portfolio,
    resolveVerifiedStage1PortfolioSnapshot,
    selectLatestVerifiedStage1Portfolio,
  } = await loadVerifiedPortfolioModule();
  const active = run("active", "2026-07-27T00:05:00Z", []);
  active.status = "running";
  active.completed_at = null;
  active.stage_results[0].status = "pending";
  active.stage_results[0].completed_at = null;
  active.stage_results[0].outputs.phase_status = "running";
  delete active.stage_results[0].outputs.active_positions_found;
  const persisted = resolveVerifiedStage1PortfolioSnapshot({
    run_id: "prior-verified",
    verified_at: "2026-07-27T00:00:00Z",
    active_positions: Array.from({ length: 7 }, (_, index) =>
      position(index + 1),
    ),
    cash_in_hand_usd: 3.44,
    occupied_positions: 7,
    available_slots: 3,
    max_positions: 10,
    trade_amount_usd: 1.14,
    wallet_freshness_state: "fresh",
  });

  const selected = selectLatestVerifiedStage1Portfolio([
    resolveLatestVerifiedStage1Portfolio([active]),
    persisted,
  ]);

  assert.equal(selected.runId, "prior-verified");
  assert.equal(selected.activePositions.length, 7);
  assert.equal(selected.cashInHandUsd, 3.44);
  assert.equal(selected.availableSlots, 3);
});

test("persisted non-fresh portfolio snapshot is rejected", async () => {
  const { resolveVerifiedStage1PortfolioSnapshot } =
    await loadVerifiedPortfolioModule();

  assert.equal(
    resolveVerifiedStage1PortfolioSnapshot({
      run_id: "stale",
      verified_at: "2026-07-27T00:00:00Z",
      active_positions: [],
      occupied_positions: 0,
      wallet_freshness_state: "stale",
    }),
    null,
  );
  assert.equal(
    resolveVerifiedStage1PortfolioSnapshot({
      run_id: "missing-lineage",
      verified_at: "2026-07-27T00:00:00Z",
      active_positions: [],
      occupied_positions: 0,
    }),
    null,
  );
});

test("persisted snapshot keeps claimable rows separate from active exposure", async () => {
  const { resolveVerifiedStage1PortfolioSnapshot } =
    await loadVerifiedPortfolioModule();
  const claimable = {
    ...position(2),
    classification: "positive_payout_claimable",
    is_claimable: true,
    claimable_value_usd: 1.15,
  };

  const snapshot = resolveVerifiedStage1PortfolioSnapshot({
    run_id: "verified",
    verified_at: "2026-07-27T00:00:00Z",
    active_positions: [position(1)],
    claimable_positions: [claimable],
    occupied_positions: 1,
    wallet_freshness_state: "fresh",
  });

  assert.equal(snapshot.activePositions.length, 1);
  assert.equal(snapshot.claimablePositions.length, 1);
  assert.equal(
    snapshot.claimablePositions[0].economicClassification,
    "positive_payout_claimable",
  );
  assert.equal(snapshot.claimablePositions[0].claimableValue, 1.15);
});
