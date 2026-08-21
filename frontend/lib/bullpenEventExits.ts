import type { BullpenQuestionRow } from "@/lib/bullpen-ai";
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";

export type BullpenExitStrategy =
  | "OUTSIDE_TOP_10_RETURNS_DAY"
  | "LLM_OR_ODDS_FILTER_EXIT"
  | "CAPITAL_AWARE_FORCED_EXIT";

export type BullpenExitSeverity =
  | "INFO"
  | "WATCH_FAST"
  | "PLANNED_EXIT"
  | "IMMEDIATE_EXIT"
  | "DUST_LOST";

export type BullpenExitReasonCode =
  | "OUTSIDE_TOP_10_BY_RETURNS_DAY"
  | "LLM_FILTER_FAILED"
  | "ODDS_FILTER_FAILED"
  | "ADVERSE_MARKET_99_5"
  | "ADVERSE_MARKET_99"
  | "HELD_SIDE_BID_BELOW_0_5_CENTS"
  | "HELD_SIDE_DROP_10_POINTS_1M"
  | "HELD_SIDE_DROP_15_POINTS_1M"
  | "HELD_SIDE_DROP_25_POINTS_5M"
  | "EVENT_CLOSE_PASSED"
  | "LOW_EXECUTABLE_VALUE"
  | "NO_BID_AVAILABLE";

export type BullpenExitState =
  | "ACTIVE"
  | "WATCH_FAST"
  | "EVENT_EXIT_PLANNED"
  | "SELL_SUBMITTED"
  | "PARTIALLY_FILLED"
  | "SOLD"
  | "DUST_LOST"
  | "FAILED";

export type BullpenExitSignal = {
  strategy: BullpenExitStrategy;
  severity: BullpenExitSeverity;
  reasonCode: BullpenExitReasonCode;
  label: string;
  description: string;
  score?: number;
  createdAt: string;
  metrics?: {
    currentYes?: number;
    currentNo?: number;
    heldProbability?: number;
    adverseProbability?: number;
    heldBestBid?: number;
    shares?: number;
    avgPrice?: number;
    estimatedFreeableValue?: number;
    drop1m?: number;
    drop5m?: number;
    adverseRise1m?: number;
    adverseRise5m?: number;
    timeToCloseHours?: number;
  };
};

export type BullpenPositionPriceSnapshot = {
  positionId: string;
  marketId: string;
  tokenId: string;
  timestamp: string;
  currentYes: number;
  currentNo: number;
  heldProbability: number;
  adverseProbability: number;
  heldBestBid?: number;
};

export type BullpenEventExitEvaluation = {
  exitSignals: BullpenExitSignal[];
  exitState: BullpenExitState;
  estimatedFreeableValue: number | null;
};

type BullpenForcedExitConfig = {
  immediateAdverseProbability: number;
  confirmedAdverseProbability: number;
  confirmedHeldProbabilityMax: number;
  heldBestBidDustThreshold: number;
  watchFastAdverseProbability: number;
  watchFastDrop1m: number;
  momentumForcedDrop1m: number;
  momentumForcedAdverseProbability: number;
  momentumForcedDrop5m: number;
  momentumForced5mAdverseProbability: number;
  scorePlannedExit: number;
  scoreWatchFast: number;
  minNetProceeds: number;
  minSnapshotsForConfirmedExit: number;
  confirmationWindowSeconds: number;
};

const DEFAULT_FORCED_EXIT_CONFIG: BullpenForcedExitConfig = {
  immediateAdverseProbability: 0.995,
  confirmedAdverseProbability: 0.99,
  confirmedHeldProbabilityMax: 0.01,
  heldBestBidDustThreshold: 0.005,
  watchFastAdverseProbability: 0.9,
  watchFastDrop1m: -0.1,
  momentumForcedDrop1m: -0.15,
  momentumForcedAdverseProbability: 0.85,
  momentumForcedDrop5m: -0.25,
  momentumForced5mAdverseProbability: 0.8,
  scorePlannedExit: 85,
  scoreWatchFast: 60,
  minNetProceeds: 0.01,
  minSnapshotsForConfirmedExit: 2,
  confirmationWindowSeconds: 15,
};

