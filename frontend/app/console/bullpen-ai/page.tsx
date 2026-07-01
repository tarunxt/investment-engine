"use client";

import { useEffect, useEffectEvent, useRef, useState } from "react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ExternalLink,
  FileText,
  Loader2,
  Menu,
  RefreshCw,
} from "lucide-react";

import { EventScanRunControls } from "@/components/shared/EventScanRunControls";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  archiveBullpenScanSnapshot,
  BULLPEN_SOURCE_URLS,
  buildBullpenLlmPrompt,
  buildBullpenLlmPromptInputs,
  buildBullpenScanQueryParams,
  computeBullpenLlmConsensus,
  createBullpenQuestionRow,
  createBullpenScanFilters,
  createBullpenScanSnapshot,
  DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
  getBullpenQuestionRuntimeMetadata,
  isBullpenQuestionInvestmentCandidate,
  LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES,
  normalizeBullpenScanFilters,
  normalizePolymarketEventRuntimeMetadata,
  parseBullpenLlmAnalysisPayload,
  summarizeBullpenLlmNotes,
  type BullpenQuestionLlmBreakdownItem,
  type BullpenQuestionRow,
  type BullpenScanFilters,
  type BullpenScanSnapshot,
  type BullpenSnapshotHistory,
  type ScanMode,
  type ScanResult,
  validateBullpenStaleFacts,
} from "@/lib/bullpen-ai";
import {
  BULLPEN_SCAN_FILTER_DETAILS,
  type BullpenScanFilterDetailId,
} from "@/lib/bullpenScanExclusions";
import {
  buildBullpenLlmTargetId,
  buildBullpenLlmRunTargetSet,
  buildBullpenQuestionRowFromActivePosition,
  extractBullpenActivePositionLlmAnalysis,
  type BullpenActivePositionLlmAnalysis,
} from "@/lib/bullpenActivePositions";
import { formatApiErrorSummary, formatUnknownError } from "@/lib/apiErrors";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { formatApiTimestamp } from "@/lib/datetime";
import { getResolvedProviderInternetAccess } from "@/lib/llmInternetAccess";
import { cn } from "@/lib/utils";
import { URLs } from "@/lib/urls";
import { APIError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveRunOnceRequest,
  PolymarketEventRunContext,
  PolymarketManualInvestOrderRequest,
  PolymarketManualInvestResponse,
  ProviderInfo,
  ProviderModelTarget,
  RunResponse,
} from "@/types/api";

import {
  BullpenQuestionsTable,
  type BullpenTableSortKey,
  type BullpenTableSortState,
} from "./_components/BullpenQuestionsTable";
import { BullpenAutoRunScheduleCard } from "./_components/BullpenAutoRunScheduleCard";
import { BullpenInvestmentsSection } from "./_components/BullpenInvestmentsSection";
import { BullpenScanFilterDetailsDialog } from "./_components/BullpenScanFilterDetailsDialog";
import { BullpenPromptEditorDialog } from "./_components/BullpenPromptEditorDialog";
import {
  syncBullpenAutoRunActivePositionAnalyses,
  syncBullpenAutoRunSummarySnapshots,
} from "./_components/bullpenAutoRunSync";
import {
  buildClaimableBullpenSignature,
  buildBullpenCloseTimeFromDateOnly,
  calculateBullpenPositionReturnsPerDay,
  type BullpenActivePositionView,
  type BullpenLiveHealth,
  type BullpenLiveSnapshot,
  type BullpenPositionsFallback,
  type BullpenPositionsResponse,
  type BullpenPositionsSource,
} from "@/lib/bullpenPositions";

const TABS: {
  mode: ScanMode;
  label: string;
  href: string;
}[] = [
  {
    mode: "30-days",
    label: "30 days",
    href: URLs.routes.console.bullpenAi30Days(),
  },
  {
    mode: "end-of-month",
    label: "End of Month",
    href: URLs.routes.console.bullpenAiEndOfMonth(),
  },
];

const BULLPEN_SNAPSHOT_STORAGE_KEY = "investment-engine:bullpen-ai:snapshots:v1";
const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investment-engine:bullpen-ai:last-llm-target:v1";
const BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY =
  "investment-engine:bullpen-ai:active-position-llm:v1";
const BULLPEN_LLM_PROMPT_STORAGE_KEY =
  "investment-engine:bullpen-ai:llm-prompt-template:v1";
const BULLPEN_REQUIRE_FRESH_EVIDENCE_STORAGE_KEY =
  "investment-engine:bullpen-ai:require-fresh-evidence:v1";
const BULLPEN_ALLOW_NON_WEB_EVIDENCE_STORAGE_KEY =
  "investment-engine:bullpen-ai:allow-non-web-evidence:v1";
const MAX_BULLPEN_SNAPSHOT_HISTORY = 10;
const RUN_POLL_INTERVAL_MS = 4_000;
const MAX_RUN_POLLS = 90;
const AUTO_CLAIM_RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_SORT_STATE: BullpenTableSortState = {
  key: "closeTime",
  direction: "asc",
};
const INVESTMENT_PROGRESS_POLL_MS = 1_500;

type PolymarketMarketRefresh = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  yesOdds: number | null;
  noOdds: number | null;
  rules: string | null;
  marketContext: string | null;
  resolutionSource: string | null;
};

type BullpenCurrentOddsRefreshResponse = {
  markets?: Record<string, PolymarketMarketRefresh>;
  unresolvedQuestionIds?: string[];
  error?: string;
};

type BullpenAutoClaimAttempt = {
  signature: string;
  attemptedAt: number;
};

type RefreshBullpenPositionsResult = {
  positions: BullpenActivePositionView[];
  error: string | null;
};

const MONTH_INDEX_BY_NAME: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
};

function normalizeQuestionTitle(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function extractCloseTimeFromMarketTitle(value: string) {
  const matchedDate =
    value.match(
      /\b(?:by|on|before|after|through|until)\s+([A-Z][a-z]+ \d{1,2}, \d{4})\b/i,
    )?.[1] || value.match(/\b([A-Z][a-z]+ \d{1,2}, \d{4})\b/)?.[1];
  if (!matchedDate) return null;

  const match = matchedDate.match(
    /^([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})$/,
  );
  const monthName = match?.[1] || null;
  const day = match?.[2]?.padStart(2, "0");
  const year = match?.[3] || null;
  const month = monthName ? MONTH_INDEX_BY_NAME[monthName.toLowerCase()] : null;
  if (!month || !day || !year) return matchedDate;

  return buildBullpenCloseTimeFromDateOnly(`${year}-${month}-${day}`) || matchedDate;
}

function createEmptySnapshotHistory(): Record<ScanMode, BullpenSnapshotHistory> {
  return {
    "30-days": { current: null, history: [] },
    "end-of-month": { current: null, history: [] },
  };
}

function createEmptySelectionMap(): Record<ScanMode, string[]> {
  return {
    "30-days": [],
    "end-of-month": [],
  };
}

function createEmptySortMap(): Record<ScanMode, BullpenTableSortState> {
  return {
    "30-days": { ...DEFAULT_SORT_STATE },
    "end-of-month": { ...DEFAULT_SORT_STATE },
  };
}

function createEmptySnapshotViewMap(): Record<ScanMode, string | null> {
  return {
    "30-days": null,
    "end-of-month": null,
  };
}

function hasSavedBullpenActivePositionAnalysis(
  analysis: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  return Boolean(
    analysis &&
      (analysis.llmYesOdds !== null ||
        analysis.llmNoOdds !== null ||
        analysis.llmCompletedAt ||
        analysis.llmBreakdown.length > 0),
  );
}

function getBullpenActivePositionAnalysisCapturedAt(
  analysis: Pick<
    BullpenActivePositionLlmAnalysis,
    "llmCompletedAt" | "llmBreakdown"
  >,
) {
  if (analysis.llmCompletedAt) return analysis.llmCompletedAt;

  return (
    [...analysis.llmBreakdown]
      .map((entry) => entry.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) || null
  );
}

function getBullpenActivePositionAnalysisTimestampMs(
  analysis: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  if (!analysis) return 0;
  const capturedAt = getBullpenActivePositionAnalysisCapturedAt(analysis);
  if (!capturedAt) return 0;

  const timestampMs = Date.parse(capturedAt);
  return Number.isFinite(timestampMs) ? timestampMs : 0;
}

function pickNewerBullpenActivePositionAnalysis(
  left: BullpenActivePositionLlmAnalysis | null | undefined,
  right: BullpenActivePositionLlmAnalysis | null | undefined,
) {
  const normalizedLeft = hasSavedBullpenActivePositionAnalysis(left) ? left : null;
  const normalizedRight = hasSavedBullpenActivePositionAnalysis(right)
    ? right
    : null;

  if (!normalizedLeft) return normalizedRight;
  if (!normalizedRight) return normalizedLeft;

  return getBullpenActivePositionAnalysisTimestampMs(normalizedRight) >
    getBullpenActivePositionAnalysisTimestampMs(normalizedLeft)
    ? normalizedRight
    : normalizedLeft;
}

function buildSnapshotBackfilledActivePositionAnalyses(
  snapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>,
) {
  const analysesByTargetId = new Map<string, BullpenActivePositionLlmAnalysis>();

  for (const mode of ["30-days", "end-of-month"] as const) {
    const snapshots = [
      snapshotsByMode[mode].current,
      ...snapshotsByMode[mode].history,
    ].filter((snapshot): snapshot is BullpenScanSnapshot => Boolean(snapshot));

    for (const snapshot of snapshots) {
      for (const question of snapshot.questions) {
        const analysis = extractBullpenActivePositionLlmAnalysis(question);
        if (!hasSavedBullpenActivePositionAnalysis(analysis)) continue;

        const targetId = buildBullpenLlmTargetId(question);
        const current = analysesByTargetId.get(targetId);
        const newer = pickNewerBullpenActivePositionAnalysis(current, analysis);
        if (newer) {
          analysesByTargetId.set(targetId, newer);
        }
      }
    }
  }

  return analysesByTargetId;
}

function buildMergedActivePositionAnalyses({
  activePositions,
  currentAnalyses,
  snapshotsByMode,
}: {
  activePositions: BullpenActivePositionView[];
  currentAnalyses: Record<string, BullpenActivePositionLlmAnalysis>;
  snapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>;
}) {
  const next: Record<string, BullpenActivePositionLlmAnalysis> = {};
  const snapshotAnalysesByTargetId =
    buildSnapshotBackfilledActivePositionAnalyses(snapshotsByMode);

  for (const position of activePositions.filter((item) => !item.isClaimable)) {
    const targetId = buildBullpenLlmTargetId(
      buildBullpenQuestionRowFromActivePosition(position),
    );
    const merged = pickNewerBullpenActivePositionAnalysis(
      currentAnalyses[position.key],
      snapshotAnalysesByTargetId.get(targetId),
    );
    if (merged) {
      next[position.key] = merged;
    }
  }

  return next;
}

function activePositionAnalysesEqual(
  left: Record<string, BullpenActivePositionLlmAnalysis>,
  right: Record<string, BullpenActivePositionLlmAnalysis>,
) {
  const leftKeys = Object.keys(left).sort();
  const rightKeys = Object.keys(right).sort();
  if (leftKeys.length !== rightKeys.length) return false;

  return leftKeys.every(
    (key, index) =>
      key === rightKeys[index] &&
      JSON.stringify(left[key]) === JSON.stringify(right[key]),
  );
}

function mergeQuestionWithLatestActivePositionAnalysis(
  question: BullpenQuestionRow,
  activePositionQuestionByTargetId: Map<string, BullpenQuestionRow>,
) {
  const matchingActivePositionQuestion = activePositionQuestionByTargetId.get(
    buildBullpenLlmTargetId(question),
  );
  if (!matchingActivePositionQuestion) return question;

  const latestAnalysis = pickNewerBullpenActivePositionAnalysis(
    extractBullpenActivePositionLlmAnalysis(question),
    extractBullpenActivePositionLlmAnalysis(matchingActivePositionQuestion),
  );
  if (!latestAnalysis) return question;

  return createBullpenQuestionRow({
    ...question,
    ...latestAnalysis,
  });
}

function formatDate(value: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "—",
    second: undefined,
  });
}

function formatDateOnly(value: string) {
  const date = new Date(`${value}T00:00:00`);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString("en-IN", { dateStyle: "long" });
}

function formatCountLabel(count: number, singular: string, plural = `${singular}s`) {
  return `${count} ${count === 1 ? singular : plural}`;
}

type BullpenLlmFailedModelSummary = {
  model: string;
  issue: string;
};

type BullpenLlmRunSummary = {
  selectedModels: number;
  uniqueQuestionsAnalyzed: number;
  rowsWithConsensusOdds: number;
  usableJsonModels: number;
  failedModels: BullpenLlmFailedModelSummary[];
  matchedRowsWithoutUsableOdds: number;
  unmatchedReturnedRows: number;
  matchedRows: number;
  activePositionsUpdated: number;
  selectedScanQuestionsUpdated: number;
};

function splitBullpenFailedModel(message: string): BullpenLlmFailedModelSummary {
  const separatorIndex = message.indexOf(": ");
  if (separatorIndex === -1) {
    return { model: message, issue: "Failed or returned unusable output." };
  }

  return {
    model: message.slice(0, separatorIndex),
    issue: message.slice(separatorIndex + 2),
  };
}

function formatElapsedTime(totalSeconds: number) {
  const safeSeconds = Math.max(0, totalSeconds);
  const minutes = Math.floor(safeSeconds / 60);
  const seconds = safeSeconds % 60;
  return `${minutes}:${seconds.toString().padStart(2, "0")}`;
}

