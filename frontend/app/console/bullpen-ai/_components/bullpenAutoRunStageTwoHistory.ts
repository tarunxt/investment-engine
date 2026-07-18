import {
  createBullpenQuestionRow,
  getBullpenAmountToBeInvestedBreakdown,
  getBullpenReturnsPerDayBreakdown,
  isBullpenQuestionInvestmentCandidate,
  normalizeBullpenLlmBreakdownEntries,
  type BullpenLlmDisagreementCategory,
  type BullpenLlmDisagreementLevel,
  type BullpenQuestionLlmBreakdownItem,
  type BullpenQuestionRow,
} from "@/lib/bullpen-ai";
import type { BullpenAutoLiveDecision } from "@/types/api";
import type {
  BullpenAutoRunScanCandidateView,
  BullpenAutoRunWorkflowStageView,
} from "./bullpenAutoRunProgress";

type StageTwoReviewedRow = Record<string, unknown>;

export type StageTwoLlmTableRow = {
  id: string;
  title: string;
  row: StageTwoReviewedRow;
  output: Record<string, unknown> | null;
  decision: BullpenAutoLiveDecision | null;
  provider: string;
  model: string;
  sourceTimestamp: string | null;
  serialNumber: number;
  question: string;
  closeTime: string | null;
  daysLeft: number | null;
  category: string;
  outcomes: string;
  currentYesOdds: number | null;
  currentNoOdds: number | null;
  yesOdds: number | null;
  noOdds: number | null;
  returnsPerDay: number | null;
  action: string;
  risk: string;
  summary: string;
  rationale: string;
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readString(value: unknown) {
  return typeof value === "string" && value.trim().length > 0
    ? value.trim()
    : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  const normalized = trimmed.replace(/[%,$\s]/g, "").replace(/,/g, "");
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return null;
}

function readArray(value: unknown) {
  return Array.isArray(value) ? value : [];
}

function readRecordValue(
  record: Record<string, unknown> | null,
  key: string,
) {
  return record ? record[key] : undefined;
}

function readRecord(record: Record<string, unknown> | null, key: string) {
  const value = readRecordValue(record, key);
  return isRecord(value) ? value : null;
}

function normalizeMatchKey(value: string | null | undefined) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\/+$/, "").toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeRunId(value: string | number | null | undefined) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return value.trim();
  }
  return null;
}

function buildRunMarketMatchKey(
  runId: string | number | null | undefined,
  marketId: string | null | undefined,
) {
  const normalizedRunId = normalizeRunId(runId);
  const normalizedMarketId = normalizeMatchKey(marketId);
  if (!normalizedRunId || !normalizedMarketId) {
    return null;
  }
  return `run-market:${normalizedRunId}::${normalizedMarketId}`;
}

function calculateDaysUntilClose(
  closeTime: string | null,
  referenceTimeMs = Date.now(),
) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return Number(
    ((closeDate.getTime() - referenceTimeMs) / (24 * 60 * 60 * 1000)).toFixed(1),
  );
}

function readPromptInputs(row: StageTwoReviewedRow) {
  return readRecord(row, "llm_prompt_inputs");
}

function readPromptInputMarket(row: StageTwoReviewedRow) {
  return readRecord(readPromptInputs(row), "market");
}

function readPreparedQuestionPayload(row: StageTwoReviewedRow) {
  const prepared = readRecord(row, "prepared_question_payload");
  if (prepared) return prepared;
  return readRecord(readPromptInputs(row), "question_payload");
}

function readStageTwoContext(row: StageTwoReviewedRow) {
  const direct = readRecord(row, "stage2_context");
  if (direct) return direct;
  return readRecord(readPromptInputs(row), "stage2_context");
}

function readQuestionRuntime(row: StageTwoReviewedRow) {
  return readRecord(row, "question_runtime");
}

function readFirstString(...values: unknown[]) {
  for (const value of values) {
    const next = readString(value);
    if (next) return next;
  }
  return null;
}

function readFirstNumber(...values: unknown[]) {
  for (const value of values) {
    const next = readNumber(value);
    if (next !== null) return next;
  }
  return null;
}

function readFirstBoolean(...values: unknown[]) {
  for (const value of values) {
    const next = readBoolean(value);
    if (next !== null) return next;
  }
  return null;
}

function formatMetricString(value: number | null) {
  if (value === null) return null;
  return value.toLocaleString("en-US", {
    maximumFractionDigits: value >= 1000 ? 0 : 2,
  });
}