function round(value: number | null | undefined, digits = 4) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return undefined;
  }
  return Number(value.toFixed(digits));
}

function clampProbability(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return Math.min(1, Math.max(0, value));
}

function probabilityFromOddsPercent(value: number | null | undefined) {
  if (value === null || value === undefined || Number.isNaN(value)) {
    return null;
  }
  return clampProbability(value / 100);
}

function normalizeHeldSide(outcome: string) {
  const normalized = outcome.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO") {
    return normalized;
  }
  return null;
}

function strongerLlmSide(question: BullpenQuestionRow | null | undefined) {
  const yes = question?.llmYesOdds ?? null;
  const no = question?.llmNoOdds ?? null;
  if (yes === null && no === null) return null;
  if ((yes ?? -Infinity) < 80 && (no ?? -Infinity) < 80) return null;
  return (yes ?? -Infinity) >= (no ?? -Infinity) ? "YES" : "NO";
}

function heldProbabilityForSide({
  heldSide,
  yesProbability,
  noProbability,
}: {
  heldSide: "YES" | "NO" | null;
  yesProbability: number | null;
  noProbability: number | null;
}) {
  if (heldSide === "YES") return yesProbability;
  if (heldSide === "NO") return noProbability;
  return null;
}

function adverseProbabilityForSide({
  heldSide,
  yesProbability,
  noProbability,
}: {
  heldSide: "YES" | "NO" | null;
  yesProbability: number | null;
  noProbability: number | null;
}) {
  if (heldSide === "YES") return noProbability;
  if (heldSide === "NO") return yesProbability;
  return null;
}

function heldBestBidForPosition(position: BullpenActivePositionView) {
  const heldSide = normalizeHeldSide(position.outcome);
  if (heldSide === "YES") {
    return position.bestBidPrice ?? position.currentPrice ?? null;
  }
  if (heldSide === "NO") {
    if (position.bestAskPrice !== null && position.bestAskPrice !== undefined) {
      return clampProbability(1 - position.bestAskPrice);
    }
    return position.currentPrice ?? null;
  }
  return null;
}

function estimatedFreeableValue(
  position: BullpenActivePositionView,
  heldBestBid: number | null,
) {
  if (heldBestBid === null) return null;
  return Number(Math.max(0, position.shares * heldBestBid).toFixed(6));
}

function timeToCloseHours(closeTime: string | null, now: Date) {
  if (!closeTime) return null;
  const parsed = new Date(closeTime);
  if (Number.isNaN(parsed.getTime())) return null;
  return (parsed.getTime() - now.getTime()) / (1000 * 60 * 60);
}

function signal(
  {
    strategy,
    severity,
    reasonCode,
    label,
    description,
    score,
    metrics,
    createdAt,
  }: BullpenExitSignal,
) {
  return {
    strategy,
    severity,
    reasonCode,
    label,
    description,
    score: round(score ?? null, 2),
    createdAt,
    metrics,
  } satisfies BullpenExitSignal;
}

export function dedupeBullpenExitSignals(signals: BullpenExitSignal[]) {
  const severityRank: Record<BullpenExitSeverity, number> = {
    INFO: 0,
    WATCH_FAST: 1,
    PLANNED_EXIT: 2,
    IMMEDIATE_EXIT: 3,
    DUST_LOST: 4,
  };
  const deduped = new Map<string, BullpenExitSignal>();

  for (const current of signals) {
    const key = `${current.strategy}::${current.reasonCode}`;
    const existing = deduped.get(key);
    if (
      !existing ||
      severityRank[current.severity] > severityRank[existing.severity]
    ) {
      deduped.set(key, current);
    }
  }

  return [...deduped.values()];
}

