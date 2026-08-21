import {
  calculateBullpenPositionReturnsPerDay,
  type BullpenActivePositionView,
  type BullpenPositionEconomicClassification,
  type BullpenPositionsSnapshotLineage,
} from "./bullpenPositions";
import type {
  BullpenAutoLiveRun,
  BullpenAutoLiveVerifiedPortfolioSnapshot,
} from "@/types/api";

const ACTIVE_CLASSIFICATION = "active";

export type VerifiedBullpenStage1Portfolio = {
  runId: string;
  verifiedAt: string | null;
  activePositions: BullpenActivePositionView[];
  activePositionsTotal: number;
  activePositionsTruncated: boolean;
  claimablePositions: BullpenActivePositionView[];
  settlementPendingPositions: BullpenActivePositionView[];
  excludedPositions: BullpenActivePositionView[];
  cashInHandUsd: number | null;
  occupiedPositions: number;
  availableSlots: number | null;
  maxPositions: number | null;
  tradeAmountUsd: number | null;
  lineage: BullpenPositionsSnapshotLineage | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value !== "string") return false;
  return ["1", "true", "yes", "claimable", "redeemable"].includes(
    value.trim().toLowerCase(),
  );
}

function hasWalletRefreshError(value: unknown) {
  if (value === null || value === undefined || value === false) return false;
  if (typeof value === "string") return Boolean(value.trim());
  return true;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function centsToPrice(value: number | null) {
  if (value === null) return null;
  return value > 1 ? value / 100 : value;
}

function readEventSlugFromMarketUrl(value: unknown) {
  const marketUrl = readString(value);
  if (!marketUrl) return null;
  try {
    const segments = new URL(marketUrl).pathname.split("/").filter(Boolean);
    const eventIndex = segments.indexOf("event");
    return eventIndex >= 0 ? (segments[eventIndex + 1] ?? null) : null;
  } catch {
    return null;
  }
}

function readVerifiedPosition(
  value: unknown,
  expectedClassification: BullpenPositionEconomicClassification = "active",
): BullpenActivePositionView | null {
  if (!value || typeof value !== "object") return null;
  const row = value as Record<string, unknown>;
  const classification = readString(row.classification);
  const claimable = readBoolean(row.is_claimable ?? row.isClaimable);
  if (expectedClassification === ACTIVE_CLASSIFICATION) {
    if ((classification && classification !== ACTIVE_CLASSIFICATION) || claimable) {
      return null;
    }
  } else if (
    classification !== expectedClassification &&
    !(expectedClassification === "positive_payout_claimable" && claimable)
  ) {
    return null;
  }

  const marketId = readString(row.market_id);
  const marketTitle =
    readString(row.market_title) ?? readString(row.question);
  if (!marketId || !marketTitle) return null;

  const rawSide = readString(row.side)?.toUpperCase() ?? "—";
  const heldSide = rawSide === "YES" || rawSide === "NO" ? rawSide : null;
  const shares = Math.max(0, readNumber(row.shares) ?? 0);
  const averagePrice = centsToPrice(readNumber(row.average_price_cents));
  const currentYesOdds = readNumber(row.current_yes_odds);
  const currentNoOdds = readNumber(row.current_no_odds);
  const currentPrice =
    centsToPrice(readNumber(row.current_price_cents)) ??
    centsToPrice(heldSide === "YES" ? currentYesOdds : heldSide === "NO" ? currentNoOdds : null);
  const costBasis =
    readNumber(row.exposure_usd) ??
    (averagePrice !== null ? shares * averagePrice : 0);
  const currentValue =
    readNumber(row.current_value_usd) ??
    (currentPrice !== null ? shares * currentPrice : null);
  const unrealizedPnl =
    currentValue === null ? null : currentValue - costBasis;
  const unrealizedPnlPercent =
    costBasis > 0 && unrealizedPnl !== null
      ? (unrealizedPnl / costBasis) * 100
      : null;
  const closeTime = readString(row.close_time);
  const legacySlug = readString(row.slug);
  const marketSlug = readString(row.market_slug) ?? legacySlug;
  const eventSlug =
    readString(row.event_slug) ??
    readEventSlugFromMarketUrl(row.market_url);

  return {
    key:
      readString(row.position_key) ??
      `${marketId}::${heldSide ?? rawSide}`,
    marketId,
    marketSlug,
    eventSlug,
    slug: marketSlug ?? eventSlug,
    conditionId: readString(row.condition_id),
    marketTitle,
    outcome: rawSide,
    heldSide,
    shares: round(shares, 4),
    averagePrice: averagePrice === null ? null : round(averagePrice, 4),
    costBasis: round(costBasis, 2),
    yesOdds: currentYesOdds,
    noOdds: currentNoOdds,
    bestBidPrice: null,
    bestAskPrice: null,
    currentPrice: currentPrice === null ? null : round(currentPrice, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    expectedPayoutUsd: readNumber(
      row.expected_payout_usdc ?? row.expected_payout_usd,
    ),
    unrealizedPnl:
      unrealizedPnl === null ? null : round(unrealizedPnl, 2),
    unrealizedPnlPercent:
      unrealizedPnlPercent === null ? null : round(unrealizedPnlPercent, 2),
    marketUrl: readString(row.market_url),
    closeTime,
    resolutionStatus: readString(row.resolution_status),
    economicClassification: expectedClassification,
    classificationReason:
      readString(row.classification_reason) ??
      "Verified as economically active by the latest completed Stage 1 Bullpen scan.",
    isClaimable: expectedClassification === "positive_payout_claimable",
    claimableSignal: claimable,
    upstreamRedeemable: readBoolean(row.upstream_redeemable),
    claimableValue: readNumber(row.claimable_value_usd),
    returnsPerDay: calculateBullpenPositionReturnsPerDay({
      closeTime,
      currentPrice,
    }),
    rules: null,
    marketContext: readString(row.theme),
    resolutionSource: "verified-stage1-scan",
  };
}

function timestampMs(value: string | null) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? Number.NEGATIVE_INFINITY : parsed;
}

function buildVerifiedPortfolioLineage({
  accountIdentity,
  credentialInode,
  credentialMtimeNs,
  credentialSize,
  positionClassifierVersion,
  source,
  freshnessState,
}: {
  accountIdentity: unknown;
  credentialInode: unknown;
  credentialMtimeNs: unknown;
  credentialSize: unknown;
  positionClassifierVersion: unknown;
  source: unknown;
  freshnessState: unknown;
}): BullpenPositionsSnapshotLineage {
  return {
    accountIdentity: readString(accountIdentity),
    credentialArtifact: {
      inode: readNumber(credentialInode),
      mtimeNs: readNumber(credentialMtimeNs),
      size: readNumber(credentialSize),
    },
    positionClassifierVersion: readNumber(positionClassifierVersion),
    source: readString(source),
    freshnessState: readString(freshnessState),
  };
}

export function shouldUseVerifiedStage1PortfolioFallback({
  hasActivePositionsSnapshot,
  verifiedPortfolio,
}: {
  hasActivePositionsSnapshot: boolean;
  verifiedPortfolio: VerifiedBullpenStage1Portfolio | null;
}) {
  return !hasActivePositionsSnapshot && verifiedPortfolio !== null;
}

/**
 * Stage 1 and the portfolio panel historically used separate wallet reads. A
 * completed Stage 1 snapshot is the worker-verified source used by Stage 2/3,
 * so the console must reconcile its portfolio count and slot preview to it.
 */
export function resolveLatestVerifiedStage1Portfolio(
  runs: Array<BullpenAutoLiveRun | null | undefined>,
): VerifiedBullpenStage1Portfolio | null {
  const seenRunIds = new Set<string>();
  const candidates: Array<{
    order: number;
    run: BullpenAutoLiveRun;
    stage: BullpenAutoLiveRun["stage_results"][number];
    outputs: Record<string, unknown>;
    verifiedAt: string | null;
  }> = [];

  runs.forEach((run, order) => {
    if (!run || seenRunIds.has(run.id)) return;
    seenRunIds.add(run.id);
    const stages = [...(run.stage_results ?? [])].reverse();
    const stage = stages.find((candidate) => {
      const outputs = candidate.outputs;
      if (!outputs || typeof outputs !== "object") return false;
      const workflowKey = readString(outputs.workflow_stage_key);
      const phaseStatus = readString(outputs.phase_status);
      const isStageOne = candidate.stage_number === 1 || workflowKey === "scan";
      const isComplete =
        Boolean(candidate.completed_at) ||
        phaseStatus === "completed" ||
        (!phaseStatus &&
          (candidate.status === "pass" || candidate.status === "warning"));
      const walletSnapshotStatus = readString(
        outputs.wallet_snapshot_status,
      )?.toLowerCase();
      const walletFreshness = readString(
        outputs.wallet_snapshot_freshness_state ??
          outputs.wallet_freshness_state,
      )?.toLowerCase();
      return (
        isStageOne &&
        isComplete &&
        (candidate.status === "pass" || candidate.status === "warning") &&
        Array.isArray(outputs.active_positions_found) &&
        !readBoolean(outputs.stage2_candidate_only) &&
        !readBoolean(outputs.blocked_by_stage1_wallet_refresh) &&
        !hasWalletRefreshError(outputs.wallet_refresh_error) &&
        !hasWalletRefreshError(outputs.wallet_market_enrichment_error) &&
        walletSnapshotStatus === "fresh" &&
        walletFreshness === "fresh"
      );
    });
    if (!stage || !stage.outputs || typeof stage.outputs !== "object") return;
    candidates.push({
      order,
      run,
      stage,
      outputs: stage.outputs,
      verifiedAt:
        stage.completed_at ?? run.completed_at ?? stage.started_at ?? run.started_at,
    });
  });

  candidates.sort((left, right) => {
    const timestampDelta =
      timestampMs(right.verifiedAt) - timestampMs(left.verifiedAt);
    return timestampDelta || left.order - right.order;
  });
  const latest = candidates[0];
  if (!latest) return null;

  const sourceActivePositions =
    latest.outputs.active_positions_found as unknown[];
  const activePositions = sourceActivePositions
    .map((row) => readVerifiedPosition(row))
    .filter((position): position is BullpenActivePositionView => Boolean(position));
  const claimablePositions = (
    Array.isArray(latest.outputs.available_for_claim)
      ? latest.outputs.available_for_claim
      : []
  )
    .map((row) => readVerifiedPosition(row, "positive_payout_claimable"))
    .filter((position): position is BullpenActivePositionView => Boolean(position));
  const settlementPendingPositions = (
    Array.isArray(latest.outputs.settlement_pending_positions)
      ? latest.outputs.settlement_pending_positions
      : []
  )
    .map((row) => readVerifiedPosition(row, "settlement_pending"))
    .filter((position): position is BullpenActivePositionView => Boolean(position));
  const excludedPositions = (
    Array.isArray(latest.outputs.excluded_position_diagnostics)
      ? latest.outputs.excluded_position_diagnostics
      : []
  )
    .map((row) => {
      const candidate = row as Record<string, unknown>;
      const classification = readString(candidate.classification);
      if (
        classification !== "stale_or_unknown" &&
        classification !== "resolved_zero_payout" &&
        classification !== "closed"
      ) {
        return null;
      }
      return readVerifiedPosition(
        row,
        classification as BullpenPositionEconomicClassification,
      );
    })
    .filter((position): position is BullpenActivePositionView => Boolean(position));
  const maxPositions = readNumber(latest.outputs.console_trade_max_positions);
  const activePositionsTotal = Math.max(
    sourceActivePositions.length,
    readNumber(latest.outputs.active_positions_total) ?? 0,
    readNumber(latest.outputs.console_trade_active_positions) ?? 0,
  );
  const occupiedPositions = Math.max(
    activePositionsTotal,
    readNumber(latest.outputs.console_trade_occupied_positions) ?? 0,
  );
  const availableSlots =
    maxPositions === null
      ? readNumber(latest.outputs.console_trade_available_slots)
      : Math.max(0, maxPositions - occupiedPositions);

  return {
    runId: latest.run.id,
    verifiedAt: latest.verifiedAt,
    activePositions,
    activePositionsTotal,
    activePositionsTruncated: activePositionsTotal > activePositions.length,
    claimablePositions,
    settlementPendingPositions,
    excludedPositions,
    cashInHandUsd: readNumber(
      latest.outputs.console_trade_cash_in_hand_usd,
    ),
    occupiedPositions,
    availableSlots,
    maxPositions,
    tradeAmountUsd: readNumber(latest.outputs.console_trade_amount_usd),
    lineage: buildVerifiedPortfolioLineage({
      accountIdentity: latest.outputs.wallet_account_identity,
      credentialInode: latest.outputs.wallet_credential_artifact_inode,
      credentialMtimeNs:
        latest.outputs.wallet_credential_artifact_mtime_ns,
      credentialSize: latest.outputs.wallet_credential_artifact_size,
      positionClassifierVersion:
        latest.outputs.wallet_position_classifier_version ??
        latest.outputs.position_classifier_version,
      source: latest.outputs.wallet_source,
      freshnessState:
        latest.outputs.wallet_snapshot_freshness_state ??
        latest.outputs.wallet_freshness_state,
    }),
  };
}

export function resolveVerifiedStage1PortfolioSnapshot(
  snapshot: BullpenAutoLiveVerifiedPortfolioSnapshot | null | undefined,
): VerifiedBullpenStage1Portfolio | null {
  if (!snapshot?.run_id || !snapshot.verified_at) return null;
  const freshness = readString(snapshot.wallet_freshness_state)?.toLowerCase();
  if (freshness !== "fresh") return null;
  const activePositions = (snapshot.active_positions ?? [])
    .map((row) => readVerifiedPosition(row))
    .filter((position): position is BullpenActivePositionView =>
      Boolean(position),
    );
  const claimablePositions = (snapshot.claimable_positions ?? [])
    .map((row) => readVerifiedPosition(row, "positive_payout_claimable"))
    .filter((position): position is BullpenActivePositionView =>
      Boolean(position),
    );
  const settlementPendingPositions = (
    snapshot.settlement_pending_positions ?? []
  )
    .map((row) => readVerifiedPosition(row, "settlement_pending"))
    .filter((position): position is BullpenActivePositionView =>
      Boolean(position),
    );
  const excludedPositions = (snapshot.excluded_positions ?? [])
    .map((row) => {
      const classification = readString(row.classification);
      if (
        classification !== "stale_or_unknown" &&
        classification !== "resolved_zero_payout" &&
        classification !== "closed"
      ) {
        return null;
      }
      return readVerifiedPosition(
        row,
        classification as BullpenPositionEconomicClassification,
      );
    })
    .filter((position): position is BullpenActivePositionView =>
      Boolean(position),
    );
  const maxPositions = readNumber(snapshot.max_positions);
  const activePositionsTotal = Math.max(
    activePositions.length,
    readNumber(snapshot.active_positions_total) ?? 0,
  );
  const occupiedPositions = Math.max(
    activePositionsTotal,
    readNumber(snapshot.occupied_positions) ?? 0,
  );
  return {
    runId: snapshot.run_id,
    verifiedAt: snapshot.verified_at,
    activePositions,
    activePositionsTotal,
    activePositionsTruncated:
      Boolean(snapshot.active_positions_truncated) ||
      activePositionsTotal > activePositions.length,
    claimablePositions,
    settlementPendingPositions,
    excludedPositions,
    cashInHandUsd: readNumber(snapshot.cash_in_hand_usd),
    occupiedPositions,
    availableSlots:
      maxPositions === null
        ? readNumber(snapshot.available_slots)
        : Math.max(0, maxPositions - occupiedPositions),
    maxPositions,
    tradeAmountUsd: readNumber(snapshot.trade_amount_usd),
    lineage: buildVerifiedPortfolioLineage({
      accountIdentity: snapshot.wallet_account_identity,
      credentialInode: snapshot.wallet_credential_artifact_inode,
      credentialMtimeNs: snapshot.wallet_credential_artifact_mtime_ns,
      credentialSize: snapshot.wallet_credential_artifact_size,
      positionClassifierVersion: snapshot.position_classifier_version,
      source: snapshot.wallet_source,
      freshnessState: snapshot.wallet_freshness_state,
    }),
  };
}

export function selectLatestVerifiedStage1Portfolio(
  candidates: Array<VerifiedBullpenStage1Portfolio | null | undefined>,
): VerifiedBullpenStage1Portfolio | null {
  return (
    candidates
      .filter(
        (
          candidate,
        ): candidate is VerifiedBullpenStage1Portfolio => Boolean(candidate),
      )
      .sort(
        (left, right) =>
          timestampMs(right.verifiedAt) - timestampMs(left.verifiedAt),
      )[0] ?? null
  );
}