function readOutcomeLabels(
  row: StageTwoReviewedRow,
): string[] {
  const directOutcomes = readArray(row.outcomes).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (directOutcomes.length) return directOutcomes;

  const preparedQuestionPayload = readPreparedQuestionPayload(row);
  const payloadOutcomes = readArray(
    readRecordValue(preparedQuestionPayload, "outcomes"),
  ).filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  return payloadOutcomes;
}

function formatOutcomes(row: StageTwoReviewedRow) {
  const explicitLabel = readFirstString(row.outcomes, row.outcome);
  if (explicitLabel) return explicitLabel;
  const outcomeLabels = readOutcomeLabels(row);
  if (outcomeLabels.length) return outcomeLabels.join(" / ");
  return "Yes / No";
}

function getRowMatchKeys(
  row: StageTwoReviewedRow,
  runId?: string | number | null,
) {
  const preparedQuestionPayload = readPreparedQuestionPayload(row);
  const promptInputMarket = readPromptInputMarket(row);
  const rawKeys = [
    row.market_id,
    row.marketId,
    row.question_id,
    row.questionId,
    row.slug,
    readRecordValue(preparedQuestionPayload, "market_id"),
    readRecordValue(preparedQuestionPayload, "question_id"),
    readRecordValue(preparedQuestionPayload, "slug"),
    readRecordValue(promptInputMarket, "slug"),
  ]
    .map((value) => normalizeMatchKey(readString(value)))
    .filter((key): key is string => Boolean(key));
  const orderedKeys: string[] = [];
  rawKeys.forEach((key) => {
    const runMarketKey = buildRunMarketMatchKey(runId, key);
    if (runMarketKey) {
      orderedKeys.push(runMarketKey);
    }
    orderedKeys.push(key);
  });
  return orderedKeys;
}

function normalizeTimestampToMs(
  value: string | number | Date | null | undefined,
) {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.getTime();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return value;
  }
  if (typeof value !== "string" || value.trim().length === 0) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeTimestampToIso(
  value: string | number | Date | null | undefined,
) {
  const timestampMs = normalizeTimestampToMs(value);
  return timestampMs === null ? null : new Date(timestampMs).toISOString();
}

function pickLatestTimestamp(
  values: Array<string | number | Date | null | undefined>,
) {
  let bestTimestampMs: number | null = null;
  values.forEach((value) => {
    const candidateMs = normalizeTimestampToMs(value);
    if (candidateMs === null) return;
    if (bestTimestampMs === null || candidateMs > bestTimestampMs) {
      bestTimestampMs = candidateMs;
    }
  });
  return bestTimestampMs === null ? null : new Date(bestTimestampMs).toISOString();
}

function hasUsableNormalizedBreakdownEntry(
  entry: BullpenQuestionLlmBreakdownItem,
) {
  return (
    !entry.invalidReason &&
    !entry.invalidStaleFact &&
    (entry.llmYesOdds !== null || entry.llmNoOdds !== null)
  );
}

function readStageTwoRowCalculationTimestamp(row: StageTwoReviewedRow) {
  return (
    readFirstString(
      row.events_summary_snapshot_timestamp,
      row.events_summary_updated_at,
      row.events_summary_calculated_at,
      row.calculation_timestamp,
      row.calculated_at,
      row.calculatedAt,
      row.current_odds_updated_at,
      row.currentOddsUpdatedAt,
    ) ?? null
  );
}

function readStageTwoRowAnyTimestamp(row: StageTwoReviewedRow) {
  return (
    readStageTwoRowCalculationTimestamp(row) ??
    readFirstString(
      row.llm_completed_at,
      row.completed_at,
      row.llm_run_at,
      row.scanned_at,
    ) ??
    null
  );
}

function getDecisionMatchKeys(decision: BullpenAutoLiveDecision) {
  const rawKeys = [decision.market_id, decision.slug ?? null]
    .map(normalizeMatchKey)
    .filter((key): key is string => Boolean(key));
  const orderedKeys: string[] = [];
  rawKeys.forEach((key) => {
    const runMarketKey = buildRunMarketMatchKey(decision.run_id, key);
    if (runMarketKey) {
      orderedKeys.push(runMarketKey);
    }
    orderedKeys.push(key);
  });
  return orderedKeys;
}

function isMissingValue(value: unknown) {
  return (
    value === undefined ||
    value === null ||
    value === "" ||
    (Array.isArray(value) && value.length === 0)
  );
}

