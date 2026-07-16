import {
  createBullpenQuestionRow,
  getBullpenAmountToBeInvestedBreakdown,
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
  const trimmed = value.trim().toLowerCase();
  return trimmed.length > 0 ? trimmed : null;
}

function calculateDaysUntilClose(closeTime: string | null) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return Number(
    ((closeDate.getTime() - Date.now()) / (24 * 60 * 60 * 1000)).toFixed(1),
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

function getRowMatchKeys(row: StageTwoReviewedRow) {
  const preparedQuestionPayload = readPreparedQuestionPayload(row);
  return [
    row.market_id,
    row.marketId,
    row.question_id,
    row.questionId,
    row.slug,
    row.market_url,
    row.marketUrl,
    row.question,
    row.market_title,
    readRecordValue(preparedQuestionPayload, "market_id"),
    readRecordValue(preparedQuestionPayload, "question_id"),
    readRecordValue(preparedQuestionPayload, "slug"),
    readRecordValue(preparedQuestionPayload, "market_url"),
    readRecordValue(preparedQuestionPayload, "question"),
  ]
    .map((value) => normalizeMatchKey(readString(value)))
    .filter((key): key is string => Boolean(key));
}

function getDecisionMatchKeys(decision: BullpenAutoLiveDecision) {
  return [
    decision.market_id,
    decision.slug ?? null,
    decision.market_url ?? null,
    decision.market_title,
  ]
    .map(normalizeMatchKey)
    .filter((key): key is string => Boolean(key));
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

function getLlmOutputMatchKey(output: Record<string, unknown>, index: number) {
  const provider = readFirstString(output.provider, output.llm_provider) ?? "provider";
  const model = readFirstString(output.model, output.llm_model) ?? "model";
  const timestamp =
    readFirstString(output.completed_at, output.completedAt, output.timestamp) ??
    `output-${index}`;
  return `${provider.toLowerCase()}::${model.toLowerCase()}::${timestamp.toLowerCase()}`;
}

function dedupeLlmOutputs(outputs: Record<string, unknown>[]) {
  const deduped = new Map<string, Record<string, unknown>>();
  outputs.forEach((output, index) => {
    const key = getLlmOutputMatchKey(output, index);
    const existing = deduped.get(key);
    deduped.set(key, existing ? mergeLlmOutputRecords(existing, output) : output);
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
  const daysLeft = calculateDaysUntilClose(closeTime);

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
        estimated_cost:
          readStageTwoLlmOutputCost(output) ?? perEventCost ?? undefined,
      };
      upsertRow({
        market_id: readFirstString(item.market_id),
        question_id: readFirstString(item.question_id),
        llm_outputs: [mergedOutput],
      });
    });
  });

  return [...rowsByPrimaryKey.values()];
}

export function getStageTwoLlmTableRows({
  reviewedRows,
  decisions,
}: {
  reviewedRows: StageTwoReviewedRow[];
  decisions: BullpenAutoLiveDecision[];
}) {
  const decisionByKey = buildDecisionLookup(decisions);

  return reviewedRows.flatMap((row, rowIndex) => {
    const decision =
      getRowMatchKeys(row).map((key) => decisionByKey.get(key)).find(Boolean) ?? null;
    const context = buildRowContext(row, decision);
    const outputs = getRowOutputs(row);
    const baseOutputs = outputs.length ? outputs : [null];

    return baseOutputs.map((output, outputIndex) => {
      const outputYesOdds = readFirstNumber(output?.yes_odds, output?.llm_yes_odds);
      const outputNoOdds = readFirstNumber(output?.no_odds, output?.llm_no_odds);
      const hasProviderOutput = Boolean(output);
      return {
        id: `${rowIndex}-${outputIndex}-${context.title}`,
        title: context.title,
        row,
        output,
        decision,
        provider: readFirstString(output?.provider) ?? "—",
        model: readFirstString(output?.model) ?? "—",
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
        returnsPerDay:
          readFirstNumber(row.returns_per_day) ??
          (hasProviderOutput &&
          context.daysLeft !== null &&
          context.daysLeft > 0 &&
          context.currentYesOdds !== null &&
          context.currentNoOdds !== null &&
          outputYesOdds !== null &&
          outputNoOdds !== null
            ? Number(
                (
                  Math.max(
                    outputYesOdds - context.currentYesOdds,
                    outputNoOdds - context.currentNoOdds,
                  ) / context.daysLeft
                ).toFixed(2),
              )
            : getDecisionReturnsPerDay(decision)),
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

export function buildStageTwoEventsSummaryRows({
  reviewedRows,
  decisions,
  runId,
}: {
  reviewedRows: StageTwoReviewedRow[];
  decisions: BullpenAutoLiveDecision[];
  runId: string | number | null;
}): BullpenQuestionRow[] {
  const decisionByKey = buildDecisionLookup(decisions);

  return reviewedRows.map((row, rowIndex) => {
    const decision =
      getRowMatchKeys(row).map((key) => decisionByKey.get(key)).find(Boolean) ?? null;
    const context = buildRowContext(row, decision);
    const promptInputMarket = readPromptInputMarket(row);
    const preparedQuestionPayload = readPreparedQuestionPayload(row);
    const stageTwoContext = readStageTwoContext(row);
    const questionRuntime = readQuestionRuntime(row);
    const llmOutputs = getRowOutputs(row);
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
    const fallbackId =
      readFirstString(
        row.question_id,
        row.market_id,
        readRecordValue(preparedQuestionPayload, "question_id"),
        readRecordValue(preparedQuestionPayload, "market_id"),
      ) ?? `stage-two-event-${rowIndex + 1}`;
    const llmCompletedAt =
      llmOutputs
        .map((output) => readStageTwoLlmTimestamp(output, row))
        .filter((value): value is string => Boolean(value))
        .sort()
        .at(-1) ?? null;
    const persistedReturnsPerDay =
      readFirstNumber(row.returns_per_day, getDecisionReturnsPerDay(decision)) ?? null;
    const persistedAmountToBeInvested =
      readFirstNumber(row.amount_to_be_invested) ??
      getBullpenAmountToBeInvestedBreakdown({
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
        returnsPerDay: persistedReturnsPerDay,
      }).result;

    const summaryRow = createBullpenQuestionRow({
      id: fallbackId,
      question: context.title,
      closeTime: context.closeTime,
      category: context.category,
      yesOdds: context.currentYesOdds,
      noOdds: context.currentNoOdds,
      currentOddsUpdatedAt: null,
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
      daysUntilClose: calculateDaysUntilClose(context.closeTime),
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
        readFirstBoolean(row.adjudication_required, decision?.adjudication_required) ??
        false,
      evidenceStatus:
        readFirstString(row.evidence_status, decision?.evidence_status) ?? null,
      eventState:
        readFirstString(row.event_state, decision?.event_state) ?? null,
      returnsPerDay: persistedReturnsPerDay,
      amountToBeInvested: persistedAmountToBeInvested,
      llmNotes:
        llmOutputs.length > 0
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
      llmBreakdown: llmOutputs as BullpenQuestionLlmBreakdownItem[],
    });

    return {
      ...summaryRow,
      returnsPerDay: persistedReturnsPerDay ?? summaryRow.returnsPerDay,
      amountToBeInvested:
        persistedAmountToBeInvested ?? summaryRow.amountToBeInvested,
    };
  });
}
