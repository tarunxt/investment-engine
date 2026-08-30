"use client";

import {
  Suspense,
  useEffect,
  useEffectEvent,
  useMemo,
  useRef,
  useState,
} from "react";
import dynamic from "next/dynamic";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  ChevronRight,
  Copy,
  Edit3,
  ExternalLink,
  FileText,
  Info,
  Loader2,
  Menu,
  Plus,
  RefreshCw,
  Trash2,
  UserRound,
  X,
} from "lucide-react";

import { EventScanRunControls } from "@/components/shared/EventScanRunControls";
import { isVerifiedFxRate } from "@/lib/fxPresentation";
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
  buildBullpenLlmRunTargetSet,
  buildBullpenQuestionRowFromActivePosition,
  extractBullpenActivePositionLlmAnalysis,
  hasSavedBullpenActivePositionAnalysis,
  pickPreferredBullpenActivePositionAnalysis,
  type BullpenActivePositionLlmAnalysis,
} from "@/lib/bullpenActivePositions";
import { formatApiErrorSummary, formatUnknownError } from "@/lib/apiErrors";
import { useUsdInrRate } from "@/hooks/useUsdInrRate";
import { formatApiTimestamp } from "@/lib/datetime";
import { getResolvedProviderInternetAccess } from "@/lib/llmInternetAccess";
import { buildBullpenInvestmentDisplay } from "@/lib/bullpenInvestments";
import {
  BullpenEventIdentityResolver,
  buildBullpenEventIdentityFromPosition,
  buildBullpenEventIdentityFromQuestion,
} from "@/lib/bullpenEventIdentityResolver";
import { cn } from "@/lib/utils";
import { URLs } from "@/lib/urls";
import { APIError, RequestTimeoutError, apiService } from "@/services/api";
import type {
  BullpenAutoLiveDecision,
  BullpenAutoLiveRun,
  BullpenAutoLiveRunOnceRequest,
  BullpenLlmExecutionMode,
  PolymarketEventRunContext,
  PolymarketManualInvestOrderRequest,
  PolymarketManualInvestResponse,
  ProviderInfo,
  ProviderModelTarget,
  RunResponse,
} from "@/types/api";

import { shouldReplaceCategory } from "@/lib/polymarketCategory";
import type {
  BullpenTableSortKey,
  BullpenTableSortState,
} from "./BullpenQuestionsTable";
import {
  syncBullpenAutoRunActivePositionAnalyses,
  syncBullpenAutoRunSummarySnapshots,
} from "./bullpenAutoRunSync";
import {
  buildClaimableBullpenSignature,
  buildBullpenCloseTimeFromDateOnly,
  calculateBullpenPositionReturnsPerDay,
  type BullpenActivePositionView,
  type BullpenLiveHealth,
  type BullpenLiveSnapshot,
  type BullpenPositionsDiagnostics,
  type BullpenPositionsFallback,
  type BullpenPositionsResponse,
  type BullpenPositionsSource,
  type BullpenPositionsSummary,
  canAutoRebaselineBullpenPositionsLineage,
  canUseBullpenDisplayCacheWithVerifiedLineage,
  getBullpenPositionsLineageMismatchFields,
  isUsableBullpenPositionsSnapshot,
  isActiveBullpenPosition,
  shouldPreserveBullpenPositionsOnRefresh,
} from "@/lib/bullpenPositions";

const BullpenQuestionsTable = dynamic(
  () =>
    import("./BullpenQuestionsTable").then((module) => module.BullpenQuestionsTable),
  {
    ssr: false,
    loading: () => <div className="h-48 animate-pulse rounded-2xl bg-slate-100" />,
  },
);
const BullpenInvestmentsSection = dynamic(
  () =>
    import("./BullpenInvestmentsSection").then(
      (module) => module.BullpenInvestmentsSection,
    ),
  {
    ssr: false,
    loading: () => <div className="h-36 animate-pulse rounded-2xl bg-slate-100" />,
  },
);
const BullpenScanFilterDetailsDialog = dynamic(
  () =>
    import("./BullpenScanFilterDetailsDialog").then(
      (module) => module.BullpenScanFilterDetailsDialog,
    ),
  { ssr: false },
);
const BullpenPromptEditorDialog = dynamic(
  () =>
    import("./BullpenPromptEditorDialog").then(
      (module) => module.BullpenPromptEditorDialog,
    ),
  { ssr: false },
);
const BullpenAutoRunScheduleCard = dynamic(
  () =>
    import("./BullpenAutoRunScheduleCard").then(
      (module) => module.BullpenAutoRunScheduleCard,
    ),
  {
    ssr: false,
    loading: () => <div className="h-48 animate-pulse rounded-2xl bg-slate-100" />,
  },
);

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
const RENDER_LEGACY_SCAN_CONTROLS =
  process.env.NEXT_PUBLIC_RENDER_LEGACY_BULLPEN_SCAN === "true";

type BullpenSnapshotSource = "manual" | "auto";

const SNAPSHOT_SOURCE_TABS: {
  source: BullpenSnapshotSource;
  label: string;
  description: string;
}[] = [
  {
    source: "auto",
    label: "Auto Scan",
    description: "",
  },
  {
    source: "manual",
    label: "Manual Scan",
    description: "Shows results from the Run Bullpen Scan button in this section.",
  },
];

const BULLPEN_SNAPSHOT_STORAGE_LEGACY_KEY =
  "investment-engine:bullpen-ai:snapshots:v1";
const BULLPEN_SNAPSHOT_STORAGE_KEY = "investment-engine:bullpen-ai:snapshots:v2";
const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investment-engine:bullpen-ai:last-llm-target:v1";
const BULLPEN_ACTIVE_POSITION_LLM_STORAGE_KEY =
  "investment-engine:bullpen-ai:active-position-llm:v1";
const BULLPEN_LLM_PROMPT_STORAGE_KEY =
  "investment-engine:bullpen-ai:llm-prompt-template:v1";
const BULLPEN_REQUIRE_FRESH_EVIDENCE_STORAGE_KEY =
  "investment-engine:bullpen-ai:require-fresh-evidence:v1";
const BULLPEN_CUSTOM_EXCLUSION_KEYWORDS_STORAGE_KEY =
  "investment-engine:bullpen-ai:custom-exclusion-keywords:v1";
const BULLPEN_ALLOW_NON_WEB_EVIDENCE_STORAGE_KEY =
  "investment-engine:bullpen-ai:allow-non-web-evidence:v1";
const DEFAULT_BULLPEN_LLM_EXECUTION_MODE: BullpenLlmExecutionMode =
  "chunked_parallel";
const DEFAULT_BULLPEN_LLM_EVENTS_PER_PROMPT = 20;
const DEFAULT_BULLPEN_LLM_MAX_CONCURRENT_REQUESTS = 6;
const MAX_BULLPEN_SNAPSHOT_HISTORY = 10;
const RUN_POLL_INTERVAL_MS = 4_000;
const MAX_RUN_POLLS = 90;
const AUTO_CLAIM_RETRY_COOLDOWN_MS = 60_000;
const DEFAULT_SORT_STATE: BullpenTableSortState = {
  key: "closeTime",
  direction: "asc",
};
const INVESTMENT_PROGRESS_POLL_MS = 1_500;
const EMPTY_SELECTED_IDS = new Set<string>();
const BULLPEN_UI_REQUEST_TIMEOUT_MS = 8_000;
const BULLPEN_SCAN_REQUEST_TIMEOUT_MS = 3_600_000;
const BULLPEN_SCAN_POLL_MS = 250;
const BULLPEN_SCAN_TRANSIENT_RETRY_MS = 1_000;

const AWS_EC2_TERMINAL_URL =
  "https://ap-south-1.console.aws.amazon.com/ec2-instance-connect/ssh/home?addressFamily=ipv4&connType=standard&instanceId=i-0b8ad0aebce8510cb&osUser=ubuntu&region=ap-south-1&sshPort=22";
const DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen login --no-browser";
const DEFAULT_SYSTEMD_BULLPEN_VERIFY_COMMAND =
  "sudo -u investor -H /usr/local/bin/bullpen polymarket positions --output json";
const DEFAULT_EC2_COMMANDS = [
  DEFAULT_SYSTEMD_BULLPEN_LOGIN_COMMAND,
  DEFAULT_SYSTEMD_BULLPEN_VERIFY_COMMAND,
  "sudo systemctl status investor-celery-worker --no-pager",
];
const EC2_COMMANDS_STORAGE_KEY = "bullpenAi.ec2Commands";
const BULLPEN_ACCOUNT_USERNAME = "intrepid_crane_3";
const BULLPEN_ACCOUNT_WALLET_FALLBACK =
  "0xa70b18abdebf0704b41901c33e8477ea1085afdf";
const CHANGE_BULLPEN_ACCOUNT_COMMANDS = [
  "sudo -u investor -H bullpen logout",
  "sudo -u investor -H bullpen login",
  "sudo -u investor -H bullpen polymarket positions --output json",
  "sudo systemctl restart investor-backend investor-celery-worker investor-celery-beat investor-frontend",
];

async function fetchBullpenUiJson<T>(
  input: string,
  init: RequestInit = {},
  timeoutMs = BULLPEN_UI_REQUEST_TIMEOUT_MS,
): Promise<{ response: Response; payload: T }> {
  const controller = new AbortController();
  let timedOut = false;
  const callerSignal = init.signal;
  const abortForCaller = () => controller.abort();
  if (callerSignal?.aborted) {
    abortForCaller();
  } else {
    callerSignal?.addEventListener("abort", abortForCaller, { once: true });
  }
  const timeoutId = window.setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  try {
    const response = await fetch(input, { ...init, signal: controller.signal });
    // Keep the deadline alive through body consumption. A response that sends
    // headers then stalls its JSON must fail just like a connection that never
    // opens, rather than leaving a page section in a loading state forever.
    const payload = (await response.json()) as T;
    return { response, payload };
  } catch (error) {
    if (timedOut) {
      throw new RequestTimeoutError(init.method ?? "GET", input, timeoutMs);
    }
    throw error;
  } finally {
    window.clearTimeout(timeoutId);
    callerSignal?.removeEventListener("abort", abortForCaller);
  }
}

function isBullpenRequestAbort(error: unknown) {
  return error instanceof DOMException && error.name === "AbortError";
}

function normalizeEc2Commands(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  return value
    .filter((command): command is string => typeof command === "string")
    .map((command) => command.trim())
    .filter(Boolean);
}

function getInitialEc2Commands() {
  if (typeof window === "undefined") return DEFAULT_EC2_COMMANDS;

  try {
    const savedCommands = window.localStorage.getItem(EC2_COMMANDS_STORAGE_KEY);
    if (!savedCommands) return DEFAULT_EC2_COMMANDS;

    const parsedCommands = JSON.parse(savedCommands);
    return normalizeEc2Commands(parsedCommands) ?? DEFAULT_EC2_COMMANDS;
  } catch (error) {
    console.warn("Unable to load saved EC2 commands", error);
    return DEFAULT_EC2_COMMANDS;
  }
}

type PolymarketMarketRefresh = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  category?: string | null;
  yesOdds: number | null;
  noOdds: number | null;
  bestBidPrice: number | null;
  bestAskPrice: number | null;
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

type BullpenPositionsRefreshMode = "passive" | "manual";

type RefreshBullpenPositionsOptions = {
  suppressAutoClaim?: boolean;
  refreshMode?: BullpenPositionsRefreshMode;
  callerSource?: string;
};