function countDefinedFields(record: Record<string, unknown>) {
  return Object.values(record).reduce<number>(
    (count, value) => count + (isMissingValue(value) ? 0 : 1),
    0,
  );
}

function mergeLlmOutputRecords(
  existing: Record<string, unknown>,
  incoming: Record<string, unknown>,
) {
  const merged = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (isMissingValue(merged[key]) && !isMissingValue(value)) {
      merged[key] = value;
    }
  }

  const existingScore = countDefinedFields(existing);
  const incomingScore = countDefinedFields(incoming);
  if (incomingScore > existingScore) {
    for (const [key, value] of Object.entries(incoming)) {
      if (!isMissingValue(value)) {
        merged[key] = value;
      }
    }
  }

  const existingTimestamp = Date.parse(
    readFirstString(existing.completed_at, existing.completedAt, existing.timestamp) ?? "",
  );
  const incomingTimestamp = Date.parse(
    readFirstString(incoming.completed_at, incoming.completedAt, incoming.timestamp) ?? "",
  );
  if (Number.isFinite(incomingTimestamp) && incomingTimestamp >= existingTimestamp) {
    for (const [key, value] of Object.entries(incoming)) {
      if (!isMissingValue(value)) {
        merged[key] = value;
      }
    }
  }

  return merged;
}

const STAGE_TWO_HISTORY_IDENTITY_ERROR =
  "Data integrity error: Stage 2 recorded an LLM output without a provider/model identity.";

function normalizeStageTwoHistoryOutputIntegrity(
  output: Record<string, unknown>,
  index: number,
) {
  const provider = readFirstString(output.provider, output.llm_provider)?.trim() ?? "";
  const model = readFirstString(output.model, output.llm_model)?.trim() ?? "";
  if (provider && model) return output;

  return {
    ...output,
    error:
      readFirstString(output.error, output.provider_error) ??
      STAGE_TWO_HISTORY_IDENTITY_ERROR,
    invalid_reason:
      readFirstString(output.invalid_reason, output.invalidReason) ??
      STAGE_TWO_HISTORY_IDENTITY_ERROR,
    _stage2_integrity_key: `missing-provider-model-${index}`,
  };
}

function getLlmOutputMatchKey(output: Record<string, unknown>, index: number) {
  const provider =
    readFirstString(output.provider, output.llm_provider) ??
    `missing-provider-${index}`;
  const model =
    readFirstString(output.model, output.llm_model) ?? `missing-model-${index}`;
  const timestamp =
    readFirstString(output.completed_at, output.completedAt, output.timestamp) ??
    `output-${index}`;
  const integrityKey = readFirstString(output._stage2_integrity_key);
  return `${provider.toLowerCase()}::${model.toLowerCase()}::${timestamp.toLowerCase()}::${(integrityKey ?? "").toLowerCase()}`;
}

function dedupeLlmOutputs(outputs: Record<string, unknown>[]) {
  const deduped = new Map<string, Record<string, unknown>>();
  outputs.forEach((output, index) => {
    const normalizedOutput = normalizeStageTwoHistoryOutputIntegrity(output, index);
    const key = getLlmOutputMatchKey(normalizedOutput, index);
    const existing = deduped.get(key);
    deduped.set(
      key,
      existing
        ? mergeLlmOutputRecords(existing, normalizedOutput)
        : normalizedOutput,
    );
  });
  return [...deduped.values()];
}

function mergeReviewedRows(
  existing: StageTwoReviewedRow | null,
  incoming: StageTwoReviewedRow,
) {
  if (!existing) {
    const llmOutputs = readArray(incoming.llm_outputs).filter(isRecord);
    return llmOutputs.length
      ? {
          ...incoming,
          llm_outputs: dedupeLlmOutputs(llmOutputs),
        }
      : { ...incoming };
  }

  const merged: StageTwoReviewedRow = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (key === "llm_outputs") continue;
    if (isMissingValue(merged[key]) && !isMissingValue(value)) {
      merged[key] = value;
    }
  }

  const llmOutputs = dedupeLlmOutputs([
    ...readArray(existing.llm_outputs).filter(isRecord),
    ...readArray(incoming.llm_outputs).filter(isRecord),
  ]);
  if (llmOutputs.length) {
    merged.llm_outputs = llmOutputs;
  }

  return merged;
}

