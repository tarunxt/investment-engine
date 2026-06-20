export type ScanMode = "30-days" | "end-of-month";

export type BullpenQuestion = {
  id: string;
  question: string;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  volume: string | null;
  liquidity: string | null;
  sourceUrl: string;
  slug: string | null;
  marketUrl: string | null;
  outcomeLabels: string[];
  outcomeCount: number | null;
  isBinaryYesNo: boolean;
  daysUntilClose: number | null;
};

export type BullpenQuestionAnalysis = {
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  currentVsLlmOddsDifference: number | null;
  returnsPerDay: number | null;
  amountToBeInvested: number | null;
  isAmountToBeInvestedHighlighted: boolean;
  llmNotes: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmRunId: number | null;
  llmCompletedAt: string | null;
  llmBreakdown: BullpenQuestionLlmBreakdownItem[];
};

export type BullpenQuestionRow = BullpenQuestion & BullpenQuestionAnalysis;

export type BullpenScanFilters = {
  maxClosingDays: number;
  targetDate: string;
  excludeSports: boolean;
  excludeWeather: boolean;
  excludeMarketPredictions: boolean;
  excludeTweetCountQuestions: boolean;
  onlyBinaryYesNo: boolean;
  minYesOdds: number;
  minNoOdds: number;
};

export type ScanResult = {
  mode: ScanMode;
  sourceUrl: string;
  sourceLabel: string;
  scannedAt: string;
  filters: BullpenScanFilters;
  totalCandidates: number;
  questions: BullpenQuestion[];
  error?: string;
  warning?: string;
  details?: string;
};

export type BullpenScanSnapshot = Omit<ScanResult, "questions"> & {
  snapshotId: string;
  archivedAt: string | null;
  questions: BullpenQuestionRow[];
};

export type BullpenSnapshotHistory = {
  current: BullpenScanSnapshot | null;
  history: BullpenScanSnapshot[];
};

export type BullpenLlmAnalysisItem = {
  questionId: string;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  currentVsLlmOddsDifference: number | null;
  notes: string | null;
  rationale: string | null;
};

export type BullpenLlmAnalysisPayload = {
  markets: BullpenLlmAnalysisItem[];
};

export type BullpenQuestionLlmBreakdownItem = {
  provider: string;
  model: string;
  jobId: number | null;
  runId: number | null;
  timestamp: string | null;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  rationale: string | null;
};

export type BullpenReturnsPerDayBreakdown = {
  currentOdds: number | null;
  currentSide: "Yes" | "No" | null;
  daysUntilClose: number | null;
  llmYesOdds: number | null;
  result: number | null;
};

export type BullpenAmountToBeInvestedBreakdown = {
  llmNoOdds: number | null;
  llmNoOddsAboveThreshold: number | null;
  returnsPerDay: number | null;
  threshold: number;
  multiplier: number;
  result: number | null;
};

export const END_OF_MONTH_DATE = "2026-06-30";

export const BULLPEN_SOURCE_URLS: Record<ScanMode, string> = {
  "30-days": "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
  "end-of-month":
    "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3",
};

export const BULLPEN_LLM_PROMPT_PLACEHOLDER = "{{SELECTED_QUESTIONS}}";

export const DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE = `[ENABLE_WEB_SEARCH]
You are an independent probability estimation engine for prediction-market events.

Analyze every selected Polymarket question provided in the input and return independent YES/NO probability estimates.

You must produce one result for every input question.

Input fields may include:
question_ref, question_id, question, slug, market_url, closing_time, category, outcomes, current_yes_odds, current_no_odds.

Use current public developments, credible recent information, official sources, base rates, time remaining, and the market's resolution criteria to estimate the true probability of YES.

Do not copy the market odds. The current market odds are only a weak reference signal.

For each question:
1. Determine what YES means under the market wording.
2. Assess the latest relevant developments.
3. Consider the deadline/resolution window.
4. Estimate the probability of YES.
5. Set NO = 100 - YES.

Output requirements:
- Return strict JSON only.
- Return an object with a top-level "markets" array.
- Return exactly one object per input question.
- Do not skip any question.
- Do not include markdown.
- Do not include commentary outside JSON.
- Copy each question_ref exactly from the input.
- question should echo the input question text.
- llm_yes_odds must be a number from 0.00 to 100.00.
- llm_no_odds must be a number from 0.00 to 100.00.
- llm_yes_odds + llm_no_odds must equal exactly 100.00.
- Use two decimal places.
- Do not use the % symbol.
- If evidence is weak, still provide a calibrated estimate.
- Avoid 0 or 100 unless the outcome is already resolved or mathematically certain.
- Keep rationale concise and under 240 characters.

JSON schema:
{
  "markets": [
    {
      "question_ref": "Q1",
      "question": "string",
      "llm_yes_odds": 50.00,
      "llm_no_odds": 50.00,
      "confidence": "Low | Medium | High",
      "rationale": "short explanation"
    }
  ]
}

Selected questions:
${BULLPEN_LLM_PROMPT_PLACEHOLDER}`;