function getModeDescription(mode: ScanMode, filters: BullpenScanFilters) {
  if (mode === "end-of-month") {
    return `Bullpen questions ending exactly on ${formatDateOnly(filters.targetDate)}.`;
  }

  return `Bullpen questions closing within ${filters.maxClosingDays} days.`;
}

function getFilterBadgeLabels(mode: ScanMode, filters: BullpenScanFilters) {
  const badges = [
    mode === "30-days"
      ? `Closes within ${filters.maxClosingDays} day${filters.maxClosingDays === 1 ? "" : "s"}`
      : `Target date: ${formatDateOnly(filters.targetDate)}`,
    `Yes >= ${filters.minYesOdds}%`,
    `No >= ${filters.minNoOdds}%`,
  ];

  if (filters.excludeSports) badges.push("No sports");
  if (filters.excludeWeather) badges.push("No weather");
  if (filters.excludeMarketPredictions) badges.push("No market predictions");
  if (filters.excludeTweetCountQuestions) badges.push("No tweet counts");
  if (filters.onlyBinaryYesNo) badges.push("Yes / No only");

  return badges;
}

function filtersEqual(left: BullpenScanFilters, right: BullpenScanFilters) {
  return (
    left.maxClosingDays === right.maxClosingDays &&
    left.targetDate === right.targetDate &&
    left.excludeSports === right.excludeSports &&
    left.excludeWeather === right.excludeWeather &&
    left.excludeMarketPredictions === right.excludeMarketPredictions &&
    Boolean(left.excludeTweetCountQuestions) ===
      Boolean(right.excludeTweetCountQuestions) &&
    left.onlyBinaryYesNo === right.onlyBinaryYesNo &&
    left.minYesOdds === right.minYesOdds &&
    left.minNoOdds === right.minNoOdds
  );
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) return formatApiErrorSummary(error);
  return formatUnknownError(error);
}

function buildClaimPositionMessage(
  positions: BullpenActivePositionView[],
  { automatic }: { automatic: boolean },
) {
  const claimableCount = positions.filter((position) => position.isClaimable).length;
  const label =
    claimableCount === 1
      ? "1 resolved Bullpen position"
      : `${claimableCount} resolved Bullpen positions`;
  return automatic
    ? `${label} became claimable, so the dashboard is submitting a Bullpen redeem/claim now.`
    : `Submitting Bullpen redeem/claim now for ${label}.`;
}

function parseTimestampMs(value: string | null | undefined) {
  if (!value) return 0;
  const timestamp = new Date(value).getTime();
  return Number.isNaN(timestamp) ? 0 : timestamp;
}

function hasKnownUsdCost(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toHistoricalCostKey(
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return provider && model ? `${provider}::${model}` : null;
}

function toRoundedInrCost(usdCost: number, usdInrRate: number) {
  return Math.round(usdCost * usdInrRate * 100) / 100;
}

function isBullpenLlmRun(run: RunResponse) {
  const prompt = run.prompt || "";
  return (
    prompt.includes("Selected questions:") &&
    prompt.includes('"question_ref"') &&
    prompt.includes('"current_yes_odds"') &&
    prompt.includes('"current_no_odds"')
  );
}

function buildBullpenHistoricalCostMapInr(
  runs: RunResponse[],
  usdInrRate: number,
) {
  const costs: Record<string, number> = {};

  runs
    .filter((run) => isBullpenLlmRun(run))
    .slice()
    .sort(
      (left, right) =>
        parseTimestampMs(right.updated_at ?? right.created_at) -
        parseTimestampMs(left.updated_at ?? left.created_at),
    )
    .forEach((run) => {
      for (const link of run.run_jobs || []) {
        const job = link.job;
        const key = toHistoricalCostKey(job?.provider, job?.model);
        if (!job || !key || costs[key] !== undefined) continue;
        if (!hasKnownUsdCost(job.estimated_cost)) continue;
        costs[key] = toRoundedInrCost(job.estimated_cost, usdInrRate);
      }
    });

  return costs;
}

function buildBullpenManualInvestOrder(
  question: BullpenQuestionRow,
): PolymarketManualInvestOrderRequest | null {
  const outcome =
    question.llmYesOdds !== null &&
    question.llmYesOdds > 80 &&
    (question.llmNoOdds === null || question.llmYesOdds >= question.llmNoOdds)
      ? "Yes"
      : "No";
  const outcomeOdds = outcome === "Yes" ? question.yesOdds : question.noOdds;

  if (
    question.amountToBeInvested === null ||
    question.amountToBeInvested <= 0 ||
    outcomeOdds === null ||
    outcomeOdds <= 0 ||
    outcomeOdds >= 100
  ) {
    return null;
  }

  const marketId =
    typeof question.slug === "string" && question.slug.trim()
      ? question.slug.trim()
      : null;
  if (!marketId) return null;

  return {
    question_id: question.id,
    market_id: marketId,
    market_title: question.question,
    outcome,
    amount: Number(question.amountToBeInvested.toFixed(2)),
    price: Number((outcomeOdds / 100).toFixed(4)),
    event_end_at: question.closeTime,
    market_url: question.marketUrl,
  };
}

function buildBullpenAutoRunLlmOutputs(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  return breakdown.map((entry) => ({
    provider: entry.provider,
    model: entry.model,
    llm_yes_odds: entry.llmYesOdds,
    llm_no_odds: entry.llmNoOdds,
    confidence: entry.confidence,
    evidence_status: entry.evidenceStatus,
    event_state: entry.eventState,
    key_evidence: entry.keyEvidence,
    red_flags: entry.redFlags,
    rationale: entry.rationale,
    completed_at: entry.timestamp,
  }));
}

function buildBullpenAutoRunRequest({
  mode,
  snapshot,
  selectedQuestionIds,
}: {
  mode: ScanMode;
  snapshot: BullpenScanSnapshot | null;
  selectedQuestionIds: Set<string>;
}): BullpenAutoLiveRunOnceRequest | null {
  if (!snapshot) {
    return null;
  }

  return {
    console_profile: {
      source_label: snapshot.sourceLabel,
      source_url: snapshot.sourceUrl,
      scanned_at: snapshot.scannedAt,
      snapshot_id: snapshot.snapshotId,
      mode,
      total_candidates: snapshot.totalCandidates,
      candidate_rows_prefiltered: true,
      reuse_saved_llm_outputs: false,
      candidate_rows: snapshot.questions.map((question) => ({
        question_id: question.id,
        market_id:
          typeof question.slug === "string" && question.slug.trim()
            ? question.slug.trim()
            : question.id,
        market_title: question.question,
        slug: question.slug,
        market_url: question.marketUrl,
        close_time: question.closeTime,
        theme: question.category || "Uncategorized",
        current_yes_odds: question.yesOdds,
        current_no_odds: question.noOdds,
        llm_yes_odds: question.llmYesOdds,
        llm_no_odds: question.llmNoOdds,
        returns_per_day: question.returnsPerDay,
        amount_to_be_invested: question.amountToBeInvested,
        llm_disagreement_level: question.llmDisagreementLevel,
        llm_disagreement_category: question.llmDisagreementCategory,
        adjudication_required: question.adjudicationRequired,
        confidence:
          question.llmBreakdown.find((entry) => entry.confidence)?.confidence ?? null,
        evidence_status: question.evidenceStatus,
        event_state: question.eventState,
        rules: question.rules,
        selected: selectedQuestionIds.has(question.id),
        llm_outputs: buildBullpenAutoRunLlmOutputs(question.llmBreakdown),
      })),
    },
  };
}

function applySnapshotMarketUpdates(
  snapshot: BullpenScanSnapshot | null,
  snapshotId: string,
  marketUpdates: Record<string, Partial<PolymarketMarketRefresh>>,
  updatedAt: string | null = null,
) {
  if (!snapshot || snapshot.snapshotId !== snapshotId) return snapshot;

  let changed = false;
  const nextQuestions = snapshot.questions.map((question) => {
    const marketUpdate = marketUpdates[question.id];
    if (!marketUpdate) {
      return question;
    }

    const nextSlug =
      marketUpdate.slug === undefined ? question.slug : marketUpdate.slug;
    const nextMarketUrl =
      marketUpdate.marketUrl === undefined
        ? question.marketUrl
        : marketUpdate.marketUrl;
    const nextYesOdds =
      marketUpdate.yesOdds === undefined ? question.yesOdds : marketUpdate.yesOdds;
    const nextNoOdds =
      marketUpdate.noOdds === undefined ? question.noOdds : marketUpdate.noOdds;
    const nextRules =
      marketUpdate.rules === undefined ? question.rules : marketUpdate.rules;
    const nextMarketContext =
      marketUpdate.marketContext === undefined
        ? question.marketContext
        : marketUpdate.marketContext;
    const nextResolutionSource =
      marketUpdate.resolutionSource === undefined
        ? question.resolutionSource
        : marketUpdate.resolutionSource;

    const oddsChanged = nextYesOdds !== question.yesOdds || nextNoOdds !== question.noOdds;

    if (
      nextSlug === question.slug &&
      nextMarketUrl === question.marketUrl &&
      nextYesOdds === question.yesOdds &&
      nextNoOdds === question.noOdds &&
      nextRules === question.rules &&
      nextMarketContext === question.marketContext &&
      nextResolutionSource === question.resolutionSource
    ) {
      return question;
    }

    changed = true;
    return createBullpenQuestionRow({
      ...question,
      slug: nextSlug,
      marketUrl: nextMarketUrl,
      yesOdds: nextYesOdds,
      noOdds: nextNoOdds,
      currentOddsUpdatedAt:
        updatedAt && oddsChanged ? updatedAt : question.currentOddsUpdatedAt,
      rules: nextRules,
      marketContext: nextMarketContext,
      resolutionSource: nextResolutionSource,
    });
  });

  return changed
    ? {
        ...snapshot,
        questions: nextQuestions,
      }
    : snapshot;
}

function normalizeSnapshot(
  snapshot: BullpenScanSnapshot | Record<string, unknown> | null | undefined,
) {
  if (!snapshot || typeof snapshot !== "object") return null;
  const record = snapshot as Record<string, unknown>;
  if (!Array.isArray(record.questions) || typeof record.mode !== "string") {
    return null;
  }
  const mode: ScanMode =
    record.mode === "end-of-month" ? "end-of-month" : "30-days";
  const defaultFilters = createBullpenScanFilters(mode);
  const storedFilters =
    record.filters && typeof record.filters === "object"
      ? (record.filters as Partial<BullpenScanFilters>)
      : {};

  return {
    ...(record as unknown as BullpenScanSnapshot),
    mode,
    snapshotId:
      typeof record.snapshotId === "string"
        ? record.snapshotId
        : `bullpen-scan-${Date.now().toString(36)}`,
    archivedAt:
      typeof record.archivedAt === "string" ? record.archivedAt : null,
    filters: {
      ...defaultFilters,
      ...storedFilters,
      excludeTweetCountQuestions: Boolean(
        storedFilters.excludeTweetCountQuestions,
      ),
    },
    questions: record.questions.map((question) =>
      createBullpenQuestionRow(question as BullpenQuestionRow),
    ),
  } satisfies BullpenScanSnapshot;
}

function readBullpenSnapshotsFromStorage() {
  if (typeof window === "undefined") return createEmptySnapshotHistory();

  try {
    const raw = window.localStorage.getItem(BULLPEN_SNAPSHOT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    const next = createEmptySnapshotHistory();

    for (const mode of ["30-days", "end-of-month"] as const) {
      const entry =
        parsed && typeof parsed === "object"
          ? (parsed as Record<string, unknown>)[mode]
          : null;
      if (!entry || typeof entry !== "object") continue;

      const current = normalizeSnapshot(
        (entry as Record<string, unknown>).current as
          | BullpenScanSnapshot
          | Record<string, unknown>
          | null,
      );
      const history = Array.isArray((entry as Record<string, unknown>).history)
        ? ((entry as Record<string, unknown>).history as Record<string, unknown>[])
            .map((snapshot) => normalizeSnapshot(snapshot))
            .filter((snapshot): snapshot is BullpenScanSnapshot => Boolean(snapshot))
        : [];

      next[mode] = {
        current,
        history,
      };
    }

    return next;
  } catch {
    return createEmptySnapshotHistory();
  }
}

function writeBullpenSnapshotsToStorage(
  snapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BULLPEN_SNAPSHOT_STORAGE_KEY,
      JSON.stringify(snapshotsByMode),
    );
  } catch {
    // Keep the screen usable even when localStorage is unavailable.
  }
}

function normalizeStoredTarget(
  value: unknown,
): ProviderModelTarget | null {
  if (
    value &&
    typeof value === "object" &&
    typeof (value as Record<string, unknown>).provider === "string" &&
    typeof (value as Record<string, unknown>).model === "string"
  ) {
    return {
      provider: (value as Record<string, string>).provider,
      model: (value as Record<string, string>).model,
    };
  }

  return null;
}

function isStoredActivePositionLlmAnalysis(
  value: unknown,
): value is BullpenActivePositionLlmAnalysis {
  return Boolean(
    value &&
      typeof value === "object" &&
      Array.isArray((value as Record<string, unknown>).llmBreakdown),
  );
}

function readActivePositionAnalysesFromStorage() {
  if (typeof window === "undefined") return {};

  try {
    const raw = window.localStorage.getItem(
      BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY,
    );
    const parsed = raw ? JSON.parse(raw) : null;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {};
    }

    return Object.fromEntries(
      Object.entries(parsed as Record<string, unknown>).filter(
        (entry): entry is [string, BullpenActivePositionLlmAnalysis] =>
          typeof entry[0] === "string" &&
          isStoredActivePositionLlmAnalysis(entry[1]),
      ),
    );
  } catch {
    return {};
  }
}