function buildDecisionLookup(decisions: BullpenAutoLiveDecision[]) {
  const decisionByKey = new Map<string, BullpenAutoLiveDecision>();
  decisions.forEach((decision) => {
    getDecisionMatchKeys(decision).forEach((key) => decisionByKey.set(key, decision));
  });
  return decisionByKey;
}

function buildRowContext(
  row: StageTwoReviewedRow,
  decision: BullpenAutoLiveDecision | null,
  referenceTimeMs = Date.now(),
) {
  const promptInputMarket = readPromptInputMarket(row);
  const preparedQuestionPayload = readPreparedQuestionPayload(row);
  const stageTwoContext = readStageTwoContext(row);
  const title =
    readFirstString(
      row.question,
      row.market_title,
      readRecordValue(promptInputMarket, "question"),
      readRecordValue(preparedQuestionPayload, "question"),
      decision?.market_title,
    ) ?? "Unknown event";
  const closeTime =
    readFirstString(
      row.close_time,
      row.end_date,
      readRecordValue(promptInputMarket, "close_time"),
      readRecordValue(preparedQuestionPayload, "close_time"),
      decision?.close_time,
    ) ?? null;
  const currentYesOdds = readFirstNumber(
    row.current_yes_odds,
    row.current_yes_odds_pct,
    row.yes_price_pct,
    readRecordValue(promptInputMarket, "current_yes_odds"),
    readRecordValue(preparedQuestionPayload, "current_yes_odds"),
    decision?.current_yes_odds,
  );
  const currentNoOdds =
    readFirstNumber(
      row.current_no_odds,
      row.current_no_odds_pct,
      row.no_price_pct,
      readRecordValue(promptInputMarket, "current_no_odds"),
      readRecordValue(preparedQuestionPayload, "current_no_odds"),
      decision?.current_no_odds,
    ) ??
    (currentYesOdds === null ? null : Number((100 - currentYesOdds).toFixed(4)));
  const category =
    readFirstString(
      row.category,
      row.theme,
      readRecordValue(promptInputMarket, "theme"),
      readRecordValue(preparedQuestionPayload, "category"),
      decision?.theme,
    ) ?? "—";
  const marketUrl =
    readFirstString(
      row.market_url,
      row.canonical_market_url,
      readRecordValue(promptInputMarket, "market_url"),
      readRecordValue(stageTwoContext, "canonical_market_url"),
      readRecordValue(preparedQuestionPayload, "market_url"),
      decision?.market_url,
    ) ?? null;
  const sourceUrl =
    readFirstString(row.source_url, row.url, marketUrl, decision?.market_url) ?? "";
  const slug =
    readFirstString(
      row.slug,
      readRecordValue(promptInputMarket, "slug"),
      readRecordValue(preparedQuestionPayload, "slug"),
      decision?.slug,
    ) ?? null;
  const daysLeft = calculateDaysUntilClose(closeTime, referenceTimeMs);

  return {
    title,
    closeTime,
    daysLeft,
    currentYesOdds,
    currentNoOdds,
    category,
    outcomes: formatOutcomes(row),
    sourceUrl,
    marketUrl,
    slug,
  };
}

function getRowOutputs(row: StageTwoReviewedRow) {
  return dedupeLlmOutputs(readArray(row.llm_outputs).filter(isRecord));
}

function getNormalizedRowLlmBreakdown(row: StageTwoReviewedRow) {
  return normalizeBullpenLlmBreakdownEntries(getRowOutputs(row));
}

function getDecisionFairYes(decision: BullpenAutoLiveDecision | null) {
  if (!decision) return null;
  return (
    decision.fair_yes_probability_pct ??
    (decision.side === "YES" ? decision.fair_probability_pct : null)
  );
}

function getDecisionFairNo(decision: BullpenAutoLiveDecision | null) {
  if (!decision) return null;
  return (
    decision.fair_no_probability_pct ??
    (decision.side === "NO" ? decision.fair_probability_pct : null)
  );
}

function getDecisionReturnsPerDay(decision: BullpenAutoLiveDecision | null) {
  if (!decision) return null;
  const currentProbability =
    (decision.side === "YES"
      ? decision.current_yes_odds
      : decision.current_no_odds) ?? null;
  const fairProbability =
    decision.side === "YES"
      ? getDecisionFairYes(decision)
      : getDecisionFairNo(decision);
  const hoursRemaining = decision.hours_remaining ?? null;
  if (
    currentProbability === null ||
    fairProbability === null ||
    hoursRemaining === null ||
    hoursRemaining <= 0
  ) {
    return null;
  }
  const daysRemaining = hoursRemaining / 24;
  return Number(
    (((fairProbability - currentProbability) / daysRemaining) || 0).toFixed(2),
  );
}