export const DEFAULT_BULLPEN_SCAN_FILTERS: Record<
  ScanMode,
  BullpenScanFilters
> = {
  "30-days": {
    maxClosingDays: 30,
    targetDate: END_OF_MONTH_DATE,
    excludeSports: true,
    excludeWeather: true,
    excludeMarketPredictions: true,
    excludeTweetCountQuestions: false,
    onlyBinaryYesNo: true,
    minYesOdds: 5,
    minNoOdds: 5,
  },
  "end-of-month": {
    maxClosingDays: 30,
    targetDate: END_OF_MONTH_DATE,
    excludeSports: true,
    excludeWeather: true,
    excludeMarketPredictions: true,
    excludeTweetCountQuestions: false,
    onlyBinaryYesNo: true,
    minYesOdds: 5,
    minNoOdds: 5,
  },
};

type SearchParamReader = {
  get(name: string): string | null;
};

function parseBooleanSearchParam(value: string | null, fallback: boolean) {
  if (value === null) return fallback;
  if (value === "true") return true;
  if (value === "false") return false;
  return fallback;
}

function parseNumberSearchParam(value: string | null, fallback: number) {
  if (value === null || value.trim() === "") return fallback;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseDateSearchParam(value: string | null, fallback: string) {
  if (!value) return fallback;
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? value : fallback;
}

export function createBullpenScanFilters(
  mode: ScanMode,
): BullpenScanFilters {
  return { ...DEFAULT_BULLPEN_SCAN_FILTERS[mode] };
}

export function normalizeBullpenScanFilters(
  mode: ScanMode,
  searchParams: SearchParamReader,
): BullpenScanFilters {
  const defaults = DEFAULT_BULLPEN_SCAN_FILTERS[mode];
  return {
    maxClosingDays: Math.max(
      1,
      parseNumberSearchParam(searchParams.get("maxClosingDays"), defaults.maxClosingDays),
    ),
    targetDate: parseDateSearchParam(
      searchParams.get("targetDate"),
      defaults.targetDate,
    ),
    excludeSports: parseBooleanSearchParam(
      searchParams.get("excludeSports"),
      defaults.excludeSports,
    ),
    excludeWeather: parseBooleanSearchParam(
      searchParams.get("excludeWeather"),
      defaults.excludeWeather,
    ),
    excludeMarketPredictions: parseBooleanSearchParam(
      searchParams.get("excludeMarketPredictions"),
      defaults.excludeMarketPredictions,
    ),
    excludeTweetCountQuestions: parseBooleanSearchParam(
      searchParams.get("excludeTweetCountQuestions"),
      defaults.excludeTweetCountQuestions,
    ),
    onlyBinaryYesNo: parseBooleanSearchParam(
      searchParams.get("onlyBinaryYesNo"),
      defaults.onlyBinaryYesNo,
    ),
    minYesOdds: Math.max(
      0,
      parseNumberSearchParam(searchParams.get("minYesOdds"), defaults.minYesOdds),
    ),
    minNoOdds: Math.max(
      0,
      parseNumberSearchParam(searchParams.get("minNoOdds"), defaults.minNoOdds),
    ),
  };
}

export function buildBullpenScanQueryParams(
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  const params = new URLSearchParams();
  params.set("mode", mode);
  params.set("maxClosingDays", String(filters.maxClosingDays));
  params.set("targetDate", filters.targetDate);
  params.set("excludeSports", String(filters.excludeSports));
  params.set("excludeWeather", String(filters.excludeWeather));
  params.set(
    "excludeMarketPredictions",
    String(filters.excludeMarketPredictions),
  );
  params.set(
    "excludeTweetCountQuestions",
    String(filters.excludeTweetCountQuestions),
  );
  params.set("onlyBinaryYesNo", String(filters.onlyBinaryYesNo));
  params.set("minYesOdds", String(filters.minYesOdds));
  params.set("minNoOdds", String(filters.minNoOdds));
  return params;
}

function clampOddsValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(100, Math.max(0, Number(value.toFixed(2))));
}