type QueuedManualBullpenPositionsRefresh = {
  options: RefreshBullpenPositionsOptions;
  waiters: Array<(result: RefreshBullpenPositionsResult) => void>;
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

function createEmptySnapshotSourceMap(): Record<ScanMode, BullpenSnapshotSource> {
  return {
    "30-days": "auto",
    "end-of-month": "auto",
  };
}

function buildSnapshotBackfilledActivePositionAnalyses(
  {
    activePositions,
    snapshotCollections,
  }: {
    activePositions: BullpenActivePositionView[];
    snapshotCollections: Record<ScanMode, BullpenSnapshotHistory>[];
  },
) {
  const snapshotCandidates: {
    analysis: BullpenActivePositionLlmAnalysis;
    question: BullpenQuestionRow;
    snapshotScannedAt: string | null;
  }[] = [];

  for (const snapshotsByMode of snapshotCollections) {
    for (const mode of ["30-days", "end-of-month"] as const) {
      const snapshots = [
        snapshotsByMode[mode].current,
        ...snapshotsByMode[mode].history,
      ].filter((snapshot): snapshot is BullpenScanSnapshot => Boolean(snapshot));

      for (const snapshot of snapshots) {
        for (const question of snapshot.questions) {
          const analysis = extractBullpenActivePositionLlmAnalysis(question);
          if (!hasSavedBullpenActivePositionAnalysis(analysis)) continue;
          snapshotCandidates.push({
            analysis,
            question,
            snapshotScannedAt: snapshot.scannedAt,
          });
        }
      }
    }
  }

  const analysesByPositionKey: Record<string, BullpenActivePositionLlmAnalysis> = {};
  for (const position of activePositions.filter(isActiveBullpenPosition)) {
    const questionMatch = BullpenEventIdentityResolver.resolveMatch({
      target: buildBullpenEventIdentityFromPosition(position),
      candidates: snapshotCandidates,
      getIdentity: (candidate) => buildBullpenEventIdentityFromQuestion(candidate.question),
      getSortTimestamp: (candidate) =>
        candidate.analysis.llmCompletedAt ?? candidate.snapshotScannedAt,
    });
    if (questionMatch.status !== "matched" || !questionMatch.match) continue;

    const analysis = {
      ...questionMatch.match.item.analysis,
      llmRecoveryStatus: "last-known-good/stale",
      llmRecoverySource: "latest-snapshot",
      llmRecoveryMatchMethod: questionMatch.match.primaryMethod,
      llmRecoveryRunId: questionMatch.match.item.analysis.llmRunId,
      llmRecoveryReason: `Recovered from the latest saved snapshot matched by ${BullpenEventIdentityResolver.describeMatchMethod(questionMatch.match.primaryMethod)}.`,
    } satisfies BullpenActivePositionLlmAnalysis;
    const preferred = pickPreferredBullpenActivePositionAnalysis(
      analysesByPositionKey[position.key],
      analysis,
    );
    if (preferred) {
      analysesByPositionKey[position.key] = preferred;
    }
  }

  return analysesByPositionKey;
}

function buildMergedActivePositionAnalyses({
  activePositions,
  currentAnalyses,
  manualSnapshotsByMode,
  autoSnapshotsByMode,
}: {
  activePositions: BullpenActivePositionView[];
  currentAnalyses: Record<string, BullpenActivePositionLlmAnalysis>;
  manualSnapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>;
  autoSnapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>;
}) {
  const next: Record<string, BullpenActivePositionLlmAnalysis> = {};
  const snapshotAnalysesByPositionKey = buildSnapshotBackfilledActivePositionAnalyses({
    activePositions,
    snapshotCollections: [manualSnapshotsByMode, autoSnapshotsByMode],
  });

  for (const position of activePositions.filter(isActiveBullpenPosition)) {
    const merged = pickPreferredBullpenActivePositionAnalysis(
      currentAnalyses[position.key],
      snapshotAnalysesByPositionKey[position.key],
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
  activePositions: BullpenActivePositionView[],
  analysesByPositionKey: Record<string, BullpenActivePositionLlmAnalysis>,
) {
  const positionMatch = BullpenEventIdentityResolver.resolveMatch({
    target: buildBullpenEventIdentityFromQuestion(question),
    candidates: activePositions,
    getIdentity: (position) => buildBullpenEventIdentityFromPosition(position),
    getSortTimestamp: (position) => position.closeTime,
  });
  if (positionMatch.status !== "matched" || !positionMatch.match) return question;

  const latestAnalysis = pickPreferredBullpenActivePositionAnalysis(
    extractBullpenActivePositionLlmAnalysis(question),
    analysesByPositionKey[positionMatch.match.item.key],
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

function getFilterCustomKeywordKey(detailId: BullpenScanFilterDetailId) {
  if (detailId === "excludeSports") return "customExcludeSportsKeywords";
  if (detailId === "excludeWeather") return "customExcludeWeatherKeywords";
  if (detailId === "excludeMarketPredictions") {
    return "customExcludeMarketPredictionsKeywords";
  }
  if (detailId === "excludeTweetCountQuestions") {
    return "customExcludeTweetCountQuestionsKeywords";
  }
  if (detailId === "excludeOthers") return "customExcludeOtherPhrases";
  return null;
}

function normalizeCustomExclusionKeywords(keywords: unknown) {
  if (!Array.isArray(keywords)) return [];
  const seen = new Set<string>();
  return keywords
    .map((keyword) => (typeof keyword === "string" ? keyword.trim().toLowerCase() : ""))
    .filter((keyword) => {
      if (!keyword || seen.has(keyword)) return false;
      seen.add(keyword);
      return true;
    });
}

function readStoredCustomExclusionKeywords() {
  if (typeof window === "undefined") return {};
  try {
    const raw = window.localStorage.getItem(
      BULLPEN_CUSTOM_EXCLUSION_KEYWORDS_STORAGE_KEY,
    );
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    return {
      customExcludeSportsKeywords: normalizeCustomExclusionKeywords(
        parsed.customExcludeSportsKeywords,
      ),
      customExcludeWeatherKeywords: normalizeCustomExclusionKeywords(
        parsed.customExcludeWeatherKeywords,
      ),
      customExcludeMarketPredictionsKeywords: normalizeCustomExclusionKeywords(
        parsed.customExcludeMarketPredictionsKeywords,
      ),
      customExcludeTweetCountQuestionsKeywords: normalizeCustomExclusionKeywords(
        parsed.customExcludeTweetCountQuestionsKeywords,
      ),
      customExcludeOtherPhrases: normalizeCustomExclusionKeywords(
        parsed.customExcludeOtherPhrases,
      ),
    };
  } catch {
    return {};
  }
}

function getCustomExclusionKeywordsForDetail(
  filters: BullpenScanFilters,
  detailId: BullpenScanFilterDetailId,
) {
  const filterKey = getFilterCustomKeywordKey(detailId);
  return filterKey ? filters[filterKey] : [];
}

function writeStoredCustomExclusionKeywords(filters: BullpenScanFilters) {
  window.localStorage.setItem(
    BULLPEN_CUSTOM_EXCLUSION_KEYWORDS_STORAGE_KEY,
    JSON.stringify({
      customExcludeSportsKeywords: filters.customExcludeSportsKeywords,
      customExcludeWeatherKeywords: filters.customExcludeWeatherKeywords,
      customExcludeMarketPredictionsKeywords:
        filters.customExcludeMarketPredictionsKeywords,
      customExcludeTweetCountQuestionsKeywords:
        filters.customExcludeTweetCountQuestionsKeywords,
      customExcludeOtherPhrases: filters.customExcludeOtherPhrases,
    }),
  );
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
    Boolean(left.excludeReleasedByEvents) ===
      Boolean(right.excludeReleasedByEvents) &&
    left.customExcludeSportsKeywords.join(",") ===
      right.customExcludeSportsKeywords.join(",") &&
    left.customExcludeWeatherKeywords.join(",") ===
      right.customExcludeWeatherKeywords.join(",") &&
    left.customExcludeMarketPredictionsKeywords.join(",") ===
      right.customExcludeMarketPredictionsKeywords.join(",") &&
    left.customExcludeTweetCountQuestionsKeywords.join(",") ===
      right.customExcludeTweetCountQuestionsKeywords.join(",") &&
    left.customExcludeOtherPhrases.join(",") ===
      right.customExcludeOtherPhrases.join(",") &&
    left.onlyBinaryYesNo === right.onlyBinaryYesNo &&
    left.minYesOdds === right.minYesOdds &&
    left.minNoOdds === right.minNoOdds
  );
}

function normalizeError(error: unknown) {
  if (error instanceof APIError) return formatApiErrorSummary(error);
  return formatUnknownError(error);
}

function markBullpenPerformance(name: string) {
  if (typeof performance === "undefined") return;
  if (performance.getEntriesByName(name, "mark").length > 0) return;
  performance.mark(name);
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

function pickLatestTimestamp(
  ...values: Array<string | null | undefined>
): string | null {
  return values.reduce<string | null>((latest, value) => {
    if (!value) return latest;
    const valueMs = parseTimestampMs(value);
    if (valueMs === 0) return latest;
    return valueMs > parseTimestampMs(latest) ? value : latest;
  }, null);
}

function getCompletedBullpenLlmRunTimestamp(
  run: Pick<RunResponse, "updated_at" | "created_at">,
) {
  return run.updated_at || run.created_at || new Date().toISOString();
}

function getBullpenAutoRunCompletedAt(run: BullpenAutoLiveRun | null | undefined) {
  if (!run || run.status !== "completed") return null;
  return run.completed_at || run.started_at || null;
}

function getLatestBullpenAutoRunCompletedAt(
  summary: {
    latest_run?: BullpenAutoLiveRun | null;
    recent_runs?: BullpenAutoLiveRun[];
  } | null,
) {
  if (!summary) return null;
  return pickLatestTimestamp(
    getBullpenAutoRunCompletedAt(summary.latest_run),
    ...(summary.recent_runs || []).map(getBullpenAutoRunCompletedAt),
  );
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
  if (!isVerifiedFxRate(usdInrRate)) return costs;

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

function parseBullpenNumericMetric(value: string | null) {
  if (!value) return null;
  const cleaned = value.replace(/[$,%]/g, "").replace(/,/g, "").trim();
  if (!cleaned) return null;
  const parsed = Number(cleaned);
  return Number.isFinite(parsed) ? parsed : null;
}

function buildBullpenManualInvestOrder(
  question: BullpenQuestionRow,
): PolymarketManualInvestOrderRequest | null {
  const outcome =
    question.llmYesOdds !== null &&
    question.llmYesOdds >= 80 &&
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
    analysis_context: {
      snapshot_mode: null,
      category: question.category,
      topic: question.category,
      event_slug: question.slug,
      event_description: question.rules ?? question.marketContext ?? null,
      yes_odds: question.yesOdds,
      no_odds: question.noOdds,
      volume_usd: parseBullpenNumericMetric(question.volume),
      liquidity_usd: parseBullpenNumericMetric(question.liquidity),
      best_bid_cents: null,
      best_ask_cents: null,
      spread_cents: null,
      rules: question.rules,
      market_context: question.marketContext,
      resolution_source: question.resolutionSource,
      llm_yes_odds: question.llmYesOdds,
      llm_no_odds: question.llmNoOdds,
      llm_disagreement_level: question.llmDisagreementLevel,
      llm_disagreement_category: question.llmDisagreementCategory,
      confidence:
        question.llmBreakdown.find((entry) => entry.confidence)?.confidence ?? null,
      evidence_status: question.evidenceStatus,
      event_state: question.eventState,
      llm_notes: question.llmNotes,
      llm_provider: question.llmProvider,
      llm_model: question.llmModel,
      llm_completed_at: question.llmCompletedAt,
      preflight_evidence_block: question.preflightEvidenceBlock ?? null,
      llm_outputs: buildBullpenAutoRunLlmOutputs(question.llmBreakdown),
    },
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
        volume_usd: parseBullpenNumericMetric(question.volume),
        liquidity_usd: parseBullpenNumericMetric(question.liquidity),
        best_bid_cents: null,
        best_ask_cents: null,
        spread_cents: null,
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
        market_context: question.marketContext,
        resolution_source: question.resolutionSource,
        event_description: question.rules ?? question.marketContext ?? null,
        preflight_evidence_block: question.preflightEvidenceBlock ?? null,
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
    const nextCategory: string = shouldReplaceCategory(
      question.category,
      marketUpdate.category,
    )
      ? marketUpdate.category ?? question.category
      : question.category;

    const oddsChanged = nextYesOdds !== question.yesOdds || nextNoOdds !== question.noOdds;

    if (
      nextSlug === question.slug &&
      nextMarketUrl === question.marketUrl &&
      nextCategory === question.category &&
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
      category: nextCategory,
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

function readSnapshotHistoryByModeFromStorageValue(value: unknown) {
  const next = createEmptySnapshotHistory();

  const parsed = value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;

  for (const mode of ["30-days", "end-of-month"] as const) {
    const entry = parsed?.[mode];
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
}

function readBullpenSnapshotsFromStorage() {
  if (typeof window === "undefined") {
    return {
      manual: createEmptySnapshotHistory(),
      auto: createEmptySnapshotHistory(),
    };
  }

  try {
    const raw = window.localStorage.getItem(BULLPEN_SNAPSHOT_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    if (parsed && typeof parsed === "object") {
      const record = parsed as Record<string, unknown>;
      if (record.manual || record.auto) {
        return {
          manual: readSnapshotHistoryByModeFromStorageValue(record.manual),
          auto: readSnapshotHistoryByModeFromStorageValue(record.auto),
        };
      }
    }
  } catch {
    // Fall back to the legacy manual-only snapshot cache.
  }

  try {
    const raw = window.localStorage.getItem(BULLPEN_SNAPSHOT_STORAGE_LEGACY_KEY);
    const parsed = raw ? JSON.parse(raw) : null;
    return {
      manual: readSnapshotHistoryByModeFromStorageValue(parsed),
      auto: createEmptySnapshotHistory(),
    };
  } catch {
    return {
      manual: createEmptySnapshotHistory(),
      auto: createEmptySnapshotHistory(),
    };
  }
}

function writeBullpenSnapshotsToStorage({
  manualSnapshotsByMode,
  autoSnapshotsByMode,
}: {
  manualSnapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>;
  autoSnapshotsByMode: Record<ScanMode, BullpenSnapshotHistory>;
}) {
  if (typeof window === "undefined") return;

  try {
    window.localStorage.setItem(
      BULLPEN_SNAPSHOT_STORAGE_KEY,
      JSON.stringify({
        manual: manualSnapshotsByMode,
        auto: autoSnapshotsByMode,
      }),
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

function normalizeServerBullpenLlmTargets(
  value: unknown,
): ProviderModelTarget[] {
  if (!Array.isArray(value)) return [];

  const normalizedTargets: ProviderModelTarget[] = [];
  const seenTargets = new Set<string>();
  value.forEach((item) => {
    const normalized = normalizeStoredTarget(item);
    if (!normalized) return;
    const provider = normalized.provider.trim();
    const model = normalized.model.trim();
    if (!provider || !model) return;
    const key = `${provider.toLowerCase()}::${model.toLowerCase()}`;
    if (seenTargets.has(key)) return;
    seenTargets.add(key);
    normalizedTargets.push({ provider, model });
  });
  return normalizedTargets;
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

function normalizeServerBullpenLlmPromptTemplate(value: string | null | undefined) {
  const normalized = value?.trim();
  return normalized ? normalized : null;
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
  return lastTargets;
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

function waitForBullpenPageVisibility(signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }
  if (typeof document === "undefined" || document.visibilityState === "visible") {
    return Promise.resolve();
  }

  return new Promise<void>((resolve, reject) => {
    const onVisibilityChange = () => {
      if (document.visibilityState !== "visible") return;
      cleanup();
      resolve();
    };
    const onAbort = () => {
      cleanup();
      reject(new DOMException("Request aborted", "AbortError"));
    };
    const cleanup = () => {
      document.removeEventListener("visibilitychange", onVisibilityChange);
      signal?.removeEventListener("abort", onAbort);
    };
    document.addEventListener("visibilitychange", onVisibilityChange);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

function waitForBullpenPollDelay(delayMs: number, signal?: AbortSignal) {
  if (signal?.aborted) {
    return Promise.reject(new DOMException("Request aborted", "AbortError"));
  }
  return new Promise<void>((resolve, reject) => {
    function cleanup() {
      signal?.removeEventListener("abort", onAbort);
    }
    function cleanupAndResolve() {
      cleanup();
      resolve();
    }
    function onAbort() {
      window.clearTimeout(timeoutId);
      cleanup();
      reject(new DOMException("Request aborted", "AbortError"));
    }
    const timeoutId = window.setTimeout(cleanupAndResolve, delayMs);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

async function waitForBullpenRunCompletion(
  runId: number,
  signal?: AbortSignal,
) {
  for (let attempt = 0; attempt < MAX_RUN_POLLS; attempt += 1) {
    await waitForBullpenPageVisibility(signal);
    const run = await apiService.getRun(runId, {
      signal,
      timeoutMs: 8_000,
    });
    const status = (run.status || "").toLowerCase();
    if (status === "completed" || status === "partial" || status === "failed") {
      return run;
    }
    await waitForBullpenPollDelay(RUN_POLL_INTERVAL_MS, signal);
  }

  return apiService.getRun(runId, { signal, timeoutMs: 8_000 });
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

function BullpenAiPageFallback() {
  return (
    <div className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6" aria-busy="true">
      <div className="space-y-3">
        <div className="h-4 w-36 animate-pulse rounded bg-purple-100" />
        <div className="h-9 w-64 animate-pulse rounded bg-slate-200" />
      </div>
      <section className="rounded-3xl border border-fuchsia-100 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap gap-2">
          <span className="h-7 w-36 animate-pulse rounded-full bg-fuchsia-100" />
          <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />
          <span className="h-7 w-28 animate-pulse rounded-full bg-slate-100" />
        </div>
        <div className="mt-5 grid gap-3 lg:grid-cols-3">
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
          <div className="h-24 animate-pulse rounded-2xl bg-slate-100" />
        </div>
      </section>
    </div>
  );
}

export default function BullpenAiPage() {
  return (
    <Suspense fallback={<BullpenAiPageFallback />}>
      <BullpenAiPageContent />
    </Suspense>
  );
}

function BullpenAiPageContent() {
  const searchParams = useSearchParams();
  const usdInrRate = useUsdInrRate();
  const activeMode: ScanMode =
    searchParams.get("tab") === "end-of-month" ? "end-of-month" : "30-days";
  const activeTab = TABS.find((tab) => tab.mode === activeMode) || TABS[0];
  const [filtersByMode, setFiltersByMode] = useState<
    Record<ScanMode, BullpenScanFilters>
  >(() => {
    const storedCustomKeywords = readStoredCustomExclusionKeywords();
    return {
      "30-days": {
        ...normalizeBullpenScanFilters("30-days", searchParams),
        ...storedCustomKeywords,
      },
      "end-of-month": {
        ...normalizeBullpenScanFilters("end-of-month", searchParams),
        ...storedCustomKeywords,
      },
    };
  });
  const [snapshotsByMode, setSnapshotsByMode] = useState<
    Record<ScanMode, BullpenSnapshotHistory>
  >(createEmptySnapshotHistory);
  const [autoSnapshotsByMode, setAutoSnapshotsByMode] = useState<
    Record<ScanMode, BullpenSnapshotHistory>
  >(createEmptySnapshotHistory);
  const [snapshotSourceByMode, setSnapshotSourceByMode] = useState<
    Record<ScanMode, BullpenSnapshotSource>
  >(createEmptySnapshotSourceMap);
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
  const [recentAutoRunDecisions, setRecentAutoRunDecisions] = useState<
    BullpenAutoLiveDecision[]
  >([]);
  const [historicalAutoRunRuns, setHistoricalAutoRunRuns] = useState<
    BullpenAutoLiveRun[]
  >([]);
  const [activePositions, setActivePositions] = useState<
    BullpenActivePositionView[]
  >([]);
  const [activePositionsSummary, setActivePositionsSummary] =
    useState<BullpenPositionsSummary | null>(null);
  const [activePositionAnalysesByKey, setActivePositionAnalysesByKey] =
    useState<Record<string, BullpenActivePositionLlmAnalysis>>({});
  const [hasLoadedPositions, setHasLoadedPositions] = useState(false);
  const [hasUsablePositionsSnapshot, setHasUsablePositionsSnapshot] =
    useState(false);
  const [isLoadingPositions, setIsLoadingPositions] = useState(false);
  const [positionsError, setPositionsError] = useState<string | null>(null);
  const [positionsFallback, setPositionsFallback] =
    useState<BullpenPositionsFallback | null>(null);
  const [positionsDiagnostics, setPositionsDiagnostics] =
    useState<BullpenPositionsDiagnostics | null>(null);
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
  const [autoRunLastCompletedAt, setAutoRunLastCompletedAt] = useState<
    string | null
  >(null);
  const [latestCompletedLlmRunId, setLatestCompletedLlmRunId] = useState<
    string | number | null
  >(null);
  const [currentInProgressLlmRunId, setCurrentInProgressLlmRunId] = useState<
    string | number | null
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
  const investingRef = useRef(false);
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
  const [bullpenLlmExecutionMode, setBullpenLlmExecutionMode] =
    useState<BullpenLlmExecutionMode>(DEFAULT_BULLPEN_LLM_EXECUTION_MODE);
  const [bullpenLlmEventsPerPrompt, setBullpenLlmEventsPerPrompt] = useState(
    DEFAULT_BULLPEN_LLM_EVENTS_PER_PROMPT,
  );
  const [requireFreshInternetEvidence, setRequireFreshInternetEvidence] =
    useState(true);
  const [
    allowEvidenceGroundedNonWebModels,
    setAllowEvidenceGroundedNonWebModels,
  ] = useState(false);
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [isPromptEditorLoading, setIsPromptEditorLoading] = useState(false);
  const [isScanFiltersOpen, setIsScanFiltersOpen] = useState(false);
  const [isScanSectionExpanded, setIsScanSectionExpanded] = useState(false);
  const [openFilterDetailsId, setOpenFilterDetailsId] =
    useState<BullpenScanFilterDetailId | null>(null);
  const [hasLoadedStorage, setHasLoadedStorage] = useState(false);
  const claimPositionsTaskRef = useRef<Promise<void> | null>(null);
  const positionsRequestInFlightRef = useRef(false);
  const queuedManualPositionsRefreshRef =
    useRef<QueuedManualBullpenPositionsRefresh | null>(null);
  const positionsAbortControllerRef = useRef<AbortController | null>(null);
  const pageRequestAbortControllerRef = useRef<AbortController | null>(null);
  const lastAutoClaimAttemptRef = useRef<BullpenAutoClaimAttempt | null>(null);
  const scanFiltersMenuRef = useRef<HTMLDivElement | null>(null);
  const canonicalizedSnapshotIdsRef = useRef<
    Record<BullpenSnapshotSource, Record<ScanMode, Set<string>>>
  >({
    manual: {
      "30-days": new Set<string>(),
      "end-of-month": new Set<string>(),
    },
    auto: {
      "30-days": new Set<string>(),
      "end-of-month": new Set<string>(),
    },
  });
  const activeSnapshotSource = snapshotSourceByMode[activeMode];

  useEffect(() => {
    const controller = new AbortController();
    pageRequestAbortControllerRef.current = controller;
    return () => {
      controller.abort();
      queuedManualPositionsRefreshRef.current = null;
      if (pageRequestAbortControllerRef.current === controller) {
        pageRequestAbortControllerRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const storedSnapshots = readBullpenSnapshotsFromStorage();
    setSnapshotsByMode(storedSnapshots.manual);
    setAutoSnapshotsByMode(storedSnapshots.auto);
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
    writeBullpenSnapshotsToStorage({
      manualSnapshotsByMode: snapshotsByMode,
      autoSnapshotsByMode,
    });
  }, [autoSnapshotsByMode, hasLoadedStorage, snapshotsByMode]);

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
        manualSnapshotsByMode: snapshotsByMode,
        autoSnapshotsByMode,
      });
      if (activePositionAnalysesEqual(current, next)) {
        return current;
      }
      return next;
    });
  }, [
    activePositions,
    autoSnapshotsByMode,
    hasLoadedPositions,
    hasLoadedStorage,
    snapshotsByMode,
  ]);

  useEffect(() => {
    setIsScanFiltersOpen(false);
    setOpenFilterDetailsId(null);
  }, [activeMode, activeSnapshotSource]);

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
    void refreshBullpenPositions({
      refreshMode: "passive",
      callerSource: "ui-interval-poll",
    });
  });

  useEffect(() => {
    const controller = new AbortController();
    positionsAbortControllerRef.current = controller;
    void refreshBullpenPositions({
      refreshMode: "passive",
      callerSource: "ui-mount",
    });
    return () => {
      controller.abort();
      if (positionsAbortControllerRef.current === controller) {
        positionsAbortControllerRef.current = null;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    // TODO(bullpen-event-exits): layer in a dedicated 15s / 5s active-odds poll for
    // Event Exit tracking without turning every tick into a full wallet sync or LLM run.
    const intervalId = window.setInterval(() => {
      pollBullpenPositions();
    }, 60_000);
    document.addEventListener("visibilitychange", pollBullpenPositions);

    return () => {
      window.clearInterval(intervalId);
      document.removeEventListener("visibilitychange", pollBullpenPositions);
    };
  }, []);

  useEffect(() => {
    if (!isScanSectionExpanded) return;
    let cancelled = false;
    const controller = new AbortController();

    const loadHistoricalCosts = async () => {
      try {
        const firstPage = await apiService.getFullRuns(
          { page: 1, limit: 100 },
          { signal: controller.signal, timeoutMs: 8_000 },
        );
        const maxPages = Math.min(firstPage.pages, 3);
        const remainingPages = Array.from(
          { length: Math.max(0, maxPages - 1) },
          (_, index) => index + 2,
        );
        const remainingResults = await Promise.all(
          remainingPages.map((page) =>
            apiService.getFullRuns(
              { page, limit: 100 },
              { signal: controller.signal, timeoutMs: 8_000 },
            ),
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
        if (!cancelled && !isBullpenRequestAbort(error)) {
          console.warn("Failed to load Bullpen LLM cost history:", error);
        }
      }
    };

    void loadHistoricalCosts();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [isScanSectionExpanded, usdInrRate]);

  const activeFilters = filtersByMode[activeMode];
  const activeSnapshots = snapshotsByMode[activeMode];
  const activeAutoSnapshots = autoSnapshotsByMode[activeMode];
  const isManualScanView = activeSnapshotSource === "manual";
  const activeCurrentSnapshot = activeSnapshots.current;
  const activeAutoCurrentSnapshot = activeAutoSnapshots.current;
  const visibleCurrentSnapshot = isManualScanView
    ? activeCurrentSnapshot
    : activeAutoCurrentSnapshot;
  const activeVisibleSnapshot = visibleCurrentSnapshot;
  const isViewingHistory = false;
  const hasStaleResult =
    isManualScanView &&
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
  const selectionEnabled = isManualScanView && Boolean(activeCurrentSnapshot);

  useEffect(() => {
    markBullpenPerformance("bullpen-shell-visible");
  }, []);

  useEffect(() => {
    if (hasLoadedPositions) {
      markBullpenPerformance("bullpen-portfolio-ready");
    }
  }, [hasLoadedPositions]);

  useEffect(() => {
    if (activeCurrentSnapshot || hasLoadedStorage) {
      markBullpenPerformance("bullpen-events-table-ready");
    }
  }, [activeCurrentSnapshot, hasLoadedStorage]);
  const selectedQuestionIds = selectionEnabled
    ? selectedQuestionIdsByMode[activeMode].filter((questionId) =>
        activeCurrentSnapshot?.questions.some((question) => question.id === questionId),
      )
    : [];
  const selectedQuestionIdSet = new Set(selectedQuestionIds);
  const selectedQuestionCount = selectedQuestionIds.length;
  const openActivePositions = activePositions.filter((position) =>
    isActiveBullpenPosition(position),
  );
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
  const activePositionQuestionsForLlm = useMemo(
    () =>
      openActivePositions.map((position) =>
        buildBullpenQuestionRowFromActivePosition(
          position,
          activePositionAnalysesByKey[position.key],
        ),
      ),
    [activePositionAnalysesByKey, openActivePositions],
  );
  const activeInvestmentCandidates = useMemo(() => {
    if (!selectionEnabled || !activeCurrentSnapshot) return [];

    return activeCurrentSnapshot.questions
      .map((question) =>
        mergeQuestionWithLatestActivePositionAnalysis(
          question,
          openActivePositions,
          activePositionAnalysesByKey,
        ),
      )
      .filter((question) => {
        return isBullpenQuestionInvestmentCandidate(question);
      });
  }, [
    activeCurrentSnapshot,
    activePositionAnalysesByKey,
    openActivePositions,
    selectionEnabled,
  ]);
  const activeInvestmentDisplay = useMemo(() => {
    if (!selectionEnabled || !activeCurrentSnapshot) return null;

    return buildBullpenInvestmentDisplay({
      activePositions: openActivePositions,
      activePositionQuestions: activePositionQuestionsForLlm,
      candidates: activeInvestmentCandidates,
      recentDecisions: recentAutoRunDecisions,
    });
  }, [
    activeCurrentSnapshot,
    activeInvestmentCandidates,
    activePositionQuestionsForLlm,
    openActivePositions,
    recentAutoRunDecisions,
    selectionEnabled,
  ]);
  const visibleInvestmentCandidates = activeVisibleSnapshot
    ? activeVisibleSnapshot.questions
        .map((question) =>
          mergeQuestionWithLatestActivePositionAnalysis(
            question,
            openActivePositions,
            activePositionAnalysesByKey,
          ),
        )
        .filter((question) => {
          return isBullpenQuestionInvestmentCandidate(question);
        })
    : [];
  const currentShortlistedInvestmentCandidates = useMemo(() => {
    if (!activeInvestmentDisplay) return [];

    return activeInvestmentDisplay.topInvestmentRows
      .filter(
        (
          row,
        ): row is Extract<
          (typeof activeInvestmentDisplay.topInvestmentRows)[number],
          { kind: "candidate" }
        > => row.kind === "candidate",
      )
      .map((row) => row.question);
  }, [activeInvestmentDisplay]);
  const visibleInvestmentDisplay = buildBullpenInvestmentDisplay({
    activePositions: openActivePositions,
    activePositionQuestions: activePositionQuestionsForLlm,
    candidates: visibleInvestmentCandidates,
    recentDecisions: recentAutoRunDecisions,
  });
  const visibleShortlistedInvestmentCandidates =
    visibleInvestmentDisplay.topInvestmentRows
      .filter(
        (
          row,
        ): row is Extract<
          (typeof visibleInvestmentDisplay.topInvestmentRows)[number],
          { kind: "candidate" }
        > => row.kind === "candidate",
      )
      .map((row) => row.question);
  const activeInvestmentCandidateIds = new Set(
    currentShortlistedInvestmentCandidates.map((question) => question.id),
  );
  const selectedInvestmentQuestionIds = selectionEnabled
    ? selectedInvestmentQuestionIdsByMode[activeMode].filter((questionId) =>
        activeInvestmentCandidateIds.has(questionId),
      )
    : [];
  const selectedInvestmentQuestionIdSet = new Set(selectedInvestmentQuestionIds);
  const eventExitPositionKeys = new Set(
    visibleInvestmentDisplay.activePositionsNeedingAttention.map(
      (entry) => entry.position.key,
    ),
  );
  const activeRetainedRows = activePositionQuestionsForLlm.filter(
    (question) => !eventExitPositionKeys.has(question.id),
  );
  const eventExitRows = visibleInvestmentDisplay.activePositionsNeedingAttention
    .map(
      (entry) =>
        entry.question ??
        activePositionQuestionsForLlm.find(
          (question) => question.id === entry.position.key,
        ) ??
        null,
    )
    .filter((question): question is BullpenQuestionRow => Boolean(question));
  const selectedNewOpportunityRows = visibleInvestmentCandidates.filter((question) =>
    selectedInvestmentQuestionIdSet.has(question.id),
  );
  const prioritizedTableRows = [
    ...activeRetainedRows,
    ...eventExitRows,
    ...selectedNewOpportunityRows,
  ];
  const prioritizedTableRowIds = new Set(
    prioritizedTableRows.map((question) => question.id),
  );
  const orderedVisibleTableRows = activeVisibleSnapshot
    ? [
        ...prioritizedTableRows,
        ...activeVisibleSnapshot.questions.filter(
          (question) => !prioritizedTableRowIds.has(question.id),
        ),
      ]
    : [];
  const tableRowHighlightById = Object.fromEntries([
    ...activeRetainedRows.map((question) =>
      [question.id, "active-retained"] as const,
    ),
    ...eventExitRows.map((question) => [question.id, "event-exit"] as const),
    ...selectedNewOpportunityRows.map((question) =>
      [question.id, "new-opportunity"] as const,
    ),
  ]);

  const visibleSelectedQuestionIdSet = selectionEnabled
    ? selectedQuestionIdSet
    : EMPTY_SELECTED_IDS;
  const visibleSelectedInvestmentQuestionIdSet =
    selectionEnabled && !isViewingHistory
      ? selectedInvestmentQuestionIdSet
      : EMPTY_SELECTED_IDS;
  const visibleHasAnyLlmOdds = Boolean(
    activePositionQuestionsForLlm.some(
      (question) => question.llmYesOdds !== null || question.llmNoOdds !== null,
    ) ||
      activeVisibleSnapshot?.questions.some(
        (question) => question.llmYesOdds !== null || question.llmNoOdds !== null,
      ),
  );
  const isReadOnlySnapshotView = !isManualScanView || isViewingHistory;
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

    const eligibleIds = currentShortlistedInvestmentCandidates
      .filter((question) => buildBullpenManualInvestOrder(question) !== null)
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
  }, [
    activeCurrentSnapshot,
    activeMode,
    currentShortlistedInvestmentCandidates,
    selectionEnabled,
  ]);

  useEffect(() => {
    if (!hasLoadedStorage || !activeVisibleSnapshot) return;
    const canonicalizedIds =
      canonicalizedSnapshotIdsRef.current[activeSnapshotSource][activeMode];
    if (
      canonicalizedIds.has(activeVisibleSnapshot.snapshotId)
    ) {
      return;
    }

    canonicalizedIds.add(activeVisibleSnapshot.snapshotId);
    const snapshotId = activeVisibleSnapshot.snapshotId;

    const questions = activeVisibleSnapshot.questions
      .filter((question) => question.id.trim())
      .map((question) => ({
        id: question.id,
        question: question.question,
        slug: question.slug,
        marketUrl: question.marketUrl,
        category: question.category,
      }));
    if (questions.length === 0) return;

    let cancelled = false;

    async function refreshMarketUrls() {
      try {
        const { response, payload } = await fetchBullpenUiJson<{
          marketUrls?: Record<string, string | null>;
          marketSlugs?: Record<string, string | null>;
          marketCategories?: Record<string, string | null>;
        }>("/api/bullpen-ai/market-urls", {
          method: "POST",
          headers: {
            "content-type": "application/json",
          },
          cache: "no-store",
          signal: pageRequestAbortControllerRef.current?.signal,
          body: JSON.stringify({ questions }),
        });
        if (!response.ok) return;

        if (
          cancelled ||
          (!payload.marketUrls &&
            !payload.marketSlugs &&
            !payload.marketCategories)
        ) {
          return;
        }

        const marketUpdates = Object.fromEntries(
          questions.map((question) => [
            question.id,
            {
              marketUrl: payload.marketUrls?.[question.id],
              slug: payload.marketSlugs?.[question.id],
              category: payload.marketCategories?.[question.id],
            },
          ]),
        );

        const updateSnapshotStore = (
          current: Record<ScanMode, BullpenSnapshotHistory>,
        ) => {
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
        };

        // Older localStorage snapshots may have stale "Uncategorized" values.
        // Reapplying market metadata lets canonical Polymarket categories heal them.
        if (activeSnapshotSource === "manual") {
          setSnapshotsByMode(updateSnapshotStore);
        } else {
          setAutoSnapshotsByMode(updateSnapshotStore);
        }
      } catch {
        // Best effort only. Existing saved snapshots will continue using stored URLs.
      }
    }

    void refreshMarketUrls();

    return () => {
      cancelled = true;
    };
  }, [activeMode, activeSnapshotSource, activeVisibleSnapshot, hasLoadedStorage]);

  function updateActiveFilters(patch: Partial<BullpenScanFilters>) {
    setFiltersByMode((current) => {
      const nextActiveFilters = {
        ...current[activeMode],
        ...patch,
      };
      return {
        ...current,
        [activeMode]: nextActiveFilters,
      };
    });
  }

  function saveCustomExclusionKeywords(
    detailId: BullpenScanFilterDetailId,
    keywords: string[],
  ) {
    const filterKey = getFilterCustomKeywordKey(detailId);
    if (!filterKey) return;
    setFiltersByMode((current) => {
      const nextActiveFilters = {
        ...current[activeMode],
        [filterKey]: keywords,
      };
      const nextFiltersByMode = {
        ...current,
        [activeMode]: nextActiveFilters,
      };
      try {
        writeStoredCustomExclusionKeywords(nextActiveFilters);
      } catch {
        // Keep the in-memory edits usable when localStorage is unavailable.
      }
      return nextFiltersByMode;
    });
  }

  function resetActiveFilters() {
    setFiltersByMode((current) => ({
      ...current,
      [activeMode]: {
        ...createBullpenScanFilters(activeMode),
        ...readStoredCustomExclusionKeywords(),
      },
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
      [activeMode]: currentShortlistedInvestmentCandidates.map(
        (question) => question.id,
      ),
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
          refreshMode: "passive",
          callerSource: "ui-claim-followup",
        });
        const remainingClaimablePositions = refreshedPositionsResult.positions.filter(
          (position) => position.isClaimable,
        );
        setClaimPositionsStatus(
          remainingClaimablePositions.length > 0
            ? automatic
              ? `Bullpen auto-claim submitted, but ${formatCountLabel(remainingClaimablePositions.length, "resolved position")} still ${remainingClaimablePositions.length === 1 ? "shows" : "show"} as claimable. Cred-X will retry automatically after the redeem cooldown and escalate to Bullpen's on-chain fallback if the payout stays stuck.`
              : `Bullpen submitted the claim, but ${formatCountLabel(remainingClaimablePositions.length, "resolved position")} still ${remainingClaimablePositions.length === 1 ? "shows" : "show"} as claimable in the latest wallet refresh. Cred-X will keep retrying after the redeem cooldown and can escalate to Bullpen's on-chain fallback if needed.`
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
    options?: RefreshBullpenPositionsOptions,
  ): Promise<RefreshBullpenPositionsResult> {
    if (positionsRequestInFlightRef.current) {
      // A user explicitly asking for a fresh wallet view must not be dropped
      // behind a passive mount/interval poll. Queue one forced refresh after
      // the in-flight request instead of creating a concurrent Bullpen read.
      if (options?.refreshMode === "manual") {
        return new Promise<RefreshBullpenPositionsResult>((resolve) => {
          const queuedRefresh = queuedManualPositionsRefreshRef.current;
          if (queuedRefresh) {
            queuedRefresh.options = options;
            queuedRefresh.waiters.push(resolve);
            return;
          }
          queuedManualPositionsRefreshRef.current = {
            options,
            waiters: [resolve],
          };
        });
      }
      return { positions: activePositions, error: null };
    }
    const requestSignal = positionsAbortControllerRef.current?.signal;
    if (requestSignal?.aborted) {
      return { positions: activePositions, error: null };
    }
    positionsRequestInFlightRef.current = true;
    setIsLoadingPositions(true);
    setPositionsError(null);

    try {
      const refreshMode = options?.refreshMode ?? "passive";
      const callerSource =
        options?.callerSource?.trim() ||
        (refreshMode === "manual" ? "ui-manual-refresh" : "ui-passive-refresh");
      const params = new URLSearchParams({
        caller_source: callerSource,
        max_age_seconds: "20",
      });
      if (refreshMode === "manual") {
        params.set("force_fresh", "true");
      } else {
        params.set("passive", "true");
      }

      const {
        response: livePositionsResponse,
        payload: livePositionsPayload,
      } = await fetchBullpenUiJson<BullpenPositionsResponse>(
        `/api/bullpen-ai/positions?${params.toString()}`,
        {
          cache: "no-store",
          signal: requestSignal,
        },
      );
      if (requestSignal?.aborted) {
        return { positions: activePositions, error: null };
      }
      const normalizedLiveSnapshot = normalizeLiveSnapshot(
        livePositionsPayload.lastSuccessfulLiveSnapshot,
      );
      const livePositions = (livePositionsPayload.positions || []).map(
        applyResolvedPositionCloseTime,
      );
      const incomingSnapshotUsable = isUsableBullpenPositionsSnapshot({
        positionsSource: livePositionsPayload.positionsSource,
        liveAvailable: livePositionsPayload.liveAvailable,
      });
      const previousLiveSnapshot = lastSuccessfulLiveSnapshot;
      const incomingLineage =
        livePositionsPayload.lineage ?? normalizedLiveSnapshot?.lineage ?? null;
      const incomingIsFreshUsableLive = Boolean(
        incomingSnapshotUsable &&
          livePositionsPayload.liveAvailable === true &&
          livePositionsPayload.positionsSource === "live-cli" &&
          !livePositionsPayload.error?.trim() &&
          livePositionsPayload.fallback?.active !== true &&
          normalizedLiveSnapshot?.source === "live-cli" &&
          incomingLineage?.source?.trim().toLowerCase() === "live-cli" &&
          incomingLineage.freshnessState?.trim().toLowerCase() === "fresh",
      );
      const lineageMismatchFields =
        getBullpenPositionsLineageMismatchFields({
          current: previousLiveSnapshot?.lineage,
          incoming: incomingLineage,
        });
      const accountIdentityChanged = lineageMismatchFields.includes(
        "account-identity",
      );
      const canEstablishFreshLineageBaseline = Boolean(
        incomingIsFreshUsableLive &&
          normalizedLiveSnapshot &&
          canAutoRebaselineBullpenPositionsLineage({
            current: previousLiveSnapshot?.lineage,
            incoming: incomingLineage,
            incomingIsFreshLive: incomingIsFreshUsableLive,
          }),
      );
      const canRenderDisplayCache =
        canUseBullpenDisplayCacheWithVerifiedLineage({
          current: previousLiveSnapshot?.lineage,
          incoming: incomingLineage,
          incomingSource: livePositionsPayload.positionsSource,
        });
      const preservingForLineageMismatch =
        lineageMismatchFields.length > 0 &&
        !canEstablishFreshLineageBaseline &&
        !canRenderDisplayCache &&
        Boolean(previousLiveSnapshot);
      const preserveForDegradedFallback =
        Boolean(previousLiveSnapshot && !incomingSnapshotUsable) ||
        shouldPreserveBullpenPositionsOnRefresh({
          incomingPositions: livePositions,
          incomingSource: livePositionsPayload.positionsSource,
          liveAvailable: livePositionsPayload.liveAvailable,
          currentPositions: activePositions,
          currentSource: positionsSource,
          lastSuccessfulLiveSnapshot: previousLiveSnapshot,
        });
      const preserveLastGoodPositions =
        preservingForLineageMismatch || preserveForDegradedFallback;
      const preservedLiveSnapshot =
        preserveLastGoodPositions
          ? previousLiveSnapshot
          : normalizedLiveSnapshot ?? previousLiveSnapshot;
      const preservingVerifiedSnapshot = Boolean(
        preserveLastGoodPositions &&
          (preservedLiveSnapshot ||
            positionsSource === "live-cli" ||
            positionsSource === "redis-cache" ||
            positionsSource === "last-successful-live-snapshot"),
      );
      const displayedPositions = preserveLastGoodPositions
        ? (preservedLiveSnapshot?.positions ?? activePositions)
        : livePositions;
      const displayedSummary = preserveLastGoodPositions
        ? (preservedLiveSnapshot?.summary ?? activePositionsSummary)
        : (livePositionsPayload.summary ?? null);
      const displayedDiagnostics = preserveLastGoodPositions
        ? (preservedLiveSnapshot?.diagnostics ?? positionsDiagnostics)
        : (livePositionsPayload.diagnostics ?? null);
      const displayedFallback = preserveLastGoodPositions
        ? {
            active: true,
            source: preservingVerifiedSnapshot
              ? ("last-successful-live-snapshot" as const)
              : ("tracked-positions" as const),
            message: preservingForLineageMismatch
              ? accountIdentityChanged
                ? "The wallet refresh belongs to a different account. Cred-X preserved the verified snapshot and will not re-baseline an account change automatically."
                : "The wallet refresh did not match the credential or classifier lineage of the verified snapshot already displayed. Cred-X preserved the verified snapshot; use Refresh to establish a fresh same-account baseline."
              : preservingVerifiedSnapshot
                ? "The tracked-position fallback is degraded, so Cred-X is preserving the most recent verified wallet snapshot in this tab."
              : "The tracked-position fallback returned no rows, so Cred-X is preserving the last read-only tracked rows in this tab.",
          }
        : (livePositionsPayload.fallback ?? null);

      setActivePositions(displayedPositions);
      setActivePositionsSummary(displayedSummary);
      setHasLoadedPositions(true);
      setHasUsablePositionsSnapshot(
        incomingSnapshotUsable || preservingVerifiedSnapshot,
      );
      setPositionsFallback(displayedFallback);
      setPositionsDiagnostics(displayedDiagnostics);
      setPositionsHealth(livePositionsPayload.health || null);
      setPositionsSource(
        preserveLastGoodPositions
          ? preservingVerifiedSnapshot
            ? "last-successful-live-snapshot"
            : (positionsSource ?? "tracked-positions")
          : (livePositionsPayload.positionsSource ?? null),
      );
      setLastSuccessfulLiveSnapshot(
        preserveLastGoodPositions
          ? previousLiveSnapshot
          : normalizedLiveSnapshot ?? previousLiveSnapshot,
      );
      if (!preserveLastGoodPositions) {
        setPositionsLastUpdatedAt(
          livePositionsPayload.fetchedAt ||
            normalizedLiveSnapshot?.fetchedAt ||
            new Date().toISOString(),
        );
      }
      setPositionsError(
        (preservingForLineageMismatch
          ? `Bullpen wallet snapshot lineage changed (${lineageMismatchFields.join(
              ", ",
            )}). The last verified wallet snapshot remains displayed${
              accountIdentityChanged
                ? "; account changes require an explicit session/account correction"
                : " until you deliberately refresh the same account"
            }.`
          : livePositionsPayload.error) ||
          (!livePositionsPayload.liveAvailable && displayedPositions.length === 0
            ? livePositionsPayload.health?.message ||
              "Live Bullpen wallet positions are unavailable right now."
            : null),
      );

      if (preservingForLineageMismatch) {
        lastAutoClaimAttemptRef.current = null;
        return {
          positions: displayedPositions,
          error:
            "Bullpen wallet snapshot lineage changed. The previous verified wallet snapshot remains displayed.",
        };
      }

      if (!livePositionsPayload.liveAvailable) {
        lastAutoClaimAttemptRef.current = null;
        return {
          positions: displayedPositions,
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
      if (requestSignal?.aborted || isBullpenRequestAbort(error)) {
        return { positions: activePositions, error: null };
      }
      const normalizedError = `Failed to load Bullpen wallet positions: ${normalizeError(error)}.`;
      setHasLoadedPositions(true);
      setPositionsError(normalizedError);
      return {
        positions: activePositions,
        error: normalizedError,
      };
    } finally {
      positionsRequestInFlightRef.current = false;
      const queuedManualRefresh = queuedManualPositionsRefreshRef.current;
      queuedManualPositionsRefreshRef.current = null;
      if (!requestSignal?.aborted) {
        setIsLoadingPositions(false);
        if (queuedManualRefresh) {
          window.queueMicrotask(() => {
            void refreshBullpenPositions(queuedManualRefresh.options).then(
              (result) => {
                queuedManualRefresh.waiters.forEach((resolve) =>
                  resolve(result),
                );
              },
            );
          });
        }
      } else if (queuedManualRefresh) {
        const abortedResult = { positions: activePositions, error: null };
        queuedManualRefresh.waiters.forEach((resolve) =>
          resolve(abortedResult),
        );
      }
    }
  }

  function syncBullpenScanSnapshot(
    snapshot: BullpenScanSnapshot,
    options?: { resetSelections?: boolean; archivePrevious?: boolean },
  ) {
    const resetSelections = options?.resetSelections ?? true;
    const archivePrevious = options?.archivePrevious ?? true;
    setSnapshotsByMode((current) => {
      const previousCurrent = current[activeMode].current;
      return {
        ...current,
        [activeMode]: {
          current: snapshot,
          history: previousCurrent && archivePrevious
            ? [
                archiveBullpenScanSnapshot(previousCurrent),
                ...current[activeMode].history,
              ].slice(0, MAX_BULLPEN_SNAPSHOT_HISTORY)
            : current[activeMode].history,
        },
      };
    });
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

  async function executeBullpenScan(options?: {
    resetSelections?: boolean;
    archivePrevious?: boolean;
    filtersOverride?: BullpenScanFilters;
  }) {
    const scanFilters = options?.filtersOverride ?? activeFilters;
    const params = buildBullpenScanQueryParams(activeMode, scanFilters);
    setScanningMode(activeMode);
    setMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    const positionsRefreshTask = refreshBullpenPositions({
      suppressAutoClaim: true,
      refreshMode: "passive",
      callerSource: "ui-scan-preflight",
    }).catch((error) => ({
      positions: activePositions,
      error: `Failed to refresh Bullpen wallet positions during scan: ${normalizeError(error)}.`,
    }));

    try {
      const scanRequestStartedAt = Date.now();
      const chunkedQuestions: ScanResult["questions"] = [];
      const chunkedRejectedQuestions: NonNullable<
        ScanResult["rejectedQuestions"]
      > = [];
      let receivedResultChunk = false;
      let chunkedTotalCandidates = 0;
      let scanCursor: string | null = null;
      let scanStartedAt: string | null = null;
      let scanResponse: { response: Response; payload: ScanResult };
      while (true) {
        const scanParams = new URLSearchParams(params);
        if (scanCursor) scanParams.set("scanCursor", scanCursor);
        if (scanStartedAt) scanParams.set("scanStartedAt", scanStartedAt);
        try {
          scanResponse = await fetchBullpenUiJson<ScanResult>(
            `/api/bullpen-ai?${scanParams.toString()}`,
            {
              cache: "no-store",
              signal: pageRequestAbortControllerRef.current?.signal,
            },
            BULLPEN_SCAN_REQUEST_TIMEOUT_MS,
          );
        } catch (scanPollError) {
          const requestSignal =
            pageRequestAbortControllerRef.current?.signal;
          if (requestSignal?.aborted || isBullpenRequestAbort(scanPollError)) {
            throw scanPollError;
          }
          const pollErrorMessage = normalizeError(scanPollError);
          const retryablePollFailure =
            /unexpected token|not valid json|http (?:429|502|503|504)|failed to fetch|network error/i.test(
              pollErrorMessage,
            );
          if (
            retryablePollFailure &&
            Date.now() - scanRequestStartedAt <
              BULLPEN_SCAN_REQUEST_TIMEOUT_MS
          ) {
            await waitForBullpenPollDelay(
              BULLPEN_SCAN_TRANSIENT_RETRY_MS,
              requestSignal,
            );
            continue;
          }
          throw scanPollError;
        }
        const pendingPayload = scanResponse.payload as ScanResult & {
          status?: string;
          retryAfterMs?: number;
          resultChunk?: boolean;
          nextCursor?: string | null;
          scanStartedAt?: string | null;
        };
        if (pendingPayload.resultChunk) {
          receivedResultChunk = true;
          chunkedTotalCandidates += pendingPayload.totalCandidates || 0;
          chunkedQuestions.push(...(pendingPayload.questions || []));
          chunkedRejectedQuestions.push(
            ...(pendingPayload.rejectedQuestions || []),
          );
        }
        scanCursor = pendingPayload.nextCursor ?? null;
        scanStartedAt = pendingPayload.scanStartedAt ?? scanStartedAt;
        if (
          scanResponse.response.status !== 202 ||
          pendingPayload.status !== "scanning"
        ) {
          break;
        }
        if (
          Date.now() - scanRequestStartedAt >=
          BULLPEN_SCAN_REQUEST_TIMEOUT_MS
        ) {
          throw new RequestTimeoutError(
            "GET",
            `/api/bullpen-ai?${params.toString()}`,
            BULLPEN_SCAN_REQUEST_TIMEOUT_MS,
          );
        }
        await new Promise((resolve) =>
          window.setTimeout(
            resolve,
            pendingPayload.retryAfterMs ?? BULLPEN_SCAN_POLL_MS,
          ),
        );
      }
      const { response } = scanResponse;
      const payload = receivedResultChunk
        ? {
            ...scanResponse.payload,
            totalCandidates: chunkedTotalCandidates,
            questions: chunkedQuestions,
            rejectedQuestions: chunkedRejectedQuestions,
          }
        : scanResponse.payload;
      const isSuccessfulScan = response.ok && !payload.error;

      void positionsRefreshTask;

      const nextSnapshot = isSuccessfulScan
        ? createBullpenScanSnapshot(payload)
        : null;
      if (nextSnapshot) {
        syncBullpenScanSnapshot(nextSnapshot, {
          resetSelections: options?.resetSelections,
          archivePrevious: options?.archivePrevious,
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
      void positionsRefreshTask;
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
          refreshMode: "passive",
          callerSource: "ui-llm-preflight",
        }),
      ]);
    const refreshedSelectedQuestions = selectedQuestions.map((question) => {
      const refreshedQuestion = refreshedQuestionsResult?.refreshedQuestions.find(
        (item) => item.id === question.id,
      );
      return refreshedQuestion || question;
    });
    const refreshedOpenActivePositions = refreshedPositionsResult.positions.filter(
      (position) => isActiveBullpenPosition(position),
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

    setLlmMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));

    try {
      const savedSettings = await apiService.updateBullpenAutoLiveSettings({
        console_llm_targets: targets,
      });
      const savedTargets = normalizeServerBullpenLlmTargets(
        savedSettings.console_llm_targets,
      );
      if (savedTargets.length === 0) {
        setLlmMessagesByMode((current) => ({
          ...current,
          [activeMode]:
            "Stage 2 could not start because the saved LLM target list is empty.",
        }));
        return;
      }

      setLlmRunningMode(activeMode);
      setLlmRunStartedAtByMode((current) => ({
        ...current,
        [activeMode]: Date.now(),
      }));
      setLastLlmTargets(savedTargets);
      writeLastLlmTargetsToStorage(savedTargets);

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
        execution_options: {
          execution_mode: bullpenLlmExecutionMode,
          events_per_prompt: bullpenLlmEventsPerPrompt,
          max_concurrent_requests: DEFAULT_BULLPEN_LLM_MAX_CONCURRENT_REQUESTS,
          target_count: savedTargets.length,
        },
      };
      const run = await apiService.createRun({
        prompt: buildBullpenLlmPrompt(
          questionsToAnalyze,
          bullpenLlmPromptTemplate,
          promptInputs,
        ),
        targets: savedTargets,
        allow_parallel: true,
        polymarket_event_context: polymarketEventContext,
      });
      setCurrentInProgressLlmRunId(run.id);
      const completedRun = await waitForBullpenRunCompletion(
        run.id,
        pageRequestAbortControllerRef.current?.signal,
      );
      setLatestCompletedLlmRunId(completedRun.id);
      const targetOrder = new Map(
        savedTargets.map((target, index) => [
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
        if (!isVerifiedFxRate(usdInrRate)) return next;
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
          const completedAt = getCompletedBullpenLlmRunTimestamp(completedRun);

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
          const completedAt = getCompletedBullpenLlmRunTimestamp(completedRun);

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
          const completedAt = getCompletedBullpenLlmRunTimestamp(completedRun);
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
              llmRecoveryStatus: "recovered",
              llmRecoverySource: "current-run",
              llmRecoveryMatchMethod: "position_key",
              llmRecoveryRunId: completedRun.id,
              llmRecoveryReason:
                "Recovered from the latest manual Bullpen LLM run matched by position key.",
            },
          );
          next[positionKey] =
            pickPreferredBullpenActivePositionAnalysis(
              next[positionKey],
              extractBullpenActivePositionLlmAnalysis(analyzedPosition),
            ) ?? extractBullpenActivePositionLlmAnalysis(analyzedPosition);
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
      setCurrentInProgressLlmRunId(null);
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
      const { response, payload } = await fetchBullpenUiJson<BullpenCurrentOddsRefreshResponse>("/api/bullpen-ai/current-odds", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        cache: "no-store",
        signal: pageRequestAbortControllerRef.current?.signal,
        body: JSON.stringify({
          questions: questionsToRefresh.map((question) => ({
            id: question.id,
            question: question.question,
            slug: question.slug,
            marketUrl: question.marketUrl,
            category: question.category,
          })),
        }),
      });
      if (!response.ok) {
        throw new Error(
          payload.error || "Failed to refresh current Polymarket odds.",
        );
      }

      const marketUpdates = payload.markets || {};
      const currentOddsUpdatedAt = new Date().toISOString();
      const currentSnapshotId = activeCurrentSnapshot.snapshotId;
      const nextSnapshot =
        applySnapshotMarketUpdates(
          activeCurrentSnapshot,
          currentSnapshotId,
          marketUpdates,
          currentOddsUpdatedAt,
        ) ?? activeCurrentSnapshot;
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
        refreshedQuestions: nextSnapshot.questions.filter((question) =>
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
    signal?: AbortSignal,
  ) {
    while (!isStopped()) {
      try {
        await waitForBullpenPageVisibility(signal);
        if (isStopped()) return;
        const state = await apiService.polymarketState({
          signal,
          timeoutMs: 8_000,
        });
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
      } catch (error) {
        if (isStopped() || isBullpenRequestAbort(error)) return;
      }

      try {
        await waitForBullpenPollDelay(INVESTMENT_PROGRESS_POLL_MS, signal);
      } catch (error) {
        if (isStopped() || isBullpenRequestAbort(error)) return;
      }
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
    // State updates are asynchronous, so a ref is the authoritative immediate
    // submission fence for this live trading mutation.
    if (investingRef.current) return;
    investingRef.current = true;

    const progressAbortController = new AbortController();
    const pageSignal = pageRequestAbortControllerRef.current?.signal;
    const abortProgressForPageExit = () => progressAbortController.abort();
    if (pageSignal?.aborted) {
      abortProgressForPageExit();
    } else {
      pageSignal?.addEventListener("abort", abortProgressForPageExit, {
        once: true,
      });
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
        progressAbortController.signal,
      );

      const response: PolymarketManualInvestResponse =
        await apiService.polymarketManualInvest({
          orders: selectedOrders,
        }, {
          signal: progressAbortController.signal,
          timeoutMs: 8_000,
        });
      void refreshBullpenPositions({
        refreshMode: "passive",
        callerSource: "ui-invest-followup",
      });
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
      progressAbortController.abort();
      pageSignal?.removeEventListener("abort", abortProgressForPageExit);
      if (progressPollingTask) {
        await progressPollingTask.catch(() => undefined);
      }
      investingRef.current = false;
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
          refreshMode: "passive",
          callerSource: "ui-current-odds-followup",
        }),
      ]);
      const summaryParts = [
        `Refreshed Current % for ${formatCountLabel(
          snapshotRefreshResult.refreshedCount,
          "visible question",
        )}.`,
        `Updated ${formatCountLabel(
          positionsRefreshResult.positions.filter((position) =>
            isActiveBullpenPosition(position),
          ).length,
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

  const currentTableEmptyMessage = isManualScanView && isScanning
    ? "Scanning Bullpen..."
    : activeVisibleSnapshot
      ? "No saved questions are available in this snapshot."
      : isManualScanView
        ? "No scan results yet. Click Run Bullpen Scan to load matching Bullpen questions."
        : "No auto scan results yet. Run Scans and Invest Now above to populate this tab.";
  const [isBullpenIntroDialogOpen, setIsBullpenIntroDialogOpen] = useState(false);
  const [ec2CommandMenuOpen, setEc2CommandMenuOpen] = useState(false);
  const [isBullpenAccountDialogOpen, setIsBullpenAccountDialogOpen] =
    useState(false);
  const [ec2Commands, setEc2Commands] = useState(getInitialEc2Commands);
  const [newEc2Command, setNewEc2Command] = useState("");
  const [editingEc2CommandIndex, setEditingEc2CommandIndex] = useState<
    number | null
  >(null);
  const [editingEc2Command, setEditingEc2Command] = useState("");

  useEffect(() => {
    try {
      window.localStorage.setItem(
        EC2_COMMANDS_STORAGE_KEY,
        JSON.stringify(ec2Commands),
      );
    } catch (error) {
      console.warn("Unable to save EC2 commands", error);
    }
  }, [ec2Commands]);

  function handleDeleteEc2Command(index: number) {
    setEc2Commands((commands) => commands.filter((_, itemIndex) => itemIndex !== index));
    if (editingEc2CommandIndex === index) {
      setEditingEc2CommandIndex(null);
      setEditingEc2Command("");
    }
  }

  const investmentEmptyMessage = !activeVisibleSnapshot
    ? isManualScanView
      ? "Run Bullpen Scan first to load the current questions table."
      : "Run Scans and Invest Now above to generate Auto Scan results."
    : !visibleHasAnyLlmOdds
      ? isManualScanView
        ? "Run LLM analysis first. Pink invest rows appear after LLM Yes or No Odds reaches 80% or higher."
        : "This Auto Scan snapshot does not have qualifying LLM odds yet."
      : "No rows are currently pink. Rows appear here when LLM Yes or No Odds is 80% or higher.";

  async function handlePromptTemplateSave(template: string) {
    try {
      await apiService.updateBullpenAutoLiveSettings({
        console_llm_prompt_template: template,
      });
    } catch (saveError) {
      const normalizedError = normalizeError(saveError);
      throw new Error(normalizedError);
    }
    setBullpenLlmPromptTemplate(template);
    writeBullpenLlmPromptToStorage(template);
  }

  async function openPromptEditor() {
    if (isPromptEditorLoading) return;
    setIsPromptEditorLoading(true);
    try {
      const settings = await apiService.getBullpenAutoLiveSettings({
        signal: pageRequestAbortControllerRef.current?.signal,
        timeoutMs: 4_000,
      });
      const savedTemplate = normalizeServerBullpenLlmPromptTemplate(
        settings.console_llm_prompt_template,
      );
      if (savedTemplate) {
        setBullpenLlmPromptTemplate(savedTemplate);
        writeBullpenLlmPromptToStorage(savedTemplate);
      }
    } catch (loadError) {
      if (!isBullpenRequestAbort(loadError)) {
        setLlmMessagesByMode((current) => ({
          ...current,
          [activeMode]: `Saved prompt could not be refreshed. ${normalizeError(loadError)}`,
        }));
      }
    } finally {
      setIsPromptEditorLoading(false);
      if (!pageRequestAbortControllerRef.current?.signal.aborted) {
        setIsPromptEditorOpen(true);
      }
    }
  }

  return (
    <div
      className="mx-auto flex w-full max-w-7xl flex-col gap-6 p-6"
      data-performance-usable="bullpen-runtime"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <p className="text-sm font-semibold uppercase tracking-[0.22em] text-purple-600">
            Copy Trading Bots
          </p>
          <div className="mt-2 flex flex-wrap items-center gap-2">
            <h1 className="text-3xl font-bold tracking-tight text-slate-950">
              Bullpen x AI
            </h1>
            <button
              type="button"
              onClick={() => setIsBullpenIntroDialogOpen(true)}
              className="inline-flex h-8 w-8 items-center justify-center rounded-full border border-purple-200 bg-white text-purple-700 shadow-sm transition hover:border-purple-300 hover:bg-purple-50 hover:text-purple-900 focus:outline-none focus:ring-2 focus:ring-purple-400 focus:ring-offset-2"
              aria-label="Show Bullpen x AI overview"
            >
              <Info className="h-4 w-4" />
            </button>
          </div>
          <div className="mt-4 flex flex-wrap items-stretch gap-3">
            <div className="flex min-w-0 flex-wrap items-center gap-x-5 gap-y-2 rounded-2xl border border-purple-100 bg-purple-50/60 px-4 py-3 text-sm">
              <div className="flex items-center gap-2">
                <UserRound className="size-4 text-purple-700" aria-hidden="true" />
                <span className="text-slate-500">Username</span>
                <strong className="font-mono text-slate-950">
                  {BULLPEN_ACCOUNT_USERNAME}
                </strong>
              </div>
              <div className="min-w-0">
                <span className="mr-2 text-slate-500">Wallet address</span>
                <strong
                  className="break-all font-mono text-xs text-slate-950"
                  title={
                    lastSuccessfulLiveSnapshot?.lineage?.accountIdentity ??
                    BULLPEN_ACCOUNT_WALLET_FALLBACK
                  }
                >
                  {lastSuccessfulLiveSnapshot?.lineage?.accountIdentity ??
                    BULLPEN_ACCOUNT_WALLET_FALLBACK}
                </strong>
              </div>
            </div>
            <Button
              type="button"
              variant="outline"
              className="border-purple-300 bg-white text-purple-800 hover:bg-purple-50"
              onClick={() => setIsBullpenAccountDialogOpen(true)}
            >
              Change Bullpen Account
            </Button>
          </div>
        </div>
        <div className="mt-1 flex flex-wrap items-center gap-2">
          <div className="relative inline-flex rounded-full border border-amber-300 bg-amber-50 text-amber-900 shadow-sm transition hover:border-amber-400 hover:bg-amber-100">
            <a
              href={AWS_EC2_TERMINAL_URL}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center rounded-l-full px-5 py-2 text-sm font-semibold"
            >
              Open AWS EC2
              <ExternalLink className="ml-2 size-3.5" aria-hidden="true" />
            </a>
            <button
              type="button"
              className="inline-flex items-center rounded-r-full border-l border-amber-300 px-3 py-2 transition hover:bg-amber-200/60"
              aria-label="Show AWS EC2 commands"
              aria-expanded={ec2CommandMenuOpen}
              onClick={() => setEc2CommandMenuOpen((open) => !open)}
            >
              <Menu className="size-4" aria-hidden="true" />
            </button>
            {ec2CommandMenuOpen ? (
              <div className="absolute right-0 top-full z-30 mt-2 w-80 rounded-2xl border border-slate-200 bg-white p-4 text-left text-slate-950 shadow-xl">
                <div className="mb-3">
                  <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                    EC2 commands
                  </p>
                  <p className="mt-1 text-xs text-slate-500">
                    Most-used commands to run after opening the EC2 shell.
                  </p>
                </div>
                <div className="space-y-2">
                  {ec2Commands.map((command, index) => {
                    const isEditing = editingEc2CommandIndex === index;

                    return (
                      <div
                        key={`${command}-${index}`}
                        className="rounded-xl border border-slate-200 bg-slate-50 p-2"
                      >
                        {isEditing ? (
                          <form
                            className="flex gap-2"
                            onSubmit={(event) => {
                              event.preventDefault();
                              const updatedCommand = editingEc2Command.trim();
                              if (!updatedCommand) return;
                              setEc2Commands((commands) =>
                                commands.map((item, itemIndex) =>
                                  itemIndex === index ? updatedCommand : item,
                                ),
                              );
                              setEditingEc2CommandIndex(null);
                              setEditingEc2Command("");
                            }}
                          >
                            <input
                              type="text"
                              value={editingEc2Command}
                              onChange={(event) =>
                                setEditingEc2Command(event.target.value)
                              }
                              aria-label="Edit EC2 command"
                              className="min-w-0 flex-1 rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs font-semibold text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                            />
                            <button
                              type="submit"
                              className="rounded-lg bg-slate-950 px-2.5 py-1.5 text-xs font-semibold text-white hover:bg-slate-800"
                            >
                              Save
                            </button>
                          </form>
                        ) : (
                          <div className="flex items-center gap-2">
                            <code className="min-w-0 flex-1 break-words text-xs font-semibold text-slate-800">
                              {command}
                            </code>
                            <div className="flex shrink-0 items-center gap-1">
                              <button
                                type="button"
                                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white hover:text-slate-950"
                                aria-label={`Copy command: ${command}`}
                                title="Copy command"
                                onClick={() =>
                                  void navigator.clipboard.writeText(command)
                                }
                              >
                                <Copy className="size-3.5" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-white hover:text-slate-950"
                                aria-label={`Edit command: ${command}`}
                                title="Edit command"
                                onClick={() => {
                                  setEditingEc2CommandIndex(index);
                                  setEditingEc2Command(command);
                                }}
                              >
                                <Edit3 className="size-3.5" aria-hidden="true" />
                              </button>
                              <button
                                type="button"
                                className="rounded-lg p-1.5 text-slate-500 transition hover:bg-rose-50 hover:text-rose-600"
                                aria-label={`Delete command: ${command}`}
                                title="Delete command"
                                onClick={() => handleDeleteEc2Command(index)}
                              >
                                <Trash2 className="size-3.5" aria-hidden="true" />
                              </button>
                            </div>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
                <form
                  className="mt-3 flex gap-2"
                  onSubmit={(event) => {
                    event.preventDefault();
                    const command = newEc2Command.trim();
                    if (!command) return;
                    setEc2Commands((commands) => [...commands, command]);
                    setNewEc2Command("");
                  }}
                >
                  <input
                    type="text"
                    value={newEc2Command}
                    onChange={(event) => setNewEc2Command(event.target.value)}
                    placeholder="Add another command"
                    className="min-w-0 flex-1 rounded-full border border-slate-200 px-3 py-2 text-xs text-slate-900 outline-none focus:border-amber-400 focus:ring-2 focus:ring-amber-100"
                  />
                  <button
                    type="submit"
                    className="inline-flex items-center gap-1 rounded-full bg-slate-950 px-3 py-2 text-xs font-semibold text-white hover:bg-slate-800"
                  >
                    <Plus className="size-3.5" aria-hidden="true" />
                    Add
                  </button>
                </form>
              </div>
            ) : null}
          </div>
          <Button asChild>
            <Link
              href={URLs.routes.console.bullpenAiAnalyseEvents()}
              prefetch={false}
            >
              Trade Analysis
            </Link>
          </Button>
        </div>
      </div>

      {isBullpenIntroDialogOpen ? (
        <div
          className="fixed inset-0 z-[130] flex items-center justify-center bg-slate-950/55 p-4"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) setIsBullpenIntroDialogOpen(false);
          }}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="bullpen-ai-overview-title"
            className="w-full max-w-xl overflow-hidden rounded-3xl border border-slate-200 bg-white shadow-[0_32px_90px_-32px_rgba(15,23,42,0.45)]"
          >
            <div className="flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.22em] text-purple-600">
                  Bullpen x AI
                </p>
                <h2 id="bullpen-ai-overview-title" className="mt-2 text-xl font-semibold text-slate-950">
                  Scan workspace overview
                </h2>
              </div>
              <button
                type="button"
                onClick={() => setIsBullpenIntroDialogOpen(false)}
                className="inline-flex h-10 w-10 items-center justify-center rounded-full border border-slate-200 text-slate-500 transition hover:bg-slate-100 hover:text-slate-900"
                aria-label="Close Bullpen x AI overview"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="px-6 py-5 text-sm leading-6 text-slate-700">
              <p>
                Run Bullpen scans inside the selected time window, tune the scan
                filters from the menu, then inspect the matching markets in a saved
                table that persists across refresh.
              </p>
            </div>
          </div>
        </div>
      ) : null}

      <BullpenAutoRunScheduleCard
        independentScanSnapshot={activeCurrentSnapshot}
        onRunIndependentStageOne={async () => {
          let independentFilters = activeFilters;
          try {
            const settings = await apiService.getBullpenAutoLiveSettings();
            independentFilters = {
              ...activeFilters,
              minYesOdds: settings.console_min_market_odds,
              minNoOdds: settings.console_min_market_odds,
              customExcludeOtherPhrases:
                settings.console_custom_exclude_phrases ?? [],
            };
          } catch {
            // The scan route still has safe filter defaults when the settings
            // request is temporarily unavailable.
          }
          const result = await executeBullpenScan({
            resetSelections: true,
            archivePrevious: false,
            filtersOverride: independentFilters,
          });
          return result;
        }}
        buildRunNowRequest={buildRunNowRequest}
        activePositions={openActivePositions}
        activePositionsSummary={activePositionsSummary}
        positionsSource={positionsSource}
        positionsUpdatedAt={positionsLastUpdatedAt}
        positionsLineage={lastSuccessfulLiveSnapshot?.lineage ?? null}
        activePositionQuestions={activePositionQuestionsForLlm}
        hasActivePositionsSnapshot={hasUsablePositionsSnapshot}
        recentDecisions={recentAutoRunDecisions}
        onSummaryUpdated={({ summary, run }) => {
          const serverTargets = normalizeServerBullpenLlmTargets(
            summary.settings.console_llm_targets,
          );
          setLastLlmTargets(serverTargets);
          writeLastLlmTargetsToStorage(serverTargets);
          const serverPromptTemplate = normalizeServerBullpenLlmPromptTemplate(
            summary.settings.console_llm_prompt_template,
          );
          if (serverPromptTemplate) {
            setBullpenLlmPromptTemplate(serverPromptTemplate);
            writeBullpenLlmPromptToStorage(serverPromptTemplate);
          }
          setBullpenLlmExecutionMode(
            summary.settings.llm_execution_mode ??
              DEFAULT_BULLPEN_LLM_EXECUTION_MODE,
          );
          setBullpenLlmEventsPerPrompt(
            summary.settings.llm_events_per_prompt ??
              DEFAULT_BULLPEN_LLM_EVENTS_PER_PROMPT,
          );
          setHistoricalAutoRunRuns(summary.recent_runs ?? []);
          setRecentAutoRunDecisions(summary.recent_decisions ?? []);
          setAutoRunLastCompletedAt(getLatestBullpenAutoRunCompletedAt(summary));
          setAutoSnapshotsByMode((current) =>
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
              activePositions: openActivePositions,
              snapshotAnalysesByKey: buildSnapshotBackfilledActivePositionAnalyses({
                activePositions: openActivePositions,
                snapshotCollections: [snapshotsByMode, autoSnapshotsByMode],
              }),
            }),
          );
        }}
        onOpenScanFilters={() => {
          setIsScanSectionExpanded(true);
          setIsScanFiltersOpen(true);
        }}
        onRefreshPortfolioPositions={async () => {
          await refreshBullpenPositions({
            suppressAutoClaim: true,
            refreshMode: "manual",
            callerSource: "ui-portfolio-refresh",
          });
        }}
        onRunCompleted={() => {
          void refreshBullpenPositions({
            suppressAutoClaim: true,
            refreshMode: "passive",
            callerSource: "ui-run-completed",
          });
        }}
      />

      {RENDER_LEGACY_SCAN_CONTROLS ? (
      <Card>
        <CardHeader className="gap-2">
          <div className="flex items-start justify-between gap-3">
            <div className="space-y-2">
              <CardTitle>{activeTab.label} Bullpen Scan</CardTitle>
              <CardDescription>
                {getModeDescription(activeMode, activeFilters)}
              </CardDescription>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onClick={() => setIsScanSectionExpanded((current) => !current)}
              aria-label={
                isScanSectionExpanded
                  ? `Collapse ${activeTab.label} Bullpen Scan`
                  : `Expand ${activeTab.label} Bullpen Scan`
              }
              aria-expanded={isScanSectionExpanded}
              className="shrink-0"
            >
              {isScanSectionExpanded ? (
                <ChevronDown className="h-5 w-5" />
              ) : (
                <ChevronRight className="h-5 w-5" />
              )}
            </Button>
          </div>
        </CardHeader>
        {isScanSectionExpanded ? (
        <CardContent className="space-y-5">
          <div className="rounded-2xl border border-slate-200 bg-white p-4">
            <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
              <div className="max-w-2xl">
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-slate-500">
                  Source
                </p>
                <p className="mt-2 text-sm text-slate-700">
                  {isManualScanView
                    ? "Scan Bullpen's trending source for this tab, then fall back to alternate market feeds only if Bullpen access fails."
                    : "Auto Scan snapshots are populated by the Run Scans and Invest Now flow above and kept separate from the manual scan table."}
                </p>
              </div>
              <div className="w-full max-w-[26rem] space-y-2">
                <div ref={scanFiltersMenuRef} className="relative">
                  <div className="flex items-center">
                    <Button
                      onClick={() => {
                        setIsScanFiltersOpen(false);
                        void runScan();
                      }}
                      disabled={!isManualScanView || isScanning}
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
                      disabled={!isManualScanView}
                      title="Open scan filters"
                      aria-label="Open scan filters"
                      aria-expanded={isScanFiltersOpen}
                      aria-haspopup="dialog"
                    >
                      <Menu className="h-4 w-4" />
                    </Button>
                  </div>
                  {isScanFiltersOpen ? (
                    <div className="fixed left-1/2 top-1/2 z-50 max-h-[min(42rem,calc(100vh-3rem))] w-[min(34rem,calc(100vw-3rem))] -translate-x-1/2 -translate-y-1/2 overflow-y-auto rounded-2xl border border-slate-200 bg-white p-4 shadow-2xl">
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
                            checked={activeFilters.excludeReleasedByEvents}
                            onChange={(checked) =>
                              updateActiveFilters({
                                excludeReleasedByEvents: checked,
                              })
                            }
                            onOpenDetails={() =>
                              setOpenFilterDetailsId("excludeReleasedByEvents")
                            }
                            label={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeReleasedByEvents.label
                            }
                            description={
                              BULLPEN_SCAN_FILTER_DETAILS
                                .excludeReleasedByEvents.description
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
                    onClick={() => void openPromptEditor()}
                    disabled={!isManualScanView || isPromptEditorLoading}
                    title="Open Bullpen LLM prompt"
                    aria-label="Open Bullpen LLM prompt"
                  >
                    <FileText className="h-4 w-4" />
                  </Button>
                  <EventScanRunControls
                    buttonLabel="Run LLM"
                    containerClassName="gap-0"
                    defaultTargets={getDefaultBullpenLlmTargets(lastLlmTargets)}
                    disableImplicitDefaultTarget
                    disabled={
                      !isManualScanView ||
                      !activeCurrentSnapshot ||
                      isViewingHistory ||
                      (selectedQuestionCount === 0 && openActivePositions.length === 0)
                    }
                    ignoreStoredSelection
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
                {isManualScanView && isRunningLlm ? (
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
                    disabled={!isManualScanView}
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

          {isManualScanView && notice ? (
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

          {isManualScanView && llmNotice ? (
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

          {isManualScanView && hasStaleResult ? (
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-4 py-3 text-sm text-sky-900">
              Filters changed for this tab after the last saved scan. The table
              below is still showing the previous saved snapshot until you run
              Bullpen Scan again.
            </div>
          ) : null}

          {activeVisibleSnapshot ? (
            <div className="flex flex-wrap gap-x-6 gap-y-2 rounded-2xl border border-slate-200 bg-slate-50 px-4 py-3 text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
              <span>Current snapshot</span>
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
              activePositionsCount={
                hasLoadedPositions
                  ? activePositions.filter((position) =>
                      isActiveBullpenPosition(position),
                    ).length
                  : null
              }
              candidates={
                selectionEnabled
                  ? currentShortlistedInvestmentCandidates
                  : visibleShortlistedInvestmentCandidates
              }
              claimError={claimPositionsError}
              claimStatusMessage={claimPositionsStatus}
              emptyMessage={investmentEmptyMessage}
              isClaimingPositions={isClaimingPositions}
              isReadOnly={isReadOnlySnapshotView}
              readOnlyMessage={
                isViewingHistory
                  ? "Switch back to the current snapshot to select events and place Bullpen orders."
                  : null
              }
              isInvesting={isInvesting}
              isLoadingPositions={isLoadingPositions}
              isRefreshingCurrentOdds={isRefreshingCurrentOdds}
              lastSuccessfulLiveSnapshot={lastSuccessfulLiveSnapshot}
              onClaimNow={() => {
                void claimBullpenResolvedPositions();
              }}
              onInvest={investInSelectedEvents}
              onRefreshPositions={() => {
                void refreshBullpenPositions({
                  refreshMode: "manual",
                  callerSource: "ui-manual-refresh",
                });
              }}
              onRefreshCurrentOdds={handleRefreshCurrentOdds}
              onToggleQuestion={toggleInvestmentSelection}
              onSelectAll={selectAllInvestmentCandidates}
              onClearAll={clearInvestmentCandidates}
              positionsError={positionsError}
              positionsFallback={positionsFallback}
              positionsDiagnostics={positionsDiagnostics}
              positionsHealth={positionsHealth}
              positionsLastUpdatedAt={positionsLastUpdatedAt}
              sectionsLastRefreshedAt={pickLatestTimestamp(
                positionsLastUpdatedAt,
                autoRunLastCompletedAt,
              )}
              positionsSource={positionsSource}
              progressMessage={isManualScanView ? investmentProgress : null}
              historicalRuns={historicalAutoRunRuns}
              recentDecisions={recentAutoRunDecisions}
              resultMessage={isManualScanView ? investmentNotice : null}
              latestCompletedLlmRunId={latestCompletedLlmRunId}
              currentInProgressLlmRunId={currentInProgressLlmRunId}
              selectedQuestionIds={visibleSelectedInvestmentQuestionIdSet}
            />
          ) : null}

          {visibleCurrentSnapshot && selectionEnabled ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              <span>
                {`${formatCountLabel(openActivePositions.length, "active position")} auto-included and ${formatCountLabel(selectedQuestionCount, "scan question")} selected for LLM analysis.`}
              </span>
              {isManualScanView && lastLlmTargets.length > 0 ? (
                <span className="text-xs font-medium uppercase tracking-[0.16em] text-slate-500">
                  Last LLMs: {formatTargetSummary(lastLlmTargets)}
                </span>
              ) : null}
            </div>
          ) : null}
        </CardContent>
        ) : null}
      </Card>
      ) : null}

      <BullpenQuestionsTable
            snapshot={activeVisibleSnapshot}
            rowsOverride={orderedVisibleTableRows}
            rowHighlightById={tableRowHighlightById}
            emptyMessage={currentTableEmptyMessage}
            headerContent={
              <>
                <div className="flex flex-wrap gap-4">
                  {SNAPSHOT_SOURCE_TABS.map((tab) => {
                    const tabSnapshot =
                      tab.source === "manual"
                        ? activeCurrentSnapshot
                        : activeAutoCurrentSnapshot;

                    return (
                      <div key={tab.source} className="space-y-1.5">
                        <button
                          type="button"
                          onClick={() =>
                            setSnapshotSourceByMode((current) => ({
                              ...current,
                              [activeMode]: tab.source,
                            }))
                          }
                          className={`rounded-full border px-3 py-1.5 text-sm font-semibold transition ${
                            activeSnapshotSource === tab.source
                              ? tab.source === "manual"
                                ? "border-blue-700 bg-blue-700 text-white shadow-sm shadow-blue-700/20"
                                : "border-emerald-600 bg-emerald-600 text-white shadow-sm shadow-emerald-600/20"
                              : tab.source === "manual"
                                ? "border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100"
                                : "border-emerald-200 bg-emerald-50 text-emerald-700 hover:bg-emerald-100"
                          }`}
                        >
                          {tab.label}
                        </button>
                        <div className="space-y-0.5 text-xs font-medium leading-5 text-slate-600">
                          {activeSnapshotSource === tab.source ? (
                            <>
                              <p>
                                Total Events Scanned: {tabSnapshot?.totalCandidates ?? 0}
                              </p>
                              <p>
                                Events that passed Filters: {tabSnapshot?.questions.length ?? 0}
                              </p>
                            </>
                          ) : null}
                        </div>
                      </div>
                    );
                  })}
                </div>
                {SNAPSHOT_SOURCE_TABS.find(
                  (tab) => tab.source === activeSnapshotSource,
                )?.description ? (
                  <p className="mt-2 text-xs text-slate-500">
                    {
                      SNAPSHOT_SOURCE_TABS.find(
                        (tab) => tab.source === activeSnapshotSource,
                      )?.description
                    }
                  </p>
                ) : null}
              </>
            }
            isLoading={isManualScanView && isScanning}
            historicalRuns={historicalAutoRunRuns}
            historicalDecisions={recentAutoRunDecisions}
            onSortChange={setActiveSort}
            selectedQuestionIds={visibleSelectedQuestionIdSet}
            selectionEnabled={selectionEnabled}
            sortState={sortByMode[activeMode]}
            onToggleQuestion={toggleQuestionSelection}
            onToggleSelectAll={toggleSelectAllQuestions}
          />

      {isBullpenAccountDialogOpen ? (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4"
          role="presentation"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) {
              setIsBullpenAccountDialogOpen(false);
            }
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-labelledby="change-bullpen-account-title"
            className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-3xl border border-slate-200 bg-white p-6 shadow-2xl"
          >
            <div className="flex items-start justify-between gap-4">
              <div>
                <p className="text-xs font-semibold uppercase tracking-[0.18em] text-purple-600">
                  Bullpen account access
                </p>
                <h2
                  id="change-bullpen-account-title"
                  className="mt-1 text-2xl font-bold text-slate-950"
                >
                  Change Bullpen Account
                </h2>
                <p className="mt-2 text-sm leading-6 text-slate-600">
                  Open the production EC2 terminal, then run these commands in
                  order. Bullpen will print a new one-time device URL and code;
                  complete that sign-in before running the verification command.
                </p>
              </div>
              <button
                type="button"
                onClick={() => setIsBullpenAccountDialogOpen(false)}
                className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-950"
                aria-label="Close Change Bullpen Account dialog"
              >
                <X className="size-5" aria-hidden="true" />
              </button>
            </div>
            <a
              href={AWS_EC2_TERMINAL_URL}
              target="_blank"
              rel="noreferrer"
              className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm font-semibold text-amber-950 hover:bg-amber-100"
            >
              <span className="min-w-0 break-all">{AWS_EC2_TERMINAL_URL}</span>
              <ExternalLink className="size-4 shrink-0" aria-hidden="true" />
            </a>
            <ol className="mt-5 space-y-3">
              {CHANGE_BULLPEN_ACCOUNT_COMMANDS.map((command, index) => (
                <li
                  key={command}
                  className="rounded-2xl border border-slate-200 bg-slate-950 p-4 text-white"
                >
                  <div className="mb-2 flex items-center justify-between gap-3">
                    <span className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                      Step {index + 1}
                    </span>
                    <button
                      type="button"
                      onClick={() => void navigator.clipboard.writeText(command)}
                      className="inline-flex items-center gap-1 rounded-lg px-2 py-1 text-xs font-semibold text-slate-300 hover:bg-white/10 hover:text-white"
                    >
                      <Copy className="size-3.5" aria-hidden="true" />
                      Copy
                    </button>
                  </div>
                  <code className="block break-all text-xs leading-5 text-emerald-300">
                    {command}
                  </code>
                </li>
              ))}
            </ol>
            <div className="mt-5 rounded-2xl border border-sky-200 bg-sky-50 p-4 text-sm leading-6 text-sky-950">
              Do not reuse the login code shown in an old screenshot. Every
              login creates a fresh one-time code. This server uses systemd, so
              use the listed investor services instead of PM2.
            </div>
          </section>
        </div>
      ) : null}

      {isPromptEditorOpen ? (
        <BullpenPromptEditorDialog
          value={bullpenLlmPromptTemplate}
          onClose={() => setIsPromptEditorOpen(false)}
          onSave={handlePromptTemplateSave}
        />
      ) : null}

      {openFilterDetailsId ? (
        <BullpenScanFilterDetailsDialog
          key={openFilterDetailsId}
          detailId={openFilterDetailsId}
          customKeywords={getCustomExclusionKeywordsForDetail(
            activeFilters,
            openFilterDetailsId,
          )}
          onSaveCustomKeywords={(keywords) =>
            saveCustomExclusionKeywords(openFilterDetailsId, keywords)
          }
          onClose={() => setOpenFilterDetailsId(null)}
        />
      ) : null}
    </div>
  );
}