function readStageTwoLlmTimestamp(
  output: Record<string, unknown> | null,
  row: StageTwoReviewedRow,
) {
  return (
    readFirstString(
      output?.completed_at,
      output?.created_at,
      output?.started_at,
      row.llm_completed_at,
      row.completed_at,
      row.llm_run_at,
      row.scanned_at,
    ) ?? null
  );
}

export function readStageTwoLlmOutputCost(
  output: Record<string, unknown> | null,
) {
  return readFirstNumber(output?.estimated_cost, output?.cost, output?.cost_usd);
}

export function resolveStageTwoHistoricalAsOfTimestamp({
  reviewedRows,
  scanCompletedAt,
  stageCompletedAt,
  runStartedAt,
  runCompletedAt,
  nowMs,
}: {
  reviewedRows: StageTwoReviewedRow[];
  scanCompletedAt?: string | null;
  stageCompletedAt?: string | null;
  runStartedAt?: string | null;
  runCompletedAt?: string | null;
  nowMs?: number | null;
}) {
  const persistedCalculationTimestamp = pickLatestTimestamp(
    reviewedRows.map((row) => readStageTwoRowCalculationTimestamp(row)),
  );
  return (
    persistedCalculationTimestamp ||
    normalizeTimestampToIso(scanCompletedAt) ||
    normalizeTimestampToIso(stageCompletedAt) ||
    normalizeTimestampToIso(runStartedAt) ||
    normalizeTimestampToIso(runCompletedAt) ||
    normalizeTimestampToIso(nowMs ?? null)
  );
}

export function resolveStageTwoEventsSummaryUpdatedAt({
  reviewedRows,
  stageCompletedAt,
  scanCompletedAt,
}: {
  reviewedRows: StageTwoReviewedRow[];
  stageCompletedAt?: string | null;
  scanCompletedAt?: string | null;
}) {
  const persistedSnapshotTimestamp = pickLatestTimestamp(
    reviewedRows.map((row) => readStageTwoRowCalculationTimestamp(row)),
  );
  const latestValidOutputTimestamp = pickLatestTimestamp(
    reviewedRows.flatMap((row) =>
      getNormalizedRowLlmBreakdown(row)
        .filter(hasUsableNormalizedBreakdownEntry)
        .map((entry) => entry.timestamp),
    ),
  );

  return (
    persistedSnapshotTimestamp ||
    latestValidOutputTimestamp ||
    normalizeTimestampToIso(stageCompletedAt) ||
    normalizeTimestampToIso(scanCompletedAt)
  );
}

export function getStageTwoLlmTargetRuns(stage: Pick<BullpenAutoRunWorkflowStageView, "outputs">) {
  const runs = stage.outputs.llm_target_runs;
  return Array.isArray(runs)
    ? runs.filter((run): run is Record<string, unknown> => isRecord(run))
    : [];
}

