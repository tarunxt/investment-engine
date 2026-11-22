"use client";
import { bindIndependentBasket } from "@/lib/scorecardBasket";
import { cards, isCard, migratedPolicy, scorecardApi, type FinalRow, type CardKey, type CardPolicy } from "@/lib/independentScorecards";
import { ScorecardReview } from "./ScorecardReview";
import { useReviewDialog } from "@/hooks/useReviewDialog";
import { ZerodhaRunGate } from "@/components/shared/ZerodhaRunGate";
import { defaultStageModelKeys, getCompatibleTargets, isModelStage, usesSingleScorecardJob, previousBrowserSelection, resolveStageModelKeys, type ModelStage } from "@/lib/workflowStageModels";
import { acquireZerodhaLogin } from "@/lib/zerodhaLoginArbitration";
import { captureWorkflowOwner, isCurrentWorkflowOwner, onWorkflowOwnerInvalidated, requireWorkflowOwner, type WorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { workflowOwnedApi } from "@/lib/workflowOwnedApi";
import type { WorkflowSurface } from "@/app/console/_components/WorkflowSurfaceHost";
import { IndMoneySnapshotDialog } from "./IndMoneySnapshotDialog";
import { readIndmoneySnapshotSource } from "@/lib/indmoneySnapshotSource";

import { AnalysisOnlyRunControl } from "@/components/shared/AnalysisOnlyRunControl";

import { WorkflowStageLedger, WorkflowStageLedgerViews, type WorkflowLedgerView } from "@/components/shared/WorkflowStageLedger";
import { WorkflowRunBoundary } from "@/app/console/automated-rebalance/_components/WorkflowRunBoundary";

import { captureUsValuation } from "@/lib/captureUsValuation";
import { captureIndiaValuation } from "@/lib/captureIndiaValuation";
import { workflowRanking } from "@/lib/workflowScorecardRanking";
import { type WorkflowStageKey, type StageState, type StageErrorDetail, type StageInfo, STAGE_ORDER, STAGE_METADATA, getStageTileLabel, parseTimestampMs, formatDuration, formatInrCost, WorkflowStageTile } from "@/components/shared/WorkflowStageTile";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { scorecardHref, type ScorecardTab } from "@/lib/scorecardNavigation";
import { ScorecardScreen, ScorecardEvidenceDialog } from "./ScorecardScreen";
import { STANDARD_ACTION_ROW_CLASS, STANDARD_ACTION_ORDER, parseActionLabel } from "@/lib/actionColorScheme";
import { AutomatedRebalanceReliabilityBridge } from "@/app/console/automated-rebalance/_components/AutomatedRebalanceReliabilityBridge";
import { InputEvidenceRows, InputEvidenceSummary } from "./InputEvidenceRows";
import { threatInputRationale } from "./threatInputRationale";
import { PromptTemplateDialog } from "@/app/console/automated-rebalance/_components/PromptTemplateDialog";
import { SavedOutputDialog } from "@/components/shared/SavedOutputDialog";
import { BasketResizeHandles } from "@/components/BasketResizeHandles";
import { ZerodhaBasketLoading } from "@/components/ZerodhaBasketLoading";
import { basketAffordabilityIssue, basketResponseIssue, definitiveBasketRejection } from "@/lib/basketSubmissionSafety";
import { useBasketSubmissionSafety } from "@/hooks/useBasketSubmissionSafety";
import { BasketDraftUnits } from "@/components/BasketDraftUnits";
import { BasketMarketClosedNotice } from "@/components/BasketMarketClosedNotice";
import { draftDirection, suggestedDraftUnits, editableDraftAmount, editableDraftIssues, type BasketDraftContext } from "@/lib/basketEditableDraft";
import { useAuth } from "@/hooks/useAuth";
import { readBasketColumnLayout, writeBasketColumnLayout, emptyBasketColumnLayout, type BasketColumnLayout } from "@/lib/basketColumnPreferences";
import { useBasketDisplayQuotes, useBasketDisplayCalculations } from "@/components/BasketDisplayCalculations";
import { basketActionGroup, indmoneyHolding, actionQuantityMatchesDraft, kiteWeightContext, kiteHoldingQuantity, stockIdentity, validDisplayPrice, verifiedFetchedDisplayQuote, formatBasketDisplayCurrency, displayScoreAccepted, toggleVisibleSelection, verifiedDisplayQuote } from "@/lib/basketDisplayCalculations";
import { PortfolioParametersTile } from "@/components/PortfolioParametersTile";
import { portfolioParameterAssets, portfolioParameterMargin } from "@/lib/portfolioParameters";
import { collectPreflightErrors, type PreflightCheck } from "@/lib/rebalancePreflight";
import { resolveTechnicalPriceEvidence } from "@/lib/technicalPriceEvidence";
import { auditResponseHashes } from "@/services/recommendationAudit";
import { WholeShareTrimChoice } from "@/components/WholeShareTrimChoice";
import { BasketUnitsPopup } from "@/components/BasketUnitsPopup";
import { BasketColumnTable, BasketColumnPicker, BasketColumnRename } from "@/components/BasketColumnPicker";
import type { BasketUnitsTrace } from "@/lib/basketUnitsExplanation";
import { useWorkflowConfiguration } from "@/app/console/_components/WorkflowConfiguration";
import { mergeStageEvidence, swingRecommendationCounts } from "@/lib/stockFlowEvidence";
import { classifyWorkflowLlmJob as classifyRunOutputJob } from "@/lib/workflowLlmEvidence";
import { assertWholeShareOrdersReviewed, isWholeShareOrderSelectable, needsWholeShareTrimReview, type WholeShareChoice } from "@/lib/wholeShareReview";
import {
  Fragment,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { formatRebalanceCost, knownCost, sumRebalanceCosts, type StageCost } from "@/lib/rebalanceCost";
import { useRebalanceCostQuote } from "@/hooks/useRebalanceCostQuote";
import {
  formatUsdAsVerifiedInr,
  isVerifiedFxRate,
} from "@/lib/fxPresentation";
import { AlertCircle, CheckCircle2, ChevronDown, ChevronRight, FileSpreadsheet, History, Info, Loader2, Pause, Play, X } from "lucide-react";

import {
  FinalActionablesConsole,
  buildConsensusRows,
  buildDashboardActionRows,
  buildHistoricalDashboardActionRows,
  buildTechnicalScanMap,
  buildTechnicalScanPrompt,
  ConsensusBreakupButton,
  ScoreMatrixButton,
  ScoreMatrixModal,
  StockDetailsButton,
  getTechnicalScanForStock,
  getScoreMatrixValidationSummary,
  normalizeScoreMatrixFormulaConfig,
  type ScoreMatrixFormulaConfig,
  type ActionCategory,
  type ActionEstimate,
  extractRebalanceInputFingerprint,
  fetchAllFullRuns,
  fetchDashboardRecentFullRuns,
  isCompletedRebalanceRun,
  type DashboardActionRow,
  type HistoricalDashboardActionRow,
  type ScoreMatrixDetail,
  type StockDetailsData,
  type TechnicalScanResult,
  type StockConsensus,
} from "@/app/console/_components/FinalActionablesConsole";
import { Button } from "@/components/ui/button";
import { TradingViewSymbolLink } from "@/components/shared/TradingViewSymbolLink";
import { TradingViewUrlListButton } from "@/components/shared/TradingViewUrlListButton";
import { LlmModelMixControls } from "@/components/shared/LlmModelMixControls";
import { StandardLlmOutputRenderer } from "@/components/shared/StandardLlmOutputRenderer";
import {
  INDMONEY_DASHBOARD_SYNC_NOW_EVENT,
  ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
} from "./dashboardEvents";
import { ModelPickerDialogFrame } from "@/components/shared/ModelPickerDialogFrame";
import { LlmModelSelectionPanel } from "@/components/shared/LlmModelSelectionPanel";
import {
  assertIndmoneyHoldingsSnapshot,
  buildRebalanceInputBundle,
  buildRebalancePrompt,
  ensureRebalanceFlowMarker,
  getPreviousMarketClose,
  getRebalanceDefaultExportSheetName,
} from "@/lib/rebalance";
import {
  buildSwingTradePrompt,
  getSwingTradeDefaultExportSheetName,
  readZerodhaSwingSettings,
  zerodhaSwingSettingsKey,
  type SwingTradeMarket,
} from "@/lib/swingTrade";
import {
  buildDefaultZerodhaBasketSelection,
  syncZerodhaBasketBuySelection,
  type ZerodhaBasketSelectableOrder,
} from "@/lib/zerodhaBasketSelection";
import { getAutoRebalanceRunDisplayLabel, getRunDetailPathFromPrompt } from "@/lib/runPresentation";
import { apiService as workflowApiService } from "@/services/api";
import { APIError, NetworkError, apiService } from "@/services/api";
import { isAnalysisRunForStage } from "@/lib/rebalanceRunIdentity";
import { buildOutputSourceJobs } from "@/lib/outputSourceJobs";
import {
  AutoRebalanceAuditSession,
  assertAutoRebalanceRunMetadata,
  autoRebalanceAuditKey,
  actionablesActivityKey,
  announceActionablesActivity,
  restoreAutoRebalanceAuditState,
  type AutoRebalanceAuditState,
} from "@/lib/autoRebalanceAudit";
import {
  technicalInputPlanIssue,
  deduplicateStageRunInputs,
  getSelectedStageRunIds,
  selectStageRunInputs,
  type ThreatStageInput,
} from "@/lib/rebalanceStageInputs";
import { URLs } from "@/lib/urls";
import { parseApiTimestamp, formatApiTimestamp, formatCompactQuoteTime, formatCompactStageTime } from "@/lib/datetime";
import { INDIA_TIMEZONE } from "../_context";
import { cn } from "@/lib/utils";
import type {
  IndMoneyUsPortfolioSnapshotCreateRequest,
  JobResponse,
  PortfolioAnalysisHistoryItem,
  ZerodhaPortfolioSnapshotDetail,
  ZerodhaPortfolioOverviewResponse,
  IndMoneyUsThreatAnalysis,
  IndMoneyUsPortfolioSnapshotDetail,
  ProviderInfo,
  ProviderModelTarget,
  RunCreate,
  AutoRebalanceHistoryItemResponse,
  AutoRebalanceRunMetadata,
  AutoRebalanceStageKey,
  RunResponse,
  ZerodhaThreatAnalysis,
} from "@/types/api";
import { normalizeError } from "./dashboardOverviewUtils";
import {
  RebalanceStockFlowDialog,
  RebalanceStockFlowTrigger,
  fetchRebalanceStockFlowSource,
  type RebalanceStockFlowPortfolio,
} from "./StockFlowTabs";

type WorkflowPortfolio = "zerodha" | "indmoneyUs";

type InputSelectionStage =
  | "threats"
  | "swing"
  | "rebalance"
  | "technical"
  | "actionables";
type InputSelectionCandidate = {
  id: string;
  source: "next" | "threat" | "run-job";
  label: string;
  jobNo: string;
  timestamp: string | null;
  status: string;
  costUsd: number | null;
  error: string | null;
  run?: RunResponse;
  jobId?: number;
  content?: string | null;
  market?: SwingTradeMarket;
};
type RunOutputJobStatus = "completed" | "partial" | "failed" | "other";

type AutoRebalanceCostBreakdownItem = {
  id: string;
  stage: Exclude<WorkflowStageKey, "sync" | "actionables">;
  sourceType: "run" | "job";
  runId?: number | null;
  jobId?: number | null;
  runPrompt?: string | null;
  timestamp: string | null;
  provider: string;
  model: string;
  status: string;
  costUsd: number | null;
  llmCount: number;
  autoRebalancePortfolio?: string | null;
  autoRebalanceSequence?: number | null;
  autoRebalanceLabel?: string | null;
};

type AutoRebalanceScanGroup = {
  id: string;
  portfolio: WorkflowPortfolio;
  timestamp: string | null;
  totalCostUsd: number;
  label: string;
  sequence: number;
  items: AutoRebalanceCostBreakdownItem[];
};

type StageLlmHistoryEntry = {
  id: string;
  runId: number;
  jobId: number;
  timestamp: string | null;
  provider: string;
  model: string;
  runtime: string | null;
  costUsd: number | null;
  status: RunOutputJobStatus;
  rawStatus: string;
};
type HistoricalLlmCostMapInr = Record<string, number>;

type ZerodhaBasketOrderKind = "Market" | "Limit" | "After market";
type ZerodhaBasketOrderPercent = number;
const ZERODHA_KITE_PUBLISHER_BATCH_SIZE = 5;
type ZerodhaBasketSubmission = {
  executionMode: ZerodhaExecutionMode;
  redirected: number;
  basketCount: number;
  clipboardCopied: boolean;
  orders: ZerodhaBasketPreviewOrder[];
  placedOrderIds?: string[];
  executionPricesByOrderId?: Record<string, number>;
  failedMessages?: string[];
  portfolioRefreshedAt?: string | null;
  phase?: "sell_first" | "buy_after_sell" | "single_side";
  skippedOrderIds?: string[];
  messages?: string[];
};
type ZerodhaBasketPreviewOrder = {
  draftContext?: BasketDraftContext;
  id: string;
  exchange: string;
  symbol: string;
  action: ActionCategory;
  side: "BUY" | "SELL";
  units: number | null;
  baseUnits: number | null;
  currentUnits: number | null;
  price: number | null;
  lastPrice: number | null;
  amount: number | null;
  availableBalance: number | null;
  percent: ZerodhaBasketOrderPercent;
  orderKind: ZerodhaBasketOrderKind;
  stock: StockConsensus;
  detail: ScoreMatrixDetail;
  technicalScan: TechnicalScanResult | null;
  allowFractionalUnits?: boolean;
  wholeShareReview?: WholeShareChoice;
  unitsTrace?: BasketUnitsTrace;
};
type WorkflowState = Record<WorkflowStageKey, StageInfo>;
type IndMoneySyncMode = "reuse" | "paste";
type PromptPreviewStage = "threats" | "swing" | "rebalance" | "technical";

type SavedModelMix = {
  id: string;
  name: string;
  targets: string[];
};

const MODEL_MIX_STORAGE_KEY = "investment-engine:model-mixes:v1";
const POLL_INTERVAL_MS = 3000;
const MAX_ZERODHA_SYNC_POLLS = 30;
const ZERODHA_AUTH_STATUS_POLL_MS = 500;
const ZERODHA_AUTH_CLOSE_GRACE_MS = 15_000;
const ZERODHA_AUTH_TIMEOUT_MS = 5 * 60 * 1000;
const ZERODHA_SYNC_AUTH_RETRY_DELAY_MS = 1_000;
const WORKFLOW_STORAGE_KEY = "investment-engine:rebalance-workflow-state:v1";
const WORKFLOW_COMPLETION_RESET_DELAY_MS = 10000;

class RecordedWorkflowStageFailure extends Error {
  readonly originalError: unknown;

  constructor(message: string, originalError: unknown) {
    super(message);
    this.name = "RecordedWorkflowStageFailure";
    this.originalError = originalError;
  }
}

const COST_BEARING_STAGES: WorkflowStageKey[] = [
  "threats",
  "swing",
  "rebalance",
  "technical",
];

function initialWorkflowState(): WorkflowState {
  return STAGE_ORDER.reduce((acc, stage) => {
    acc[stage] = { state: "idle" };
    return acc;
  }, {} as WorkflowState);
}

type PersistedWorkflow = {
  states: Record<WorkflowPortfolio, WorkflowState>;
  runningPortfolio: WorkflowPortfolio | null;
  specificMode: Record<WorkflowPortfolio, boolean>;
  selectedStages: Record<WorkflowPortfolio, WorkflowStageKey[]>;
  selectedInputs?: Record<
    WorkflowPortfolio,
    Partial<Record<InputSelectionStage, string[]>>
  >;
  activeAutoRebalanceMetadata?: Partial<
    Record<WorkflowPortfolio, AutoRebalanceRunMetadata>
  >;
  auditStates?: Partial<Record<WorkflowPortfolio, AutoRebalanceAuditState>>;
  savedAt: string;
};

function buildInitialStates() {
  return {
    zerodha: initialWorkflowState(),
    indmoneyUs: initialWorkflowState(),
  };
}

// Older tabs may have persisted history fields on upcoming/running stages.
// Keep polling identity and terminal current failures; refresh running metrics
// from that exact job instead of trusting fields inherited by older code.
function restoreCurrentWorkflowStages(stages: WorkflowState): WorkflowState {
  return STAGE_ORDER.reduce((next, stage) => {
    const info = stages[stage];
    next[stage] = info.state === "idle" || info.state === "queued"
      ? { state: info.state }
      : info.state === "running"
        ? { state: info.state, activeRunId: info.activeRunId, startedAt: info.startedAt, runStatus: info.runStatus }
        : info;
    return next;
  }, {} as WorkflowState);
}

function readPersistedWorkflow(): PersistedWorkflow | null {
  if (typeof window === "undefined") return null;
  try {
    const raw = window.localStorage.getItem(WORKFLOW_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as PersistedWorkflow;
    if (!parsed?.states?.zerodha || !parsed?.states?.indmoneyUs) return null;
    for(const portfolio of ["zerodha","indmoneyUs"] as const) parsed.states[portfolio].pairwise ??= {state:"idle"};
    return parsed;
  } catch {
    return null;
  }
}

function persistWorkflow(snapshot: PersistedWorkflow) {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(WORKFLOW_STORAGE_KEY, JSON.stringify(snapshot));
  } catch {
    // Progress persistence is best-effort; the visible in-memory state remains authoritative.
  }
}

function hasRestorableRunningWorkflow(
  persisted: PersistedWorkflow | null,
  portfolio: WorkflowPortfolio | null | undefined,
) {
  if (!persisted || !portfolio) return false;
  return STAGE_ORDER.some((stage) => {
    const state = persisted.states?.[portfolio]?.[stage]?.state;
    return state === "queued" || state === "running";
  });
}

function getRestorableRunningPortfolio(persisted: PersistedWorkflow | null) {
  return hasRestorableRunningWorkflow(persisted, persisted?.runningPortfolio)
    ? (persisted?.runningPortfolio ?? null)
    : null;
}

function hasActiveWorkflowStage(
  portfolio: WorkflowPortfolio,
  states: Record<WorkflowPortfolio, WorkflowState>,
) {
  return STAGE_ORDER.some((stage) =>
    ["queued", "running"].includes(states[portfolio][stage].state),
  );
}

function getQueuedStages(
  portfolio: WorkflowPortfolio,
  states: Record<WorkflowPortfolio, WorkflowState>,
  runningPortfolio: WorkflowPortfolio | null,
  specificMode: Record<WorkflowPortfolio, boolean>,
  selectedStages: Record<WorkflowPortfolio, Set<WorkflowStageKey>>,
) {
  if (runningPortfolio !== portfolio) return new Set<WorkflowStageKey>();
  const runningIndex = STAGE_ORDER.findIndex(
    (stage) => states[portfolio][stage].state === "running",
  );
  const activeIndex = runningIndex >= 0 ? runningIndex : -1;
  return new Set(
    STAGE_ORDER.filter((stage, index) => {
      const info = states[portfolio][stage];
      if (info.state !== "idle" && info.state !== "queued") return false;
      if (index <= activeIndex) return false;
      return specificMode[portfolio]
        ? selectedStages[portfolio].has(stage)
        : true;
    }),
  );
}

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => window.setTimeout(resolve, ms));
}

function isZerodhaAuthPropagationError(error: unknown) {
  if (error instanceof APIError && [401, 403, 409, 425].includes(error.status)) {
    return true;
  }
  return /(?:zerodha|kite).*(?:session|token|connect|login)|(?:session|token).*(?:expired|missing|not\s+found|not\s+connected)/i.test(
    normalizeError(error),
  );
}

async function confirmZerodhaConnectionReady(
  timeoutMs = ZERODHA_AUTH_CLOSE_GRACE_MS,
  owner: WorkflowOwner | null = captureWorkflowOwner(),
) {
  requireWorkflowOwner(owner);
  const ownerApi = workflowOwnedApi(apiService, owner);
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown = null;
  while (Date.now() < deadline) {
    requireWorkflowOwner(owner);
    try {
      const status = await ownerApi.zerodhaStatus();
      if (status.connected) return status;
      lastError = new Error("Kite login returned successfully, but the Zerodha session is not active yet.");
    } catch (error) {
      requireWorkflowOwner(owner);
      lastError = error;
    }
    await sleep(ZERODHA_AUTH_STATUS_POLL_MS);
    requireWorkflowOwner(owner);
  }
  throw new Error(`Kite login could not be confirmed by Cred-X within ${Math.round(timeoutMs / 1000)} seconds: ${normalizeError(lastError)}`);
}

async function queueZerodhaPortfolioSyncWithAuthRetry(owner: WorkflowOwner | null = captureWorkflowOwner()) {
  requireWorkflowOwner(owner);
  const ownerApi = workflowOwnedApi(apiService, owner);
  try {
    return await ownerApi.zerodhaSyncPortfolio();
  } catch (error) {
    requireWorkflowOwner(owner);
    if (!isZerodhaAuthPropagationError(error)) throw error;
    await confirmZerodhaConnectionReady(undefined, owner);
    requireWorkflowOwner(owner);
    await sleep(ZERODHA_SYNC_AUTH_RETRY_DELAY_MS);
    requireWorkflowOwner(owner);
    return ownerApi.zerodhaSyncPortfolio();
  }
}

function formatTimestamp(value?: string | null) {
  return formatApiTimestamp(value, {
    emptyValue: "Not available",
    locale: "en-IN",
    timeZone: INDIA_TIMEZONE,
    timeZoneName: "short",
  });
}

function getStageLabel(stage: WorkflowStageKey, state: StageState) {
  if (state === "running") return STAGE_METADATA[stage].running;
  if (state === "queued") return STAGE_METADATA[stage].idle;
  if (state === "completed") return STAGE_METADATA[stage].completed;
  return STAGE_METADATA[stage].idle;
}

function getInputStatusBadgeClass(status?: string | null) {
  const normalized = (status || "").toLowerCase();
  if (["reserved", "queued", "pending"].includes(normalized)) {
    return "bg-blue-50 text-blue-700 ring-blue-200";
  }
  if (normalized === "partial") {
    return "bg-amber-50 text-amber-700 ring-amber-200";
  }
  if (normalized === "completed" || normalized === "synced" || normalized === "parsed") {
    return "bg-emerald-50 text-emerald-700 ring-emerald-200";
  }
  if (normalized === "failed" || normalized === "error") {
    return "bg-red-50 text-red-700 ring-red-200";
  }
  return "bg-slate-100 text-slate-700 ring-slate-200";
}

function hasExceededCurrentQuotaError(error: string | null | undefined) {
  return /exceeded\s+your\s+current\s+quota/i.test(error ?? "");
}

function shouldShowQuotaLlmSwitchWarning(
  stages: Record<WorkflowStageKey, StageInfo>,
) {
  return hasExceededCurrentQuotaError(stages.threats.error);
}

function getLlmSelectorScanLabel(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio | null,
) {
  const marketLabel =
    portfolio === "zerodha" ? "India" : portfolio === "indmoneyUs" ? "US" : "";
  return [STAGE_METADATA[stage].idle, marketLabel].filter(Boolean).join(" ");
}

function getLlmSelectorTitle(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio | null,
  costInr?: number | null,
) {
  const scanLabel = getLlmSelectorScanLabel(stage, portfolio);
  const costLabel = formatInrCost(costInr);
  return `Select LLMs- ${scanLabel}${costLabel !== "n/a" ? ` (Cost incurred: ${costLabel})` : ""}`;
}

function readFailureDiagnostics(
  metadata: unknown,
): Partial<StageErrorDetail> {
  const metadataRecord =
    metadata && typeof metadata === "object" && !Array.isArray(metadata)
      ? (metadata as Record<string, unknown>)
      : null;
  const raw =
    metadataRecord?.failure_diagnostics &&
    typeof metadataRecord.failure_diagnostics === "object" &&
    !Array.isArray(metadataRecord.failure_diagnostics)
      ? (metadataRecord.failure_diagnostics as Record<string, unknown>)
      : null;
  if (!raw) return {};
  const stringValue = (key: string) =>
    typeof raw[key] === "string" && raw[key] ? (raw[key] as string) : null;
  const numberValue = (key: string) =>
    typeof raw[key] === "number" && Number.isFinite(raw[key])
      ? (raw[key] as number)
      : null;
  return {
    provider: stringValue("provider"),
    model: stringValue("model"),
    jobId: numberValue("job_id"),
    runId: numberValue("run_id"),
    httpStatus: numberValue("http_status"),
    providerResponseBody: stringValue("provider_response_body"),
    correlationId: stringValue("correlation_id"),
    exceptionType: stringValue("exception_type"),
    traceReference: stringValue("trace_reference"),
    retrySafe: typeof raw.retry_safe === "boolean" ? raw.retry_safe : null,
    attempt: numberValue("attempt"),
  };
}

function summarizeRun(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const firstJob = jobs[0];
  const jobCosts = jobs.map(job => job.estimated_cost).filter(knownCost);
  const failedJobs = jobs.filter(
    (job) => classifyRunOutputJob(job) === "failed",
  );
  const failedJob = failedJobs[0];
  const errorDetails: StageErrorDetail[] = failedJobs
    .map((job): StageErrorDetail => {
      const diagnostics = readFailureDiagnostics(job.runtime_metadata_json);
      return {
        ...diagnostics,
        provider: diagnostics.provider ?? job.provider ?? null,
        model: diagnostics.model ?? job.model ?? null,
        message: job.error_message?.trim() || `LLM job #${job.id} ended with status "${job.status || "failed"}".`,
        status: job.status ?? null,
        jobId: diagnostics.jobId ?? job.id ?? null,
        runId: diagnostics.runId ?? run.id,
      };
    })
    .filter((detail) => detail.message.trim());
  if (run.export_error?.trim()) {
    errorDetails.unshift({
      provider: null,
      model: null,
      message: run.export_error.trim(),
      status: run.export_status ?? null,
      jobId: null,
    });
  }
  const primaryError =
    run.export_error?.trim() ||
    failedJob?.error_message?.trim() ||
    errorDetails[0]?.message ||
    null;
  return {
    completedAt: run.updated_at ?? firstJob?.updated_at ?? run.created_at,
    distinctModels: jobs.length && jobs.every(job => job.model?.trim())
      ? new Set(jobs.map(job => job.model.trim().toLowerCase())).size : undefined,
    provider: jobs.length > 1 ? `${jobs.length} jobs` : firstJob?.provider,
    model: jobs.length > 1 ? [...new Set(jobs.map(job => job.model).filter(Boolean))].join(", ") : firstJob?.model,
    runStatus: failedJobs.length && jobs.some(job => job.status === "completed") ? "partial" : run.status,
    exportStatus: run.export_status ?? firstJob?.export_status,
    costUsd: jobCosts.length ? jobCosts.reduce((sum, cost) => sum + cost, 0) : null,
    costIncomplete: jobCosts.length < jobs.length,
    error: primaryError,
    partialNotice: jobs.some(job => classifyRunOutputJob(job) === "partial")
      ? "LLM output is partially used: available rows and values are retained; missing or unaligned values are excluded from calculations." : null,
    errorDetails,
  };
}

function summarizeThreat(
  analysis: ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis,
) {
  const errorMessage = analysis.error_message?.trim() ?? null;
  const diagnostics = readFailureDiagnostics(analysis.runtime_metadata_json);
  const evidence = analysis.report?.tables.find(table => table.key === "threat_score_evidence");
  const evidenceCoverage = evidence?.columns.includes("Disposition")
    ? `${evidence.rows.filter(row => row.Disposition === "Accepted").length}/${evidence.rows.length} rows accepted`
    : undefined;
  const paired = analysis.report?.tables.find(table => table.key === "pairwise_scores")?.rows;
  const portfolioRisk = analysis.report?.tables.find(table => table.key === "portfolio_threat_score")?.rows[0];
  const assessed = analysis.report?.tables.find(table => table.key === "stock_threat_scores")?.rows;
  const coverage = assessed ? ` · ${assessed.filter(row => row["Stock Threat /100"] !== "Unknown").length} of ${assessed.length} listings scored` : "";
  const validPairs = paired?.reduce((n, row) => n + Number(row["Valid comparisons"]), 0);
  const expectedPairs = paired?.reduce((n, row) => n + Number(row.Expected), 0);
  return {
    evidenceCoverage,
    pairStatus: expectedPairs && Number.isFinite(expectedPairs) && validPairs != null && Number.isFinite(validPairs)
      ? validPairs === expectedPairs ? "completed" as const : "partial" as const
      : undefined,
    pairCoverage: validPairs == null || expectedPairs == null ? undefined : `${validPairs / 2} / ${expectedPairs / 2} comparisons`,
    portfolioThreat: portfolioRisk ? `${portfolioRisk["Portfolio Threat /100"]} / 100 · ${portfolioRisk["Assessed value"]} of holdings value assessed${coverage}` : undefined,
    completedAt: analysis.updated_at ?? analysis.created_at,
    provider: analysis.provider,
    model: analysis.model,
    jobId: analysis.job_id ?? null,
    runStatus: analysis.status,
    exportStatus: null,
    costUsd: analysis.estimated_cost ?? null,
    error: analysis.error_message ?? null,
    errorDetails: errorMessage
      ? [
          {
            ...diagnostics,
            provider: diagnostics.provider ?? analysis.provider ?? null,
            model: diagnostics.model ?? analysis.model ?? null,
            message: errorMessage,
            status: analysis.status ?? null,
            jobId: diagnostics.jobId ?? analysis.job_id ?? null,
          },
        ]
      : [],
  };
}

function readSavedModelMixes(): SavedModelMix[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = window.localStorage.getItem(MODEL_MIX_STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed)
      ? parsed.filter(
          (mix) =>
            mix &&
            typeof mix.id === "string" &&
            typeof mix.name === "string" &&
            Array.isArray(mix.targets),
        )
      : [];
  } catch {
    return [];
  }
}

async function waitForRunCompletion(
  runId: number,
  onProgress?: (run: RunResponse) => void,
  shouldStop?: () => boolean,
) {
  while (true) {
    if (shouldStop?.()) throw new Error(`Run #${runId} was cancelled by user.`);
    const run = await retryWorkflowRead(
      () => apiService.getRun(runId),
      `run #${runId} status`,
      shouldStop,
    );
    onProgress?.(run);
    const status = (run.status || "").toLowerCase();
    if (status === "completed" || status === "partial" || status === "failed") return run;
    await sleep(POLL_INTERVAL_MS);
  }
}

function isTransientWorkflowReadError(error: unknown) {
  if (error instanceof NetworkError) return true;
  return error instanceof APIError && (error.status === 429 || error.status >= 500);
}

async function retryWorkflowRead<T>(
  read: () => Promise<T>,
  label: string,
  shouldStop?: () => boolean,
): Promise<T> {
  let consecutiveFailures = 0;
  while (true) {
    if (shouldStop?.()) throw new Error("Auto-rebalance flow was cancelled by user.");
    try {
      return await read();
    } catch (error) {
      if (!isTransientWorkflowReadError(error)) throw error;
      consecutiveFailures += 1;
      const delayMs = Math.min(15_000, 1_000 * 2 ** Math.min(consecutiveFailures, 4));
      console.warn(
        `Transient auto-rebalance read failed for ${label}; retrying in ${Math.round(delayMs / 1000)}s.`,
        error,
      );
      await sleep(delayMs);
    }
  }
}

async function waitForZerodhaPortfolioSync(
  previousCapturedAt?: string | null,
  shouldStop?: () => boolean,
  owner: WorkflowOwner | null = captureWorkflowOwner(),
): Promise<ZerodhaPortfolioOverviewResponse> {
  requireWorkflowOwner(owner);
  const ownerApi = workflowOwnedApi(apiService, owner);
  const stopped = () => !isCurrentWorkflowOwner(owner) || Boolean(shouldStop?.());
  let latestOverview = await retryWorkflowRead(
    () => ownerApi.zerodhaPortfolioOverview(),
    "Zerodha portfolio sync status",
    stopped,
  );

  for (let attempt = 0; attempt <= MAX_ZERODHA_SYNC_POLLS; attempt += 1) {
    if (stopped()) {
      throw new Error("Zerodha portfolio sync was cancelled by user.");
    }
    requireWorkflowOwner(owner);
    const latestCapturedAt = latestOverview.latest?.captured_at ?? null;
    if (latestCapturedAt && Date.parse(latestCapturedAt) > (previousCapturedAt ? Date.parse(previousCapturedAt) : 0)) {
      requireWorkflowOwner(owner);
      return latestOverview;
    }

    if (attempt === MAX_ZERODHA_SYNC_POLLS) break;
    await sleep(POLL_INTERVAL_MS);
    requireWorkflowOwner(owner);
    latestOverview = await retryWorkflowRead(
      () => ownerApi.zerodhaPortfolioOverview(),
      "Zerodha portfolio sync status",
      stopped,
    );
  }

  requireWorkflowOwner(owner);
  throw new Error("Portfolio sync timed out waiting for a new Zerodha snapshot. Check the sync status before retrying.");
}

async function waitForThreatCompletion(
  portfolio: WorkflowPortfolio,
  jobId: number,
  shouldStop?: () => boolean,
): Promise<ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis> {
  while (true) {
    if (shouldStop?.()) {
      throw new Error(`Threat job #${jobId} was cancelled by user.`);
    }
    const analysis = await retryWorkflowRead(
      () =>
        portfolio === "zerodha"
          ? apiService.zerodhaThreatJob(jobId)
          : apiService.indmoneyUsThreatJob(jobId),
      `threat job #${jobId} status`,
      shouldStop,
    );
    const status = (analysis.status || "").toLowerCase();
    if (["completed", "partial", "failed"].includes(status)) return analysis;
    await sleep(POLL_INTERVAL_MS);
  }
}

function getLatestMatchingRebalanceRuns(
  runs: RunResponse[],
  market: SwingTradeMarket,
) {
  const marketRuns = runs
    .filter((run) => isCompletedRebalanceRun(run, market))
    .sort(
      (a, b) => parseTimestampMs(b.created_at) - parseTimestampMs(a.created_at),
    );
  const latestRun = marketRuns[0];
  if (!latestRun) return [];
  const fingerprint = extractRebalanceInputFingerprint(latestRun.prompt);
  return marketRuns.filter(
    (run) => extractRebalanceInputFingerprint(run.prompt) === fingerprint,
  );
}

type BasketScoreRevision = {
  finalRows?: Map<string, FinalRow>;
  formula: ScoreMatrixFormulaConfig | null;
  differences: string[];
  divisors: string[];
  sequence: number;
  version: string | null;
  capturedAt: string | null;
  replayed: boolean;
  originals: Map<string, number>;
  saved: Map<string, {score: number; divisor?: number; jobId?: number; threatReason?: string | null; comparisons?: number | null; pairwise?: number | null}>;
};

function sameFrozenScore(saved: unknown, current: number | null) {
  if (saved === current) return true;
  if (typeof saved !== "number" || current === null || !Number.isFinite(saved) || !Number.isFinite(current)) return false;
  return Math.abs(saved - current) <= 8 * Number.EPSILON * Math.max(Math.abs(saved), Math.abs(current));
}

function canonicalBasketInputs(value: unknown): string {
  if (Array.isArray(value)) return "[" + value.map(canonicalBasketInputs).join(",") + "]";
  if (value !== null && typeof value === "object") {
    const fields = Object.entries(value).sort(([a], [b]) => a.localeCompare(b));
    return "{" + fields.map(([key, val]) => JSON.stringify(key) + ":" + canonicalBasketInputs(val)).join(",") + "}";
  }
  return JSON.stringify(value);
}

const ZERODHA_BASKET_ACTIONS = new Set<ActionCategory>([
  "Sell All",
  "Trim",
  "Add more",
  "Buy New",
]);
const ZERODHA_BASKET_SECTION_ORDER: ActionCategory[] = [
  "Sell All",
  "Trim",
  "Buy New",
  "Add more",
];
const ZERODHA_BASKET_SECTION_LABELS: Partial<Record<ActionCategory, string>> = {
  "Sell All": "Sell All",
  Trim: "Trim",
  "Buy New": "Buy New",
  "Add more": "Buy More",
  Hold: "Hold",
};
const ZERODHA_BASKET_INCREASING_SCORE_ACTIONS = new Set<ActionCategory>(["Sell All", "Trim"]);
const ZERODHA_BASKET_DECREASING_SCORE_ACTIONS = new Set<ActionCategory>(["Add more", "Buy New"]);
const ZERODHA_DEFAULT_MARKET_PROTECTION = "-1";
type ZerodhaExecutionMode = "direct_market" | "publisher_limit";

const ZERODHA_ORDER_KINDS: ZerodhaBasketOrderKind[] = [
  "Market",
  "Limit",
  "After market",
];

const KITE_BASKET_URL = "https://kite.zerodha.com/connect/basket";
function buildKiteBasketUrl(apiKey: string) {
  const url = new URL(KITE_BASKET_URL);
  url.searchParams.set("api_key", apiKey);
  return url.toString();
}
const INDIA_MARKET_TIME_ZONE = "Asia/Kolkata";
const INDIA_MARKET_OPEN_MINUTES = 9 * 60 + 15;
const INDIA_MARKET_CLOSE_MINUTES = 15 * 60 + 30;

function getIndiaMarketStatus(now = new Date()) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: INDIA_MARKET_TIME_ZONE,
    weekday: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(now);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";
  const weekday = value("weekday");
  const hour = Number(value("hour"));
  const minute = Number(value("minute"));
  const minutes = hour * 60 + minute;
  const isWeekday = !["Sat", "Sun"].includes(weekday);
  const open = isWeekday && minutes >= INDIA_MARKET_OPEN_MINUTES && minutes <= INDIA_MARKET_CLOSE_MINUTES;
  return {
    open,
    label: open
      ? "NSE/BSE regular market appears open now."
      : "NSE/BSE regular market appears closed now. Selected regular orders will be submitted as Zerodha AMO.",
  };
}

function getZerodhaBasketOrderExecution(order: ZerodhaBasketPreviewOrder, marketOpen: boolean, executionMode: ZerodhaExecutionMode = "publisher_limit") {
  const variety = order.orderKind === "After market" || !marketOpen ? "amo" as const : "regular" as const;

  return {
    orderType: executionMode === "direct_market" ? "MARKET" as const : "LIMIT" as const,
    variety,
  };
}

function getZerodhaPublisherApiKey(loginUrl: string) {
  try {
    return new URL(loginUrl).searchParams.get("api_key")?.trim() || null;
  } catch {
    return null;
  }
}

function chunkZerodhaBasketOrders(orders: ZerodhaBasketPreviewOrder[]) {
  const chunks: ZerodhaBasketPreviewOrder[][] = [];
  for (let index = 0; index < orders.length; index += ZERODHA_KITE_PUBLISHER_BATCH_SIZE) {
    chunks.push(orders.slice(index, index + ZERODHA_KITE_PUBLISHER_BATCH_SIZE));
  }
  return chunks;
}

function buildZerodhaKiteBasketPayload(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  assertWholeShareOrdersReviewed(orders);
  return orders.map((order) => {
    const execution = getZerodhaBasketOrderExecution(order, marketOpen, "publisher_limit");
    const payload: Record<string, string | number | boolean> = {
      variety: execution.variety,
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      order_type: execution.orderType,
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      product: "CNC",
      validity: "DAY",
      readonly: false,
      tag: "credx",
    };
    if (execution.orderType === "MARKET") {
      throw new Error("Publisher basket payload cannot contain MARKET orders");
    } else if (order.price) {
      payload.price = Number(order.price.toFixed(2));
    }
    return payload;
  });
}

async function prepareZerodhaBasketOrdersForKite(orders: ZerodhaBasketPreviewOrder[]) {
  const limitOrders = orders.filter(isWholeShareOrderSelectable);
  if (limitOrders.length === 0) return orders;

  const response = await apiService.zerodhaPrepareBasketOrders({
    orders: limitOrders.map((order) => ({
      tradingsymbol: order.symbol.toUpperCase(),
      exchange: order.exchange.toUpperCase(),
      transaction_type: order.side,
      quantity: Math.max(1, Math.floor(order.units ?? 0)),
      price: order.price ?? 0,
      last_price: order.lastPrice ?? undefined,
    })),
  });
  const preparedByOrderId = new Map(
    limitOrders.map((order, index) => [order.id, response.orders[index]] as const),
  );

  return orders.map((order) => {
    const prepared = preparedByOrderId.get(order.id);
    return prepared
      ? {
          ...order,
          price: prepared.price,
          lastPrice: prepared.last_price,
          amount: calculateZerodhaBasketAmount(order.units, prepared.price),
        }
      : order;
  });
}

function postZerodhaKiteBasket(apiKey: string, orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean, targetName: string) {
  const form = document.createElement("form");
  form.method = "post";
  form.action = buildKiteBasketUrl(apiKey);
  form.target = targetName;
  form.style.display = "none";

  const apiKeyInput = document.createElement("input");
  apiKeyInput.type = "hidden";
  apiKeyInput.name = "api_key";
  apiKeyInput.value = apiKey;
  form.appendChild(apiKeyInput);

  const dataInput = document.createElement("input");
  dataInput.type = "hidden";
  dataInput.name = "data";
  dataInput.value = JSON.stringify(buildZerodhaKiteBasketPayload(orders, marketOpen));
  form.appendChild(dataInput);

  document.body.appendChild(form);
  form.submit();
  form.remove();
}

function buildZerodhaKiteClipboardText(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  assertWholeShareOrdersReviewed(orders);
  const lines = [
    "Cred-X Zerodha order basket for Kite",
    "Paste/reference this in Kite while placing the orders manually:",
    "",
    "Exchange, Symbol, Side, Qty, Order Type, Variety, Product, Validity, Price, Market Protection",
  ];

  orders.forEach((order) => {
    const execution = getZerodhaBasketOrderExecution(order, marketOpen, "publisher_limit");
    const price = execution.orderType === "LIMIT" && order.price ? order.price.toFixed(2) : "";
    const marketProtection = execution.orderType === "MARKET" ? String(ZERODHA_DEFAULT_MARKET_PROTECTION) : "";
    lines.push([
      order.exchange,
      order.symbol,
      order.side,
      Math.max(1, Math.floor(order.units ?? 0)),
      execution.orderType,
      execution.variety.toUpperCase(),
      "CNC",
      "DAY",
      price,
      marketProtection,
    ].join(", "));
  });

  return lines.join("\n");
}

async function copyZerodhaKiteBasketToClipboard(orders: ZerodhaBasketPreviewOrder[], marketOpen: boolean) {
  if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) return false;
  await navigator.clipboard.writeText(buildZerodhaKiteClipboardText(orders, marketOpen));
  return true;
}

function parseBasketNumber(value?: string | null) {
  const match = String(value || "")
    .replace(/,/g, "")
    .match(/-?\d+(?:\.\d+)?/);
  if (!match) return null;
  const parsed = Number(match[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function getBasketPrice(stock: StockConsensus, amount: number | null, units: number | null, fallbackPrice: number | null = null) {
  if (amount !== null && amount > 0 && units !== null && units !== 0) return Math.abs(amount / units);
  const representativePrice = parseBasketNumber(stock.representative["Price Per Unit"]);
  if (representativePrice !== null && representativePrice > 0) return representativePrice;
  return fallbackPrice !== null && fallbackPrice > 0 ? fallbackPrice : null;
}

function calculatePercentBasketUnits(
  baseUnits: number | null,
  percent: ZerodhaBasketOrderPercent,
  allowFractionalUnits = false,
) {
  if (baseUnits === null || baseUnits <= 0) return null;
  const rawUnits = Math.abs(baseUnits) * (percent / 100);
  if (allowFractionalUnits) return rawUnits > 0 ? rawUnits : null;
  if (percent < 100 && rawUnits < 1) return null;
  return Math.max(1, Math.floor(rawUnits));
}

function getZerodhaBasketSellUnitLimit(order: ZerodhaBasketPreviewOrder) {
  const availableUnits = order.currentUnits ?? order.baseUnits;
  if (availableUnits === null || availableUnits <= 0) return null;
  return order.allowFractionalUnits ? availableUnits : Math.floor(availableUnits);
}

function getZerodhaBasketBuyUnitLimit(order: ZerodhaBasketPreviewOrder) {
  if (order.price === null || order.price <= 0) return null;
  return order.availableBalance !== null && order.availableBalance > 0
    ? Math.floor(order.availableBalance / order.price)
    : null;
}

function getZerodhaBasketUnitLimit(order: ZerodhaBasketPreviewOrder) {
  return order.side === "SELL" ? getZerodhaBasketSellUnitLimit(order) : getZerodhaBasketBuyUnitLimit(order);
}

function clampZerodhaBasketUnits(
  units: number | null,
  maxUnits: number | null,
  allowFractionalUnits = false,
) {
  if (units === null || !Number.isFinite(units)) return null;
  const normalizedUnits = allowFractionalUnits ? Math.abs(units) : Math.floor(Math.abs(units));
  if (normalizedUnits <= 0 || (!allowFractionalUnits && normalizedUnits < 1)) return null;
  if (maxUnits !== null && maxUnits <= 0) return null;
  return Math.min(normalizedUnits, maxUnits ?? normalizedUnits);
}

function calculateZerodhaBasketAmount(units: number | null, price: number | null) {
  return units !== null && price !== null ? Math.abs(units * price) : null;
}

function calculateZerodhaBasketPercent(
  side: "BUY" | "SELL",
  units: number | null,
  amount: number | null,
  totalUnits: number | null,
  availableBalance: number | null,
) {
  if (side === "SELL") {
    if (units === null || totalUnits === null || totalUnits <= 0) return 0;
    return Math.min(100, Math.max(0, (units / totalUnits) * 100));
  }
  if (amount === null || availableBalance === null || availableBalance <= 0) return 0;
  return Math.max(0, (amount / availableBalance) * 100);
}

function formatBasketPercent(value: number) {
  if (!Number.isFinite(value)) return "0%";
  const normalized = Math.max(0, value);
  return `${new Intl.NumberFormat("en-IN", {
    maximumFractionDigits: normalized > 0 && normalized < 10 ? 1 : 0,
  }).format(normalized)}%`;
}

function formatZerodhaLtpRefreshTime(value: string | null) {
  if (!value) return "";
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return "Using recently refreshed quoted LTP for the next basket";
  return `Quoted LTP refreshed ${new Intl.DateTimeFormat("en-IN", {
    timeZone: INDIA_TIMEZONE,
    hour: "numeric",
    minute: "2-digit",
    second: "2-digit",
    hour12: true,
  }).format(parsed)} IST for the next basket`;
}

function getZerodhaBasketBaseUnits(action: ActionCategory, estimate: ActionEstimate) {
  if (action === "Sell All" || action === "Trim") {
    return estimate.currentUnits !== null && estimate.currentUnits > 0
      ? estimate.currentUnits
      : estimate.units;
  }
  return estimate.units;
}

function getZerodhaBasketActionForPercent(order: ZerodhaBasketPreviewOrder) {
  if (order.wholeShareReview && order.wholeShareReview !== "exit") return "Trim";
  if (order.side === "SELL") return order.percent >= 100 ? "Sell All" : "Trim";
  return order.action;
}

function applyZerodhaBasketPercent(
  order: ZerodhaBasketPreviewOrder,
  percent: ZerodhaBasketOrderPercent,
): ZerodhaBasketPreviewOrder {
  const baseUnits = order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits;
  if (order.side === "SELL" && needsWholeShareTrimReview(baseUnits, baseUnits === null ? null : baseUnits * percent / 100, order.allowFractionalUnits)) {
    return { ...order, action: "Trim", units: null, amount: null, percent, wholeShareReview: "required" };
  }
  if (order.wholeShareReview && percent === 100) return order;
  const units = clampZerodhaBasketUnits(
    calculatePercentBasketUnits(baseUnits, percent, order.allowFractionalUnits),
    getZerodhaBasketUnitLimit(order),
    order.allowFractionalUnits,
  );
  const amount = calculateZerodhaBasketAmount(units, order.price);
  const normalizedPercent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...order,
    action: order.side === "SELL" ? (normalizedPercent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent: normalizedPercent,
    unitsTrace: { ...order.unitsTrace, manualAdjusted: false, latest: { kind: "Percentage change", previousUnits: order.units, requestedUnits: baseUnits === null ? null : Math.abs(baseUnits) * percent / 100, roundedUnits: calculatePercentBasketUnits(baseUnits, percent, order.allowFractionalUnits), cap: getZerodhaBasketUnitLimit(order), result: units, baseUnits, percent } },
  };
}

function applyZerodhaBasketUnitDelta(
  order: ZerodhaBasketPreviewOrder,
  delta: number,
): ZerodhaBasketPreviewOrder {
  if (order.wholeShareReview) return order;
  const units = clampZerodhaBasketUnits((order.units ?? 0) + delta, getZerodhaBasketUnitLimit(order), order.allowFractionalUnits);
  const amount = calculateZerodhaBasketAmount(units, order.price);
  const percent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...order,
    action: order.side === "SELL" ? (percent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent,
    unitsTrace: { ...order.unitsTrace, manualAdjusted: true, latest: { kind: "Manual Units adjustment", previousUnits: order.units, requestedUnits: (order.units ?? 0) + delta, roundedUnits: order.allowFractionalUnits ? Math.abs((order.units ?? 0) + delta) : Math.floor(Math.abs((order.units ?? 0) + delta)), cap: getZerodhaBasketUnitLimit(order), result: units } },
  };
}

function applyZerodhaBasketLivePricing(
  order: ZerodhaBasketPreviewOrder,
  price: number | null,
  lastPrice: number | null,
): ZerodhaBasketPreviewOrder {
  const pricedOrder = {
    ...order,
    price,
    lastPrice,
  };
  const units = clampZerodhaBasketUnits(order.units, getZerodhaBasketUnitLimit(pricedOrder), order.allowFractionalUnits);
  const amount = calculateZerodhaBasketAmount(units, price);
  const percent = calculateZerodhaBasketPercent(
    order.side,
    units,
    amount,
    order.side === "SELL" ? (order.currentUnits ?? order.baseUnits) : order.baseUnits,
    order.availableBalance,
  );

  return {
    ...pricedOrder,
    action: order.side === "SELL" ? (percent >= 100 ? "Sell All" : "Trim") : order.action,
    units,
    amount,
    percent,
    unitsTrace: { ...order.unitsTrace, latest: { kind: "Price refresh / quantity cap", previousUnits: order.units, requestedUnits: order.units, roundedUnits: order.units === null ? null : order.allowFractionalUnits ? Math.abs(order.units) : Math.floor(Math.abs(order.units)), cap: getZerodhaBasketUnitLimit(pricedOrder), result: units } },
  };
}

function mergePreparedZerodhaBasketOrders(
  currentOrders: ZerodhaBasketPreviewOrder[],
  preparedOrders: ZerodhaBasketPreviewOrder[],
) {
  const preparedById = new Map(preparedOrders.map((order) => [order.id, order] as const));
  return currentOrders.map((order) => {
    const prepared = preparedById.get(order.id);
    return prepared
      ? applyZerodhaBasketLivePricing(order, prepared.price, prepared.lastPrice)
      : order;
  });
}

function getZerodhaBasketScore(order: ZerodhaBasketPreviewOrder) {
  return order.detail.calculatedScore;
}

function getZerodhaBasketSelectableOrders(
  orders: ZerodhaBasketPreviewOrder[],
): ZerodhaBasketSelectableOrder[] {
  return orders.filter(isWholeShareOrderSelectable).map((order) => ({
    id: order.id,
    side: order.side,
    score: getZerodhaBasketScore(order),
    explicitSelectionRequired: order.wholeShareReview === "exit",
  }));
}

function formatZerodhaBasketScore(value: number | null) {
  return value === null ? "—" : value.toFixed(2);
}

function buildZerodhaBasketScoreWarningMessage(orders: ZerodhaBasketPreviewOrder[]) {
  const issueLines = orders.flatMap((order) => {
    const summary = getScoreMatrixValidationSummary(order.detail);
    if (!summary.finalScoreOutOfRange && summary.rangeIssues.length === 0) return [];

    return [
      `${order.exchange} ${order.symbol}: final score ${formatZerodhaBasketScore(summary.rawScore)}`,
      ...(summary.finalScoreMessage ? [`- ${summary.finalScoreMessage}`] : []),
      ...summary.rangeIssues.map((issue) => `- ${issue.parameter}: ${issue.message}`),
      "",
    ];
  });

  if (!issueLines.length) return null;

  return [
    "Warning: one or more selected Zerodha basket stocks have score inconsistencies.",
    "",
    ...issueLines,
    "Review the inconsistent inputs before placing the basket.",
  ].join("\n").trim();
}

function compareZerodhaBasketOrdersByScore(left: ZerodhaBasketPreviewOrder, right: ZerodhaBasketPreviewOrder) {
  // Editable India drafts are grouped by Action New. Their percent changes with
  // Units, so the legacy percent-derived action must not become a sort key.
  // Legacy/non-draft baskets keep their existing ordering semantics.
  const leftAction = left.draftContext ? basketActionGroup(left.draftContext.action) as ActionCategory : getZerodhaBasketActionForPercent(left);
  const rightAction = right.draftContext ? basketActionGroup(right.draftContext.action) as ActionCategory : getZerodhaBasketActionForPercent(right);
  const leftActionIndex = ZERODHA_BASKET_SECTION_ORDER.indexOf(leftAction);
  const rightActionIndex = ZERODHA_BASKET_SECTION_ORDER.indexOf(rightAction);
  const actionComparison = (leftActionIndex === -1 ? Number.MAX_SAFE_INTEGER : leftActionIndex)
    - (rightActionIndex === -1 ? Number.MAX_SAFE_INTEGER : rightActionIndex);
  if (actionComparison !== 0) return actionComparison;

  const leftScore = getZerodhaBasketScore(left);
  const rightScore = getZerodhaBasketScore(right);
  const leftMissingScore = leftScore === null || !Number.isFinite(leftScore);
  const rightMissingScore = rightScore === null || !Number.isFinite(rightScore);
  if (leftMissingScore !== rightMissingScore) return leftMissingScore ? 1 : -1;

  if (!leftMissingScore && !rightMissingScore) {
    const shouldSortIncreasing = ZERODHA_BASKET_INCREASING_SCORE_ACTIONS.has(leftAction);
    const shouldSortDecreasing = ZERODHA_BASKET_DECREASING_SCORE_ACTIONS.has(leftAction);
    const scoreComparison = shouldSortIncreasing
      ? leftScore - rightScore
      : shouldSortDecreasing
        ? rightScore - leftScore
        : 0;
    if (scoreComparison !== 0) return scoreComparison;
  }

  return left.symbol.localeCompare(right.symbol, undefined, { sensitivity: "base", numeric: true });
}

function formatBasketQuantity(value: number | null) {
  if (value === null) return "—";
  return new Intl.NumberFormat("en-IN", { maximumFractionDigits: 3 }).format(value);
}

function formatBasketCurrency(value: number | null, currency: "INR" | "USD" = "INR") {
  return formatBasketDisplayCurrency(value, currency);
}

function getZerodhaAvailableMarginToneClass(
  availableMargin: number | null,
  buyBasketAmount: number,
) {
  if (availableMargin === null) return "text-slate-500";
  if (availableMargin <= buyBasketAmount) return "text-red-700";
  if (availableMargin > buyBasketAmount * 1.1) return "text-emerald-700";
  return "text-amber-600";
}

function normalizeZerodhaBasketSymbol(value?: string | null) {
  return (value || "")
    .trim()
    .toUpperCase()
    .replace(/^(?:NSE|BSE):/, "")
    .replace(/\.(?:NS|BO|NSE|BSE)$/i, "")
    .trim();
}

function buildZerodhaHoldingExchangeMap(snapshot?: ZerodhaPortfolioSnapshotDetail | null) {
  const map = new Map<string, string>();
  snapshot?.holdings.forEach((holding) => {
    const symbol = normalizeZerodhaBasketSymbol(holding.tradingsymbol);
    const exchange = holding.exchange?.trim().toUpperCase();
    if (symbol && exchange) map.set(symbol, exchange);
  });
  return map;
}

function buildZerodhaHoldingUnitsMap(snapshot?: ZerodhaPortfolioSnapshotDetail | null) {
  const map = new Map<string, number>();
  snapshot?.holdings.forEach((holding) => {
    const symbol = normalizeZerodhaBasketSymbol(holding.tradingsymbol);
    if (symbol && holding.quantity != null && Number.isFinite(holding.quantity)) map.set(symbol, Math.max(0, holding.quantity));
  });
  return map;
}

function buildZerodhaSnapshotPriceMap(snapshot?: ZerodhaPortfolioSnapshotDetail | null) {
  const map = new Map<string, number>();
  snapshot?.holdings.forEach((holding) => {
    const symbol = normalizeZerodhaBasketSymbol(holding.tradingsymbol);
    const price = holding.last_price || holding.close_price || holding.average_price || 0;
    if (symbol && price > 0) map.set(symbol, price);
  });
  [...(snapshot?.positions.net ?? []), ...(snapshot?.positions.day ?? [])].forEach((position) => {
    const symbol = normalizeZerodhaBasketSymbol(position.tradingsymbol);
    const price = position.last_price || position.close_price || position.average_price || 0;
    if (symbol && price > 0 && !map.has(symbol)) map.set(symbol, price);
  });
  return map;
}

function getZerodhaBasketExchange(
  stock: StockConsensus,
  side: "BUY" | "SELL",
  holdingExchangeBySymbol: Map<string, string>,
) {
  const symbol = normalizeZerodhaBasketSymbol(stock.symbol);
  const holdingExchange = symbol ? holdingExchangeBySymbol.get(symbol) : null;
  if (side === "SELL" && holdingExchange) return holdingExchange;

  const rawExchange = stock.exchange || stock.representative["Exchange Symbol"]?.split(/\s+/)[0] || "NSE";
  return rawExchange.trim().toUpperCase() || "NSE";
}

function isExplicitNonBuyDecision(stock: StockConsensus) {
  return stock.rows.length > 0 && stock.rows.every(row =>
    row.cells["Action (Buy/Add/Sell All/Trim/Hold/Buy New)"]?.trim() === "Hold"
    && ["Current Units", "Units Change", "Final Units", "Units to Buy", "Total Buy Amount"].every(key => /^[-+]?0(?:\.0+)?$/.test((row.cells[key] ?? "").trim()))
  );
}

function buildZerodhaBasketPreviewOrders(
  rows: DashboardActionRow[],
  technicalScans: Record<string, TechnicalScanResult>,
  snapshot?: ZerodhaPortfolioSnapshotDetail | null,
  options: { allowFractionalSellUnits?: boolean } = {},
): ZerodhaBasketPreviewOrder[] {
  const holdingExchangeBySymbol = buildZerodhaHoldingExchangeMap(snapshot);
  const holdingUnitsBySymbol = buildZerodhaHoldingUnitsMap(snapshot);
  const snapshotPriceBySymbol = buildZerodhaSnapshotPriceMap(snapshot);
  const availableBalance = snapshot?.available_margin ?? null;
  const basketRows = rows
    // Keep explicit zero-position non-buy decisions visible in allocationUniverse,
    // without converting them into executable orders through a later formula.
    .filter(row=>row.independentEligible !== false)
    .filter(row => !isExplicitNonBuyDecision(row.stock))
    .filter((row): row is DashboardActionRow & {formulaAction: ActionCategory} => row.formulaAction !== null && ZERODHA_BASKET_ACTIONS.has(row.formulaAction))
    .filter((row) => {
      if (row.formulaAction !== "Sell All" && row.formulaAction !== "Trim") return true;
      const symbol = normalizeZerodhaBasketSymbol(row.stock.symbol);
      return (holdingUnitsBySymbol.get(symbol) ?? 0) > 0;
    });
  const eligibleSellAmount = basketRows
    .filter((row) => row.formulaAction === "Sell All" || row.formulaAction === "Trim")
    .filter((row) => row.formulaAction !== "Trim" || !needsWholeShareTrimReview(
      holdingUnitsBySymbol.get(normalizeZerodhaBasketSymbol(row.stock.symbol)) ?? null,
      (holdingUnitsBySymbol.get(normalizeZerodhaBasketSymbol(row.stock.symbol)) ?? 0) * 0.5,
      Boolean(options.allowFractionalSellUnits),
    ))
    .reduce((sum, row) => sum + Math.abs(row.formulaEstimate.amount ?? 0), 0);
  const requestedBuyAmount = basketRows
    .filter((row) => row.formulaAction === "Buy New" || row.formulaAction === "Add more")
    .reduce((sum, row) => sum + Math.abs(row.formulaEstimate.amount ?? 0), 0);
  const safetyBuffer = requestedBuyAmount > 0 ? Math.max(50, requestedBuyAmount * 0.01) : 0;
  const projectedBuyPower = availableBalance !== null && eligibleSellAmount > 0
    ? Math.max(0, availableBalance + eligibleSellAmount - safetyBuffer)
    : availableBalance;

  return basketRows
    .map((row) => {
      const { stock } = row;
      const action = row.formulaAction;
      const estimate = row.formulaEstimate;
      const side: "BUY" | "SELL" = action === "Sell All" || action === "Trim" ? "SELL" : "BUY";
      const requestedPercent: ZerodhaBasketOrderPercent = action === "Trim" ? 50 : 100;
      const normalizedSymbol = normalizeZerodhaBasketSymbol(stock.symbol) || stock.symbol;
      const currentHoldingUnits = holdingUnitsBySymbol.get(normalizedSymbol) ?? null;
      const baseUnits = side === "SELL"
        ? currentHoldingUnits
        : getZerodhaBasketBaseUnits(action, estimate);
      const snapshotPrice = snapshotPriceBySymbol.get(normalizedSymbol) ?? null;
      const price = getBasketPrice(stock, estimate.amount, estimate.units, snapshotPrice);
      const allowFractionalUnits = side === "SELL" && Boolean(options.allowFractionalSellUnits);
      const wholeShareReview = action === "Trim" && needsWholeShareTrimReview(currentHoldingUnits, currentHoldingUnits === null ? null : currentHoldingUnits * 0.5, allowFractionalUnits) ? "required" as const : undefined;
      const rawUnits = calculatePercentBasketUnits(baseUnits, requestedPercent, allowFractionalUnits);
      const sellAvailableUnits = estimate.currentUnits ?? baseUnits;
      const maxUnits = side === "SELL"
        ? (sellAvailableUnits !== null && sellAvailableUnits > 0 ? (allowFractionalUnits ? sellAvailableUnits : Math.floor(sellAvailableUnits)) : null)
        : (projectedBuyPower !== null && price !== null && price > 0 ? Math.floor(projectedBuyPower / price) : null);
      const units = wholeShareReview ? null : clampZerodhaBasketUnits(rawUnits, maxUnits, allowFractionalUnits);
      const amount = wholeShareReview ? null : calculateZerodhaBasketAmount(units, price) ?? estimate.amount;
      const percent = calculateZerodhaBasketPercent(
        side,
        units,
        amount,
        side === "SELL" ? sellAvailableUnits : baseUnits,
        availableBalance,
      );
      return {
        id: `zerodha:${row.id}`,
        exchange: getZerodhaBasketExchange(stock, side, holdingExchangeBySymbol),
        symbol: normalizedSymbol,
        action,
        side,
        units,
        baseUnits,
        currentUnits: side === "SELL" ? currentHoldingUnits : estimate.currentUnits,
        price,
        amount,
        lastPrice: snapshotPrice,
        availableBalance: side === "BUY" ? projectedBuyPower : availableBalance,
        percent,
        orderKind: "Market" as const,
        stock,
        detail: row.detail,
        technicalScan: getTechnicalScanForStock(technicalScans, stock),
        allowFractionalUnits,
        wholeShareReview,
        unitsTrace: { initial: { sourceUnits: estimate.units, baseUnits, requestedPercent, rawUnits: baseUnits === null ? null : Math.abs(baseUnits) * requestedPercent / 100, roundedUnits: rawUnits, cap: maxUnits, result: units, price }, manualAdjusted: false },
      };
    })
    .filter((order) => order.wholeShareReview || (order.units !== null && order.units > 0))
    .sort(compareZerodhaBasketOrdersByScore);
}

function targetKey(target: ProviderModelTarget) {
  return `${target.provider}::${target.model}`;
}

function getSelectionMultipliers(keys: string[]) {
  return keys.reduce<Record<string, number>>((counts, key) => {
    counts[key] = (counts[key] ?? 0) + 1;
    return counts;
  }, {});
}

function expandSelectionKeys(selectedKeys: Set<string>, multipliers: Record<string, number>) {
  return Array.from(selectedKeys).flatMap((key) =>
    Array.from({ length: Math.max(1, multipliers[key] ?? 1) }, () => key),
  );
}

function getAutoRebalancePortfolioKey(portfolio: WorkflowPortfolio): AutoRebalanceRunMetadata["auto_rebalance_portfolio"] {
  return portfolio === "zerodha" ? "india" : "indmoney_us";
}

async function reserveAutoRebalanceRunMetadata(
  portfolio: WorkflowPortfolio,
  analysisOnly = false,
): Promise<AutoRebalanceRunMetadata> {
  const reserved = await apiService.reserveAutoRebalanceRunLabel(
    getAutoRebalancePortfolioKey(portfolio),
    analysisOnly,
  );
  if (analysisOnly && (reserved.side_effect_policy?.version !== 1 || reserved.side_effect_policy.mode !== "analysis_only")) {
    throw new Error("The server did not confirm notification and export suppression. This run has not started.");
  }
  return {
    auto_rebalance_portfolio: reserved.portfolio,
    auto_rebalance_sequence: reserved.sequence,
    auto_rebalance_label: reserved.label,
  };
}

const recommendationAuditEnabled = process.env.NEXT_PUBLIC_RECOMMENDATION_AUDIT_ENABLED === "true";

function buildRunPayload({
  prompt,
  targets,
  sheetName,
  runMetadata,
  scanLabel,
  auditContext,
}: {
  prompt: string;
  targets: ProviderModelTarget[];
  sheetName?: string;
  runMetadata?: AutoRebalanceRunMetadata | null;
  scanLabel?: "Swing Scan" | "Rebalance Scan" | "Technical Scan";
  auditContext?: import("@/types/recommendationAudit").AuditRunContext;
}): RunCreate {
  const uniqueTargets = targets;

  const metadata = runMetadata
    ? {
        ...runMetadata,
        auto_rebalance_label: scanLabel
          ? `${runMetadata.auto_rebalance_label} (${scanLabel})`
          : runMetadata.auto_rebalance_label,
      }
    : {};

  return {
    prompt,
    targets: uniqueTargets,
    ...(recommendationAuditEnabled && auditContext ? { recommendation_audit: auditContext } : {}),
    allow_parallel: true,
    auto_export_enabled: Boolean(sheetName),
    export_sheet_name: sheetName,
    ...metadata,
  };
}

function getRunProgress(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  const classifications = jobs.map(classifyRunOutputJob);
  const passedLlms = classifications.filter(
    (state) => state === "completed",
  ).length;
  const partialLlms = classifications.filter((state) => state === "partial").length;
  const failedLlms = classifications.filter((state) => state === "failed").length;
  const activeLlms = jobs.filter((job) => {
    const status = (job.status || "").toLowerCase();
    return status === "pending" || status === "processing";
  }).length;
  const runStatus = (run.status || "").toLowerCase();
  const isActiveRun =
    runStatus === "pending" ||
    runStatus === "processing" ||
    activeLlms > 0;
  return {
    completedLlms: passedLlms + partialLlms + failedLlms,
    passedLlms,
    partialLlms,
    failedLlms,
    totalLlms: jobs.length,
    runStatus: isActiveRun ? run.status || "processing" : partialLlms ? "partial" : run.status,
    endedAt: isActiveRun ? null : getLatestRunTimestamp(run),
  };
}

function isUsableStageJob(job?: { status?: string; response?: string | null }) {
  const status = (job?.status || "").toLowerCase();
  return (
    status === "completed" ||
    status === "partial" ||
    Boolean(job?.response?.trim())
  );
}

function getRunJobTimestamp(
  run: RunResponse,
  job?: { updated_at?: string | null; created_at?: string | null },
) {
  return job?.updated_at ?? job?.created_at ?? getLatestRunTimestamp(run);
}

function buildRunJobCandidate(
  run: RunResponse,
  jobId: number | undefined,
  stageLabel: string,
  market: SwingTradeMarket,
): InputSelectionCandidate | null {
  const link = run.run_jobs?.find((item) => item.job?.id === jobId);
  const job = link?.job;
  if (!job || !isUsableStageJob(job)) return null;
  const costUsd =
    typeof job.estimated_cost === "number" ? job.estimated_cost : null;
  return {
    id: `run:${run.id}:job:${job.id}`,
    source: "run-job",
    label: `${stageLabel} · ${job.provider}/${job.model}`,
    jobNo: `#${run.id} / #${job.id}`,
    timestamp: getRunJobTimestamp(run, job),
    status: job.status || run.status,
    costUsd,
    error: job.error_message ?? null,
    run,
    jobId: job.id,
    content: job.response,
    market,
  };
}

function buildRunJobCandidates(runs: RunResponse[], stageLabel: string, market: SwingTradeMarket) {
  return runs.flatMap(
    (run) =>
      (run.run_jobs ?? [])
        .map((link) => buildRunJobCandidate(run, link.job?.id, stageLabel, market))
        .filter(Boolean) as InputSelectionCandidate[],
  );
}

function buildNextCandidate(
  stage: InputSelectionStage,
  market: SwingTradeMarket,
): InputSelectionCandidate {
  const labelByStage: Record<InputSelectionStage, string> = {
    threats: "Upcoming portfolio snapshot",
    swing: "Market and swing scan prompt",
    rebalance: "Upcoming Swing Scan output",
    technical: "Upcoming Rebalance Scan output",
    actionables: "Upcoming Technical Scan output",
  };
  return {
    id: `${stage}:next`,
    source: "next",
    label: labelByStage[stage],
    jobNo: "Upcoming run",
    timestamp: null,
    status: "reserved",
    costUsd: null,
    error: null,
    market,
  };
}

function getInputMarketLabel(market?: SwingTradeMarket) {
  if (market === "india") return "India";
  if (market === "us") return "US";
  return "Market unknown";
}

function getInputMarketBadgeClass(market?: SwingTradeMarket) {
  if (market === "india") return "border-orange-200 bg-orange-50 text-orange-800";
  if (market === "us") return "border-indigo-200 bg-indigo-50 text-indigo-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function getStagePromptPreview(portfolio: WorkflowPortfolio, stage: PromptPreviewStage, swingPrompt: string) {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  const portfolioName = portfolio === "zerodha" ? "Zerodha" : "INDmoney US";
  if (stage === "threats") {
    const marker = portfolio === "zerodha" ? "[ZERODHA_THREATS]" : "[INDMONEY_US_THREATS]";
    return `${marker}
[ENABLE_WEB_SEARCH]
[THREAT_METADATA_DO_NOT_REPEAT]

${portfolioName} Threat Scan Flow

This dashboard queues the server-side ${portfolioName} threat prompt through the threat-scan worker endpoint. The runtime prompt includes the latest selected portfolio snapshot, web-search markers, and the normalized threat analysis instructions stored with the backend threat flow.`;
  }
  if (stage === "swing") {
    return swingPrompt;
  }
  if (stage === "rebalance") {
    return `${ensureRebalanceFlowMarker(buildRebalancePrompt(market), market)}

---

## Rebalance Input Bundle
Runtime inputs are appended here from the Select Inputs popup: latest portfolio snapshot, latest Threat Scan output, and all explicitly selected Swing Scan outputs. Selections may be historical. Capture times do not prove price freshness; the weekday close estimate does not validate exchange holidays or early closes.`;
  }
  return buildTechnicalScanPrompt([], market);
}

function withInrCost(info: Partial<StageInfo>, usdInrRate: number) {
  if (
    typeof info.costUsd !== "number" ||
    info.costUsd <= 0 ||
    !isVerifiedFxRate(usdInrRate)
  ) {
    return info;
  }
  return {
    ...info,
    costInr: info.costInr && info.costInr > 0 ? info.costInr : info.costUsd * usdInrRate,
  };
}

function getLatestRunTimestamp(run: RunResponse) {
  const timestamps = [
    run.updated_at,
    run.exported_at,
    run.created_at,
    ...((run.run_jobs ?? []).flatMap((link) => [
      link.job?.updated_at,
      link.job?.created_at,
    ])),
  ]
    .map(parseTimestampMs)
    .filter(Boolean);
  if (timestamps.length === 0) return run.updated_at ?? run.exported_at ?? run.created_at ?? null;
  return new Date(Math.max(...timestamps)).toISOString();
}

function sortRunsByLatestTimestamp(runs: RunResponse[]) {
  return [...runs].sort(
    (a, b) =>
      parseTimestampMs(getLatestRunTimestamp(b)) -
      parseTimestampMs(getLatestRunTimestamp(a)),
  );
}

function isTechnicalScanRun(run: RunResponse, market: SwingTradeMarket) {
  return isAnalysisRunForStage(run, "technical", market);
}

function isCompletedTechnicalScanRun(
  run: RunResponse,
  market: SwingTradeMarket,
) {
  if (!isTechnicalScanRun(run, market)) return false;
  const hasUsableJob = (run.run_jobs ?? []).some((link) => {
    const job = link.job;
    return isUsableStageJob(job) && Boolean(job?.response?.trim());
  });
  return isUsableStageJob(run) || hasUsableJob;
}

function isRebalanceRunForMarket(run: RunResponse, market: SwingTradeMarket) {
  return isAnalysisRunForStage(run, "rebalance", market);
}

function getLatestStageRun(
  runs: RunResponse[],
  stage: Extract<WorkflowStageKey, "swing" | "rebalance" | "technical">,
  market: SwingTradeMarket,
) {
  const matchingRuns = runs.filter((run) => {
    if (stage === "swing") return isAnalysisRunForStage(run, "swing", market);
    if (stage === "rebalance") return isRebalanceRunForMarket(run, market);
    return isTechnicalScanRun(run, market);
  });
  return sortRunsByLatestTimestamp(matchingRuns)[0];
}

function listingsFromSwingRun(run: RunResponse) {
  const listings = new Set<string>();
  for (const { job } of run.run_jobs ?? []) {
    if (job?.status !== "completed") continue;
    let symbolIndex = -1, exchangeIndex = -1;
    for (const line of (job.response ?? "").split("\n")) {
      if (!line.trim().startsWith("|")) { symbolIndex = -1; continue; }
      const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map(cell => cell.trim());
      const header = cells.findIndex(cell => /^(stock symbol|ticker symbol)$/i.test(cell));
      if (header >= 0) {
        symbolIndex = header;
        exchangeIndex = cells.findIndex(cell => /^(exchange|exchange symbol)$/i.test(cell));
        continue;
      }
      const symbol = cells[symbolIndex];
      if (symbolIndex < 0 || !symbol || /^[-:]+$/.test(symbol)) continue;
      listings.add(`${cells[exchangeIndex] ?? ""}:${symbol}`.toUpperCase());
    }
  }
  return [...listings];
}

function countUniqueStocksFromRun(run: RunResponse) {
  return listingsFromSwingRun(run).length || null;
}

function summarizeRunForIdleTile(
  run: RunResponse | undefined,
  usdInrRate: number,
  recommendedStocks?: number | null,
): Partial<StageInfo> {
  if (!run) return {};
  const progress = getRunProgress(run);
  const progressStatus = (progress.runStatus || "").toLowerCase();
  const isActiveRun =
    progressStatus === "pending" || progressStatus === "processing";
  return withInrCost(
    {
      ...summarizeRun(run),
      ...progress,
      startedAt: run.created_at,
      completedAt: isActiveRun ? null : getLatestRunTimestamp(run),
      lastRunId: run.id,
      workflowSequence: run.auto_rebalance_sequence ?? null,
      evidence: { kind: "saved", references: [`Run #${run.id} · ${run.status} · ${getLatestRunTimestamp(run) ?? run.created_at}`] },
      recommendedStocks: recommendedStocks ?? null,
    },
    usdInrRate,
  );
}

function getAutoRebalanceSummaryNumber(
  summary: Record<string, unknown>,
  key: string,
) {
  const value = summary[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function summarizeAutoRebalanceHistoryStage(
  history: AutoRebalanceHistoryItemResponse | null,
  stage: WorkflowStageKey,
  usdInrRate: number,
): Partial<StageInfo> {
  const item = history?.stages.find((entry) => entry.stage === stage);
  if (!item) return {};
  const summary = item.summary ?? {};
  const completedLlms =
    getAutoRebalanceSummaryNumber(summary, "completed_llms") ??
    item.completed_provider_count ??
    null;
  const failedLlms =
    getAutoRebalanceSummaryNumber(summary, "failed_llms") ??
    item.failed_provider_count ??
    null;
  const totalLlms =
    getAutoRebalanceSummaryNumber(summary, "total_llms") ??
    item.provider_count ??
    null;
  const costUsd =
    item.estimated_cost > 0 ? item.estimated_cost : getAutoRebalanceSummaryNumber(summary, "cost_usd");
  return withInrCost(
    {
      startedAt: item.started_at ?? history?.created_at ?? null,
      endedAt:
        item.completed_at ??
        history?.completed_at ??
        history?.updated_at ??
        null,
      completedAt:
        item.completed_at ??
        history?.completed_at ??
        history?.updated_at ??
        null,
      runStatus:
        (typeof summary.run_status === "string" && summary.run_status.trim()
          ? summary.run_status
          : item.status) ?? null,
      provider:
        typeof summary.provider === "string" ? summary.provider : null,
      model: typeof summary.model === "string" ? summary.model : null,
      costUsd,
      costIncomplete: summary.cost_incomplete === true,
      costInr: getAutoRebalanceSummaryNumber(summary, "cost_inr"),
      error: item.error_message ?? null,
      lastRunId: item.run_id ?? null,
      workflowSequence: history?.sequence ?? null,
      jobId: item.job_id ?? null,
      evidence: { kind: "saved", references: [
        `${history?.portfolio} workflow #${history?.sequence} · ${stage} · ${item.status} · ${item.completed_at ?? item.started_at ?? "stage time unavailable"}`,
        ...(item.run_id ? [`Run #${item.run_id}`] : []),
        ...(item.job_id ? [`Job #${item.job_id}`] : []),
      ] },
      evidenceCoverage: typeof summary.evidence_coverage === "string" ? summary.evidence_coverage : undefined,
      distinctModels: getAutoRebalanceSummaryNumber(summary, "distinct_models") ?? undefined,
      completedLlms,
      passedLlms: getAutoRebalanceSummaryNumber(summary, "passed_llms") ?? Math.max(0, (item.completed_provider_count ?? 0) - (item.partial_provider_count ?? 0)),
      partialLlms: getAutoRebalanceSummaryNumber(summary, "partial_llms") ?? item.partial_provider_count ?? 0,
      partialNotice: typeof summary.partial_notice === "string" ? summary.partial_notice : null,
      failedLlms,
      totalLlms,
      recommendedStocks: getAutoRebalanceSummaryNumber(
        summary,
        "recommended_stocks",
      ),
      commonStocks: getAutoRebalanceSummaryNumber(summary, "common_stocks"),
      rebalanceInputs: getAutoRebalanceSummaryNumber(
        summary,
        "rebalance_inputs",
      ),
    },
    usdInrRate,
  );
}

function getLatestAutoRebalanceHistoryItem(
  items: AutoRebalanceHistoryItemResponse[] | undefined,
  stage?: WorkflowStageKey,
) {
  const recordedStageTime = (invocation: AutoRebalanceHistoryItemResponse) => {
    const entry = stage ? invocation.stages.find((item) => item.stage === stage) : undefined;
    return parseTimestampMs(entry?.completed_at ?? entry?.started_at ?? invocation.completed_at ?? invocation.updated_at ?? invocation.created_at);
  };
  return [...(items ?? [])]
    .filter(
      (item) =>
        !stage || item.stages.some((stageItem) => stageItem.stage === stage),
    )
    .sort((a, b) => recordedStageTime(b) - recordedStageTime(a) || b.sequence - a.sequence)[0] ?? null;
}

function getStageCostInr(info: StageInfo, usdInrRate: number) {
  if (typeof info.costInr === "number" && info.costInr > 0) return info.costInr;
  if (
    typeof info.costUsd === "number" &&
    info.costUsd > 0 &&
    isVerifiedFxRate(usdInrRate)
  )
    return info.costUsd * usdInrRate;
  return 0;
}

function getWorkflowRunCost(state: WorkflowState, sequence: number | null, fx: number) {
  const stages = COST_BEARING_STAGES.map(stage => state[stage]).filter(info =>
    info.workflowSequence === sequence && (knownCost(info.costUsd) || knownCost(info.costInr) ||
      info.state === "running" || info.state === "failed" || (info.totalLlms ?? 0) > 0));
  return sumRebalanceCosts(stages, fx);
}

function getWorkflowRunDuration(state: WorkflowState, now = Date.now()) {
  const starts = COST_BEARING_STAGES.map((stage) =>
    parseTimestampMs(state[stage].startedAt),
  ).filter(Boolean);
  const ends = COST_BEARING_STAGES.map((stage) =>
    parseTimestampMs(state[stage].endedAt ?? state[stage].completedAt),
  ).filter(Boolean);
  if (!starts.length) return null;
  return formatDuration(
    new Date(Math.min(...starts)).toISOString(),
    ends.length ? new Date(Math.max(...ends)).toISOString() : null,
    now,
  );
}

function getRunDuration(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  const startMs = Math.min(
    ...[
      parseTimestampMs(run.created_at),
      ...jobs.map((job) => parseTimestampMs(job.created_at)),
    ].filter(Boolean),
  );
  const endMs = Math.max(
    ...[
      parseTimestampMs(run.updated_at),
      ...jobs.map((job) => parseTimestampMs(job.updated_at)),
    ].filter(Boolean),
  );
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return formatDuration(
    new Date(startMs).toISOString(),
    new Date(endMs).toISOString(),
  );
}

function getRunOutputDisplayLabel(run: RunResponse) {
  return getAutoRebalanceRunDisplayLabel(run);
}

function getRunOutputSummary(run: RunResponse, usdInrRate: number) {
  const runLabel = getRunOutputDisplayLabel(run);
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const classifications = jobs.map(classifyRunOutputJob);
  const completed = classifications.filter((state) => state === "completed").length;
  const partial = classifications.filter((state) => state === "partial").length;
  const failed = classifications.filter((state) => state === "failed").length;
  const totalCost = sumRebalanceCosts(jobs.map(job => ({ costUsd: job.estimated_cost })), usdInrRate);
  const duration = getRunDuration(run);
  return [
    `${runLabel} · ${formatTimestamp(run.created_at)} · LLMs used: ${jobs.length}`,
    `Completed: ${completed} · Partial: ${partial} · Failed: ${failed}`,
    duration ? `Time taken: ${duration}` : null,
    `Cost incurred: ${formatRebalanceCost(totalCost)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

function formatInrCostFromUsd(value: number | null | undefined, usdInrRate: number) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) {
    return "Cost n/a";
  }
  return formatRebalanceCost({ costUsd: value }, usdInrRate);
}

function getJobDuration(job?: JobResponse | null) {
  return formatDuration(job?.created_at, job?.updated_at);
}

function getRunJobDisplayModels(jobs: JobResponse[]) {
  const totals = new Map<string, number>();
  jobs.forEach((job) => {
    const key = `${job.provider ?? "Unknown"}::${job.model ?? "Unknown"}`;
    totals.set(key, (totals.get(key) ?? 0) + 1);
  });
  const seen = new Map<string, number>();
  return jobs.map((job) => {
    const model = job.model ?? "Unknown";
    const key = `${job.provider ?? "Unknown"}::${model}`;
    const ordinal = (seen.get(key) ?? 0) + 1;
    seen.set(key, ordinal);
    return (totals.get(key) ?? 0) > 1 ? `${model} ${ordinal}` : model;
  });
}

function getRunLlmLabel(run: RunResponse) {
  const jobs = run.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
  if (jobs.length === 0) return { provider: "Unknown", model: "No LLM jobs" };
  if (jobs.length === 1) {
    return { provider: jobs[0]?.provider ?? "Unknown", model: jobs[0]?.model ?? "Unknown" };
  }
  return { provider: `${jobs.length} LLMs`, model: "Model mix" };
}

function getAutoRebalanceStageForRun(
  run: RunResponse,
  portfolio: WorkflowPortfolio,
): AutoRebalanceCostBreakdownItem["stage"] | null {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  if (isCompletedRebalanceRun(run, market)) return "rebalance";
  if (isCompletedTechnicalScanRun(run, market)) return "technical";
  if (isAnalysisRunForStage(run, "swing", market)) return "swing";
  return null;
}

function buildThreatCostBreakdownItem(
  item: PortfolioAnalysisHistoryItem,
): AutoRebalanceCostBreakdownItem {
  return {
    id: `threat:${item.job_id}`,
    stage: "threats",
    sourceType: "job",
    jobId: item.job_id,
    runId: item.run_id ?? null,
    timestamp: item.updated_at ?? item.created_at ?? null,
    provider: item.provider,
    model: item.model,
    status: item.status,
    costUsd: typeof item.estimated_cost === "number" ? item.estimated_cost : null,
    llmCount: 1,
    autoRebalancePortfolio: item.auto_rebalance_portfolio ?? null,
    autoRebalanceSequence: item.auto_rebalance_sequence ?? null,
    autoRebalanceLabel: item.auto_rebalance_label ?? null,
  };
}

function buildRunCostBreakdownItems(
  run: RunResponse,
  portfolio: WorkflowPortfolio,
): AutoRebalanceCostBreakdownItem[] {
  const stage = getAutoRebalanceStageForRun(run, portfolio);
  if (!stage) return [];
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  if (jobs.length === 0) {
    const { provider, model } = getRunLlmLabel(run);
    return [{
      id: `run:${run.id}:${stage}`,
      stage,
      sourceType: "run",
      runId: run.id,
      timestamp: getLatestRunTimestamp(run),
      runPrompt: run.prompt,
      provider,
      model,
      status: run.status,
      costUsd: null,
      llmCount: 0,
      autoRebalancePortfolio: run.auto_rebalance_portfolio ?? null,
      autoRebalanceSequence: run.auto_rebalance_sequence ?? null,
      autoRebalanceLabel: run.auto_rebalance_label ?? null,
    }];
  }
  return jobs.map((job) => ({
    id: `run:${run.id}:job:${job.id}:${stage}`,
    stage,
    sourceType: "run",
    runId: run.id,
    jobId: job.id,
    timestamp: job.updated_at ?? job.created_at ?? getLatestRunTimestamp(run),
    runPrompt: run.prompt,
    provider: job.provider,
    model: job.model,
    status: job.status || run.status,
    costUsd: typeof job.estimated_cost === "number" ? job.estimated_cost : null,
    llmCount: 1,
    autoRebalancePortfolio: run.auto_rebalance_portfolio ?? job.auto_rebalance_portfolio ?? null,
    autoRebalanceSequence: run.auto_rebalance_sequence ?? job.auto_rebalance_sequence ?? null,
    autoRebalanceLabel: run.auto_rebalance_label ?? job.auto_rebalance_label ?? null,
  }));
}

function buildAutoRebalanceScanGroups(
  runs: RunResponse[],
  threatHistory: PortfolioAnalysisHistoryItem[],
  portfolio: WorkflowPortfolio,
): AutoRebalanceScanGroup[] {
  const maxGapMs = 90 * 60 * 1000;
  const items = [
    ...threatHistory.map(buildThreatCostBreakdownItem),
    ...runs.flatMap((run) => buildRunCostBreakdownItems(run, portfolio)),
  ]
    .filter((item) => parseTimestampMs(item.timestamp) > 0)
    .sort((a, b) => parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp));

  const groups: AutoRebalanceCostBreakdownItem[][] = [];
  items.forEach((item) => {
    const lastGroup = groups[groups.length - 1];
    const lastItem = lastGroup?.[lastGroup.length - 1];
    const hasReservedRunBoundary = Boolean(
      item.autoRebalanceSequence &&
      lastItem?.autoRebalanceSequence &&
      item.autoRebalancePortfolio &&
      lastItem.autoRebalancePortfolio,
    );
    const sameReservedRun = Boolean(
      hasReservedRunBoundary &&
      item.autoRebalancePortfolio === lastItem?.autoRebalancePortfolio &&
      item.autoRebalanceSequence === lastItem?.autoRebalanceSequence,
    );
    const differentReservedRun = Boolean(hasReservedRunBoundary && !sameReservedRun);
    const shouldStartNewGroup =
      !lastGroup ||
      !lastItem ||
      differentReservedRun ||
      (!sameReservedRun &&
        parseTimestampMs(item.timestamp) - parseTimestampMs(lastItem.timestamp) > maxGapMs);
    if (shouldStartNewGroup) {
      groups.push([item]);
      return;
    }
    lastGroup.push(item);
  });

  const chronologicalGroups = groups.map((group, index) => {
    const sortedItems = [...group].sort(
      (a, b) => parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp),
    );
    const explicitSequence = sortedItems.find((item) => item.autoRebalanceSequence)?.autoRebalanceSequence ?? null;
    return {
      chronologicalSequence: index + 1,
      explicitSequence,
      sortedItems,
    };
  });
  const explicitSequenceCounts = chronologicalGroups.reduce<Record<number, number>>((counts, group) => {
    if (typeof group.explicitSequence === "number" && group.explicitSequence > 0) {
      counts[group.explicitSequence] = (counts[group.explicitSequence] ?? 0) + 1;
    }
    return counts;
  }, {});

  return chronologicalGroups
    .map((group) => {
      const { chronologicalSequence, explicitSequence, sortedItems } = group;
      const latestTimestamp = new Date(
        Math.max(...sortedItems.map((item) => parseTimestampMs(item.timestamp))),
      ).toISOString();
      const stageRank: Record<AutoRebalanceCostBreakdownItem["stage"], number> = {
        pairwise: 5,
        threats: 1,
        swing: 2,
        rebalance: 3,
        technical: 4,
      };
      const idParts = sortedItems.map((item) => item.id).join("|");
      let sequence = chronologicalSequence;
      let canUseExplicitLabel = false;
      if (
        typeof explicitSequence === "number" &&
        explicitSequence > 0 &&
        explicitSequenceCounts[explicitSequence] === 1
      ) {
        sequence = explicitSequence;
        canUseExplicitLabel = true;
      }
      const fallbackLabel = portfolio === "zerodha" ? `India Run #${sequence}` : `IndMoney US Run #${sequence}`;
      const explicitLabel = sortedItems.find((item) => item.autoRebalanceLabel)?.autoRebalanceLabel ?? null;
      const label = canUseExplicitLabel && explicitLabel ? explicitLabel : fallbackLabel;
      return {
        id: `${portfolio}:${sequence}:${idParts}`,
        portfolio,
        timestamp: latestTimestamp,
        totalCostUsd: sortedItems.reduce(
          (total, item) => total + (item.costUsd ?? 0),
          0,
        ),
        label,
        sequence,
        items: sortedItems.sort((a, b) => {
          const rankDelta = stageRank[a.stage] - stageRank[b.stage];
          return rankDelta || parseTimestampMs(a.timestamp) - parseTimestampMs(b.timestamp);
        }),
      };
    })
    .sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
}

function formatAutoRebalanceStageLabel(
  stage: AutoRebalanceCostBreakdownItem["stage"],
) {
  return getStageTileLabel(stage);
}

function getAutoRebalanceItemRunHref(item: AutoRebalanceCostBreakdownItem) {
  if (item.runId) return getRunDetailPathFromPrompt(item.runId, item.runPrompt);
  if (item.jobId) return URLs.routes.console.jobDetail(item.jobId);
  return null;
}

function getAutoRebalanceItemLlmHref(item: AutoRebalanceCostBreakdownItem) {
  const runHref = getAutoRebalanceItemRunHref(item);
  if (!runHref) return null;
  if (item.runId && item.jobId) return `${runHref}#llm-output-job-${item.jobId}`;
  return runHref;
}

function getAutoRebalanceItemJobNumber(item: AutoRebalanceCostBreakdownItem) {
  if (item.jobId) return `Job #${item.jobId}`;
  if (item.runId) return `Run #${item.runId}`;
  return "—";
}

function groupAutoRebalanceItemsByStage(items: AutoRebalanceCostBreakdownItem[]) {
  const stageOrder: AutoRebalanceCostBreakdownItem["stage"][] = [
    "threats",
    "swing",
    "rebalance",
    "technical",
  ];
  return stageOrder
    .map((stage) => ({
      stage,
      items: items.filter((item) => item.stage === stage),
    }))
    .filter((section) => section.items.length > 0);
}

function AutoRebalanceCostLink({
  href,
  children,
  className,
}: {
  href: string | null;
  children: ReactNode;
  className?: string;
}) {
  if (!href) return <span className={className}>{children}</span>;
  return (
    <Link href={href} className={cn("hover:text-blue-700 hover:underline", className)}>
      {children}
    </Link>
  );
}

function isRunForStageHistory(
  run: RunResponse,
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
) {
  const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
  if (isCard(stage) || stage === "swing") return isAnalysisRunForStage(run, stage, market);
  return false;
}

function buildStageLlmHistoryEntries(
  runs: RunResponse[],
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
): StageLlmHistoryEntry[] {
  return runs
    .filter((run) => isRunForStageHistory(run, stage, portfolio))
    .flatMap((run) =>
      (run.run_jobs ?? []).flatMap((link) => {
        const job = link.job;
        if (!job) return [];
        return [{
          id: `${run.id}:${job.id}`,
          runId: run.id,
          jobId: job.id,
          timestamp: job.updated_at ?? job.created_at ?? run.updated_at ?? run.created_at ?? null,
          provider: job.provider,
          model: job.model,
          runtime: getJobDuration(job),
          costUsd: typeof job.estimated_cost === "number" ? job.estimated_cost : null,
          status: classifyRunOutputJob(job),
          rawStatus: job.status || run.status || "unknown",
        }];
      }),
    )
    .sort((a, b) => parseTimestampMs(b.timestamp) - parseTimestampMs(a.timestamp));
}

function hasKnownUsdCost(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function toHistoricalLlmCostKey(
  provider: string | null | undefined,
  model: string | null | undefined,
) {
  return provider && model ? `${provider}::${model}` : null;
}

function toRoundedInrCost(usdCost: number, usdInrRate: number) {
  return Math.round(usdCost * usdInrRate * 100) / 100;
}

function buildRunHistoricalCostMapInr(
  runs: RunResponse[],
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
  usdInrRate: number,
): HistoricalLlmCostMapInr {
  const costs: HistoricalLlmCostMapInr = {};
  if (!isVerifiedFxRate(usdInrRate)) return costs;
  buildStageLlmHistoryEntries(runs, stage, portfolio).forEach((entry) => {
    const key = toHistoricalLlmCostKey(entry.provider, entry.model);
    if (!key || costs[key] !== undefined) return;
    // The Auto-rebalance history popup reports actual incurred cost for any
    // job that reached the backend and recorded spend, including partial runs.
    // Use the same source for Select LLM indicatory costs so the selector
    // mirrors the latest incurred amount instead of falling back to stale
    // provider estimates for non-completed-but-charged jobs.
    if (!hasKnownUsdCost(entry.costUsd)) return;
    costs[key] = toRoundedInrCost(entry.costUsd, usdInrRate);
  });
  return costs;
}

function buildThreatHistoricalCostMapInr(
  history: PortfolioAnalysisHistoryItem[],
  usdInrRate: number,
): HistoricalLlmCostMapInr {
  const costs: HistoricalLlmCostMapInr = {};
  if (!isVerifiedFxRate(usdInrRate)) return costs;
  history
    .slice()
    .sort(
      (a, b) =>
        parseTimestampMs(b.updated_at ?? b.created_at) -
        parseTimestampMs(a.updated_at ?? a.created_at),
    )
    .forEach((item) => {
      const key = toHistoricalLlmCostKey(item.provider, item.model);
      if (!key || costs[key] !== undefined) return;
      if (!hasKnownUsdCost(item.estimated_cost)) return;
      costs[key] = toRoundedInrCost(item.estimated_cost, usdInrRate);
    });
  return costs;
}

async function loadStageHistoricalCostMapInr(
  stage: WorkflowStageKey,
  portfolio: WorkflowPortfolio,
  usdInrRate: number,
): Promise<HistoricalLlmCostMapInr> {
  if (!isVerifiedFxRate(usdInrRate)) return {};
  if (stage === "sync" || stage === "actionables") return {};
  if (stage === "threats") {
    const response = portfolio === "zerodha"
      ? await apiService.zerodhaThreatsHistory({ limit: 200 })
      : await apiService.indmoneyUsThreatsHistory({ limit: 200 });
    return buildThreatHistoricalCostMapInr(response.history ?? [], usdInrRate);
  }

  const runs = await fetchAllFullRuns();
  return buildRunHistoricalCostMapInr(runs, stage, portfolio, usdInrRate);
}

function getRunOutputStatusClass(status: RunOutputJobStatus) {
  if (status === "completed") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (status === "partial") return "border-sky-200 bg-sky-50 text-sky-700";
  if (status === "failed") return "border-red-200 bg-red-50 text-red-700";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function getRunOutputStatusLabel(status: RunOutputJobStatus) {
  if (status === "completed") return "Completed";
  if (status === "partial") return "Partial";
  if (status === "failed") return "Failed";
  return "Other";
}

function RunOutputDetails({ run, pairwise = false }: { run: RunResponse; pairwise?: boolean }) {
  const { rate: usdInrRate } = useRebalanceCostQuote();
  const [highlightedJobId, setHighlightedJobId] = useState<number | null>(null);
  const jobs = run.run_jobs?.map((link) => link.job).filter((job): job is JobResponse => Boolean(job)) ?? [];
  const classifications = jobs.map(classifyRunOutputJob);
  const completed = classifications.filter((state) => state === "completed").length;
  const partial = classifications.filter((state) => state === "partial").length;
  const failed = classifications.filter((state) => state === "failed").length;
  const duration = getRunDuration(run);
  const totalCost = sumRebalanceCosts(jobs.map(job => ({ costUsd: job.estimated_cost })), usdInrRate);
  const runLabel = getRunOutputDisplayLabel(run);
  const displayModels = getRunJobDisplayModels(jobs);

  const scrollToJob = (jobId: number) => {
    setHighlightedJobId(jobId);
    window.setTimeout(() => setHighlightedJobId((current) => (current === jobId ? null : current)), 1000);
    document.getElementById(`run-output-job-${jobId}`)?.scrollIntoView({
      behavior: "smooth",
      block: "start",
    });
  };

  return (
    <div className="max-w-full space-y-4 overflow-x-hidden bg-white p-5 text-slate-900">
      <section className="rounded-3xl border border-slate-200 bg-white p-5 shadow-sm">
        <div className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.22em] text-slate-400">
              Last Run Summary
            </p>
            <h4 className="mt-2 text-lg font-extrabold text-slate-950">
              {runLabel} · {formatTimestamp(run.created_at)}
              <span className="block text-sm font-semibold text-slate-600 sm:ml-2 sm:inline">
                LLMs used: {jobs.length}{duration ? ` · Time taken: ${duration}` : ""}
              </span>
            </h4>
          </div>
          <div className="grid grid-cols-3 gap-2 text-center text-xs font-bold uppercase tracking-[0.14em]">
            <div className="rounded-2xl border border-emerald-200 bg-emerald-50 px-5 py-3 text-emerald-700">
              <span className="block text-xl">{completed}</span>Completed
            </div>
            <div className="rounded-2xl border border-sky-200 bg-sky-50 px-5 py-3 text-sky-700">
              <span className="block text-xl">{partial}</span>Partial
            </div>
            <div className="rounded-2xl border border-red-200 bg-red-50 px-5 py-3 text-red-700">
              <span className="block text-xl">{failed}</span>Failed
            </div>
          </div>
        </div>
        <p className="mt-2 text-sm font-semibold text-slate-600">Cumulative cost: {formatRebalanceCost(totalCost)}</p>
        <div className="mt-4 overflow-hidden rounded-2xl border border-slate-200 bg-white">
          <div className="overflow-x-auto">
            <table className="min-w-full text-left text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-[0.14em] text-slate-500">
                <tr>
                  <th className="px-4 py-3 font-bold">Provider</th>
                  <th className="px-4 py-3 font-bold">Model</th>
                  <th className="px-4 py-3 font-bold">Status</th>
                  <th className="px-4 py-3 font-bold">Runtime</th>
                  <th className="px-4 py-3 font-bold">Cost</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {jobs.map((job, index) => {
                  const state = classifyRunOutputJob(job);
                  const jobDuration = getJobDuration(job);
                  return (
                    <tr
                      key={`summary-job-${job.id}`}
                      role="button"
                      tabIndex={0}
                      onClick={() => scrollToJob(job.id)}
                      onKeyDown={(event) => {
                        if (event.key === "Enter" || event.key === " ") scrollToJob(job.id);
                      }}
                      className="cursor-pointer bg-white transition hover:bg-slate-50"
                      title={`Jump to ${job.provider}/${job.model}`}
                    >
                      <td className="px-4 py-3 font-bold capitalize text-slate-900">{job.provider}</td>
                      <td className="px-4 py-3 font-semibold text-slate-700">{displayModels[index]}</td>
                      <td className="px-4 py-3">
                        <span className={`rounded-full border px-2.5 py-1 text-xs font-bold ${getRunOutputStatusClass(state)}`}>
                          {getRunOutputStatusLabel(state)}
                        </span>
                      </td>
                      <td className="px-4 py-3 font-mono text-xs text-slate-600">{jobDuration ?? "n/a"}</td>
                      <td className="px-4 py-3 font-bold text-slate-700">{formatInrCostFromUsd(job.estimated_cost, usdInrRate)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
        <p className="mt-4 text-xs text-slate-500">
          Partially usable LLM outputs are counted separately. Missing or unaligned values are excluded from calculations.
        </p>
      </section>

      {jobs.map((job, index) => {
        const state = classifyRunOutputJob(job);
        const isHighlighted = highlightedJobId === job.id;
        return (
          <section
            key={`details-job-${job.id}`}
            id={`run-output-job-${job.id}`}
            className={`scroll-mt-6 overflow-hidden rounded-2xl border bg-white transition duration-300 ${
              isHighlighted
                ? "border-blue-400 ring-4 ring-blue-200"
                : "border-slate-200"
            }`}
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-slate-200 px-5 py-4">
              <div>
                <h4 className="font-bold text-slate-950">
                  <span className="capitalize">{job.provider}</span>
                  <span className="ml-3 text-sm font-medium text-slate-500">{displayModels[index]}</span>
                  <span className="ml-3 text-sm font-medium text-slate-500">Job #{job.id}</span>
                </h4>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs font-semibold">
                <span>Run timer: {getJobDuration(job) ?? "n/a"}</span>
                <span>Cost: {formatInrCostFromUsd(job.estimated_cost, usdInrRate)}</span>
                <span className={`rounded-full border px-2 py-1 ${getRunOutputStatusClass(state)}`}>
                  {getRunOutputStatusLabel(state)}
                </span>
              </div>
            </div>
            {job.error_message ? (
              <div className={cn("m-5 rounded-none border p-4 text-sm leading-6", state === "partial" ? "border-amber-200 bg-amber-50 text-amber-800" : "border-red-200 bg-red-50 text-red-700")}>
                {job.error_message}
              </div>
            ) : null}
            {job.response?.trim() ? (
              <div className="m-5 max-w-full overflow-x-auto rounded-2xl bg-slate-50 p-5">
                <StandardLlmOutputRenderer content={job.response.trim()} pairwisePrompt={pairwise ? job.prompt || run.prompt : undefined} />
              </div>
            ) : (
              <div className="m-5 rounded-2xl bg-slate-50 p-5 text-xs leading-6 text-slate-700">
                No response text saved.
              </div>
            )}
          </section>
        );
      })}
    </div>
  );
}

function getStageOutputRoute(
  portfolio: WorkflowPortfolio,
  stage: WorkflowStageKey,
) {
  const zerodha = portfolio === "zerodha";
  const routeByStage: Record<WorkflowStageKey, string> = {
    pairwise: URLs.routes.console.dashboard(),
    sync: zerodha
      ? URLs.routes.console.zerodha()
      : URLs.routes.console.indmoneyUs(),
    threats: zerodha
      ? URLs.routes.console.zerodhaThreats()
      : URLs.routes.console.indmoneyUsThreats(),
    swing: zerodha
      ? URLs.routes.console.zerodhaSwingTrade()
      : URLs.routes.console.indmoneyUsSwingTrade(),
    rebalance: zerodha
      ? URLs.routes.console.zerodhaRebalance()
      : URLs.routes.console.indmoneyUsRebalance(),
    technical: URLs.routes.console.dashboard(),
    actionables: `${URLs.routes.console.dashboard()}#final-actionables`,
  };
  return routeByStage[stage];
}

function ZerodhaBasketPreviewDialog(props: Parameters<typeof ScopedZerodhaBasketPreviewDialog>[0]) {
  const { user } = useAuth();
  const owner = user && Number.isSafeInteger(user.id) && user.id > 0 ? user.id : null;
  const [columnPreferences, setColumnPreferences] = useState<Record<string, BasketColumnLayout>>({});
  const preferenceScope = `${owner ?? "anonymous"}:${props.basketBrokerLabel ?? "Zerodha"}:${props.tradingViewMarket ?? "india"}`;
  useEffect(() => {
    if (owner === null) return;
    const hidden = readBasketColumnLayout(preferenceScope);
    setColumnPreferences(current => Object.hasOwn(current, preferenceScope) ? current : { ...current, [preferenceScope]: hidden });
  }, [owner, preferenceScope]);
  const saved = columnPreferences[preferenceScope];
  function updateLayout(change: (layout: BasketColumnLayout) => BasketColumnLayout) {
    const previous = saved ?? (owner === null ? emptyBasketColumnLayout() : readBasketColumnLayout(preferenceScope));
    const next = change(previous);
    if (owner !== null) writeBasketColumnLayout(preferenceScope, next);
    setColumnPreferences(current => ({ ...current, [preferenceScope]: next }));
  }
  return <ScopedZerodhaBasketPreviewDialog
    key={`${preferenceScope}:${props.detailsData.portfolioSnapshot?.captured_at ?? "missing"}:${props.open}`}
    {...props}
    widthOwner={owner}
    columnPreferences={{
      hiddenColumns: saved?.hidden ?? [],
      order: saved?.order ?? [],
      names: saved?.names ?? {},
      toggle: id => updateLayout(layout => ({
        ...layout,
        hidden: layout.hidden.includes(id) ? layout.hidden.filter(value => value !== id) : [...layout.hidden, id],
      })),
      reorder: order => updateLayout(layout => ({ ...layout, order })),
      rename: (id, name) => updateLayout(layout => ({ ...layout, names: { ...layout.names, [id]: name } })),
    }}
  />;
}
function ScopedZerodhaBasketPreviewDialog({
  open,
  loading,
  error,
  allocationUniverse = [],
  scoreSourceRuns = [],
  orders,
  selectedIds,
  onClose,
  onToggle,
  onToggleAll,
  onToggleSection,
  onOrderKindChange,
  onPercentChange,
  onUnitsChange,
  onWholeShareChoice,
  onPlaceOrder,
  placing,
  directMarketAvailable,
  orderSubmissionBlockedReason,
  showSubmissionNotice = true,
  executionMode,
  onExecutionModeChange,
  onRefreshLtp,
  ltpRefreshing,
  ltpRefreshedAt,
  submission,
  detailsData,
  historicalRows,
  formulaConfig,
  onFormulaConfigChange,
  buyThreshold,
  buyThresholdDraft,
  onBuyThresholdDraftChange,
  previewLabel = "Zerodha Basket Preview",
  onDefaultSelection,
  basketTitle = "Zerodha India Place Order Basket",
  basketBrokerLabel = "Zerodha",
  tradingViewMarket = "india",
  tradingViewTitle = "Zerodha India Basket TradingView URLs",
  tradingViewAriaLabel = "Open Zerodha India basket TradingView URL list",
  loadingLabel = "Preparing Zerodha basket…",
  scoreRevision,
  openSavedBasket,
  compareCurrentSettings,
  scoreScanCompletedAt: scoreScanCompletedAtOverride = null,
  primaryButtonLabel,
  basketInfoText = "All rows are visible and selectable. Selection does not assert execution validity. Review the basket here, use protected MARKET for all selected stocks by default whenever direct Kite Connect access is enabled during regular market hours. Market drafts require enabled direct broker access; no silent LIMIT fallback is used.",
  basketCurrency = "INR",
  widthOwner,
  columnPreferences,
}: {
  open: boolean;
  loading: boolean;
  error: string | null;
  orders: ZerodhaBasketPreviewOrder[];
  allocationUniverse?: DashboardActionRow[];
  scoreSourceRuns?: RunResponse[];
  selectedIds: Set<string>;
  onClose: () => void;
  onToggle: (id: string) => void;
  onToggleAll: (ids?: string[]) => void;
  onDefaultSelection?: (ids: Set<string>) => void;
  onToggleSection: (action: ActionCategory, visibleIds?: string[]) => void;
  onOrderKindChange: (id: string, orderKind: ZerodhaBasketOrderKind) => void;
  onPercentChange: (id: string, percent: ZerodhaBasketOrderPercent) => void;
  onUnitsChange: (id: string, delta: number) => void;
  onWholeShareChoice?: (id: string, choice: "keep" | "exit") => void;
  onPlaceOrder: (drafts?: ZerodhaBasketPreviewOrder[]) => void;
  placing: boolean;
  directMarketAvailable: boolean;
  orderSubmissionBlockedReason?: string | null;
  showSubmissionNotice?: boolean;
  executionMode: ZerodhaExecutionMode;
  onExecutionModeChange: (mode: ZerodhaExecutionMode) => void;
  onRefreshLtp: () => void;
  ltpRefreshing: boolean;
  ltpRefreshedAt: string | null;
  submission: ZerodhaBasketSubmission | null;
  detailsData: StockDetailsData;
  historicalRows: HistoricalDashboardActionRow[];
  formulaConfig: ScoreMatrixFormulaConfig;
  onFormulaConfigChange: (updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => void;
  buyThreshold: number;
  buyThresholdDraft: string;
  onBuyThresholdDraftChange: (value: string) => void;
  previewLabel?: string;
  basketTitle?: string;
  basketBrokerLabel?: string;
  tradingViewMarket?: SwingTradeMarket;
  tradingViewTitle?: string;
  tradingViewAriaLabel?: string;
  loadingLabel?: string;
  openSavedBasket?: () => void;
  compareCurrentSettings?: () => void;
  scoreRevision?: BasketScoreRevision | null;
  scoreScanCompletedAt?: string | null;
  primaryButtonLabel?: string;
  basketInfoText?: ReactNode;
  basketCurrency?: "INR" | "USD";
  widthOwner?: number | null;
  columnPreferences?: { hiddenColumns: string[]; order?: string[]; names?: Record<string, string>; toggle: (label: string) => void; reorder?: (order: string[]) => void; rename?: (id: string, name: string) => void };
}) {
  const reviewDialog = useReviewDialog<HTMLDivElement>(open, onClose);
  const orderBlockersId = useId();
  const [marketNoticeOpen, setMarketNoticeOpen] = useState(false);
  const [selectedMatrixDetail, setSelectedMatrixDetail] = useState<ScoreMatrixDetail | null>(null);
  const [basketInfoOpen, setBasketInfoOpen] = useState(false);
  const [priceReviews, setPriceReviews] = useState<Set<string>>(new Set());
  const [manualDraftUnits, setManualDraftUnits] = useState<Record<string, number>>({});
  const [unitsDetailId, setUnitsDetailId] = useState<string | null>(null);
  const [localHiddenColumns, setHiddenColumns] = useState<string[]>([]);
  const hiddenColumns = columnPreferences?.hiddenColumns ?? localHiddenColumns;
  const [columnMenu, setColumnMenu] = useState<string[] | null>(null);
  const [renameColumn, setRenameColumn] = useState<string | null>(null);
  useEffect(() => { if (!open) { setUnitsDetailId(null); setColumnMenu(null); } }, [open]);
  const unitsDetailOrder = unitsDetailId ? orders.find(order => order.id === unitsDetailId) : undefined;

  const availableMargin = portfolioParameterMargin(detailsData.portfolioSnapshot, tradingViewMarket);
  const currentWeights = kiteWeightContext(tradingViewMarket === "india" ? detailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null : null);
  // One saved-snapshot valuation for tile, weights, differences and display sizing.
  // Include T1 delivery exposure; never add intraday/net positions or quote-refresh values.
  const portfolioAssets = tradingViewMarket === "india"
    ? { portfolioValue: currentWeights.portfolioValue, availableMargin, totalAssets: currentWeights.totalAssets }
    : portfolioParameterAssets(detailsData.portfolioSnapshot, tradingViewMarket, availableMargin);
  const finalListings = Array.from(scoreRevision?.finalRows?.values() ?? []);
  const quoteRows = allocationUniverse.map(row => row.stock);
  const indiaListings = [...quoteRows, ...finalListings];
  const quoteInstruments = (tradingViewMarket === "us" ? [...quoteRows, ...orders] : indiaListings)
    .map(row => `${row.exchange.toUpperCase()}:${row.symbol.toUpperCase()}`);
  const columnNames = { ...(tradingViewMarket === "india" ? { "Score": "Workflow final score", "Consensus": "Votes for proposed trade", "Action": "Score-based action", "Side": "Trade side", "Action New": "Proposed trade" } : {}), ...(tradingViewMarket === "us" ? { "Vendor LTP": "Alpaca IEX LTP" } : {}), ...columnPreferences?.names } as Record<string, string>;
  const quoteRead = useBasketDisplayQuotes(open, tradingViewMarket, quoteInstruments, detailsData.portfolioSnapshot ? `${tradingViewMarket}:${detailsData.portfolioSnapshot.snapshot_date}:${detailsData.portfolioSnapshot.captured_at}:${ltpRefreshedAt ?? "initial"}` : null);
  const providerPriceCell = (symbol: string, exchange: string) => {
    const quote = verifiedFetchedDisplayQuote(tradingViewMarket === "india" ? (quoteRead.upstoxQuotes ?? []).filter(row => row.source.startsWith("Upstox ")) : quoteRead.quotes, symbol, exchange);
    const stale = tradingViewMarket === "us" && quoteRead.vendorQuotes?.some(row => row.instrument === stockIdentity(symbol, exchange) && row.stale);
    return <td className="whitespace-nowrap px-4 py-3 text-slate-700" data-provider={tradingViewMarket === "india" ? "upstox" : "alpaca-iex"} title={quote ? `${quote.source} · As of ${quote.asOf}` : tradingViewMarket === "india" ? "No Upstox quote available for this exact listing" : "No verified Alpaca IEX trade available for this exact listing"}>
      {quote ? <><div>{formatBasketCurrency(quote.price, basketCurrency)}</div><time dateTime={quote.asOf} className="block text-[10px] text-slate-500">{formatCompactQuoteTime(quote.asOf)}</time>{stale && <span className="block text-xs text-amber-700">Stale last trade</span>}</> : "Unavailable"}
    </td>;
  };
  const displayQuote = (symbol: string, exchange: string) => {
    const quote = verifiedFetchedDisplayQuote(quoteRead.quotes, symbol, exchange) ?? verifiedDisplayQuote(detailsData.portfolioSnapshot, tradingViewMarket, symbol, exchange);
    const order = orders.find(row => row.symbol === symbol && row.exchange === exchange);
    const rowQuote = tradingViewMarket === "india" ? validDisplayPrice(order?.lastPrice) : null;
    return { ltp: quote?.price ?? rowQuote, limitPrice: tradingViewMarket === "india" ? validDisplayPrice(order?.price) : null, ltpAsOf: quote?.asOf ?? (rowQuote !== null ? ltpRefreshedAt ?? undefined : undefined), ltpSource: quote?.source ?? (rowQuote !== null ? "Quoted LTP shown in this exact row; freshness not independently verified" : undefined), quoteLoading: quoteRead.loading && !quote && rowQuote === null };
  };
  const venueEvidence = (symbol: string, exchange: string) => {
    const holding = tradingViewMarket === "india" ? kiteHoldingQuantity(detailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null, symbol, exchange) : null;
    const upstox = verifiedFetchedDisplayQuote((quoteRead.upstoxQuotes ?? []).filter(quote => quote.source.startsWith("Upstox ")), symbol, exchange);
    const snapshot = detailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null;
    const exact = tradingViewMarket === "india" ? snapshot?.holdings?.filter(h => stockIdentity(h.tradingsymbol, h.exchange) === stockIdentity(symbol, exchange)) ?? [] : [];
    const idsForVenue = new Set([...exact.map(h => h.isin), upstox?.isin].filter((s): s is string => Boolean(s)));
    const issuer = idsForVenue.size === 1 ? [...idsForVenue][0] : null;
    const hasOutsideHolding = issuer && snapshot?.holdings?.some(h => h.isin === issuer && !indiaListings.some(item => stockIdentity(item.symbol, item.exchange) === stockIdentity(h.tradingsymbol, h.exchange)));
    return {holding, upstox, isin: hasOutsideHolding ? null : issuer};
  };
  const displayStock = (row: DashboardActionRow) => {
    const currentOrder = orders.find(order => order.symbol === row.stock.symbol && order.exchange === row.stock.exchange);
    const currentDetail = currentOrder?.detail ?? row.detail;
    const { holding, upstox, isin } = venueEvidence(row.stock.symbol, row.stock.exchange);
    const modelPrices = row.stock.rows.map(({meta, cells}) => ({
      job: meta.jobId, provider: meta.provider, time: meta.createdAt,
      price: validDisplayPrice(Number(String(cells["Price Per Unit"] ?? "").replace(/,/g, ""))),
      excluded: Object.entries(cells).filter(([header, value]) => header.startsWith("Score Rationale") && (!/^-?\d+(?:\.\d+)?$/.test(String(value).trim()) || Math.abs(Number(value)) > 3)).map(([header]) => header.replace(/^Score Rationale\s*[-–]?\s*/, "")),
      fields: Object.entries(cells).filter(([header, value]) => header.startsWith("Score Rationale") && /^-?\d+(?:\.\d+)?$/.test(String(value).trim()) && Math.abs(Number(value)) <= 3).length,
    }));
    const usHolding = tradingViewMarket === "us" && !row.stock.identityIssue && row.stock.usIdentity?.holdingSafe !== false ? indmoneyHolding(detailsData.portfolioSnapshot as IndMoneyUsPortfolioSnapshotDetail | null, row.stock.symbol, row.stock.exchange, allocationUniverse.map(item => item.stock)) : null;
    const vendor = tradingViewMarket === "us" ? verifiedFetchedDisplayQuote(quoteRead.quotes, row.stock.symbol, row.stock.exchange) : null;
    const ids = [...new Set([...row.stock.rows.map(source => source.meta.runId), ...(currentDetail.technicalScanSourceRunId ? [currentDetail.technicalScanSourceRunId] : [])])];
    const scoreSources = ids.map(runId => {
      const run = scoreSourceRuns.find(source => source.id === runId);
      const sameMarket = run && ["rebalance", "technical", "swing", "threats"].some(stage => isAnalysisRunForStage(run, stage as "rebalance" | "technical" | "swing" | "threats", tradingViewMarket));
      return { runId, createdAt: parseApiTimestamp(run?.created_at)?.toISOString() ?? "", completed: run?.status === "completed", status: run?.status, market: sameMarket ? tradingViewMarket : null };
    });
    const saved = openSavedBasket ? scoreRevision?.saved.get(stockIdentity(row.stock.symbol, row.stock.exchange)) : undefined;
    return { savedComparison: saved && {score: saved.score, divisor: saved.divisor, currentDivisor: currentDetail.detailedRationaleDenominator}, modelUnits: currentDetail.meanUnitsChange, isin, modelPrices, verifiedUsIdentity: row.stock.usIdentity?.listing ? {securityId:row.stock.usIdentity.listing.security_id,exchangeAliases:row.stock.usIdentity.holdingSafe ? ["US"] : []} : undefined, identityIssue: row.stock.identityIssue, vendorReady: (quoteRead.vendorQuotes ?? []).find(quote => quote.instrument === stockIdentity(row.stock.symbol, row.stock.exchange))?.eligible_for_readiness === true, investedValue: usHolding?.investedValue ?? null, vendorLtp: vendor?.price ?? null, vendorSource: vendor?.source, vendorAsOf: vendor?.asOf, currentValue: tradingViewMarket === "us" ? usHolding?.currentValue ?? null : currentWeights.valid ? currentWeights.values.get(stockIdentity(row.stock.symbol, row.stock.exchange)) ?? 0 : null, holdingQuantity: tradingViewMarket === "us" ? usHolding?.quantity ?? null : holding?.quantity ?? null, holdingAsOf: holding?.asOf, holdingSource: holding?.source, upstoxLtp: upstox?.price ?? null, upstoxAsOf: upstox?.asOf, upstoxSource: upstox?.source, symbol: row.stock.symbol, exchange: row.stock.exchange, score: currentOrder ? currentDetail.calculatedScore : row.formulaScore, action: currentOrder ? getZerodhaBasketActionForPercent(currentOrder) : row.formulaAction, scoreSources, ...displayQuote(row.stock.symbol, row.stock.exchange) };
  };
  const calculationStocks = allocationUniverse.map(displayStock);
  const knownListings = new Set(calculationStocks.map(stock => stockIdentity(stock.symbol, stock.exchange)));
  const finalOnlyStocks = finalListings.filter(row => !knownListings.has(row.listing)).map(row => {
    const stock = {symbol:row.symbol, exchange:row.exchange, score:row.signed, currentValue:row.value,
      holdingQuantity:row.units, action:row.action, ...displayQuote(row.symbol, row.exchange)};
    if (tradingViewMarket !== "india") return stock;
    const {holding, upstox, isin} = venueEvidence(row.symbol, row.exchange);
    return {...stock, isin, currentValue: currentWeights.valid ? currentWeights.values.get(row.listing) ?? 0 : null, holdingQuantity:holding?.quantity ?? null, upstoxLtp:upstox?.price ?? null,
      upstoxAsOf:upstox?.asOf, upstoxSource:upstox?.source};
  });
  const displayCalculations = useBasketDisplayCalculations(open, tradingViewMarket, [...calculationStocks, ...finalOnlyStocks], portfolioAssets.totalAssets, detailsData.portfolioSnapshot?.captured_at ?? null, basketBrokerLabel, { portfolioValue: portfolioAssets.portfolioValue, availableMargin: portfolioAssets.availableMargin }, tradingViewMarket === "india" ? "issuer-v2" : "listing-v1");
  const legacyDisplayOnlyRows = allocationUniverse.filter(row => row.independentEligible !== false && !orders.some(order => order.symbol === row.stock.symbol && order.exchange === row.stock.exchange));
  const visibleScore = (_score: number | null) => true;
  const zerodhaSections = new Map<string, string>();
  const buildEditableRow = (existing: ZerodhaBasketPreviewOrder | undefined, row?: DashboardActionRow): ZerodhaBasketPreviewOrder => {
    const stock = existing ? { symbol: existing.symbol, exchange: existing.exchange, score: existing.detail.calculatedScore, ...displayQuote(existing.symbol, existing.exchange) } : displayStock(row!);
    const metrics = displayCalculations.metrics?.(stock);
    const action = metrics?.comparison.action ?? null, direction = draftDirection(action);
    const suggested = suggestedDraftUnits(metrics?.actionSizing.stocks);
    const id = existing?.id ?? `basket:${stockIdentity(stock.symbol, stock.exchange)}`;
    if (tradingViewMarket === "india") zerodhaSections.set(id, basketActionGroup(action, metrics?.comparison.current, metrics?.target));
    const units = Object.hasOwn(manualDraftUnits, id) ? manualDraftUnits[id] : suggested;
    const price = metrics?.actionSizing.price ?? null;
    const holding = tradingViewMarket === "india" ? kiteHoldingQuantity(detailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null, stock.symbol, stock.exchange) : (() => { if (metrics?.sourceStock.identityIssue) return null; const found = indmoneyHolding(detailsData.portfolioSnapshot as IndMoneyUsPortfolioSnapshotDetail | null, stock.symbol, stock.exchange, allocationUniverse.map(item => item.stock)); return found?.quantity == null ? null : { quantity: found.quantity }; })();
    const upstox = verifiedFetchedDisplayQuote((quoteRead.upstoxQuotes ?? []).filter(quote => quote.source.startsWith("Upstox ")), stock.symbol, stock.exchange);
    return { ...existing, id, symbol: stock.symbol, exchange: stock.exchange,
      action: (basketActionGroup(action) === 'Unavailable' ? 'Hold' : basketActionGroup(action)) as ActionCategory,
      side: direction ?? existing?.side ?? 'BUY', units, baseUnits: suggested, currentUnits: holding?.quantity ?? null,
      price, lastPrice: price, amount: editableDraftAmount(units, price), availableBalance: availableMargin,
      percent: direction === 'SELL' && holding?.quantity ? (units ?? 0) / holding.quantity * 100 : 100,
      orderKind: 'Market', wholeShareReview: tradingViewMarket === 'india' ? existing?.wholeShareReview : undefined, stock: existing?.stock ?? row!.stock, detail: existing?.detail ?? row!.detail,
      technicalScan: existing?.technicalScan ?? null,
      draftContext: { action, directionConflict: metrics && "directionConflict" in metrics.actionSizing ? metrics.actionSizing.directionConflict : false, originalAction: (existing ? existing.detail.calculatedAction : row!.formulaAction) ?? undefined, suggestedUnits: suggested, source: tradingViewMarket === "india" ? upstox?.source : displayQuote(stock.symbol, stock.exchange).ltpSource, asOf: tradingViewMarket === "india" ? upstox?.asOf : displayQuote(stock.symbol, stock.exchange).ltpAsOf },
    };
  };
  const basketRows = [
    ...orders.map(order => buildEditableRow(order)),
    ...legacyDisplayOnlyRows.map(row => buildEditableRow(undefined, row)),
  ];
  const editableListings = new Set(basketRows.map(row => stockIdentity(row.symbol, row.exchange)));
  const renderSavedScore = (row: FinalRow) => <details>
    <summary className="cursor-pointer font-semibold">{row.final == null ? "Unavailable" : row.final.toFixed(2) + " / 100"}<small className="block text-slate-600">{row.status}</small></summary>
    {Object.entries(row.scores).map(([card, score]) => <div key={card}>{card} · {score?.toFixed(2) ?? "Unavailable"}</div>)}
  </details>;
  const reviewRows = Array.from(scoreRevision?.finalRows?.values() ?? [])
    .filter(row => !editableListings.has(row.listing));
  const quotedOrders = tradingViewMarket === "india"
    ? basketRows.filter(row => row.draftContext?.source?.startsWith("Upstox ") && row.amount !== null && row.amount > 0 && Number.isFinite(row.amount))
    : basketRows;
  const defaultIds = JSON.stringify(quotedOrders.map(order => order.id));
  const selectionEdited = useRef(false);
  useEffect(() => {
    if (!open || loading) {
      selectionEdited.current = false;
      return;
    }
    if (!selectionEdited.current && !submission && onDefaultSelection) {
      onDefaultSelection(new Set<string>(JSON.parse(defaultIds)));
    }
  }, [open, loading, defaultIds, onDefaultSelection, submission]);
  if (!open) return null;

  const selectableOrders = quotedOrders;
  const selectedOrders = basketRows.filter((order) => selectedIds.has(order.id));
  const selectedBuyAmount = selectedOrders
    .filter((order) => order.side === "BUY")
    .reduce((sum, order) => sum + (order.amount ?? 0), 0);
  const selectedSellAmount = selectedOrders
    .filter((order) => order.side === "SELL")
    .reduce((sum, order) => sum + (order.amount ?? 0), 0);
  const netPurchases = selectedOrders.some(order => order.amount == null || !Number.isFinite(order.amount))
    ? null : selectedBuyAmount - selectedSellAmount;
  const availableMarginToneClass = getZerodhaAvailableMarginToneClass(
    availableMargin,
    selectedBuyAmount,
  );
  const safetyBufferAmount = selectedBuyAmount > 0 ? Math.max(50, selectedBuyAmount * 0.01) : 0;
  const projectedBuyPower = availableMargin === null || selectedOrders.some(order => order.amount === null) ? null : Math.max(0, availableMargin + selectedSellAmount - safetyBufferAmount);

  const allSelected = selectableOrders.length > 0 && selectableOrders.every(order => selectedIds.has(order.id));
  const isZerodhaPreview = tradingViewMarket === "india";
  const marketStatus = getIndiaMarketStatus();
  const submittedOrderIds = new Set(submission?.orders.map((order) => order.id) ?? []);
  const placedOrderIds = new Set(submission?.placedOrderIds ?? []);
  const skippedOrderIds = new Set(submission?.skippedOrderIds ?? []);
  const executionPricesByOrderId = submission?.executionPricesByOrderId ?? {};
  const scoreScanCompletedAt = scoreScanCompletedAtOverride ?? (
    orders
      .map((order) => order.technicalScan?.createdAt ?? null)
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => parseTimestampMs(right) - parseTimestampMs(left))[0] ?? null
  );
  const orderCalculation = (order: ZerodhaBasketPreviewOrder) => displayCalculations.metrics?.({ symbol: order.symbol, exchange: order.exchange, score: order.detail.calculatedScore, ...displayQuote(order.symbol, order.exchange) });
  const groupForOrder = (order: ZerodhaBasketPreviewOrder) => {
    const saved = scoreRevision?.finalRows?.get(stockIdentity(order.symbol, order.exchange));
    if (isZerodhaPreview) return zerodhaSections.get(order.id);
    if (saved) return parseActionLabel(saved.action ?? "") ?? "Unavailable";
    return typeof displayCalculations.metrics === "function" ? basketActionGroup(orderCalculation(order)?.comparison.action) : getZerodhaBasketActionForPercent(order);
  };
  const indiaSource = (order: ZerodhaBasketPreviewOrder) => calculationStocks.find(stock => stockIdentity(stock.symbol, stock.exchange) === stockIdentity(order.symbol, order.exchange));
  const priceReviewKey = (order: ZerodhaBasketPreviewOrder) => JSON.stringify([order.exchange, order.symbol, order.price, order.draftContext?.asOf, indiaSource(order)?.modelPrices]);
  const divergent = (order: ZerodhaBasketPreviewOrder) => indiaSource(order)?.modelPrices.some(model => model.price && order.price && Math.abs(order.price / model.price - 1) >= 0.10);
  const issuerDraftIssue = (order: ZerodhaBasketPreviewOrder) => {
    const source = indiaSource(order);
    if (!source?.isin || calculationStocks.some(s => !s.isin)) return "Provisional allocation: a security identity is missing, conflicts, or has holdings outside this basket.";
    const members = calculationStocks.filter(stock => stock.isin === source.isin);
    if (members.some(stock => stock.holdingQuantity == null || !stock.upstoxLtp && stock.holdingQuantity !== 0)) return "Combined holdings or exact-venue prices are unavailable.";
    const selections = selectedOrders.filter(item => indiaSource(item)?.isin === source.isin);
    const additions = selections.filter(item => item.side === "BUY");
    if (additions.length && selections.some(item => item.side === "SELL")) return "Opposing trades for the same equity require review.";
    if (additions.length > 1) return "Route this equity's purchase to one venue.";
    const held = members.reduce((n, stock) => n + (stock.holdingQuantity ?? 0) * (stock.upstoxLtp ?? 0), 0);
    const projected = selections.reduce((n, item) => n + (item.side === "BUY" ? 1 : -1) * (item.amount ?? 0), held);
    if (selections.length && (portfolioAssets.totalAssets == null || projected > portfolioAssets.totalAssets * displayCalculations.parameters.normalised / 100 + 0.001)) return "Selected units exceed the combined issuer weight cap.";
    return null;
  };
  const rowDraftIssues = (order: ZerodhaBasketPreviewOrder) => !isZerodhaPreview ? [
    ...(order.stock.identityIssue ? [order.stock.identityIssue] : []),
    ...(!draftDirection(order.draftContext?.action) ? ["Action New has no buy or sell direction."] : []),
    ...(order.units == null || !Number.isFinite(order.units) || order.units <= 0 ? ["A positive fractional or whole quantity is required."] : []),
    ...(order.price == null || order.amount == null ? ["Verified US vendor price and calculated amount are required."] : []),
    ...(!calculationStocks.find(stock => stockIdentity(stock.symbol, stock.exchange) === stockIdentity(order.symbol, order.exchange))?.vendorReady ? ["Alpaca IEX estimate is not an execution-ready quote; source trade time and market calendar require review."] : []),
    ...(!actionQuantityMatchesDraft(orderCalculation(order)?.actionSizing.stocks, order.side, order.baseUnits) ? ["Invested-cost action direction and Action New must agree; review this estimate."] : []),
    ...(order.side === "SELL" && (order.currentUnits == null || order.units == null || order.units > order.currentUnits) ? ["Sell estimate exceeds known holdings or holdings are unavailable; review invested-cost sizing."] : []),
    ...(displayCalculations.loading || displayCalculations.error ? ["Complete score history is required."] : []),
    ...(calculationStocks.find(stock => stockIdentity(stock.symbol, stock.exchange) === stockIdentity(order.symbol, order.exchange))?.scoreSources?.some(source => !source.completed) ? ["Source output is partial or incomplete; review required."] : []),
  ] : [
    ...editableDraftIssues(order),
    ...[issuerDraftIssue(order)].filter((reason): reason is string => Boolean(reason)),
    ...(divergent(order) && !priceReviews.has(priceReviewKey(order)) ? ["Model price differs from the venue quote by at least 10%. Review price provenance before execution."] : []),
    ...(order.wholeShareReview && order.wholeShareReview !== "exit" ? ["Existing whole-share choice requires explicit review."] : []),
    ...(!directMarketAvailable || !marketStatus.open || executionMode !== 'direct_market' ? ['Market execution requires enabled direct broker access during regular market hours.'] : []),
  ];
  const affordabilityIssue = isZerodhaPreview ? basketAffordabilityIssue(selectedOrders, availableMargin) : null;
  const issuesByReason = new Map<string, Set<string>>();
  for (const order of selectedOrders) {
    for (const detail of rowDraftIssues(order)) {
      const reason = detail.startsWith("Last Upstox trade on ")
        ? "Last Upstox trade is older than 2 minutes."
        : detail;
      const stocks = issuesByReason.get(reason) ?? new Set<string>();
      stocks.add(order.exchange + ":" + order.symbol);
      issuesByReason.set(reason, stocks);
    }
  }
  const selectedDraftIssues = Array.from(issuesByReason.keys());
  const savedReview = reviewRows.map(row => {
    const stock = { symbol: row.symbol, exchange: row.exchange, score: row.signed, ...displayQuote(row.symbol, row.exchange) };
    const metrics = isZerodhaPreview ? displayCalculations.metrics?.(stock) : undefined;
    const action = metrics?.comparison.action ?? null;
    const units = manualDraftUnits[row.listing] ?? suggestedDraftUnits(metrics?.actionSizing.stocks);
    const amount = editableDraftAmount(units, metrics?.actionSizing.price ?? null);
    const group = isZerodhaPreview ? basketActionGroup(action, metrics?.comparison.current, metrics?.target) : parseActionLabel(row.action ?? "") ?? "Unavailable";
    return { row, stock, action, units, amount, group };
  });
  const sectionGroups = [...STANDARD_ACTION_ORDER, "No Action", "Unavailable"].map((action) => ({
    action,
    label: isZerodhaPreview && action === "Add more" ? "Add More" : ZERODHA_BASKET_SECTION_LABELS[action as ActionCategory] ?? action,
    review: savedReview.filter(item => item.group === action),
    orders: basketRows
      .filter((order) => groupForOrder(order) === action && visibleScore(order.detail.calculatedScore))
      .sort(compareZerodhaBasketOrdersByScore),
  })).filter((group) => group.orders.length > 0 || group.review.length > 0);

  const orderBlockers = [
    ...(!selectedOrders.length ? ["Select at least one stock."] : []),
    ...(placing ? ["Order submission is in progress."] : []),
    ...(ltpRefreshing ? ["Quote refresh is in progress."] : []),
    ...(orderSubmissionBlockedReason ? [orderSubmissionBlockedReason] : []),
    ...selectedDraftIssues,
    ...(affordabilityIssue ? [affordabilityIssue] : []),
  ];
  const buttonText = isZerodhaPreview ? "Place Order" : (primaryButtonLabel ?? "Place Order");
  const busyText = executionMode === "direct_market" ? "Placing…" : "Opening…";
  const renderPlaceOrderButton = (className?: string) => (
    <Button
      type="button"
      onClick={() => onPlaceOrder(basketRows)}
      aria-describedby={orderBlockers.length ? orderBlockersId : undefined}
      disabled={!selectedOrders.length || placing || ltpRefreshing || Boolean(orderSubmissionBlockedReason) || selectedDraftIssues.length > 0 || Boolean(affordabilityIssue)}
      className={cn(
        "shrink-0 rounded-full bg-blue-600 px-5 text-sm font-bold text-white shadow-md shadow-blue-600/25 hover:bg-blue-700 disabled:opacity-50",
        className,
      )}
    >
      {placing ? busyText : buttonText}
    </Button>
  );

  return (
    <>
    <div inert={displayCalculations.popupOpen || unitsDetailOrder || columnMenu || renameColumn || marketNoticeOpen ? true : undefined} className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div {...reviewDialog} role="dialog" aria-modal="true" aria-label={basketTitle} className="relative w-[var(--basket-width,80rem)] max-w-full min-w-[min(320px,100%)] rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <BasketResizeHandles panelRef={reviewDialog.ref} owner={widthOwner} />
        <div className="flex h-[var(--basket-height,auto)] max-h-[min(var(--basket-height,90dvh),calc(100dvh-2rem))] flex-col overflow-hidden rounded-[inherit]">
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <div className="text-[11px] font-semibold uppercase tracking-[0.35em] text-slate-400">
              {previewLabel}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-3">
              <h3 className="text-xl font-bold text-slate-950">
                {basketTitle}
              </h3>
              <BasketMarketClosedNotice closed={isZerodhaPreview && !marketStatus.open} executionMode={executionMode} onOpenChange={setMarketNoticeOpen} />
              <div className="relative">
                <button
                  type="button"
                  onClick={() => setBasketInfoOpen((current) => !current)}
                  className="inline-flex size-8 items-center justify-center rounded-full border border-blue-100 bg-blue-50 text-blue-600 transition hover:border-blue-200 hover:bg-blue-100 hover:text-blue-700"
                  aria-label={`Show ${basketBrokerLabel} basket selection guidance`}
                  aria-expanded={basketInfoOpen}
                >
                  <Info className="size-4" />
                </button>
                {basketInfoOpen ? (
                  <div className="absolute left-0 top-10 z-20 w-96 max-w-[calc(100vw-3rem)] rounded-2xl border border-blue-100 bg-white p-4 text-sm leading-6 text-slate-600 shadow-xl shadow-slate-900/10">
                    {basketInfoText}
                  </div>
                ) : null}
              </div>
              <TradingViewUrlListButton
                items={orders.map((order) => ({
                  symbol: order.symbol,
                  market: tradingViewMarket,
                  exchange: order.exchange,
                }))}
                title={tradingViewTitle}
                ariaLabel={tradingViewAriaLabel}
              />
            </div>
            {scoreScanCompletedAt ? (
              <p
                className="mt-2 text-xs font-semibold text-slate-600"
                data-testid="basket-score-scan-completed-at"
              >
                Last score scan: {formatCompactStageTime(scoreScanCompletedAt)}
                {scoreRevision && <span className="ml-2">Run #{scoreRevision.sequence}</span>}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onClose}
              className="rounded-full border border-slate-200 p-2 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
              aria-label={`Close ${basketBrokerLabel} basket preview`}
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        {compareCurrentSettings && <button type="button" className="mx-5 mt-2 self-start underline" onClick={compareCurrentSettings}>Compare with current settings</button>}
        {showSubmissionNotice && orderSubmissionBlockedReason ? (
          <div role="alert" className="mx-5 mt-4 rounded-2xl border border-amber-200 bg-amber-50 p-4 text-sm text-amber-900">
            {scoreRevision?.divisors.length ? <p className="font-semibold">Rationale divisor (basket → saved): {scoreRevision.divisors.join(", ")}</p> : null}
            {orderSubmissionBlockedReason}
            {scoreRevision?.differences.length ? <details><summary>Affected listings ({scoreRevision.differences.length})</summary>{scoreRevision.differences.join(", ")}</details> : null}
            {openSavedBasket && <button type="button" className="mt-2 underline" onClick={openSavedBasket}>Open basket with saved scoring settings</button>}
          </div>
        ) : null}
        <div role="region" aria-label="Basket orders, scroll to inspect" tabIndex={0} className="min-h-0 flex-1 overflow-auto overscroll-contain px-5 pb-5">
          {loading ? (isZerodhaPreview ? <ZerodhaBasketLoading /> : (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> {loadingLabel}
            </div>
          )) : orders.length || allocationUniverse.length || reviewRows.length || !error ? (
            <>
              <div className="sticky left-5">
                {error ? (
                  <div className="mb-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                    {error}
                  </div>
                ) : null}

                {displayCalculations.renderDisclosure(netPurchases)}

                {!isZerodhaPreview ? <p className="mb-5 text-sm font-semibold text-slate-700">IndMoney US basket review · USD</p> : null}

                {submission ? (
                  <div className={cn("mb-5 rounded-2xl border px-4 py-3 text-sm", submission.executionMode === "direct_market" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-blue-200 bg-blue-50 text-blue-800")}>
                    {submission.executionMode === "direct_market" ? (
                      <div className="flex flex-col gap-1">
                        <div className="font-bold">Success: {submission.redirected} protected MARKET order{submission.redirected === 1 ? "" : "s"} completed in Kite.</div>
                        <div>Executed rows are highlighted green below so you can see which Trim/Sell/Buy transactions finished.</div>
                        {submission.portfolioRefreshedAt ? (
                          <div>Portfolio snapshot refreshed after execution; the latest holdings are available for the next Trim calculation.</div>
                        ) : null}
                        {submission.failedMessages?.length ? (
                          <div className="font-semibold text-amber-800">Failed: {submission.failedMessages.join("; ")}</div>
                        ) : null}
                      </div>
                    ) : (
                      <>
                        Created {submission.basketCount} Kite protected LIMIT basket tray{submission.basketCount === 1 ? "" : "s"} for {submission.redirected} selected order{submission.redirected === 1 ? "" : "s"}.
                        {submission.basketCount > 1 ? ` Each tray contains at most ${ZERODHA_KITE_PUBLISHER_BATCH_SIZE} orders; place every tray in Kite.` : ""}
                        {submission.clipboardCopied ? " A backup order checklist was copied to your clipboard." : " Use the table below as your backup manual-entry checklist if Kite rejects the basket payload."}
                      </>
                    )}
                  </div>
                ) : null}

                {!isZerodhaPreview ? <p className="mb-5 rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-600">Review selected US stock quantities and USD amounts before confirming the final basket.</p> : null}

                <div className="mb-5 grid gap-3 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-3">
                  <div className="rounded-2xl border border-emerald-100 bg-emerald-50 p-4">
                    <div className="text-xs font-bold uppercase tracking-wide text-emerald-700">Buy Basket</div>
                    <div className="mt-2 text-2xl font-black text-emerald-950">{formatBasketCurrency(selectedOrders.some(order => order.side === "BUY" && order.amount === null) ? null : selectedBuyAmount, basketCurrency)}</div>
                    <div className={cn("mt-3 text-xs font-bold uppercase tracking-wide", availableMarginToneClass)}>
                      Available Margin
                    </div>
                    <div className={cn("mt-1 text-lg font-black", availableMarginToneClass)}>
                      {availableMargin === null ? "Not available" : formatBasketCurrency(availableMargin, basketCurrency)}
                    </div>
                    <div className="mt-2 whitespace-nowrap text-sm text-emerald-900">After sales: <strong>{projectedBuyPower === null ? "Not available" : formatBasketCurrency(projectedBuyPower, basketCurrency)}</strong></div>
                  </div>
                  <div className="rounded-2xl border border-red-100 bg-red-50 p-4">
                    <div className="text-xs font-bold uppercase tracking-wide text-red-700">Sell Basket</div>
                    <div className="mt-2 text-2xl font-black text-red-950">{formatBasketCurrency(selectedOrders.some(order => order.side === "SELL" && order.amount === null) ? null : selectedSellAmount, basketCurrency)}</div>
                  </div>
                  <PortfolioParametersTile valuationNote={tradingViewMarket === "india" ? "Portfolio exposure includes settled + T1 delivery units at each listing’s saved last price. Total Assets adds Available Margin once; net/day positions are not added." : undefined} onDisplayParametersChange={displayCalculations.setParameters} key={`${basketBrokerLabel}:${tradingViewMarket}:${detailsData.portfolioSnapshot?.captured_at ?? "unavailable"}`} currency={basketCurrency} {...portfolioAssets} capturedAt={detailsData.portfolioSnapshot?.captured_at ?? null} />
                </div>
                {quoteRead.loading ? <p role="status" className="mb-3 text-slate-600">Loading display prices…</p> : quoteRead.error ? <p role="alert" className="mb-3 text-amber-800">{quoteRead.upstoxEnabled ? "Price sources unavailable. " : `Display prices unavailable: ${quoteRead.error}. `}<button type="button" className="underline" onClick={quoteRead.retry}>Retry quotes</button></p> : null}
                {displayCalculations.error ? <p role="alert" className="mb-3 text-red-700">{displayCalculations.error} <button type="button" onClick={displayCalculations.retry} className="underline">Retry historical scores</button></p> : null}
              </div>
              <h3 className="sticky left-5 mb-2 text-lg font-bold text-slate-900">Order Basket</h3>
              <div className="basket-preview-scroll mb-5 w-max min-w-full rounded-2xl border border-slate-200">
                  <BasketColumnTable hidden={hiddenColumns} order={columnPreferences?.order} names={displayCalculations.parameters ? { "Historical Weighted Score": tradingViewMarket === "india" ? `${displayCalculations.parameters.days}-day mean of Workflow final score` : `${displayCalculations.parameters.days}-day mean of run scores (−3 to +3)`, ...columnNames } : columnNames} onOpen={setColumnMenu} onRequestRename={setRenameColumn}>
                  <table aria-label="Order Basket" className="min-w-[92rem] w-full border-separate border-spacing-0 text-sm">
                    <thead className="bg-slate-50">
                      <tr className="bg-slate-50 text-left text-xs uppercase tracking-wide text-slate-500">
                        <th className="px-4 py-3 font-semibold" data-column-label="Selection">
                          <input type="checkbox" checked={allSelected} onChange={() => { selectionEdited.current = true; onToggleAll(selectableOrders.map(row => row.id)); }} aria-label="Select or deselect all basket rows" className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500" />
                        </th>
                        <th className="px-4 py-3 font-semibold">Stock</th>
                        <th className="px-4 py-3 font-semibold">Score</th>
                        <th className="px-4 py-3 font-semibold">Consensus</th>
                        <th className="px-4 py-3 font-semibold">Action</th>
                        <th className="px-4 py-3 font-semibold">Side</th>
                        {displayCalculations.headers}
                        <th className="px-4 py-3 font-semibold">Units</th>
                        <th className="px-4 py-3 font-semibold">%</th>
                        <th className="px-4 py-3 font-semibold" data-column-label={tradingViewMarket === "us" ? "Vendor LTP" : undefined}>{tradingViewMarket === "india" ? "Upstox LTP" : "Alpaca IEX LTP"}</th>
                        <th className="px-4 py-3 font-semibold">Quoted LTP</th>
                        <th className="px-4 py-3 font-semibold">Limit Price</th>
                        <th className="px-4 py-3 font-semibold">Amount</th>
                        <th className="px-4 py-3 font-semibold">Order Type</th>
                        <th className="px-4 py-3 font-semibold">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {!sectionGroups.length && !reviewRows.length ? <tr><td colSpan={23} className="px-4 py-6 text-slate-500">No basket rows available.</td></tr> : null}
                      {sectionGroups.map((group) => {
                        const sectionSelectable = group.orders.filter(order => selectableOrders.includes(order));
                        const sectionSelected = sectionSelectable.filter(order => selectedIds.has(order.id)).length;
                        const sectionAllSelected = sectionSelectable.length > 0 && sectionSelected === sectionSelectable.length;
                        return (
                          <Fragment key={group.action}>
                            <tr className={cn("border-y border-slate-200 text-slate-900", STANDARD_ACTION_ROW_CLASS[parseActionLabel(group.action)!] ?? "bg-slate-100")}>
                              <td className="px-4 py-3" colSpan={23}>
                                <label className="inline-flex items-center gap-3 text-sm font-black">
                                  <input
                                    type="checkbox"
                                    checked={sectionAllSelected}
                                    onChange={() => { selectionEdited.current = true; onToggleSection(group.action as ActionCategory, sectionSelectable.map(order => order.id)); }}
                                    disabled={!sectionSelectable.length}
                                    aria-label={`Select or deselect ${group.label} ${basketBrokerLabel} basket orders`}
                                    className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                  />
                                  <span>{group.label}</span>
                                </label>
                              </td>
                            </tr>
                            {group.orders.map((order) => {
                              const savedRow = scoreRevision?.finalRows?.get(stockIdentity(order.symbol, order.exchange));
                              const isSubmitted = submittedOrderIds.has(order.id);
                              const isSkipped = skippedOrderIds.has(order.id);
                              const isPlaced = placedOrderIds.has(order.id) || (submission?.executionMode === "publisher_limit" && isSubmitted);
                              const executionPrice = executionPricesByOrderId[order.id] ?? null;
                              return (
                              <Fragment key={order.id}>
                              <tr className={cn("transition", isSkipped ? "bg-orange-50/80 ring-1 ring-inset ring-orange-100" : isPlaced ? "bg-emerald-50/80 ring-1 ring-inset ring-emerald-100" : isSubmitted ? "bg-amber-50/70" : "bg-white")}>
                                <td className="px-4 py-3">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(order.id)}
                                    onChange={() => { selectionEdited.current = true; onToggle(order.id); }}
                                    aria-label={`Select ${order.exchange} ${order.symbol}`}
                                    className="size-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                                  />
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-bold text-slate-950">
                                  <div className="inline-flex items-center gap-1.5">
                                    <StockDetailsButton
                                      stock={order.stock}
                                      savedFinal={isZerodhaPreview ? savedRow : undefined}
                                      formulaConfig={formulaConfig}
                                      market={tradingViewMarket}
                                      technicalScan={order.technicalScan}
                                      detailsData={detailsData}
                                      historicalRows={historicalRows}
                                    />
                                    {!isZerodhaPreview && <span className="text-xs font-semibold text-slate-500">{order.exchange}</span>}
                                    <TradingViewSymbolLink
                                      symbol={order.symbol}
                                      market={tradingViewMarket}
                                      exchange={order.exchange}
                                      className="underline-offset-4 transition hover:text-blue-700 hover:underline"
                                    >
                                      {isZerodhaPreview ? stockIdentity(order.symbol, order.exchange) : order.symbol}
                                    </TradingViewSymbolLink>
                                  </div>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-800">
                                  {savedRow ? renderSavedScore(savedRow) : <ScoreMatrixButton workflowScale detail={order.detail} savedScore={scoreRevision?.saved.get(stockIdentity(order.symbol, order.exchange))} originalDenominator={scoreRevision?.originals.get(stockIdentity(order.symbol, order.exchange))} formulaConfig={formulaConfig} onOpenDetail={setSelectedMatrixDetail} />}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3">
                                  <ConsensusBreakupButton stock={order.stock} action={getZerodhaBasketActionForPercent(order)} />
                                  {<details className="text-xs text-slate-600"><summary>Rationale coverage {indiaSource(order)?.modelPrices.filter(m => m.fields === 6).length ?? 0}/{order.stock.rows?.length ?? 0} jobs</summary>{indiaSource(order)?.modelPrices.map(m => <div key={m.job}>#{m.job} {m.provider} · {m.fields}/6 scored · model {formatBasketDisplayCurrency(m.price, basketCurrency)} · job {m.time}{m.excluded.length ? ` · excluded: ${m.excluded.join(", ")}` : ""}</div>)}{isZerodhaPreview && <div>Upstox ₹{order.price ?? "unavailable"} · last trade {order.draftContext?.asOf ?? "unavailable"}</div>}{isZerodhaPreview && divergent(order) && <button type="button" className="text-blue-700 underline" disabled={priceReviews.has(priceReviewKey(order))} onClick={() => setPriceReviews(previous => new Set([...previous, priceReviewKey(order)]))}>{priceReviews.has(priceReviewKey(order)) ? "Price difference reviewed" : "Acknowledge this price difference"}</button>}</details>}
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{isZerodhaPreview ? order.draftContext?.originalAction ?? getZerodhaBasketActionForPercent(order) : getZerodhaBasketActionForPercent(order)}</td>
                                <td className="px-4 py-3">
                                  <span className={cn(
                                    "rounded-full px-3 py-1 text-xs font-bold",
                                    !draftDirection(order.draftContext?.action) ? "bg-slate-100 text-slate-700" : order.side === "BUY" ? "bg-emerald-100 text-emerald-700" : "bg-red-100 text-red-700",
                                  )}>
                                    {draftDirection(order.draftContext?.action) ?? (order.draftContext?.action === "Hold" ? "Hold" : "Unavailable")}
                                  </span>
                                </td>
                                {displayCalculations.cells({ symbol: order.symbol, exchange: order.exchange, score: order.detail.calculatedScore, ...displayQuote(order.symbol, order.exchange) })}
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                                  <BasketDraftUnits fractional={tradingViewMarket === "us"} symbol={order.symbol} action={order.draftContext?.action ?? null} units={order.units} onChange={units => setManualDraftUnits(current => ({ ...current, [order.id]: units }))}>{displayCalculations.units?.({ symbol: order.symbol, exchange: order.exchange, score: order.detail.calculatedScore, ...displayQuote(order.symbol, order.exchange) }, "Units action", order.units)}</BasketDraftUnits>
                                </td>
                                <td className="px-4 py-3">
                                  <span>{formatBasketPercent(order.percent)}</span>
                                </td>
                                {providerPriceCell(order.symbol, order.exchange)}
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatBasketCurrency(displayQuote(order.symbol, order.exchange).ltp, basketCurrency)}</td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700" title={`Market orders have no limit price; estimated value uses ${isZerodhaPreview ? "Upstox" : "US vendor"} LTP.`}>—</td>
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">{formatBasketCurrency(order.amount, basketCurrency)}</td>
                                <td className="px-4 py-3">
                                  <span>Market</span>
                                </td>
                                <td className="whitespace-nowrap px-4 py-3 text-xs font-semibold text-slate-600">
                                  {isSkipped ? (
                                    <span className="inline-flex rounded-full bg-orange-100 px-3 py-1 font-bold text-orange-800">Buy skipped/reduced</span>
                                  ) : isPlaced ? (
                                    <span className="inline-flex flex-col rounded-xl bg-emerald-100 px-3 py-1 font-bold text-emerald-800">
                                      <span>{submission?.executionMode === "direct_market" ? (order.side === "SELL" ? "Sell phase placed" : "Buy phase placed") : "Sent to protected LIMIT tray"}</span>
                                      {executionPrice !== null ? (
                                        <span className="text-[11px] font-black text-emerald-950">Avg. Price {formatBasketCurrency(executionPrice, basketCurrency)}</span>
                                      ) : null}
                                    </span>
                                  ) : isSubmitted ? (
                                    <span className="inline-flex rounded-full bg-amber-100 px-3 py-1 font-bold text-amber-800">Failed / check Kite</span>
                                  ) : (
                                    <span className="inline-block max-w-xs whitespace-normal">{rowDraftIssues(order).join(" ") || (isZerodhaPreview ? "Ready for broker validation" : "Estimate for manual review · not an execution quote")}</span>
                                  )}
                                </td>
                              </tr>
                              {order.wholeShareReview && (
                                <tr className="bg-amber-50/40">
                                  <td colSpan={23} className="px-4 pb-4 pt-2">
                                    <WholeShareTrimChoice
                                      symbol={order.symbol}
                                      choice={order.wholeShareReview}
                                      locked={placing || isSubmitted || isPlaced}
                                      onChoose={choice => onWholeShareChoice?.(order.id, choice)}
                                    />
                                  </td>
                                </tr>
                              )}
                              </Fragment>
                              );
                            })}
                            {group.review.map(({ row, stock, action, units, amount }) => {
                              const fullStock = allocationUniverse.find(item => stockIdentity(item.stock.symbol, item.stock.exchange) === row.listing)?.stock;
                              return <tr key={row.listing} data-display-only="true">
                                <td className="px-4"><input type="checkbox" disabled aria-label={row.listing + " review only"} /></td>
                                <td className="whitespace-nowrap px-4 py-3"><div className="inline-flex items-center">
                                  {isZerodhaPreview && <StockDetailsButton stock={fullStock ?? {
                                    key: row.listing, symbol: row.symbol, exchange: row.exchange, rows: [], swingScanEntries: [],
                                    representative: {"Stock Symbol":row.symbol, "Stock Name":row.name, "Exchange Symbol":row.exchange},
                                  }} savedFinal={row} formulaConfig={formulaConfig} market={tradingViewMarket} technicalScan={null}
                                    detailsData={detailsData} historicalRows={historicalRows} />}
                                  <div><strong>{row.listing}</strong><small className="block">{row.name}</small></div></div></td>
                                <td className="whitespace-nowrap px-4 py-3">{renderSavedScore(row)}</td>
                                <td>—</td><td>{row.action ?? "Unavailable"}</td><td>{draftDirection(action) ?? (action === "Hold" ? "Hold" : "—")}</td>
                                {displayCalculations.cells(stock)}
                                <td className="whitespace-nowrap px-4 py-3 text-slate-700">
                                  {isZerodhaPreview ? (
                                    <BasketDraftUnits symbol={row.symbol} action={action} units={units}
                                      onChange={value => setManualDraftUnits(current => ({ ...current, [row.listing]: value }))}>
                                      {displayCalculations.units(stock, "Units action", units)}
                                    </BasketDraftUnits>
                                  ) : "—"}
                                </td>
                                <td>—</td>{providerPriceCell(row.symbol, row.exchange)}
                                <td>—</td><td>—</td>
                                <td className="whitespace-nowrap px-4 py-3">{isZerodhaPreview ? formatBasketCurrency(amount, basketCurrency) : "—"}</td>
                                <td className="px-4 py-3">{isZerodhaPreview ? "Market" : "—"}</td>
                                <td className="px-4 text-xs">{row.sizing_reason ?? "Review only"}</td>
                              </tr>;
                            })}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                  </BasketColumnTable>
              </div>
            </>
          ) : (
            error ? (
              <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                {error}
              </div>
            ) : (
              <div className="rounded-2xl border border-dashed border-slate-200 bg-slate-50 px-4 py-12 text-center text-sm text-slate-500">
                No Sell All, Trim, Add more, or Buy New {basketBrokerLabel} actionables are available yet.
              </div>
            )
          )}
        </div>

        <div className="sticky bottom-0 z-10 flex shrink-0 items-end gap-3 border-t border-slate-200 bg-white p-4 sm:p-5">
          {!isZerodhaPreview ? <div className="min-w-0 rounded-2xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-800">
            Review selected US stock quantities and USD amounts before confirming the final basket.
          </div> : null}
          {orderBlockers.length ? <details id={orderBlockersId} className="min-w-0 flex-1 text-sm text-amber-800"><summary>Why Place Order is unavailable</summary><ul tabIndex={0} aria-label="Blocking order checks" className="mt-2 max-h-40 overflow-y-auto">{orderBlockers.map((reason, index) => <li key={`${index}:${reason}`} className="grid grid-cols-[minmax(0,1fr)_minmax(5rem,1fr)] gap-3 py-1"><span>{reason}</span><strong>{issuesByReason.has(reason) ? issuesByReason.get(reason)!.size === selectedOrders.length ? "All" : Array.from(issuesByReason.get(reason)!).join(", ") : selectedOrders.length ? "All" : "—"}</strong></li>)}</ul></details> : null}
          {renderPlaceOrderButton("ml-auto self-end justify-center")}
        </div>

        <ScoreMatrixModal
          detail={selectedMatrixDetail}
          formulaConfig={formulaConfig}
          onFormulaConfigChange={onFormulaConfigChange}
          onClose={() => setSelectedMatrixDetail(null)}
        />
        </div>
      </div>
    </div>
    {displayCalculations.renderPopup(netPurchases)}
    {unitsDetailOrder ? <BasketUnitsPopup row={unitsDetailOrder} broker={basketBrokerLabel} onClose={() => setUnitsDetailId(null)} /> : null}
    {renameColumn ? <BasketColumnRename key={renameColumn} id={renameColumn} name={columnNames[renameColumn] ?? renameColumn} onSave={name => columnPreferences?.rename?.(renameColumn, name)} onClose={() => setRenameColumn(null)} /> : null}
    {columnMenu ? <BasketColumnPicker covered={Boolean(renameColumn)} labels={columnMenu} hidden={hiddenColumns} order={columnPreferences?.order} names={columnNames} onReorder={columnPreferences?.reorder} onRequestRename={setRenameColumn} onToggle={label => columnPreferences ? columnPreferences.toggle(label) : setHiddenColumns(current => current.includes(label) ? current.filter(value => value !== label) : [...current, label])} onClose={() => setColumnMenu(null)} /> : null}
    </>
  );
}


function summarizeInputError(error: string) {
  const normalized = error.replace(/\s+/g, " ").trim();
  const partialMatch = normalized.match(
    /returned partial rebalance table \(missing (\d+) current portfolio holding row\(s\)/i,
  );
  if (partialMatch) {
    return `Partial rebalance table: missing ${partialMatch[1]} holding row${
      partialMatch[1] === "1" ? "" : "s"
    }.`;
  }

  const malformedMatch = normalized.match(/returned (malformed table output \([^)]*\))/i);
  if (malformedMatch) return malformedMatch[1];

  const firstSentence = normalized.match(/^(.{1,140}?[.!?])(?:\s|$)/)?.[1];
  if (firstSentence) return firstSentence;
  return normalized.length > 140 ? `${normalized.slice(0, 137)}…` : normalized;
}

function InputErrorPreview({ error }: { error: string | null }) {
  if (!error) return <span className="text-slate-400">—</span>;

  const summary = summarizeInputError(error);
  if (summary === error) {
    return <span className="text-red-700">{summary}</span>;
  }

  return (
    <details className="group max-w-xs text-red-700">
      <summary className="cursor-pointer list-none text-xs font-semibold leading-5 underline decoration-red-300 underline-offset-2 hover:text-red-800 focus:outline-none focus:ring-2 focus:ring-red-300">
        {summary} <span className="font-bold text-red-500">Details</span>
      </summary>
      <div className="mt-2 max-h-36 overflow-auto whitespace-pre-wrap rounded-lg border border-red-100 bg-red-50 p-2 text-xs leading-5 text-red-700">
        {error}
      </div>
    </details>
  );
}


function InputSelectionDialog({
  open,
  stage,
  candidates,
  selectedIds,
  usdInrRate,
  loading,
  error,
  onToggle,
  onToggleAll,
  onResetDefaults,
  onClose,
}: {
  open: boolean;
  stage: InputSelectionStage | null;
  candidates: InputSelectionCandidate[];
  selectedIds: Set<string>;
  usdInrRate: number;
  loading: boolean;
  error: string | null;
  onToggle: (id: string) => void;
  onToggleAll: () => void;
  onResetDefaults: () => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const selectAllRef = useRef<HTMLInputElement | null>(null);
  const [expandedRunKeys, setExpandedRunKeys] = useState<Set<string>>(() => new Set());
  const allSelected =
    candidates.length > 0 &&
    candidates.every((candidate) => selectedIds.has(candidate.id));
  const someSelected = candidates.some((candidate) =>
    selectedIds.has(candidate.id),
  );
  const selectedCount = candidates.filter((candidate) =>
    selectedIds.has(candidate.id),
  ).length;

  const runGroups = useMemo(() => {
    const groups = new Map<
      string,
      {
        key: string;
        runId: number | null;
        title: string;
        timestamp: string | null;
        market?: SwingTradeMarket;
        candidates: InputSelectionCandidate[];
      }
    >();

    candidates.forEach((candidate) => {
      const key = candidate.run ? `run:${candidate.run.id}` : candidate.id;
      const existing = groups.get(key);
      if (existing) {
        existing.candidates.push(candidate);
        existing.market = existing.market ?? candidate.market;
        if (
          candidate.timestamp &&
          (!existing.timestamp || parseTimestampMs(candidate.timestamp) > parseTimestampMs(existing.timestamp))
        ) {
          existing.timestamp = candidate.timestamp;
        }
        return;
      }

      groups.set(key, {
        key,
        runId: candidate.run?.id ?? null,
        title: candidate.run ? getAutoRebalanceRunDisplayLabel(candidate.run) : candidate.jobNo,
        timestamp: candidate.timestamp,
        market: candidate.market,
        candidates: [candidate],
      });
    });

    return Array.from(groups.values()).sort((left, right) => {
      const leftIsUpcoming = left.candidates.some((candidate) => candidate.source === "next");
      const rightIsUpcoming = right.candidates.some((candidate) => candidate.source === "next");
      if (leftIsUpcoming !== rightIsUpcoming) return leftIsUpcoming ? -1 : 1;
      return parseTimestampMs(right.timestamp) - parseTimestampMs(left.timestamp);
    });
  }, [candidates]);

  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someSelected && !allSelected;
    }
  }, [allSelected, someSelected]);

  if (!open || !stage) return null;

  const titleByStage: Record<InputSelectionStage, string> = {
    threats: `Select ${getStageTileLabel("threats")} inputs`,
    swing: `Select ${getStageTileLabel("swing")} inputs`,
    rebalance: `Select ${getStageTileLabel("rebalance")} inputs`,
    technical: `Select ${getStageTileLabel("technical")} inputs`,
    actionables: `Select ${getStageTileLabel("actionables")} inputs`,
  };
  const rationaleByStage: Record<InputSelectionStage, string> = {
    threats:
      threatInputRationale(candidates, selectedIds, loading, error),
    swing:
      "Swing Scan discovers contenders using the selected market and swing prompt. The next stage assesses threats across holdings and contenders.",
    rebalance:
      "Default: only the upcoming Swing output from this workflow. Saved Swing jobs are included only when you explicitly select them. Opening this picker never changes your choices. Latest saved stage outputs are shown with their timestamps, including scans from before the latest market close.",
    technical:
      "Default: only the upcoming Rebalance output from this workflow. Select saved Rebalance jobs explicitly if needed; no latest-run fallback is added.",
    actionables:
      "Final Actionables freezes the Technical output generated in this workflow and its exact Rebalance inputs. Run Technical and Final Actionables together; saved historical outputs are not substituted.",
  };

  const toggleRunGroup = (groupCandidates: InputSelectionCandidate[]) => {
    const groupAllSelected = groupCandidates.every((candidate) => selectedIds.has(candidate.id));
    groupCandidates.forEach((candidate) => {
      if (groupAllSelected ? selectedIds.has(candidate.id) : !selectedIds.has(candidate.id)) {
        onToggle(candidate.id);
      }
    });
  };

  return (
    <ModelPickerDialogFrame enabled title={titleByStage[stage]} titleId={titleId} onClose={onClose}
      overlayClassName="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/50 p-4 backdrop-blur-sm"
      panelClassName={cn("flex max-h-[90vh] w-full max-w-5xl flex-col overflow-hidden rounded-[28px] shadow-2xl", stage === "threats" ? "border border-slate-300 bg-[#f5f4fc]" : "bg-white")}>
        <div className="flex shrink-0 items-start justify-between gap-3 px-4 pb-3 pt-4 sm:px-6 sm:pb-4 sm:pt-6">
          <div>
            <h3 id={titleId} className="text-xl font-extrabold sm:text-2xl tracking-tight text-slate-950">
              {titleByStage[stage]}
            </h3>
            <p className="mt-2 text-sm text-slate-500 sm:text-base">
              Choose which previous-stage outputs should be included in the next
              prompt.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close input selection"
          >
            <X className="size-5" />
          </button>
        </div>
        <div className="mx-4 mb-3 flex shrink-0 flex-wrap sm:mx-6 sm:mb-4 items-center justify-between gap-3 rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-900 sm:px-4 sm:py-3">
          {stage === "threats" ? <InputEvidenceSummary candidates={candidates} selectedIds={selectedIds} loading={loading} error={error} /> : <span>{selectedCount} output{selectedCount === 1 ? "" : "s"} selected.</span>}
          <div className="flex items-center gap-3">
            <label className="flex items-center gap-2 text-xs font-extrabold uppercase tracking-[0.18em] text-blue-950">
              <input
                ref={selectAllRef}
                type="checkbox"
                checked={allSelected}
                onChange={onToggleAll}
                aria-label="Select or deselect all inputs"
              />
              Select all
            </label>
            <button
              type="button"
              onClick={onResetDefaults}
              className="rounded-full border border-slate-300 bg-white px-5 py-2 text-xs font-extrabold uppercase tracking-[0.18em] text-slate-900 shadow-sm hover:bg-slate-50"
            >
              Reset defaults
            </button>
          </div>
        </div>
        <div className="mx-4 min-h-0 flex-1 overflow-auto rounded-2xl border border-slate-200 bg-slate-50/60 p-2 sm:mx-6 sm:p-3">
          <div className="mb-3 max-w-3xl rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm leading-5 sm:px-4 sm:py-3 sm:leading-6 text-amber-900">
            <span className="font-extrabold">Input selection rationale:</span>{" "}
            {rationaleByStage[stage]}
          </div>
          {stage === "threats" ? <InputEvidenceRows candidates={candidates} selectedIds={selectedIds} loading={loading} error={error} onToggle={onToggle} formatTimestamp={formatTimestamp} formatCost={(value) => formatUsdAsVerifiedInr(value, usdInrRate)} /> : loading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Loading eligible
              outputs…
            </div>
          ) : candidates.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-white p-8 text-sm text-slate-500">
              No eligible outputs are available yet.
            </div>
          ) : (
            <div className="space-y-3">
              {runGroups.map((group) => {
                const groupSelectedCount = group.candidates.filter((candidate) => selectedIds.has(candidate.id)).length;
                const groupAllSelected = groupSelectedCount === group.candidates.length;
                const expanded = expandedRunKeys.has(group.key);
                const statusSummary = Array.from(new Set(group.candidates.map((candidate) => candidate.status || "unknown"))).join(", ");
                const totalCostUsd = group.candidates.reduce(
                  (total, candidate) => total + (typeof candidate.costUsd === "number" ? candidate.costUsd : 0),
                  0,
                );

                return (
                  <div key={group.key} className="rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-wrap items-center gap-3 px-4 py-3">
                      <input
                        type="checkbox"
                        checked={groupAllSelected}
                        onChange={() => toggleRunGroup(group.candidates)}
                        aria-label={`Select all LLM jobs in ${group.title}`}
                      />
                      <button
                        type="button"
                        onClick={() =>
                          setExpandedRunKeys((current) => {
                            const next = new Set(current);
                            if (next.has(group.key)) next.delete(group.key);
                            else next.add(group.key);
                            return next;
                          })
                        }
                        className="flex items-center gap-2 rounded-full px-2 py-1 text-left font-extrabold text-slate-950 hover:bg-slate-100"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? "Collapse" : "Expand"} ${group.title} LLM job details`}
                      >
                        {expanded ? <ChevronDown className="size-4" /> : <ChevronRight className="size-4" />}
                      </button>
                      {group.runId ? (
                        <Link
                          href={URLs.routes.console.runDetail(group.runId)}
                          className="font-extrabold text-slate-950 underline-offset-4 hover:text-blue-700 hover:underline"
                        >
                          {group.title}
                        </Link>
                      ) : (
                        <span className="font-extrabold text-slate-950">{group.title}</span>
                      )}
                      <span
                        className={cn(
                          "rounded-full border px-3 py-1 text-xs font-extrabold uppercase tracking-[0.14em]",
                          getInputMarketBadgeClass(group.market),
                        )}
                        title={`Scan market: ${getInputMarketLabel(group.market)}`}
                      >
                        {getInputMarketLabel(group.market)}
                      </span>
                      <span className="rounded-full bg-blue-50 px-3 py-1 text-xs font-bold text-blue-800">
                        {groupSelectedCount}/{group.candidates.length} LLM job{group.candidates.length === 1 ? "" : "s"} selected
                      </span>
                      <span className="text-sm text-slate-500">
                        {group.timestamp ? formatTimestamp(group.timestamp) : "Reserved for next output"}
                      </span>
                      <span className="text-sm capitalize text-slate-500">{statusSummary}</span>
                      <span className="ml-auto text-sm font-semibold text-slate-600">
                        {totalCostUsd > 0 ? formatUsdAsVerifiedInr(totalCostUsd, usdInrRate) : "Cost n/a"}
                      </span>
                    </div>
                    {expanded ? (
                      <div className="border-t border-slate-100 px-4 pb-4 pt-2">
                        <table className="w-full min-w-[760px] text-left text-sm">
                          <thead className="text-xs font-extrabold uppercase tracking-wide text-slate-500">
                            <tr>
                              <th className="w-10 py-2 pr-3">Select</th>
                              <th className="px-3 py-2">Job</th>
                              <th className="px-3 py-2">Timestamp</th>
                              <th className="px-3 py-2">Status</th>
                              <th className="px-3 py-2">Market</th>
                              <th className="px-3 py-2">LLM / Source</th>
                              <th className="px-3 py-2">Cost (INR)</th>
                              <th className="px-3 py-2">Error</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {group.candidates.map((candidate) => (
                              <tr key={candidate.id} className={candidate.source === "next" ? "bg-blue-50/60" : "bg-white"}>
                                <td className="py-3 pr-3 align-top">
                                  <input
                                    type="checkbox"
                                    checked={selectedIds.has(candidate.id)}
                                    onChange={() => onToggle(candidate.id)}
                                    aria-label={`Select ${candidate.label}`}
                                  />
                                </td>
                                <td className="px-3 py-3 align-top font-semibold text-slate-900">{candidate.jobNo}</td>
                                <td className="px-3 py-3 align-top text-slate-600">
                                  {candidate.timestamp ? formatTimestamp(candidate.timestamp) : "Reserved for next output"}
                                </td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full px-2 py-1 text-xs font-semibold capitalize ring-1", getInputStatusBadgeClass(candidate.status))}>
                                    {candidate.status}
                                  </span>
                                </td>
                                <td className="px-3 py-3 align-top">
                                  <span className={cn("rounded-full border px-2 py-1 text-xs font-bold", getInputMarketBadgeClass(candidate.market))}>
                                    {getInputMarketLabel(candidate.market)}
                                  </span>
                                </td>
                                <td className="px-3 py-3 align-top text-slate-700">{candidate.label}</td>
                                <td className="px-3 py-3 align-top text-slate-600">
                                  {typeof candidate.costUsd === "number"
                                    ? formatUsdAsVerifiedInr(candidate.costUsd, usdInrRate)
                                    : "n/a"}
                                </td>
                                <td className="max-w-xs px-3 py-3 align-top text-xs"><InputErrorPreview error={candidate.error} /></td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </div>
                );
              })}
            </div>
          )}
        </div>
        <div className="flex shrink-0 justify-end px-4 py-3 sm:px-6 sm:py-5">
          <Button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-950 px-7 font-extrabold uppercase tracking-[0.18em] text-white hover:bg-slate-800"
          >
            Done
          </Button>
        </div>
    </ModelPickerDialogFrame>
  );
}

function AutoRebalanceCostHistoryDialog({
  open,
  portfolio,
  groups,
  loading,
  error,
  usdInrRate,
  onClose,
}: {
  open: boolean;
  portfolio: WorkflowPortfolio | null;
  groups: AutoRebalanceScanGroup[];
  loading: boolean;
  error: string | null;
  usdInrRate: number;
  selectedGroup: AutoRebalanceScanGroup | null;
  onSelectGroup: (group: AutoRebalanceScanGroup) => void;
  onClose: () => void;
  onCloseBreakdown: () => void;
}) {
  const reviewDialog = useReviewDialog<HTMLDivElement>(open, onClose);
  const [collapsedRunIds, setCollapsedRunIds] = useState<Set<string>>(() => new Set());
  const [collapsedStageKeys, setCollapsedStageKeys] = useState<Set<string>>(() => new Set());

  if (!open || !portfolio) return null;
  const title = portfolio === "zerodha" ? "Zerodha scan cost history" : "INDmoney US scan cost history";
  return (
    <div className="fixed inset-0 z-50 flex justify-end bg-slate-950/50 p-4 backdrop-blur-sm" onClick={onClose}>
      <div {...reviewDialog} role="dialog" aria-modal="true" aria-label={title} className="flex h-full w-full max-w-4xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-start justify-between gap-4 border-b border-slate-200 p-5">
          <div>
            <p className="text-[11px] font-bold uppercase tracking-[0.2em] text-blue-600">
              Auto-rebalance history
            </p>
            <h3 className="mt-1 text-lg font-extrabold text-slate-950">{title}</h3>
            <p className="mt-1 text-sm text-slate-500">
              Each Run button press is tracked as an independent India or IndMoney US run.
              Each run section is split by stage, and each stage can list one or many LLM/source rows.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full p-1 text-slate-400 hover:bg-slate-100 hover:text-slate-700"
            aria-label="Close auto-rebalance cost history"
          >
            <X className="size-5" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto p-5">
          {loading ? (
            <div className="flex items-center justify-center gap-2 rounded-2xl border border-slate-200 bg-slate-50 py-12 text-sm text-slate-500">
              <Loader2 className="size-4 animate-spin" /> Loading runs…
            </div>
          ) : error ? (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">{error}</div>
          ) : groups.length === 0 ? (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4 text-sm text-slate-500">
              No previous runs were found for this portfolio yet.
            </div>
          ) : (
            <div className="space-y-4">
              {groups.map((group) => {
                const runCollapsed = collapsedRunIds.has(group.id);

                return (
                  <section key={group.id} className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="flex flex-col gap-3 border-b border-slate-200 bg-slate-50/70 p-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="flex items-start gap-3">
                        <button
                          type="button"
                          onClick={() => {
                            setCollapsedRunIds((current) => {
                              const next = new Set(current);
                              if (next.has(group.id)) next.delete(group.id);
                              else next.add(group.id);
                              return next;
                            });
                          }}
                          className="mt-0.5 rounded-full p-1 text-slate-500 hover:bg-white hover:text-blue-700"
                          aria-expanded={!runCollapsed}
                          aria-label={`${runCollapsed ? "Expand" : "Collapse"} ${group.label}`}
                        >
                          {runCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                        </button>
                        <div>
                          <h4 className="text-sm font-extrabold text-slate-950">
                            {group.label} · {formatTimestamp(group.timestamp)}
                          </h4>
                          <p className="mt-1 text-xs text-slate-500">
                            {group.items.length} cost item{group.items.length === 1 ? "" : "s"} · {group.items.reduce((total, item) => total + item.llmCount, 0)} LLM job{group.items.reduce((total, item) => total + item.llmCount, 0) === 1 ? "" : "s"}
                          </p>
                        </div>
                      </div>
                      <div className="text-left sm:text-right">
                        <p className="text-base font-extrabold text-emerald-700">
                          {formatRebalanceCost(sumRebalanceCosts(group.items, usdInrRate))}
                        </p>
                        <p className="mt-1 text-[11px] font-bold uppercase tracking-[0.14em] text-slate-400">
                          Total incurred
                        </p>
                      </div>
                    </div>

                    {!runCollapsed ? (
                      <div className="overflow-x-auto">
                        <table className="min-w-full divide-y divide-slate-200 text-sm">
                          <thead className="bg-white text-left text-[11px] font-bold uppercase tracking-[0.14em] text-slate-500">
                            <tr>
                              <th className="px-4 py-3">Job No</th>
                              <th className="px-4 py-3">Stage/Scan</th>
                              <th className="px-4 py-3">LLM / Source</th>
                              <th className="px-4 py-3">Timestamp</th>
                              <th className="px-4 py-3 text-right">Cost</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100 bg-white">
                            {groupAutoRebalanceItemsByStage(group.items).map((section) => {
                              const sectionKey = `${group.id}:${section.stage}`;
                              const sectionCollapsed = collapsedStageKeys.has(sectionKey);
                              const showSectionCost =
                                section.stage === "swing" || section.stage === "rebalance";

                              return (
                                <Fragment key={sectionKey}>
                                  <tr className="bg-blue-50/70">
                                    <td colSpan={5} className="px-4 py-2 text-[11px] font-extrabold uppercase tracking-[0.18em] text-blue-700">
                                      <span className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                                        <button
                                          type="button"
                                          onClick={() => {
                                            setCollapsedStageKeys((current) => {
                                              const next = new Set(current);
                                              if (next.has(sectionKey)) next.delete(sectionKey);
                                              else next.add(sectionKey);
                                              return next;
                                            });
                                          }}
                                          className="flex items-center gap-2 text-left hover:text-blue-900"
                                          aria-expanded={!sectionCollapsed}
                                          aria-label={`${sectionCollapsed ? "Expand" : "Collapse"} ${formatAutoRebalanceStageLabel(section.stage)} rows`}
                                        >
                                          {sectionCollapsed ? <ChevronRight className="size-4" /> : <ChevronDown className="size-4" />}
                                          <span>{formatAutoRebalanceStageLabel(section.stage)}</span>
                                        </button>
                                        {showSectionCost ? (
                                          <span className="text-emerald-700">
                                            Cumulative cost:{" "}
                                            {formatRebalanceCost(sumRebalanceCosts(section.items, usdInrRate))}
                                          </span>
                                        ) : null}
                                      </span>
                                    </td>
                                  </tr>
                                  {!sectionCollapsed
                                    ? section.items.map((item) => {
                                        const runHref = getAutoRebalanceItemRunHref(item);
                                        const llmHref = getAutoRebalanceItemLlmHref(item);
                                        return (
                                          <tr key={item.id} className="align-top">
                                            <td className="whitespace-nowrap px-4 py-3 font-semibold text-slate-700">
                                              <AutoRebalanceCostLink href={runHref}>
                                                {getAutoRebalanceItemJobNumber(item)}
                                              </AutoRebalanceCostLink>
                                            </td>
                                            <td className="px-4 py-3">
                                              <AutoRebalanceCostLink href={runHref} className="font-bold text-slate-950">
                                                {formatAutoRebalanceStageLabel(item.stage)}
                                              </AutoRebalanceCostLink>
                                              <p className="mt-1 text-xs capitalize text-slate-500">{item.status || "unknown"}</p>
                                            </td>
                                            <td className="min-w-56 px-4 py-3">
                                              <AutoRebalanceCostLink href={llmHref} className="font-semibold text-blue-700">
                                                {item.provider}/{item.model}
                                              </AutoRebalanceCostLink>
                                              <p className="mt-1 text-xs text-slate-500">
                                                {item.runId ? (item.jobId ? `Output section for job #${item.jobId}` : "Run-level source") : "Standalone source job"}
                                              </p>
                                            </td>
                                            <td className="whitespace-nowrap px-4 py-3 text-slate-600">{formatTimestamp(item.timestamp)}</td>
                                            <td className="whitespace-nowrap px-4 py-3 text-right font-extrabold text-emerald-700">
                                              {formatInrCostFromUsd(item.costUsd, usdInrRate)}
                                            </td>
                                          </tr>
                                        );
                                      })
                                    : null}
                                </Fragment>
                              );
                            })}
                          </tbody>
                        </table>
                      </div>
                    ) : null}
                  </section>
                );
              })}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function StageLlmSelectorDialog({
  open,
  stage,
  portfolio,
  providers,
  selectedKeys,
  onToggle,
  onSelectAll,
  onClear,
  onResetDefaults,
  onReplaceSelection,
  selectedMultipliers,
  onMultiplierChange,
  onClose,
  lastRunCostInr,
  historicalEstimatedCostInrByTarget = {},
  loading = false,
  error = null,
  onRetry, saving = false, saveError, onImportPrevious,
}: {
  saving?: boolean;
  saveError?: string | null;
  onImportPrevious?: () => void;
  open: boolean;
  stage: WorkflowStageKey | null;
  portfolio: WorkflowPortfolio | null;
  providers: ProviderInfo[];
  selectedKeys: Set<string>;
  onToggle: (key: string) => void;
  onSelectAll: () => void;
  onClear: () => void;
  onResetDefaults: () => void;
  onReplaceSelection: (keys: Set<string>) => void;
  selectedMultipliers: Record<string, number>;
  onMultiplierChange: (key: string, nextValue: number) => void;
  onClose: () => void;
  lastRunCostInr?: number | null;
  historicalEstimatedCostInrByTarget?: HistoricalLlmCostMapInr;
  loading?: boolean;
  error?: string | null;
  onRetry?: () => void;
}) {
  const [savedMixes, setSavedMixes] = useState<SavedModelMix[]>(() =>
    readSavedModelMixes(),
  );
  const [selectedMixId, setSelectedMixId] = useState("");
  const selectorTitleId = useId();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [historyEntries, setHistoryEntries] = useState<StageLlmHistoryEntry[]>([]);
  const [historyKey, setHistoryKey] = useState("");
  const { rate: usdInrRate } = useRebalanceCostQuote();
  const currentHistoryKey = stage && portfolio ? `${portfolio}:${stage}` : "";
  const activeHistoryOpen = historyOpen && historyKey === currentHistoryKey;
  const hasLastRunCost =
    typeof lastRunCostInr === "number" &&
    Number.isFinite(lastRunCostInr) &&
    lastRunCostInr > 0;
  const selectorScanLabel = stage
    ? getLlmSelectorScanLabel(stage, portfolio)
    : "this scan";
  const selectorTitle = stage
    ? getLlmSelectorTitle(stage, portfolio, lastRunCostInr)
    : "Select LLMs";
  const loadHistory = useCallback(async () => {
    if (!stage || !portfolio || !currentHistoryKey) return;
    if (historyKey === currentHistoryKey) {
      setHistoryOpen((current) => !current);
      if (historyEntries.length > 0) return;
    } else {
      setHistoryKey(currentHistoryKey);
      setHistoryEntries([]);
      setHistoryError(null);
      setHistoryOpen(true);
    }
    setHistoryLoading(true);
    setHistoryError(null);
    try {
      const runs = await fetchAllFullRuns();
      setHistoryEntries(buildStageLlmHistoryEntries(runs, stage, portfolio).slice(0, 60));
    } catch (error) {
      setHistoryError(normalizeError(error));
    } finally {
      setHistoryLoading(false);
    }
  }, [currentHistoryKey, historyEntries.length, historyKey, portfolio, stage]);

  const persistSavedMixes = useCallback((mixes: SavedModelMix[]) => {
    setSavedMixes(mixes);
    try {
      window.localStorage.setItem(MODEL_MIX_STORAGE_KEY, JSON.stringify(mixes));
    } catch {
      // Keep selector usable even when localStorage is unavailable.
    }
  }, []);

  const getEstimatedCostInr = useCallback(
    (providerName: string, model: string) => {
      const override = historicalEstimatedCostInrByTarget[`${providerName}::${model}`];
      if (typeof override === "number" && Number.isFinite(override)) {
        return override;
      }
      return providers.find((provider) => provider.name === providerName)
        ?.model_estimated_cost_inr?.[model];
    },
    [historicalEstimatedCostInrByTarget, providers],
  );

  if (!open || !stage) return null;

  const organizedPicker = isCard(stage);
  const singleJob = usesSingleScorecardJob(stage, portfolio);
  const singleSelect = singleJob || stage === "threats" || stage === "technical";
  const compatibleTargets = new Set(
    providers.flatMap((provider) =>
      provider.models
        .filter(
          (model) =>
            provider.configured &&
            provider.model_compatibility?.[model]?.compatible !== false,
        )
        .map((model) => `${provider.name}::${model}`),
    ),
  );
  const modelMixControls = (
    <LlmModelMixControls
      mixes={savedMixes}
      selectedMixId={selectedMixId}
      onApply={(id) => {
        if (!id || id === "none") {
          setSelectedMixId("");
          return;
        }
        const mix = savedMixes.find((item) => item.id === id);
        if (!mix) return;
        const filteredTargets = mix.targets.filter((target) =>
          compatibleTargets.has(target),
        );
        if (filteredTargets.length < mix.targets.length) {
          window.alert(
            "Some models in this mix are incompatible with current API access and were skipped.",
          );
        }
        if (singleSelect) {
          onReplaceSelection(new Set(filteredTargets.slice(0, 1)));
        } else {
          onReplaceSelection(new Set(filteredTargets));
        }
        setSelectedMixId(id);
      }}
      onSave={() => {
        const name = window.prompt("Name this model mix:");
        if (!name) return;
        const cleaned = name.trim();
        if (!cleaned) return;
        const targets = Array.from(selectedKeys);
        if (targets.length === 0) {
          window.alert("Select at least one model before saving a mix.");
          return;
        }
        const now = new Date().toISOString();
        const existing = savedMixes.find(
          (mix) => mix.name.toLowerCase() === cleaned.toLowerCase(),
        );
        if (existing) {
          const updated = { ...existing, name: cleaned, targets, updated_at: now };
          persistSavedMixes(
            savedMixes.map((mix) => (mix.id === existing.id ? updated : mix)),
          );
          setSelectedMixId(existing.id);
          return;
        }
        const created = {
          id: `mix_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`,
          name: cleaned,
          targets,
          updated_at: now,
        };
        persistSavedMixes([created, ...savedMixes]);
        setSelectedMixId(created.id);
      }}
      onEdit={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (!current) return;
        const name = window.prompt("Edit model mix name:", current.name);
        if (!name?.trim()) return;
        persistSavedMixes(
          savedMixes.map((mix) =>
            mix.id === selectedMixId
              ? { ...mix, name: name.trim(), updated_at: new Date().toISOString() }
              : mix,
          ),
        );
      }}
      onDelete={() => {
        if (!selectedMixId) return;
        const current = savedMixes.find((mix) => mix.id === selectedMixId);
        if (!window.confirm(`Delete model mix "${current?.name || selectedMixId}"?`)) {
          return;
        }
        persistSavedMixes(savedMixes.filter((mix) => mix.id !== selectedMixId));
        setSelectedMixId("");
      }}
    />
  );

  return (
    <ModelPickerDialogFrame enabled title={selectorTitle} titleId={selectorTitleId} onClose={onClose}>
        <div className={cn("flex items-start justify-between gap-4 border-b border-slate-200 px-6 py-5", organizedPicker && "shrink-0 px-4 py-3 sm:px-6")}>
          <div>
            <p id={selectorTitleId} className="text-xs font-semibold uppercase tracking-[0.18em] text-blue-600">
              {selectorTitle}
            </p>
            <h3 className="mt-1 text-xl font-bold text-slate-950">
              {getStageLabel(stage, "idle")}
            </h3>
            {stage === "threats" ? <p className="mt-2 text-sm text-slate-600">{STAGE_METADATA[stage].tileDescription}</p> : null}
            <p className="mt-1 text-sm text-slate-500">
              {singleJob ? "Choose one model. All assignments for this scorecard run in one job." : "Choose the provider/model targets this dashboard stage should use."}
            </p>
            {hasLastRunCost ? (
              <p className="mt-2 inline-flex rounded-full bg-emerald-50 px-3 py-1 text-sm font-semibold text-emerald-700 ring-1 ring-emerald-100">
                Last {selectorScanLabel} cost incurred: {formatInrCost(lastRunCostInr)}
              </p>
            ) : null}
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={loadHistory}
              className={cn(
                "rounded-full p-2 text-slate-500 hover:bg-blue-50 hover:text-blue-700",
                activeHistoryOpen ? "bg-blue-50 text-blue-700 ring-1 ring-blue-200" : "",
              )}
              aria-label={`Show LLM run history for ${selectorTitle}`}
              title={`${selectorTitle} run history`}
            >
              <History className="size-5" />
            </button>
            <button
              type="button"
              onClick={() => {
                setHistoryOpen(false);
                onClose();
              }}
              className="rounded-full p-2 text-slate-500 hover:bg-slate-100 hover:text-slate-900"
              data-dialog-initial-focus
              aria-label="Close LLM selector"
            >
              <X className="size-5" />
            </button>
          </div>
        </div>

        <div className={cn("flex-1 overflow-y-auto px-6 py-5", organizedPicker && "min-h-0 overscroll-contain px-4 py-4 sm:px-6")}>
          {activeHistoryOpen ? (
            <div className="mb-5 rounded-2xl border border-blue-100 bg-blue-50/50 p-4">
              <div className="mb-3 flex items-center justify-between gap-3">
                <div>
                  <h4 className="text-sm font-extrabold uppercase tracking-[0.16em] text-blue-900">LLM run history</h4>
                  <p className="mt-1 text-xs text-slate-600">Click any LLM tile to open that job on the run details page.</p>
                </div>
                {historyLoading ? <Loader2 className="size-4 animate-spin text-blue-700" /> : null}
              </div>
              {historyError ? (
                <div className="rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-700">{historyError}</div>
              ) : historyLoading && historyEntries.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">Loading LLM history…</div>
              ) : historyEntries.length === 0 ? (
                <div className="rounded-xl border border-slate-200 bg-white p-4 text-sm text-slate-500">No prior LLM jobs were found for this stage.</div>
              ) : (
                <div className="grid max-h-72 gap-2 overflow-y-auto pr-1 sm:grid-cols-2">
                  {historyEntries.map((entry) => (
                    <Link
                      key={entry.id}
                      href={`${URLs.routes.console.runDetail(entry.runId)}#llm-output-job-${entry.jobId}`}
                      className="rounded-2xl border border-slate-200 bg-white p-3 text-left shadow-sm transition hover:border-blue-300 hover:shadow-md focus:outline-none focus:ring-2 focus:ring-blue-500"
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <p className="text-xs font-extrabold uppercase tracking-[0.14em] text-slate-500">Run #{entry.runId} / Job #{entry.jobId}</p>
                          <p className="mt-1 truncate text-sm font-bold text-slate-950">{entry.provider}/{entry.model}</p>
                        </div>
                        <span className={cn("rounded-full border px-2 py-0.5 text-[11px] font-bold capitalize", getRunOutputStatusClass(entry.status))}>
                          {getRunOutputStatusLabel(entry.status)}
                        </span>
                      </div>
                      <div className="mt-2 grid grid-cols-2 gap-2 text-xs text-slate-600">
                        <span>{entry.timestamp ? formatTimestamp(entry.timestamp) : "No timestamp"}</span>
                        <span>Runtime: {entry.runtime ?? "n/a"}</span>
                        <span>Cost: {formatInrCostFromUsd(entry.costUsd, usdInrRate)}</span>
                        <span>Status: {entry.rawStatus}</span>
                      </div>
                    </Link>
                  ))}
                </div>
              )}
            </div>
          ) : null}
          {error ? (
            <div className="mb-4 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800">
              <p className="font-semibold">Model settings could not be loaded.</p>
              <p className="mt-1">{error}</p>
              {onRetry ? (
                <Button
                  type="button"
                  variant="outline"
                  onClick={onRetry}
                  className="mt-3 rounded-full border-red-300 bg-white text-red-800 hover:bg-red-100"
                >
                  Retry
                </Button>
              ) : null}
            </div>
          ) : null}
          {loading && providers.length === 0 ? (
            <div className="mb-4 flex items-center gap-2 rounded-2xl border border-blue-100 bg-blue-50 p-4 text-sm text-blue-800">
              <Loader2 className="size-4 animate-spin" />
              Loading provider models…
            </div>
          ) : null}
          {saveError && <p role="alert" className="mb-3 text-sm text-red-800">{saveError}</p>}
          {saving && <p role="status" className="mb-2 text-sm">Saving model selection…</p>}
          <fieldset disabled={loading || saving || Boolean(error)} className="min-w-0">
            {onImportPrevious && <button type="button" onClick={onImportPrevious} className="mb-3 text-sm text-indigo-700 underline">Use this browser’s previous selection</button>}
            <LlmModelSelectionPanel
              organized={organizedPicker}
              loading={organizedPicker && loading}
              providers={providers}
              selectedKeys={selectedKeys}
              selectedMultipliers={singleSelect ? undefined : selectedMultipliers}
              onMultiplierChange={singleSelect ? undefined : onMultiplierChange}
              selectionMode={singleSelect ? "single" : "multiple"}
              emptyMessage={organizedPicker ? "No provider models are available. Retry when provider access is restored." : "Loading provider models..."}
              showBulkActions={!singleSelect}
              modelMixControls={modelMixControls}
              getEstimatedCostInr={getEstimatedCostInr}
              onToggle={onToggle}
              onSelectAll={singleSelect ? undefined : onSelectAll}
              onClear={singleJob ? undefined : onClear}
              costSummaryLabel="Estimated selected run"
              onToggleProvider={singleJob ? undefined : (providerName, models) => {
                const providerModelKeys = models.map(
                  (model) => `${providerName}::${model}`,
                );
                const allSelected =
                  providerModelKeys.length > 0 &&
                  providerModelKeys.every((key) => selectedKeys.has(key));
                const next = new Set(selectedKeys);
                for (const key of providerModelKeys) {
                  if (allSelected) next.delete(key);
                  else next.add(key);
                }
                onReplaceSelection(next);
              }}
            />
          </fieldset>
        </div>

        <div className={cn("flex items-center justify-between gap-3 border-t border-slate-200 px-6 py-4", organizedPicker && "shrink-0 flex-wrap px-4 py-3 sm:px-6")}>
          {organizedPicker ? <span className="text-sm font-semibold text-slate-700">{selectedKeys.size} selected</span> : null}
          <button
            type="button"
            disabled={loading || saving || Boolean(error)}
            onClick={onResetDefaults}
            className="rounded-full border border-slate-200 px-4 py-2 text-sm font-semibold text-slate-700 hover:bg-slate-50"
          >
            Reset defaults
          </button>
          <Button
            type="button"
            onClick={onClose}
            className="rounded-full bg-slate-950 text-white hover:bg-slate-800"
          >
            Done
          </Button>
        </div>
    </ModelPickerDialogFrame>
  );
}

const readLatestIndmoneySnapshot = () => apiService.indmoneyUsPortfolioOverview();

const NO_DASHBOARD_REFRESH = async () => {};

export function RebalanceWorkflowSections({
  // Standalone workflows refresh stage data and dispatch final-actionables-refresh
  // themselves; only embedded consumers need an additional dashboard refresh.
  onDashboardRefresh = NO_DASHBOARD_REFRESH,
  stageLedger = false,
  surface,
}: {
  onDashboardRefresh?: () => Promise<void>;
  stageLedger?: boolean;
  surface?: WorkflowSurface | null;
}) {
  const router = useRouter();
  const [cardEvidence, setCardEvidence] = useState<{market:WorkflowPortfolio; card:CardKey; sequence:number; tab:ScorecardTab}|null>(null);
  const [cardReview, setCardReview] = useState<{portfolio:WorkflowPortfolio;stage:CardKey|"actionables"|"source"; revision?: number; attempt?: number}|null>(null);
  const [latestIndiaWorkflow, setLatestIndiaWorkflow] = useState<AutoRebalanceHistoryItemResponse | null>(null);
  const [preparedSwing, setPreparedSwing] = useState<{ id: number; sequence: number; listings: number; snapshot_id: number; swing_job_ids: number[] } | null>(null);
  const [preparingSwing, setPreparingSwing] = useState(false);
  const [recoveryIssue, setRecoveryIssue] = useState("");
  const [sourceSelections,setSourceSelections] = useState<Partial<Record<WorkflowPortfolio,number>>>({});
  const [cardPolicies,setCardPolicies] = useState<Partial<Record<WorkflowPortfolio,CardPolicy>>>({});
  const [preflightPortfolio, setPreflightPortfolio] = useState<WorkflowPortfolio | null>(null);
  const [preflightErrors, setPreflightErrors] = useState<Partial<Record<WorkflowPortfolio, string[]>>>({});
  const [runtimeOwner] = useState(captureWorkflowOwner);
  const [zerodhaSwingSettings, setZerodhaSwingSettings] = useState(() => readZerodhaSwingSettings(runtimeOwner?.id));
  const swingPrompts = useMemo(() => ({
    zerodha: buildSwingTradePrompt("india", zerodhaSwingSettings.investmentAmount, zerodhaSwingSettings),
    indmoneyUs: buildSwingTradePrompt("us"),
  }), [zerodhaSwingSettings]);
  const apiService = useMemo(() => workflowOwnedApi(workflowApiService, runtimeOwner), [runtimeOwner]);
  const { rate: usdInrRate, verifiedRate, label: costRateLabel } = useRebalanceCostQuote();
  const { user: basketOwner } = useAuth();
  const basketSafety = useBasketSubmissionSafety(basketOwner?.id ?? null);
  const [initialPersisted] = useState<PersistedWorkflow | null>(() =>
    readPersistedWorkflow(),
  );
  const initialRunningPortfolio = useMemo(
    (): WorkflowPortfolio | null => {
      const portfolio = getRestorableRunningPortfolio(initialPersisted);
      return portfolio === "zerodha" ? null : portfolio;
    },
    [initialPersisted],
  );
  const [states, setStates] = useState<
    Record<WorkflowPortfolio, WorkflowState>
  >(() =>
    initialRunningPortfolio && initialPersisted?.states
      ? { ...initialPersisted.states, [initialRunningPortfolio]: restoreCurrentWorkflowStages(initialPersisted.states[initialRunningPortfolio]) }
      : buildInitialStates(),
  );
  const [ledgerMarket, setLedgerMarket] = useState<WorkflowPortfolio>(() => initialRunningPortfolio ?? "zerodha");
  const [ledgerView, setLedgerView] = useState<WorkflowLedgerView>("ledger");
  const [runningPortfolio, setRunningPortfolio] =
    useState<WorkflowPortfolio | null>(() => initialRunningPortfolio);
  const [dialogOpen, setDialogOpen] = useState(false);
  const [workflowHistoryError, setWorkflowHistoryError] = useState<string | null>(null);
  const [dialogError, setDialogError] = useState<string | null>(null);
  const [indMoneySyncOnly, setIndMoneySyncOnly] = useState(false);
  const [now, setNow] = useState(0);
  const [workflowPaused, setWorkflowPaused] = useState(false);
  const [analysisOnlyRuns, setAnalysisOnlyRuns] = useState<Record<WorkflowPortfolio, boolean>>({ zerodha: false, indmoneyUs: false });
  const [specificMode, setSpecificMode] = useState<
    Record<WorkflowPortfolio, boolean>
  >(() => ({
    zerodha:
      initialRunningPortfolio === "zerodha"
        ? Boolean(initialPersisted?.specificMode?.zerodha)
        : false,
    indmoneyUs:
      initialRunningPortfolio === "indmoneyUs"
        ? Boolean(initialPersisted?.specificMode?.indmoneyUs)
        : false,
  }));
  const [selectedStages, setSelectedStages] = useState<
    Record<WorkflowPortfolio, Set<WorkflowStageKey>>
  >(() => ({
    zerodha: new Set(
      initialRunningPortfolio === "zerodha"
        ? (initialPersisted?.selectedStages?.zerodha ?? [])
        : [],
    ),
    indmoneyUs: new Set(
      initialRunningPortfolio === "indmoneyUs"
        ? (initialPersisted?.selectedStages?.indmoneyUs ?? [])
        : [],
    ),
  }));
  const [selectedInputs, setSelectedInputs] = useState<
    Record<WorkflowPortfolio, Record<InputSelectionStage, Set<string>>>
  >(() => ({
    zerodha: {
      threats: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.threats ?? ["threats:next"])
          : ["threats:next"],
      ),
      swing: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.swing ?? ["swing:next"])
          : ["swing:next"],
      ),
      rebalance: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.rebalance ?? [
              "rebalance:next",
            ])
          : ["rebalance:next"],
      ),
      technical: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.technical ?? [
              "technical:next",
            ])
          : ["technical:next"],
      ),
      actionables: new Set(
        initialRunningPortfolio === "zerodha"
          ? (initialPersisted?.selectedInputs?.zerodha?.actionables ?? [
              "actionables:next",
            ])
          : ["actionables:next"],
      ),
    },
    indmoneyUs: {
      threats: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.threats ?? [
              "threats:next",
            ])
          : ["threats:next"],
      ),
      swing: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.swing ?? [
              "swing:next",
            ])
          : ["swing:next"],
      ),
      rebalance: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.rebalance ?? [
              "rebalance:next",
            ])
          : ["rebalance:next"],
      ),
      technical: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.technical ?? [
              "technical:next",
            ])
          : ["technical:next"],
      ),
      actionables: new Set(
        initialRunningPortfolio === "indmoneyUs"
          ? (initialPersisted?.selectedInputs?.indmoneyUs?.actionables ?? [
              "actionables:next",
            ])
          : ["actionables:next"],
      ),
    },
  }));
  const [savedRunCosts, setSavedRunCosts] = useState<Partial<Record<WorkflowPortfolio, StageCost & { sequence: number }>>>({});
  const [activeAutoRebalanceMetadata, setActiveAutoRebalanceMetadata] = useState<
    Partial<Record<WorkflowPortfolio, AutoRebalanceRunMetadata>>
  >(() => {
    const restored: Partial<Record<WorkflowPortfolio, AutoRebalanceRunMetadata>> = {};
    if (!initialRunningPortfolio) return restored;
    for (const portfolio of ["zerodha", "indmoneyUs"] as const) {
      if (portfolio !== initialRunningPortfolio) continue;
      const metadata = initialPersisted?.activeAutoRebalanceMetadata?.[portfolio];
      try {
        assertAutoRebalanceRunMetadata(metadata, portfolio === "zerodha" ? "india" : "indmoney_us");
        restored[portfolio] = metadata;
      } catch {
        // Invalid cached identity is ignored; saved stage output stays visible.
      }
    }
    return restored;
  });
  const [auditStates, setAuditStates] = useState<
    Partial<Record<WorkflowPortfolio, AutoRebalanceAuditState>>
  >(() => Object.fromEntries(
    Object.entries(initialPersisted?.auditStates ?? {}).flatMap(([portfolio, state]) => {
      const restored = restoreAutoRebalanceAuditState(state);
      return restored && ["zerodha", "indmoneyUs"].includes(portfolio) ? [[portfolio, restored]] : [];
    }),
  ));
  const [completionEmailWarnings, setCompletionEmailWarnings] = useState<
    Partial<Record<WorkflowPortfolio, string>>
  >({});
  const [inputDialog, setInputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: InputSelectionStage;
  } | null>(null);
  const [inputCandidates, setInputCandidates] = useState<
    InputSelectionCandidate[]
  >([]);
  const [inputCandidatesLoading, setInputCandidatesLoading] = useState(false);
  const [inputCandidatesError, setInputCandidatesError] = useState<string | null>(null);
  const [llmDialogStage, setLlmDialogStage] = useState<ModelStage | null>(null);
  const [llmDialogPortfolio, setLlmDialogPortfolio] = useState<WorkflowPortfolio | null>(
    null,
  );
  const [llmDialogProviders, setLlmDialogProviders] = useState<ProviderInfo[]>(
    [],
  );
  const [llmDialogSelectedKeys, setLlmDialogSelectedKeys] = useState<
    Set<string>
  >(new Set());
  const [llmDialogMultipliers, setLlmDialogMultipliers] = useState<Record<string, number>>({});
  const [llmDialogHistoricalCosts, setLlmDialogHistoricalCosts] =
    useState<HistoricalLlmCostMapInr>({});
  const [llmDialogLoading, setLlmDialogLoading] = useState(false);
  const [llmDialogError, setLlmDialogError] = useState<string | null>(null);
  const [savingModels, setSavingModels] = useState(false);
  const [modelSaveError, setModelSaveError] = useState<string | null>(null);
  const [legacyKeys, setLegacyKeys] = useState<string[] | null>(null);
  const pendingModelSave = useRef<Promise<void> | null>(null);
  const loadModelPreferences = useCallback(async () => {
    await pendingModelSave.current;
    return apiService.getWorkflowModels();
  }, [apiService]);
  const llmDialogRequestRef = useRef(0);
  const [costHistoryPortfolio, setCostHistoryPortfolio] = useState<WorkflowPortfolio | null>(null);
  const [stockFlowPortfolio, setStockFlowPortfolio] =
    useState<RebalanceStockFlowPortfolio | null>(null);
  const [costHistoryGroups, setCostHistoryGroups] = useState<AutoRebalanceScanGroup[]>([]);
  const [costHistoryLoading, setCostHistoryLoading] = useState(false);
  const [costHistoryError, setCostHistoryError] = useState<string | null>(null);
  const [selectedCostGroup, setSelectedCostGroup] = useState<AutoRebalanceScanGroup | null>(null);
  const [outputDialog, setOutputDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: WorkflowStageKey;
    title: string;
    body: string;
    loading: boolean;
    error: string | null;
    requestedRunId?: number;
    savedAt?: string | null;
    provenance?: string | null;
    routeUrl?: string | null;
    run?: RunResponse | null;
  } | null>(null);
  const outputRequestRef = useRef(0);
  const closeOutputDialog = useCallback(() => {
    outputRequestRef.current += 1;
    setOutputDialog(null);
    setActionablesCalculationsPortfolio(null);
  }, []);
  const [actionablesCalculationsPortfolio, setActionablesCalculationsPortfolio] =
    useState<WorkflowPortfolio | null>(null);
  const [promptDialog, setPromptDialog] = useState<{
    portfolio: WorkflowPortfolio;
    stage: PromptPreviewStage;
    title: string;
  } | null>(null);
  const [zerodhaBasketOpen, setZerodhaBasketOpen] = useState(false);
  const [zerodhaBasketLoading, setZerodhaBasketLoading] = useState(false);
  const [zerodhaBasketPlacing, setZerodhaBasketPlacing] = useState(false);
  const [zerodhaBasketSubmission, setZerodhaBasketSubmission] = useState<ZerodhaBasketSubmission | null>(null);
  const [brokerOrderBlock, setZerodhaOrderSubmissionBlockedReason] = useState<string | null>(null);
  const [zerodhaBasketError, setZerodhaBasketError] = useState<string | null>(null);
  const [zerodhaAllocationUniverse, setZerodhaAllocationUniverse] = useState<DashboardActionRow[]>([]);
  const [zerodhaBasketOrders, setZerodhaBasketOrders] = useState<ZerodhaBasketPreviewOrder[]>([]);
  const [zerodhaBasketHistoryRuns, setZerodhaBasketHistoryRuns] = useState<RunResponse[]>([]);
  const [zerodhaExecutionMode, setZerodhaExecutionMode] = useState<ZerodhaExecutionMode>("publisher_limit");
  const [zerodhaDirectMarketAvailable, setZerodhaDirectMarketAvailable] = useState(false);
  const [zerodhaBasketLtpRefreshing, setZerodhaBasketLtpRefreshing] = useState(false);
  const [zerodhaBasketLtpRefreshedAt, setZerodhaBasketLtpRefreshedAt] = useState<string | null>(null);
  const [zerodhaBasketScoreScanCompletedAt, setZerodhaBasketScoreScanCompletedAt] = useState<string | null>(null);
  const [zerodhaBasketDetailsData, setZerodhaBasketDetailsData] = useState<StockDetailsData>({
    portfolioSnapshot: null,
    eventsAnalysis: null,
    threatsAnalysis: null,
    error: null,
  });
  const { scoreMatrixFormulaConfig, setScoreMatrixFormulaConfig, zerodhaBasketBuyThreshold, setZerodhaBasketBuyThreshold, zerodhaBasketBuyThresholdDraft, setZerodhaBasketBuyThresholdDraft, indmoneyBasketBuyThreshold, setIndmoneyBasketBuyThreshold, indmoneyBasketBuyThresholdDraft, setIndmoneyBasketBuyThresholdDraft, buyThresholdSaveError, buyThresholdPersistence } = useWorkflowConfiguration();
  const [localBasketFormula, setLocalBasketFormula] = useState<ScoreMatrixFormulaConfig | null>(null);
  const basketFormula = localBasketFormula ?? scoreMatrixFormulaConfig;
  const [scoreRevision, setScoreRevision] = useState<BasketScoreRevision | null>(null);
  const [verificationIssue, setVerificationIssue] = useState<string | null>(null);
  const [verifiedBasketFormula, setVerifiedBasketFormula] = useState<string | null>(null);
  const zerodhaOrderSubmissionBlockedReason = [brokerOrderBlock, verifiedBasketFormula === canonicalBasketInputs(basketFormula) ? null :
    (verifiedBasketFormula ? "The scoring formula changed after verification." : verificationIssue ?? "Basket inputs await verification.")].filter(Boolean).join(" ") || null;
  const [selectedZerodhaBasketIds, setSelectedZerodhaBasketIds] = useState<Set<string>>(new Set());
  const [indmoneyBasketOpen, setIndmoneyBasketOpen] = useState(false);
  const [indmoneyBasketLoading, setIndmoneyBasketLoading] = useState(false);
  const [indmoneyBasketError, setIndmoneyBasketError] = useState<string | null>(null);
  const [indmoneyAllocationUniverse, setIndmoneyAllocationUniverse] = useState<DashboardActionRow[]>([]);
  const [indmoneyBasketOrders, setIndmoneyBasketOrders] = useState<ZerodhaBasketPreviewOrder[]>([]);
  const [indmoneyBasketHistoryRuns, setIndmoneyBasketHistoryRuns] = useState<RunResponse[]>([]);
  const [indmoneyBasketDetailsData, setIndmoneyBasketDetailsData] = useState<StockDetailsData>({
    portfolioSnapshot: null,
    eventsAnalysis: null,
    threatsAnalysis: null,
    error: null,
  });
  const [selectedIndmoneyBasketIds, setSelectedIndmoneyBasketIds] = useState<Set<string>>(new Set());
  const activeExecutionRefsRef = useRef<Array<{ kind: "run" | "job"; id: number }>>([]);
  const activeAutoRebalanceMetadataRef = useRef<
    Partial<Record<WorkflowPortfolio, AutoRebalanceRunMetadata>>
  >(activeAutoRebalanceMetadata);
  const auditSessionsRef = useRef<Partial<Record<WorkflowPortfolio, AutoRebalanceAuditSession>>>({});
  const cancelRequestedRef = useRef(false);
  const pauseRequestedRef = useRef(false);
  const isWorkflowExecutingRef = useRef(false);

  useEffect(() => {
    if (!isCurrentWorkflowOwner(runtimeOwner)) return;
    persistWorkflow({
      states,
      runningPortfolio,
      specificMode,
      selectedStages: {
        zerodha: Array.from(selectedStages.zerodha),
        indmoneyUs: Array.from(selectedStages.indmoneyUs),
      },
      selectedInputs: {
        zerodha: {
          threats: Array.from(selectedInputs.zerodha.threats),
          swing: Array.from(selectedInputs.zerodha.swing),
          rebalance: Array.from(selectedInputs.zerodha.rebalance),
          technical: Array.from(selectedInputs.zerodha.technical),
          actionables: Array.from(selectedInputs.zerodha.actionables),
        },
        indmoneyUs: {
          threats: Array.from(selectedInputs.indmoneyUs.threats),
          swing: Array.from(selectedInputs.indmoneyUs.swing),
          rebalance: Array.from(selectedInputs.indmoneyUs.rebalance),
          technical: Array.from(selectedInputs.indmoneyUs.technical),
          actionables: Array.from(selectedInputs.indmoneyUs.actionables),
        },
      },
      activeAutoRebalanceMetadata,
      auditStates,
      savedAt: new Date().toISOString(),
    });
  }, [runtimeOwner,
    activeAutoRebalanceMetadata,
    auditStates,
    runningPortfolio,
    selectedInputs,
    selectedStages,
    specificMode,
    states,
  ]);

  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);

  const isBusy = Boolean(preflightPortfolio) || Boolean(runningPortfolio) || isWorkflowExecutingRef.current;

  const openAutoRebalanceCostHistory = useCallback(async (portfolio: WorkflowPortfolio) => {
    setCostHistoryPortfolio(portfolio);
    setSelectedCostGroup(null);
    setCostHistoryLoading(true);
    setCostHistoryError(null);
    try {
      const [runs, threatHistory] = await Promise.all([
        fetchAllFullRuns(),
        portfolio === "zerodha"
          ? apiService.zerodhaThreatsHistory({ limit: 200 })
          : apiService.indmoneyUsThreatsHistory({ limit: 200 }),
      ]);
      setCostHistoryGroups(
        buildAutoRebalanceScanGroups(runs, threatHistory.history ?? [], portfolio).slice(0, 40),
      );
    } catch (error) {
      setCostHistoryError(normalizeError(error));
      setCostHistoryGroups([]);
    } finally {
      setCostHistoryLoading(false);
    }
  }, [apiService, ]);

  const zerodhaBasketHistoricalRows = useMemo(
    () => buildHistoricalDashboardActionRows(
      zerodhaBasketHistoryRuns,
      "india",
      zerodhaBasketDetailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null,
      buildTechnicalScanMap(zerodhaBasketHistoryRuns),
      basketFormula,
    ),
    [basketFormula, zerodhaBasketDetailsData.portfolioSnapshot, zerodhaBasketHistoryRuns],
  );

  const indmoneyBasketHistoricalRows = useMemo(
    () => buildHistoricalDashboardActionRows(
      indmoneyBasketHistoryRuns,
      "us",
      indmoneyBasketDetailsData.portfolioSnapshot as IndMoneyUsPortfolioSnapshotDetail | null,
      buildTechnicalScanMap(indmoneyBasketHistoryRuns),
      scoreMatrixFormulaConfig,
    ),
    [indmoneyBasketDetailsData.portfolioSnapshot, indmoneyBasketHistoryRuns, scoreMatrixFormulaConfig],
  );

  const handleScoreMatrixFormulaConfigChange = useCallback((updater: (current: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => {
    const updateConfig = localBasketFormula ? (fn: (value: ScoreMatrixFormulaConfig) => ScoreMatrixFormulaConfig) => setLocalBasketFormula(fn(localBasketFormula)) : setScoreMatrixFormulaConfig;
    updateConfig((current) => {
      const next = updater(current);
      if (zerodhaBasketOpen && zerodhaBasketOrders.length > 0) {
        const currentOrders = zerodhaBasketOrders;

        const stocksByKey = new Map<string, StockConsensus>();
        const technicalScansBySymbol: Record<string, TechnicalScanResult> = {};
        currentOrders.forEach((order) => {
          stocksByKey.set(order.stock.key, order.stock);
          if (order.technicalScan) {
            technicalScansBySymbol[`SYMBOL:${order.symbol.toUpperCase()}`] = order.technicalScan;
            technicalScansBySymbol[`SYMBOL:${order.stock.symbol.toUpperCase()}`] = order.technicalScan;
          }
        });

        const actionRows = buildDashboardActionRows(
          [...stocksByKey.values()],
          "india",
          technicalScansBySymbol,
          next,
        );
        const rebuiltOrders = buildZerodhaBasketPreviewOrders(
          actionRows,
          technicalScansBySymbol,
          zerodhaBasketDetailsData.portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null,
        );
        const previousBySymbol = new Map(currentOrders.map((order) => [order.symbol, order]));
        const nextOrders = rebuiltOrders.map((order) => {
          const previousOrder = previousBySymbol.get(order.symbol);
          if (!previousOrder) return order;
          return applyZerodhaBasketLivePricing(
            {
              ...order,
              orderKind: previousOrder.orderKind,
            },
            previousOrder.price ?? order.price,
            previousOrder.lastPrice ?? order.lastPrice,
          );
        });
        setZerodhaBasketOrders(nextOrders);
        setSelectedZerodhaBasketIds(new Set());
      }
      setZerodhaBasketSubmission(null);
      return next;
    });
  }, [localBasketFormula, setScoreMatrixFormulaConfig, zerodhaBasketDetailsData.portfolioSnapshot, zerodhaBasketOpen, zerodhaBasketOrders]);

  const closeAutoRebalanceCostHistory = useCallback(() => {
    setCostHistoryPortfolio(null);
    setSelectedCostGroup(null);
    setCostHistoryError(null);
  }, []);

  const zerodhaPreparation = useRef(0);
  const indmoneyPreparation = useRef(0);
  const verifyBasketRevision = useCallback(async (market: "india" | "us", stocks: StockConsensus[], technicalScans: ReturnType<typeof buildTechnicalScanMap>, initialFormula: ScoreMatrixFormulaConfig, rebalance: RunResponse[], technical: RunResponse, sequence: number, requested?: {sequence:number; formula:ScoreMatrixFormulaConfig}) => {
    const broker = market === "india" ? "india" : "indmoney_us";
    let formula = initialFormula;
    let actionRows = buildDashboardActionRows(stocks, market, technicalScans, formula);
    const [history, hashes, verification] = await Promise.all([
      apiService.getAutoRebalanceHistoryDetail(broker, sequence), auditResponseHashes([...rebalance, technical], technical), apiService.getScoreVerification(broker, sequence),
    ]);

    const stage = history.stages.find(s => s.stage === "actionables");
    const corrected = stage?.summary?.corrected_final_v2;
    const frozen = verification.verified ? verification.record : (corrected ?? stage?.summary?.frozen_final) as Record<string, unknown> | undefined;
    const original = stage?.summary?.frozen_final as Record<string, unknown> | undefined;
    const originals = new Map<string, number>();
    for (const saved of Array.isArray(original?.rows) ? original.rows : []) {
      const denominator = saved?.formula_inputs?.detailedRationaleDenominator;
      if (typeof denominator === "number" && Number.isFinite(denominator)) {
        originals.set(stockIdentity(saved.symbol, saved.exchange), denominator);
      }
    }
    const ranking = frozen?.actionable_ranking as {rows?: {listing:string;threat_reason?:string | null}[]} | undefined;
    const reasons = new Map(ranking?.rows?.map(item=>[item.listing,item.threat_reason]));
    const saved = new Map<string, {score: number; divisor?: number; jobId?: number; threatReason?: string | null; comparisons?: number | null; pairwise?: number | null}>();
    for (const row of Array.isArray(frozen?.rows) ? frozen.rows : []) {
      if (typeof row?.effectiveScore === "number" && Number.isFinite(row.effectiveScore)) {
        const evidence = verification.verified ? verification.evidence[row.exchange + ":" + row.symbol] : undefined;
        saved.set(stockIdentity(row.symbol, row.exchange), {score: row.effectiveScore, divisor: row.formula_inputs?.detailedRationaleDenominator, jobId: evidence?.job_id, comparisons: evidence?.comparisons, pairwise: evidence?.pairwise, threatReason: verification.verified ? evidence?.threat_reason ?? reasons.get(row.exchange + ":" + row.symbol) : null});
      }
    }
    const storedFormula = verification.verified && frozen?.formula && typeof frozen.formula === "object"
      ? normalizeScoreMatrixFormulaConfig(frozen.formula as Partial<ScoreMatrixFormulaConfig>) : null;
    const verifiedSettings = storedFormula && canonicalBasketInputs(storedFormula) === canonicalBasketInputs(frozen?.formula) ? storedFormula : null;
    if (!requested && verifiedSettings) {
      formula = verifiedSettings;

      actionRows = buildDashboardActionRows(stocks, market, technicalScans, formula);
    }
    const divisors = new Set<string>();
    const differences = actionRows.filter(row => {
      const entry = saved.get(stockIdentity(row.stock.symbol, row.stock.exchange));
      if (entry?.divisor != null && entry.divisor !== row.detail.detailedRationaleDenominator)
        divisors.add(`${row.detail.detailedRationaleDenominator} → ${entry.divisor}`);
      return !entry || !sameFrozenScore(entry.score, row.formulaScore) || entry.divisor !== row.detail.detailedRationaleDenominator;
    }).map(row => stockIdentity(row.stock.symbol, row.stock.exchange));
    const revision = {
      formula: verifiedSettings,
      divisors: [...divisors], differences,
      sequence, version: typeof frozen?.formula_version === "string" ? frozen.formula_version : null,
      capturedAt: typeof frozen?.captured_at === "string" ? frozen.captured_at : null,
      replayed: Boolean(corrected), originals, saved,
    };
    const rows = Array.isArray(frozen?.rows) ? frozen.rows : [];
    const listingKey = (exchange: string, symbol: string) => JSON.stringify([exchange, symbol]);
    const savedByListing = new Map(rows.map(saved => [listingKey(saved.exchange, saved.symbol), saved]));
    const problems = [
      requested && sequence !== requested.sequence && "requested workflow sequence",
      !verification.verified && verification.reason,
      !(stage?.status === "completed" || corrected) && "Actionables completion or saved replay",
      (frozen?.schema !== "workflow-final-v2" || frozen.formula_version !== "score-matrix-v2") && "formula version",
      (frozen?.broker !== broker || frozen.workflow_sequence !== sequence) && "workflow identity",
      frozen?.technical_run_id !== technical.id && "Technical source run",
      canonicalBasketInputs(frozen?.rebalance_run_ids) !== canonicalBasketInputs(rebalance.map(r => r.id)) && "Rebalance source runs",
      canonicalBasketInputs(frozen?.response_hashes) !== canonicalBasketInputs(hashes) && "source response revisions",
      canonicalBasketInputs(frozen?.formula) !== canonicalBasketInputs(formula) && "formula settings",
      (!rows.length || savedByListing.size !== rows.length || rows.length !== actionRows.length ||
        new Set(actionRows.map(row => listingKey(row.stock.exchange, row.stock.symbol))).size !== actionRows.length) && "listing coverage",
      ...actionRows.flatMap(row => {
        const saved = savedByListing.get(listingKey(row.stock.exchange, row.stock.symbol));
        return saved && saved.action === row.formulaAction && sameFrozenScore(saved.score, row.formulaScore)
          ? [] : [row.stock.exchange + ":" + row.stock.symbol + " action or score"];
      }),
    ].filter(Boolean);
    const issue = problems.length ? "Could not match " + problems.filter(problem => !String(problem).endsWith(" action or score")).concat(problems.some(problem => String(problem).endsWith(" action or score")) ? ["listing actions or scores"] : []).join(", ") + "." : null;
    return {actionRows, formula, revision, issue};
  }, [apiService]);
  const openZerodhaBasketPreview = useCallback(async (requested?: {sequence: number; formula: ScoreMatrixFormulaConfig}) => {
    let formula = requested?.formula ?? scoreMatrixFormulaConfig;
    setLocalBasketFormula(requested?.formula ?? null);
    const generation = ++zerodhaPreparation.current;
    setVerifiedBasketFormula(null);
    setVerificationIssue(null);
    setScoreRevision(null);
    setZerodhaAllocationUniverse([]);
    setZerodhaBasketOrders([]);
    setZerodhaBasketHistoryRuns([]);
    setSelectedZerodhaBasketIds(new Set());
    setZerodhaBasketDetailsData({ portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null, error: null });
    setZerodhaBasketOpen(true);
    setZerodhaBasketLoading(true);
    setZerodhaBasketError(null);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketLtpRefreshedAt(null);
    setZerodhaBasketScoreScanCompletedAt(null);
    setZerodhaDirectMarketAvailable(false);
    try {
      const [stockFlowResult, statusResult, loginResult] = await Promise.allSettled([
        fetchRebalanceStockFlowSource("zerodha"),
        apiService.zerodhaStatus(),
        apiService.zerodhaLoginUrl(),
      ]);
      if (stockFlowResult.status === "rejected") throw stockFlowResult.reason;
      if (generation !== zerodhaPreparation.current) return;
      const independent=await scorecardApi(apiService,"india").latestFinal(requested?.sequence);
      if(generation!==zerodhaPreparation.current)return;
      const portfolioSnapshot=stockFlowResult.value.portfolioSnapshot;
      const runs=independent ? await Promise.all(Object.values(independent.source_runs).map(id=>apiService.getRun(id))) : stockFlowResult.value.runs;
      setZerodhaBasketHistoryRuns(runs);
      const status = statusResult.status === "fulfilled" ? statusResult.value : null;
      const login = loginResult.status === "fulfilled" ? loginResult.value : null;
      setZerodhaOrderSubmissionBlockedReason(status?.order_submission_blocked_reason ?? login?.order_submission_blocked_reason ?? null);
      const directMarketEnabled = Boolean(
        status?.connected
          && login?.configured
          && status.direct_market_orders_enabled
          && login.direct_market_orders_enabled,
      );
      setZerodhaDirectMarketAvailable(
        directMarketEnabled,
      );
      setZerodhaExecutionMode("direct_market");
      const [eventsResult, threatsResult] = await Promise.allSettled([
        apiService.zerodhaEventsLatest(),
        apiService.zerodhaThreatsLatest(),
      ]);
      if (generation !== zerodhaPreparation.current) return;
      const stocks = buildConsensusRows(
        getLatestMatchingRebalanceRuns(runs, "india"),
        "india",
        portfolioSnapshot,
      );
      const technicalScans = buildTechnicalScanMap(runs);
      setZerodhaBasketScoreScanCompletedAt(
        Object.values(technicalScans)
          .map((scan) => scan.createdAt)
          .filter((value): value is string => Boolean(value))
          .sort((left, right) => parseTimestampMs(right) - parseTimestampMs(left))[0] ?? null,
      );
      let actionRows = buildDashboardActionRows(stocks, "india", technicalScans, formula);
      const rebalance = getLatestMatchingRebalanceRuns(runs, "india");
      const technicalIds = [...new Set(actionRows.map(row => row.detail?.technicalScanSourceRunId))];
      const technical = technicalIds.length === 1 ? runs.find(run => run.id === technicalIds[0]) : null;
      if(independent){
        const verified=bindIndependentBasket(actionRows,independent,formula);
        actionRows=verified.rows;setScoreRevision(verified.revision);setVerifiedBasketFormula(canonicalBasketInputs(formula));
      } else if (technical?.auto_rebalance_sequence && !stockFlowResult.value.warning) {
        const sequence = technical.auto_rebalance_sequence;
        try {
          const verified = await verifyBasketRevision("india", stocks, technicalScans, formula, rebalance, technical, sequence, requested);
          if (generation !== zerodhaPreparation.current) return;
          ({actionRows, formula} = verified);
          setLocalBasketFormula(formula);
          setScoreRevision(verified.revision);
          if (verified.issue) setVerificationIssue(verified.issue);
          else setVerifiedBasketFormula(canonicalBasketInputs(formula));
        } catch {
          if (generation === zerodhaPreparation.current) setVerificationIssue("Could not read the saved revision or verify its source responses.");
        }
      }
      if (generation !== zerodhaPreparation.current) return;
      const orders = buildZerodhaBasketPreviewOrders(
        actionRows,
        technicalScans,
        portfolioSnapshot as ZerodhaPortfolioSnapshotDetail | null,
      );
      const capturedDetailsErrors = [eventsResult, threatsResult]
        .filter((result): result is PromiseRejectedResult => result.status === "rejected")
        .map((result) => normalizeError(result.reason));
      setZerodhaBasketDetailsData({
        portfolioSnapshot,
        eventsAnalysis: eventsResult.status === "fulfilled" ? eventsResult.value.analysis : null,
        threatsAnalysis: threatsResult.status === "fulfilled" ? threatsResult.value.analysis : null,
        error: capturedDetailsErrors.length ? capturedDetailsErrors.join("; ") : null,
      });
      setZerodhaAllocationUniverse(!independent && stockFlowResult.value.warning ? [] : actionRows);
      if (!independent && stockFlowResult.value.warning) setZerodhaBasketError(`Display calculations unavailable for cached source: ${stockFlowResult.value.warning}`);
      setZerodhaBasketOrders(orders);
      setSelectedZerodhaBasketIds(new Set());
    } catch (error) {
      if (generation !== zerodhaPreparation.current) return;
      setZerodhaAllocationUniverse([]);
      setZerodhaBasketOrders([]);
      setZerodhaBasketHistoryRuns([]);
      setZerodhaDirectMarketAvailable(false);
      setZerodhaBasketDetailsData({ portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null, error: normalizeError(error) });
      setSelectedZerodhaBasketIds(new Set());
      setZerodhaBasketError(`Could not prepare Zerodha basket: ${normalizeError(error)}`);
    } finally {
      if (generation === zerodhaPreparation.current) setZerodhaBasketLoading(false);
    }
  }, [apiService, scoreMatrixFormulaConfig, zerodhaBasketBuyThreshold, verifyBasketRevision]);

  const [usScanAt, setUsScanAt] = useState<string | null>(null);
  const [usRevision, setUsRevision] = useState<BasketScoreRevision | null>(null);
  const [usFormula, setUsFormula] = useState<ScoreMatrixFormulaConfig | null>(null);
  const openIndmoneyBasketPreview = useCallback(async (requested?: {sequence:number; formula:ScoreMatrixFormulaConfig}) => {
    setUsRevision(null);
    setUsScanAt(null);
    setUsFormula(requested?.formula ?? null);
    const generation = ++indmoneyPreparation.current;
    setIndmoneyAllocationUniverse([]);
    setIndmoneyBasketOrders([]);
    setIndmoneyBasketHistoryRuns([]);
    setSelectedIndmoneyBasketIds(new Set());
    setIndmoneyBasketDetailsData({ portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null, error: null });
    setIndmoneyBasketOpen(true);
    setIndmoneyBasketLoading(true);
    setIndmoneyBasketError(null);
    try {
      const [stockFlowSource, eventsResult, threatsResult] = await Promise.all([
        fetchRebalanceStockFlowSource("indmoneyUs"),
        apiService.indmoneyUsEventsLatest().then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason })),
        apiService.indmoneyUsThreatsLatest().then((value) => ({ status: "fulfilled" as const, value })).catch((reason) => ({ status: "rejected" as const, reason })),
      ]);
      if (generation !== indmoneyPreparation.current) return;
      const independent=await scorecardApi(apiService,"indmoney_us").latestFinal(requested?.sequence);
      if(generation!==indmoneyPreparation.current)return;
      const portfolioSnapshot=stockFlowSource.portfolioSnapshot;
      const runs=independent ? await Promise.all(Object.values(independent.source_runs).map(id=>apiService.getRun(id))) : stockFlowSource.runs;
      setIndmoneyBasketHistoryRuns(runs);
      const stocks = buildConsensusRows(
        getLatestMatchingRebalanceRuns(runs, "us"),
        "us",
        portfolioSnapshot,
        runs,
        stockFlowSource.verifiedUsListings ?? [],
      );
      const technicalScans = buildTechnicalScanMap(runs);
      setUsScanAt(Object.values(technicalScans).map(scan => scan.createdAt).filter((value): value is string => Boolean(value)).sort((a,b) => parseTimestampMs(b) - parseTimestampMs(a))[0] ?? null);
      let actionRows = buildDashboardActionRows(stocks, "us", technicalScans, requested?.formula ?? scoreMatrixFormulaConfig);
      const ids = new Set(actionRows.map(row => row.detail?.technicalScanSourceRunId));
      const technical = ids.size === 1 ? runs.find(run => ids.has(run.id)) : null;
      if(independent){
        const verified=bindIndependentBasket(actionRows,independent,requested?.formula??scoreMatrixFormulaConfig);
        actionRows=verified.rows;setUsRevision(verified.revision);setUsFormula(verified.revision.formula);
      } else if (technical?.auto_rebalance_sequence && !stockFlowSource.warning) {
        const verified = await verifyBasketRevision("us", stocks, technicalScans, requested?.formula ?? scoreMatrixFormulaConfig,
          getLatestMatchingRebalanceRuns(runs, "us"), technical, technical.auto_rebalance_sequence, requested);
        if (generation !== indmoneyPreparation.current) return;
        actionRows = verified.actionRows;
        setUsRevision(verified.revision);
        setUsFormula(verified.formula);
        if (verified.issue) setIndmoneyBasketError(verified.issue);
      } else {
        setIndmoneyBasketError("A unique saved Technical source is required to verify this preview.");
      }
      const orders = buildZerodhaBasketPreviewOrders(actionRows, technicalScans, null, { allowFractionalSellUnits: true })
        .map((order) => ({
          ...order,
          id: order.id.replace(/^zerodha:/, "indmoney:"),
          exchange: order.exchange || "US",
        }));
      const capturedDetailsErrors = [eventsResult, threatsResult]
        .filter((result) => result.status === "rejected")
        .map((result) => normalizeError(result.reason));
      setIndmoneyBasketDetailsData({
        portfolioSnapshot,
        eventsAnalysis: eventsResult.status === "fulfilled" ? eventsResult.value.analysis : null,
        threatsAnalysis: threatsResult.status === "fulfilled" ? threatsResult.value.analysis : null,
        error: capturedDetailsErrors.length ? capturedDetailsErrors.join("; ") : null,
      });
      setIndmoneyAllocationUniverse(!independent && stockFlowSource.warning ? [] : actionRows);
      if (!independent && stockFlowSource.warning) setIndmoneyBasketError(`Display calculations unavailable for cached source: ${stockFlowSource.warning}`);
      setIndmoneyBasketOrders(orders);
      setSelectedIndmoneyBasketIds(new Set());
    } catch (error) {
      if (generation !== indmoneyPreparation.current) return;
      setIndmoneyAllocationUniverse([]);
      setIndmoneyBasketOrders([]);
      setIndmoneyBasketHistoryRuns([]);
      setIndmoneyBasketDetailsData({ portfolioSnapshot: null, eventsAnalysis: null, threatsAnalysis: null, error: normalizeError(error) });
      setSelectedIndmoneyBasketIds(new Set());
      setIndmoneyBasketError(`Could not prepare IndMoney basket: ${normalizeError(error)}`);
    } finally {
      if (generation === indmoneyPreparation.current) setIndmoneyBasketLoading(false);
    }
  }, [apiService, indmoneyBasketBuyThreshold, scoreMatrixFormulaConfig, verifyBasketRevision]);

  const updateZerodhaBasketBuyThresholdDraft = useCallback((value: string) => {
    setZerodhaBasketBuyThresholdDraft(value);
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    const parsed = Number(trimmedValue);
    if (!Number.isFinite(parsed)) return;

    setZerodhaBasketBuyThreshold(parsed);
    setZerodhaBasketSubmission(null);

  }, [setZerodhaBasketBuyThreshold, setZerodhaBasketBuyThresholdDraft, zerodhaBasketOrders]);

  const toggleZerodhaBasketOrder = useCallback((id: string) => {
    setSelectedZerodhaBasketIds((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, [zerodhaBasketOrders]);

  const toggleAllZerodhaBasketOrders = useCallback((ids?: string[]) => {
    const allIds = ids ?? zerodhaBasketOrders.map(order => order.id);
    setSelectedZerodhaBasketIds(current => allIds.every(id => current.has(id)) ? new Set() : new Set(allIds));
  }, [zerodhaBasketOrders]);
  const toggleZerodhaBasketSection = useCallback((action: ActionCategory, ids?: string[]) => {
    const groupIds = ids ?? zerodhaBasketOrders.filter(order => getZerodhaBasketActionForPercent(order) === action).map(order => order.id);
    setSelectedZerodhaBasketIds(current => toggleVisibleSelection(current, groupIds));
  }, [zerodhaBasketOrders]);

  const updateZerodhaBasketOrderKind = useCallback(
    (id: string, orderKind: ZerodhaBasketOrderKind) => {
      setZerodhaBasketSubmission(null);
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? { ...order, orderKind } : order)),
      );
    },
    [],
  );

  const updateZerodhaBasketPercent = useCallback(
    (id: string, percent: ZerodhaBasketOrderPercent) => {
      setZerodhaBasketSubmission(null);
      setSelectedZerodhaBasketIds(current => { const next = new Set(current); next.delete(id); return next; });
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? applyZerodhaBasketPercent(order, percent) : order)),
      );
    },
    [],
  );

  const updateZerodhaBasketUnits = useCallback(
    (id: string, delta: number) => {
      setZerodhaBasketSubmission(null);
      setZerodhaBasketOrders((current) =>
        current.map((order) => (order.id === id ? applyZerodhaBasketUnitDelta(order, delta) : order)),
      );
    },
    [],
  );

  const reviewZerodhaWholeShareChoice = useCallback((id: string, choice: "keep" | "exit") => {
    if (zerodhaBasketPlacing || zerodhaBasketSubmission?.orders.some(order => order.id === id)) return;
    setZerodhaBasketSubmission(null);
    // Reviewing the choice never selects or submits an order.
    setSelectedZerodhaBasketIds(current => { const next = new Set(current); next.delete(id); return next; });
    setZerodhaBasketOrders(current => current.map(order => {
      if (order.id !== id || !order.wholeShareReview || order.currentUnits !== 1) return order;
      return { ...order, wholeShareReview: choice, action: choice === "exit" ? "Sell All" : "Trim", units: choice === "exit" ? 1 : null, amount: choice === "exit" ? order.price : null, percent: choice === "exit" ? 100 : 0 };
    }));
  }, [zerodhaBasketPlacing, zerodhaBasketSubmission]);

  const updateIndmoneyBasketBuyThresholdDraft = useCallback((value: string) => {
    setIndmoneyBasketBuyThresholdDraft(value);
    const trimmedValue = value.trim();
    if (!trimmedValue) return;

    const parsed = Number(trimmedValue);
    if (!Number.isFinite(parsed)) return;

    setIndmoneyBasketBuyThreshold(parsed);

  }, [setIndmoneyBasketBuyThreshold, setIndmoneyBasketBuyThresholdDraft, indmoneyBasketOrders]);

  const toggleIndmoneyBasketOrder = useCallback((id: string) => {
    setSelectedIndmoneyBasketIds(current => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next; });
  }, []);
  const toggleAllIndmoneyBasketOrders = useCallback((visibleIds?: string[]) => {
    setSelectedIndmoneyBasketIds(current => toggleVisibleSelection(current, visibleIds ?? indmoneyBasketOrders.map(order => order.id)));
  }, [indmoneyBasketOrders]);
  const toggleIndmoneyBasketSection = useCallback((action: ActionCategory, visibleIds?: string[]) => {
    const ids = visibleIds ?? indmoneyBasketOrders.filter(order => getZerodhaBasketActionForPercent(order) === action).map(order => order.id);
    setSelectedIndmoneyBasketIds(current => toggleVisibleSelection(current, ids));
  }, [indmoneyBasketOrders]);

  const updateIndmoneyBasketOrderKind = useCallback((id: string, orderKind: ZerodhaBasketOrderKind) => {
    setIndmoneyBasketOrders((current) =>
      current.map((order) => (order.id === id ? { ...order, orderKind } : order)),
    );
  }, []);

  const updateIndmoneyBasketPercent = useCallback((id: string, percent: ZerodhaBasketOrderPercent) => {
    setIndmoneyBasketOrders((current) =>
      current.map((order) => (order.id === id ? applyZerodhaBasketPercent(order, percent) : order)),
    );
  }, []);

  const updateIndmoneyBasketUnits = useCallback((id: string, delta: number) => {
    setIndmoneyBasketOrders((current) =>
      current.map((order) => (order.id === id ? applyZerodhaBasketUnitDelta(order, delta) : order)),
    );
  }, []);

  const confirmIndmoneyFinalOrder = useCallback((drafts?: ZerodhaBasketPreviewOrder[]) => {
    const selectedOrders = (drafts ?? indmoneyBasketOrders).filter((order) => selectedIndmoneyBasketIds.has(order.id));
    if (!selectedOrders.length) {
      window.alert("Select at least one IndMoney basket row before final order review.");
      return;
    }
    if (selectedOrders.some(order => order.units == null || order.units <= 0 || order.price == null || order.amount == null || !draftDirection(order.draftContext?.action))) {
      window.alert("Selected INDmoney estimates have missing inputs. Review the basket before continuing.");
      return;
    }
    window.alert("INDmoney estimates are available for manual review. Vendor prices may be delayed; verify current prices and quantities in INDmoney before execution.");
  }, [indmoneyBasketOrders, selectedIndmoneyBasketIds]);

  const refreshZerodhaBasketLtp = useCallback(async () => {
    if (!zerodhaBasketOrders.length) return;
    setZerodhaBasketLtpRefreshing(true);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);
    try {
      const preparedOrders = await prepareZerodhaBasketOrdersForKite(zerodhaBasketOrders);
      setZerodhaBasketOrders((current) => mergePreparedZerodhaBasketOrders(current, preparedOrders));
      setZerodhaBasketLtpRefreshedAt(new Date().toISOString());
    } catch (error) {
      setZerodhaBasketError(`Could not refresh live LTP: ${normalizeError(error)}`);
    } finally {
      setZerodhaBasketLtpRefreshing(false);
    }
  }, [zerodhaBasketOrders]);

  const changeZerodhaExecutionMode = useCallback((mode: ZerodhaExecutionMode) => {
    setZerodhaExecutionMode(mode);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);
  }, []);

  const placeSelectedZerodhaBasketOrders = useCallback(async (previewDrafts?: ZerodhaBasketPreviewOrder[]) => {
    if (basketSafety.blockedReason || zerodhaBasketPlacing || zerodhaBasketLtpRefreshing || zerodhaOrderSubmissionBlockedReason) {
      setZerodhaBasketError(basketSafety.blockedReason ?? zerodhaOrderSubmissionBlockedReason ?? "Order placement or quote refresh is in progress.");
      return;
    }
    const sourceDrafts = previewDrafts ?? zerodhaBasketOrders;
    const missingIds = [...selectedZerodhaBasketIds].filter(id => !sourceDrafts.some(order => order.id === id));
    if (missingIds.length) { setZerodhaBasketError(`Selected rows missing from the reviewed draft: ${missingIds.join(', ')}. Reopen and review the complete basket.`); return; }
    const selectedOrders = sourceDrafts.filter(order => selectedZerodhaBasketIds.has(order.id)).sort(compareZerodhaBasketOrdersByScore);
    if (previewDrafts) {
      const errors = selectedOrders.flatMap(order => editableDraftIssues(order).map(reason => `${order.exchange}:${order.symbol}: ${reason}`));
      if (new Set(selectedOrders.map(order => stockIdentity(order.symbol, order.exchange))).size !== selectedOrders.length) errors.push('Duplicate exact listing in selected drafts.');
      if (zerodhaExecutionMode !== 'direct_market' || !getIndiaMarketStatus().open) errors.push('Market drafts require direct broker access during regular market hours; protected LIMIT fallback is not used.');
      if (errors.length) { setZerodhaBasketError(errors.join(' ')); return; }
    }
    const affordabilityIssue = basketAffordabilityIssue(selectedOrders, portfolioParameterMargin(zerodhaBasketDetailsData.portfolioSnapshot, "india"));
    if (affordabilityIssue) { setZerodhaBasketError(affordabilityIssue); return; }
    try { assertWholeShareOrdersReviewed(selectedOrders); }
    catch (error) { setZerodhaBasketError(normalizeError(error)); return; }
    if (!selectedOrders.length) {
      window.alert("Select at least one Zerodha basket row before opening Kite.");
      return;
    }
    if (!previewDrafts) {
      const scoreWarningMessage = buildZerodhaBasketScoreWarningMessage(selectedOrders);
      if (scoreWarningMessage) window.alert(scoreWarningMessage);
    }
    const marketStatus = getIndiaMarketStatus();
    const isPublisherBuySecondStep = zerodhaExecutionMode === "publisher_limit" && zerodhaBasketSubmission?.phase === "sell_first";
    const publisherOrdersForThisStep = isPublisherBuySecondStep ? selectedOrders.filter((order) => order.side === "BUY") : selectedOrders;
    const mixedPublisherSides = zerodhaExecutionMode === "publisher_limit" && !isPublisherBuySecondStep && selectedOrders.some((order) => order.side === "SELL") && selectedOrders.some((order) => order.side === "BUY");
    const orderChunks = chunkZerodhaBasketOrders(mixedPublisherSides ? selectedOrders.filter((order) => order.side === "SELL") : publisherOrdersForThisStep);
    const shouldContinue = window.confirm(
      `${marketStatus.label}

${zerodhaExecutionMode === "direct_market"
  ? `This will place SELL protected MARKET orders first through Kite Connect with market_protection=-1, wait for sell status, refresh margins, then place only affordable BUY orders. Execution is not atomic or guaranteed. Continue?`
  : `This will open protected LIMIT Kite basket tray(s). If both SELL and BUY rows are selected, only SELL trays open first; after you place sells in Kite, click Refresh & Open Buy Basket to reprice and open affordable BUY trays. Continue?`}`,
    );
    if (!shouldContinue) return;

    setZerodhaBasketPlacing(true);
    setZerodhaBasketSubmission(null);
    setZerodhaBasketError(null);

    if (zerodhaExecutionMode === "direct_market") {
      if (!marketStatus.open) {
        setZerodhaBasketPlacing(false);
        setZerodhaBasketError("Protected MARKET orders are available only during regular NSE/BSE trading hours. Switch back to the protected LIMIT basket after market close.");
        return;
      }
      let attemptStarted = false;
      try {
        await basketSafety.begin();
        attemptStarted = true;
        const response = await apiService.zerodhaPlaceProtectedMarketOrdersSequenced({
          orders: selectedOrders.map((order) => ({
            tradingsymbol: order.symbol.toUpperCase(),
            exchange: order.exchange.toUpperCase() as "NSE" | "BSE",
            transaction_type: order.side,
            quantity: Math.max(1, Math.floor(order.units ?? 0)),
            product: "CNC",
            validity: "DAY",
            market_protection: ZERODHA_DEFAULT_MARKET_PROTECTION,
            estimated_price: order.price || order.lastPrice || undefined,
            last_price: order.lastPrice || order.price || undefined,
          })),
          sell_first: true,
          wait_for_sell_completion: true,
          safety_buffer_amount: Math.max(50, selectedOrders.filter((order) => order.side === "BUY").reduce((sum, order) => sum + (order.amount ?? 0), 0) * 0.01),
        });
        const responseIssue = basketResponseIssue(response, selectedOrders);
        if (responseIssue) throw new Error(`Order response cannot be safely reconciled: ${responseIssue}`);
        const allResults = [...response.sell_results, ...response.buy_results];
        const failed = allResults.filter((result) => result.status === "failed");
        const placedResultKeys = new Set(
          allResults
            .filter((result) => result.status === "placed")
            .map((result) => `${result.exchange.toUpperCase()}:${result.tradingsymbol.toUpperCase()}:${result.transaction_type}`),
        );
        const placedOrders = selectedOrders.filter((order) =>
          placedResultKeys.has(`${order.exchange.toUpperCase()}:${order.symbol.toUpperCase()}:${order.side}`),
        );
        setSelectedZerodhaBasketIds(current => new Set([...current].filter(id => !placedOrders.some(order => order.id === id))));
        const failedMessages = [...failed.map((result) => `${result.tradingsymbol}: ${result.error || "unknown error"}`), ...response.skipped_buy_results.map((result) => `${result.tradingsymbol}: ${result.error || "buy skipped"}`), ...response.messages];
        let portfolioRefreshedAt: string | null = null;

        if (response.placed_count > 0) {
          try {
            const previousOverview = await retryWorkflowRead(
              () => apiService.zerodhaPortfolioOverview(),
              "Zerodha portfolio overview before sync",
              () => cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner),
            );
            await apiService.zerodhaSyncPortfolio();
            const overview = await waitForZerodhaPortfolioSync(previousOverview.latest?.captured_at, () => !isCurrentWorkflowOwner(runtimeOwner), runtimeOwner);
            portfolioRefreshedAt = overview.latest?.captured_at ?? null;
            setZerodhaBasketDetailsData((current) => ({
              ...current,
              portfolioSnapshot: overview.latest,
            }));
          } catch (syncError) {
            failedMessages.push(`Portfolio refresh after order placement did not complete: ${normalizeError(syncError)}`);
          }
        }

        setZerodhaBasketSubmission({
          executionMode: "direct_market",
          redirected: response.placed_count,
          basketCount: 0,
          clipboardCopied: false,
          orders: selectedOrders,
          placedOrderIds: placedOrders.map((order) => order.id),
          skippedOrderIds: selectedOrders.filter((order) => response.skipped_buy_results.some((result) => result.tradingsymbol.toUpperCase() === order.symbol.toUpperCase() && result.exchange.toUpperCase() === order.exchange.toUpperCase())).map((order) => order.id),
          failedMessages,
          messages: response.messages,
          portfolioRefreshedAt,
        });
        if (failed.length) basketSafety.uncertain();
        else basketSafety.complete();
        if (failed.length || response.skipped_count) {
          setZerodhaBasketError(`Placed ${response.placed_count} protected MARKET order${response.placed_count === 1 ? "" : "s"}; ${response.failed_count} failed; ${response.skipped_count} buy order${response.skipped_count === 1 ? "" : "s"} skipped/reduced: ${failedMessages.join("; ")}`);
        }
      } catch (error) {
        if (attemptStarted) {
          if (error instanceof APIError && definitiveBasketRejection(error)) basketSafety.complete();
          else basketSafety.uncertain();
        }
        setZerodhaBasketError(`Could not place protected MARKET orders: ${normalizeError(error)}. Check the Kite order book before retrying: a failed response does not prove that no orders were placed.`);
      } finally {
        setZerodhaBasketPlacing(false);
      }
      return;
    }

    const publisherStepOrders = mixedPublisherSides ? selectedOrders.filter((order) => order.side === "SELL") : publisherOrdersForThisStep;
    if (!publisherStepOrders.length) {
      setZerodhaBasketPlacing(false);
      setZerodhaBasketError(isPublisherBuySecondStep ? "No selected BUY rows remain for the second-step buy basket." : "No selected rows to open in Kite.");
      return;
    }
    const kiteTargetPrefix = `zerodha-basket-${Date.now()}`;
    const kiteWindows = orderChunks.map((_, index) => {
      const targetName = `${kiteTargetPrefix}-${index + 1}`;
      return {
        targetName,
        win: window.open("about:blank", targetName),
      };
    });
    if (kiteWindows.some((entry) => !entry.win)) {
      kiteWindows.forEach((entry) => entry.win?.close());
      setZerodhaBasketPlacing(false);
      setZerodhaBasketError(`Your browser blocked one or more Kite basket popups. Allow popups for this site, then try the protected LIMIT basket again. ${orderChunks.length} popup${orderChunks.length === 1 ? "" : "s"} required for the selected rows.`);
      return;
    }
    kiteWindows.forEach((entry) => {
      if (entry.win) entry.win.opener = null;
    });

    try {
      const login = await apiService.zerodhaLoginUrl();
      const apiKey = login.configured ? getZerodhaPublisherApiKey(login.login_url) : null;
      if (!apiKey) {
        kiteWindows.forEach((entry) => entry.win?.close());
        setZerodhaBasketError("Zerodha Kite Publisher is not configured. Add ZERODHA_API_KEY on the backend and try again.");
        return;
      }

      let preparedOrders = await prepareZerodhaBasketOrdersForKite(publisherStepOrders);
      if (isPublisherBuySecondStep) {
        const overview = await apiService.zerodhaPortfolioOverview();
        const refreshedMargin = overview.latest?.available_margin ?? null;
        let remaining = refreshedMargin === null ? 0 : Math.max(0, refreshedMargin - Math.max(50, preparedOrders.reduce((sum, order) => sum + (order.amount ?? 0), 0) * 0.01));
        preparedOrders = preparedOrders.map((order) => {
          if (order.side !== "BUY" || !order.price || order.price <= 0) return order;
          const affordableUnits = Math.min(order.units ?? 0, Math.floor(remaining / order.price));
          remaining -= Math.max(0, affordableUnits) * order.price;
          return { ...order, units: affordableUnits > 0 ? affordableUnits : null, amount: calculateZerodhaBasketAmount(affordableUnits > 0 ? affordableUnits : null, order.price) };
        }).filter((order) => order.side !== "BUY" || ((order.units ?? 0) > 0));
        setZerodhaBasketDetailsData((current) => ({ ...current, portfolioSnapshot: overview.latest }));
      }
      if (!preparedOrders.length) {
        kiteWindows.forEach((entry) => entry.win?.close());
        setZerodhaBasketError("No affordable BUY rows remain after refreshed margin and safety buffer.");
        return;
      }
      setZerodhaBasketOrders((current) => mergePreparedZerodhaBasketOrders(current, preparedOrders));
      setZerodhaBasketLtpRefreshedAt(new Date().toISOString());
      const preparedChunks = chunkZerodhaBasketOrders(preparedOrders);

      let clipboardCopied = false;
      try {
        clipboardCopied = await copyZerodhaKiteBasketToClipboard(preparedOrders, marketStatus.open);
      } catch {
        clipboardCopied = false;
      }

      preparedChunks.forEach((chunk, index) => {
        postZerodhaKiteBasket(apiKey, chunk, marketStatus.open, kiteWindows[index].targetName);
      });

      setZerodhaBasketSubmission({
        executionMode: "publisher_limit",
        redirected: preparedOrders.length,
        basketCount: preparedChunks.length,
        clipboardCopied,
        orders: preparedOrders,
        phase: mixedPublisherSides ? "sell_first" : isPublisherBuySecondStep ? "buy_after_sell" : "single_side",
        messages: mixedPublisherSides ? ["Sell phase opened. After you place the sell basket in Kite, click Refresh & Open Buy Basket."] : isPublisherBuySecondStep ? ["Buy phase opened after refreshed margin sizing."] : [],
      });
    } catch (error) {
      kiteWindows.forEach((entry) => entry.win?.close());
      setZerodhaBasketError(`Could not open the Kite order basket: ${normalizeError(error)}`);
    } finally {
      setZerodhaBasketPlacing(false);
    }
  }, [runtimeOwner, apiService, basketSafety, zerodhaBasketPlacing, zerodhaBasketLtpRefreshing, zerodhaBasketDetailsData.portfolioSnapshot, zerodhaOrderSubmissionBlockedReason, selectedZerodhaBasketIds, zerodhaBasketOrders, zerodhaBasketSubmission?.phase, zerodhaExecutionMode]);

  const savedStageReadGeneration = useRef(0);
  const loadLatestIdleStageInfo = useCallback(async () => {
    const generation = ++savedStageReadGeneration.current;
    const [
      zerodhaOverviewResult,
      indmoneyOverviewResult,
      zerodhaThreatResult,
      indmoneyThreatResult,
      runsResult,
      zerodhaHistoryResult,
      indmoneyHistoryResult,
    ] = await Promise.allSettled([
      apiService.zerodhaPortfolioOverview(),
      apiService.indmoneyUsPortfolioOverview(),
      apiService.zerodhaThreatsLatest(),
      apiService.indmoneyUsThreatsLatest(),
      fetchDashboardRecentFullRuns(),
      apiService.getAutoRebalanceHistory("india", { limit: 25 }),
      apiService.getAutoRebalanceHistory("indmoney_us", { limit: 25 }),
    ]);

    if (!isCurrentWorkflowOwner(runtimeOwner) || generation !== savedStageReadGeneration.current) return;
    const zerodhaOverview =
      zerodhaOverviewResult.status === "fulfilled"
        ? zerodhaOverviewResult.value
        : null;
    const indmoneyOverview =
      indmoneyOverviewResult.status === "fulfilled"
        ? indmoneyOverviewResult.value
        : null;
    const zerodhaThreat =
      zerodhaThreatResult.status === "fulfilled" ? zerodhaThreatResult.value : null;
    const indmoneyThreat =
      indmoneyThreatResult.status === "fulfilled"
        ? indmoneyThreatResult.value
        : null;
    const runs = runsResult.status === "fulfilled" ? runsResult.value : [];
    const failedHistory = [zerodhaHistoryResult, indmoneyHistoryResult].find(result => result.status === "rejected");
    setWorkflowHistoryError(failedHistory?.status === "rejected"
      ? `Saved workflow history unavailable: ${normalizeError(failedHistory.reason)}. Refresh to retry.` : null);
    // A failed history read cannot establish a newer stage result. The other
    // portfolio may still refresh, and the latest holdings count is independent.
    const historyByPortfolio: Record<
      WorkflowPortfolio,
      AutoRebalanceHistoryItemResponse[]
    > = {
      zerodha:
        zerodhaHistoryResult.status === "fulfilled"
          ? zerodhaHistoryResult.value.items
          : [],
      indmoneyUs:
        indmoneyHistoryResult.status === "fulfilled"
          ? indmoneyHistoryResult.value.items
          : [],
    };

    const latestIndia = historyByPortfolio.zerodha.reduce<AutoRebalanceHistoryItemResponse | null>(
      (latest, item) => !latest || item.sequence > latest.sequence ? item : latest, null);
    if (zerodhaHistoryResult.status === "fulfilled") setLatestIndiaWorkflow(latestIndia);
    setSavedRunCosts(current => {
      const next = { ...current };
      for (const portfolio of ["zerodha", "indmoneyUs"] as const) {
        const latest = historyByPortfolio[portfolio].reduce<AutoRebalanceHistoryItemResponse | null>(
          (entry, item) => !entry || item.sequence > entry.sequence ? item : entry, null);
        if (!latest) continue;
        const stages = latest.stages.filter(item => COST_BEARING_STAGES.includes(item.stage) &&
          item.status !== "skipped" && (item.provider_count > 0 || item.estimated_cost > 0 ||
            knownCost(item.summary?.cost_usd) || knownCost(item.summary?.cost_inr)));
        next[portfolio] = {
          ...sumRebalanceCosts(stages.map(item => summarizeAutoRebalanceHistoryStage(latest, item.stage, usdInrRate)), usdInrRate),
          sequence: latest.sequence,
        };
      }
      return next;
    });

    const nextByPortfolio = (
      ["zerodha", "indmoneyUs"] as WorkflowPortfolio[]
    ).reduce(
      (acc, portfolio) => {
        if (portfolio === "zerodha" && latestIndia) {
          acc.zerodha = {} as Record<WorkflowStageKey, Partial<StageInfo>>;
          for (const stage of STAGE_ORDER) {
            const row = latestIndia.stages.find(entry => entry.stage === stage);
            const info: Partial<StageInfo> = row ? summarizeAutoRebalanceHistoryStage(latestIndia, stage, usdInrRate)
              : { workflowSequence: latestIndia.sequence, runStatus: "not started" };
            if (row?.status === "interrupted" && !row.run_id && !row.job_id && !row.provider_count) info.runStatus = "interrupted before launch";
            if (row?.run_id && stage === "swing") {
              const run = runs.find(run => run.id === row.run_id && run.auto_rebalance_sequence === latestIndia.sequence && run.auto_rebalance_portfolio === "india");
              if (run && run.run_jobs?.length) {
                const counts = swingRecommendationCounts(run);
                if (counts.recommendedStocks != null) Object.assign(info, counts);
                info.distinctModels ??= summarizeRun(run).distinctModels;
              }
            }
            if (row && stage === "sync") {
              const captured = zerodhaOverview?.latest;
              const time = parseTimestampMs(captured?.captured_at);
              const swingStart = latestIndia.stages.find(entry => entry.stage === "swing")?.started_at;
              info.portfolioStockCount = getAutoRebalanceSummaryNumber(row.summary ?? {}, "portfolio_stock_count")
                ?? (captured && time >= parseTimestampMs(latestIndia.created_at) && time <= parseTimestampMs(swingStart ?? row.completed_at) ? captured.holdings_count : null);
            }
            acc.zerodha[stage] = info;
          }
          return acc;
        }
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        const latestSwingRun = getLatestStageRun(runs, "swing", market);
        const latestRebalanceRun = getLatestStageRun(runs, "rebalance", market);
        const latestTechnicalRun = getLatestStageRun(runs, "technical", market);
        const latestRebalanceRuns = latestRebalanceRun
          ? getLatestMatchingRebalanceRuns(runs, market)
          : [];
        const latestActionablesTimestamp = [
          latestTechnicalRun,
          latestRebalanceRun,
        ]
          .map((run) => (run ? getLatestRunTimestamp(run) : null))
          .filter(Boolean)
          .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
        const latestActionableStocks = latestRebalanceRuns.length
          ? buildConsensusRows(latestRebalanceRuns, market)
          : [];

        const overview =
          portfolio === "zerodha" ? zerodhaOverview : indmoneyOverview;
        const threatResponse =
          portfolio === "zerodha" ? zerodhaThreat : indmoneyThreat;
        const threat = threatResponse?.analysis ?? null;
        const syncStatus =
          portfolio === "zerodha"
            ? "last synced portfolio"
            : (indmoneyOverview?.latest?.parse_status ?? "last snapshot");

        const historyInfo = (stage: WorkflowStageKey) =>
          summarizeAutoRebalanceHistoryStage(
            getLatestAutoRebalanceHistoryItem(historyByPortfolio[portfolio], stage),
            stage,
            usdInrRate,
          );
        const latestHistoryRebalance = historyInfo("rebalance");
        const latestHistoryTechnical = historyInfo("technical");
        const latestHistoryActionables = historyInfo("actionables");
        const historyActionablesTimestamp = [
          latestHistoryActionables.completedAt,
          latestHistoryTechnical.completedAt,
          latestHistoryRebalance.completedAt,
        ]
          .filter((value): value is string => Boolean(value))
          .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0] ?? null;

        acc[portfolio] = {
          pairwise: historyInfo("pairwise"),
          sync: {
            ...mergeStageEvidence({
              completedAt: overview?.latest?.captured_at ?? null,
              runStatus: overview?.latest ? syncStatus : null,
              evidence: overview?.latest ? { kind: "saved", references: [`Portfolio snapshot · ${overview.latest.captured_at}`] } : undefined,
            } as Partial<StageInfo>, historyInfo("sync"), true),
            ...(overview?.latest ? { portfolioStockCount: overview.latest.holdings_count } : {}),
          },
          swing: mergeStageEvidence(
            { ...summarizeRunForIdleTile(latestSwingRun, usdInrRate),
              ...(latestSwingRun ? swingRecommendationCounts(latestSwingRun) : {}) },
            historyInfo("swing"),
            true,
          ),
          threats: mergeStageEvidence(
            threat
              ? withInrCost(
                  {
                    ...summarizeThreat(threat),
                    evidence: { kind: "saved", references: [`Threat analysis · ${threat.status} · ${threat.updated_at ?? threat.created_at}`, ...(threat.job_id ? [`Job #${threat.job_id}`] : [])] },
                    completedLlms:
                      (threat.status || "").toLowerCase() === "completed" ? 1 : 0,
                    passedLlms:
                      (threat.status || "").toLowerCase() === "completed" ? 1 : 0,
                    failedLlms:
                      (threat.status || "").toLowerCase() === "failed" ? 1 : 0,
                    totalLlms: 1,
                  },
                  usdInrRate,
                )
              : {},
            historyInfo("threats"),
            true,
          ),
          rebalance: mergeStageEvidence(
            summarizeRunForIdleTile(
              latestRebalanceRun,
              usdInrRate,
              latestRebalanceRuns.length
                ? buildConsensusRows(latestRebalanceRuns, market).length
                : null,
            ),
            latestHistoryRebalance,
            true,
          ),
          technical: mergeStageEvidence(
            summarizeRunForIdleTile(
              latestTechnicalRun,
              usdInrRate,
              latestTechnicalRun
                ? countUniqueStocksFromRun(latestTechnicalRun)
                : null,
            ),
            latestHistoryTechnical,
            true,
          ),
          actionables: mergeStageEvidence({
            evidence: latestActionablesTimestamp || historyActionablesTimestamp ? { kind: "derived", references: [
              ...(latestActionablesTimestamp
                ? [latestTechnicalRun, latestRebalanceRun].filter(run => run && getLatestRunTimestamp(run) === latestActionablesTimestamp).map(run => `Timestamp source: run #${run!.id} · ${run!.status} · ${latestActionablesTimestamp}`)
                : [latestHistoryActionables, latestHistoryTechnical, latestHistoryRebalance].filter(info => info.completedAt === historyActionablesTimestamp).flatMap(info => (info.evidence?.references ?? []).map(reference => `Timestamp source: ${reference}`))),
              ...(latestActionableStocks.length
                ? latestRebalanceRuns.map(run => `Stock-count source: run #${run.id} · ${run.status} · ${getLatestRunTimestamp(run) ?? run.created_at}`)
                : ((latestHistoryRebalance.recommendedStocks ? latestHistoryRebalance : latestHistoryTechnical.recommendedStocks ? latestHistoryTechnical : {}).evidence?.references ?? []).map(reference => `Stock-count source: ${reference}`)),
              ...(latestRebalanceRuns.length
                ? latestRebalanceRuns.map(run => `Rebalance-input source: run #${run.id} · ${run.status}`)
                : latestHistoryRebalance.completedAt ? (latestHistoryRebalance.evidence?.references ?? []).map(reference => `Rebalance-input source: ${reference}`) : []),
            ] } : undefined,
            completedAt:
              latestActionablesTimestamp ?? historyActionablesTimestamp,
            runStatus:
              latestActionablesTimestamp || historyActionablesTimestamp
                ? "derived from latest rebalance/technical scan"
                : null,
            rebalanceInputs:
              latestRebalanceRuns.length ||
              (latestHistoryRebalance.completedAt ? 1 : null),
            recommendedStocks:
              latestActionableStocks.length ||
              latestHistoryRebalance.recommendedStocks ||
              latestHistoryTechnical.recommendedStocks ||
              null,
          }, latestHistoryActionables, true),
        };
        return acc;
      },
      {} as Record<
        WorkflowPortfolio,
        Record<WorkflowStageKey, Partial<StageInfo>>
      >,
    );

    await Promise.all((["zerodha","indmoneyUs"] as const).map(async portfolio => {
      const sequence = Math.max(0,...historyByPortfolio[portfolio].map(item=>item.sequence));
      if (!sequence) return;
      const saved = await scorecardApi(apiService,portfolio==="zerodha"?"india":"indmoney_us").coverage(sequence).catch(()=>null);
      if (portfolio === "zerodha" && saved?.revision_id) {
        Object.assign(nextByPortfolio.zerodha.swing, {sourceRevision:saved.revision_id, sourceListingCount:saved.listing_count});
      }
      if(portfolio==="zerodha" && saved?.final_summary){
        const f=saved.final_summary;
        Object.assign(nextByPortfolio.zerodha.actionables,{finalSummary:f,rebalanceInputs:f.rebalance_inputs,recommendedStocks:f.eligible});
      }
      for(const card of ["technical","pairwise","rebalance","threats"] as const){
        const output=saved?.cards[card];
        if(!output) continue;
        const stage=nextByPortfolio[portfolio][card];
        if(stage.workflowSequence && stage.workflowSequence!==sequence) continue;
        stage.published=output;
        if(card==="threats") {
          stage.threatCounts={expected:output.expected,returned:output.threat_returned??0,scored:output.covered,complete:output.threat_complete??0,status:output.threat_status??"unassessed"};
        }
        stage.evidenceCoverage=`${output.covered}/${output.expected} ${card==="pairwise"?"pairs judged":"stocks scored"}`;
        stage.workflowSequence=sequence;
      }
    }));
    setStates((current) => {
      if (!isCurrentWorkflowOwner(runtimeOwner) || generation !== savedStageReadGeneration.current) return current;
      const next = { ...current };
      (["zerodha", "indmoneyUs"] as WorkflowPortfolio[]).forEach((portfolio) => {
        next[portfolio] = { ...current[portfolio] };
        STAGE_ORDER.forEach((stage) => {
          const existing = current[portfolio][stage];
          const incoming = nextByPortfolio[portfolio][stage];
          if (isWorkflowExecutingRef.current || runningPortfolio === portfolio) return;
          if (portfolio === "zerodha") {
            if (latestIndia && (existing.workflowSequence ?? 0) <= latestIndia.sequence) {
              next[portfolio][stage] = { ...incoming, state: "idle" };
            }
            return;
          }
          if (existing.state === "running" || existing.state === "queued") return;
          const existingAt = parseTimestampMs(existing.completedAt ?? existing.endedAt);
          const incomingAt = parseTimestampMs(incoming.completedAt);
          const knownStockCount = incoming.portfolioStockCount ?? existing.portfolioStockCount;
          const snapshotCount = stage === "sync" && knownStockCount != null
            ? { portfolioStockCount: knownStockCount }
            : {};
          // Replace one run's evidence atomically: spreading the prior stage leaks
          // old errors and partial counts into a new successful result.
          const historyAvailable = indmoneyHistoryResult.status === "fulfilled";
          next[portfolio][stage] = historyAvailable && incoming.evidence && incomingAt > 0 && incomingAt >= existingAt
            ? { ...incoming, ...snapshotCount, state: "idle" }
            : { ...existing, ...snapshotCount };
        });
      });
      return next;
    });
  }, [apiService, runtimeOwner, usdInrRate, runningPortfolio]);

  useEffect(() => {
    const refreshSavedEvidence = () => {
      if (document.visibilityState === "visible") {
        void loadLatestIdleStageInfo().catch(() => {
          // Do not turn unavailable history into blank or successful output.
        });
      }
    };
    const timeoutId = window.setTimeout(refreshSavedEvidence, 0);
    window.addEventListener("focus", refreshSavedEvidence);
    return () => {
      window.clearTimeout(timeoutId);
      window.removeEventListener("focus", refreshSavedEvidence);
    };
  }, [loadLatestIdleStageInfo]);

  useEffect(() => {
    if (runningPortfolio || !latestIndiaWorkflow || !["pending", "queued", "processing", "running"].includes(latestIndiaWorkflow.status)) return;
    const interval = window.setInterval(() => {
      if (document.visibilityState === "visible") void loadLatestIdleStageInfo().catch(() => {});
    }, 15000);
    return () => window.clearInterval(interval);
  }, [runningPortfolio, latestIndiaWorkflow?.status, loadLatestIdleStageInfo]);

  useEffect(() => {
    if (runningPortfolio !== "zerodha") return;
    const warn = (event: BeforeUnloadEvent) => {
      if (isWorkflowExecutingRef.current) { event.preventDefault(); event.returnValue = ""; }
    };
    window.addEventListener("beforeunload", warn);
    return () => window.removeEventListener("beforeunload", warn);
  }, [runningPortfolio]);

  const updateStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info: Partial<StageInfo>,
    ) => {
      if (!isCurrentWorkflowOwner(runtimeOwner)) return;
      setStates((current) => {
        if (!isCurrentWorkflowOwner(runtimeOwner)) return current;
        const next = {
          ...current,
          [portfolio]: {
            ...current[portfolio],
            [stage]: { ...current[portfolio][stage], evidence: undefined, ...info,
              workflowSequence: info.workflowSequence ?? activeAutoRebalanceMetadataRef.current[portfolio]?.auto_rebalance_sequence ?? current[portfolio][stage].workflowSequence },
          },
        };
        const persisted = readPersistedWorkflow();
        if (persisted) {
          persistWorkflow({
            ...persisted,
            states: next,
            savedAt: new Date().toISOString(),
          });
        }
        return next;
      });
    },
    [runtimeOwner, ],
  );

  const getAuditSession = useCallback((
    portfolio: WorkflowPortfolio,
    metadata: AutoRebalanceRunMetadata,
  ) => {
    const key = autoRebalanceAuditKey(metadata);
    const existing = auditSessionsRef.current[portfolio];
    if (existing?.key === key) return existing;
    // These closures retain this run's identity through retries and teardown.
    const captured = { ...metadata };
    const session = new AutoRebalanceAuditSession(captured, {
      persist: (stage, payload) => apiService.updateAutoRebalanceStage(
        captured.auto_rebalance_portfolio,
        captured.auto_rebalance_sequence,
        stage,
        payload,
      ),
      read: () => apiService.getAutoRebalanceHistoryDetail(
        captured.auto_rebalance_portfolio,
        captured.auto_rebalance_sequence,
      ),
      delay: sleep,
      onFailure: (stage, error) => {
        console.error("Could not persist auto-rebalance stage audit", key, stage, error);
      },
      onChange: (state) => {
        if (auditSessionsRef.current[portfolio]?.key !== key) return;
        setAuditStates((current) => ({ ...current, [portfolio]: state }));
      },
    });
    auditSessionsRef.current[portfolio] = session;
    return session;
  }, [apiService, ]);

  const recordAutoRebalanceStage = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      status:
        | "processing"
        | "completed"
        | "partial"
        | "failed"
        | "skipped"
        | "paused"
        | "cancelled"
        | "interrupted",
      info: Partial<StageInfo> = {},
      links?: { runId?: number | null; jobId?: number | null },
    ) => {
      if (!isCurrentWorkflowOwner(runtimeOwner)) return;
      const metadata = activeAutoRebalanceMetadataRef.current[portfolio];
      if (!metadata) return;
      const payload = {
        status,
        run_id: links?.runId ?? info.lastRunId ?? null,
        job_id: links?.jobId ?? null,
        summary: {
          run_status: info.runStatus ?? null,
          provider: info.provider ?? null,
          model: info.model ?? null,
          completed_llms: info.completedLlms ?? null,
          total_llms: info.totalLlms ?? null,
          passed_llms: info.passedLlms ?? null,
          partial_llms: info.partialLlms ?? null,
          partial_notice: info.partialNotice ?? null,
          failed_llms: info.failedLlms ?? null,
          recommended_stocks: info.recommendedStocks ?? null,
          ...(info.commonStocks != null ? { common_stocks: info.commonStocks } : {}),
          rebalance_inputs: info.rebalanceInputs ?? null,
          ...(info.portfolioStockCount != null ? { portfolio_stock_count: info.portfolioStockCount } : {}),
          ...(info.finalInputs ? { final_inputs: info.finalInputs } : {}),
          ...(info.evidenceCoverage ? { evidence_coverage: info.evidenceCoverage } : {}),
          ...(info.distinctModels != null ? { distinct_models: info.distinctModels } : {}),
          ...(info.pairCoverage ? { pair_coverage: info.pairCoverage } : {}),
          ...(info.portfolioThreat ? { portfolio_threat: info.portfolioThreat } : {}),
          ...(info.frozenFinal ? { frozen_final: info.frozenFinal } : {}),
          cost_incomplete: info.costIncomplete ?? false,
          cost_usd: info.costUsd ?? null,
          cost_inr: info.costInr ?? null,
        },
        error_message: info.error ?? null,
        started_at: stage === "sync" || stage === "actionables" ? undefined : info.startedAt ?? undefined,
        completed_at: stage === "sync" || stage === "actionables" ? undefined : info.completedAt ?? info.endedAt ?? undefined,
      };
      return getAuditSession(portfolio, metadata).record(stage as AutoRebalanceStageKey, payload);
    },
    [runtimeOwner, getAuditSession],
  );

  const resetPortfolio = useCallback((portfolio: WorkflowPortfolio) => {
    // Invalidate reads started before the Run click, including before reservation.
    savedStageReadGeneration.current += 1;
    setWorkflowHistoryError(null);
    setStates((current) => ({
      ...current,
      [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
        // Saved evidence remains in audit/history, never in a new run's cells.
        acc[stage] = { state: "idle" };
        return acc;
      }, {} as WorkflowState),
    }));
  }, []);

  const completeSkippedStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      note = "Using latest saved output",
    ) => {
      const timestamp = new Date().toISOString();
      updateStage(portfolio, stage, {
        state: specificMode[portfolio] ? "idle" : "completed",
        ...(specificMode[portfolio]
          ? {}
          : {
              startedAt: timestamp,
              endedAt: timestamp,
              completedAt: timestamp,
            }),
        runStatus: note,
        error: null,
      });
      void recordAutoRebalanceStage(
        portfolio,
        stage,
        "skipped",
        {
          startedAt: timestamp,
          endedAt: timestamp,
          completedAt: timestamp,
          runStatus: note,
        },
      );
    },
    [recordAutoRebalanceStage, specificMode, updateStage],
  );

  const markRunning = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      extra?: Partial<StageInfo>,
    ) => {
      const timestamp = new Date().toISOString();
      updateStage(portfolio, stage, {
        state: "running",
        startedAt: timestamp,
        endedAt: null,
        completedAt: null,
        error: null,
        errorDetails: [],
        lastRunId: null, activeRunId: null, recommendedStocks: null, commonStocks: null, jobId: null, workflowSequence: null,
        passedLlms: 0, partialLlms: 0, failedLlms: 0, completedLlms: 0,
        partialNotice: null, exportStatus: null, costUsd: null, costInr: null, costIncomplete: false,
        provider: null, model: null, runStatus: "processing", totalLlms: null,
        rebalanceInputs: null, frozenFinal: undefined,
        ...extra,
      });
      void recordAutoRebalanceStage(portfolio, stage, "processing", {
        startedAt: timestamp,
        ...extra,
      });
    },
    [recordAutoRebalanceStage, updateStage],
  );

  const markCompleted = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info: Partial<StageInfo>,
    ) => {
      const timestamp = new Date().toISOString();
      const infoWithInrCost = withInrCost(info, verifiedRate);
      updateStage(portfolio, stage, {
        state: "completed",
        endedAt: timestamp,
        completedAt: infoWithInrCost.completedAt ?? timestamp,
        activeRunId: null,
        ...infoWithInrCost,
      });
      return recordAutoRebalanceStage(
        portfolio,
        stage,
        infoWithInrCost.runStatus?.toLowerCase() === "partial"
          ? "partial"
          : "completed",
        {
        ...infoWithInrCost,
        startedAt: infoWithInrCost.startedAt,
        endedAt: timestamp,
        completedAt: infoWithInrCost.completedAt ?? timestamp,
        },
      );
    },
    [recordAutoRebalanceStage, updateStage, verifiedRate],
  );

  // Poll ownership changes only with execution identity, never progress/cost/display updates.
  const restoredPollingIdentity = JSON.stringify([runningPortfolio, runningPortfolio ? STAGE_ORDER.map(stage => [stage, states[runningPortfolio][stage].state, states[runningPortfolio][stage].activeRunId ?? null]) : null]);
  const restoredPollingContext = useRef({ states, specificMode, selectedStages, markCompleted, recordAutoRebalanceStage, updateStage, usdInrRate: verifiedRate });
  restoredPollingContext.current = { states, specificMode, selectedStages, markCompleted, recordAutoRebalanceStage, updateStage, usdInrRate: verifiedRate };
  useEffect(() => {
    const { states, specificMode, selectedStages, recordAutoRebalanceStage } = restoredPollingContext.current;
    if (!runningPortfolio) return;
    // The visible workflow is driven by runWorkflow while this tab is open.
    // Its stages briefly hand off from a completed job to the next queued job;
    // treating that normal gap as a restored/abandoned session clears the run
    // controls and strands the remaining stages.
    if (isWorkflowExecutingRef.current) return;
    const runningEntries = STAGE_ORDER.flatMap((stage) => {
      const info = states[runningPortfolio][stage];
      return info.state === "running" && info.activeRunId
        ? [{ stage, runId: info.activeRunId }]
        : [];
    });
    if (runningEntries.length === 0) {
      const hasQueuedStages = STAGE_ORDER.some(
        (stage) => states[runningPortfolio][stage].state === "queued",
      );
      const hasVisibleFinishedStages = STAGE_ORDER.some((stage) =>
        ["completed", "failed"].includes(states[runningPortfolio][stage].state),
      );
      if (hasQueuedStages || hasVisibleFinishedStages) {
        const timestamp = new Date().toISOString();
        const lastTerminalStageIndex = STAGE_ORDER.reduce(
          (latestIndex, stage, index) =>
            ["completed", "failed"].includes(states[runningPortfolio][stage].state)
              ? index
              : latestIndex,
          -1,
        );
        const interruptedStage =
          STAGE_ORDER.find((stage) =>
            ["queued", "running"].includes(states[runningPortfolio][stage].state),
          ) ??
          STAGE_ORDER.find(
            (stage, index) =>
              index > lastTerminalStageIndex &&
              (!specificMode[runningPortfolio] || selectedStages[runningPortfolio].has(stage)),
          );
        if (interruptedStage) {
          void recordAutoRebalanceStage(runningPortfolio, interruptedStage, "interrupted", {
            endedAt: timestamp,
            runStatus: "interrupted",
            error:
              "This browser session ended before the next auto-rebalance stage could be launched. Completed worker output was preserved; start a new run to continue safely.",
          });
        }
        setStates((current) => ({
          ...current,
          [runningPortfolio]: STAGE_ORDER.reduce((acc, stage) => {
            const info = current[runningPortfolio][stage];
            acc[stage] =
              info.state === "queued"
                ? {
                    ...info,
                    state: "idle",
                    endedAt: timestamp,
                    runStatus:
                      "Not started before this browser session ended",
                  }
                : info;
            return acc;
          }, {} as WorkflowState),
        }));
        setRunningPortfolio(null);
        setWorkflowPaused(false);
        pauseRequestedRef.current = false;
        delete activeAutoRebalanceMetadataRef.current[runningPortfolio];
        setActiveAutoRebalanceMetadata((current) => {
          const next = { ...current };
          delete next[runningPortfolio];
          return next;
        });
      }
      return;
    }

    activeExecutionRefsRef.current = runningEntries.map(({ stage, runId }) => ({
      kind: stage === "threats" ? "job" : "run",
      id: runId,
    }));

    let cancelled = false;
    let inFlight = false;
    const poll = async () => {
      if (cancelled || inFlight || !isCurrentWorkflowOwner(runtimeOwner)) return;
      inFlight = true;
      const { markCompleted, updateStage, usdInrRate } = restoredPollingContext.current;
      try {
      await Promise.allSettled(
        runningEntries.map(async ({ stage, runId }) => {
          if (stage === "threats") {
            const analysis =
              runningPortfolio === "zerodha"
                ? await apiService.zerodhaThreatJob(runId)
                : await apiService.indmoneyUsThreatJob(runId);
            if (cancelled) return;
            const status = (analysis.status || "").toLowerCase();
            updateStage(runningPortfolio, stage, {
              ...withInrCost(summarizeThreat(analysis), usdInrRate),
              completedLlms: ["completed", "partial", "failed"].includes(status) ? 1 : 0,
              passedLlms: status === "completed" ? 1 : 0,
              partialLlms: status === "partial" ? 1 : 0,
              failedLlms: status === "failed" ? 1 : 0,
              totalLlms: 1,
            });
            if (status === "completed") {
              markCompleted(runningPortfolio, stage, {
                ...summarizeThreat(analysis),
                completedLlms: 1,
                passedLlms: 1,
                failedLlms: 0,
                totalLlms: 1,
              });
            } else if (status === "failed") {
              updateStage(runningPortfolio, stage, {
                state: "failed",
                endedAt: new Date().toISOString(),
                error: analysis.error_message ?? "Threats scan failed.",
                runStatus: analysis.status,
              });
            }
            return;
          }

          const run = await apiService.getRun(runId);
          if (cancelled) return;
          const status = (run.status || "").toLowerCase();
          const market: SwingTradeMarket =
            runningPortfolio === "zerodha" ? "india" : "us";
          const runSummary = withInrCost(
            {
              ...summarizeRun(run),
              ...getRunProgress(run),
              lastRunId: run.id,
              recommendedStocks:
                stage === "technical"
                  ? countUniqueStocksFromRun(run)
                  : stage === "rebalance"
                    ? buildConsensusRows(
                        getLatestMatchingRebalanceRuns([run], market),
                        market,
                      ).length || null
                    : undefined,
              ...(stage === "swing" ? swingRecommendationCounts(run) : {}),
            },
            usdInrRate,
          );
          updateStage(runningPortfolio, stage, runSummary);
          if (status === "completed" || status === "partial") {
            markCompleted(runningPortfolio, stage, {
              ...runSummary,
            });
          } else if (status === "failed") {
            updateStage(runningPortfolio, stage, {
              ...runSummary,
              state: "failed",
              endedAt: new Date().toISOString(),
              error: summarizeRun(run).error ?? `Run #${run.id} failed.`,
            });
          }
        }),
      );
      } finally { inFlight = false; }
    };

    void poll();
    const timer = window.setInterval(() => void poll(), POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  // Execution identity is the only restart trigger; current callbacks live in the ref above.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restoredPollingIdentity]);

  const toggleSpecificMode = useCallback((portfolio: WorkflowPortfolio) => {
    setSpecificMode((current) => {
      const nextEnabled = !current[portfolio];
      if (nextEnabled) {
        setSelectedStages((selected) => ({
          ...selected,
          [portfolio]: new Set(),
        }));
      }
      return { ...current, [portfolio]: nextEnabled };
    });
  }, []);

  const toggleStageSelection = useCallback(
    (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      setSelectedStages((current) => {
        const nextSet = new Set(current[portfolio]);
        if (nextSet.has(stage)) nextSet.delete(stage);
        else nextSet.add(stage);
        return { ...current, [portfolio]: nextSet };
      });
    },
    [],
  );

  const loadInputCandidates = useCallback(
    async (portfolio: WorkflowPortfolio, stage: InputSelectionStage) => {
      setInputCandidatesLoading(true);
      setInputCandidatesError(null);
      try {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        const nextCandidate = buildNextCandidate(stage, market);
        let candidates: InputSelectionCandidate[] = [nextCandidate];

        if (stage === "threats") {
          const overview =
            portfolio === "zerodha"
              ? await apiService.zerodhaPortfolioOverview()
              : await apiService.indmoneyUsPortfolioOverview();
          if (overview.latest) {
            candidates.push({
              id: `portfolio:${portfolio}:latest`,
              source: "run-job",
              label:
                portfolio === "zerodha"
                  ? "Latest Zerodha portfolio snapshot"
                  : "Latest INDmoney US snapshot",
              jobNo: "Latest snapshot",
              timestamp: overview.latest.captured_at ?? null,
              status:
                portfolio === "zerodha"
                  ? "synced"
                  : (("parse_status" in overview.latest
                      ? overview.latest.parse_status
                      : null) ?? "parsed"),
              costUsd: null,
              error: null,
              content: JSON.stringify(overview.latest, null, 2),
              market,
            });
          }
        } else if (stage === "swing") {
          candidates = [{...nextCandidate, content: swingPrompts[portfolio]}];
        } else if (stage !== "actionables") {
          const runs = await fetchDashboardRecentFullRuns();
          if (stage === "rebalance") {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs
                    .filter((run) =>
                      isAnalysisRunForStage(run, "swing", market),
                    ),
                ),
                "Swing Scan",
                market,
              ),
            );
          } else if (stage === "technical") {
            candidates = candidates.concat(
              buildRunJobCandidates(
                sortRunsByLatestTimestamp(
                  runs.filter((run) => isCompletedRebalanceRun(run, market)),
                ),
                "Rebalance Scan",
                market,
              ),
            );
          }
        }

        setInputCandidates(candidates);
        // Loading options is read-only: retain Next, explicit jobs, and empty selections.

      } finally {
        setInputCandidatesLoading(false);
      }
    },
    [apiService, swingPrompts],
  );

  const openInputSelection = useCallback(
    (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
      if (
        stage !== "threats" &&
        stage !== "swing" &&
        stage !== "rebalance" &&
        stage !== "technical" &&
        stage !== "actionables"
      )
        return;
      const inputStage = stage as InputSelectionStage;
      setInputDialog({ portfolio, stage: inputStage });
      void loadInputCandidates(portfolio, inputStage).catch((error) => {
        setInputCandidates([]);
        setInputCandidatesError(normalizeError(error));
        window.alert(
          `Could not load selectable inputs: ${normalizeError(error)}`,
        );
      });
    },
    [loadInputCandidates],
  );

  const toggleInputCandidate = useCallback(
    (id: string) => {
      if (!inputDialog) return;
      setSelectedInputs((current) => {
        const nextSet = new Set(
          current[inputDialog.portfolio][inputDialog.stage],
        );
        if (nextSet.has(id)) nextSet.delete(id);
        else nextSet.add(id);
        return {
          ...current,
          [inputDialog.portfolio]: {
            ...current[inputDialog.portfolio],
            [inputDialog.stage]: nextSet,
          },
        };
      });
    },
    [inputDialog],
  );

  const toggleAllInputCandidates = useCallback(() => {
    if (!inputDialog) return;
    setSelectedInputs((current) => {
      const allSelected = inputCandidates.every((candidate) =>
        current[inputDialog.portfolio][inputDialog.stage].has(candidate.id),
      );
      return {
        ...current,
        [inputDialog.portfolio]: {
          ...current[inputDialog.portfolio],
          [inputDialog.stage]: allSelected
            ? new Set()
            : new Set(inputCandidates.map((candidate) => candidate.id)),
        },
      };
    });
  }, [inputDialog, inputCandidates]);

  const resetDefaultInputCandidates = useCallback(() => {
    if (!inputDialog) return;
    const nextCandidateId = `${inputDialog.stage}:next`;
    const defaultIds = [nextCandidateId];
    setSelectedInputs((current) => ({
      ...current,
      [inputDialog.portfolio]: {
        ...current[inputDialog.portfolio],
        [inputDialog.stage]: new Set(defaultIds),
      },
    }));
  }, [inputCandidates, inputDialog]);

  const waitForRunWithStageHandling = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      runId: number,
      backendScored = false,
    ) => {
      activeExecutionRefsRef.current = [
        ...activeExecutionRefsRef.current.filter(
          (entry) => !(entry.kind === "run" && entry.id === runId),
        ),
        { kind: "run", id: runId },
      ];
      updateStage(portfolio, stage, { activeRunId: runId });
      void recordAutoRebalanceStage(
        portfolio,
        stage,
        "processing",
        { activeRunId: runId },
        { runId },
      );

      let run: RunResponse;
      try {
        run = await waitForRunCompletion(
          runId,
          (progressRun) =>
            updateStage(portfolio, stage, getRunProgress(progressRun)),
          () => cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner),
        );
      } catch (error) {
        if (error instanceof APIError && error.status === 401) {
          updateStage(portfolio, stage, {
            state: "failed",
            endedAt: new Date().toISOString(),
            runStatus: "auth expired",
            error:
              "Dashboard authentication expired while polling. The worker job may still have completed and saved output in the background; refresh/sign in again before verifying the result.",
          });
          throw new Error(
            "Dashboard authentication expired while polling. The worker job may still complete in the background; refresh/sign in again and open View Output or the stage screen to verify saved results.",
          );
        }
        throw error;
      }
      const status = (run.status || "").toLowerCase();
      if (status === "completed" || status === "partial" || (backendScored && status === "failed")) return run;

      const progress = getRunProgress(run);
      const failureSummary = summarizeRun(run);
      // The progress poll intentionally carries only counters. Before throwing
      // a terminal failure, copy the full saved job/provider diagnostics into
      // the stage so the modal never has to reconstruct them from a generic
      // JavaScript Error.
      updateStage(portfolio, stage, {
        ...failureSummary,
        ...progress,
        state: "failed",
        activeRunId: null,
        lastRunId: run.id,
        endedAt: getLatestRunTimestamp(run),
      });
      const error = failureSummary.error;
      throw new Error(
        `Run #${runId} ended with status "${run.status}". Completed so far: ${progress.completedLlms}/${progress.totalLlms} LLMs.${error ? ` Error: ${error}` : ""}`,
      );
    },
    [runtimeOwner, recordAutoRebalanceStage, updateStage],
  );

  const showStageLlmInfo = useCallback(async (portfolio: WorkflowPortfolio, stage: WorkflowStageKey) => {
    if (!isModelStage(stage)) return;
    const requestId = ++llmDialogRequestRef.current;
    const prompt = swingPrompts[portfolio];

    setLegacyKeys(null);
    setModelSaveError(null);
    setLlmDialogStage(stage);
    setLlmDialogPortfolio(portfolio);
    setLlmDialogProviders([]);
    setLlmDialogSelectedKeys(new Set());
    setLlmDialogMultipliers({});
    setLlmDialogHistoricalCosts({});
    setLlmDialogError(null);
    setLlmDialogLoading(true);

    // Cost history is optional display data. It must never prevent a user from
    // choosing models, even when the history endpoint is temporarily unavailable.
    const historicalCostsPromise = loadStageHistoricalCostMapInr(
      stage,
      portfolio,
      usdInrRate,
    );

    let lastProviderError: unknown = null;
    try {
      let providers: ProviderInfo[] | null = null;
      for (let attempt = 0; attempt < 2 && !providers; attempt += 1) {
        try {
          providers = await apiService.getProviders({ prompt });
        } catch (error) {
          lastProviderError = error;
          if (attempt === 0) await sleep(350);
        }
      }
      if (!providers) throw lastProviderError ?? new Error("Provider models are unavailable.");

      const saved = await loadModelPreferences();
      if (requestId !== llmDialogRequestRef.current) return;
      const targetKeys = resolveStageModelKeys(stage, saved, portfolio);
      const previous = saved[stage] === undefined ? previousBrowserSelection(stage) : null;
      const compatible = new Set(getCompatibleTargets(providers).map(targetKey));
      if (previous && previous.every(key => compatible.has(key)) && JSON.stringify(previous) !== JSON.stringify(targetKeys)) {
        setLegacyKeys(previous);
      }
      setLlmDialogProviders(providers);
      setLlmDialogSelectedKeys(new Set(targetKeys));
      setLlmDialogMultipliers(getSelectionMultipliers(targetKeys));

      void historicalCostsPromise
        .then((historicalCosts) => {
          if (requestId === llmDialogRequestRef.current) {
            setLlmDialogHistoricalCosts(historicalCosts);
          }
        })
        .catch(() => {
          // Historical cost estimates are best-effort only.
        });
    } catch (error) {
      if (requestId === llmDialogRequestRef.current) {
        setLlmDialogError(normalizeError(error));
      }
    } finally {
      if (requestId === llmDialogRequestRef.current) {
        setLlmDialogLoading(false);
      }
    }
  }, [apiService, loadModelPreferences, usdInrRate, swingPrompts]);

  const showStageOutput = useCallback(
    async (portfolio: WorkflowPortfolio, stage: WorkflowStageKey, requestedRunId?: number) => {
      const title = `${portfolio === "zerodha" ? "Zerodha India" : "INDmoney US"} · ${STAGE_METADATA[stage].idle} Output`;
      const requestId = ++outputRequestRef.current;
      const routeUrl = getStageOutputRoute(portfolio, stage);
      setOutputDialog({
        portfolio,
        stage,
        requestedRunId,
        title,
        body: "",
        loading: stage !== "actionables",
        error: null,
        routeUrl,
        run: null,
      });
      try {
        const market: SwingTradeMarket =
          portfolio === "zerodha" ? "india" : "us";
        let body = "No saved output is available yet.";
        let savedAt: string | null = null;
        let provenance: string | null = null;
        let savedError: string | null = null;
        let selectedRun: RunResponse | null = null;
        if (stage === "sync") {
          const overview =
            portfolio === "zerodha"
              ? await apiService.zerodhaPortfolioOverview()
              : await apiService.indmoneyUsPortfolioOverview();
          body = overview.latest ? JSON.stringify(overview.latest, null, 2) : "No saved portfolio snapshot is available yet.";
          savedAt = overview.latest?.captured_at ?? null;
          provenance = overview.latest ? `Portfolio snapshot · ${overview.latest.snapshot_date} · ${overview.latest.source}` : null;
        } else if (stage === "threats") {
          const latest = requestedRunId ? (portfolio === "zerodha"
            ? await apiService.zerodhaThreatJob(requestedRunId) : await apiService.indmoneyUsThreatJob(requestedRunId))
            : (portfolio === "zerodha" ? await apiService.zerodhaThreatsLatest() : await apiService.indmoneyUsThreatsLatest()).analysis;
          savedAt = latest?.updated_at ?? latest?.created_at ?? null;
          provenance = latest ? `Job #${latest.job_id} · ${latest.provider}/${latest.model} · ${latest.status}` : null;
          if (latest?.error_message && !latest.report) savedError = latest.error_message;
          body = latest?.report?.raw_markdown?.trim() ||
            (latest?.report ? JSON.stringify(latest.report, null, 2) :
              latest ? `Saved job status: ${latest.status}. No report text has been saved for this job.` :
              "No saved threat output is available yet.");
        } else if (stage === "actionables") {
          body =
            "Final Actionables are rendered in the dashboard output tables below. Use the section anchor to inspect the latest India and US actionable rows.";
        } else {
          const runs = await fetchAllFullRuns();
          selectedRun = sortRunsByLatestTimestamp(
            runs.filter((run) => {
              if (requestedRunId !== undefined && run.id !== requestedRunId) return false;
              if (stage === "swing")
                return isAnalysisRunForStage(run, "swing", market);
              if (stage === "rebalance")
                return isCompletedRebalanceRun(run, market);
              if (stage === "technical")
                return isTechnicalScanRun(run, market);
              return false;
            }),
          )[0];
          savedAt = selectedRun ? getLatestRunTimestamp(selectedRun) : null;
          provenance = selectedRun ? `Run #${selectedRun.id}` : null;
          const jobs =
            selectedRun?.run_jobs?.map((link) => link.job).filter(Boolean) ?? [];
          body = jobs.length
            ? [
                `## Last run summary\n${selectedRun ? getRunOutputSummary(selectedRun, usdInrRate) : "Not available"}`,
                jobs
                  .map(
                    (job) =>
                      `# ${selectedRun ? getRunOutputDisplayLabel(selectedRun) : "Run"} / Job ${job?.id} · ${job?.provider ?? "LLM"}/${job?.model ?? "model"}\n\n${job?.response?.trim() || job?.error_message || "No response text saved."}`,
                  )
                  .join("\n\n---\n\n"),
              ].join("\n\n---\n\n")
            : "No saved LLM output is available yet.";
        }
        if (requestId !== outputRequestRef.current) return;
        setOutputDialog({
          portfolio,
          stage,
          requestedRunId,
          title,
          body,
          loading: false,
          error: savedError,
          routeUrl,
          savedAt,
          provenance,
          run: selectedRun,
        });
      } catch (error) {
        if (requestId !== outputRequestRef.current) return;
        setOutputDialog({
          portfolio,
          stage,
          requestedRunId,
          title,
          body: "",
          loading: false,
          error: normalizeError(error),
          routeUrl,
          run: null,
        });
      }
    },
    [apiService, usdInrRate],
  );

  useEffect(() => {
    const handleOpenStageOutput = (event: Event) => {
      const payload = (event as CustomEvent<{ runId?: number; stage?: WorkflowStageKey; portfolio?: WorkflowPortfolio }>).detail;
      if (!Number.isSafeInteger(payload?.runId) || (payload.runId ?? 0) <= 0) return;
      if (payload.stage !== "rebalance" && payload.stage !== "technical") return;
      if (payload.portfolio !== "zerodha" && payload.portfolio !== "indmoneyUs") return;
      event.preventDefault();
      void showStageOutput(payload.portfolio, payload.stage, payload.runId);
    };
    window.addEventListener("final-actionables:open-stage-output", handleOpenStageOutput);
    return () => {
      outputRequestRef.current += 1;
      window.removeEventListener("final-actionables:open-stage-output", handleOpenStageOutput);
    };
  }, [showStageOutput]);

  function saveModelKeys(keys: string[]) {
    if (!llmDialogStage || llmDialogLoading || llmDialogError || pendingModelSave.current) return;
    if (usesSingleScorecardJob(llmDialogStage, llmDialogPortfolio) && keys.length !== 1) {
      setModelSaveError("Choose exactly one model for this scorecard.");
      return;
    }
    if (keys.length > 8) {
      setModelSaveError("A stage can run up to eight model calls, including repeats. Reduce the selection and try again.");
      return;
    }
    const requestId = llmDialogRequestRef.current;
    const stage = llmDialogStage;
    setModelSaveError(null);
    setSavingModels(true);
    const write = apiService.saveWorkflowModels(stage, keys);
    pendingModelSave.current = write;
    void write.then(() => {
      if (requestId !== llmDialogRequestRef.current) return;
      setLlmDialogSelectedKeys(new Set(keys));
      setLlmDialogMultipliers(getSelectionMultipliers(keys));
      setLegacyKeys(null);
    }).catch(error => {
      if (isCurrentWorkflowOwner(runtimeOwner)) setModelSaveError(`Could not save ${getStageTileLabel(stage)} models. ${normalizeError(error)}`);
    }).finally(() => {
      pendingModelSave.current = null;
      setSavingModels(false);
    });
  }

  function persistLlmDialogSelection(keys: Set<string>) {
    saveModelKeys(expandSelectionKeys(keys, llmDialogMultipliers));
  }

  function toggleLlmTarget(key: string) {
    if (llmDialogStage === "threats" || llmDialogStage === "technical" || usesSingleScorecardJob(llmDialogStage ?? "", llmDialogPortfolio)) {
      saveModelKeys([key]);
      return;
    }
    const next = new Set(llmDialogSelectedKeys);
    if (next.has(key)) next.delete(key);
    else next.add(key);
    persistLlmDialogSelection(next);
  }

  function changeLlmMultiplier(key: string, count: number) {
    const next = new Set(llmDialogSelectedKeys);
    if (count > 0) next.add(key);
    else next.delete(key);
    saveModelKeys(expandSelectionKeys(next, { ...llmDialogMultipliers, [key]: count }));
  }

  const navigateForStage = useCallback(
    (
      portfolio: WorkflowPortfolio,
      stage: WorkflowStageKey,
      info?: StageInfo,
    ) => {
      if (info?.state === "failed" && info.error) {
        window.alert(info.error);
        return;
      }
      const zerodha = portfolio === "zerodha";
      const hrefByStage: Record<WorkflowStageKey, string> = {
        pairwise: URLs.routes.console.dashboard(),
        sync: zerodha
          ? URLs.routes.console.zerodha()
          : URLs.routes.console.indmoneyUs(),
        swing: zerodha
          ? `${URLs.routes.console.zerodhaSwingTrade()}#recent-jobs`
          : `${URLs.routes.console.indmoneyUsSwingTrade()}#recent-jobs`,
        threats: zerodha
          ? URLs.routes.console.zerodhaThreats()
          : URLs.routes.console.indmoneyUsThreats(),
        rebalance: zerodha
          ? URLs.routes.console.zerodhaRebalance()
          : URLs.routes.console.indmoneyUsRebalance(),
        technical: `${URLs.routes.console.dashboard()}#final-actionables`,
        actionables: `${URLs.routes.console.dashboard()}#final-actionables`,
      };
      if ((stage === "technical" || stage === "actionables") && window.location.pathname === URLs.routes.console.dashboard()) {
        document.getElementById("final-actionables")?.scrollIntoView({ behavior: "smooth", block: "start" });
        return;
      }
      window.open(hrefByStage[stage], "_blank", "noopener,noreferrer");
    },
    [],
  );

  const showStagePrompt = useCallback(
    (portfolio: WorkflowPortfolio, stage: PromptPreviewStage) => {
      const portfolioLabel = portfolio === "zerodha" ? "Zerodha" : "INDmoney US";
      setPromptDialog({
        portfolio,
        stage,
        title: `${portfolioLabel} ${getStageTileLabel(stage)} prompt`,
      });
    },
    [],
  );

  const buildZerodhaPopupFeatures = useCallback(() => {
    const width = 560;
    const height = 760;
    const left = Math.max(window.screenX + (window.outerWidth - width) / 2, 0);
    const top = Math.max(window.screenY + (window.outerHeight - height) / 2, 0);
    return `popup=yes,width=${width},height=${height},left=${Math.round(left)},top=${Math.round(top)}`;
  }, []);

  const ensureZerodhaConnectedForSync = useCallback(async (preOpenedPopup?: Window | null) => {
    let releaseLogin: (() => void) | null = null;
    try {
      const status = await apiService.zerodhaStatus();
      if (status.connected) {
        preOpenedPopup?.close();
        return;
      }

      releaseLogin = acquireZerodhaLogin();
      if (!releaseLogin) throw new Error("Another Zerodha sign-in is already open. Complete or close it before retrying.");
      const login = await apiService.zerodhaLoginUrl();
      if (!login.configured || !login.login_url) {
        preOpenedPopup?.close();
        throw new Error("Zerodha is not configured on this server.");
      }

      const canReusePreOpenedPopup = Boolean(preOpenedPopup && !preOpenedPopup.closed);
      const popup = canReusePreOpenedPopup
        ? preOpenedPopup
        : window.open(
            login.login_url,
            "zerodha-workflow-connect",
            buildZerodhaPopupFeatures(),
          );

      if (!popup) {
        throw new Error(
          "Zerodha login popup was blocked. Allow popups for CredX and try again.",
        );
      }

      if (canReusePreOpenedPopup) {
        popup.location.href = login.login_url;
      }
      popup.focus();

      await new Promise<void>((resolve, reject) => {
        let settled = false;
        let releaseOwner: () => void = () => {};
        let statusCheckInFlight = false;
        let popupClosedAt: number | null = null;
        const finish = (error?: Error) => {
          if (settled) return;
          settled = true;
          releaseOwner();
          window.removeEventListener("message", handleMessage);
          window.clearInterval(popupPoll);
          window.clearTimeout(timeout);
          if (!popup.closed) popup.close();
          if (error) reject(error);
          else resolve();
        };
        const confirmConnection = async () => {
          if (settled || statusCheckInFlight) return;
          statusCheckInFlight = true;
          try {
            const latestStatus = await apiService.zerodhaStatus();
            if (latestStatus.connected) finish();
          } catch (error) {
            // The callback may still be committing or a gateway read may be
            // transiently unavailable. Keep polling until the bounded deadline.
            console.warn("Waiting for Cred-X to confirm the Zerodha login.", error);
          } finally {
            statusCheckInFlight = false;
          }
        };
        const handleMessage = (event: MessageEvent) => {
          if (event.origin !== window.location.origin) return;
          if (event.source !== popup) return;
          const data = event.data as
            | { type?: string; message?: string }
            | null
            | undefined;
          if (data?.type === "zerodha_connected") {
            void confirmConnection();
          } else if (data?.type === "zerodha_error") {
            finish(new Error(data.message || "Zerodha connection failed."));
          }
        };
        const popupPoll = window.setInterval(() => {
          void confirmConnection();
          if (popup.closed && popupClosedAt === null) {
            popupClosedAt = Date.now();
          }
          if (
            popupClosedAt !== null &&
            Date.now() - popupClosedAt >= ZERODHA_AUTH_CLOSE_GRACE_MS
          ) {
            finish(
              new Error(
                "The Kite login window closed, but Cred-X could not confirm that the Zerodha token was saved. Please retry the login.",
              ),
            );
          }
        }, ZERODHA_AUTH_STATUS_POLL_MS);
        const timeout = window.setTimeout(() => {
          finish(new Error("Zerodha login timed out before connection completed."));
        }, ZERODHA_AUTH_TIMEOUT_MS);
        window.addEventListener("message", handleMessage);
        releaseOwner = onWorkflowOwnerInvalidated(() => finish(new Error("Account changed before Zerodha sign-in completed.")));
        void confirmConnection();
      });
    } finally {
      releaseLogin?.();
      // Preflight may fail before the login URL or polling cleanup exists.
      if (preOpenedPopup && !preOpenedPopup.closed) preOpenedPopup.close();
    }
  }, [apiService, buildZerodhaPopupFeatures]);

  const runWorkflow = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      indmoneyPayload?: IndMoneyUsPortfolioSnapshotCreateRequest,
      savedSnapshot?: IndMoneyUsPortfolioSnapshotDetail,
      recovery?: { sequence: number; revision: number; analysisOnly: boolean },
    ) => {
      if (!isCurrentWorkflowOwner(runtimeOwner)) return;
      // Kill may clear the visible running portfolio before its asynchronous
      // work has unwound. Do not let a new run steal that work's identity.
      if (isWorkflowExecutingRef.current) return;
      const market: SwingTradeMarket = portfolio === "zerodha" ? "india" : "us";
      const runSpecificMode = Boolean(recovery) || specificMode[portfolio];
      const stagesToRun = new Set<WorkflowStageKey>(recovery ? [...cards, "actionables"] : selectedStages[portfolio]);
      if (runSpecificMode && stagesToRun.size === 0) {
        window.alert("Select at least one stage to run.");
        return;
      }
      const shouldRunCurrentStage = (stage: WorkflowStageKey) =>
        !runSpecificMode || stagesToRun.has(stage);
      let currentStage: WorkflowStageKey = "sync";

      // Zerodha authentication must be opened synchronously from the Run click.
      // Waiting for the run-label reservation first loses the browser user gesture
      // and Chrome/Safari can block the popup, making Run appear to do nothing.
      const zerodhaPopup =
        portfolio === "zerodha" && shouldRunCurrentStage("sync")
          ? window.open("about:blank", "zerodha-workflow-connect", buildZerodhaPopupFeatures())
          : null;

      isWorkflowExecutingRef.current = true;
      setPreflightPortfolio(portfolio);
      setPreflightErrors(previous => ({ ...previous, [portfolio]: [] }));
      const targets: Partial<Record<WorkflowStageKey, ProviderModelTarget[]>> = {};
      const cardModelErrors: Partial<Record<CardKey,string>> = {};
      const checks: PreflightCheck[] = [
        { label: "LLM configuration", run: async () => {
          const modelStages = (["swing", ...cards] as const).filter(shouldRunCurrentStage);
          if (!modelStages.length) return;
          const [providers, saved] = await Promise.all([
            apiService.getProviders({ prompt: swingPrompts[portfolio] }),
            loadModelPreferences(),
          ]);
          const issues: string[] = [];
          const compatible = new Map(getCompatibleTargets(providers).map(target => [targetKey(target), target]));
          for (const stage of modelStages) {
            const keys = resolveStageModelKeys(stage, saved, portfolio);
            targets[stage] = keys.flatMap(key => compatible.get(key) ?? []);
            const unavailable = [...new Set(keys.filter(key => !compatible.has(key)))];
            const modelIssue = unavailable.length ? `${stage} has unavailable selected models (${unavailable.join(", ")}). Open its LLM selector and update the selection.`
              : !targets[stage]?.length ? `${stage} has no compatible model. Open its LLM selector and choose a configured model.` : null;
            if (modelIssue) {
              if (stage === "swing") issues.push(modelIssue);
              else cardModelErrors[stage] = modelIssue;
            }
          }
          if (issues.length) throw new Error(issues.join("\n"));
        } },
      ];
      if (!shouldRunCurrentStage("swing") && (cards.some(shouldRunCurrentStage) || shouldRunCurrentStage("actionables"))) {
        checks.push({label:"Stage 2 publication", run:async()=>{
          const id=recovery?.revision ?? sourceSelections[portfolio];
          if (id) { await scorecardApi(apiService, portfolio==="zerodha"?"india":"indmoney_us").read(id); return; }
          if (![...selectedInputs[portfolio].rebalance].some(key=>/^run:[1-9]\d*:job:[1-9]\d*$/.test(key))) throw new Error("Select a Stage 2 revision or choose Swing to publish one.");
        }});
      }
      if (portfolio === "indmoneyUs" && shouldRunCurrentStage("sync")) {
        checks.push({ label: "INDmoney snapshot", run: async () => {
          if (indmoneyPayload) {
            if (!indmoneyPayload.raw_text.trim()) throw new Error("Paste the INDmoney holdings snapshot before running.");
            return;
          }
          const snapshot = await readIndmoneySnapshotSource(readLatestIndmoneySnapshot, savedSnapshot);
          assertIndmoneyHoldingsSnapshot(snapshot);
        } });
      }
      let errors: string[];
      try {
        errors = await collectPreflightErrors(checks);
        if (!errors.length && portfolio === "zerodha" && shouldRunCurrentStage("sync")) {
          await ensureZerodhaConnectedForSync(zerodhaPopup);
        }
        requireWorkflowOwner(runtimeOwner);
      } catch (error) {
        errors = [normalizeError(error)];
      }
      setPreflightPortfolio(null);
      if (errors.length || !isCurrentWorkflowOwner(runtimeOwner)) {
        zerodhaPopup?.close();
        isWorkflowExecutingRef.current = false;
        if (isCurrentWorkflowOwner(runtimeOwner)) setPreflightErrors(previous => ({ ...previous, [portfolio]: errors }));
        return;
      }
      const swingTargets = targets.swing ?? [];

      setRunningPortfolio(portfolio);
      resetPortfolio(portfolio);
      activeExecutionRefsRef.current = [];
      cancelRequestedRef.current = false;
      pauseRequestedRef.current = false;
      setWorkflowPaused(false);

      const startingStage =
        STAGE_ORDER.find((stage) => shouldRunCurrentStage(stage)) ?? "sync";
      currentStage = startingStage;
      updateStage(portfolio, startingStage, {
        state: "running",
        startedAt: new Date().toISOString(),
        runStatus:
          portfolio === "zerodha"
            ? "Starting Zerodha auto-rebalance"
            : "Starting INDmoney auto-rebalance",
        error: null,
      });

      let runMetadata: AutoRebalanceRunMetadata;
      let auditSession: AutoRebalanceAuditSession;
      try {
        runMetadata = await reserveAutoRebalanceRunMetadata(portfolio, recovery?.analysisOnly || analysisOnlyRuns[portfolio]);
        assertAutoRebalanceRunMetadata(runMetadata, portfolio === "zerodha" ? "india" : "indmoney_us");
        auditSession = getAuditSession(portfolio, runMetadata);
      } catch (error) {
        zerodhaPopup?.close();
        const failedAt = new Date().toISOString();
        const message = `Could not start ${
          portfolio === "zerodha" ? "Zerodha" : "INDmoney"
        } auto-rebalance: ${normalizeError(error)}`;
        updateStage(portfolio, startingStage, {
          state: "failed",
          endedAt: failedAt,
          runStatus: "start failed",
          error: message,
        });
        isWorkflowExecutingRef.current = false;
        setRunningPortfolio(null);
        window.alert(message);
        return;
      }

      setAuditStates((current) => ({
        ...current,
        [portfolio]: {
          key: auditSession.key,
          label: runMetadata.auto_rebalance_label,
          status: "pending",
          pending: 0,
          message: null,
        },
      }));
      setCompletionEmailWarnings((current) => ({ ...current, [portfolio]: undefined }));
      activeAutoRebalanceMetadataRef.current[portfolio] = runMetadata;
      setActiveAutoRebalanceMetadata((current) => ({
        ...current,
        [portfolio]: runMetadata,
      }));
      const finishedStages = new Set<WorkflowStageKey>();
      const stopIfRequested = () => {
        const wasCancelled = cancelRequestedRef.current;
        if (!pauseRequestedRef.current && !wasCancelled) return false;
        const stoppedStage = STAGE_ORDER.find((stage) => !finishedStages.has(stage) && (wasCancelled || shouldRunCurrentStage(stage)));
        if (!stoppedStage) {
          // The last selected stage has already finished. Only metadata for
          // skipped stages remains, so finish saving it without a false pause.
          pauseRequestedRef.current = false;
          setWorkflowPaused(false);
          return false;
        }
        const timestamp = new Date().toISOString();
        setStates((current) => ({
          ...current,
          [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
            const info = current[portfolio][stage];
            acc[stage] =
              info.state === "queued"
                ? {
                    ...info,
                    state: "idle",
                    endedAt: timestamp,
                    runStatus: "Paused before this stage",
                  }
                : info;
            return acc;
          }, {} as WorkflowState),
        }));
        updateStage(portfolio, stoppedStage, {
          state: wasCancelled ? "failed" : "idle",
          activeRunId: null,
          endedAt: timestamp,
          runStatus: wasCancelled ? "cancelled" : "Paused before this stage",
          error: wasCancelled ? "Auto-rebalance flow was killed by user." : null,
        });
        void recordAutoRebalanceStage(portfolio, stoppedStage, wasCancelled ? "cancelled" : "paused", {
          endedAt: timestamp,
          runStatus: wasCancelled ? "cancelled" : "paused",
          error: wasCancelled
            ? "Auto-rebalance flow was killed by user."
            : "Auto-rebalance was paused before this stage could be launched.",
        });
        pauseRequestedRef.current = false;
        return true;
      };
      const continueAfterStageFailure = (
        stage: WorkflowStageKey,
        error: unknown,
      ) => {
        if (cancelRequestedRef.current) throw error;
        const message = normalizeError(error);
        updateStage(portfolio, stage, {
          state: "failed",
          endedAt: new Date().toISOString(),
          activeRunId: null,
          error: message,
          runStatus: "failed",
        });
        void recordAutoRebalanceStage(
          portfolio,
          stage,
          "failed",
          {
            endedAt: new Date().toISOString(),
            error: message,
            runStatus: "failed",
          },
        );
        // Never run a later trading stage from stale output after a genuine
        // stage failure. Transient API failures are retried below/inside the
        // polling layer; a failure that reaches here is actionable and fully
        // recorded in the run history.
        throw new RecordedWorkflowStageFailure(message, error);
      };
      let generatedSwingRun: RunResponse | null = null;
      let workflowSnapshot: ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null = null;

      try {
        if (portfolio === "indmoneyUs" && savedSnapshot && !indmoneyPayload) {
          workflowSnapshot = await readIndmoneySnapshotSource(readLatestIndmoneySnapshot, savedSnapshot);
        }
        if (stopIfRequested()) {
          zerodhaPopup?.close();
          return;
        }
        currentStage = "sync";
        if (shouldRunCurrentStage("sync")) {
          markRunning(portfolio, "sync");
          if (portfolio === "zerodha") {
            const previousOverview = await apiService.zerodhaPortfolioOverview();
            await queueZerodhaPortfolioSyncWithAuthRetry(runtimeOwner);
            const overview = await waitForZerodhaPortfolioSync(
              previousOverview.latest?.captured_at,
              () => cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner),
              runtimeOwner,
            );
            workflowSnapshot = overview.latest;
            await markCompleted(portfolio, "sync", {
              completedAt: overview.latest?.captured_at,
              portfolioStockCount: overview.latest?.holdings_count ?? null,
              finalInputs: { snapshot_at: overview.latest?.captured_at },
              runStatus: "synced",
            });
          } else if (indmoneyPayload) {
            const snapshot =
              await apiService.indmoneyUsCreatePortfolioSnapshot(
                indmoneyPayload,
              );
            assertIndmoneyHoldingsSnapshot(snapshot);
            workflowSnapshot = snapshot;
            await markCompleted(portfolio, "sync", {
              completedAt: snapshot.captured_at,
              runStatus: snapshot.parse_status,
            });
          } else {
            const overview = { latest: workflowSnapshot ?? await retryWorkflowRead(
              () => readIndmoneySnapshotSource(readLatestIndmoneySnapshot),
              "IndMoney portfolio overview",
              () => cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner),
            ) };
            workflowSnapshot = overview.latest;
            await markCompleted(portfolio, "sync", {
              completedAt: overview.latest?.captured_at,
              runStatus: overview.latest?.parse_status ?? "last snapshot",
            });
          }
        } else {
          completeSkippedStage(
            portfolio,
            "sync",
            recovery ? `Using holdings from workflow #${recovery.sequence}` : "Using last synced portfolio",
          );
        }

        finishedStages.add("sync");
        const nextStageAfterSync = STAGE_ORDER.find(
          (stage) => stage !== "sync" && shouldRunCurrentStage(stage),
        );
        if (nextStageAfterSync) {
          // Show the upcoming stage before any ancillary refresh or provider
          // lookup. These requests can be slow, but the user should never be
          // left guessing whether the sequence will continue.
          currentStage = nextStageAfterSync;
          markRunning(portfolio, nextStageAfterSync);
        }
        if (shouldRunCurrentStage("sync")) {
          void onDashboardRefresh().catch((error) => {
            console.error("Failed to refresh dashboard after portfolio sync", error);
          });
        }

        if (stopIfRequested()) return;

        currentStage = "swing";
        if (shouldRunCurrentStage("swing")) {
          try {
          markRunning(portfolio, "swing", {
            totalLlms: swingTargets.length,
            completedLlms: 0,
          });
          const swingRun = await apiService.createRun(
            buildRunPayload({
              prompt: swingPrompts[portfolio],
              targets: swingTargets,
              sheetName: getSwingTradeDefaultExportSheetName(market),
              runMetadata,
              scanLabel: "Swing Scan",
            }),
          );
          const completedSwingRun = await waitForRunWithStageHandling(
            portfolio,
            "swing",
            swingRun.id,
          );
          generatedSwingRun = completedSwingRun;
          await markCompleted(portfolio, "swing", {
            ...summarizeRun(completedSwingRun),
            ...getRunProgress(completedSwingRun),
            lastRunId: completedSwingRun.id,
            ...swingRecommendationCounts(completedSwingRun),
          });
          } catch (error) {
            continueAfterStageFailure("swing", error);
          }
        } else {
          completeSkippedStage(
            portfolio,
            "swing",
            recovery ? `Using Swing from workflow #${recovery.sequence}` : "Using latest completed swing scan",
          );
        }

        finishedStages.add("swing");
        if (stopIfRequested()) return;

        const broker = runMetadata.auto_rebalance_portfolio;
        const sequence = runMetadata.auto_rebalance_sequence;
        const api = scorecardApi(apiService, broker);
        const selectedCards = cards.filter(shouldRunCurrentStage);
        if (generatedSwingRun || selectedCards.length || shouldRunCurrentStage("actionables")) {
          if (selectedCards.length) currentStage = selectedCards[0];
          else if (shouldRunCurrentStage("actionables")) currentStage = "actionables";
          let revision = recovery?.revision ?? sourceSelections[portfolio];
          const swingSelection = selectedInputs[portfolio].rebalance;
          const explicitJobs = [...swingSelection].flatMap(key => {
            const match = /^run:[1-9]\d*:job:([1-9]\d*)$/.exec(key);
            return match ? [Number(match[1])] : [];
          });
          // Selecting a saved Stage 2 publication never re-reads holdings or Swing.
          if (generatedSwingRun || (!revision && explicitJobs.length)) {
            const snapshot = workflowSnapshot ?? (portfolio === "zerodha" ? await apiService.zerodhaPortfolioOverview() : await apiService.indmoneyUsPortfolioOverview()).latest;
            if (!snapshot) throw new Error("Stage 2 requires a portfolio snapshot.");
            const selectedIds = [...new Set([...explicitJobs,...(generatedSwingRun?.run_jobs ?? []).filter(link => isUsableStageJob(link.job)).map(link=>link.job_id)])];
            revision = (await api.publish({sequence, request_key:"workflow-"+sequence, captured_at:snapshot.captured_at,
              ...("id" in snapshot ? {snapshot_id:snapshot.id} : {}), swing_job_ids:selectedIds})).id;
            setSourceSelections(prev=>({...prev,[portfolio]:revision}));
          }
          if (!revision) throw new Error("Select a saved Stage 2 revision in Merge contenders, or run Swing to publish a new one.");
          if (stopIfRequested()) return;
          const source = await api.read(revision);
          if (stopIfRequested()) return;
          updateStage(portfolio, "swing", {sourceRevision: source.id, sourceListingCount: source.manifest.stocks.length});
          const chosen: Partial<Record<CardKey,number>> = {};
          for (const item of source.attempts) if (!chosen[item.card]) chosen[item.card]=item.id;
          const runCard = async (card:CardKey) => {
            if (!shouldRunCurrentStage(card)) { completeSkippedStage(portfolio,card,"Using selected Stage 2 revision"); finishedStages.add(card); return; }
            markRunning(portfolio,card,{totalLlms:targets[card]?.length});
            // Never substitute a previous output when the explicitly requested rerun fails.
            delete chosen[card];
            try {
              if (cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner)) return;
              if (cardModelErrors[card]) throw new Error(cardModelErrors[card]);
              const queued=await api.start(source.id,card,{sequence, request_key:"workflow-"+sequence,targets:targets[card] ?? []});
              const run=queued.run_id==null?null:await waitForRunWithStageHandling(portfolio,card,queued.run_id,queued.scoring_version===3 || card==="pairwise");
              const result=await api.result(queued.id);
              if (result.status === "processing") throw new Error("Scorecard jobs are still settling. Open its saved output to refresh.");
              chosen[card]=queued.id;
              await markCompleted(portfolio,card,{...(run?{...summarizeRun(run),...getRunProgress(run),lastRunId:run.id}:{totalLlms:0,completedLlms:0}),
                ...(result.status !== "completed" ? {partialNotice:`Scorecard ${result.status}. ${result.scored ?? 0} of ${source.manifest.stocks.length} listings have verified scores.`} : {}),
                ...(card==="threats" && result.threat_counts ? {threatCounts:{...result.threat_counts,status:result.status}} : {}),
                recommendedStocks:result.scored ?? 0,evidenceCoverage:result.pair_counts ? `${result.pair_counts.judged}/${result.pair_counts.expected} pairs judged` : String(result.scored ?? 0)+"/"+source.manifest.stocks.length+" scored",
                ...(result.pair_counts ? {published:{output_id:queued.id,run_id:queued.run_id,covered:result.pair_counts.judged,expected:result.pair_counts.expected,pair_counts:result.pair_counts,used_output_id:null,final_id:null}} : {}),
                ...(result.rebalance_audit?{published:{output_id:result.id,run_id:run?.id??0,covered:result.rebalance_audit.coverage.assessed,
                  expected:result.rows.length,used_output_id:null,final_id:null,counts:result.rebalance_audit.coverage,actions:result.rebalance_audit.actions}}:{}),
                finalInputs:{stage2_revision:source.id,attempt:queued.id}});
            } catch (error) {
              if (cancelRequestedRef.current) throw error;
              updateStage(portfolio,card,{state:"failed",error:normalizeError(error),activeRunId:null});
              await recordAutoRebalanceStage(portfolio,card,"failed",{error:normalizeError(error),finalInputs:{stage2_revision:source.id}});
            } finally { finishedStages.add(card); }
          };
          await Promise.allSettled(cards.map(runCard));
          if (stopIfRequested()) return;
          currentStage="actionables";
          if (shouldRunCurrentStage("actionables")) {
            markRunning(portfolio,"actionables");
            const previous = source.finals[0] ? await api.final(source.finals[0].id) : null;
            const config = cardPolicies[portfolio] ?? previous?.policy ?? await api.savedPolicy() ?? migratedPolicy(scoreMatrixFormulaConfig);
            const final=await api.finalize(source.id,sequence,chosen,config);
            const frozenCoverage=portfolio==="zerodha"?await api.coverage(sequence).catch(()=>null):null;
            const finalSummary=frozenCoverage?.final_summary?.id===final.id?frozenCoverage.final_summary:undefined;
            const saved=await markCompleted(portfolio,"actionables",{runStatus: final.rows.every(row => row.status === "Complete") ? "saved calculation" : "partial",
              partialNotice: final.rows.some(row => row.status !== "Complete") ? `Final saved with ${final.rows.filter(row => row.status === "Complete").length}/${final.rows.length} complete listings.` : undefined,
              recommendedStocks:final.rows.filter(row=>row.status==="Complete" && row.action!==null && row.action!=="Hold" && (row.suggested_units??0)>0).length,
              ...(finalSummary?{finalSummary,rebalanceInputs:finalSummary.rebalance_inputs,recommendedStocks:finalSummary.eligible}:{}),
              frozenFinal:{schema:final.schema,final_id:final.id,workflow_sequence:sequence}});
            if (saved?.saved===false && /Final calculation could not be verified/i.test(saved.error)) throw new Error(saved.error);
            window.dispatchEvent(new CustomEvent("final-actionables-refresh",{detail:{market,completedAt:new Date().toISOString()}}));
          } else completeSkippedStage(portfolio,"actionables","Stage 4 not selected");
        } else {
          for (const stage of [...cards,"actionables"] as const) completeSkippedStage(portfolio,stage,"Stage not selected");
        }
        // Computation is complete, but history and completion notifications
        // must wait for every metadata write and matching durable server truth.
        const historySaved = await auditSession.verifyCompletion(STAGE_ORDER);
        if (!historySaved || cancelRequestedRef.current) return;
        if (shouldRunCurrentStage("actionables") && !recovery?.analysisOnly && !analysisOnlyRuns[portfolio]) {
          try {
            await apiService.queueAutoRebalanceCompletionEmail({
              portfolio: runMetadata.auto_rebalance_portfolio,
              sequence: runMetadata.auto_rebalance_sequence,
              label: runMetadata.auto_rebalance_label,
              completed_at: new Date().toISOString(),
              stages_completed: STAGE_ORDER.filter(shouldRunCurrentStage).map(
                getStageTileLabel,
              ),
            });
          } catch (emailError) {
            setCompletionEmailWarnings((current) => ({
              ...current,
              [portfolio]: `Completion email was not confirmed: ${normalizeError(emailError)}`,
            }));
            console.error("Failed to queue auto-rebalance success email", emailError);
          }
        }
        if (pauseRequestedRef.current) pauseRequestedRef.current = false;
        setWorkflowPaused(false);
        window.setTimeout(() => {
          if (isWorkflowExecutingRef.current || auditSessionsRef.current[portfolio]?.key !== auditSession.key) return;
          setStates((current) => {
            return {
              ...current,
              [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
                const info = current[portfolio][stage];
                acc[stage] =
                  info.state === "completed"
                    ? { ...info, state: "idle" }
                    : info;
                return acc;
              }, {} as WorkflowState),
            };
          });
          setSpecificMode((current) => ({ ...current, [portfolio]: false }));
          setSelectedStages((current) => ({
            ...current,
            [portfolio]: new Set(),
          }));
          setSelectedInputs((current) => ({
            ...current,
            [portfolio]: {
              threats: new Set(["threats:next"]),
              swing: new Set(["swing:next"]),
              rebalance: new Set(["rebalance:next"]),
              technical: new Set(["technical:next"]),
              actionables: new Set(["actionables:next"]),
            },
          }));
        }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
      } catch (error) {
        const wasCancelled = cancelRequestedRef.current;
        const message = wasCancelled
          ? "Auto-rebalance flow was killed by user."
          : normalizeError(error);
        const failedAt = new Date().toISOString();
        // Stage-level catches already persist actionable failures. Do not
        // write the same failure a second time from this workflow boundary.
        if (!(error instanceof RecordedWorkflowStageFailure)) {
          updateStage(portfolio, currentStage, {
            state: "failed",
            endedAt: failedAt,
            error: message,
            runStatus: wasCancelled ? "cancelled" : "failed",
          });
          void recordAutoRebalanceStage(
            portfolio,
            currentStage,
            wasCancelled ? "cancelled" : "failed",
            {
              endedAt: failedAt,
              error: message,
              runStatus: wasCancelled ? "cancelled" : "failed",
            },
          );
        }
        window.setTimeout(() => {
          if (isWorkflowExecutingRef.current || auditSessionsRef.current[portfolio]?.key !== auditSession.key) return;
          setStates((current) => ({
            ...current,
            [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
              const info = current[portfolio][stage];
              acc[stage] =
                info.state === "failed" ? { ...info, state: "idle" } : info;
              return acc;
            }, {} as WorkflowState),
          }));
          setSpecificMode((current) => ({ ...current, [portfolio]: false }));
          setSelectedStages((current) => ({
            ...current,
            [portfolio]: new Set(),
          }));
        }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
      } finally {
        // Pauses, cancellations and genuine model failures also retain their
        // pending audit writes until bounded persistence attempts finish.
        await auditSession.drain();
        setAnalysisOnlyRuns(current => ({ ...current, [portfolio]: false }));
        const wasCancelled = cancelRequestedRef.current;
        activeExecutionRefsRef.current = [];
        delete activeAutoRebalanceMetadataRef.current[portfolio];
        setActiveAutoRebalanceMetadata((current) => {
          const next = { ...current };
          delete next[portfolio];
          return next;
        });
        isWorkflowExecutingRef.current = false;
        setRunningPortfolio(null);
        if (wasCancelled) {
          const timestamp = new Date().toISOString();
          setStates((current) => ({
            ...current,
            [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
              const info = current[portfolio][stage];
              acc[stage] = ["running", "queued"].includes(info.state)
                ? {
                    ...info,
                    state: "failed",
                    endedAt: timestamp,
                    runStatus: "killed",
                    error: "Auto-rebalance flow was killed by user.",
                  }
                : info;
              return acc;
            }, {} as WorkflowState),
          }));
          window.setTimeout(() => {
            if (isWorkflowExecutingRef.current || auditSessionsRef.current[portfolio]?.key !== auditSession.key) return;
            setStates((current) => ({
              ...current,
              [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
                const info = current[portfolio][stage];
                acc[stage] =
                  info.state === "failed" ? { ...info, state: "idle" } : info;
                return acc;
              }, {} as WorkflowState),
            }));
            setSpecificMode((current) => ({ ...current, [portfolio]: false }));
            setSelectedStages((current) => ({
              ...current,
              [portfolio]: new Set(),
            }));
          }, WORKFLOW_COMPLETION_RESET_DELAY_MS);
        }
      }
    },
    [runtimeOwner, apiService, loadModelPreferences, scoreMatrixFormulaConfig, swingPrompts,
      analysisOnlyRuns,
      buildZerodhaPopupFeatures,
      completeSkippedStage,
      getAuditSession,
      markCompleted,
      markRunning,
      ensureZerodhaConnectedForSync,
      onDashboardRefresh,
      recordAutoRebalanceStage,
      resetPortfolio,
      selectedInputs,
      selectedStages, sourceSelections, cardPolicies,
      specificMode,
      updateStage,
      usdInrRate,
      waitForRunWithStageHandling,
    ],
  );

  const syncPortfolioNow = useCallback(
    async (
      portfolio: WorkflowPortfolio,
      payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
      savedSnapshot?: IndMoneyUsPortfolioSnapshotDetail,
    ) => {
      if (!isCurrentWorkflowOwner(runtimeOwner)) return;
      const zerodhaPopup =
        portfolio === "zerodha"
          ? window.open("about:blank", "zerodha-workflow-connect", buildZerodhaPopupFeatures())
          : null;
      try {
        markRunning(portfolio, "sync");
        if (portfolio === "zerodha") {
          await ensureZerodhaConnectedForSync(zerodhaPopup);
          const previousOverview = await apiService.zerodhaPortfolioOverview();
          await queueZerodhaPortfolioSyncWithAuthRetry(runtimeOwner);
          const overview = await waitForZerodhaPortfolioSync(
            previousOverview.latest?.captured_at,
            () => cancelRequestedRef.current || !isCurrentWorkflowOwner(runtimeOwner),
            runtimeOwner,
          );
          markCompleted(portfolio, "sync", {
            completedAt: overview.latest?.captured_at,
            portfolioStockCount: overview.latest?.holdings_count ?? null,
            runStatus: "synced",
          });
        } else if (payload) {
          const snapshot =
            await apiService.indmoneyUsCreatePortfolioSnapshot(payload);
          assertIndmoneyHoldingsSnapshot(snapshot);
          markCompleted(portfolio, "sync", {
            completedAt: snapshot.captured_at,
            runStatus: snapshot.parse_status,
          });
        } else {
          const overview = { latest: await readIndmoneySnapshotSource(readLatestIndmoneySnapshot, savedSnapshot) };
          markCompleted(portfolio, "sync", {
            completedAt: overview.latest?.captured_at,
            runStatus: overview.latest?.parse_status ?? "last snapshot",
          });
        }
        await onDashboardRefresh();
      } catch (error) {
        updateStage(portfolio, "sync", {
          state: "failed",
          endedAt: new Date().toISOString(),
          error: normalizeError(error),
          runStatus: "failed",
        });
      }
    },
    [runtimeOwner, apiService,
      buildZerodhaPopupFeatures,
      ensureZerodhaConnectedForSync,
      markCompleted,
      markRunning,
      onDashboardRefresh,
      updateStage,
    ],
  );

  useEffect(() => {
    const handleZerodhaDashboardSync = () => {
      if (runningPortfolio) return;
      void syncPortfolioNow("zerodha");
    };
    const handleIndmoneyDashboardSync = () => {
      if (runningPortfolio) return;
      setIndMoneySyncOnly(true);
      setDialogError(null);
      setDialogOpen(true);
    };
    window.addEventListener(
      ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
      handleZerodhaDashboardSync,
    );
    window.addEventListener(
      INDMONEY_DASHBOARD_SYNC_NOW_EVENT,
      handleIndmoneyDashboardSync,
    );
    return () => {
      window.removeEventListener(
        ZERODHA_DASHBOARD_SYNC_NOW_EVENT,
        handleZerodhaDashboardSync,
      );
      window.removeEventListener(
        INDMONEY_DASHBOARD_SYNC_NOW_EVENT,
        handleIndmoneyDashboardSync,
      );
    };
  }, [runningPortfolio, syncPortfolioNow]);

  const handleIndMoneyContinue = useCallback(
    (
      mode: IndMoneySyncMode,
      payload?: IndMoneyUsPortfolioSnapshotCreateRequest,
      savedSnapshot?: IndMoneyUsPortfolioSnapshotDetail,
    ) => {
      setDialogError(null);
      setDialogOpen(false);
      if (indMoneySyncOnly) {
        setIndMoneySyncOnly(false);
        void syncPortfolioNow(
          "indmoneyUs",
          mode === "paste" ? payload : undefined,
          mode === "reuse" ? savedSnapshot : undefined,
        );
        return;
      }
      void runWorkflow("indmoneyUs", mode === "paste" ? payload : undefined, mode === "reuse" ? savedSnapshot : undefined);
    },
    [indMoneySyncOnly, runWorkflow, syncPortfolioNow],
  );

  const getBrokerStatus = useCallback(() => apiService.zerodhaStatus(), [apiService]);
  const connectBroker = useCallback(() => {
    const popup = window.open("about:blank", "zerodha-workflow-connect", buildZerodhaPopupFeatures());
    return ensureZerodhaConnectedForSync(popup);
  }, [buildZerodhaPopupFeatures, ensureZerodhaConnectedForSync]);

  const lastRunByPortfolio = useMemo(() => {
    const result: Record<WorkflowPortfolio, string | null> = {
      zerodha: null,
      indmoneyUs: null,
    };
    (Object.keys(states) as WorkflowPortfolio[]).forEach((portfolio) => {
      const latest = STAGE_ORDER.map(
        (stage) => states[portfolio][stage].completedAt,
      )
        .filter(Boolean)
        .sort((a, b) => parseTimestampMs(b) - parseTimestampMs(a))[0];
      result[portfolio] = latest ?? null;
    });
    return result;
  }, [states]);

  const sections = useMemo(
    () => [
      {
        portfolio: "zerodha" as const,
        title: "Indian Stocks Auto-Rebalance",
        buttonLabel: "Run",
      },
      {
        portfolio: "indmoneyUs" as const,
        title: "Run Indmoney Auto-Rebalance",
        buttonLabel: "Run",
      },
    ],
    [],
  );

  const renderSectionCard = (section: (typeof sections)[number]) => {
    const audit = auditStates[section.portfolio];
    const savedWorkflowSequences = STAGE_ORDER.map(
      (stage) => states[section.portfolio][stage].workflowSequence,
    ).filter((sequence): sequence is number =>
      typeof sequence === "number" && Number.isSafeInteger(sequence) && sequence > 0,
    );
    const displayedWorkflowSequence =
      (runningPortfolio === section.portfolio ? activeAutoRebalanceMetadata[section.portfolio]?.auto_rebalance_sequence : null) ??
      (savedWorkflowSequences.length ? Math.max(...savedWorkflowSequences) : null);
    const recoverable = section.portfolio === "zerodha" && latestIndiaWorkflow?.sequence === displayedWorkflowSequence &&
      ["interrupted", "failed"].includes(latestIndiaWorkflow.status) &&
      latestIndiaWorkflow.stages.some(row => row.stage === "sync" && row.status === "completed") &&
      latestIndiaWorkflow.stages.some(row => row.stage === "swing" && (["completed", "partial"].includes(row.status) ||
        (row.provider_count > 0 && row.completed_provider_count === row.provider_count))) &&
      !latestIndiaWorkflow.stages.some(row => row.stage !== "sync" && row.stage !== "swing" &&
        (row.run_id || row.job_id || row.provider_count || ["completed", "partial"].includes(row.status)));
    const prepared = preparedSwing?.sequence === displayedWorkflowSequence ? preparedSwing : null;
    const openCard = (card: CardKey, tab?: ScorecardTab) => {
      const sequence = states[section.portfolio][card].workflowSequence ?? displayedWorkflowSequence;
      if (tab && sequence) setCardEvidence({market:section.portfolio, card, sequence, tab});
      else router.push(scorecardHref(section.portfolio, card, sequence, tab));
    };
    const finalStage = states[section.portfolio].actionables;
    const basketRevision = section.portfolio === "zerodha" ? scoreRevision : usRevision;
    const preparedOrders = section.portfolio === "zerodha" ? zerodhaBasketOrders : indmoneyBasketOrders;
    const basketReady = displayedWorkflowSequence !== null && finalStage.state === "completed" && !finalStage.error &&
      finalStage.frozenFinal?.workflow_sequence === displayedWorkflowSequence &&
      ((finalStage.frozenFinal.schema === "independent-scorecards-v1" && (finalStage.recommendedStocks ?? 0) > 0) ||
       Number(finalStage.frozenFinal.basket_order_count) > 0 ||
       (basketRevision?.sequence === displayedWorkflowSequence && preparedOrders.length > 0));
    const emailWarning = completionEmailWarnings[section.portfolio];
    const isSectionRunning = runningPortfolio === section.portfolio;
    const hasActiveStage = hasActiveWorkflowStage(section.portfolio, states);
    const showPauseKillControls = isSectionRunning || hasActiveStage;
    const queuedStages = getQueuedStages(
      section.portfolio,
      states,
      runningPortfolio,
      specificMode,
      selectedStages,
    );
    const showQuotaLlmSwitchWarning = shouldShowQuotaLlmSwitchWarning(
      states[section.portfolio],
    );

    const runButton = (
      <Button
        type="button"
        disabled={isBusy}
        onClick={() => {
          if (isBusy) return;
          if (section.portfolio === "indmoneyUs") {
            setDialogError(null);
            setIndMoneySyncOnly(false);
            setDialogOpen(true);
            return;
          }
          void runWorkflow("zerodha");
        }}
        className="h-11 w-full justify-center gap-3 rounded-full bg-slate-950 px-7 text-xs font-extrabold uppercase tracking-[0.18em] text-white shadow-lg shadow-slate-950/15 hover:bg-slate-900 disabled:opacity-50 xl:w-auto"
      >
        <Play className="size-4" />
        {preflightPortfolio === section.portfolio ? "Checking…" : section.buttonLabel.toUpperCase()}
      </Button>
    );

    return (
      <div
        key={section.portfolio}
        className={stageLedger ? "min-w-0 rounded-2xl border border-indigo-200 bg-indigo-50/50 p-4" : "rounded-[28px] border border-slate-200 bg-white p-6 shadow-md shadow-slate-200/70"}
      >
        <div className="flex flex-col gap-4 xl:flex-row xl:items-start xl:justify-between">
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h2 className="text-xl font-medium text-slate-950">
                {section.title}
              </h2>
              <Link
                href={URLs.routes.console.autoRebalanceRuns(section.portfolio)}
                className="inline-flex size-8 shrink-0 items-center justify-center rounded-full border border-slate-200 bg-white text-slate-600 shadow-sm transition hover:border-indigo-300 hover:bg-indigo-50 hover:text-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500"
                aria-label={`Open ${section.title} run history`}
                title="Open auto-rebalance run history"
              >
                <History className="size-4" />
              </Link>
            </div>
            <p className="mt-2 text-base leading-6 text-slate-500">
              Last/Current run{displayedWorkflowSequence !== null ? ` #${displayedWorkflowSequence}` : ""}:{" "}
              {formatCompactStageTime(lastRunByPortfolio[section.portfolio])}
            </p>
            {recoverable && latestIndiaWorkflow && !isBusy && <div className="mt-3 space-y-1 text-sm">
              {prepared ? <>
                <p role="status">Stage 2 revision #{prepared.id} · {prepared.listings} merged listings · holdings snapshot #{prepared.snapshot_id} · Swing jobs {prepared.swing_job_ids.map(id => "#"+id).join(", ")}</p>
                <Button type="button" onClick={() => void runWorkflow("zerodha", undefined, undefined, {
                  revision: prepared.id, sequence: prepared.sequence, analysisOnly: latestIndiaWorkflow.side_effect_policy?.mode === "analysis_only",
                })}>Run scorecards from these inputs</Button>
              </> : <Button type="button" disabled={preparingSwing} onClick={async () => {
                setPreparingSwing(true); setRecoveryIssue("");
                try {
                  const saved = await scorecardApi(apiService, "india").prepareSwingSource(latestIndiaWorkflow.sequence);
                  setPreparedSwing(saved);
                  setSourceSelections(prev => ({...prev, zerodha: saved.id}));
                  await loadLatestIdleStageInfo();
                } catch (error) { setRecoveryIssue(normalizeError(error)); }
                finally { setPreparingSwing(false); }
              }}>{preparingSwing ? "Preparing…" : "Prepare saved Swing inputs"}</Button>}
              {!prepared && <p>Uses this workflow’s saved holdings and Swing results. No model charge.</p>}
              {recoveryIssue && <p role="alert" className="text-red-700">{recoveryIssue}</p>}
            </div>}
            {stageLedger && !surface ? <WorkflowRunBoundary historyHref={URLs.routes.console.autoRebalanceRuns(section.portfolio)} /> : null}

          </div>
          <div aria-label={stageLedger ? "Run controls" : undefined} className="flex w-full min-w-0 flex-col items-start gap-3 xl:w-auto xl:max-w-full xl:items-end">
            <div
              className={
                showPauseKillControls
                  ? "grid w-full min-w-0 grid-cols-2 gap-2 xl:w-60"
                  : "flex w-full min-w-0 flex-col gap-2 sm:flex-row sm:flex-wrap sm:justify-end xl:w-auto"
              }
            >
              {showPauseKillControls ? (
                <>
                  <Button
                    type="button"
                    onClick={() => {
                      pauseRequestedRef.current = !pauseRequestedRef.current;
                      setWorkflowPaused(pauseRequestedRef.current);
                    }}
                    className={cn(
                      "h-auto w-full shrink-0 justify-center whitespace-normal rounded-full px-6 py-2 text-center leading-5 text-white shadow-sm transition",
                      workflowPaused
                        ? "bg-emerald-600 hover:bg-emerald-700"
                        : "bg-orange-500 hover:bg-orange-600",
                    )}
                  >
                    {workflowPaused ? (
                      <Play className="mr-2 size-4 fill-current" />
                    ) : (
                      <Pause className="mr-2 size-4 fill-current" />
                    )}
                    {workflowPaused ? "Resume" : "Pause"}
                  </Button>
                  <Button
                    type="button"
                    onClick={() => {
                      const portfolio = section.portfolio;
                      const timestamp = new Date().toISOString();

                      cancelRequestedRef.current = true;
                      pauseRequestedRef.current = false;
                      setWorkflowPaused(false);
                      if (runningPortfolio === portfolio) {
                        setRunningPortfolio(null);
                      }
                      setStates((current) => ({
                        ...current,
                        [portfolio]: STAGE_ORDER.reduce((acc, stage) => {
                          const info = current[portfolio][stage];
                          acc[stage] = ["running", "queued"].includes(info.state)
                            ? {
                                ...info,
                                state: "failed",
                                endedAt: timestamp,
                                runStatus: "killed",
                                error: "Auto-rebalance flow was killed by user.",
                              }
                            : info;
                          return acc;
                        }, {} as WorkflowState),
                      }));
                      void Promise.allSettled(
                        STAGE_ORDER.filter((stage) =>
                          ["running", "queued"].includes(
                            states[portfolio][stage].state,
                          ),
                        ).map((stage) =>
                          recordAutoRebalanceStage(portfolio, stage, "cancelled", {
                            endedAt: timestamp,
                            runStatus: "cancelled",
                            error: "Auto-rebalance flow was killed by user.",
                          }),
                        ),
                      );
                      void Promise.allSettled(
                        activeExecutionRefsRef.current.map((execution) =>
                          execution.kind === "job"
                            ? apiService.cancelJob(execution.id)
                            : apiService.cancelRun(execution.id),
                        ),
                      );
                    }}
                    className="h-auto w-full shrink-0 justify-center whitespace-normal rounded-full bg-red-600 px-6 py-2 text-center leading-5 text-white hover:bg-red-700"
                  >
                    <X className="mr-2 size-4" />
                    Kill
                  </Button>
                </>
              ) : section.portfolio === "zerodha" ? (
                <ZerodhaRunGate getStatus={getBrokerStatus} connect={connectBroker} disabled={isBusy}>{runButton}</ZerodhaRunGate>
              ) : runButton}
            </div>
            {!surface && <AnalysisOnlyRunControl checked={analysisOnlyRuns[section.portfolio]} disabled={isBusy}
              onChange={checked => setAnalysisOnlyRuns(current => ({ ...current, [section.portfolio]: checked }))} />}
            <button
              type="button"
              disabled={isBusy}
              onClick={() => toggleSpecificMode(section.portfolio)}
              className={
                specificMode[section.portfolio]
                  ? "rounded-full bg-blue-950 px-3 py-1 text-xs font-extrabold text-white shadow-sm hover:bg-blue-900 disabled:opacity-50"
                  : "text-xs font-semibold text-slate-700 underline-offset-4 hover:underline disabled:opacity-50"
              }
            >
              Run specific Stages
            </button>
          </div>
        </div>

        {preflightPortfolio === section.portfolio && <p role="status" className="mt-4 text-sm text-blue-800">Checking configuration, stage dependencies and saved inputs before starting…</p>}
        {Boolean(preflightErrors[section.portfolio]?.length) && (
          <div role="alert" className="my-4 rounded-xl border border-red-300 bg-red-50 p-4 text-sm text-red-950">
            <h3 className="font-semibold">Pre-run checks found issues</h3>
            <p className="mt-1">Resolve these issues, then press Run to check again.</p>
            <ul className="mt-2 list-disc space-y-2 pl-5">
              {preflightErrors[section.portfolio]?.map((error, index) => <li key={index} className="whitespace-pre-line">{error}</li>)}
            </ul>
          </div>
        )}

        <WorkflowStageLedger basketReady={basketReady} active={runningPortfolio === section.portfolio} market={section.portfolio} board enabled={stageLedger} view={ledgerView} historyHref={URLs.routes.console.autoRebalanceRuns(section.portfolio)} onStockFlowClick={() => setStockFlowPortfolio(section.portfolio)} onManageSource={() => setCardReview({portfolio:section.portfolio,stage:"source"})} onManageCard={stage => setCardReview({portfolio:section.portfolio,stage})}>
          {STAGE_ORDER.map((stage) => (
            <WorkflowStageTile
              key={stage}
              stage={stage}
              info={
                queuedStages.has(stage)
                  ? { ...states[section.portfolio][stage], state: "queued" }
                  : states[section.portfolio][stage]
              }
              now={now}
              selectable={specificMode[section.portfolio] && !isBusy}
              selected={selectedStages[section.portfolio].has(stage)}
              onClick={
                specificMode[section.portfolio] && !isBusy
                  ? () => toggleStageSelection(section.portfolio, stage)
                  : () =>
                      isCard(stage) ? openCard(stage) : navigateForStage(
                        section.portfolio,
                        stage,
                        states[section.portfolio][stage],
                      )
              }
              onInfoClick={stage !== "sync" && stage !== "actionables"
                  ? () => void showStageLlmInfo(section.portfolio, stage)
                  : undefined
              }
              onInputClick={stage === "pairwise" ? () => openCard(stage,"inputs") : isCard(stage) ? () => openInputSelection(section.portfolio,stage) : stage==="actionables" ? ()=>setCardReview({portfolio:section.portfolio,stage}) :
                stage==="swing" ? ()=>openInputSelection(section.portfolio,stage):undefined}
              onPromptClick={isCard(stage) ? () => openCard(stage,"prompts") :
                stage==="swing" ? ()=>showStagePrompt(section.portfolio,stage):undefined}
              onOutputClick={() => {
                if (isCard(stage)) { openCard(stage, "output"); return; }
                if(stage==="actionables"){setCardReview({portfolio:section.portfolio,stage});return;}
                setActionablesCalculationsPortfolio(null);
                void showStageOutput(section.portfolio,stage,states[section.portfolio][stage].lastRunId ?? undefined);
              }}
              onSyncNowClick={
                stage === "sync"
                  ? () => {
                      if (section.portfolio === "indmoneyUs") {
                        setDialogError(null);
                        setIndMoneySyncOnly(true);
                        setDialogOpen(true);
                        return;
                      }
                      void syncPortfolioNow("zerodha");
                    }
                  : undefined
              }
              onPlaceOrderClick={
                stage === "actionables" && !(section.portfolio === "zerodha" && finalStage.runStatus === "not started")
                  ? section.portfolio === "zerodha"
                    ? () => void openZerodhaBasketPreview(displayedWorkflowSequence ? {sequence:displayedWorkflowSequence, formula:scoreMatrixFormulaConfig} : undefined)
                    : () => void openIndmoneyBasketPreview(displayedWorkflowSequence ? {sequence:displayedWorkflowSequence, formula:scoreMatrixFormulaConfig} : undefined)
                  : undefined
              }
              placeOrderLabel={section.portfolio === "zerodha" ? "View Final Basket" : "Place Order"}
              onCalculationsClick={
                stage === "actionables"
                  ? () => {
                      if (finalStage.frozenFinal?.schema === "independent-scorecards-v1" || !finalStage.frozenFinal) {
                        setCardReview({portfolio:section.portfolio,stage:"actionables"});
                        return;
                      }
                      window.location.hash = "final-actionables";
                      setActionablesCalculationsPortfolio(section.portfolio);
                      void showStageOutput(section.portfolio, "actionables");
                    }
                  : undefined
              }
            />
          ))}
        </WorkflowStageLedger>
        {showQuotaLlmSwitchWarning ? (
          <div className="mt-6 rounded-2xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm leading-6 text-amber-950 shadow-sm">
            <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
              <div className="flex min-w-0 gap-3">
                <AlertCircle className="mt-0.5 size-5 shrink-0 text-amber-600" />
                <div>
                  <p className="font-extrabold">Threat Scan quota exceeded.</p>
                  <p className="mt-1">
                    Choose another model for Threats and rerun it against the same Stage 2 revision.
                  </p>
                </div>
              </div>
              <div className="flex shrink-0 flex-col gap-2 sm:flex-row">
                <Button
                  type="button"
                  variant="outline"
                  className="h-9 rounded-full border-amber-300 bg-white px-4 text-xs font-extrabold text-amber-950 hover:bg-amber-100"
                  onClick={() =>
                    void showStageLlmInfo(section.portfolio,"threats")
                  }
                >
                  Switch Threats LLMs
                </Button>
              </div>
            </div>
          </div>
        ) : null}
        {audit?.status === "pending" ? (
          <p role="status" className="mt-2 flex items-center gap-2 text-sm text-amber-800">
            <Loader2 className="size-4 shrink-0 animate-spin" />
            {audit.label}: run history confirmation pending. Completed outputs remain available.
          </p>
        ) : null}
        {emailWarning ? <p role="alert" className="mt-2 text-sm text-amber-800">{emailWarning}</p> : null}
        <div className="mt-5 flex items-center justify-between gap-3 rounded-2xl border border-emerald-100 bg-emerald-50 px-5 py-4 text-base font-normal text-emerald-950">
          <div className="flex min-w-0 flex-wrap items-center gap-3">
            <RebalanceStockFlowTrigger
              portfolio={section.portfolio}
              onClick={() => setStockFlowPortfolio(section.portfolio)}
            />
            <div>
              {getWorkflowRunDuration(states[section.portfolio], now)
                ? `Cumulative LLM time: ${getWorkflowRunDuration(states[section.portfolio], now)} · `
                : ""}
              <span title={costRateLabel}>Total cost incurred in last Auto-rebalance:{" "}
              {formatRebalanceCost(
                !isSectionRunning && savedRunCosts[section.portfolio]?.sequence === displayedWorkflowSequence
                  ? savedRunCosts[section.portfolio]!
                  : getWorkflowRunCost(states[section.portfolio], displayedWorkflowSequence, usdInrRate), usdInrRate
              )}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => void openAutoRebalanceCostHistory(section.portfolio)}
            className="inline-flex size-10 shrink-0 items-center justify-center rounded-full border border-emerald-200 bg-white text-emerald-700 shadow-sm transition hover:border-emerald-300 hover:bg-emerald-100 focus:outline-none focus:ring-2 focus:ring-emerald-500"
            aria-label={`Open ${section.title} cost history`}
            title="Open previous scan cost history"
          >
            <History className="size-5" />
          </button>
        </div>
      </div>
    );
  };

  useEffect(() => {
    setLedgerView("ledger");
    setCardEvidence(null);
    setCardReview(null);
    setDialogOpen(false);
    setIndMoneySyncOnly(false);
    setStockFlowPortfolio(null);
    setCostHistoryPortfolio(null);
    setLlmDialogStage(null);
    setPromptDialog(null);
    closeOutputDialog();
    setInputDialog(null);
    setZerodhaBasketOpen(false);
    setIndmoneyBasketOpen(false);
    outputRequestRef.current += 1;
    llmDialogRequestRef.current += 1;
  }, [surface?.target, surface?.market, surface?.scorecards?.sequence, surface?.scorecards?.card, closeOutputDialog]);

  const zerodhaSection = sections[0];
  const indmoneySection = sections[1];

  const content = (
    <AutomatedRebalanceReliabilityBridge>
      {cardReview && <ScorecardReview key={cardReview.portfolio+cardReview.stage} portfolio={cardReview.portfolio} stage={cardReview.stage}
        initialAttempt={cardReview.attempt} revisionId={cardReview.revision ?? sourceSelections[cardReview.portfolio]} previousFormula={scoreMatrixFormulaConfig} fallbackPolicy={migratedPolicy(scoreMatrixFormulaConfig)}
        onRevision={id=>setSourceSelections(previous=>({...previous,[cardReview.portfolio]:id}))}
        onPolicy={policy=>setCardPolicies(previous=>({...previous,[cardReview.portfolio]:policy}))}
        onClose={()=>setCardReview(null)} />}
      {cardEvidence && <ScorecardEvidenceDialog key={cardEvidence.market+cardEvidence.card+cardEvidence.sequence}
        {...cardEvidence} client={apiService} onClose={() => setCardEvidence(null)}
        renderOutput={(run, card) => <RunOutputDetails run={run} pairwise={card === "pairwise"} />}
        onInputs={() => { const {market,card}=cardEvidence; setCardEvidence(null); if (card === "pairwise") setCardReview({portfolio:market,stage:"source"}); else openInputSelection(market,card); }}
        onTemplate={cardEvidence.card === "pairwise" ? undefined : () => { const {market,card}=cardEvidence; setCardEvidence(null); if (card !== "pairwise") showStagePrompt(market,card); }} />}
      {surface?.scorecards ? <ScorecardScreen key={[surface.market,surface.scorecards.card,surface.scorecards.sequence].join("/")}
        market={surface.market} screen={surface.scorecards} client={apiService}
        account={basketOwner?.full_name || basketOwner?.username || "Account"}
        renderOutput={(run, card) => <RunOutputDetails run={run} pairwise={card === "pairwise"} />}
        onModels={card => void showStageLlmInfo(surface.market,card)}
        onInputs={card => card === "pairwise" ? setCardReview({portfolio:surface.market,stage:"source"}) : openInputSelection(surface.market,card)}
        onTemplate={card => showStagePrompt(surface.market,card)}
        onStockFlow={() => setStockFlowPortfolio(surface.market)}
        onManage={(stage,revision,attempt) => setCardReview({portfolio:surface.market,stage,revision,attempt})} /> : <>
      {stageLedger ? <WorkflowStageLedgerViews market={surface?.market ?? ledgerMarket} portfolioOnly={Boolean(surface)} view={ledgerView} onChange={(market, view) => { setLedgerMarket(market); setLedgerView(view); }} /> : null}
      <section className={stageLedger ? "min-w-0" : "grid gap-6 xl:grid-cols-2"}>
        {(!stageLedger || (surface?.market ?? ledgerMarket) === "zerodha") && renderSectionCard(zerodhaSection)}
        {(!stageLedger || (surface?.market ?? ledgerMarket) === "indmoneyUs") && renderSectionCard(indmoneySection)}
      </section>
      </>}
      {!llmDialogStage && modelSaveError && <p role="alert" className="text-sm text-red-800">{modelSaveError}</p>}
      {workflowHistoryError ? <div role="alert" className="mb-4 rounded border border-amber-500 p-3">{workflowHistoryError}</div> : null}

      <RebalanceStockFlowDialog
        portfolio={stockFlowPortfolio}
        formulaConfig={scoreMatrixFormulaConfig}
        buyThresholds={{
          zerodha: zerodhaBasketBuyThreshold,
          indmoneyUs: indmoneyBasketBuyThreshold,
        }}
        buyThresholdDrafts={{
          zerodha: zerodhaBasketBuyThresholdDraft,
          indmoneyUs: indmoneyBasketBuyThresholdDraft,
        }}
        onBuyThresholdDraftChange={(portfolio, value) => {
          if (portfolio === "zerodha") updateZerodhaBasketBuyThresholdDraft(value);
          else updateIndmoneyBasketBuyThresholdDraft(value);
        }}
        buyThresholdSaveError={buyThresholdSaveError}
          buyThresholdPersistence={buyThresholdPersistence}
        onClose={() => setStockFlowPortfolio(null)}
      />

      <AutoRebalanceCostHistoryDialog
        open={Boolean(costHistoryPortfolio)}
        portfolio={costHistoryPortfolio}
        groups={costHistoryGroups}
        loading={costHistoryLoading}
        error={costHistoryError}
        usdInrRate={usdInrRate}
        selectedGroup={selectedCostGroup}
        onSelectGroup={setSelectedCostGroup}
        onClose={closeAutoRebalanceCostHistory}
        onCloseBreakdown={() => setSelectedCostGroup(null)}
      />

      <StageLlmSelectorDialog
        open={Boolean(llmDialogStage)}
        stage={llmDialogStage}
        portfolio={llmDialogPortfolio}
        providers={llmDialogProviders}
        selectedKeys={llmDialogSelectedKeys}
        historicalEstimatedCostInrByTarget={llmDialogHistoricalCosts}
        loading={llmDialogLoading}
        error={llmDialogError}
        onRetry={() => {
          if (llmDialogStage && llmDialogPortfolio) {
            void showStageLlmInfo(llmDialogPortfolio, llmDialogStage);
          }
        }}
        onToggle={toggleLlmTarget}
        saving={savingModels}
        saveError={modelSaveError}
        onImportPrevious={legacyKeys ? () => saveModelKeys(legacyKeys) : undefined}
        onSelectAll={() => saveModelKeys(getCompatibleTargets(llmDialogProviders).map(targetKey))}
        onClear={() => saveModelKeys([])}
        onResetDefaults={() => llmDialogStage && saveModelKeys(defaultStageModelKeys(llmDialogStage))}
        onReplaceSelection={persistLlmDialogSelection}
        selectedMultipliers={llmDialogMultipliers}
        onMultiplierChange={changeLlmMultiplier}
        lastRunCostInr={
          llmDialogStage && llmDialogPortfolio
            ? getStageCostInr(
                states[llmDialogPortfolio][llmDialogStage],
                usdInrRate,
              )
            : null
        }
        onClose={() => {
          llmDialogRequestRef.current += 1;
          setLlmDialogStage(null);
          setLlmDialogPortfolio(null);
          setLlmDialogError(null);
          setLlmDialogLoading(false);
        }}
      />

      <InputSelectionDialog
        open={Boolean(inputDialog)}
        stage={inputDialog?.stage ?? null}
        candidates={inputCandidates}
        selectedIds={
          inputDialog
            ? selectedInputs[inputDialog.portfolio][inputDialog.stage]
            : new Set()
        }
        usdInrRate={usdInrRate}
        loading={inputCandidatesLoading}
        error={inputCandidatesError}
        onToggle={toggleInputCandidate}
        onToggleAll={toggleAllInputCandidates}
        onResetDefaults={resetDefaultInputCandidates}
        onClose={() => setInputDialog(null)}
      />

      <ZerodhaBasketPreviewDialog
        open={zerodhaBasketOpen}
        loading={zerodhaBasketLoading}
        error={zerodhaBasketError}
        orders={zerodhaBasketOrders}
        allocationUniverse={zerodhaAllocationUniverse}
        scoreSourceRuns={zerodhaBasketHistoryRuns}
        selectedIds={selectedZerodhaBasketIds}
        onClose={() => { zerodhaPreparation.current += 1; setZerodhaBasketOpen(false); }}
        onToggle={toggleZerodhaBasketOrder}
        onDefaultSelection={setSelectedZerodhaBasketIds}
        onToggleAll={toggleAllZerodhaBasketOrders}
        onToggleSection={toggleZerodhaBasketSection}
        onOrderKindChange={updateZerodhaBasketOrderKind}
        onPercentChange={updateZerodhaBasketPercent}
        onUnitsChange={updateZerodhaBasketUnits}
        onWholeShareChoice={reviewZerodhaWholeShareChoice}
        onPlaceOrder={placeSelectedZerodhaBasketOrders}
        placing={zerodhaBasketPlacing}
        showSubmissionNotice={Boolean(basketSafety.blockedReason || brokerOrderBlock || verificationIssue || verifiedBasketFormula || scoreRevision?.differences.length)}
        orderSubmissionBlockedReason={basketSafety.blockedReason ?? zerodhaOrderSubmissionBlockedReason}
        directMarketAvailable={zerodhaDirectMarketAvailable}
        executionMode={zerodhaExecutionMode}
        onExecutionModeChange={changeZerodhaExecutionMode}
        onRefreshLtp={refreshZerodhaBasketLtp}
        ltpRefreshing={zerodhaBasketLtpRefreshing}
        ltpRefreshedAt={zerodhaBasketLtpRefreshedAt}
        scoreRevision={scoreRevision}
        compareCurrentSettings={scoreRevision?.formula && canonicalBasketInputs(scoreRevision.formula) === canonicalBasketInputs(basketFormula) && canonicalBasketInputs(basketFormula) !== canonicalBasketInputs(scoreMatrixFormulaConfig)
          ? () => void openZerodhaBasketPreview({sequence: scoreRevision.sequence, formula: scoreMatrixFormulaConfig}) : undefined}
        openSavedBasket={scoreRevision?.formula && canonicalBasketInputs(scoreRevision.formula) !== canonicalBasketInputs(basketFormula)
          ? () => void openZerodhaBasketPreview({sequence: scoreRevision.sequence, formula: scoreRevision.formula!}) : undefined}
        scoreScanCompletedAt={zerodhaBasketScoreScanCompletedAt}
        submission={zerodhaBasketSubmission}
        detailsData={zerodhaBasketDetailsData}
        historicalRows={zerodhaBasketHistoricalRows}
        formulaConfig={basketFormula}
        onFormulaConfigChange={handleScoreMatrixFormulaConfigChange}
        buyThreshold={zerodhaBasketBuyThreshold}
        buyThresholdDraft={zerodhaBasketBuyThresholdDraft}
        onBuyThresholdDraftChange={updateZerodhaBasketBuyThresholdDraft}
      />

      <ZerodhaBasketPreviewDialog
        open={indmoneyBasketOpen}
        loading={indmoneyBasketLoading}
        error={indmoneyBasketError}
        orders={indmoneyBasketOrders}
        allocationUniverse={indmoneyAllocationUniverse}
        scoreSourceRuns={indmoneyBasketHistoryRuns}
        selectedIds={selectedIndmoneyBasketIds}
        onClose={() => { indmoneyPreparation.current += 1; setIndmoneyBasketOpen(false); }}
        onToggle={toggleIndmoneyBasketOrder}
        onToggleAll={toggleAllIndmoneyBasketOrders}
        onToggleSection={toggleIndmoneyBasketSection}
        onOrderKindChange={updateIndmoneyBasketOrderKind}
        onPercentChange={updateIndmoneyBasketPercent}
        onUnitsChange={updateIndmoneyBasketUnits}
        onPlaceOrder={confirmIndmoneyFinalOrder}
        placing={false}
        directMarketAvailable={false}
        executionMode="publisher_limit"
        onExecutionModeChange={() => undefined}
        onRefreshLtp={() => undefined}
        ltpRefreshing={false}
        ltpRefreshedAt={null}
        submission={null}
        detailsData={indmoneyBasketDetailsData}
        historicalRows={indmoneyBasketHistoricalRows}
        scoreScanCompletedAt={usScanAt}
        scoreRevision={usRevision}
        compareCurrentSettings={usRevision?.formula && canonicalBasketInputs(usFormula) !== canonicalBasketInputs(scoreMatrixFormulaConfig) ? () => void openIndmoneyBasketPreview({sequence:usRevision.sequence,formula:scoreMatrixFormulaConfig}) : undefined}
        openSavedBasket={usRevision?.formula && canonicalBasketInputs(usFormula) !== canonicalBasketInputs(usRevision.formula) ? () => void openIndmoneyBasketPreview({sequence:usRevision.sequence,formula:usRevision.formula!}) : undefined}
        formulaConfig={usFormula ?? scoreMatrixFormulaConfig}
        onFormulaConfigChange={update => {const next = update(usFormula ?? scoreMatrixFormulaConfig); setScoreMatrixFormulaConfig(() => next); setUsFormula(next);}}
        buyThreshold={indmoneyBasketBuyThreshold}
        buyThresholdDraft={indmoneyBasketBuyThresholdDraft}
        onBuyThresholdDraftChange={updateIndmoneyBasketBuyThresholdDraft}
        previewLabel="IndMoney Basket Preview"
        basketTitle="IndMoney Final Order Basket"
        basketBrokerLabel="IndMoney"
        tradingViewMarket="us"
        tradingViewTitle="IndMoney Basket TradingView URLs"
        tradingViewAriaLabel="Open IndMoney basket TradingView URL list"
        loadingLabel="Preparing IndMoney basket…"
        primaryButtonLabel="Final Order"
        basketCurrency="USD"
        basketInfoText="All rows remain visible. Review the IndMoney basket before final execution."
      />

      {promptDialog ? (
        <PromptTemplateDialog
          title={promptDialog.title}
          body={getStagePromptPreview(promptDialog.portfolio, promptDialog.stage, swingPrompts[promptDialog.portfolio])}
          swingSettings={promptDialog.portfolio === "zerodha" && promptDialog.stage === "swing" ? zerodhaSwingSettings : undefined}
          onSaveSwingSettings={settings => {
            const owner = requireWorkflowOwner(runtimeOwner);
            window.localStorage.setItem(zerodhaSwingSettingsKey(owner.id), JSON.stringify(settings));
            setZerodhaSwingSettings(settings);
          }}
          onReviewInputs={() => {
            const { portfolio, stage } = promptDialog;
            setPromptDialog(null);
            void openInputSelection(portfolio, stage);
          }}
          onClose={() => setPromptDialog(null)}
        />
      ) : null}

      {outputDialog ? (
        <SavedOutputDialog
          title={outputDialog.title}
          savedAt={outputDialog.savedAt}
          provenance={outputDialog.provenance}
          routeUrl={outputDialog.routeUrl ?? getStageOutputRoute(outputDialog.portfolio, outputDialog.stage)}
          onClose={closeOutputDialog}
          onRetry={() => void showStageOutput(outputDialog.portfolio, outputDialog.stage, outputDialog.requestedRunId)}
          loading={outputDialog.loading}
        >
            {outputDialog.stage === "threats" ? <p className="border-b border-slate-200 bg-white px-6 py-3 text-sm text-slate-600">{STAGE_METADATA[outputDialog.stage].tileDescription}</p> : null}
            <div className="max-h-[72vh] overflow-auto bg-white p-0 text-slate-900">
              {outputDialog.loading ? (
                <div role="status" className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
                  <Loader2 className="size-4 animate-spin" /> Loading output…
                </div>
              ) : outputDialog.error ? (
                <div role="alert" className="m-5 rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-700">
                  {outputDialog.error}
                </div>
              ) : outputDialog.stage === "actionables" ? (
                <div className="max-h-[72vh] overflow-auto bg-slate-50 p-4">
                  <FinalActionablesConsole
                    portfolio={outputDialog.portfolio}
                    market={outputDialog.portfolio === "zerodha" ? "india" : "us"}
                    openCalculationsOnMount={
                      actionablesCalculationsPortfolio === outputDialog.portfolio
                    }
                  />
                </div>
              ) : outputDialog.run ? (
                <RunOutputDetails run={outputDialog.run} pairwise={outputDialog.stage === "pairwise"} />
              ) : (
                <pre className="m-5 whitespace-pre-wrap break-words rounded-2xl bg-slate-950 p-5 text-xs leading-6 text-slate-100">
                  {outputDialog.body}
                </pre>
              )}
            </div>
        </SavedOutputDialog>
      ) : null}

      {dialogOpen ? (
        <IndMoneySnapshotDialog
          open={dialogOpen}
          saving={runningPortfolio === "indmoneyUs"}
          error={dialogError}
          loadSnapshot={readLatestIndmoneySnapshot}
          onClose={() => {
            if (runningPortfolio === "indmoneyUs") return;
            setDialogOpen(false);
            setIndMoneySyncOnly(false);
          }}
          onContinue={handleIndMoneyContinue}
        />
      ) : null}
    </AutomatedRebalanceReliabilityBridge>
  );
  if (surface === null) return null;
  return surface ? createPortal(content, surface.target) : content;
}