function normalizeOddsPair(
  yesValue: number | null,
  noValue: number | null,
): { yes: number | null; no: number | null } {
  let yes = clampOddsValue(yesValue);
  let no = clampOddsValue(noValue);

  if (yes !== null && no === null) {
    no = clampOddsValue(100 - yes);
  } else if (no !== null && yes === null) {
    yes = clampOddsValue(100 - no);
  } else if (yes !== null && no !== null) {
    const total = yes + no;
    if (total > 0 && Math.abs(total - 100) > 0.01) {
      yes = clampOddsValue((yes / total) * 100);
      no = clampOddsValue(100 - (yes ?? 0));
    }
  }

  return { yes, no };
}

function calculateBullpenReturnsPerDay({
  yesOdds,
  noOdds,
  llmYesOdds,
  daysUntilClose,
}: Pick<
  BullpenQuestionRow,
  "yesOdds" | "noOdds" | "llmYesOdds" | "daysUntilClose"
>) {
  return getBullpenReturnsPerDayBreakdown({
    yesOdds,
    noOdds,
    llmYesOdds,
    daysUntilClose,
  }).result;
}

function calculateCurrentVsLlmOddsDifference({
  yesOdds,
  llmYesOdds,
}: Pick<BullpenQuestionRow, "yesOdds" | "llmYesOdds">) {
  if (yesOdds === null || llmYesOdds === null) return null;
  return Number((yesOdds - llmYesOdds).toFixed(2));
}

function calculateBullpenAmountToBeInvested({
  llmNoOdds,
  returnsPerDay,
}: Pick<BullpenQuestionRow, "llmNoOdds" | "returnsPerDay">) {
  return getBullpenAmountToBeInvestedBreakdown({
    llmNoOdds,
    returnsPerDay,
  }).result;
}

export function getBullpenReturnsPerDayBreakdown({
  yesOdds,
  noOdds,
  llmYesOdds,
  daysUntilClose,
}: Pick<
  BullpenQuestionRow,
  "yesOdds" | "noOdds" | "llmYesOdds" | "daysUntilClose"
>): BullpenReturnsPerDayBreakdown {
  if (
    yesOdds === null ||
    noOdds === null ||
    llmYesOdds === null ||
    daysUntilClose === null ||
    daysUntilClose <= 0
  ) {
    return {
      currentOdds: null,
      currentSide: null,
      daysUntilClose,
      llmYesOdds,
      result: null,
    };
  }

  const currentSide = llmYesOdds > 50 ? "Yes" : "No";
  const currentOdds = currentSide === "Yes" ? yesOdds : noOdds;

  return {
    currentOdds,
    currentSide,
    daysUntilClose,
    llmYesOdds,
    result:
      currentOdds === null
        ? null
        : Number(((100 - currentOdds) / daysUntilClose).toFixed(2)),
  };
}

export function getBullpenAmountToBeInvestedBreakdown({
  llmNoOdds,
  returnsPerDay,
}: Pick<
  BullpenQuestionRow,
  "llmNoOdds" | "returnsPerDay"
>): BullpenAmountToBeInvestedBreakdown {
  const threshold = 80;
  const multiplier = 5;
  const llmNoOddsAboveThreshold =
    llmNoOdds === null ? null : Number((llmNoOdds - threshold).toFixed(2));

  return {
    llmNoOdds,
    llmNoOddsAboveThreshold,
    returnsPerDay,
    threshold,
    multiplier,
    result:
      llmNoOdds === null || returnsPerDay === null
        ? null
        : Number(
            (
              (multiplier * (llmNoOdds - threshold) * returnsPerDay) /
              100
            ).toFixed(2),
          ),
  };
}

export function isBullpenQuestionInvestmentCandidate(
  question: Pick<
    BullpenQuestionRow,
    "llmNoOdds" | "returnsPerDay" | "amountToBeInvested"
  >,
) {
  return (
    question.llmNoOdds !== null &&
    question.returnsPerDay !== null &&
    question.amountToBeInvested !== null &&
    question.llmNoOdds > 80 &&
    question.returnsPerDay > 5
  );
}