export function getStageTwoLlmReviewedRows(
  stage: Pick<BullpenAutoRunWorkflowStageView, "outputs">,
  scanCandidates: BullpenAutoRunScanCandidateView[] = [],
) {
  const rowsByPrimaryKey = new Map<string, StageTwoReviewedRow>();
  const primaryKeyByAlias = new Map<string, string>();

  const upsertRow = (incoming: StageTwoReviewedRow) => {
    const aliases = getRowMatchKeys(incoming);
    const primaryKey =
      aliases.find((alias) => primaryKeyByAlias.has(alias))
        ? primaryKeyByAlias.get(
            aliases.find((alias) => primaryKeyByAlias.has(alias))!,
          )!
        : aliases[0] ?? `row-${rowsByPrimaryKey.size}`;
    const existing = rowsByPrimaryKey.get(primaryKey) ?? null;
    const merged = mergeReviewedRows(existing, incoming);
    rowsByPrimaryKey.set(primaryKey, merged);
    aliases.forEach((alias) => primaryKeyByAlias.set(alias, primaryKey));
    return merged;
  };

  const persistedRows = Array.isArray(stage.outputs.llm_reviewed_candidates)
    ? stage.outputs.llm_reviewed_candidates.filter(isRecord)
    : [];
  persistedRows.forEach(upsertRow);

  scanCandidates
    .map((candidate) => ({
      market_id: candidate.marketId,
      question_id: candidate.questionId,
      question: candidate.question,
      market_title: candidate.question,
      close_time: candidate.closeTime,
      category: candidate.theme,
      theme: candidate.theme,
      current_yes_odds: candidate.currentYesOdds,
      current_no_odds: candidate.currentNoOdds,
      market_url: candidate.marketUrl,
      slug: candidate.slug,
      volume_usd: candidate.volumeUsd,
      liquidity_usd: candidate.liquidityUsd,
    }))
    .forEach(upsertRow);

  getStageTwoLlmTargetRuns(stage).forEach((run) => {
    const eventOutputs = readArray(run.event_outputs).filter(isRecord);
    const runCost = readFirstNumber(run.estimated_cost, run.cost);
    const perEventCost =
      eventOutputs.length > 0 && runCost !== null ? runCost / eventOutputs.length : null;

    eventOutputs.forEach((item) => {
      const output = readRecord(item, "output");
      if (!output) return;
      const mergedOutput = {
        ...output,
        provider: readFirstString(output.provider, run.provider) ?? undefined,
        model: readFirstString(output.model, run.model) ?? undefined,
        requested_model:
          readFirstString(output.requested_model, output.requestedModel, run.model) ??
          undefined,
        estimated_cost:
          readStageTwoLlmOutputCost(output) ?? perEventCost ?? undefined,
      };
      upsertRow({
        market_id: readFirstString(item.market_id),
        question_id: readFirstString(item.question_id),
        slug: readFirstString(item.slug, output.slug),
        market_url: readFirstString(item.market_url, output.market_url),
        llm_outputs: [mergedOutput],
      });
    });
  });

  return [...rowsByPrimaryKey.values()];
}

export function getStageTwoLlmTableRows({
  reviewedRows,
  decisions,
  asOfTimestamp,
  runId,
}: {
  reviewedRows: StageTwoReviewedRow[];
  decisions: BullpenAutoLiveDecision[];
  asOfTimestamp?: string | number | Date | null;
  runId?: string | number | null;
}) {
  const decisionByKey = buildDecisionLookup(decisions);
  const referenceTimeMs = normalizeTimestampToMs(asOfTimestamp) ?? Date.now();

  return reviewedRows.flatMap((row, rowIndex) => {
    const decision =
      getRowMatchKeys(row, runId).map((key) => decisionByKey.get(key)).find(Boolean) ?? null;
    const context = buildRowContext(row, decision, referenceTimeMs);
    const outputs = getRowOutputs(row);
    const baseOutputs = outputs.length ? outputs : [null];

    return baseOutputs.map((output, outputIndex) => {
      const normalizedOutput = output
        ? normalizeBullpenLlmBreakdownEntries([output])[0] ?? null
        : null;
      const outputYesOdds = normalizedOutput?.llmYesOdds ?? null;
      const outputNoOdds = normalizedOutput?.llmNoOdds ?? null;
      const hasProviderOutput = Boolean(output);
      return {
        id: `${rowIndex}-${outputIndex}-${context.title}`,
        title: context.title,
        row,
        output,
        decision,
        provider: normalizedOutput?.provider ?? readFirstString(output?.provider) ?? "—",
        model: normalizedOutput?.model ?? readFirstString(output?.model) ?? "—",
        sourceTimestamp: readStageTwoLlmTimestamp(output, row),
        serialNumber: rowIndex + 1,
        question: context.title,
        closeTime: context.closeTime,
        daysLeft: context.daysLeft,
        category: context.category,
        outcomes: context.outcomes,
        currentYesOdds: context.currentYesOdds,
        currentNoOdds: context.currentNoOdds,
        yesOdds: hasProviderOutput
          ? outputYesOdds
          : readFirstNumber(
              row.llm_yes_odds,
              row.fair_yes_probability_pct,
              getDecisionFairYes(decision),
            ),
        noOdds: hasProviderOutput
          ? outputNoOdds
          : readFirstNumber(
              row.llm_no_odds,
              row.fair_no_probability_pct,
              getDecisionFairNo(decision),
            ),
        returnsPerDay: hasProviderOutput
          ? getBullpenReturnsPerDayBreakdown({
              yesOdds: context.currentYesOdds,
              noOdds: context.currentNoOdds,
              llmYesOdds: outputYesOdds,
              llmNoOdds: outputNoOdds,
              daysUntilClose: context.daysLeft,
            }).result
          : (readFirstNumber(row.returns_per_day) ??
              getDecisionReturnsPerDay(decision)),
        action:
          readFirstString(output?.decision, output?.action, decision?.decision) ?? "—",
        risk:
          readFirstString(output?.risk_status, decision?.risk_status) ?? "—",
        summary:
          readFirstString(
            output?.summary,
            row.summary,
            row.reason,
            decision?.summary,
            decision?.reason,
          ) ?? "—",
        rationale:
          readFirstString(
            output?.rationale,
            row.rationale,
            row.reason,
            decision?.rationale,
            decision?.reason,
          ) ?? "—",
      } satisfies StageTwoLlmTableRow;
    });
  });
}