export function deriveBullpenExitState(signals: BullpenExitSignal[]): BullpenExitState {
  if (signals.length === 0) return "ACTIVE";
  const severities = new Set(signals.map((signal) => signal.severity));
  if (severities.has("DUST_LOST")) return "DUST_LOST";
  if (severities.has("IMMEDIATE_EXIT") || severities.has("PLANNED_EXIT")) {
    return "EVENT_EXIT_PLANNED";
  }
  if (signals.every((signal) => signal.severity === "WATCH_FAST")) {
    return "WATCH_FAST";
  }
  return "ACTIVE";
}

function pickLookbackSnapshot(
  history: BullpenPositionPriceSnapshot[],
  {
    referenceTime,
    targetSeconds,
  }: {
    referenceTime: Date;
    targetSeconds: number;
  },
) {
  const eligible = history
    .map((snapshot) => {
      const parsed = Date.parse(snapshot.timestamp);
      if (!Number.isFinite(parsed)) return null;
      const deltaSeconds = (referenceTime.getTime() - parsed) / 1000;
      if (deltaSeconds < targetSeconds) return null;
      return {
        distance: Math.abs(deltaSeconds - targetSeconds),
        snapshot,
      };
    })
    .filter((item): item is { distance: number; snapshot: BullpenPositionPriceSnapshot } => Boolean(item))
    .sort((left, right) => left.distance - right.distance);

  return eligible[0]?.snapshot ?? null;
}

function confirmedAdverseSnapshots(
  history: BullpenPositionPriceSnapshot[],
  config: BullpenForcedExitConfig,
) {
  const qualifying = history
    .filter(
      (snapshot) =>
        snapshot.adverseProbability >= config.confirmedAdverseProbability &&
        snapshot.heldProbability <= config.confirmedHeldProbabilityMax,
    )
    .map((snapshot) => Date.parse(snapshot.timestamp))
    .filter((value) => Number.isFinite(value))
    .sort((left, right) => left - right);

  if (qualifying.length < config.minSnapshotsForConfirmedExit) {
    return false;
  }

  return (
    (qualifying[qualifying.length - 1] ?? 0) - (qualifying[0] ?? 0)
  ) >= config.confirmationWindowSeconds * 1000;
}

function scoreReasonCode({
  eventClosePassed,
  hasBid,
  estimatedFreeableValue,
  adverseProbability,
}: {
  eventClosePassed: boolean;
  hasBid: boolean;
  estimatedFreeableValue: number | null;
  adverseProbability: number | null;
}): BullpenExitReasonCode {
  if (!hasBid) return "NO_BID_AVAILABLE";
  if (estimatedFreeableValue !== null && estimatedFreeableValue < 0.01) {
    return "LOW_EXECUTABLE_VALUE";
  }
  if (eventClosePassed) return "EVENT_CLOSE_PASSED";
  if (adverseProbability !== null && adverseProbability >= 0.99) {
    return "ADVERSE_MARKET_99";
  }
  return "LOW_EXECUTABLE_VALUE";
}

