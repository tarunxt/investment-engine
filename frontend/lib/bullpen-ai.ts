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
  rules: string | null;
  marketContext: string | null;
  resolutionSource: string | null;
};

export type BullpenLlmDisagreementLevel = "Low" | "Medium" | "High";

export type BullpenQuestionAnalysis = {
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  llmAverageYesOdds: number | null;
  llmMedianYesOdds: number | null;
  llmTrimmedMeanYesOdds: number | null;
  llmMinYesOdds: number | null;
  llmMaxYesOdds: number | null;
  llmSpreadYesOdds: number | null;
  llmDisagreementLevel: BullpenLlmDisagreementLevel | null;
  adjudicationRequired: boolean;
  evidenceStatus: string | null;
  eventState: string | null;
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
  yesDefinition: string | null;
  deadlineEt: string | null;
  hoursRemaining: number | null;
  evidenceStatus: string | null;
  eventState: string | null;
  confidence: string | null;
  keyEvidence: string[];
  redFlags: string[];
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
  yesDefinition: string | null;
  deadlineEt: string | null;
  hoursRemaining: number | null;
  evidenceStatus: string | null;
  eventState: string | null;
  confidence: string | null;
  keyEvidence: string[];
  redFlags: string[];
  rationale: string | null;
};

export type BullpenLlmConsensus = {
  consensusYesOdds: number | null;
  consensusNoOdds: number | null;
  consensusMethod: "average" | "median" | "trimmedMean" | null;
  llmAverageYesOdds: number | null;
  llmMedianYesOdds: number | null;
  llmTrimmedMeanYesOdds: number | null;
  llmMinYesOdds: number | null;
  llmMaxYesOdds: number | null;
  llmSpreadYesOdds: number | null;
  llmDisagreementLevel: BullpenLlmDisagreementLevel | null;
  adjudicationRequired: boolean;
};