function buildDeterministicHistoricalFallbackId(
  row: StageTwoReviewedRow,
  rowIndex: number,
  context: ReturnType<typeof buildRowContext>,
) {
  const slugBase =
    readFirstString(
      row.question,
      row.market_title,
      context.slug,
      context.marketUrl,
      `row-${rowIndex + 1}`,
    ) ?? `row-${rowIndex + 1}`;
  const normalized = slugBase
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `stage-two-event-${normalized || rowIndex + 1}`;
}

function buildStableStageTwoRowId(
  row: StageTwoReviewedRow,
  rowIndex: number,
  context: ReturnType<typeof buildRowContext>,
  preparedQuestionPayload: Record<string, unknown> | null,
  stageTwoContext: Record<string, unknown> | null,
) {
  return (
    readFirstString(
      row.question_id,
      readRecordValue(preparedQuestionPayload, "question_id"),
      row.market_id,
      readRecordValue(preparedQuestionPayload, "market_id"),
      row.slug,
      readRecordValue(preparedQuestionPayload, "slug"),
      context.slug,
      row.canonical_market_url,
      readRecordValue(stageTwoContext, "canonical_market_url"),
      row.market_url,
      readRecordValue(preparedQuestionPayload, "market_url"),
      context.marketUrl,
    ) ?? buildDeterministicHistoricalFallbackId(row, rowIndex, context)
  );
}