export function createBullpenQuestionRow(
  question: BullpenQuestion | BullpenQuestionRow,
): BullpenQuestionRow {
  const analysisFields = question as Partial<BullpenQuestionAnalysis>;
  const llmBreakdown = normalizeBullpenLlmBreakdown(
    analysisFields.llmBreakdown,
  );
  const averageOdds =
    llmBreakdown.length > 0
      ? averageBullpenLlmOdds(llmBreakdown)
      : { yes: null, no: null };
  const latestCompletedAt =
    [...llmBreakdown]
      .map((entry) => entry.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) || null;
  const llmYesOdds = analysisFields.llmYesOdds ?? averageOdds.yes;
  const llmNoOdds = analysisFields.llmNoOdds ?? averageOdds.no;
  const baseRow = {
    ...question,
    llmYesOdds,
    llmNoOdds,
  } as BullpenQuestionRow;
  const currentVsLlmOddsDifference =
    calculateCurrentVsLlmOddsDifference(baseRow);
  const returnsPerDay = calculateBullpenReturnsPerDay(baseRow);
  const amountToBeInvested = calculateBullpenAmountToBeInvested({
    llmNoOdds,
    returnsPerDay,
  });
  const isAmountToBeInvestedHighlighted = isBullpenQuestionInvestmentCandidate({
    llmNoOdds,
    returnsPerDay,
    amountToBeInvested,
  });

  return {
    ...question,
    llmYesOdds,
    llmNoOdds,
    currentVsLlmOddsDifference,
    returnsPerDay,
    amountToBeInvested,
    isAmountToBeInvestedHighlighted,
    llmNotes: analysisFields.llmNotes ?? summarizeBullpenLlmNotes(llmBreakdown),
    llmProvider:
      analysisFields.llmProvider ??
      (llmBreakdown.length === 1 ? llmBreakdown[0]?.provider || null : null),
    llmModel:
      analysisFields.llmModel ??
      (llmBreakdown.length === 1 ? llmBreakdown[0]?.model || null : null),
    llmRunId: analysisFields.llmRunId ?? null,
    llmCompletedAt: analysisFields.llmCompletedAt ?? latestCompletedAt,
    llmBreakdown,
  };
}