export type BullpenReturnsPerDayBreakdown = {
  currentOdds: number | null;
  currentSide: "Yes" | "No" | null;
  daysUntilClose: number | null;
  llmYesOdds: number | null;
  llmNoOdds: number | null;
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

export const LEGACY_BULLPEN_LLM_PROMPT_TEMPLATES = [`[ENABLE_WEB_SEARCH]
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
${BULLPEN_LLM_PROMPT_PLACEHOLDER}`];

export const DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE = `[ENABLE_WEB_SEARCH]
You are an independent probability estimation engine for Polymarket questions.

Analyze every selected market and return one calibrated YES/NO estimate per question.

You must use the exact market_url when present, the supplied Polymarket rules, the supplied detailed Polymarket market context when present, and the current timestamps provided in the input.
Do not reason from the market title alone.
If the title, close time, and market_url rules appear inconsistent, the supplied Polymarket rules win.

Input fields may include:
question_ref, question_id, question, slug, market_url, close_time, closing_time, close_time_et, current_time_utc, current_time_et, deadline_et, hours_remaining, deadline_source, title_date_hint, title_deadline_et_assumption, category, outcomes, current_yes_odds, current_no_odds, polymarket_rules, polymarket_market_context, polymarket_resolution_source.

Each market may include:
- polymarket_rules
- polymarket_market_context
- polymarket_resolution_source

You MUST use polymarket_rules as the authoritative resolution criteria.
You MUST read and consider polymarket_market_context when present.
The Market Context may include the label "Experimental AI-generated summary referencing Polymarket data." Treat it as helpful context and evidence, not as the final resolution authority.
If polymarket_rules conflict with polymarket_market_context, polymarket_rules win.
If polymarket_rules say an announcement immediately resolves the market, then an already-confirmed announcement should be treated as criteria_likely_satisfied and already_occurred.

For each question:
1. Read and consider the exact market_url, polymarket_rules, polymarket_market_context, and polymarket_resolution_source.
2. State what YES means under those exact rules in yes_definition.
3. Use current_time_utc and current_time_et as the evaluation timestamp.
4. Determine the operative deadline in ET.
5. For "by [date]" markets, assume 11:59 PM ET on that date unless the rules explicitly say otherwise.
6. Compute hours_remaining from the operative deadline, not from vague intuition.
7. Distinguish clearly between:
   - already occurred / criteria likely satisfied
   - scheduled but not occurred
   - preparatory or indirect signals only
   - weak or rumour evidence
   - no reliable evidence
   - conflicting evidence
8. Never convert scheduled, expected, planned, rumored, or preparatory activity into "already happened".
9. Use current market odds only as a weak reference signal, not as the primary basis for the answer.
10. Set llm_no_odds = 100 - llm_yes_odds.
11. If the supplied rules plus current credible evidence show that the market has already resolved YES, return llm_yes_odds = 100.00 and llm_no_odds = 0.00.
12. If the supplied rules plus current credible evidence show that the market has already resolved NO, return llm_yes_odds = 0.00 and llm_no_odds = 100.00.
13. Do not hedge at 95 or 99 once the market's own rules are already satisfied.

Use these labels when possible:
- evidence_status: criteria_likely_satisfied | scheduled_not_occurred | preparatory_or_indirect_only | weak_or_rumour_only | no_reliable_evidence | conflicting_evidence
- event_state: already_occurred | scheduled_not_occurred | preparatory_only | rumour_only | no_confirmed_event | conflicting
- confidence: Low | Medium | High

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
- Keep rationale concise and under 320 characters.
- key_evidence should be a short array of the most decision-relevant facts.
- red_flags should be a short array of contradictions, caveats, or missing-rule issues.

JSON schema:
{
  "markets": [
    {
      "question_ref": "Q1",
      "question": "string",
      "yes_definition": "exact YES resolution meaning",
      "deadline_et": "YYYY-MM-DD hh:mm:ss AM/PM ET",
      "hours_remaining": 24.5,
      "evidence_status": "scheduled_not_occurred",
      "event_state": "scheduled_not_occurred",
      "llm_yes_odds": 50.00,
      "llm_no_odds": 50.00,
      "confidence": "Medium",
      "key_evidence": ["fact 1", "fact 2"],
      "red_flags": ["caveat 1"],
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
    excludeTweetCountQuestions: true,
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
    excludeTweetCountQuestions: true,
    onlyBinaryYesNo: true,
    minYesOdds: 5,
    minNoOdds: 5,
  },
};

const BULLPEN_ET_TIME_ZONE = "America/New_York";
const BULLPEN_MONTH_INDEX_BY_NAME: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11,
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

function roundBullpenValue(value: number | null) {
  if (value === null || !Number.isFinite(value)) return null;
  return Number(value.toFixed(2));
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

function averageBullpenValues(values: number[]) {
  if (values.length === 0) return null;
  return roundBullpenValue(
    values.reduce((total, value) => total + value, 0) / values.length,
  );
}

function medianBullpenValues(values: number[]) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const middleIndex = Math.floor(sorted.length / 2);

  if (sorted.length % 2 === 1) {
    return roundBullpenValue(sorted[middleIndex] ?? null);
  }

  return roundBullpenValue(
    ((sorted[middleIndex - 1] ?? 0) + (sorted[middleIndex] ?? 0)) / 2,
  );
}

function trimmedMeanBullpenValues(values: number[]) {
  if (values.length === 0) return null;

  const sorted = [...values].sort((left, right) => left - right);
  const trimCount =
    sorted.length >= 5 ? Math.max(1, Math.floor(sorted.length * 0.1)) : 0;
  const trimmedValues =
    trimCount > 0 && trimCount * 2 < sorted.length
      ? sorted.slice(trimCount, sorted.length - trimCount)
      : sorted;

  return averageBullpenValues(trimmedValues);
}

function calculateBullpenReturnsPerDay({
  yesOdds,
  noOdds,
  llmYesOdds,
  llmNoOdds,
  daysUntilClose,
}: Pick<
  BullpenQuestionRow,
  "yesOdds" | "noOdds" | "llmYesOdds" | "llmNoOdds" | "daysUntilClose"
>) {
  return getBullpenReturnsPerDayBreakdown({
    yesOdds,
    noOdds,
    llmYesOdds,
    llmNoOdds,
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
  llmNoOdds,
  daysUntilClose,
}: Pick<
  BullpenQuestionRow,
  "yesOdds" | "noOdds" | "llmYesOdds" | "llmNoOdds" | "daysUntilClose"
>): BullpenReturnsPerDayBreakdown {
  if (
    yesOdds === null ||
    noOdds === null ||
    llmYesOdds === null ||
    llmNoOdds === null ||
    daysUntilClose === null ||
    daysUntilClose <= 0
  ) {
    return {
      currentOdds: null,
      currentSide: null,
      daysUntilClose,
      llmYesOdds,
      llmNoOdds,
      result: null,
    };
  }

  // Match spreadsheet column O:
  // =IF(LLM No Odds > 50%, (100 - Current No Odds) / Days, (100 - Current Yes Odds) / Days)
  const currentSide = llmNoOdds > 50 ? "No" : "Yes";
  const currentOdds = currentSide === "No" ? noOdds : yesOdds;

  return {
    currentOdds,
    currentSide,
    daysUntilClose,
    llmYesOdds,
    llmNoOdds,
    result: Number(((100 - currentOdds) / daysUntilClose).toFixed(2)),
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
  > &
    Partial<
      Pick<BullpenQuestionRow, "llmDisagreementLevel" | "adjudicationRequired">
    >,
) {
  return (
    question.llmNoOdds !== null &&
    question.returnsPerDay !== null &&
    question.amountToBeInvested !== null &&
    question.llmDisagreementLevel !== "High" &&
    !question.adjudicationRequired &&
    question.llmNoOdds > 80 &&
    question.returnsPerDay > 5
  );
}

function pickBullpenConsensusLabel(
  values: Array<string | null | undefined>,
  conflictValue: string,
) {
  const normalizedValues = values.filter(
    (value): value is string => typeof value === "string" && value.trim().length > 0,
  );
  if (normalizedValues.length === 0) return null;

  const counts = new Map<string, number>();
  const firstSeenOrder = new Map<string, number>();

  normalizedValues.forEach((value, index) => {
    counts.set(value, (counts.get(value) ?? 0) + 1);
    if (!firstSeenOrder.has(value)) {
      firstSeenOrder.set(value, index);
    }
  });

  const rankedValues = [...counts.entries()].sort((left, right) => {
    if (right[1] !== left[1]) {
      return right[1] - left[1];
    }

    return (firstSeenOrder.get(left[0]) ?? 0) - (firstSeenOrder.get(right[0]) ?? 0);
  });

  if (
    rankedValues.length > 1 &&
    rankedValues[0]?.[1] === rankedValues[1]?.[1]
  ) {
    return conflictValue;
  }

  return rankedValues[0]?.[0] ?? null;
}

export function createBullpenQuestionRow(
  question: BullpenQuestion | BullpenQuestionRow,
): BullpenQuestionRow {
  const analysisFields = question as Partial<BullpenQuestionAnalysis>;
  const llmBreakdown = normalizeBullpenLlmBreakdown(
    analysisFields.llmBreakdown,
  );
  const topLevelOdds = normalizeOddsPair(
    analysisFields.llmYesOdds ?? null,
    analysisFields.llmNoOdds ?? null,
  );
  const llmConsensus = computeBullpenLlmConsensus(llmBreakdown);
  const hasConsensusOdds =
    llmConsensus.consensusYesOdds !== null || llmConsensus.consensusNoOdds !== null;
  const latestCompletedAt =
    [...llmBreakdown]
      .map((entry) => entry.timestamp)
      .filter((timestamp): timestamp is string => Boolean(timestamp))
      .sort()
      .at(-1) || null;
  const llmYesOdds = hasConsensusOdds
    ? llmConsensus.consensusYesOdds
    : topLevelOdds.yes;
  const llmNoOdds = hasConsensusOdds
    ? llmConsensus.consensusNoOdds
    : topLevelOdds.no;
  const baseRow = {
    ...question,
    rules: question.rules ?? null,
    marketContext: question.marketContext ?? null,
    resolutionSource: question.resolutionSource ?? null,
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
    llmDisagreementLevel: llmConsensus.llmDisagreementLevel,
    adjudicationRequired: llmConsensus.adjudicationRequired,
  });

  return {
    ...question,
    rules: question.rules ?? null,
    marketContext: question.marketContext ?? null,
    resolutionSource: question.resolutionSource ?? null,
    llmYesOdds,
    llmNoOdds,
    llmAverageYesOdds:
      llmConsensus.llmAverageYesOdds ?? analysisFields.llmAverageYesOdds ?? null,
    llmMedianYesOdds:
      llmConsensus.llmMedianYesOdds ?? analysisFields.llmMedianYesOdds ?? null,
    llmTrimmedMeanYesOdds:
      llmConsensus.llmTrimmedMeanYesOdds ??
      analysisFields.llmTrimmedMeanYesOdds ??
      null,
    llmMinYesOdds:
      llmConsensus.llmMinYesOdds ?? analysisFields.llmMinYesOdds ?? null,
    llmMaxYesOdds:
      llmConsensus.llmMaxYesOdds ?? analysisFields.llmMaxYesOdds ?? null,
    llmSpreadYesOdds:
      llmConsensus.llmSpreadYesOdds ?? analysisFields.llmSpreadYesOdds ?? null,
    llmDisagreementLevel:
      llmConsensus.llmDisagreementLevel ??
      analysisFields.llmDisagreementLevel ??
      null,
    adjudicationRequired:
      llmConsensus.adjudicationRequired ||
      analysisFields.adjudicationRequired ||
      false,
    evidenceStatus:
      analysisFields.evidenceStatus ??
      pickBullpenConsensusLabel(
        llmBreakdown.map((entry) => entry.evidenceStatus),
        "conflicting_evidence",
      ),
    eventState:
      analysisFields.eventState ??
      pickBullpenConsensusLabel(
        llmBreakdown.map((entry) => entry.eventState),
        "conflicting",
      ),
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

function readStringArrayValue(value: unknown) {
  if (Array.isArray(value)) {
    return value
      .map((item) => readStringValue(item))
      .filter((item): item is string => item !== null);
  }

  const directValue = readStringValue(value);
  return directValue ? [directValue] : [];
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
      const normalizedOdds = normalizeOddsPair(
        extractNumber(record.llmYesOdds ?? record.llm_yes_odds),
        extractNumber(record.llmNoOdds ?? record.llm_no_odds),
      );

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
        llmYesOdds: normalizedOdds.yes,
        llmNoOdds: normalizedOdds.no,
        yesDefinition:
          readStringValue(record.yesDefinition) ||
          readStringValue(record.yes_definition) ||
          null,
        deadlineEt:
          readStringValue(record.deadlineEt) ||
          readStringValue(record.deadline_et) ||
          null,
        hoursRemaining: roundBullpenValue(
          extractNumber(record.hoursRemaining ?? record.hours_remaining),
        ),
        evidenceStatus:
          readStringValue(record.evidenceStatus) ||
          readStringValue(record.evidence_status) ||
          null,
        eventState:
          readStringValue(record.eventState) ||
          readStringValue(record.event_state) ||
          null,
        confidence: readStringValue(record.confidence) || null,
        keyEvidence: readStringArrayValue(
          record.keyEvidence ?? record.key_evidence,
        ),
        redFlags: readStringArrayValue(record.redFlags ?? record.red_flags),
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
      const yesDefinition =
        readStringValue(record.yes_definition) ||
        readStringValue(record.yesDefinition) ||
        null;
      const deadlineEt =
        readStringValue(record.deadline_et) ||
        readStringValue(record.deadlineEt) ||
        null;
      const hoursRemaining = roundBullpenValue(
        extractNumber(record.hours_remaining ?? record.hoursRemaining),
      );
      const evidenceStatus =
        readStringValue(record.evidence_status) ||
        readStringValue(record.evidenceStatus) ||
        null;
      const eventState =
        readStringValue(record.event_state) ||
        readStringValue(record.eventState) ||
        null;
      const confidence = readStringValue(record.confidence) || null;
      const keyEvidence = readStringArrayValue(
        record.key_evidence ?? record.keyEvidence,
      );
      const redFlags = readStringArrayValue(record.red_flags ?? record.redFlags);

      const notes =
        readStringValue(record.rationale) ||
        readStringValue(record.reasoning) ||
        readStringValue(record.notes) ||
        readStringValue(record.note) ||
        readStringValue(record.explanation) ||
        readStringValue(record.summary) ||
        keyEvidence[0] ||
        null;

      return {
        questionId,
        llmYesOdds: normalizedOdds.yes,
        llmNoOdds: normalizedOdds.no,
        yesDefinition,
        deadlineEt,
        hoursRemaining,
        evidenceStatus,
        eventState,
        confidence,
        keyEvidence,
        redFlags,
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

export function computeBullpenLlmConsensus(
  breakdown: BullpenQuestionLlmBreakdownItem[],
): BullpenLlmConsensus {
  const yesValues = breakdown
    .map((entry) => entry.llmYesOdds)
    .filter((value): value is number => typeof value === "number");

  if (yesValues.length === 0) {
    return {
      consensusYesOdds: null,
      consensusNoOdds: null,
      consensusMethod: null,
      llmAverageYesOdds: null,
      llmMedianYesOdds: null,
      llmTrimmedMeanYesOdds: null,
      llmMinYesOdds: null,
      llmMaxYesOdds: null,
      llmSpreadYesOdds: null,
      llmDisagreementLevel: null,
      adjudicationRequired: false,
    };
  }

  const sortedValues = [...yesValues].sort((left, right) => left - right);
  const llmAverageYesOdds = averageBullpenValues(sortedValues);
  const llmMedianYesOdds = medianBullpenValues(sortedValues);
  const llmTrimmedMeanYesOdds = trimmedMeanBullpenValues(sortedValues);
  const llmMinYesOdds = roundBullpenValue(sortedValues[0] ?? null);
  const llmMaxYesOdds = roundBullpenValue(sortedValues.at(-1) ?? null);
  const llmSpreadYesOdds =
    llmMinYesOdds === null || llmMaxYesOdds === null
      ? null
      : roundBullpenValue(llmMaxYesOdds - llmMinYesOdds);

  let llmDisagreementLevel: BullpenLlmDisagreementLevel = "Low";
  if (llmSpreadYesOdds !== null && llmSpreadYesOdds > 30) {
    llmDisagreementLevel = "High";
  } else if (llmSpreadYesOdds !== null && llmSpreadYesOdds > 15) {
    llmDisagreementLevel = "Medium";
  }

  const adjudicationRequired = llmSpreadYesOdds !== null && llmSpreadYesOdds > 30;
  const consensusMethod =
    llmDisagreementLevel === "High" ? "median" : "average";
  const consensusYesOdds =
    consensusMethod === "median" ? llmMedianYesOdds : llmAverageYesOdds;
  const normalizedConsensus = normalizeOddsPair(
    consensusYesOdds,
    consensusYesOdds === null ? null : 100 - consensusYesOdds,
  );

  return {
    consensusYesOdds: normalizedConsensus.yes,
    consensusNoOdds: normalizedConsensus.no,
    consensusMethod,
    llmAverageYesOdds,
    llmMedianYesOdds,
    llmTrimmedMeanYesOdds,
    llmMinYesOdds,
    llmMaxYesOdds,
    llmSpreadYesOdds,
    llmDisagreementLevel,
    adjudicationRequired,
  };
}

export function averageBullpenLlmOdds(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  const consensus = computeBullpenLlmConsensus(breakdown);
  return normalizeOddsPair(
    consensus.llmAverageYesOdds,
    consensus.llmAverageYesOdds === null ? null : 100 - consensus.llmAverageYesOdds,
  );
}

export function summarizeBullpenLlmNotes(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  if (breakdown.length === 0) return null;
  if (breakdown.length === 1) return breakdown[0]?.rationale || null;
  const consensus = computeBullpenLlmConsensus(breakdown);
  const disagreementNote =
    consensus.adjudicationRequired && consensus.llmSpreadYesOdds !== null
      ? ` High disagreement detected (${consensus.llmSpreadYesOdds.toFixed(2)}-point spread).`
      : "";
  return `${breakdown.length} LLM outputs available.${disagreementNote} Click the LLM odds to inspect the full breakdown.`;
}

function formatBullpenDateTimeInTimeZone(date: Date, timeZone: string) {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
      hour12: true,
    })
      .formatToParts(date)
      .filter((part) => part.type !== "literal")
      .map((part) => [part.type, part.value]),
  );

  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}:${parts.second} ${parts.dayPeriod} ${timeZone === BULLPEN_ET_TIME_ZONE ? "ET" : "UTC"}`;
}