export function buildStageTwoEventsSummaryRows({
  reviewedRows,
  decisions,
  runId,
  asOfTimestamp,
}: {
  reviewedRows: StageTwoReviewedRow[];
  decisions: BullpenAutoLiveDecision[];
  runId: string | number | null;
  asOfTimestamp?: string | number | Date | null;
}): BullpenQuestionRow[] {
  const decisionByKey = buildDecisionLookup(decisions);
  const referenceTimeMs = normalizeTimestampToMs(asOfTimestamp) ?? Date.now();
  const normalizedAsOfTimestamp = normalizeTimestampToIso(asOfTimestamp);

  return reviewedRows.map((row, rowIndex) => {
    const decision =
      getRowMatchKeys(row, runId).map((key) => decisionByKey.get(key)).find(Boolean) ?? null;
    const context = buildRowContext(row, decision, referenceTimeMs);
    const promptInputMarket = readPromptInputMarket(row);
    const preparedQuestionPayload = readPreparedQuestionPayload(row);
    const stageTwoContext = readStageTwoContext(row);
    const questionRuntime = readQuestionRuntime(row);
    const llmOutputs = getRowOutputs(row);
    const normalizedBreakdown = normalizeBullpenLlmBreakdownEntries(llmOutputs);
    const hasUsableBreakdown = normalizedBreakdown.some(
      hasUsableNormalizedBreakdownEntry,
    );
    const outcomeLabels = readOutcomeLabels(row);
    const volume = formatMetricString(
      readFirstNumber(
        row.volume_usd,
        row.volume,
        readRecordValue(promptInputMarket, "volume_usd"),
      ),
    );
    const liquidity = formatMetricString(
      readFirstNumber(
        row.liquidity_usd,
        row.liquidity,
        readRecordValue(promptInputMarket, "liquidity_usd"),
      ),
    );
    const fallbackId = buildStableStageTwoRowId(
      row,
      rowIndex,
      context,
      preparedQuestionPayload,
      stageTwoContext,
    );
    const llmCompletedAt =
      pickLatestTimestamp(
        normalizedBreakdown
          .filter(hasUsableNormalizedBreakdownEntry)
          .map((entry) => entry.timestamp),
      ) ??
      pickLatestTimestamp(llmOutputs.map((output) => readStageTwoLlmTimestamp(output, row))) ??
      readStageTwoRowAnyTimestamp(row);
    const persistedReturnsPerDay =
      readFirstNumber(row.returns_per_day, getDecisionReturnsPerDay(decision)) ?? null;

    const summaryRow = createBullpenQuestionRow({
      id: fallbackId,
      question: context.title,
      closeTime: context.closeTime,
      category: context.category,
      yesOdds: context.currentYesOdds,
      noOdds: context.currentNoOdds,
      currentOddsUpdatedAt:
        readFirstString(
          row.current_odds_updated_at,
          row.currentOddsUpdatedAt,
          row.scanned_at,
          normalizedAsOfTimestamp,
        ) ?? null,
      investmentTableAddedAt: null,
      volume,
      liquidity,
      sourceUrl: context.sourceUrl,
      slug: context.slug,
      marketUrl: context.marketUrl,
      outcomeLabels,
      outcomeCount: outcomeLabels.length || null,
      isBinaryYesNo:
        outcomeLabels.length === 2 &&
        outcomeLabels.every(
          (label) => label.toLowerCase() === "yes" || label.toLowerCase() === "no",
        ),
      daysUntilClose: calculateDaysUntilClose(context.closeTime, referenceTimeMs),
      rules:
        readFirstString(
          row.rules,
          readRecordValue(stageTwoContext, "exact_resolution_rules"),
          readRecordValue(preparedQuestionPayload, "polymarket_rules"),
        ) ?? null,
      marketContext:
        readFirstString(
          row.market_context,
          readRecordValue(stageTwoContext, "market_context"),
          readRecordValue(preparedQuestionPayload, "polymarket_market_context"),
        ) ?? null,
      resolutionSource:
        readFirstString(
          row.resolution_source,
          readRecordValue(stageTwoContext, "resolution_source"),
          readRecordValue(preparedQuestionPayload, "polymarket_resolution_source"),
        ) ?? null,
      llmYesOdds: readFirstNumber(
        row.fair_yes_probability_pct,
        row.llm_yes_odds,
        getDecisionFairYes(decision),
      ),
      llmNoOdds: readFirstNumber(
        row.fair_no_probability_pct,
        row.llm_no_odds,
        getDecisionFairNo(decision),
      ),
      llmDisagreementLevel:
        readFirstString(
          row.disagreement_level,
          row.llm_disagreement_level,
          decision?.disagreement_level,
        ) as BullpenLlmDisagreementLevel | null,
      llmDisagreementCategory:
        readFirstString(
          row.disagreement_category,
          row.llm_disagreement_category,
        ) as BullpenLlmDisagreementCategory | null,
      adjudicationRequired:
        !hasUsableBreakdown &&
        (readFirstBoolean(row.adjudication_required, decision?.adjudication_required) ??
          false),
      evidenceStatus: hasUsableBreakdown
        ? null
        : readFirstString(row.evidence_status, decision?.evidence_status) ?? null,
      eventState: hasUsableBreakdown
        ? null
        : readFirstString(row.event_state, decision?.event_state) ?? null,
      returnsPerDay: persistedReturnsPerDay,
      amountToBeInvested: readFirstNumber(row.amount_to_be_invested),
      llmNotes:
        normalizedBreakdown.length > 0
          ? null
          : readFirstString(row.summary, row.reason, decision?.summary, decision?.reason),
      llmRunId: runId,
      llmCompletedAt,
      preflightEvidenceBlock:
        readFirstString(
          row.preflight_evidence_block,
          readRecordValue(questionRuntime, "preflight_evidence_block"),
          readRecordValue(preparedQuestionPayload, "preflight_evidence_block"),
        ) ?? null,
      llmBreakdown: normalizedBreakdown,
    });

    const finalReturnsPerDay = summaryRow.returnsPerDay ?? persistedReturnsPerDay;
    const finalAmountToBeInvested =
      readFirstNumber(row.amount_to_be_invested) ??
      getBullpenAmountToBeInvestedBreakdown({
        llmYesOdds: summaryRow.llmYesOdds,
        llmNoOdds: summaryRow.llmNoOdds,
        returnsPerDay: finalReturnsPerDay,
      }).result;
    const finalRow = {
      ...summaryRow,
      returnsPerDay: finalReturnsPerDay,
      amountToBeInvested: finalAmountToBeInvested,
    };

    return {
      ...finalRow,
      isAmountToBeInvestedHighlighted:
        isBullpenQuestionInvestmentCandidate(finalRow),
    };
  });
}