function writeActivePositionAnalysesToStorage(
  analysesByKey: Record<string, BullpenActivePositionLlmAnalysis>,
) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY,
      JSON.stringify(analysesByKey),
    );
  } catch {
    // Best effort only.
  }
}

function readLastLlmTargetsFromStorage() {
  if (typeof window === "undefined") return [];

  try {
    const raw = window.localStorage.getItem(BULLPEN_LAST_LLM_TARGET_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => normalizeStoredTarget(item))
        .filter((item): item is ProviderModelTarget => Boolean(item));
    }
    const singleTarget = normalizeStoredTarget(parsed);
    return singleTarget ? [singleTarget] : [];
  } catch {
    return [];
  }
}

function writeLastLlmTargetsToStorage(targets: ProviderModelTarget[]) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BULLPEN_LAST_LLM_TARGET_STORAGE_KEY,
      JSON.stringify(targets),
    );
  } catch {
    // Best effort only.
  }
}

function readBullpenLlmPromptFromStorage() {
  if (typeof window === "undefined") {
    return DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE;
  }

  try {
    const stored = window.localStorage.getItem(BULLPEN_LLM_PROMPT_STORAGE_KEY);
    const normalizedStored = stored?.trim();
    if (!normalizedStored) {
      return DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE;
    }
    if (LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES.includes(normalizedStored)) {
      return DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE;
    }
    return normalizedStored;
  } catch {
    return DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE;
  }
}

function writeBullpenLlmPromptToStorage(template: string) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(BULLPEN_LLM_PROMPT_STORAGE_KEY, template);
  } catch {
    // Best effort only.
  }
}

function readStoredBoolean(key: string, fallback: boolean) {
  if (typeof window === "undefined") return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (raw === "true") return true;
    if (raw === "false") return false;
  } catch {
    // Best effort only.
  }
  return fallback;
}

function writeStoredBoolean(key: string, value: boolean) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(key, String(value));
  } catch {
    // Best effort only.
  }
}

function getDefaultBullpenLlmTargets(lastTargets: ProviderModelTarget[]) {
  if (lastTargets.length > 0) return lastTargets;
  return [{ provider: "deepseek", model: "deepseek-v4-flash" }];
}

function formatTargetSummary(
  targets: ProviderModelTarget[],
  {
    maxVisible = 2,
  }: {
    maxVisible?: number;
  } = {},
) {
  if (targets.length === 0) return "the selected LLMs";

  const visible = targets
    .slice(0, maxVisible)
    .map((target) => `${target.provider} / ${target.model}`);
  const remaining = targets.length - visible.length;

  return remaining > 0
    ? `${visible.join(", ")} + ${remaining} more`
    : visible.join(", ");
}

async function waitForBullpenRunCompletion(runId: number) {
  for (let attempt = 0; attempt < MAX_RUN_POLLS; attempt += 1) {
    const run = await apiService.getRun(runId);
    const status = (run.status || "").toLowerCase();
    if (status === "completed" || status === "partial" || status === "failed") {
      return run;
    }
    await new Promise((resolve) => window.setTimeout(resolve, RUN_POLL_INTERVAL_MS));
  }

  return apiService.getRun(runId);
}

function FilterToggle({
  checked,
  label,
  description,
  onChange,
  onOpenDetails,
  className,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
  onOpenDetails?: () => void;
  className?: string;
}) {
  const isDetailCard = typeof onOpenDetails === "function";

  return (
    <div
      role={isDetailCard ? "button" : undefined}
      tabIndex={isDetailCard ? 0 : undefined}
      onClick={onOpenDetails}
      onKeyDown={(event) => {
        if (!isDetailCard) return;
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpenDetails();
        }
      }}
      className={cn(
        "rounded-2xl border border-slate-200 bg-slate-50 p-3",
        isDetailCard
          ? "cursor-pointer transition hover:border-slate-300 hover:bg-white focus:outline-none focus:ring-2 focus:ring-slate-300"
          : "",
        className,
      )}
    >
      <div className="flex items-start gap-3">
        <input
          type="checkbox"
          checked={checked}
          onClick={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
          onChange={(event) => onChange(event.target.checked)}
          aria-label={`Toggle ${label}`}
          className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
        />
        <span className="space-y-1">
          <span className="block text-sm font-semibold text-slate-900">
            {label}
          </span>
          <span className="block text-xs leading-5 text-slate-600">
            {description}
          </span>
          {isDetailCard ? (
            <span className="block text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Click card for exact rules
            </span>
          ) : null}
        </span>
      </div>
    </div>
  );
}