function getTimeZoneOffsetMinutes(date: Date, timeZone: string) {
  const timeZoneName =
    new Intl.DateTimeFormat("en-US", {
      timeZone,
      timeZoneName: "shortOffset",
    })
      .formatToParts(date)
      .find((part) => part.type === "timeZoneName")?.value || "GMT";
  const matchedOffset = timeZoneName.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/i);
  if (!matchedOffset) return 0;

  const [, sign, hoursText, minutesText] = matchedOffset;
  const hours = Number(hoursText);
  const minutes = Number(minutesText || "0");
  const totalMinutes = hours * 60 + minutes;

  return sign === "-" ? totalMinutes * -1 : totalMinutes;
}

function createBullpenEasternDate(
  year: number,
  monthIndex: number,
  day: number,
  hour = 23,
  minute = 59,
  second = 0,
) {
  const referenceDate = new Date(Date.UTC(year, monthIndex, day, 16, 0, 0));
  const offsetMinutes = getTimeZoneOffsetMinutes(
    referenceDate,
    BULLPEN_ET_TIME_ZONE,
  );

  return new Date(
    Date.UTC(year, monthIndex, day, hour, minute, second) -
      offsetMinutes * 60 * 1000,
  );
}

function extractBullpenMentionedDateParts(question: string) {
  const match = question.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i,
  );
  if (!match) return null;

  const monthIndex = BULLPEN_MONTH_INDEX_BY_NAME[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = match[3]
    ? Number(match[3])
    : new Date().getUTCFullYear();

  if (
    monthIndex === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year)
  ) {
    return null;
  }

  return {
    year,
    monthIndex,
    day,
    label: `${year.toString().padStart(4, "0")}-${(monthIndex + 1)
      .toString()
      .padStart(2, "0")}-${day.toString().padStart(2, "0")}`,
  };
}

