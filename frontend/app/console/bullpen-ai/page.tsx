"use client";

import { useEffect, useRef, useState } from "react";
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
  averageBullpenLlmOdds,
  archiveBullpenScanSnapshot,
  BULLPEN_SOURCE_URLS,
  buildBullpenLlmPrompt,
  buildBullpenScanQueryParams,
  createBullpenQuestionRow,
  createBullpenScanFilters,
  createBullpenScanSnapshot,
  DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
  isBullpenQuestionInvestmentCandidate,
  normalizeBullpenScanFilters,
  parseBullpenLlmAnalysisPayload,
  summarizeBullpenLlmNotes,
  type BullpenQuestionRow,
  type BullpenScanFilters,
  type BullpenScanSnapshot,
  type BullpenSnapshotHistory,
  type ScanMode,
  type ScanResult,
} from "@/lib/bullpen-ai";
import { cn } from "@/lib/utils";
import { URLs } from "@/lib/urls";
import { APIError, apiService } from "@/services/api";
import type {
  PolymarketManualInvestOrderRequest,
  PolymarketManualInvestResponse,
  ProviderModelTarget,
} from "@/types/api";

import {
  BullpenQuestionsTable,
  type BullpenTableSortKey,
  type BullpenTableSortState,
} from "./_components/BullpenQuestionsTable";
import { BullpenInvestmentsSection } from "./_components/BullpenInvestmentsSection";
import { BullpenPromptEditorDialog } from "./_components/BullpenPromptEditorDialog";

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

const BULLPEN_SNAPSHOT_STORAGE_KEY = "investor:bullpen-ai:snapshots:v1";
const BULLPEN_LAST_LLM_TARGET_STORAGE_KEY =
  "investor:bullpen-ai:last-llm-target:v1";
const BULLPEN_LLM_PROMPT_STORAGE_KEY =
  "investor:bullpen-ai:llm-prompt-template:v1";
const MAX_BULLPEN_SNAPSHOT_HISTORY = 10;
const RUN_POLL_INTERVAL_MS = 4_000;
const MAX_RUN_POLLS = 90;
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
};

type BullpenCurrentOddsRefreshResponse = {
  markets?: Record<string, PolymarketMarketRefresh>;
  unresolvedQuestionIds?: string[];
  error?: string;
};

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