export default function BullpenAiPage() {
  const searchParams = useSearchParams();
  const usdInrRate = useUsdInrRate();
  const activeMode: ScanMode =
    searchParams.get("tab") === "end-of-month" ? "end-of-month" : "30-days";
  const activeTab = TABS.find((tab) => tab.mode === activeMode) || TABS[0];
  const [filtersByMode, setFiltersByMode] = useState<
    Record<ScanMode, BullpenScanFilters>
  >(() => ({
    "30-days": normalizeBullpenScanFilters("30-days", searchParams),
    "end-of-month": normalizeBullpenScanFilters("end-of-month", searchParams),
  }));
  const [snapshotsByMode, setSnapshotsByMode] = useState<
    Record<ScanMode, BullpenSnapshotHistory>
  >(createEmptySnapshotHistory);
  const [selectedSnapshotIdByMode, setSelectedSnapshotIdByMode] = useState<
    Record<ScanMode, string | null>
  >(createEmptySnapshotViewMap);
  const [selectedQuestionIdsByMode, setSelectedQuestionIdsByMode] = useState<
    Record<ScanMode, string[]>
  >(createEmptySelectionMap);
  const [
    selectedInvestmentQuestionIdsByMode,
    setSelectedInvestmentQuestionIdsByMode,
  ] = useState<Record<ScanMode, string[]>>(createEmptySelectionMap);
  const [sortByMode, setSortByMode] = useState<
    Record<ScanMode, BullpenTableSortState>
  >(createEmptySortMap);
  const [messagesByMode, setMessagesByMode] = useState<
    Record<ScanMode, string | null>
  >({
    "30-days": null,
    "end-of-month": null,
  });
  const [llmMessagesByMode, setLlmMessagesByMode] = useState<
    Record<ScanMode, BullpenLlmRunSummary | string | null>
  >({
    "30-days": null,
    "end-of-month": null,
  });
  const [investmentMessagesByMode, setInvestmentMessagesByMode] = useState<
    Record<ScanMode, string | null>
  >({
    "30-days": null,
    "end-of-month": null,
  });
  const [investmentProgressByMode, setInvestmentProgressByMode] = useState<
    Record<ScanMode, string | null>
  >({
    "30-days": null,
    "end-of-month": null,
  });
  const [activePositions, setActivePositions] = useState<
    BullpenActivePositionView[]
  >([]);
  const [activePositionAnalysesByKey, setActivePositionAnalysesByKey] =
    useState<Record<string, BullpenActivePositionLlmAnalysis>>({});
  const [hasLoadedPositions, setHasLoadedPositions] = useState(false);
  const [isLoadingPositions, setIsLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionsFallback, setPositionsFallback] =
    useState<BullpenPositionsFallback | null>(null);
  const [positionsHealth, setPositionsHealth] =
    useState<BullpenLiveHealth | null>(null);
  const [claimPositionsError, setClaimPositionsError] = useState<string | null>(
    null,
  );
  const [claimPositionsStatus, setClaimPositionsStatus] = useState<
    string | null
  >(null);
  const [isClaimingPositions, setIsClaimingPositions] = useState(false);
  const [positionsLastUpdatedAt, setPositionsLastUpdatedAt] = useState<
    string | null
  >(null);
  const [positionsSource, setPositionsSource] =
    useState<BullpenPositionsSource | null>(null);
  const [lastSuccessfulLiveSnapshot, setLastSuccessfulLiveSnapshot] =
    useState<BullpenLiveSnapshot | null>(null);
  const [scanningMode, setScanningMode] = useState<ScanMode | null>(null);
  const [llmRunningMode, setLlmRunningMode] = useState<ScanMode | null>(null);
  const [llmRunStartedAtByMode, setLlmRunStartedAtByMode] = useState<
    Record<ScanMode, number | null>
  >({
    "30-days": null,
    "end-of-month": null,
  });
  const [llmElapsedSeconds, setLlmElapsedSeconds] = useState(0);
  const [investingMode, setInvestingMode] = useState<ScanMode | null>(null);
  const [refreshingCurrentOddsMode, setRefreshingCurrentOddsMode] = useState<
    ScanMode | null
  >(null);
  const [lastLlmTargets, setLastLlmTargets] = useState<ProviderModelTarget[]>(
    [],
  );
  const [historicalCostInrByTarget, setHistoricalCostInrByTarget] = useState<
    Record<string, number>
  >({});
  const [bullpenLlmPromptTemplate, setBullpenLlmPromptTemplate] = useState(
    DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
  );
  const [requireFreshInternetEvidence, setRequireFreshInternetEvidence] =
    useState(true);
  const [
    allowEvidenceGroundedNonWebModels,
    setAllowEvidenceGroundedNonWebModels,
  ] = useState(false);
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [isScanFiltersOpen, setIsScanFiltersOpen] = useState(false);
  const [openFilterDetailsId, setOpenFilterDetailsId] =
    useState<BullpenScanFilterDetailId | null>(null);
  const [hasLoadedStorage, setHasLoadedStorage] = useState(false);
  const claimPositionsTaskRef = useRef<Promise<void> | null>(null);
  const lastAutoClaimAttemptRef = useRef<BullpenAutoClaimAttempt | null>(null);
  const scanFiltersMenuRef = useRef<HTMLDivElement | null>(null);
  const canonicalizedSnapshotIdsRef = useRef<Record<ScanMode, Set<string>>>({
    "30-days": new Set<string>(),
    "end-of-month": new Set<string>(),
  });

  useEffect(() => {
    setSnapshotsByMode(readBullpenSnapshotsFromStorage());
    setLastLlmTargets(readLastLlmTargetsFromStorage());
    setBullpenLlmPromptTemplate(readBullpenLlmPromptFromStorage());
    setActivePositionAnalysesByKey(readActivePositionAnalysesFromStorage());
    setRequireFreshInternetEvidence(
      readStoredBoolean(BULLPEN_REQUIRE_FRESH_EVIDENCE_STORAGE_KEY, true),
    );
    setAllowEvidenceGroundedNonWebModels(
      readStoredBoolean(BULLPEN_ALLOW_NON_WEB_EVIDENCE_STORAGE_KEY, false),
    );
    setHasLoadedStorage(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedStorage) return;
    writeBullpenSnapshotsToStorage(snapshotsByMode);
  }, [hasLoadedStorage, snapshotsByMode]);

  useEffect(() => {
    if (!hasLoadedStorage) return;
    writeStoredBoolean(
      BULLPEN_REQUIRE_FRESH_EVIDENCE_STORAGE_KEY,
      requireFreshInternetEvidence,
    );
  }, [hasLoadedStorage, requireFreshInternetEvidence]);

  useEffect(() => {
    if (!hasLoadedStorage) return;
    writeStoredBoolean(
      BULLPEN_ALLOW_NON_WEB_EVIDENCE_STORAGE_KEY,
      allowEvidenceGroundedNonWebModels,
    );
  }, [hasLoadedStorage, allowEvidenceGroundedNonWebModels]);

  useEffect(() => {
    if (!hasLoadedStorage) return;
    writeActivePositionAnalysesToStorage(activePositionAnalysesByKey);
  }, [activePositionAnalysesByKey, hasLoadedStorage]);

  useEffect(() => {
    if (!hasLoadedPositions || !hasLoadedStorage) return;
    setActivePositionAnalysesByKey((current) => {
      const next = buildMergedActivePositionAnalyses({
        activePositions,
        currentAnalyses: current,
        snapshotsByMode,
      });
      if (activePositionAnalysesEqual(current, next)) {
        return current;
      }
      return next;
    });
  }, [activePositions, hasLoadedPositions, hasLoadedStorage, snapshotsByMode]);

  useEffect(() => {
    setIsScanFiltersOpen(false);
    setOpenFilterDetailsId(null);
  }, [activeMode]);

  useEffect(() => {
    if (!isScanFiltersOpen || openFilterDetailsId) return;

    function handlePointerDown(event: MouseEvent) {
      if (!scanFiltersMenuRef.current) return;
      if (scanFiltersMenuRef.current.contains(event.target as Node)) return;
      setIsScanFiltersOpen(false);
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setIsScanFiltersOpen(false);
      }
    }

    document.addEventListener("mousedown", handlePointerDown);
    document.addEventListener("keydown", handleKeyDown);

    return () => {
      document.removeEventListener("mousedown", handlePointerDown);
      document.removeEventListener("keydown", handleKeyDown);
    };
  }, [isScanFiltersOpen, openFilterDetailsId]);

  const pollBullpenPositions = useEffectEvent(() => {
    if (typeof document !== "undefined" && document.visibilityState !== "visible") {
      return;
    }
    if (claimPositionsTaskRef.current) return;
    void refreshBullpenPositions();
  });

  useEffect(() => {
    void refreshBullpenPositions();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const intervalId = window.setInterval(() => {
      pollBullpenPositions();
    }, 60_000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, []);

  useEffect(() => {
    let cancelled = false;

    const loadHistoricalCosts = async () => {
      try {
        const firstPage = await apiService.getFullRuns({ page: 1, limit: 100 });
        const maxPages = Math.min(firstPage.pages, 3);
        const remainingPages = Array.from(
          { length: Math.max(0, maxPages - 1) },
          (_, index) => index + 2,
        );
        const remainingResults = await Promise.all(
          remainingPages.map((page) =>
            apiService.getFullRuns({ page, limit: 100 }),
          ),
        );
        const runs = [
          ...firstPage.items,
          ...remainingResults.flatMap((page) => page.items),
        ];
        if (cancelled) return;
        setHistoricalCostInrByTarget(
          buildBullpenHistoricalCostMapInr(runs, usdInrRate),
        );
      } catch (error) {
        if (!cancelled) {
          console.warn("Failed to load Bullpen LLM cost history:", error);
        }
      }
    };

    void loadHistoricalCosts();
    return () => {
      cancelled = true;
    };
  }, [usdInrRate]);

  const activeFilters = filtersByMode[activeMode];
  const activeSnapshots = snapshotsByMode[activeMode];
  const activeCurrentSnapshot = activeSnapshots.current;
  const activeSelectedSnapshotId = selectedSnapshotIdByMode[activeMode];
  const activeVisibleSnapshot =
    !activeSelectedSnapshotId ||
    activeCurrentSnapshot?.snapshotId === activeSelectedSnapshotId
      ? activeCurrentSnapshot
      : activeSnapshots.history.find(
          (snapshot) => snapshot.snapshotId === activeSelectedSnapshotId,
        ) || activeCurrentSnapshot;
  const isViewingHistory = Boolean(
    activeVisibleSnapshot &&
      activeCurrentSnapshot &&
      activeVisibleSnapshot.snapshotId !== activeCurrentSnapshot.snapshotId,
  );
  const hasStaleResult =
    activeCurrentSnapshot !== null &&
    !filtersEqual(activeCurrentSnapshot.filters, activeFilters);
  const notice = messagesByMode[activeMode];
  const llmNotice = llmMessagesByMode[activeMode];
  const investmentNotice = investmentMessagesByMode[activeMode];
  const investmentProgress = investmentProgressByMode[activeMode];
  const isScanning = scanningMode === activeMode;
  const isRunningLlm = llmRunningMode === activeMode;
  const llmRunStartedAt = llmRunStartedAtByMode[activeMode];
  const isInvesting = investingMode === activeMode;
  const isRefreshingCurrentOdds = refreshingCurrentOddsMode === activeMode;
  const selectionEnabled = Boolean(activeCurrentSnapshot && !isViewingHistory);
  const selectedQuestionIds = selectionEnabled
    ? selectedQuestionIdsByMode[activeMode].filter((questionId) =>
        activeCurrentSnapshot?.questions.some((question) => question.id === questionId),
      )
    : [];
  const selectedQuestionIdSet = new Set(selectedQuestionIds);
  const selectedQuestionCount = selectedQuestionIds.length;
  const activeFilterBadges = getFilterBadgeLabels(activeMode, activeFilters);
  const openActivePositions = activePositions.filter((position) => !position.isClaimable);
  const getBullpenSelectionConstraint = (
    provider: ProviderInfo,
    _model: string,
  ) => {
    void _model;
    if (
      !requireFreshInternetEvidence ||
      allowEvidenceGroundedNonWebModels
    ) {
      return { selectable: true };
    }
    const internetAccess = getResolvedProviderInternetAccess(
      provider.name,
      provider.internet_access,
    );
    if (internetAccess.mode === "none") {
      return {
        selectable: false,
        reason:
          "Fresh internet evidence is required for this Bullpen run. Turn on 'Allow evidence-grounded non-web models' to include models without model-side search.",
      };
    }
    return { selectable: true };
  };
  const llmPickerHeaderContent = (
    <div className="space-y-3 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-4">
      <FilterToggle
        checked={requireFreshInternetEvidence}
        onChange={setRequireFreshInternetEvidence}
        label="Require fresh internet evidence for every event"
        description="Default on. The backend will refresh Polymarket facts, build a verified evidence block, and enforce web-grounded checks before consensus includes a model."
      />
      <FilterToggle
        checked={allowEvidenceGroundedNonWebModels}
        onChange={setAllowEvidenceGroundedNonWebModels}
        label="Allow evidence-grounded non-web models"
        description="When enabled, models without model-side search can still run if the backend verified evidence block is attached."
      />
    </div>
  );
  const activePositionQuestionsForLlm = openActivePositions.map((position) =>
    buildBullpenQuestionRowFromActivePosition(
      position,
      activePositionAnalysesByKey[position.key],
    ),
  );
  const activePositionQuestionByTargetId = new Map(
    activePositionQuestionsForLlm.map(
      (question) => [buildBullpenLlmTargetId(question), question] as const,
    ),
  );
  const activeInvestmentCandidates =
    selectionEnabled && activeCurrentSnapshot
      ? activeCurrentSnapshot.questions
          .map((question) =>
            mergeQuestionWithLatestActivePositionAnalysis(
              question,
              activePositionQuestionByTargetId,
            ),
          )
          .filter((question) => {
            return isBullpenQuestionInvestmentCandidate(question);
          })
      : [];
  const activeInvestmentCandidateIds = new Set(
    activeInvestmentCandidates.map((question) => question.id),
  );
  const selectedInvestmentQuestionIds = selectionEnabled
    ? selectedInvestmentQuestionIdsByMode[activeMode].filter((questionId) =>
        activeInvestmentCandidateIds.has(questionId),
      )
    : [];
  const selectedInvestmentQuestionIdSet = new Set(selectedInvestmentQuestionIds);
  const activeHasAnyLlmOdds = Boolean(
    activePositionQuestionsForLlm.some(
      (question) => question.llmYesOdds !== null || question.llmNoOdds !== null,
    ) ||
      activeCurrentSnapshot?.questions.some(
      (question) => question.llmYesOdds !== null || question.llmNoOdds !== null,
      ),
  );
  const buildRunNowRequest = async () => {
    const { snapshot, error } = await executeBullpenScan({
      resetSelections: true,
    });
    if (error) {
      throw new Error(error);
    }

    return buildBullpenAutoRunRequest({
      mode: activeMode,
      snapshot,
      selectedQuestionIds: new Set<string>(),
    });
  };

  useEffect(() => {
    if (!isRunningLlm || !llmRunStartedAt) {
      setLlmElapsedSeconds(0);
      return;
    }

    const updateElapsed = () => {
      setLlmElapsedSeconds(
        Math.max(0, Math.floor((Date.now() - llmRunStartedAt) / 1000)),
      );
    };

    updateElapsed();
    const intervalId = window.setInterval(updateElapsed, 1000);

    return () => {
      window.clearInterval(intervalId);
    };
  }, [isRunningLlm, llmRunStartedAt]);

  useEffect(() => {
    if (!selectionEnabled || !activeCurrentSnapshot) return;

    const eligibleIds = activeCurrentSnapshot.questions
      .filter((question) => {
        return isBullpenQuestionInvestmentCandidate(question);
      })
      .map((question) => question.id);
    setSelectedInvestmentQuestionIdsByMode((current) => {
      const previous = current[activeMode];
      const filtered = previous.filter((questionId) => eligibleIds.includes(questionId));

      if (previous.length > 0) {
        if (
          previous.length === filtered.length &&
          previous.every((questionId, index) => questionId === filtered[index])
        ) {
          return current;
        }

        return {
          ...current,
          [activeMode]: filtered,
        };
      }

      if (eligibleIds.length === 0) return current;

      return {
        ...current,
        [activeMode]: eligibleIds,
      };
    });
  }, [activeCurrentSnapshot, activeMode, selectionEnabled]);

  useEffect(() => {
    if (!hasLoadedStorage || !activeVisibleSnapshot) return;
    if (
      canonicalizedSnapshotIdsRef.current[activeMode].has(
        activeVisibleSnapshot.snapshotId,
      )
    ) {
      return;
    }

    canonicalizedSnapshotIdsRef.current[activeMode].add(
      activeVisibleSnapshot.snapshotId,
    );
    const snapshotId = activeVisibleSnapshot.snapshotId;

    const questions = activeVisibleSnapshot.questions
      .filter((question) => question.id.trim())
      .map((question) => ({
        id: question.id,
        slug: question.slug,
        marketUrl: question.marketUrl,
      }));
    if (questions.length === 0) return;

    let cancelled = false;

    async function refreshMarketUrls() {
      try {
        const response = await fetch("/api/bullpen-ai/market-urls", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          cache: "no-store",
          body: JSON.stringify({ questions }),
        });
        if (!response.ok) return;

        const payload = (await response.json()) as {
          marketUrls?: Record<string, string | null>;
          marketSlugs?: Record<string, string | null>;
        };
        if (cancelled || (!payload.marketUrls && !payload.marketSlugs)) return;

        const marketUpdates = Object.fromEntries(
          questions.map((question) => [
            question.id,
            {
              marketUrl: payload.marketUrls?.[question.id],
              slug: payload.marketSlugs?.[question.id],
            },
          ]),
        );

        setSnapshotsByMode((current) => {
          const nextCurrent = applySnapshotMarketUpdates(
            current[activeMode].current,
            snapshotId,
            marketUpdates,
          );
          const nextHistory = current[activeMode].history.map((snapshot) =>
            applySnapshotMarketUpdates(
              snapshot,
              snapshotId,
              marketUpdates,
            ) || snapshot,
          );

          if (
            nextCurrent === current[activeMode].current &&
            nextHistory.every(
              (snapshot, index) => snapshot === current[activeMode].history[index],
            )
          ) {
            return current;
          }

          return {
            ...current,
            [activeMode]: {
              current: nextCurrent,
              history: nextHistory,
            },
          };
        });
      } catch {
        // Best effort only. Existing saved snapshots will continue using stored URLs.
      }
    }

    void refreshMarketUrls();

    return () => {
      cancelled = true;
    };
  }, [activeMode, activeVisibleSnapshot, hasLoadedStorage]);

  function updateActiveFilters(patch: Partial<BullpenScanFilters>) {
    setFiltersByMode((current) => ({
      ...current,
      [activeMode]: {
        ...current[activeMode],
        ...patch,
      },
    }));
  }

  function resetActiveFilters() {
    setFiltersByMode((current) => ({
      ...current,
      [activeMode]: createBullpenScanFilters(activeMode),
    }));
  }

  function setActiveSort(sortKey: BullpenTableSortKey) {
    setSortByMode((current) => {
      const previous = current[activeMode];
      return {
        ...current,
        [activeMode]:
          previous.key === sortKey
            ? {
                key: sortKey,
                direction: previous.direction === "asc" ? "desc" : "asc",
              }
            : {
                key: sortKey,
                direction: "asc",
              },
      };
    });
  }

  function toggleQuestionSelection(questionId: string) {
    if (!selectionEnabled) return;

    setSelectedQuestionIdsByMode((current) => {
      const next = new Set(current[activeMode]);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return {
        ...current,
        [activeMode]: Array.from(next),
      };
    });
  }

  function toggleSelectAllQuestions() {
    if (!selectionEnabled || !activeCurrentSnapshot) return;

    setSelectedQuestionIdsByMode((current) => {
      const allQuestionIds = activeCurrentSnapshot.questions.map(
        (question) => question.id,
      );
      const everySelected = allQuestionIds.every((questionId) =>
        current[activeMode].includes(questionId),
      );

      return {
        ...current,
        [activeMode]: everySelected ? [] : allQuestionIds,
      };
    });
  }

  function toggleInvestmentSelection(questionId: string) {
    if (!selectionEnabled || !activeInvestmentCandidateIds.has(questionId)) return;

    setSelectedInvestmentQuestionIdsByMode((current) => {
      const next = new Set(current[activeMode]);
      if (next.has(questionId)) {
        next.delete(questionId);
      } else {
        next.add(questionId);
      }
      return {
        ...current,
        [activeMode]: Array.from(next).filter((id) => activeInvestmentCandidateIds.has(id)),
      };
    });
  }

  function selectAllInvestmentCandidates() {
    if (!selectionEnabled) return;
    setSelectedInvestmentQuestionIdsByMode((current) => ({
      ...current,
      [activeMode]: activeInvestmentCandidates.map((question) => question.id),
    }));
  }

  function clearInvestmentCandidates() {
    setSelectedInvestmentQuestionIdsByMode((current) => ({
      ...current,
      [activeMode]: [],
    }));
  }

  function resolvePositionCloseTime(marketTitle: string) {
    const normalizedMarketTitle = normalizeQuestionTitle(marketTitle);

    for (const mode of ["30-days", "end-of-month"] as const) {
      const snapshots = [
        snapshotsByMode[mode].current,
        ...snapshotsByMode[mode].history,
      ].filter((snapshot): snapshot is BullpenScanSnapshot => Boolean(snapshot));

      for (const snapshot of snapshots) {
        const matchedQuestion = snapshot.questions.find(
          (question) =>
            normalizeQuestionTitle(question.question) === normalizedMarketTitle,
        );
        if (matchedQuestion?.closeTime) {
          return matchedQuestion.closeTime;
        }
      }
    }

    return extractCloseTimeFromMarketTitle(marketTitle);
  }

  function applyResolvedPositionCloseTime(position: BullpenActivePositionView) {
    const resolvedCloseTime =
      resolvePositionCloseTime(position.marketTitle) ?? position.closeTime;

    if (resolvedCloseTime === position.closeTime) {
      return position;
    }

    return {
      ...position,
      closeTime: resolvedCloseTime,
      returnsPerDay: calculateBullpenPositionReturnsPerDay({
        closeTime: resolvedCloseTime,
        currentPrice: position.currentPrice,
        isClaimable: position.isClaimable,
      }),
    } satisfies BullpenActivePositionView;
  }

  function normalizeLiveSnapshot(
    snapshot: BullpenLiveSnapshot | null | undefined,
  ) {
    if (!snapshot) return null;

    return {
      ...snapshot,
      positions: snapshot.positions.map(applyResolvedPositionCloseTime),
    } satisfies BullpenLiveSnapshot;
  }

  async function claimBullpenResolvedPositions({
    automatic = false,
    positions = activePositions,
  }: {
    automatic?: boolean;
    positions?: BullpenActivePositionView[];
  } = {}) {
    if (claimPositionsTaskRef.current) {
      await claimPositionsTaskRef.current;
      return;
    }

    const claimablePositions = positions.filter((position) => position.isClaimable);
    if (claimablePositions.length === 0) {
      setClaimPositionsError(null);
      setClaimPositionsStatus(
        "No resolved Bullpen positions are currently waiting to be claimed.",
      );
      return;
    }

    const task = (async () => {
      setIsClaimingPositions(true);
      setClaimPositionsError(null);
      setClaimPositionsStatus(
        buildClaimPositionMessage(claimablePositions, { automatic }),
      );

      try {
        const canTargetSpecificConditions = claimablePositions.every((position) =>
          Boolean(position.conditionId?.trim()),
        );
        const conditionIds = canTargetSpecificConditions
          ? Array.from(
              new Set(
                claimablePositions
                  .map((position) => position.conditionId?.trim() || null)
                  .filter((value): value is string => Boolean(value)),
              ),
            )
          : [];

        await apiService.polymarketLiveRedeem(
          canTargetSpecificConditions ? { conditionIds } : undefined,
        );
        setClaimPositionsStatus(
          "Bullpen redeem/claim submitted. Refreshing the popup with the latest wallet data.",
        );
        const refreshedPositionsResult = await refreshBullpenPositions({
          suppressAutoClaim: true,
        });
        const remainingClaimablePositions = refreshedPositionsResult.positions.filter(
          (position) => position.isClaimable,
        );
        setClaimPositionsStatus(
          remainingClaimablePositions.length > 0
            ? automatic
              ? `Bullpen auto-claim submitted, but ${formatCountLabel(remainingClaimablePositions.length, "resolved position")} still ${remainingClaimablePositions.length === 1 ? "shows" : "show"} as claimable. Cred-X will retry automatically on the next refresh.`
              : `Bullpen submitted the claim, but ${formatCountLabel(remainingClaimablePositions.length, "resolved position")} still ${remainingClaimablePositions.length === 1 ? "shows" : "show"} as claimable in the latest wallet refresh.`
            : automatic
              ? "Bullpen automatically submitted the resolved positions for claim."
              : "Bullpen submitted the resolved positions for claim.",
        );
      } catch (error) {
        setClaimPositionsStatus(null);
        setClaimPositionsError(
          automatic
            ? `Automatic Bullpen claim failed: ${normalizeError(error)}`
            : `Bullpen claim failed: ${normalizeError(error)}`,
        );
      } finally {
        setIsClaimingPositions(false);
      }
    })();

    claimPositionsTaskRef.current = task;
    try {
      await task;
    } finally {
      claimPositionsTaskRef.current = null;
    }
  }

  async function refreshBullpenPositions(
    options?: { suppressAutoClaim?: boolean },
  ): Promise<RefreshBullpenPositionsResult> {
    setIsLoadingPositions(true);
    setPositionsError(null);

    try {
      const livePositionsResponse = await fetch("/api/bullpen-ai/positions", {
        cache: "no-store",
      });
      const livePositionsPayload =
        (await livePositionsResponse.json()) as BullpenPositionsResponse;
      const normalizedLiveSnapshot = normalizeLiveSnapshot(
        livePositionsPayload.lastSuccessfulLiveSnapshot,
      );
      const livePositions = (livePositionsPayload.positions || []).map(
        applyResolvedPositionCloseTime,
      );

      setActivePositions(livePositions);
      setHasLoadedPositions(true);
      setPositionsFallback(livePositionsPayload.fallback || null);
      setPositionsHealth(livePositionsPayload.health || null);
      setPositionsSource(livePositionsPayload.positionsSource || null);
      setLastSuccessfulLiveSnapshot(normalizedLiveSnapshot);
      setPositionsLastUpdatedAt(
        livePositionsPayload.fetchedAt ||
          normalizedLiveSnapshot?.fetchedAt ||
          new Date().toISOString(),
      );
      setPositionsError(
        livePositionsPayload.error ||
          (!livePositionsPayload.liveAvailable && livePositions.length === 0
            ? livePositionsPayload.health?.message ||
              "Live Bullpen wallet positions are unavailable right now."
            : null),
      );

      if (!livePositionsPayload.liveAvailable) {
        lastAutoClaimAttemptRef.current = null;
        return {
          positions: livePositions,
          error: livePositionsPayload.error || null,
        };
      }

      const claimableSignature = buildClaimableBullpenSignature(livePositions);
      if (!claimableSignature) {
        lastAutoClaimAttemptRef.current = null;
      } else if (!options?.suppressAutoClaim) {
        const lastAttempt = lastAutoClaimAttemptRef.current;
        const shouldAutoClaim =
          !lastAttempt ||
          lastAttempt.signature !== claimableSignature ||
          Date.now() - lastAttempt.attemptedAt >=
            AUTO_CLAIM_RETRY_COOLDOWN_MS;
        if (shouldAutoClaim) {
          lastAutoClaimAttemptRef.current = {
            signature: claimableSignature,
            attemptedAt: Date.now(),
          };
          void claimBullpenResolvedPositions({
            automatic: true,
            positions: livePositions,
          });
        }
      }
      if (!livePositionsResponse.ok) {
        lastAutoClaimAttemptRef.current = null;
      }
      return {
        positions: livePositions,
        error: livePositionsPayload.error || null,
      };
    } catch (error) {
      const normalizedError = `Failed to load Bullpen wallet positions: ${normalizeError(error)}.`;
      setHasLoadedPositions(true);
      setPositionsError(normalizedError);
      return {
        positions: activePositions,
        error: normalizedError,
      };
    } finally {
      setIsLoadingPositions(false);
    }
  }

  function syncBullpenScanSnapshot(
    snapshot: BullpenScanSnapshot,
    options?: { resetSelections?: boolean },
  ) {
    const resetSelections = options?.resetSelections ?? true;
    setSnapshotsByMode((current) => {
      const previousCurrent = current[activeMode].current;
      return {
        ...current,
        [activeMode]: {
          current: snapshot,
          history: previousCurrent
            ? [
                archiveBullpenScanSnapshot(previousCurrent),
                ...current[activeMode].history,
              ].slice(0, MAX_BULLPEN_SNAPSHOT_HISTORY)
            : current[activeMode].history,
        },
      };
    });
    setSelectedSnapshotIdByMode((current) => ({
      ...current,
      [activeMode]: null,
    }));
    if (!resetSelections) {
      return;
    }
    setSelectedQuestionIdsByMode((current) => ({
      ...current,
      [activeMode]: [],
    }));
    setSelectedInvestmentQuestionIdsByMode((current) => ({
      ...current,
      [activeMode]: [],
    }));
  }

  async function executeBullpenScan(options?: { resetSelections?: boolean }) {
    const params = buildBullpenScanQueryParams(activeMode, activeFilters);
    setScanningMode(activeMode);
    setMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    const positionsRefreshTask = refreshBullpenPositions({
      suppressAutoClaim: true,
    });

    try {
      const response = await fetch(`/api/bullpen-ai?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as ScanResult;
      const isSuccessfulScan = response.ok && !payload.error;

      await positionsRefreshTask;

      const nextSnapshot = isSuccessfulScan
        ? createBullpenScanSnapshot(payload)
        : null;
      if (nextSnapshot) {
        syncBullpenScanSnapshot(nextSnapshot, {
          resetSelections: options?.resetSelections,
        });
      }

      const message =
        !response.ok || payload.error
          ? payload.error || "Bullpen scan failed."
          : payload.warning
            ? payload.warning
            : payload.questions.length === 0
              ? "No Bullpen questions matched the current scan filters. Adjust the filters or rerun later."
              : null;
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]: message,
      }));

      return {
        snapshot: nextSnapshot,
        error: !isSuccessfulScan
          ? payload.error || "Bullpen scan failed."
          : null,
      };
    } catch (scanError) {
      await positionsRefreshTask;
      const message =
        scanError instanceof Error
          ? scanError.message
          : "Bullpen scan failed.";
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]: message,
      }));
      return {
        snapshot: null,
        error: message,
      };
    } finally {
      setScanningMode(null);
    }
  }

  async function runScan() {
    await executeBullpenScan({ resetSelections: true });
  }

  async function runLlm(targets: ProviderModelTarget[]) {
    if (targets.length === 0) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: "Select at least one LLM before running analysis.",
      }));
      return;
    }

    if (!activeCurrentSnapshot) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: "Run Bullpen Scan first so there is a current table to analyze.",
      }));
      return;
    }

    if (isViewingHistory) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          "Switch back to the current snapshot before running LLM analysis. Saved history is read-only.",
      }));
      return;
    }

    const selectedQuestions = activeCurrentSnapshot.questions.filter((question) =>
      selectedQuestionIdSet.has(question.id),
    );
    const [refreshedQuestionsResult, refreshedPositionsResult] =
      await Promise.all([
        selectedQuestions.length > 0
          ? refreshCurrentOdds({
              questionIds: selectedQuestions.map((question) => question.id),
              announceResult: false,
              showLoadingState: false,
            })
          : Promise.resolve(null),
        refreshBullpenPositions({
          suppressAutoClaim: true,
        }),
      ]);
    const refreshedSelectedQuestions = selectedQuestions.map((question) => {
      const refreshedQuestion = refreshedQuestionsResult?.refreshedQuestions.find(
        (item) => item.id === question.id,
      );
      return refreshedQuestion || question;
    });
    const refreshedOpenActivePositions = refreshedPositionsResult.positions.filter(
      (position) => !position.isClaimable,
    );
    const llmTargetSet = buildBullpenLlmRunTargetSet({
      activePositions: refreshedOpenActivePositions,
      analysesByPositionKey: activePositionAnalysesByKey,
      selectedQuestions: refreshedSelectedQuestions,
    });
    const questionsToAnalyze = llmTargetSet.questions;

    if (questionsToAnalyze.length === 0) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          "Select at least one Bullpen question or keep an active position open before running LLM analysis.",
      }));
      return;
    }

    setLlmRunningMode(activeMode);
    setLlmRunStartedAtByMode((current) => ({
      ...current,
      [activeMode]: Date.now(),
    }));
    setLlmMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setLastLlmTargets(targets);
    writeLastLlmTargetsToStorage(targets);

    try {
      const promptInputs = buildBullpenLlmPromptInputs(questionsToAnalyze);
      const polymarketEventContext: PolymarketEventRunContext = {
        kind: "polymarket_bullpen_event",
        prompt_template: bullpenLlmPromptTemplate,
        question_payload: promptInputs.questionPayload,
        evidence_options: {
          require_fresh_internet_evidence: requireFreshInternetEvidence,
          allow_evidence_grounded_non_web_models:
            allowEvidenceGroundedNonWebModels,
        },
      };
      const run = await apiService.createRun({
        prompt: buildBullpenLlmPrompt(
          questionsToAnalyze,
          bullpenLlmPromptTemplate,
          promptInputs,
        ),
        targets,
        allow_parallel: true,
        polymarket_event_context: polymarketEventContext,
      });
      const completedRun = await waitForBullpenRunCompletion(run.id);
      const targetOrder = new Map(
        targets.map((target, index) => [
          `${target.provider}::${target.model}`,
          index,
        ]),
      );
      const selectedRunJobs = completedRun.run_jobs
        .filter((runJob) =>
          targetOrder.has(`${runJob.job.provider}::${runJob.job.model}`),
        )
        .sort(
          (left, right) =>
            (targetOrder.get(`${left.job.provider}::${left.job.model}`) ?? 0) -
            (targetOrder.get(`${right.job.provider}::${right.job.model}`) ?? 0),
        );
      setHistoricalCostInrByTarget((current) => {
        const next = { ...current };
        for (const runJob of selectedRunJobs) {
          const key = toHistoricalCostKey(
            runJob.job.provider,
            runJob.job.model,
          );
          if (!key || !hasKnownUsdCost(runJob.job.estimated_cost)) continue;
          next[key] = toRoundedInrCost(runJob.job.estimated_cost, usdInrRate);
        }
        return next;
      });
      const questionIdsToAnalyze = new Set(
        questionsToAnalyze.map((question) => question.id),
      );
      const breakdownByQuestionId = new Map<
        string,
        BullpenQuestionRow["llmBreakdown"]
      >();
      const failedModels: string[] = [];
      let successfulModelCount = 0;
      let unmatchedCount = 0;

      for (const runJob of selectedRunJobs) {
        const label = `${runJob.job.provider} / ${runJob.job.model}`;
        const responseText = runJob.job.response;
        const runtimeMetadata = normalizePolymarketEventRuntimeMetadata(
          runJob.job.runtime_metadata_json,
        );

        if (!responseText) {
          failedModels.push(
            `${label}: ${runJob.job.error_message || `job ${runJob.job.status.toLowerCase()}`}`,
          );
          continue;
        }

        try {
          const analysisPayload = parseBullpenLlmAnalysisPayload(
            responseText,
            questionsToAnalyze,
          );
          const analysisByQuestionId = new Map(
            analysisPayload.markets
              .filter((item) => questionIdsToAnalyze.has(item.questionId))
              .map((item) => [item.questionId, item] as const),
          );

          unmatchedCount += Math.max(
            0,
            analysisPayload.markets.length - analysisByQuestionId.size,
          );
          successfulModelCount += 1;

          analysisByQuestionId.forEach((item, questionId) => {
            const currentBreakdown = breakdownByQuestionId.get(questionId) || [];
            const questionRuntimeMetadata = getBullpenQuestionRuntimeMetadata(
              runJob.job.runtime_metadata_json,
              questionId,
            );
            const preflightEvidenceBlock =
              questionRuntimeMetadata?.preflight_evidence_block ||
              promptInputs.preflightEvidenceBlocksByQuestionId[questionId] ||
              null;
            const fallbackStaleFactValidation = validateBullpenStaleFacts(
              preflightEvidenceBlock,
              item.rationale || item.notes,
            );
            const staleFactDetected =
              questionRuntimeMetadata?.stale_fact_detected ??
              fallbackStaleFactValidation.invalidStaleFact ??
              false;
            const invalidReason =
              questionRuntimeMetadata?.invalid_reason ||
              (staleFactDetected
                ? fallbackStaleFactValidation.staleFactReason
                : null) ||
              runtimeMetadata?.invalid_reason ||
              null;
            currentBreakdown.push({
              provider: runJob.job.provider,
              model: runJob.job.model,
              jobId: runJob.job.id,
              runId: completedRun.id,
              timestamp: runJob.job.updated_at || completedRun.updated_at,
              llmYesOdds: item.llmYesOdds,
              llmNoOdds: item.llmNoOdds,
              yesDefinition: item.yesDefinition,
              deadlineEt: item.deadlineEt,
              hoursRemaining: item.hoursRemaining,
              evidenceStatus: item.evidenceStatus,
              eventState: item.eventState,
              confidence: item.confidence,
              keyEvidence: item.keyEvidence,
              redFlags: item.redFlags,
              rationale: item.rationale || item.notes,
              webSearchUsed:
                questionRuntimeMetadata?.web_search_used ??
                runtimeMetadata?.web_search_used ??
                runJob.job.web_search_used ??
                null,
              webSearchQueries:
                questionRuntimeMetadata?.web_search_queries ||
                runtimeMetadata?.web_search_queries ||
                runJob.job.web_search_queries ||
                [],
              webSources:
                questionRuntimeMetadata?.web_sources ||
                runtimeMetadata?.web_sources ||
                runJob.job.web_sources ||
                [],
              internetVerified:
                questionRuntimeMetadata?.internet_verified ??
                runtimeMetadata?.internet_verified ??
                null,
              evidenceBlockUsed:
                questionRuntimeMetadata?.evidence_block_used ??
                runtimeMetadata?.evidence_block_used ??
                Boolean(preflightEvidenceBlock),
              staleFactDetected,
              invalidReason,
              invalidStaleFact: staleFactDetected,
              staleFactReason:
                fallbackStaleFactValidation.staleFactReason ||
                runtimeMetadata?.invalid_reason ||
                null,
            });
            breakdownByQuestionId.set(questionId, currentBreakdown);
          });
        } catch (jobError) {
          failedModels.push(`${label}: ${normalizeError(jobError)}`);
        }
      }

      if (breakdownByQuestionId.size === 0) {
        throw new Error(
          failedModels.length > 0
            ? failedModels.join(" | ")
            : `Run #${completedRun.id} did not return any usable LLM output.`,
        );
      }

      const matchedQuestionCount = breakdownByQuestionId.size;
      const analysisBySnapshotQuestionId = new Map<
        string,
        BullpenQuestionRow["llmBreakdown"]
      >();
      const preflightBySnapshotQuestionId = new Map<string, string>();
      const analysisByPositionKey = new Map<
        string,
        BullpenQuestionRow["llmBreakdown"]
      >();
      const preflightByPositionKey = new Map<string, string>();

      for (const [questionId, llmBreakdown] of breakdownByQuestionId.entries()) {
        const links = llmTargetSet.linksByQuestionId[questionId] || [];
        const preflightEvidenceBlock =
          promptInputs.preflightEvidenceBlocksByQuestionId[questionId] || null;
        for (const link of links) {
          if (link.kind === "snapshot") {
            analysisBySnapshotQuestionId.set(link.questionId, llmBreakdown);
            if (preflightEvidenceBlock) {
              preflightBySnapshotQuestionId.set(
                link.questionId,
                preflightEvidenceBlock,
              );
            }
          } else {
            analysisByPositionKey.set(link.positionKey, llmBreakdown);
            if (preflightEvidenceBlock) {
              preflightByPositionKey.set(
                link.positionKey,
                preflightEvidenceBlock,
              );
            }
          }
        }
      }

      const matchedCount =
        analysisBySnapshotQuestionId.size + analysisByPositionKey.size;
      const rowsWithOddsCount = Array.from(breakdownByQuestionId.values()).filter(
        (llmBreakdown) => {
          const consensus = computeBullpenLlmConsensus(llmBreakdown);
          return (
            consensus.consensusYesOdds !== null ||
            consensus.consensusNoOdds !== null
          );
        },
      ).length;
      const blankOddsCount = matchedQuestionCount - rowsWithOddsCount;

      setSnapshotsByMode((current) => {
        const currentSnapshot = current[activeMode].current;
        if (!currentSnapshot) return current;

        const nextQuestions = currentSnapshot.questions.map((question) => {
          const llmBreakdown = analysisBySnapshotQuestionId.get(question.id);
          if (!llmBreakdown || llmBreakdown.length === 0) return question;

          const consensus = computeBullpenLlmConsensus(llmBreakdown);
          const completedAt =
            [...llmBreakdown]
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) || new Date().toISOString();

          return createBullpenQuestionRow({
            ...question,
            llmYesOdds: consensus.consensusYesOdds,
            llmNoOdds: consensus.consensusNoOdds,
            llmNotes: summarizeBullpenLlmNotes(llmBreakdown),
            llmProvider:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null,
            llmModel:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null,
            llmRunId: completedRun.id,
            llmCompletedAt: completedAt,
            preflightEvidenceBlock:
              preflightBySnapshotQuestionId.get(question.id) ?? null,
            llmBreakdown,
          });
        });

        return {
          ...current,
          [activeMode]: {
            ...current[activeMode],
            current: {
              ...currentSnapshot,
              questions: nextQuestions,
            },
          },
        };
      });
      setSelectedInvestmentQuestionIdsByMode((current) => {
        const currentSnapshot = snapshotsByMode[activeMode].current;
        const sourceQuestions = currentSnapshot?.questions || [];
        const nextQuestions = sourceQuestions.map((question) => {
          const llmBreakdown = analysisBySnapshotQuestionId.get(question.id);
          if (!llmBreakdown || llmBreakdown.length === 0) return question;

          const consensus = computeBullpenLlmConsensus(llmBreakdown);
          const completedAt =
            [...llmBreakdown]
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) || new Date().toISOString();

          return createBullpenQuestionRow({
            ...question,
            llmYesOdds: consensus.consensusYesOdds,
            llmNoOdds: consensus.consensusNoOdds,
            llmNotes: summarizeBullpenLlmNotes(llmBreakdown),
            llmProvider:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null,
            llmModel:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null,
            llmRunId: completedRun.id,
            llmCompletedAt: completedAt,
            preflightEvidenceBlock:
              preflightBySnapshotQuestionId.get(question.id) ?? null,
            llmBreakdown,
          });
        });
        const eligibleIds = nextQuestions
          .filter((question) => {
            return (
              isBullpenQuestionInvestmentCandidate(question) &&
              buildBullpenManualInvestOrder(question) !== null
            );
          })
          .map((question) => question.id);

        return {
          ...current,
          [activeMode]: eligibleIds,
        };
      });
      setActivePositionAnalysesByKey((current) => {
        const next = { ...current };
        const activePositionLookup = new Map(
          refreshedOpenActivePositions.map(
            (position) => [position.key, position] as const,
          ),
        );

        for (const [positionKey, llmBreakdown] of analysisByPositionKey.entries()) {
          const position = activePositionLookup.get(positionKey);
          if (!position || llmBreakdown.length === 0) continue;

          const consensus = computeBullpenLlmConsensus(llmBreakdown);
          const completedAt =
            [...llmBreakdown]
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) || new Date().toISOString();
          const analyzedPosition = buildBullpenQuestionRowFromActivePosition(
            position,
            {
              llmYesOdds: consensus.consensusYesOdds,
              llmNoOdds: consensus.consensusNoOdds,
              llmNotes: summarizeBullpenLlmNotes(llmBreakdown),
              llmProvider:
                llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null,
              llmModel:
                llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null,
              llmRunId: completedRun.id,
              llmCompletedAt: completedAt,
              preflightEvidenceBlock:
                preflightByPositionKey.get(positionKey) ?? null,
              llmBreakdown,
            },
          );
          next[positionKey] = extractBullpenActivePositionLlmAnalysis(
            analyzedPosition,
          );
        }

        return next;
      });

      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: {
          selectedModels: targets.length,
          uniqueQuestionsAnalyzed: questionsToAnalyze.length,
          rowsWithConsensusOdds: rowsWithOddsCount,
          usableJsonModels: successfulModelCount,
          failedModels: failedModels.map(splitBullpenFailedModel),
          matchedRowsWithoutUsableOdds: blankOddsCount,
          unmatchedReturnedRows: unmatchedCount,
          matchedRows: matchedCount,
          activePositionsUpdated: analysisByPositionKey.size,
          selectedScanQuestionsUpdated: analysisBySnapshotQuestionId.size,
        },
      }));
    } catch (error) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: normalizeError(error),
      }));
    } finally {
      setLlmRunningMode(null);
      setLlmRunStartedAtByMode((current) => ({
        ...current,
        [activeMode]: null,
      }));
    }
  }

  async function refreshCurrentOdds({
    questionIds,
    announceResult = true,
    showLoadingState = true,
  }: {
    questionIds?: string[];
    announceResult?: boolean;
    showLoadingState?: boolean;
  } = {}) {
    if (!activeCurrentSnapshot || !selectionEnabled) {
      throw new Error(
        "Switch back to the current snapshot before refreshing Current %.",
      );
    }

    const questionIdsToRefresh =
      questionIds ?? activeCurrentSnapshot.questions.map((question) => question.id);
    const refreshesVisibleQuestions = questionIds === undefined;
    const selectedQuestionIdSet = new Set(questionIdsToRefresh);
    const questionsToRefresh = activeCurrentSnapshot.questions.filter((question) =>
      selectedQuestionIdSet.has(question.id),
    );

    if (questionsToRefresh.length === 0) {
      throw new Error(
        refreshesVisibleQuestions
          ? "No visible questions are available to refresh Current %."
          : "Select at least one pink event before refreshing Current %.",
      );
    }

    if (showLoadingState) {
      setRefreshingCurrentOddsMode(activeMode);
      setInvestmentProgressByMode((current) => ({
        ...current,
        [activeMode]: `Refreshing latest Polymarket odds for ${formatCountLabel(
          questionsToRefresh.length,
          refreshesVisibleQuestions ? "visible question" : "selected event",
        )}...`,
      }));
    }

    try {
      const response = await fetch("/api/bullpen-ai/current-odds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          questions: questionsToRefresh.map((question) => ({
            id: question.id,
            question: question.question,
            slug: question.slug,
            marketUrl: question.marketUrl,
          })),
        }),
      });
      const payload = (await response.json()) as BullpenCurrentOddsRefreshResponse;
      if (!response.ok) {
        throw new Error(
          payload.error || "Failed to refresh current Polymarket odds.",
        );
      }

      const marketUpdates = payload.markets || {};
      const currentOddsUpdatedAt = new Date().toISOString();
      const currentSnapshotId = activeCurrentSnapshot.snapshotId;
      const nextQuestions = activeCurrentSnapshot.questions.map((question) => {
        const update = marketUpdates[question.id];
        if (!update) return question;
        return createBullpenQuestionRow({
          ...question,
          slug: update.slug ?? question.slug,
          marketUrl: update.marketUrl ?? question.marketUrl,
          yesOdds: update.yesOdds ?? question.yesOdds,
          noOdds: update.noOdds ?? question.noOdds,
          currentOddsUpdatedAt,
          rules: update.rules ?? question.rules,
          marketContext: update.marketContext ?? question.marketContext,
          resolutionSource:
            update.resolutionSource ?? question.resolutionSource,
        });
      });
      const refreshedQuestionIds = new Set(Object.keys(marketUpdates));
      const unresolvedCount = payload.unresolvedQuestionIds?.length || 0;

      setSnapshotsByMode((current) => ({
        ...current,
        [activeMode]: {
          ...current[activeMode],
          current: applySnapshotMarketUpdates(
            current[activeMode].current,
            currentSnapshotId,
            marketUpdates,
            currentOddsUpdatedAt,
          ),
          history: current[activeMode].history,
        },
      }));

      if (announceResult) {
        const summaryParts = [
          `Refreshed Current % for ${formatCountLabel(
            refreshedQuestionIds.size,
            refreshesVisibleQuestions ? "visible question" : "selected event",
          )}.`,
        ];
        if (unresolvedCount > 0) {
          summaryParts.push(
            `${formatCountLabel(
              unresolvedCount,
              refreshesVisibleQuestions ? "visible question" : "selected event",
            )} could not be refreshed from Polymarket.`,
          );
        }
        setInvestmentMessagesByMode((current) => ({
          ...current,
          [activeMode]: summaryParts.join(" "),
        }));
      }

      return {
        refreshedQuestions: nextQuestions.filter((question) =>
          selectedQuestionIdSet.has(question.id),
        ),
        refreshedCount: refreshedQuestionIds.size,
        unresolvedCount,
      };
    } finally {
      if (showLoadingState) {
        setRefreshingCurrentOddsMode(null);
        setInvestmentProgressByMode((current) => ({
          ...current,
          [activeMode]: null,
        }));
      }
    }
  }

  async function pollBullpenInvestmentProgress(
    isStopped: () => boolean,
    fallbackMessage: string,
  ) {
    while (!isStopped()) {
      try {
        const state = await apiService.polymarketState();
        if (isStopped()) return;

        const latestActivity = state.recent_activity[0]?.message?.trim();
        const nextMessage =
          latestActivity ||
          (state.live.balance.status === "loading"
            ? "Bullpen is syncing the latest wallet balance..."
            : fallbackMessage);
        if (nextMessage) {
          setInvestmentProgressByMode((current) => ({
            ...current,
            [activeMode]: nextMessage,
          }));
        }
      } catch {
        if (isStopped()) return;
      }

      await new Promise((resolve) =>
        window.setTimeout(resolve, INVESTMENT_PROGRESS_POLL_MS),
      );
    }
  }

  async function investInSelectedEvents() {
    if (!activeCurrentSnapshot || !selectionEnabled) {
      setInvestmentMessagesByMode((current) => ({
        ...current,
        [activeMode]: "Switch back to the current snapshot before placing Bullpen orders.",
      }));
      return;
    }

    setInvestingMode(activeMode);
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentProgressByMode((current) => ({
      ...current,
      [activeMode]: `Refreshing latest Polymarket odds for ${formatCountLabel(selectedInvestmentQuestionIds.length, "selected event")} before placing orders...`,
    }));

    let stopProgressPolling = false;
    let progressPollingTask: Promise<void> | null = null;

    try {
      const { refreshedQuestions, refreshedCount, unresolvedCount } =
        await refreshCurrentOdds({
          questionIds: selectedInvestmentQuestionIds,
          announceResult: false,
          showLoadingState: false,
        });
      const refreshedEligibleQuestions = refreshedQuestions.filter((question) =>
        isBullpenQuestionInvestmentCandidate(question),
      );
      const noLongerQualifiedCount =
        refreshedQuestions.length - refreshedEligibleQuestions.length;
      const selectedOrders = refreshedEligibleQuestions
        .map((question) => buildBullpenManualInvestOrder(question))
        .filter(
          (order): order is PolymarketManualInvestOrderRequest => Boolean(order),
        );

      if (selectedOrders.length === 0) {
        setInvestmentMessagesByMode((current) => ({
          ...current,
          [activeMode]:
            noLongerQualifiedCount > 0
              ? "After refreshing Polymarket, the selected rows were no longer pink invest candidates, so no Bullpen orders were placed."
              : "The selected rows still need a valid market slug after refresh, so no Bullpen orders were placed.",
        }));
        return;
      }

      setInvestmentProgressByMode((current) => ({
        ...current,
        [activeMode]:
          refreshedCount > 0
            ? `Latest Polymarket odds synced for ${formatCountLabel(refreshedCount, "selected event")}. Bullpen is now checking your trading session and placing ${formatCountLabel(selectedOrders.length, "order")}.`
            : `Bullpen is checking your trading session and placing ${formatCountLabel(selectedOrders.length, "order")}.`,
      }));
      progressPollingTask = pollBullpenInvestmentProgress(
        () => stopProgressPolling,
        "Bullpen is still working through the selected orders...",
      );

      const response: PolymarketManualInvestResponse =
        await apiService.polymarketManualInvest({
          orders: selectedOrders,
        });
      void refreshBullpenPositions();
      const executedOrders = response.orders.filter(
        (order) => order.status === "executed",
      );
      const failedOrders = response.orders.filter(
        (order) => order.status !== "executed",
      );

      setSelectedInvestmentQuestionIdsByMode((current) => ({
        ...current,
        [activeMode]: failedOrders.map((order) => order.question_id),
      }));

      const summaryParts: string[] = [];
      if (executedOrders.length > 0 && failedOrders.length === 0) {
        summaryParts.push(
          `Investing was successful. Placed ${executedOrders.length} Bullpen order${executedOrders.length === 1 ? "" : "s"}.`,
        );
      } else if (executedOrders.length > 0) {
        summaryParts.push(
          `Investing was partially successful. Placed ${executedOrders.length} Bullpen order${executedOrders.length === 1 ? "" : "s"}.`,
        );
      } else {
        summaryParts.push("Investing was not successful. No Bullpen orders were placed.");
      }
      if (failedOrders.length > 0) {
        summaryParts.push(
          `${failedOrders.length} order${failedOrders.length === 1 ? "" : "s"} failed: ${failedOrders
            .map((order) => `${order.market_title}: ${order.message}`)
            .join(" | ")}.`,
        );
      }
      if (unresolvedCount > 0) {
        summaryParts.push(
          `${formatCountLabel(unresolvedCount, "selected event")} could not be refreshed from Polymarket first, so it was skipped unless a saved slug was already available.`,
        );
      }
      if (noLongerQualifiedCount > 0) {
        summaryParts.push(
          `${formatCountLabel(noLongerQualifiedCount, "selected event")} was skipped because the refreshed odds no longer met the pink-row threshold.`,
        );
      }

      setInvestmentMessagesByMode((current) => ({
        ...current,
        [activeMode]: summaryParts.join(" "),
      }));
    } catch (error) {
      setInvestmentMessagesByMode((current) => ({
        ...current,
        [activeMode]: `Investing was not successful. ${normalizeError(error)}`,
      }));
    } finally {
      stopProgressPolling = true;
      if (progressPollingTask) {
        await progressPollingTask;
      }
      setInvestingMode(null);
      setInvestmentProgressByMode((current) => ({
        ...current,
        [activeMode]: null,
      }));
    }
  }

  async function handleRefreshCurrentOdds() {
    try {
      const [snapshotRefreshResult, positionsRefreshResult] = await Promise.all([
        refreshCurrentOdds({
          announceResult: false,
        }),
        refreshBullpenPositions({
          suppressAutoClaim: true,
        }),
      ]);
      const summaryParts = [
        `Refreshed Current % for ${formatCountLabel(
          snapshotRefreshResult.refreshedCount,
          "visible question",
        )}.`,
        `Updated ${formatCountLabel(
          positionsRefreshResult.positions.filter((position) => !position.isClaimable)
            .length,
          "active position",
        )}.`,
      ];
      if (snapshotRefreshResult.unresolvedCount > 0) {
        summaryParts.push(
          `${formatCountLabel(
            snapshotRefreshResult.unresolvedCount,
            "visible question",
          )} could not be refreshed from Polymarket.`,
        );
      }
      if (positionsRefreshResult.error) {
        summaryParts.push(positionsRefreshResult.error);
      }
      setInvestmentMessagesByMode((current) => ({
        ...current,
        [activeMode]: summaryParts.join(" "),
      }));
    } catch (error) {
      setInvestmentMessagesByMode((current) => ({
        ...current,
        [activeMode]: normalizeError(error),
      }));
    }
  }

  const currentTableEmptyMessage = isScanning
    ? "Scanning Bullpen..."
    : activeVisibleSnapshot
      ? "No saved questions are available in this snapshot."
      : "No scan results yet. Click Run Bullpen Scan to load matching Bullpen questions.";
  const investmentEmptyMessage = !activeCurrentSnapshot
    ? "Run Bullpen Scan first to load the current questions table."
    : !activeHasAnyLlmOdds
      ? "Run LLM analysis first. Pink invest rows appear after LLM Yes or No Odds qualify."
      : "No rows are currently pink. Rows appear here when LLM Yes or No Odds is above 80%.";

  function handlePromptTemplateSave(template: string) {
    setBullpenLlmPromptTemplate(template);
    writeBullpenLlmPromptToStorage(template);
  }

  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6">
      <div>
        <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
          Copy Trading Bots
        </p>
        <h1 className="mt-2 text-3xl font-bold tracking-tight text-slate-950">
          Bullpen x AI
        </h1>
        <p className="mt-2 max-w-3xl text-sm text-slate-600">
          Run Bullpen scans inside the selected time window, tune the scan
          filters from the menu, then inspect the matching markets in a saved
          table that persists across refresh.
        </p>
      </div>

      <BullpenAutoRunScheduleCard
        buildRunNowRequest={buildRunNowRequest}
        activePositions={openActivePositions}
        hasActivePositionsSnapshot={Boolean(positionsLastUpdatedAt)}
        onSummaryUpdated={({ summary, run }) => {
          setSnapshotsByMode((current) =>
            syncBullpenAutoRunSummarySnapshots({
              snapshotsByMode: current,
              summary,
              run,
              fallbackMode: activeMode,
            }),
          );
          setActivePositionAnalysesByKey((current) =>
            syncBullpenAutoRunActivePositionAnalyses({
              currentAnalyses: current,
              run,
            }),
          );
        }}
        onRunCompleted={() => {
          void refreshBullpenPositions({ suppressAutoClaim: true });
        }}
      />

      <div className="flex flex-wrap gap-2 rounded-2xl border border-slate-200 bg-white p-2 shadow-sm">
        {TABS.map((tab) => (
          <Link
            key={tab.mode}
            href={tab.href}
            className={`rounded-xl px-4 py-2 text-sm font-semibold transition ${activeMode === tab.mode ? "bg-slate-950 text-white" : "text-slate-600 hover:bg-slate-100 hover:text-slate-950"}`}
          >
            {tab.label}
          </Link>
        ))}
      </div>

      <Card className="border-slate-200 shadow-sm">
        <CardHeader className="gap-2">
          <CardTitle>{activeTab.label} Bullpen Scan</CardTitle>
          <CardDescription>
            {getModeDescription(activeMode, activeFilters)}
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          <div className="grid gap-4 rounded-2xl border border-slate-200 bg-white p-4 lg:grid-cols-[minmax(0,1fr)_22rem]">
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                Current Filters
              </p>
              <p className="mt-2 text-sm text-slate-700">
                Open the scan menu to edit the time window, odds floors, and
                market exclusions for the next Bullpen run.
              </p>
              <div className="mt-4 flex flex-wrap gap-2">
                {activeFilterBadges.map((badge) => (
                  <span
                    key={badge}
                    className="rounded-full border border-slate-200 bg-white px-3 py-1 text-xs font-medium text-slate-700"
                  >
                    {badge}
                  </span>
                ))}
              </div>
            </div>
            <div className="flex flex-col justify-between gap-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Source
                </p>
                <p className="mt-2 text-sm text-slate-700">
                  Scan Bullpen&apos;s trending source for this tab, then fall back to
                  alternate market feeds only if Bullpen access fails.
                </p>
              </div>
              <div className="space-y-2">
                <div ref={scanFiltersMenuRef} className="relative">
                  <div className="flex items-center">
                    <Button
                      onClick={() => {
                        setIsScanFiltersOpen(false);
                        void runScan();
                      }}
                      disabled={isScanning}
                      className="min-w-0 flex-1 rounded-r-none gap-2 whitespace-nowrap"
                    >
                      {isScanning ? (
                        <Loader2 className="h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="h-4 w-4" />
                      )}
                      <span className="truncate">Run Bullpen Scan</span>
                    </Button>
                    <Button
                      size="icon"
                      className="h-10 w-10 rounded-l-none border-l border-primary-foreground/15"
                      onClick={() =>
                        setIsScanFiltersOpen((current) => !current)
                      }
                      title="Open scan filters"
                      aria-label="Open scan filters"
                      aria-expanded={isScanFiltersOpen}
                      aria-haspopup="dialog"
                    >
                      <Menu className="h-4 w-4" />
                    </Button>
                  </div>
                  {isScanFiltersOpen ? (
                    <div className="absolute right-0 top-full z-20 mt-2 w-[min(34rem,calc(100vw-3rem))] rounded-2xl border border-slate-200 bg-white p-4 shadow-xl">
                      <div className="flex flex-wrap items-center justify-between gap-3">
                        <div>
                          <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                            Scan Filters
                          </p>
                          <p className="mt-1 text-sm text-slate-600">
                            These settings apply to the next Bullpen scan.
                          </p>
                        </div>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => resetActiveFilters()}
                        >
                          Reset Filters
                        </Button>
                      </div>

                      <div className="mt-4 space-y-4">
                        <div className="grid gap-4 sm:grid-cols-3">
                          <div className="space-y-2 sm:col-span-3">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              {activeMode === "30-days"
                                ? "Closing Window"
                                : "Target Date"}
                            </p>
                            {activeMode === "30-days" ? (
                              <>
                                <input
                                  type="number"
                                  min={1}
                                  step={1}
                                  value={activeFilters.maxClosingDays}
                                  onChange={(event) => {
                                    const parsed = Number(event.target.value);
                                    if (!Number.isFinite(parsed)) return;
                                    updateActiveFilters({
                                      maxClosingDays: Math.max(1, parsed),
                                    });
                                  }}
                                  className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                                />
                                <p className="text-xs leading-5 text-slate-600">
                                  Include only questions closing within this many days.
                                </p>
                              </>
                            ) : (
                              <>
                                <input
                                  type="date"
                                  value={activeFilters.targetDate}
                                  onChange={(event) =>
                                    updateActiveFilters({
                                      targetDate: event.target.value,
                                    })
                                  }
                                  className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                                />
                                <p className="text-xs leading-5 text-slate-600">
                                  Only questions whose closing date matches this calendar day.
                                </p>
                              </>
                            )}
                          </div>

                          <div className="space-y-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Min Yes Odds %
                            </p>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={activeFilters.minYesOdds}
                              onChange={(event) => {
                                const parsed = Number(event.target.value);
                                if (!Number.isFinite(parsed)) return;
                                updateActiveFilters({
                                  minYesOdds: Math.max(0, parsed),
                                });
                              }}
                              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                            />
                            <p className="text-xs leading-5 text-slate-600">
                              Require the Yes side to meet or exceed this Bullpen odds percentage floor.
                            </p>
                          </div>

                          <div className="space-y-2">
                            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                              Min No Odds %
                            </p>
                            <input
                              type="number"
                              min={0}
                              step={0.1}
                              value={activeFilters.minNoOdds}
                              onChange={(event) => {
                                const parsed = Number(event.target.value);
                                if (!Number.isFinite(parsed)) return;
                                updateActiveFilters({
                                  minNoOdds: Math.max(0, parsed),
                                });
                              }}
                              className="h-11 w-full rounded-xl border border-slate-200 bg-slate-50 px-3 text-sm text-slate-900 outline-none transition focus:border-slate-400"
                            />
                            <p className="text-xs leading-5 text-slate-600">
                              Require the No side to meet or exceed this Bullpen odds percentage floor.
                            </p>
                          </div>
                        </div>

                        <div className="grid gap-3 sm:grid-cols-2">
                          <p className="text-xs leading-5 text-slate-500 sm:col-span-2">
                            Use the checkbox to toggle a rule. Click any card to
                            inspect the exact matching algorithm.
                          </p>
                          <FilterToggle
                            checked={activeFilters.excludeSports}
                            onChange={(checked) =>
                              updateActiveFilters({ excludeSports: checked })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId("excludeSports")
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS.excludeSports.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS.excludeSports
                                .description
                            }
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeWeather}
                            onChange={(checked) =>
                              updateActiveFilters({ excludeWeather: checked })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId("excludeWeather")
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS.excludeWeather.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS.excludeWeather
                                .description
                            }
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeMarketPredictions}
                            onChange={(checked) =>
                              updateActiveFilters({
                                excludeMarketPredictions: checked,
                              })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId(
                                "excludeMarketPredictions",
                              )
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeMarketPredictions.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeMarketPredictions.description
                            }
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeTweetCountQuestions}
                            onChange={(checked) =>
                              updateActiveFilters({
                                excludeTweetCountQuestions: checked,
                              })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId(
                                "excludeTweetCountQuestions",
                              )
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeTweetCountQuestions.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeTweetCountQuestions.description
                            }
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.onlyBinaryYesNo}
                            onChange={(checked) =>
                              updateActiveFilters({ onlyBinaryYesNo: checked })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId("onlyBinaryYesNo")
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS.onlyBinaryYesNo.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS.onlyBinaryYesNo
                                .description
                            }
                            className="h-full sm:col-span-2"
                          />
                        </div>
                      </div>
                    </div>
                  ) : null}
                </div>
                <div className="flex items-center gap-0">
                  <Button
                    size="icon"
                    className="h-10 w-10 border-r border-primary-foreground/15"
                    onClick={() => setIsPromptEditorOpen(true)}
                    title="Open Bullpen LLM prompt"
                    aria-label="Open Bullpen LLM prompt"
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  <EventScanRunControls
                    buttonLabel="Run LLM"
                    containerClassName="gap-0"
                    defaultTargets={getDefaultBullpenLlmTargets(lastLlmTargets)}
                    disabled={
                      !activeCurrentSnapshot ||
                      isViewingHistory ||
                      (selectedQuestionCount === 0 && openActivePositions.length === 0)
                    }
                    selectionMode="multiple"
                    onRunMultiple={runLlm}
                    getSelectionConstraint={getBullpenSelectionConstraint}
                    historicalEstimatedCostInrByTarget={
                      historicalCostInrByTarget
                    }
                    pickerHeaderContent={llmPickerHeaderContent}
                    pickerDialogLabel="Select LLMs"
                    pickerIcon={<Menu className="size-4" />}
                    running={isRunningLlm}
                    buttonClassName="rounded-none"
                    pickerButtonClassName="h-10 w-10 rounded-none border border-l-0 border-transparent bg-primary text-primary-foreground hover:bg-primary/80 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </div>
                {isRunningLlm ? (
                  <div className="rounded-xl border border-sky-200 bg-sky-50 px-3 py-2 text-xs leading-5 text-sky-900">
                    <div className="flex flex-wrap items-center gap-2 font-semibold">
                      <Loader2 className="h-3.5 w-3.5 animate-spin" />
                      <span>LLM running</span>
                      <span className="rounded-full bg-white px-2 py-0.5 font-mono text-sky-950 shadow-sm">
                        {formatElapsedTime(llmElapsedSeconds)}
                      </span>
                    </div>
                    <p className="mt-1 text-sky-800">
                      Running {formatTargetSummary(lastLlmTargets)} on{" "}
                      {[
                        openActivePositions.length > 0
                          ? formatCountLabel(openActivePositions.length, "active position")
                          : null,
                        selectedQuestionCount > 0
                          ? formatCountLabel(selectedQuestionCount, "selected scan question")
                          : null,
                      ]
                        .filter((value): value is string => Boolean(value))
                        .join(" and ")}{" "}
                      now. When it finishes, we&apos;ll say how many rows were
                      updated, how many model outputs were usable, and whether any
                      consensus LLM odds stayed blank.
                    </p>
                  </div>
                ) : null}
                <div className="flex flex-wrap gap-2">
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => resetActiveFilters()}
                  >
                    Reset Filters
                  </Button>
                  <a
                    href={BULLPEN_SOURCE_URLS[activeMode]}
                    target="_blank"
                    rel="noreferrer"
                    className="inline-flex items-center gap-1 self-center whitespace-nowrap text-sm font-medium text-purple-700 hover:text-purple-900"
                  >
                    Open source <ExternalLink className="h-3.5 w-3.5" />
                  </a>
                </div>
              </div>
            </div>
          </div>

          {notice ? (
            <div className="flex gap-3 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
              <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
              <div className="space-y-1">
                <p>{notice}</p>
                <p className="text-xs text-amber-800">
                  If Bullpen blocks server-side access, rerun after network
                  access or session availability is restored.
                </p>
              </div>
            </div>
          ) : null}

          {llmNotice ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              {typeof llmNotice === "string" ? (
                llmNotice
              ) : (
                <div className="space-y-4">
                  <div className="overflow-hidden rounded-xl border border-sky-200 bg-white">
                    <table className="w-full border-collapse text-left text-sm">
                      <tbody className="divide-y divide-sky-100">
                        <tr>
                          <th className="w-64 bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Selected models
                          </th>
                          <td className="px-3 py-2">{llmNotice.selectedModels}</td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Unique questions analyzed
                          </th>
                          <td className="px-3 py-2">
                            {llmNotice.uniqueQuestionsAnalyzed}
                          </td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Models with usable JSON
                          </th>
                          <td className="px-3 py-2">{llmNotice.usableJsonModels}</td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Rows with consensus odds
                          </th>
                          <td className="px-3 py-2">
                            {llmNotice.rowsWithConsensusOdds}
                          </td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Linked rows updated
                          </th>
                          <td className="px-3 py-2">{llmNotice.matchedRows}</td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Active positions updated
                          </th>
                          <td className="px-3 py-2">
                            {llmNotice.activePositionsUpdated}
                          </td>
                        </tr>
                        <tr>
                          <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                            Selected scan questions updated
                          </th>
                          <td className="px-3 py-2">
                            {llmNotice.selectedScanQuestionsUpdated}
                          </td>
                        </tr>
                        {llmNotice.matchedRowsWithoutUsableOdds > 0 ? (
                          <tr>
                            <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                              Matched rows without usable odds
                            </th>
                            <td className="px-3 py-2">
                              {llmNotice.matchedRowsWithoutUsableOdds}
                            </td>
                          </tr>
                        ) : null}
                        {llmNotice.unmatchedReturnedRows > 0 ? (
                          <tr>
                            <th className="bg-sky-50 px-3 py-2 font-semibold text-sky-950">
                              Returned rows not matched
                            </th>
                            <td className="px-3 py-2">
                              {llmNotice.unmatchedReturnedRows}
                            </td>
                          </tr>
                        ) : null}
                      </tbody>
                    </table>
                  </div>

                  {llmNotice.failedModels.length > 0 ? (
                    <div className="overflow-hidden rounded-xl border border-sky-200 bg-white">
                      <table className="w-full border-collapse text-left text-sm">
                        <thead className="bg-sky-50 text-sky-950">
                          <tr>
                            <th className="w-64 px-3 py-2 font-semibold">Failed model</th>
                            <th className="px-3 py-2 font-semibold">Issue</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-sky-100">
                          {llmNotice.failedModels.map((failure) => (
                            <tr key={`${failure.model}:${failure.issue}`}>
                              <td className="px-3 py-2 font-medium text-sky-950">
                                {failure.model}
                              </td>
                              <td className="break-words px-3 py-2 text-sky-900">
                                {failure.issue}
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  ) : null}
                </div>
              )}
            </div>
          ) : null}

          {hasStaleResult ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Filters changed for this tab after the last saved scan. The table
              below is still showing the previous saved snapshot until you run
              Bullpen Scan again.
            </div>
          ) : null}

          {activeCurrentSnapshot ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <div className="flex flex-wrap items-center gap-2">
                <span className="text-xs font-semibold uppercase tracking-[0.16em] text-slate-500">
                  Saved Snapshots
                </span>
                <button
                  type="button"
                  onClick={() =>
                    setSelectedSnapshotIdByMode((current) => ({
                      ...current,
                      [activeMode]: null,
                    }))
                  }
                  className={`rounded-full px-3 py-1 text-xs font-semibold transition ${!isViewingHistory ? "bg-slate-950 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}
                >
                  Current · {formatDate(activeCurrentSnapshot.scannedAt)}
                </button>
                {activeSnapshots.history.map((snapshot, index) => (
                  <button
                    key={snapshot.snapshotId}
                    type="button"
                    onClick={() =>
                      setSelectedSnapshotIdByMode((current) => ({
                        ...current,
                        [activeMode]: snapshot.snapshotId,
                      }))
                    }
                    className={`rounded-full px-3 py-1 text-xs font-semibold transition ${activeSelectedSnapshotId === snapshot.snapshotId ? "bg-slate-950 text-white" : "bg-white text-slate-700 hover:bg-slate-100"}`}
                  >
                    Saved {index + 1} · {formatDate(snapshot.scannedAt)}
                  </button>
                ))}
              </div>
              <p className="mt-3 text-xs text-slate-600">
                {isViewingHistory
                  ? "Viewing a saved history version. Switch back to Current to select questions or run LLM analysis."
                  : "The current table is saved locally with its scan timestamp and will remain visible after refresh."}
              </p>
            </div>
          ) : null}

          {activeVisibleSnapshot ? (
            <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              <span>
                {isViewingHistory ? "Viewing saved version" : "Viewing current version"}
              </span>
              <span>{activeVisibleSnapshot.questions.length} matches</span>
              <span>{activeVisibleSnapshot.totalCandidates} markets scanned</span>
              <span>Source used: {activeVisibleSnapshot.sourceLabel}</span>
              <span>Scanned at: {formatDate(activeVisibleSnapshot.scannedAt)}</span>
              {activeVisibleSnapshot.archivedAt ? (
                <span>Archived at: {formatDate(activeVisibleSnapshot.archivedAt)}</span>
              ) : null}
            </div>
          ) : null}

          {activeVisibleSnapshot ? (
            <BullpenInvestmentsSection
              activePositions={activePositions}
              activePositionQuestions={activePositionQuestionsForLlm}
              activePositionsCount={hasLoadedPositions ? activePositions.length : null}
              candidates={activeInvestmentCandidates}
              claimError={claimPositionsError}
              claimStatusMessage={claimPositionsStatus}
              emptyMessage={investmentEmptyMessage}
              isClaimingPositions={isClaimingPositions}
              isHistoryView={isViewingHistory}
              isInvesting={isInvesting}
              isLoadingPositions={isLoadingPositions}
              isRefreshingCurrentOdds={isRefreshingCurrentOdds}
              lastSuccessfulLiveSnapshot={lastSuccessfulLiveSnapshot}
              onClaimNow={() => {
                void claimBullpenResolvedPositions();
              }}
              onInvest={investInSelectedEvents}
              onRefreshPositions={() => {
                void refreshBullpenPositions();
              }}
              onRefreshCurrentOdds={handleRefreshCurrentOdds}
              onToggleQuestion={toggleInvestmentSelection}
              onSelectAll={selectAllInvestmentCandidates}
              onClearAll={clearInvestmentCandidates}
              positionsError={positionsError}
              positionsFallback={positionsFallback}
              positionsHealth={positionsHealth}
              positionsLastUpdatedAt={positionsLastUpdatedAt}
              positionsSource={positionsSource}
              progressMessage={investmentProgress}
              resultMessage={investmentNotice}
              selectedQuestionIds={selectedInvestmentQuestionIdSet}
            />
          ) : null}

          {activeCurrentSnapshot ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              <span>
                {selectionEnabled
                  ? `${formatCountLabel(openActivePositions.length, "active position")} auto-included and ${formatCountLabel(selectedQuestionCount, "scan question")} selected for LLM analysis.`
                  : "History view is read-only; switch back to Current to select questions."}
              </span>
              {lastLlmTargets.length > 0 ? (
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Last LLMs: {formatTargetSummary(lastLlmTargets)}
                </span>
              ) : null}
            </div>
          ) : null}

          <BullpenQuestionsTable
            snapshot={activeVisibleSnapshot}
            emptyMessage={currentTableEmptyMessage}
            isLoading={isScanning}
            onSortChange={setActiveSort}
            selectedQuestionIds={selectedQuestionIdSet}
            selectionEnabled={selectionEnabled}
            sortState={sortByMode[activeMode]}
            onToggleQuestion={toggleQuestionSelection}
            onToggleSelectAll={toggleSelectAllQuestions}
          />
        </CardContent>
      </Card>

      {isPromptEditorOpen ? (
        <BullpenPromptEditorDialog
          value={bullpenLlmPromptTemplate}
          onClose={() => setIsPromptEditorOpen(false)}
          onSave={handlePromptTemplateSave}
        />
      ) : null}

      {openFilterDetailsId ? (
        <BullpenScanFilterDetailsDialog
          detailId={openFilterDetailsId}
          onClose={() => setOpenFilterDetailsId(null)}
        />
      ) : null}
    </div>
  );
}