function buildBullpenDeadlineInfo(question: BullpenQuestionRow, now: Date) {
  const closeDate =
    question.closeTime && !Number.isNaN(new Date(question.closeTime).getTime())
      ? new Date(question.closeTime)
      : null;
  const closeTimeEt = closeDate
    ? formatBullpenDateTimeInTimeZone(closeDate, BULLPEN_ET_TIME_ZONE)
    : null;
  const titleDateParts = extractBullpenMentionedDateParts(question.question);
  const isByDateMarket =
    /\bby\s+(January|February|March|April|May|June|July|August|September|October|November|December)\s+\d{1,2}(?:,\s*\d{4})?\b/i.test(
      question.question,
    );
  const titleDeadlineDate =
    titleDateParts && isByDateMarket
      ? createBullpenEasternDate(
          titleDateParts.year,
          titleDateParts.monthIndex,
          titleDateParts.day,
          23,
          59,
          0,
        )
      : null;
  const deadlineDate = titleDeadlineDate || closeDate;
  const deadlineEt = deadlineDate
    ? formatBullpenDateTimeInTimeZone(deadlineDate, BULLPEN_ET_TIME_ZONE)
    : null;
  const hoursRemaining =
    deadlineDate === null
      ? null
      : roundBullpenValue(
          (deadlineDate.getTime() - now.getTime()) / (60 * 60 * 1000),
        );

  return {
    closeTimeEt,
    deadlineEt,
    hoursRemaining,
    deadlineSource: titleDeadlineDate
      ? "question_title_by_date_assumption"
      : closeDate
        ? "close_time"
        : null,
    titleDateHint: titleDateParts?.label ?? null,
    titleDeadlineEtAssumption: titleDeadlineDate
      ? formatBullpenDateTimeInTimeZone(
          titleDeadlineDate,
          BULLPEN_ET_TIME_ZONE,
        )
      : null,
  };
}