export function evaluateBullpenEventExits({
  position,
  question,
  topActivePositionKeys,
  priceHistory = [],
  now = new Date(),
}: {
  position: BullpenActivePositionView;
  question: BullpenQuestionRow | null | undefined;
  topActivePositionKeys: Set<string>;
  priceHistory?: BullpenPositionPriceSnapshot[];
  now?: Date;
}): BullpenEventExitEvaluation {
  const createdAt = now.toISOString();
  const heldSide = normalizeHeldSide(position.outcome);
  const currentYes = probabilityFromOddsPercent(position.yesOdds);
  const currentNo = probabilityFromOddsPercent(position.noOdds);
  const heldProbability = heldProbabilityForSide({
    heldSide,
    yesProbability: currentYes,
    noProbability: currentNo,
  });
  const adverseProbability = adverseProbabilityForSide({
    heldSide,
    yesProbability: currentYes,
    noProbability: currentNo,
  });
  const heldBestBid = heldBestBidForPosition(position);
  const estimatedFreeable = estimatedFreeableValue(position, heldBestBid);
  const llmHeldProbability = heldProbabilityForSide({
    heldSide,
    yesProbability: probabilityFromOddsPercent(question?.llmYesOdds ?? null),
    noProbability: probabilityFromOddsPercent(question?.llmNoOdds ?? null),
  });
  const metrics = {
    currentYes: round(currentYes),
    currentNo: round(currentNo),
    heldProbability: round(heldProbability),
    adverseProbability: round(adverseProbability),
    heldBestBid: round(heldBestBid),
    shares: round(position.shares, 6),
    avgPrice: round(position.averagePrice),
    estimatedFreeableValue: round(estimatedFreeable),
    timeToCloseHours: round(timeToCloseHours(position.closeTime, now), 2),
  };

  const rankingSignals: BullpenExitSignal[] = [];
  if (!topActivePositionKeys.has(position.key)) {
    rankingSignals.push(
      signal({
        strategy: "OUTSIDE_TOP_10_RETURNS_DAY",
        severity: "PLANNED_EXIT",
        reasonCode: "OUTSIDE_TOP_10_BY_RETURNS_DAY",
        label: "Outside Top 10",
        description:
          "Position is outside the top 10 by Returns/day and may be sold to free capital.",
        createdAt,
      }),
    );
  }
  if (heldSide && strongerLlmSide(question) !== heldSide) {
    rankingSignals.push(
      signal({
        strategy: "LLM_OR_ODDS_FILTER_EXIT",
        severity: "PLANNED_EXIT",
        reasonCode: "LLM_FILTER_FAILED",
        label: "LLM / Odds Filter Exit",
        description:
          "Position no longer passes the LLM or odds requirements for active Bullpen positions.",
        createdAt,
      }),
    );
  }
  if (
    currentYes === null ||
    currentNo === null ||
    currentYes < 0.05 ||
    currentNo < 0.05
  ) {
    rankingSignals.push(
      signal({
        strategy: "LLM_OR_ODDS_FILTER_EXIT",
        severity: "PLANNED_EXIT",
        reasonCode: "ODDS_FILTER_FAILED",
        label: "LLM / Odds Filter Exit",
        description:
          "Position no longer passes the LLM or odds requirements for active Bullpen positions.",
        createdAt,
      }),
    );
  }

  if (heldProbability === null || adverseProbability === null) {
    const dedupedRankingSignals = dedupeBullpenExitSignals(rankingSignals);
    return {
      exitSignals: dedupedRankingSignals,
      exitState: deriveBullpenExitState(dedupedRankingSignals),
      estimatedFreeableValue: estimatedFreeable,
    };
  }

  const snapshotNow: BullpenPositionPriceSnapshot = {
    positionId: position.key,
    marketId: position.marketId,
    tokenId: position.conditionId ?? position.key,
    timestamp: createdAt,
    currentYes: round(currentYes) ?? 0,
    currentNo: round(currentNo) ?? 0,
    heldProbability: round(heldProbability) ?? 0,
    adverseProbability: round(adverseProbability) ?? 0,
    heldBestBid: round(heldBestBid),
  };
  const dedupedHistoryMap = new Map<string, BullpenPositionPriceSnapshot>();
  for (const snapshot of priceHistory.filter(
    (snapshot) => snapshot.positionId === position.key,
  )) {
    dedupedHistoryMap.set(snapshot.timestamp, snapshot);
  }
  dedupedHistoryMap.set(snapshotNow.timestamp, snapshotNow);
  const mergedHistory = [...dedupedHistoryMap.values()].sort(
    (left, right) => Date.parse(left.timestamp) - Date.parse(right.timestamp),
  );
  const snapshot1m = pickLookbackSnapshot(mergedHistory, {
    referenceTime: now,
    targetSeconds: 60,
  });
  const snapshot5m = pickLookbackSnapshot(mergedHistory, {
    referenceTime: now,
    targetSeconds: 300,
  });
  const drop1m =
    snapshot1m ? heldProbability - snapshot1m.heldProbability : null;
  const drop5m =
    snapshot5m ? heldProbability - snapshot5m.heldProbability : null;
  const adverseRise1m =
    snapshot1m ? adverseProbability - snapshot1m.adverseProbability : null;
  const adverseRise5m =
    snapshot5m ? adverseProbability - snapshot5m.adverseProbability : null;
  const timeToClose = timeToCloseHours(position.closeTime, now);
  const eventClosePassed = timeToClose !== null && timeToClose <= 0;
  const hasBid = heldBestBid !== null && heldBestBid > 0;

  const forcedMetrics = {
    ...metrics,
    drop1m: round(drop1m),
    drop5m: round(drop5m),
    adverseRise1m: round(adverseRise1m),
    adverseRise5m: round(adverseRise5m),
  };
  const forcedSignals: BullpenExitSignal[] = [];

  if (adverseProbability >= DEFAULT_FORCED_EXIT_CONFIG.immediateAdverseProbability) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "IMMEDIATE_EXIT",
        reasonCode: "ADVERSE_MARKET_99_5",
        label: "Forced Exit: 99.5% Against Us",
        description:
          "Market odds are effectively resolved against the held outcome. Move this position to Event Exits immediately.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  if (
    heldBestBid !== null &&
    heldBestBid <= DEFAULT_FORCED_EXIT_CONFIG.heldBestBidDustThreshold
  ) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity:
          estimatedFreeable === null ||
          estimatedFreeable < DEFAULT_FORCED_EXIT_CONFIG.minNetProceeds
            ? "DUST_LOST"
            : "IMMEDIATE_EXIT",
        reasonCode: "HELD_SIDE_BID_BELOW_0_5_CENTS",
        label: "Forced Exit: Held Side Below 0.5c",
        description:
          "The held outcome has almost no executable bid value. Exit if executable, otherwise mark as dust.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  if (
    confirmedAdverseSnapshots(mergedHistory, DEFAULT_FORCED_EXIT_CONFIG)
  ) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "IMMEDIATE_EXIT",
        reasonCode: "ADVERSE_MARKET_99",
        label: "Forced Exit: Confirmed 99% Against Us",
        description:
          "The position has remained virtually lost across multiple snapshots.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  if (
    (drop1m !== null && drop1m <= DEFAULT_FORCED_EXIT_CONFIG.watchFastDrop1m) ||
    adverseProbability >= DEFAULT_FORCED_EXIT_CONFIG.watchFastAdverseProbability
  ) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "WATCH_FAST",
        reasonCode:
          drop1m !== null && drop1m <= DEFAULT_FORCED_EXIT_CONFIG.watchFastDrop1m
            ? "HELD_SIDE_DROP_10_POINTS_1M"
            : "ADVERSE_MARKET_99",
        label: "Watch Fast",
        description:
          "Held-side odds are deteriorating quickly. Refresh this position more frequently.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  if (
    drop1m !== null &&
    drop1m <= DEFAULT_FORCED_EXIT_CONFIG.momentumForcedDrop1m &&
    adverseProbability >=
      DEFAULT_FORCED_EXIT_CONFIG.momentumForcedAdverseProbability
  ) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "PLANNED_EXIT",
        reasonCode: "HELD_SIDE_DROP_15_POINTS_1M",
        label: "Forced Exit: Fast 1m Collapse",
        description:
          "Held-side odds dropped by at least 15 percentage points in one minute and the market is now heavily against us.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  if (
    drop5m !== null &&
    drop5m <= DEFAULT_FORCED_EXIT_CONFIG.momentumForcedDrop5m &&
    adverseProbability >=
      DEFAULT_FORCED_EXIT_CONFIG.momentumForced5mAdverseProbability
  ) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "PLANNED_EXIT",
        reasonCode: "HELD_SIDE_DROP_25_POINTS_5M",
        label: "Forced Exit: 5m Collapse",
        description:
          "Held-side odds dropped by at least 25 percentage points in five minutes and the market is now heavily against us.",
        createdAt,
        metrics: forcedMetrics,
      }),
    );
  }

  let score = 0;
  if (adverseProbability >= 0.995) score += 100;
  else if (adverseProbability >= 0.99) score += 75;
  else if (adverseProbability >= 0.95) score += 45;
  else if (adverseProbability >= 0.9) score += 25;

  if (adverseRise1m !== null && adverseRise1m >= 0.1) score += 20;
  if (adverseRise5m !== null && adverseRise5m >= 0.2) score += 20;

  if (eventClosePassed) score += 25;
  else if (timeToClose !== null && timeToClose <= 6) score += 10;

  if (
    heldBestBid !== null &&
    heldBestBid <= DEFAULT_FORCED_EXIT_CONFIG.heldBestBidDustThreshold
  ) {
    score += 20;
  }
  if (
    estimatedFreeable !== null &&
    estimatedFreeable >= DEFAULT_FORCED_EXIT_CONFIG.minNetProceeds
  ) {
    score += 10;
  }
  if (
    !hasBid ||
    (estimatedFreeable !== null &&
      estimatedFreeable < DEFAULT_FORCED_EXIT_CONFIG.minNetProceeds)
  ) {
    score -= 15;
  }

  if (llmHeldProbability !== null && llmHeldProbability <= 0.2) {
    score += 10;
  }

  if (score >= DEFAULT_FORCED_EXIT_CONFIG.scorePlannedExit) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "PLANNED_EXIT",
        reasonCode: scoreReasonCode({
          eventClosePassed,
          hasBid,
          estimatedFreeableValue: estimatedFreeable,
          adverseProbability,
        }),
        label: "Capital-Aware Forced Exit",
        description:
          "Position is losing executable value based on adverse odds, momentum, time-to-close, and liquidity.",
        createdAt,
        score,
        metrics: forcedMetrics,
      }),
    );
  } else if (score >= DEFAULT_FORCED_EXIT_CONFIG.scoreWatchFast) {
    forcedSignals.push(
      signal({
        strategy: "CAPITAL_AWARE_FORCED_EXIT",
        severity: "WATCH_FAST",
        reasonCode: scoreReasonCode({
          eventClosePassed,
          hasBid,
          estimatedFreeableValue: estimatedFreeable,
          adverseProbability,
        }),
        label: "Capital-Aware Forced Exit",
        description:
          "Position is losing executable value based on adverse odds, momentum, time-to-close, and liquidity.",
        createdAt,
        score,
        metrics: forcedMetrics,
      }),
    );
  }

  const exitSignals = dedupeBullpenExitSignals([
    ...rankingSignals,
    ...forcedSignals,
  ]);

  return {
    exitSignals,
    exitState: deriveBullpenExitState(exitSignals),
    estimatedFreeableValue: estimatedFreeable,
  };
}