export function createBullpenScanSnapshot(
  result: ScanResult,
  snapshotId = `bullpen-scan-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
): BullpenScanSnapshot {
  return {
    ...result,
    snapshotId,
    archivedAt: null,
    questions: result.questions.map((question) => createBullpenQuestionRow(question)),
  };
}

export function archiveBullpenScanSnapshot(
  snapshot: BullpenScanSnapshot,
  archivedAt = new Date().toISOString(),
): BullpenScanSnapshot {
  return {
    ...snapshot,
    archivedAt,
    questions: snapshot.questions.map((question) => createBullpenQuestionRow(question)),
  };
}

function extractNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const cleaned = value.replace(/[%,$\s]/g, "");
    if (!cleaned) return null;
    const parsed = Number(cleaned);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function extractJsonValueFromText(text: string) {
  const trimmed = text.trim();
  if (!trimmed) {
    throw new Error("LLM returned an empty response.");
  }

  const fencedMatches = Array.from(
    trimmed.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi),
  ).map((match) => match[1]);
  const candidates = [
    ...fencedMatches,
    trimmed,
    (() => {
      const start = trimmed.indexOf("{");
      const end = trimmed.lastIndexOf("}");
      return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
    })(),
    (() => {
      const start = trimmed.indexOf("[");
      const end = trimmed.lastIndexOf("]");
      return start >= 0 && end > start ? trimmed.slice(start, end + 1) : null;
    })(),
  ].filter((candidate): candidate is string => Boolean(candidate));

  for (const candidate of candidates) {
    try {
      return JSON.parse(candidate);
    } catch {
      continue;
    }
  }

  throw new Error("LLM response was not valid JSON.");
}

function getBullpenQuestionRef(index: number) {
  return `Q${index + 1}`;
}

function normalizeQuestionLookupValue(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

function normalizeLooseQuestionLookupValue(value: string) {
  return normalizeQuestionLookupValue(value).replace(/[^a-z0-9]+/g, "");
}

function readStringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function normalizeBullpenLlmBreakdown(
  value: unknown,
): BullpenQuestionLlmBreakdownItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => {
      if (!entry || typeof entry !== "object") return null;
      const record = entry as Record<string, unknown>;
      const provider = readStringValue(record.provider);
      const model = readStringValue(record.model);
      if (!provider || !model) return null;

      return {
        provider,
        model,
        jobId:
          typeof record.jobId === "number" && Number.isFinite(record.jobId)
            ? record.jobId
            : typeof record.job_id === "number" && Number.isFinite(record.job_id)
              ? record.job_id
              : null,
        runId:
          typeof record.runId === "number" && Number.isFinite(record.runId)
            ? record.runId
            : typeof record.run_id === "number" && Number.isFinite(record.run_id)
              ? record.run_id
              : null,
        timestamp:
          readStringValue(record.timestamp) ||
          readStringValue(record.completedAt) ||
          readStringValue(record.completed_at) ||
          null,
        llmYesOdds: clampOddsValue(
          extractNumber(record.llmYesOdds ?? record.llm_yes_odds),
        ),
        llmNoOdds: clampOddsValue(
          extractNumber(record.llmNoOdds ?? record.llm_no_odds),
        ),
        rationale:
          readStringValue(record.rationale) ||
          readStringValue(record.reasoning) ||
          readStringValue(record.notes) ||
          readStringValue(record.note) ||
          readStringValue(record.explanation) ||
          readStringValue(record.summary) ||
          null,
      } satisfies BullpenQuestionLlmBreakdownItem;
    })
    .filter(
      (entry): entry is BullpenQuestionLlmBreakdownItem => entry !== null,
    );
}

function buildBullpenQuestionLookupMap(questions: BullpenQuestionRow[]) {
  const aliasToQuestionId = new Map<string, string>();

  const registerAlias = (alias: string | null, questionId: string) => {
    if (!alias) return;
    const normalized = normalizeQuestionLookupValue(alias);
    const loose = normalizeLooseQuestionLookupValue(alias);

    if (normalized && !aliasToQuestionId.has(normalized)) {
      aliasToQuestionId.set(normalized, questionId);
    }
    if (loose && !aliasToQuestionId.has(loose)) {
      aliasToQuestionId.set(loose, questionId);
    }
  };

  questions.forEach((question, index) => {
    for (const alias of [
      getBullpenQuestionRef(index),
      question.id,
      question.question,
      question.slug,
      question.marketUrl,
    ]) {
      registerAlias(alias, question.id);
    }
  });

  return aliasToQuestionId;
}

function resolveBullpenQuestionId(
  record: Record<string, unknown>,
  aliasToQuestionId: Map<string, string> | null,
) {
  if (!aliasToQuestionId) {
    return (
      readStringValue(record.question_id) ||
      readStringValue(record.questionId) ||
      readStringValue(record.question_ref) ||
      readStringValue(record.questionRef) ||
      readStringValue(record.question) ||
      readStringValue(record.market_question) ||
      readStringValue(record.title) ||
      readStringValue(record.slug) ||
      readStringValue(record.market_url) ||
      readStringValue(record.marketUrl)
    );
  }

  const aliases = [
    readStringValue(record.question_ref),
    readStringValue(record.questionRef),
    readStringValue(record.question_id),
    readStringValue(record.questionId),
    readStringValue(record.question),
    readStringValue(record.market_question),
    readStringValue(record.title),
    readStringValue(record.name),
    readStringValue(record.slug),
    readStringValue(record.market_url),
    readStringValue(record.marketUrl),
  ].filter((alias): alias is string => Boolean(alias));

  for (const alias of aliases) {
    const normalized = normalizeQuestionLookupValue(alias);
    const loose = normalizeLooseQuestionLookupValue(alias);
    const matchedQuestionId =
      aliasToQuestionId.get(normalized) || aliasToQuestionId.get(loose);

    if (matchedQuestionId) return matchedQuestionId;
  }

  return aliases[0] ?? null;
}

function extractMarketsFromParsedLlmPayload(parsed: unknown) {
  if (Array.isArray(parsed)) return parsed;
  if (!parsed || typeof parsed !== "object") return [];

  const record = parsed as Record<string, unknown>;
  const collections = [
    record.markets,
    record.questions,
    record.predictions,
    record.results,
    record.items,
  ];

  for (const collection of collections) {
    if (Array.isArray(collection)) return collection;
  }

  if (record.content && typeof record.content === "object") {
    return extractMarketsFromParsedLlmPayload(record.content);
  }

  return [];
}

export function parseBullpenLlmAnalysisPayload(
  responseText: string,
  questions: BullpenQuestionRow[] = [],
): BullpenLlmAnalysisPayload {
  const parsed = extractJsonValueFromText(responseText);
  const markets = extractMarketsFromParsedLlmPayload(parsed);
  const aliasToQuestionId =
    questions.length > 0 ? buildBullpenQuestionLookupMap(questions) : null;

  if (markets.length === 0) {
    throw new Error("LLM response did not include any market odds.");
  }

  const normalizedMarkets = markets
    .map((item: unknown): BullpenLlmAnalysisItem | null => {
      if (!item || typeof item !== "object") return null;
      const record = item as Record<string, unknown>;
      const questionId = resolveBullpenQuestionId(record, aliasToQuestionId);
      if (!questionId) return null;

      const normalizedOdds = normalizeOddsPair(
        extractNumber(
          record.llm_yes_odds ??
            record.llmYesOdds ??
            record.yes_odds ??
            record.yesOdds ??
            record.yes_probability ??
            record.yesProbability ??
            record.prob_yes ??
            record.probYes ??
            record.probability_yes ??
            record.probabilityYes,
        ),
        extractNumber(
          record.llm_no_odds ??
            record.llmNoOdds ??
            record.no_odds ??
            record.noOdds ??
            record.no_probability ??
            record.noProbability ??
            record.prob_no ??
            record.probNo ??
            record.probability_no ??
            record.probabilityNo,
        ),
      );

      const notes =
        readStringValue(record.rationale) ||
        readStringValue(record.reasoning) ||
        readStringValue(record.notes) ||
        readStringValue(record.note) ||
        readStringValue(record.explanation) ||
        readStringValue(record.summary) ||
        null;

      return {
        questionId,
        llmYesOdds: normalizedOdds.yes,
        llmNoOdds: normalizedOdds.no,
        currentVsLlmOddsDifference: null,
        notes: notes || null,
        rationale: notes || null,
      };
    })
    .filter(
      (item): item is BullpenLlmAnalysisItem => item !== null,
    );

  return {
    markets: normalizedMarkets,
  };
}

export function averageBullpenLlmOdds(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  const yesValues = breakdown
    .map((entry) => entry.llmYesOdds)
    .filter((value): value is number => typeof value === "number");
  const noValues = breakdown
    .map((entry) => entry.llmNoOdds)
    .filter((value): value is number => typeof value === "number");

  const average = (values: number[]) =>
    values.length === 0
      ? null
      : Number(
          (
            values.reduce((total, value) => total + value, 0) / values.length
          ).toFixed(2),
        );

  return normalizeOddsPair(average(yesValues), average(noValues));
}

export function summarizeBullpenLlmNotes(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  if (breakdown.length === 0) return null;
  if (breakdown.length === 1) return breakdown[0]?.rationale || null;
  return `${breakdown.length} LLM outputs available. Click the LLM odds to inspect the full breakdown.`;
}

function buildBullpenLlmQuestionPayload(questions: BullpenQuestionRow[]) {
  return questions.map((question, index) => ({
    question_ref: getBullpenQuestionRef(index),
    question_id: question.id,
    question: question.question,
    closing_time: question.closeTime,
    category: question.category,
    outcomes: question.outcomeLabels,
    current_yes_odds: question.yesOdds,
    current_no_odds: question.noOdds,
    market_url: question.marketUrl,
    slug: question.slug,
  }));
}

export function buildBullpenLlmPrompt(
  questions: BullpenQuestionRow[],
  template = DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
) {
  const selectedQuestionsJson = JSON.stringify(
    buildBullpenLlmQuestionPayload(questions),
    null,
    2,
  );
  const normalizedTemplate = template.trim();

  if (normalizedTemplate.includes(BULLPEN_LLM_PROMPT_PLACEHOLDER)) {
    return normalizedTemplate.replace(
      BULLPEN_LLM_PROMPT_PLACEHOLDER,
      selectedQuestionsJson,
    );
  }

  return `${normalizedTemplate}\n\nSelected questions:\n${selectedQuestionsJson}`;
}