function buildBullpenLlmQuestionPayload(questions: BullpenQuestionRow[]) {
  const now = new Date();
  const currentTimeUtc = now.toISOString();
  const currentTimeEt = formatBullpenDateTimeInTimeZone(
    now,
    BULLPEN_ET_TIME_ZONE,
  );

  return questions.map((question, index) => {
    const deadlineInfo = buildBullpenDeadlineInfo(question, now);

    return {
      question_ref: getBullpenQuestionRef(index),
      question_id: question.id,
      question: question.question,
      close_time: question.closeTime,
      closing_time: question.closeTime,
      close_time_et: deadlineInfo.closeTimeEt,
      current_time_utc: currentTimeUtc,
      current_time_et: currentTimeEt,
      deadline_et: deadlineInfo.deadlineEt,
      hours_remaining: deadlineInfo.hoursRemaining,
      deadline_source: deadlineInfo.deadlineSource,
      title_date_hint: deadlineInfo.titleDateHint,
      title_deadline_et_assumption: deadlineInfo.titleDeadlineEtAssumption,
      category: question.category,
      outcomes: question.outcomeLabels,
      current_yes_odds: question.yesOdds,
      current_no_odds: question.noOdds,
      market_url: question.marketUrl,
      slug: question.slug,
      polymarket_rules: question.rules,
      polymarket_market_context: question.marketContext,
      polymarket_resolution_source: question.resolutionSource,
    };
  });
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