function formatDate(value: string | null) {
  if (!value) return "—";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString("en-IN", {
    dateStyle: "medium",
    timeStyle: "short",
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
  if (error instanceof APIError) return error.message;
  if (error instanceof Error) return error.message;
  return "Something went wrong.";
}

function buildBullpenManualInvestOrder(
  question: BullpenQuestionRow,
): PolymarketManualInvestOrderRequest | null {
  if (
    question.amountToBeInvested === null ||
    question.amountToBeInvested <= 0 ||
    question.noOdds === null ||
    question.noOdds <= 0 ||
    question.noOdds >= 100
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
    outcome: "No",
    amount: Number(question.amountToBeInvested.toFixed(2)),
    price: Number((question.noOdds / 100).toFixed(4)),
    event_end_at: question.closeTime,
    market_url: question.marketUrl,
  };
}

function applySnapshotMarketUpdates(
  snapshot: BullpenScanSnapshot | null,
  snapshotId: string,
  marketUpdates: Record<string, Partial<PolymarketMarketRefresh>>,
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

    if (
      nextSlug === question.slug &&
      nextMarketUrl === question.marketUrl &&
      nextYesOdds === question.yesOdds &&
      nextNoOdds === question.noOdds
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
    return stored?.trim() || DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE;
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
  className,
}: {
  checked: boolean;
  label: string;
  description: string;
  onChange: (checked: boolean) => void;
  className?: string;
}) {
  return (
    <label
      className={cn(
        "flex items-start gap-3 rounded-2xl border border-slate-200 bg-slate-50 p-3",
        className,
      )}
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
        className="mt-1 h-4 w-4 rounded border-slate-300 text-slate-950 focus:ring-slate-400"
      />
      <span className="space-y-1">
        <span className="block text-sm font-semibold text-slate-900">
          {label}
        </span>
        <span className="block text-xs leading-5 text-slate-600">
          {description}
        </span>
      </span>
    </label>
  );
}

export default function BullpenAiPage() {
  const searchParams = useSearchParams();
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
    Record<ScanMode, string | null>
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
  const [scanningMode, setScanningMode] = useState<ScanMode | null>(null);
  const [llmRunningMode, setLlmRunningMode] = useState<ScanMode | null>(null);
  const [investingMode, setInvestingMode] = useState<ScanMode | null>(null);
  const [refreshingCurrentOddsMode, setRefreshingCurrentOddsMode] = useState<
    ScanMode | null
  >(null);
  const [lastLlmTargets, setLastLlmTargets] = useState<ProviderModelTarget[]>(
    [],
  );
  const [bullpenLlmPromptTemplate, setBullpenLlmPromptTemplate] = useState(
    DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
  );
  const [isPromptEditorOpen, setIsPromptEditorOpen] = useState(false);
  const [isScanFiltersOpen, setIsScanFiltersOpen] = useState(false);
  const [hasLoadedStorage, setHasLoadedStorage] = useState(false);
  const scanFiltersMenuRef = useRef<HTMLDivElement | null>(null);
  const canonicalizedSnapshotIdsRef = useRef<Record<ScanMode, Set<string>>>({
    "30-days": new Set<string>(),
    "end-of-month": new Set<string>(),
  });

  useEffect(() => {
    setSnapshotsByMode(readBullpenSnapshotsFromStorage());
    setLastLlmTargets(readLastLlmTargetsFromStorage());
    setBullpenLlmPromptTemplate(readBullpenLlmPromptFromStorage());
    setHasLoadedStorage(true);
  }, []);

  useEffect(() => {
    if (!hasLoadedStorage) return;
    writeBullpenSnapshotsToStorage(snapshotsByMode);
  }, [hasLoadedStorage, snapshotsByMode]);

  useEffect(() => {
    setIsScanFiltersOpen(false);
  }, [activeMode]);

  useEffect(() => {
    if (!isScanFiltersOpen) return;

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
  }, [isScanFiltersOpen]);

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
  const activeInvestmentCandidates =
    selectionEnabled && activeCurrentSnapshot
      ? activeCurrentSnapshot.questions.filter((question) => {
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
    activeCurrentSnapshot?.questions.some(
      (question) => question.llmYesOdds !== null || question.llmNoOdds !== null,
    ),
  );

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

  async function runScan() {
    const params = buildBullpenScanQueryParams(activeMode, activeFilters);
    setScanningMode(activeMode);
    setMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));

    try {
      const response = await fetch(`/api/bullpen-ai?${params.toString()}`, {
        cache: "no-store",
      });
      const payload = (await response.json()) as ScanResult;
      const isSuccessfulScan = response.ok && !payload.error;

      if (isSuccessfulScan) {
        const nextSnapshot = createBullpenScanSnapshot(payload);

        setSnapshotsByMode((current) => {
          const previousCurrent = current[activeMode].current;
          return {
            ...current,
            [activeMode]: {
              current: nextSnapshot,
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
        setSelectedQuestionIdsByMode((current) => ({
          ...current,
          [activeMode]: [],
        }));
        setSelectedInvestmentQuestionIdsByMode((current) => ({
          ...current,
          [activeMode]: [],
        }));
      }

      setMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          !response.ok || payload.error
            ? payload.error || "Bullpen scan failed."
            : payload.warning
              ? payload.warning
              : payload.questions.length === 0
                ? "No Bullpen questions matched the current scan filters. Adjust the filters or rerun later."
                : null,
      }));
    } catch (scanError) {
      setMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          scanError instanceof Error
            ? scanError.message
            : "Bullpen scan failed.",
      }));
    } finally {
      setScanningMode(null);
    }
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

    if (selectedQuestions.length === 0) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]:
          "Select at least one question from the table before running LLM analysis.",
      }));
      return;
    }

    setLlmRunningMode(activeMode);
    setLlmMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setInvestmentMessagesByMode((current) => ({ ...current, [activeMode]: null }));
    setLastLlmTargets(targets);
    writeLastLlmTargetsToStorage(targets);

    try {
      const run = await apiService.createRun({
        prompt: buildBullpenLlmPrompt(
          selectedQuestions,
          bullpenLlmPromptTemplate,
        ),
        targets,
        allow_parallel: true,
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
      const selectedQuestionIdsSet = new Set(
        selectedQuestions.map((question) => question.id),
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

        if (!responseText) {
          failedModels.push(
            `${label}: ${runJob.job.error_message || `job ${runJob.job.status.toLowerCase()}`}`,
          );
          continue;
        }

        try {
          const analysisPayload = parseBullpenLlmAnalysisPayload(
            responseText,
            selectedQuestions,
          );
          const analysisByQuestionId = new Map(
            analysisPayload.markets
              .filter((item) => selectedQuestionIdsSet.has(item.questionId))
              .map((item) => [item.questionId, item] as const),
          );

          unmatchedCount += Math.max(
            0,
            analysisPayload.markets.length - analysisByQuestionId.size,
          );
          successfulModelCount += 1;

          analysisByQuestionId.forEach((item, questionId) => {
            const currentBreakdown = breakdownByQuestionId.get(questionId) || [];
            currentBreakdown.push({
              provider: runJob.job.provider,
              model: runJob.job.model,
              jobId: runJob.job.id,
              runId: completedRun.id,
              timestamp: runJob.job.updated_at || completedRun.updated_at,
              llmYesOdds: item.llmYesOdds,
              llmNoOdds: item.llmNoOdds,
              rationale: item.rationale || item.notes,
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

      const matchedCount = breakdownByQuestionId.size;
      const rowsWithOddsCount = Array.from(breakdownByQuestionId.values()).filter(
        (llmBreakdown) => {
          const averageOdds = averageBullpenLlmOdds(llmBreakdown);
          return averageOdds.yes !== null || averageOdds.no !== null;
        },
      ).length;
      const blankOddsCount = matchedCount - rowsWithOddsCount;

      setSnapshotsByMode((current) => {
        const currentSnapshot = current[activeMode].current;
        if (!currentSnapshot) return current;

        const nextQuestions = currentSnapshot.questions.map((question) => {
          const llmBreakdown = breakdownByQuestionId.get(question.id);
          if (!llmBreakdown || llmBreakdown.length === 0) return question;

          const averageOdds = averageBullpenLlmOdds(llmBreakdown);
          const completedAt =
            [...llmBreakdown]
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) || new Date().toISOString();

          return createBullpenQuestionRow({
            ...question,
            llmYesOdds: averageOdds.yes,
            llmNoOdds: averageOdds.no,
            currentVsLlmOddsDifference:
              averageOdds.yes === null || question.yesOdds === null
                ? null
                : Number((question.yesOdds - averageOdds.yes).toFixed(2)),
            llmNotes: summarizeBullpenLlmNotes(llmBreakdown),
            llmProvider:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null,
            llmModel:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null,
            llmRunId: completedRun.id,
            llmCompletedAt: completedAt,
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
          const llmBreakdown = breakdownByQuestionId.get(question.id);
          if (!llmBreakdown || llmBreakdown.length === 0) return question;

          const averageOdds = averageBullpenLlmOdds(llmBreakdown);
          const completedAt =
            [...llmBreakdown]
              .map((entry) => entry.timestamp)
              .filter((timestamp): timestamp is string => Boolean(timestamp))
              .sort()
              .at(-1) || new Date().toISOString();

          return createBullpenQuestionRow({
            ...question,
            llmYesOdds: averageOdds.yes,
            llmNoOdds: averageOdds.no,
            currentVsLlmOddsDifference:
              averageOdds.yes === null || question.yesOdds === null
                ? null
                : Number((question.yesOdds - averageOdds.yes).toFixed(2)),
            llmNotes: summarizeBullpenLlmNotes(llmBreakdown),
            llmProvider:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null,
            llmModel:
              llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null,
            llmRunId: completedRun.id,
            llmCompletedAt: completedAt,
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

      const summaryParts = [
        `LLM finished with ${targets.length} selected model${targets.length === 1 ? "" : "s"}.`,
      ];

      if (rowsWithOddsCount > 0) {
        summaryParts.push(
          `Averaged odds for ${formatCountLabel(rowsWithOddsCount, "selected question")}.`,
        );
      } else if (matchedCount > 0) {
        summaryParts.push(
          `Matched ${formatCountLabel(matchedCount, "selected row")} back to the table, but the returned models left their odds blank.`,
        );
      } else {
        summaryParts.push(
          "The returned models produced output, but none of it could be matched back to the selected table rows, so the LLM odds columns stayed unchanged.",
        );
      }

      if (blankOddsCount > 0) {
        summaryParts.push(
          `${formatCountLabel(blankOddsCount, "matched row")} came back without usable odds after averaging, so those LLM odds stayed blank.`,
        );
      }

      if (unmatchedCount > 0) {
        summaryParts.push(
          `${formatCountLabel(unmatchedCount, "returned row")} could not be matched back to the selected questions.`,
        );
      }

      if (successfulModelCount > 0) {
        summaryParts.push(
          `${formatCountLabel(successfulModelCount, "model")} returned usable JSON.`,
        );
      }

      if (failedModels.length > 0) {
        summaryParts.push(
          `${formatCountLabel(failedModels.length, "model")} failed or returned unusable output: ${failedModels.join(" | ")}.`,
        );
      }

      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: summaryParts.join(" "),
      }));
    } catch (error) {
      setLlmMessagesByMode((current) => ({
        ...current,
        [activeMode]: normalizeError(error),
      }));
    } finally {
      setLlmRunningMode(null);
    }
  }

  async function refreshSelectedCurrentOdds({
    questionIds = selectedInvestmentQuestionIds,
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

    const selectedQuestionIdSet = new Set(questionIds);
    const questionsToRefresh = activeCurrentSnapshot.questions.filter((question) =>
      selectedQuestionIdSet.has(question.id),
    );

    if (questionsToRefresh.length === 0) {
      throw new Error("Select at least one pink event before refreshing Current %.");
    }

    if (showLoadingState) {
      setRefreshingCurrentOddsMode(activeMode);
    }
    setInvestmentProgressByMode((current) => ({
      ...current,
      [activeMode]: `Refreshing latest Polymarket odds for ${formatCountLabel(questionsToRefresh.length, "selected event")}...`,
    }));

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
          ),
          history: current[activeMode].history,
        },
      }));

      if (announceResult) {
        const summaryParts = [
          `Refreshed Current % for ${formatCountLabel(refreshedQuestionIds.size, "selected event")}.`,
        ];
        if (unresolvedCount > 0) {
          summaryParts.push(
            `${formatCountLabel(unresolvedCount, "selected event")} could not be refreshed from Polymarket.`,
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
        await refreshSelectedCurrentOdds({
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
      if (executedOrders.length > 0) {
        summaryParts.push(
          `Placed ${executedOrders.length} Bullpen order${executedOrders.length === 1 ? "" : "s"}.`,
        );
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
          `${formatCountLabel(noLongerQualifiedCount, "selected event")} was skipped because the refreshed odds no longer met the pink-row thresholds.`,
        );
      }
      if (summaryParts.length === 0) {
        summaryParts.push("No Bullpen orders were placed.");
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
      await refreshSelectedCurrentOdds();
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
      ? "Run LLM analysis first. Pink invest rows appear after LLM No Odds and Returns/day qualify."
      : "No rows are currently pink. Rows appear here when LLM No Odds is above 80% and Returns/day is above 5%.";

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
                          <FilterToggle
                            checked={activeFilters.excludeSports}
                            onChange={(checked) =>
                              updateActiveFilters({ excludeSports: checked })
                            }
                            label="Exclude sports"
                            description="Remove sports leagues, teams, games, tournaments, and match-result markets."
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeWeather}
                            onChange={(checked) =>
                              updateActiveFilters({ excludeWeather: checked })
                            }
                            label="Exclude weather"
                            description="Remove temperature, storm, rainfall, hurricane, and climate-style markets."
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeMarketPredictions}
                            onChange={(checked) =>
                              updateActiveFilters({
                                excludeMarketPredictions: checked,
                              })
                            }
                            label="Exclude market predictions"
                            description="Remove finance, macro, stocks, commodities, and crypto-price style questions."
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.excludeTweetCountQuestions}
                            onChange={(checked) =>
                              updateActiveFilters({
                                excludeTweetCountQuestions: checked,
                              })
                            }
                            label="Exclude tweet counts"
                            description="Remove questions asking how many tweets or social posts someone will make."
                            className="h-full"
                          />
                          <FilterToggle
                            checked={activeFilters.onlyBinaryYesNo}
                            onChange={(checked) =>
                              updateActiveFilters({ onlyBinaryYesNo: checked })
                            }
                            label="Only Yes / No"
                            description="Keep only binary markets that resolve between a Yes and No outcome."
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
                      selectedQuestionCount === 0
                    }
                    selectionMode="multiple"
                    onRunMultiple={runLlm}
                    pickerDialogLabel="Select LLM"
                    pickerIcon={<Menu className="size-4" />}
                    running={isRunningLlm}
                    buttonClassName="rounded-none"
                    pickerButtonClassName="h-10 w-10 rounded-none border border-l-0 border-transparent bg-primary text-primary-foreground hover:bg-primary/80 focus:outline-none focus:ring-2 focus:ring-ring/30"
                  />
                </div>
                {isRunningLlm ? (
                  <p className="text-xs leading-5 text-slate-600">
                    Running {formatTargetSummary(lastLlmTargets)} on the selected
                    questions now. When it finishes, we&apos;ll say how many
                    table rows were updated, how many model outputs were usable,
                    and whether any averaged LLM odds stayed blank.
                  </p>
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
              {llmNotice}
            </div>
          ) : null}

          {investmentNotice ? (
            <div className="rounded-2xl border border-fuchsia-200 bg-fuchsia-50 px-4 py-3 text-sm text-fuchsia-950">
              {investmentNotice}
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
              candidates={activeInvestmentCandidates}
              emptyMessage={investmentEmptyMessage}
              isHistoryView={isViewingHistory}
              isInvesting={isInvesting}
              isRefreshingCurrentOdds={isRefreshingCurrentOdds}
              onInvest={investInSelectedEvents}
              onRefreshCurrentOdds={handleRefreshCurrentOdds}
              onToggleQuestion={toggleInvestmentSelection}
              onSelectAll={selectAllInvestmentCandidates}
              onClearAll={clearInvestmentCandidates}
              progressMessage={investmentProgress}
              selectedQuestionIds={selectedInvestmentQuestionIdSet}
            />
          ) : null}

          {activeCurrentSnapshot ? (
            <div className="flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-slate-200 bg-white px-4 py-3 text-sm text-slate-600">
              <span>
                {selectionEnabled
                  ? `${selectedQuestionCount} question${selectedQuestionCount === 1 ? "" : "s"} selected for LLM analysis.`
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
    </div>
  );
}