export function getBullpenEventExitBadgeLabel(signal: BullpenExitSignal) {
  if (signal.reasonCode === "OUTSIDE_TOP_10_BY_RETURNS_DAY") return "Outside Top 10";
  if (signal.reasonCode === "LLM_FILTER_FAILED") return "LLM Filter";
  if (signal.reasonCode === "ODDS_FILTER_FAILED") return "Odds Filter";
  if (signal.reasonCode === "ADVERSE_MARKET_99_5") return "99.5% Against Us";
  if (signal.reasonCode === "ADVERSE_MARKET_99") {
    return signal.severity === "WATCH_FAST" ? "Watch Fast" : "99% Against Us";
  }
  if (signal.reasonCode === "HELD_SIDE_BID_BELOW_0_5_CENTS") {
    return signal.severity === "DUST_LOST" ? "Dust" : "Held Bid < 0.5c";
  }
  if (signal.reasonCode === "HELD_SIDE_DROP_10_POINTS_1M") return "Watch Fast";
  if (signal.reasonCode === "HELD_SIDE_DROP_15_POINTS_1M") return "Fast Collapse";
  if (signal.reasonCode === "HELD_SIDE_DROP_25_POINTS_5M") return "5m Collapse";
  if (signal.reasonCode === "EVENT_CLOSE_PASSED") return "Event Closed";
  if (signal.reasonCode === "NO_BID_AVAILABLE") return "No Bid";
  if (signal.reasonCode === "LOW_EXECUTABLE_VALUE") return "Low Value";
  return signal.label;
}
