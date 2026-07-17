import type {
  PolymarketEventQuestionPayload,
  PolymarketEventQuestionRuntimeMetadata,
  PolymarketEventRuntimeMetadata,
} from "@/types/api";
import {
  DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS,
  hasBullpenQualifiedLlmSide,
} from "@/lib/bullpenStage2To3Strategy";

export type ScanMode = "30-days" | "end-of-month";

export type BullpenQuestion = {
  id: string;
  question: string;
  positionKey?: string | null;
  conditionId?: string | null;
  marketId?: string | null;
  questionId?: string | null;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  currentOddsUpdatedAt?: string | null;
  investmentTableAddedAt?: string | null;
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
export type BullpenLlmDirection = "YES_CAMP" | "NO_CAMP" | "UNCERTAIN";
export type BullpenLlmDisagreementCategory =
  | "CONSENSUS"
  | "MOSTLY_CONSENSUS_SOME_UNCERTAINTY"
  | "CONSENSUS_WITH_OUTLIER"
  | "HIGH_DISAGREEMENT";
export type BullpenLlmReviewTone = "high" | "medium" | "lowEvidence";

export type BullpenQuestionAnalysis = {
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  llmAverageYesOdds: number | null;
  llmMedianYesOdds: number | null;
  llmTrimmedMeanYesOdds: number | null;
  llmIqrYesOdds: number | null;
  llmTrimmedRangeYesOdds: number | null;
  llmMinYesOdds: number | null;
  llmMaxYesOdds: number | null;
  llmSpreadYesOdds: number | null;
  llmDisagreementLevel: BullpenLlmDisagreementLevel | null;
  llmDisagreementCategory: BullpenLlmDisagreementCategory | null;
  llmRationaleMismatchCount: number;
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
  llmRunId: string | number | null;
  llmCompletedAt: string | null;
  preflightEvidenceBlock?: string | null;
  llmBreakdown: BullpenQuestionLlmBreakdownItem[];
};

export type BullpenQuestionRow = BullpenQuestion & BullpenQuestionAnalysis;

export function hasBullpenLlmAnalysis(
  question:
    | Pick<
        Partial<BullpenQuestionAnalysis>,
        "llmYesOdds" | "llmNoOdds" | "llmRunId" | "llmCompletedAt" | "llmBreakdown"
      >
    | null
    | undefined,
) {
  if (!question) return false;

  const hasYesOdds =
    question.llmYesOdds !== null && question.llmYesOdds !== undefined;
  const hasNoOdds =
    question.llmNoOdds !== null && question.llmNoOdds !== undefined;
  const hasRunId =
    question.llmRunId !== null && question.llmRunId !== undefined;

  return (
    hasYesOdds ||
    hasNoOdds ||
    hasRunId ||
    Boolean(question.llmCompletedAt) ||
    Boolean(question.llmBreakdown?.length)
  );
}

export type BullpenScanFilters = {
  maxClosingDays: number;
  targetDate: string;
  excludeSports: boolean;
  excludeWeather: boolean;
  excludeMarketPredictions: boolean;
  excludeTweetCountQuestions: boolean;
  customExcludeSportsKeywords: string[];
  customExcludeWeatherKeywords: string[];
  customExcludeMarketPredictionsKeywords: string[];
  customExcludeTweetCountQuestionsKeywords: string[];
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
  requestedModel?: string | null;
  actualModel?: string | null;
  status?: string | null;
  providerError?: string | null;
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
  direction?: BullpenLlmDirection | null;
  rationaleOddsMismatch?: boolean;
  rationaleOddsMismatchReason?: string | null;
  effectiveWeight?: number | null;
  webSearchUsed: boolean | null;
  webSearchQueries: string[];
  webSources: string[];
  internetVerified: boolean | null;
  evidenceBlockUsed: boolean;
  staleFactDetected: boolean;
  invalidReason: string | null;
  invalidStaleFact: boolean;
  staleFactReason: string | null;
};

type BullpenLlmPromptQuestionPayload = {
  event_id: string;
  question_ref: string;
  question_id: string;
  market_id: string | null;
  question: string;
  stage2_context: Record<string, unknown>;
  preflight_evidence_block: string | null;
};

type BullpenLegacyPreflightPayload = {
  question_ref: string;
  question_id: string;
  market_id: string | null;
  question: string;
  close_time: string | null;
  closing_time: string | null;
  close_time_et: string | null;
  current_time_utc: string;
  current_time_et: string;
  deadline_et: string | null;
  hours_remaining: number | null;
  deadline_source: string | null;
  title_date_hint: string | null;
  title_deadline_et_assumption: string | null;
  category: string;
  outcomes: string[];
  current_yes_odds: number | null;
  current_no_odds: number | null;
  market_url: string | null;
  slug: string | null;
  polymarket_rules: string | null;
  polymarket_market_context: string | null;
  polymarket_resolution_source: string | null;
};

export type BullpenLlmPromptInputs = {
  questionPayload: PolymarketEventQuestionPayload[];
  promptPayload: BullpenLlmPromptQuestionPayload[];
  preflightEvidenceBlocksByQuestionId: Record<string, string>;
};

export type BullpenLlmConsensus = {
  consensusYesOdds: number | null;
  consensusNoOdds: number | null;
  consensusMethod: "average" | "median" | "trimmedMean" | null;
  llmAverageYesOdds: number | null;
  llmMedianYesOdds: number | null;
  llmTrimmedMeanYesOdds: number | null;
  llmIqrYesOdds: number | null;
  llmTrimmedRangeYesOdds: number | null;
  llmMinYesOdds: number | null;
  llmMaxYesOdds: number | null;
  llmSpreadYesOdds: number | null;
  llmDisagreementLevel: BullpenLlmDisagreementLevel | null;
  llmDisagreementCategory: BullpenLlmDisagreementCategory | null;
  llmRationaleMismatchCount: number;
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
  llmYesOdds: number | null;
  llmNoOdds: number | null;
  strongestLlmOdds: number | null;
  returnsPerDay: number | null;
  minStrongestLlmOdds: number;
  fixedAmountUsd: number;
  qualifies: boolean;
  result: number | null;
};

export const END_OF_MONTH_DATE = "2026-06-30";
export const BULLPEN_FIXED_INVEST_AMOUNT_USD = 5;

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

export const DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE = `[STAGE2_SHARED_EVIDENCE_ONLY]
You are estimating Polymarket YES/NO probabilities from a single shared evidence packet.

Each input row contains an event_id and a canonical stage2_context. Use only that structured context.
Do not browse. Do not add outside evidence. Treat Polymarket AI-generated market context as background only.
Use the exact resolution rules, the deterministic deadline fields, and the structured evidence packet as the source of truth.
Current market odds are a weak prior, not independent evidence.

Output requirements:
- Return strict JSON only.
- Return one row per expected event_id.
- Use event_id as the primary key.
- Do not skip events.
- Do not invent evidence or probabilities.
- Preserve valid 0/100 outcomes when the rules and evidence already settle the market.
- If only one side is known, return the complement for the other side.

Schema:
{
  "markets": [
    {
      "event_id": "stable-event-id",
      "question_id": "question-id",
      "market_id": "market-id",
      "yes_definition": "exact YES resolution meaning",
      "deadline_utc": "2026-07-14T12:00:00+00:00",
      "resolution_timezone": "Asia/Riyadh",
      "hours_remaining": 4.25,
      "evidence_status": "insufficient|weak|moderate|strong|criteria_satisfied",
      "event_state": "already_occurred|not_confirmed|scheduled|preparatory|conflicting|unknown",
      "llm_yes_odds": 42.25,
      "llm_no_odds": 57.75,
      "confidence": "Low|Medium|High",
      "key_evidence_source_ids": ["S1", "S3"],
      "red_flags": ["short caveat"],
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
    customExcludeSportsKeywords: [],
    customExcludeWeatherKeywords: [],
    customExcludeMarketPredictionsKeywords: [],
    customExcludeTweetCountQuestionsKeywords: [],
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
    customExcludeSportsKeywords: [],
    customExcludeWeatherKeywords: [],
    customExcludeMarketPredictionsKeywords: [],
    customExcludeTweetCountQuestionsKeywords: [],
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

function parseKeywordListSearchParam(value: string | null) {
  if (!value) return [];
  const seen = new Set<string>();
  return value
    .split(",")
    .map((keyword) => keyword.trim().toLowerCase())
    .filter((keyword) => {
      if (!keyword || seen.has(keyword)) return false;
      seen.add(keyword);
      return true;
    });
}

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
    customExcludeSportsKeywords: parseKeywordListSearchParam(
      searchParams.get("customExcludeSportsKeywords"),
    ),
    customExcludeWeatherKeywords: parseKeywordListSearchParam(
      searchParams.get("customExcludeWeatherKeywords"),
    ),
    customExcludeMarketPredictionsKeywords: parseKeywordListSearchParam(
      searchParams.get("customExcludeMarketPredictionsKeywords"),
    ),
    customExcludeTweetCountQuestionsKeywords: parseKeywordListSearchParam(
      searchParams.get("customExcludeTweetCountQuestionsKeywords"),
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
  params.set(
    "customExcludeSportsKeywords",
    filters.customExcludeSportsKeywords.join(","),
  );
  params.set(
    "customExcludeWeatherKeywords",
    filters.customExcludeWeatherKeywords.join(","),
  );
  params.set(
    "customExcludeMarketPredictionsKeywords",
    filters.customExcludeMarketPredictionsKeywords.join(","),
  );
  params.set(
    "customExcludeTweetCountQuestionsKeywords",
    filters.customExcludeTweetCountQuestionsKeywords.join(","),
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

export function normalizeBullpenOddsPair(
  yesValue: number | null,
  noValue: number | null,
) {
  return normalizeOddsPair(yesValue, noValue);
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

const BULLPEN_YES_CAMP_THRESHOLD = 60;
const BULLPEN_NO_CAMP_THRESHOLD = 40;
const BULLPEN_HIGH_RAW_SPREAD_THRESHOLD = 30;
const BULLPEN_PROVIDER_SHARE_THRESHOLD = 0.25;
const BULLPEN_OUTLIER_DISTANCE_THRESHOLD = 20;
const BULLPEN_RATIONALE_MISMATCH_WEIGHT = 0.35;
const BULLPEN_NEGATIVE_RATIONALE_PATTERNS = [
  /\bno credible evidence\b/i,
  /\bno confirmed (?:event|announcement|launch|deal|filing|approval|evidence)\b/i,
  /\bnot confirmed\b/i,
  /\bevent not confirmed\b/i,
  /\bno official (?:announcement|confirmation|filing)\b/i,
  /\bunlikely\b/i,
  /\bunconfirmed\b/i,
  /\brumou?r(?:ed|s)?\b/i,
  /\bspeculative\b/i,
] as const;

type BullpenComputedLlmEntry = {
  provider: string;
  model: string;
  yesOdds: number;
  direction: BullpenLlmDirection;
  effectiveWeight: number;
  rationaleOddsMismatch: boolean;
  rationaleOddsMismatchReason: string | null;
};

type BullpenProviderSignal = {
  provider: string;
  medianYesOdds: number;
  direction: BullpenLlmDirection;
  effectiveWeight: number;
  modelCount: number;
  rationaleMismatchCount: number;
};

function getBullpenTrimmedValues(values: number[]) {
  if (values.length === 0) return [] as number[];

  const sorted = [...values].sort((left, right) => left - right);
  const trimCount =
    sorted.length >= 5 ? Math.max(1, Math.floor(sorted.length * 0.1)) : 0;

  if (trimCount === 0 || trimCount * 2 >= sorted.length) {
    return sorted;
  }

  return sorted.slice(trimCount, sorted.length - trimCount);
}

function quantileBullpenValues(values: number[], quantile: number) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  const clampedQuantile = Math.min(1, Math.max(0, quantile));
  const position = (sorted.length - 1) * clampedQuantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lowerValue = sorted[lowerIndex] ?? sorted[0] ?? 0;
  const upperValue = sorted[upperIndex] ?? sorted.at(-1) ?? lowerValue;

  if (lowerIndex === upperIndex) {
    return roundBullpenValue(lowerValue);
  }

  return roundBullpenValue(
    lowerValue + (upperValue - lowerValue) * (position - lowerIndex),
  );
}

function iqrBullpenValues(values: number[]) {
  if (values.length < 2) return 0;
  const q1 = quantileBullpenValues(values, 0.25);
  const q3 = quantileBullpenValues(values, 0.75);
  if (q1 === null || q3 === null) return 0;
  return roundBullpenValue(q3 - q1) ?? 0;
}

function trimmedRangeBullpenValues(values: number[]) {
  const trimmedValues = getBullpenTrimmedValues(values);
  if (trimmedValues.length === 0) return null;
  const minValue = trimmedValues[0] ?? null;
  const maxValue = trimmedValues.at(-1) ?? null;
  if (minValue === null || maxValue === null) return null;
  return roundBullpenValue(maxValue - minValue);
}

export function classifyBullpenLlmDirection(
  yesOdds: number | null,
): BullpenLlmDirection | null {
  if (yesOdds === null) return null;
  if (yesOdds >= BULLPEN_YES_CAMP_THRESHOLD) return "YES_CAMP";
  if (yesOdds <= BULLPEN_NO_CAMP_THRESHOLD) return "NO_CAMP";
  return "UNCERTAIN";
}

function detectBullpenRationaleOddsMismatch(
  rationale: string | null | undefined,
  yesOdds: number | null,
) {
  const rationaleText = readStringValue(rationale);
  if (!rationaleText || yesOdds === null) {
    return {
      rationaleOddsMismatch: false,
      rationaleOddsMismatchReason: null,
      effectiveWeight: 1,
    };
  }

  const hasNegativeSignal = BULLPEN_NEGATIVE_RATIONALE_PATTERNS.some((pattern) =>
    pattern.test(rationaleText),
  );
  const rationaleOddsMismatch = hasNegativeSignal && yesOdds >= 45;

  return {
    rationaleOddsMismatch,
    rationaleOddsMismatchReason: rationaleOddsMismatch
      ? "Rationale leans against a confirmed Yes case, but the quoted odds stayed near 50/50 or Yes-favoring."
      : null,
    effectiveWeight: rationaleOddsMismatch ? BULLPEN_RATIONALE_MISMATCH_WEIGHT : 1,
  };
}

function computeBullpenLlmEntries(
  breakdown: BullpenQuestionLlmBreakdownItem[],
) {
  return breakdown
    .filter((entry) => !isBullpenBreakdownEntryInvalid(entry))
    .map((entry): BullpenComputedLlmEntry | null => {
      const yesOdds =
        typeof entry.llmYesOdds === "number" && Number.isFinite(entry.llmYesOdds)
          ? entry.llmYesOdds
          : null;
      if (yesOdds === null) return null;

      const mismatch = detectBullpenRationaleOddsMismatch(
        entry.rationale,
        yesOdds,
      );
      const direction =
        entry.direction ?? classifyBullpenLlmDirection(yesOdds) ?? "UNCERTAIN";
      const effectiveWeight =
        typeof entry.effectiveWeight === "number" &&
        Number.isFinite(entry.effectiveWeight)
          ? entry.effectiveWeight
          : mismatch.effectiveWeight;

      return {
        provider: entry.provider,
        model: entry.model,
        yesOdds,
        direction,
        effectiveWeight,
        rationaleOddsMismatch:
          entry.rationaleOddsMismatch ?? mismatch.rationaleOddsMismatch,
        rationaleOddsMismatchReason:
          entry.rationaleOddsMismatchReason ??
          mismatch.rationaleOddsMismatchReason,
      };
    })
    .filter((entry): entry is BullpenComputedLlmEntry => entry !== null);
}

function buildBullpenProviderSignals(entries: BullpenComputedLlmEntry[]) {
  const providers = new Map<
    string,
    { yesValues: number[]; weights: number[]; rationaleMismatchCount: number }
  >();

  entries.forEach((entry) => {
    const existing =
      providers.get(entry.provider) || {
        yesValues: [],
        weights: [],
        rationaleMismatchCount: 0,
      };
    existing.yesValues.push(entry.yesOdds);
    existing.weights.push(entry.effectiveWeight);
    if (entry.rationaleOddsMismatch) {
      existing.rationaleMismatchCount += 1;
    }
    providers.set(entry.provider, existing);
  });

  return [...providers.entries()]
    .map(([provider, value]): BullpenProviderSignal | null => {
      const medianYesOdds = medianBullpenValues(value.yesValues);
      if (medianYesOdds === null) return null;
      return {
        provider,
        medianYesOdds,
        direction: classifyBullpenLlmDirection(medianYesOdds) ?? "UNCERTAIN",
        effectiveWeight:
          roundBullpenValue(averageBullpenValues(value.weights)) ?? 1,
        modelCount: value.yesValues.length,
        rationaleMismatchCount: value.rationaleMismatchCount,
      };
    })
    .filter((provider): provider is BullpenProviderSignal => provider !== null);
}

function summarizeBullpenDirectionSupport<
  T extends { direction: BullpenLlmDirection; effectiveWeight: number },
>(items: T[]) {
  const counts = {
    YES_CAMP: 0,
    NO_CAMP: 0,
    UNCERTAIN: 0,
  } satisfies Record<BullpenLlmDirection, number>;
  const weights = {
    YES_CAMP: 0,
    NO_CAMP: 0,
    UNCERTAIN: 0,
  } satisfies Record<BullpenLlmDirection, number>;

  items.forEach((item) => {
    counts[item.direction] += 1;
    weights[item.direction] += item.effectiveWeight;
  });

  const totalWeight = Object.values(weights).reduce(
    (total, value) => total + value,
    0,
  );
  const shares = {
    YES_CAMP:
      totalWeight > 0 ? roundBullpenValue(weights.YES_CAMP / totalWeight) ?? 0 : 0,
    NO_CAMP:
      totalWeight > 0 ? roundBullpenValue(weights.NO_CAMP / totalWeight) ?? 0 : 0,
    UNCERTAIN:
      totalWeight > 0 ? roundBullpenValue(weights.UNCERTAIN / totalWeight) ?? 0 : 0,
  } satisfies Record<BullpenLlmDirection, number>;

  return {
    counts,
    shares,
  };
}

function countBullpenOutlierModels(
  entries: BullpenComputedLlmEntry[],
  medianYesOdds: number | null,
  iqrYesOdds: number | null,
) {
  if (medianYesOdds === null) return 0;
  const distanceThreshold = Math.max(
    BULLPEN_OUTLIER_DISTANCE_THRESHOLD,
    (iqrYesOdds ?? 0) * 1.5,
  );

  return entries.filter(
    (entry) => Math.abs(entry.yesOdds - medianYesOdds) >= distanceThreshold,
  ).length;
}

export function getBullpenLlmDisagreementCategoryLabel(
  category: BullpenLlmDisagreementCategory | null | undefined,
) {
  switch (category) {
    case "HIGH_DISAGREEMENT":
      return "High LLM disagreement";
    case "CONSENSUS_WITH_OUTLIER":
      return "Consensus with outlier";
    case "MOSTLY_CONSENSUS_SOME_UNCERTAINTY":
      return "Mostly consensus, some uncertainty";
    case "CONSENSUS":
      return "Consensus";
    default:
      return null;
  }
}

export function isBullpenHighLlmDisagreement(
  question: Pick<
    BullpenQuestionAnalysis,
    "llmDisagreementCategory" | "llmDisagreementLevel" | "adjudicationRequired"
  >,
) {
  return (
    question.llmDisagreementCategory === "HIGH_DISAGREEMENT" ||
    question.llmDisagreementLevel === "High" ||
    question.adjudicationRequired
  );
}

export function getBullpenLlmReviewState(
  question: Pick<
    BullpenQuestionAnalysis,
    | "llmDisagreementCategory"
    | "llmDisagreementLevel"
    | "adjudicationRequired"
    | "evidenceStatus"
  >,
): { label: string; tone: BullpenLlmReviewTone } | null {
  if (isBullpenHighLlmDisagreement(question)) {
    return {
      label: "High LLM disagreement",
      tone: "high",
    };
  }

  const categoryLabel = getBullpenLlmDisagreementCategoryLabel(
    question.llmDisagreementCategory,
  );
  if (
    categoryLabel &&
    question.llmDisagreementCategory !== "CONSENSUS" &&
    question.llmDisagreementLevel !== "Low"
  ) {
    return {
      label: categoryLabel,
      tone: "medium",
    };
  }

  if (question.evidenceStatus === "Low" || question.adjudicationRequired) {
    return {
      label: "Low evidence / adjudication needed",
      tone: "lowEvidence",
    };
  }

  return null;
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
  llmYesOdds,
  llmNoOdds,
  returnsPerDay,
}: Pick<BullpenQuestionRow, "llmYesOdds" | "llmNoOdds" | "returnsPerDay">) {
  return getBullpenAmountToBeInvestedBreakdown({
    llmYesOdds,
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
  llmYesOdds,
  llmNoOdds,
  returnsPerDay,
}: Pick<
  BullpenQuestionRow,
  "llmYesOdds" | "llmNoOdds" | "returnsPerDay"
>): BullpenAmountToBeInvestedBreakdown {
  const minStrongestLlmOdds =
    DEFAULT_BULLPEN_STAGE2_TO_STAGE3_MIN_LLM_SIDE_ODDS;
  const strongestLlmOdds = Math.max(llmYesOdds ?? -Infinity, llmNoOdds ?? -Infinity);
  const normalizedStrongestLlmOdds = Number.isFinite(strongestLlmOdds)
    ? strongestLlmOdds
    : null;
  const qualifies =
    returnsPerDay !== null &&
    normalizedStrongestLlmOdds !== null &&
    normalizedStrongestLlmOdds >= minStrongestLlmOdds;

  return {
    llmYesOdds,
    llmNoOdds,
    strongestLlmOdds: normalizedStrongestLlmOdds,
    returnsPerDay,
    minStrongestLlmOdds,
    fixedAmountUsd: BULLPEN_FIXED_INVEST_AMOUNT_USD,
    qualifies,
    result: qualifies ? BULLPEN_FIXED_INVEST_AMOUNT_USD : null,
  };
}

export function isBullpenQuestionInvestmentCandidate(
  question: Pick<
    BullpenQuestionRow,
    "llmYesOdds" | "llmNoOdds" | "returnsPerDay" | "amountToBeInvested"
  >,
) {
  return (
    question.returnsPerDay !== null &&
    hasBullpenStrongLlmOdds(question)
  );
}

export function hasBullpenStrongLlmOdds(
  question:
    | Pick<BullpenQuestionRow, "llmYesOdds" | "llmNoOdds">
    | null
    | undefined,
) {
  return hasBullpenQualifiedLlmSide(question);
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
  const validLlmBreakdown = llmBreakdown.filter(
    (entry) => !isBullpenBreakdownEntryInvalid(entry),
  );
  const hasBreakdownConsensus = validLlmBreakdown.length > 0;
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
    currentOddsUpdatedAt:
      (question as Partial<BullpenQuestion>).currentOddsUpdatedAt ?? null,
    investmentTableAddedAt:
      (question as Partial<BullpenQuestion>).investmentTableAddedAt ?? null,
    llmYesOdds,
    llmNoOdds,
  } as BullpenQuestionRow;
  const currentVsLlmOddsDifference =
    calculateCurrentVsLlmOddsDifference(baseRow);
  const returnsPerDay = calculateBullpenReturnsPerDay(baseRow);
  const amountToBeInvested = calculateBullpenAmountToBeInvested({
    llmYesOdds,
    llmNoOdds,
    returnsPerDay,
  });
  const isAmountToBeInvestedHighlighted = isBullpenQuestionInvestmentCandidate({
    llmYesOdds,
    llmNoOdds,
    returnsPerDay,
    amountToBeInvested,
  });

  return {
    ...question,
    rules: question.rules ?? null,
    marketContext: question.marketContext ?? null,
    resolutionSource: question.resolutionSource ?? null,
    currentOddsUpdatedAt:
      (question as Partial<BullpenQuestion>).currentOddsUpdatedAt ?? null,
    investmentTableAddedAt:
      (question as Partial<BullpenQuestion>).investmentTableAddedAt ?? null,
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
    llmIqrYesOdds:
      llmConsensus.llmIqrYesOdds ?? analysisFields.llmIqrYesOdds ?? null,
    llmTrimmedRangeYesOdds:
      llmConsensus.llmTrimmedRangeYesOdds ??
      analysisFields.llmTrimmedRangeYesOdds ??
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
    llmDisagreementCategory:
      llmConsensus.llmDisagreementCategory ??
      analysisFields.llmDisagreementCategory ??
      null,
    llmRationaleMismatchCount:
      llmConsensus.llmRationaleMismatchCount ??
      analysisFields.llmRationaleMismatchCount ??
      0,
    adjudicationRequired:
      hasBreakdownConsensus
        ? llmConsensus.adjudicationRequired
        : analysisFields.adjudicationRequired || false,
    evidenceStatus:
      analysisFields.evidenceStatus ??
      pickBullpenConsensusLabel(
        validLlmBreakdown.map((entry) => entry.evidenceStatus),
        "conflicting_evidence",
      ),
    eventState:
      analysisFields.eventState ??
      pickBullpenConsensusLabel(
        validLlmBreakdown.map((entry) => entry.eventState),
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
    preflightEvidenceBlock: analysisFields.preflightEvidenceBlock ?? null,
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
    questions: result.questions.map((question) =>
      createBullpenQuestionRow({
        ...question,
        currentOddsUpdatedAt: question.currentOddsUpdatedAt ?? result.scannedAt,
        investmentTableAddedAt: question.investmentTableAddedAt ?? result.scannedAt,
      }),
    ),
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

function readBooleanValue(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (normalized === "true") return true;
    if (normalized === "false") return false;
  }
  return null;
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

function isBullpenBreakdownEntryInvalid(
  entry: Pick<BullpenQuestionLlmBreakdownItem, "invalidReason" | "invalidStaleFact">,
) {
  return Boolean(entry.invalidReason) || entry.invalidStaleFact;
}

function normalizePolymarketQuestionRuntimeMetadata(
  value: unknown,
): PolymarketEventQuestionRuntimeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  return {
    question_ref: readStringValue(record.question_ref) || null,
    question_id: readStringValue(record.question_id) || null,
    question: readStringValue(record.question) || null,
    web_search_used: readBooleanValue(record.web_search_used),
    web_search_queries: readStringArrayValue(record.web_search_queries),
    web_sources: readStringArrayValue(record.web_sources),
    evidence_block_used: readBooleanValue(record.evidence_block_used),
    internet_verified: readBooleanValue(record.internet_verified),
    stale_fact_detected: readBooleanValue(record.stale_fact_detected),
    invalid_reason: readStringValue(record.invalid_reason) || null,
    preflight_evidence_block:
      readStringValue(record.preflight_evidence_block) || null,
  };
}

export function normalizePolymarketEventRuntimeMetadata(
  value: unknown,
): PolymarketEventRuntimeMetadata | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const questionRuntimeRecord =
    record.question_runtime &&
    typeof record.question_runtime === "object" &&
    !Array.isArray(record.question_runtime)
      ? (record.question_runtime as Record<string, unknown>)
      : null;

  return {
    kind: readStringValue(record.kind) || null,
    require_fresh_internet_evidence: readBooleanValue(
      record.require_fresh_internet_evidence,
    ),
    allow_evidence_grounded_non_web_models: readBooleanValue(
      record.allow_evidence_grounded_non_web_models,
    ),
    web_search_used: readBooleanValue(record.web_search_used),
    web_search_queries: readStringArrayValue(record.web_search_queries),
    web_sources: readStringArrayValue(record.web_sources),
    evidence_block_used: readBooleanValue(record.evidence_block_used),
    internet_verified: readBooleanValue(record.internet_verified),
    stale_fact_detected: readBooleanValue(record.stale_fact_detected),
    invalid_reason: readStringValue(record.invalid_reason) || null,
    model_side_search_used: readBooleanValue(record.model_side_search_used),
    question_runtime: questionRuntimeRecord
      ? Object.fromEntries(
          Object.entries(questionRuntimeRecord)
            .map(([questionId, runtimeValue]) => [
              questionId,
              normalizePolymarketQuestionRuntimeMetadata(runtimeValue),
            ])
            .filter(
              (
                entry,
              ): entry is [string, PolymarketEventQuestionRuntimeMetadata] =>
                entry[1] !== null,
            ),
        )
      : null,
    warnings: readStringArrayValue(record.warnings),
  };
}

export function getBullpenQuestionRuntimeMetadata(
  runtimeMetadata: unknown,
  questionId: string,
) {
  return (
    normalizePolymarketEventRuntimeMetadata(runtimeMetadata)?.question_runtime?.[
      questionId
    ] || null
  );
}

function extractBullpenPreflightFactMap(
  preflightEvidenceBlock: string | null | undefined,
) {
  const block = readStringValue(preflightEvidenceBlock);
  if (!block) return {} as Record<string, string>;

  const factsSection = block
    .split(/Verified current facts:\s*/i)[1]
    ?.split(/\n\s*(?:Latest search results|Instruction):\s*/i)[0];
  if (!factsSection) return {} as Record<string, string>;

  const factMap: Record<string, string> = {};
  factsSection.split("\n").forEach((line) => {
    const match = line.trim().match(/^- ([^:]+):\s*(.+)$/);
    if (!match) return;
    const key = normalizeQuestionLookupValue(match[1] || "");
    const value = (match[2] || "").trim();
    if (!key || !value || value === "Not supplied" || value === "Unknown") {
      return;
    }
    factMap[key] = value;
  });

  return factMap;
}

const BULLPEN_STALE_FACT_RULES = [
  {
    id: "public_listing_already_confirmed",
    factPattern:
      /\b(went public|has gone public|is publicly traded|started trading|began trading|listed on|trades on (nasdaq|nyse|amex|tsx|lse|euronext|otc)|public ticker)\b/i,
    contradictionPattern:
      /\b(has not gone public|hasn't gone public|no ipo yet|still private|is still private|remains private|not publicly traded|no public ticker)\b/i,
    reason:
      "Rationale contradicted authoritative preflight facts that already confirmed the company is public.",
  },
] as const;

export function validateBullpenStaleFacts(
  preflightEvidenceBlock: string | null | undefined,
  rationale: string | null | undefined,
) {
  const rationaleText = readStringValue(rationale);
  if (!rationaleText) {
    return {
      invalidStaleFact: false,
      staleFactReason: null,
    };
  }

  const factMap = extractBullpenPreflightFactMap(preflightEvidenceBlock);
  const authoritativeContext = [
    factMap["detailed market context"],
    factMap["resolution source"],
  ]
    .filter((value): value is string => Boolean(value))
    .join("\n");

  if (!authoritativeContext) {
    return {
      invalidStaleFact: false,
      staleFactReason: null,
    };
  }

  for (const rule of BULLPEN_STALE_FACT_RULES) {
    if (
      rule.factPattern.test(authoritativeContext) &&
      rule.contradictionPattern.test(rationaleText)
    ) {
      return {
        invalidStaleFact: true,
        staleFactReason: rule.reason,
      };
    }
  }

  return {
    invalidStaleFact: false,
    staleFactReason: null,
  };
}

function normalizeBullpenLlmBreakdown(
  value: unknown,
): BullpenQuestionLlmBreakdownItem[] {
  if (!Array.isArray(value)) return [];

  return value
    .map((entry) => normalizeBullpenLlmBreakdownEntry(entry))
    .filter(
      (entry): entry is BullpenQuestionLlmBreakdownItem => entry !== null,
    );
}

function readBullpenLlmOddsAlias(
  record: Record<string, unknown>,
  aliases: string[],
) {
  for (const alias of aliases) {
    const value = extractNumber(record[alias]);
    if (value !== null) return value;
  }
  return null;
}

export function normalizeBullpenLlmBreakdownEntry(
  entry: unknown,
): BullpenQuestionLlmBreakdownItem | null {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return null;

  const record = entry as Record<string, unknown>;
  const requestedModel =
    readStringValue(record.requestedModel) ||
    readStringValue(record.requested_model) ||
    readStringValue(record.targetModel) ||
    readStringValue(record.target_model) ||
    readStringValue(record.modelName) ||
    readStringValue(record.model_name) ||
    readStringValue(record.llm_model) ||
    readStringValue(record.model) ||
    null;
  const actualModel =
    readStringValue(record.actualModel) ||
    readStringValue(record.actual_model) ||
    readStringValue(record.resolvedModel) ||
    readStringValue(record.resolved_model) ||
    readStringValue(record.model) ||
    null;
  const provider =
    readStringValue(record.provider) ||
    readStringValue(record.llm_provider) ||
    readStringValue(record.provider_name) ||
    "unknown-provider";
  const model = actualModel || requestedModel || "unknown-model";
  const normalizedOdds = normalizeOddsPair(
    readBullpenLlmOddsAlias(record, [
      "llmYesOdds",
      "llm_yes_odds",
      "yesOdds",
      "yes_odds",
      "yesProbability",
      "yes_probability",
      "probYes",
      "prob_yes",
      "probabilityYes",
      "probability_yes",
      "fair_yes_probability_pct",
    ]),
    readBullpenLlmOddsAlias(record, [
      "llmNoOdds",
      "llm_no_odds",
      "noOdds",
      "no_odds",
      "noProbability",
      "no_probability",
      "probNo",
      "prob_no",
      "probabilityNo",
      "probability_no",
      "fair_no_probability_pct",
    ]),
  );
  const rationaleText =
    readStringValue(record.rationale) ||
    readStringValue(record.reasoning) ||
    readStringValue(record.notes) ||
    readStringValue(record.note) ||
    readStringValue(record.explanation) ||
    readStringValue(record.summary) ||
    null;
  const rationaleMismatch = detectBullpenRationaleOddsMismatch(
    rationaleText,
    normalizedOdds.yes,
  );
  const providerError =
    readStringValue(record.providerError) ||
    readStringValue(record.provider_error) ||
    readStringValue(record.error) ||
    null;
  const status =
    readStringValue(record.status) ||
    readStringValue(record.execution_status) ||
    null;
  const invalidReason =
    readStringValue(record.invalidReason) ||
    readStringValue(record.invalid_reason) ||
    readStringValue(record.staleFactReason) ||
    readStringValue(record.stale_fact_reason) ||
    providerError ||
    (normalizedOdds.yes === null && normalizedOdds.no === null
      ? "Provider returned no usable YES/NO odds."
      : null);

  return {
    provider,
    model,
    requestedModel,
    actualModel,
    status,
    providerError,
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
      readStringValue(record.createdAt) ||
      readStringValue(record.created_at) ||
      readStringValue(record.updatedAt) ||
      readStringValue(record.updated_at) ||
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
      record.keyEvidence ??
        record.key_evidence ??
        record.keyEvidenceSourceIds ??
        record.key_evidence_source_ids,
    ),
    redFlags: readStringArrayValue(record.redFlags ?? record.red_flags),
    rationale: rationaleText,
    direction:
      (readStringValue(record.direction) as BullpenLlmDirection | null) ??
      classifyBullpenLlmDirection(normalizedOdds.yes),
    rationaleOddsMismatch:
      readBooleanValue(
        record.rationaleOddsMismatch ?? record.rationale_odds_mismatch,
      ) ?? rationaleMismatch.rationaleOddsMismatch,
    rationaleOddsMismatchReason:
      readStringValue(
        record.rationaleOddsMismatchReason ??
          record.rationale_odds_mismatch_reason,
      ) ?? rationaleMismatch.rationaleOddsMismatchReason,
    effectiveWeight: roundBullpenValue(
      extractNumber(record.effectiveWeight ?? record.effective_weight) ??
        rationaleMismatch.effectiveWeight,
    ),
    webSearchUsed: readBooleanValue(
      record.webSearchUsed ?? record.web_search_used,
    ),
    webSearchQueries: readStringArrayValue(
      record.webSearchQueries ?? record.web_search_queries,
    ),
    webSources: readStringArrayValue(
      record.webSources ?? record.web_sources,
    ),
    internetVerified: readBooleanValue(
      record.internetVerified ?? record.internet_verified,
    ),
    evidenceBlockUsed:
      readBooleanValue(
        record.evidenceBlockUsed ?? record.evidence_block_used,
      ) ?? false,
    staleFactDetected:
      readBooleanValue(
        record.staleFactDetected ?? record.stale_fact_detected,
      ) ??
      readBooleanValue(record.invalidStaleFact ?? record.invalid_stale_fact) ??
      false,
    invalidReason,
    invalidStaleFact:
      readBooleanValue(record.invalidStaleFact ?? record.invalid_stale_fact) ??
      false,
    staleFactReason:
      readStringValue(record.staleFactReason) ||
      readStringValue(record.stale_fact_reason) ||
      null,
  } satisfies BullpenQuestionLlmBreakdownItem;
}

export function normalizeBullpenLlmBreakdownEntries(
  value: unknown,
): BullpenQuestionLlmBreakdownItem[] {
  return normalizeBullpenLlmBreakdown(value);
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
      readStringValue(record.market_id) ||
      readStringValue(record.marketId) ||
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
    readStringValue(record.market_id),
    readStringValue(record.marketId),
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
  const computedEntries = computeBullpenLlmEntries(breakdown);
  const modelYesValues = computedEntries.map((entry) => entry.yesOdds);
  const providerSignals = buildBullpenProviderSignals(computedEntries);
  const consensusYesValues =
    providerSignals.length >= 2
      ? providerSignals.map((provider) => provider.medianYesOdds)
      : modelYesValues;

  if (consensusYesValues.length === 0) {
    return {
      consensusYesOdds: null,
      consensusNoOdds: null,
      consensusMethod: null,
      llmAverageYesOdds: null,
      llmMedianYesOdds: null,
      llmTrimmedMeanYesOdds: null,
      llmIqrYesOdds: null,
      llmTrimmedRangeYesOdds: null,
      llmMinYesOdds: null,
      llmMaxYesOdds: null,
      llmSpreadYesOdds: null,
      llmDisagreementLevel: null,
      llmDisagreementCategory: null,
      llmRationaleMismatchCount: 0,
      adjudicationRequired: false,
    };
  }

  const sortedConsensusValues = [...consensusYesValues].sort(
    (left, right) => left - right,
  );
  const sortedModelValues = [...modelYesValues].sort((left, right) => left - right);
  const llmAverageYesOdds = averageBullpenValues(sortedConsensusValues);
  const llmMedianYesOdds = medianBullpenValues(sortedConsensusValues);
  const llmTrimmedMeanYesOdds = trimmedMeanBullpenValues(sortedConsensusValues);
  const llmIqrYesOdds = iqrBullpenValues(sortedConsensusValues);
  const llmTrimmedRangeYesOdds = trimmedRangeBullpenValues(sortedConsensusValues);
  const llmMinYesOdds = roundBullpenValue(sortedModelValues[0] ?? null);
  const llmMaxYesOdds = roundBullpenValue(sortedModelValues.at(-1) ?? null);
  const llmSpreadYesOdds =
    llmMinYesOdds === null || llmMaxYesOdds === null
      ? null
      : roundBullpenValue(llmMaxYesOdds - llmMinYesOdds);
  const modelSupport = summarizeBullpenDirectionSupport(computedEntries);
  const providerSupport = summarizeBullpenDirectionSupport(
    providerSignals.length >= 2
      ? providerSignals
      : computedEntries.map((entry) => ({
          direction: entry.direction,
          effectiveWeight: entry.effectiveWeight,
        })),
  );
  const modelTwoSidedSupport =
    modelSupport.counts.YES_CAMP >= 2 && modelSupport.counts.NO_CAMP >= 2;
  const providerTwoSidedSupport =
    providerSignals.length >= 2 &&
    providerSupport.shares.YES_CAMP >= BULLPEN_PROVIDER_SHARE_THRESHOLD &&
    providerSupport.shares.NO_CAMP >= BULLPEN_PROVIDER_SHARE_THRESHOLD;
  const highDisagreement = modelTwoSidedSupport || providerTwoSidedSupport;
  const medianDirection = classifyBullpenLlmDirection(llmMedianYesOdds);
  const trimmedMeanDirection = classifyBullpenLlmDirection(llmTrimmedMeanYesOdds);
  const strongConsensusDirection =
    medianDirection &&
    medianDirection === trimmedMeanDirection &&
    medianDirection !== "UNCERTAIN"
      ? medianDirection
      : null;
  const outlierCount = countBullpenOutlierModels(
    computedEntries,
    llmMedianYesOdds,
    llmIqrYesOdds,
  );
  const opposingProviderShare =
    strongConsensusDirection === "YES_CAMP"
      ? providerSupport.shares.NO_CAMP
      : strongConsensusDirection === "NO_CAMP"
        ? providerSupport.shares.YES_CAMP
        : 0;
  const majorityProviderShare =
    strongConsensusDirection === "YES_CAMP"
      ? providerSupport.shares.YES_CAMP
      : strongConsensusDirection === "NO_CAMP"
        ? providerSupport.shares.NO_CAMP
        : 0;
  const consensusWithOutlier =
    !highDisagreement &&
    llmSpreadYesOdds !== null &&
    llmSpreadYesOdds > BULLPEN_HIGH_RAW_SPREAD_THRESHOLD &&
    strongConsensusDirection !== null &&
    majorityProviderShare >= 0.6 &&
    opposingProviderShare < BULLPEN_PROVIDER_SHARE_THRESHOLD &&
    outlierCount >= 1 &&
    outlierCount <= 2;
  const mostlyConsensusSomeUncertainty =
    !highDisagreement &&
    !consensusWithOutlier &&
    strongConsensusDirection !== null &&
    (modelSupport.counts.UNCERTAIN > 0 || providerSupport.shares.UNCERTAIN > 0) &&
    opposingProviderShare < BULLPEN_PROVIDER_SHARE_THRESHOLD;

  let llmDisagreementLevel: BullpenLlmDisagreementLevel = "Low";
  let llmDisagreementCategory: BullpenLlmDisagreementCategory = "CONSENSUS";
  if (highDisagreement) {
    llmDisagreementLevel = "High";
    llmDisagreementCategory = "HIGH_DISAGREEMENT";
  } else if (consensusWithOutlier) {
    llmDisagreementLevel = "Medium";
    llmDisagreementCategory = "CONSENSUS_WITH_OUTLIER";
  } else if (mostlyConsensusSomeUncertainty) {
    llmDisagreementLevel = "Medium";
    llmDisagreementCategory = "MOSTLY_CONSENSUS_SOME_UNCERTAINTY";
  }

  const adjudicationRequired = highDisagreement;
  const consensusMethod =
    highDisagreement
      ? "median"
      : sortedConsensusValues.length >= 5 && llmTrimmedMeanYesOdds !== null
        ? "trimmedMean"
        : llmMedianYesOdds !== null
          ? "median"
          : "average";
  const consensusYesOdds =
    consensusMethod === "trimmedMean"
      ? llmTrimmedMeanYesOdds
      : consensusMethod === "median"
        ? llmMedianYesOdds
        : llmAverageYesOdds;
  const normalizedConsensus = normalizeOddsPair(
    consensusYesOdds,
    consensusYesOdds === null ? null : 100 - consensusYesOdds,
  );
  const llmRationaleMismatchCount = computedEntries.filter(
    (entry) => entry.rationaleOddsMismatch,
  ).length;

  return {
    consensusYesOdds: normalizedConsensus.yes,
    consensusNoOdds: normalizedConsensus.no,
    consensusMethod,
    llmAverageYesOdds,
    llmMedianYesOdds,
    llmTrimmedMeanYesOdds,
    llmIqrYesOdds,
    llmTrimmedRangeYesOdds,
    llmMinYesOdds,
    llmMaxYesOdds,
    llmSpreadYesOdds,
    llmDisagreementLevel,
    llmDisagreementCategory,
    llmRationaleMismatchCount,
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
  if (breakdown.length === 1) {
    if (isBullpenBreakdownEntryInvalid(breakdown[0])) {
      return (
        breakdown[0].invalidReason ||
        breakdown[0].staleFactReason ||
        "This model output was excluded from consensus because it contradicted verified evidence or missed the required internet-evidence checks."
      );
    }
    return breakdown[0]?.rationale || null;
  }
  const consensus = computeBullpenLlmConsensus(breakdown);
  const invalidCount = breakdown.filter((entry) =>
    isBullpenBreakdownEntryInvalid(entry),
  ).length;
  const disagreementLabel = getBullpenLlmDisagreementCategoryLabel(
    consensus.llmDisagreementCategory,
  );
  const disagreementNote =
    disagreementLabel &&
    consensus.llmDisagreementCategory !== "CONSENSUS" &&
    consensus.llmSpreadYesOdds !== null
      ? ` ${disagreementLabel} detected (${consensus.llmSpreadYesOdds.toFixed(2)}-point raw spread).`
      : "";
  const invalidNote =
    invalidCount > 0
      ? ` ${invalidCount} output${invalidCount === 1 ? "" : "s"} excluded for invalid or stale evidence handling.`
      : "";
  const mismatchNote =
    consensus.llmRationaleMismatchCount > 0
      ? ` ${consensus.llmRationaleMismatchCount} rationale/odds mismatch${consensus.llmRationaleMismatchCount === 1 ? "" : "es"} had reduced weight.`
      : "";
  return `${breakdown.length} LLM outputs available.${invalidNote}${mismatchNote}${disagreementNote} Click the LLM odds to inspect the full breakdown.`;
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

function formatBullpenPreflightText(
  value: string | null | undefined,
  fallback = "Not supplied",
) {
  if (!value) return fallback;
  const trimmed = value.trim();
  return trimmed || fallback;
}

function formatBullpenPreflightOdds(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Unknown";
  }

  return `${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}%`;
}

function formatBullpenPreflightHours(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) {
    return "Unknown";
  }

  return value.toLocaleString(undefined, {
    maximumFractionDigits: 2,
  });
}

function formatBullpenPreflightOutcomes(question: BullpenQuestionRow) {
  if (question.outcomeLabels.length > 0) {
    return question.outcomeLabels.join(" / ");
  }
  if (question.isBinaryYesNo) return "Yes / No";
  if (question.outcomeCount !== null) {
    return `${question.outcomeCount.toLocaleString()} outcomes`;
  }
  return "Unknown";
}

function buildBullpenPreflightEvidenceBlock(
  question: BullpenQuestionRow,
  payload: BullpenLegacyPreflightPayload,
) {
  const lines = [
    "Preflight Evidence Block:",
    "Market:",
    question.question,
    "",
    "Verified current facts:",
    `- question_id: ${question.id}`,
    `- market_id: ${question.id}`,
    `- category: ${formatBullpenPreflightText(payload.category, "Unknown")}`,
    `- outcomes: ${formatBullpenPreflightOutcomes(question)}`,
    `- current time (UTC): ${payload.current_time_utc}`,
    `- current time (ET): ${payload.current_time_et}`,
    `- close time: ${formatBullpenPreflightText(payload.close_time, "Unknown")}`,
    `- close time (ET): ${formatBullpenPreflightText(payload.close_time_et, "Unknown")}`,
    `- deadline (ET): ${formatBullpenPreflightText(payload.deadline_et, "Unknown")}`,
    `- hours remaining: ${formatBullpenPreflightHours(payload.hours_remaining)}`,
    `- current yes odds: ${formatBullpenPreflightOdds(payload.current_yes_odds)}`,
    `- current no odds: ${formatBullpenPreflightOdds(payload.current_no_odds)}`,
    `- market URL: ${formatBullpenPreflightText(payload.market_url, "Not supplied")}`,
    `- slug: ${formatBullpenPreflightText(payload.slug, "Not supplied")}`,
    `- Polymarket rules: ${formatBullpenPreflightText(payload.polymarket_rules)}`,
    `- detailed market context: ${formatBullpenPreflightText(payload.polymarket_market_context)}`,
    `- resolution source: ${formatBullpenPreflightText(payload.polymarket_resolution_source)}`,
    "",
    "Instruction:",
    "These facts are authoritative. Do not contradict them. Only estimate the unresolved condition.",
  ];

  return lines.join("\n");
}

function buildBullpenLlmPromptQuestionPayload(
  question: BullpenQuestionRow,
  index: number,
  referenceTime: Date,
) {
  const currentTimeUtc = referenceTime.toISOString();
  const currentTimeEt = formatBullpenDateTimeInTimeZone(
    referenceTime,
    BULLPEN_ET_TIME_ZONE,
  );
  const deadlineInfo = buildBullpenDeadlineInfo(question, referenceTime);
  const stage2Context = {
    schema_version: 2,
    event_id: question.id,
    question_ref: getBullpenQuestionRef(index),
    question_id: question.id,
    market_id: question.id,
    question: question.question,
    canonical_market_url: question.marketUrl,
    canonical_market_slug: question.slug,
    canonical_event_slug: question.slug,
    category: question.category,
    theme: question.category,
    outcome_labels: question.outcomeLabels,
    current_yes_odds: question.yesOdds,
    current_no_odds: question.noOdds,
    exact_resolution_rules: question.rules,
    exact_yes_definition: question.rules,
    resolution_source_description: question.resolutionSource,
    background_market_context: question.marketContext,
    background_context_warning: question.marketContext
      ? "Experimental AI-generated Polymarket summary is background context only."
      : null,
    resolution_timezone_name: "ET",
    resolution_timezone_iana: BULLPEN_ET_TIME_ZONE,
    deadline_local: deadlineInfo.deadlineEt,
    deadline_utc: question.closeTime,
    hours_remaining: deadlineInfo.hoursRemaining,
    deadline_source: deadlineInfo.deadlineSource,
    deadline_confidence: deadlineInfo.deadlineEt ? "medium" : "unresolved",
    current_time_utc: currentTimeUtc,
    rule_quality_status: question.rules ? "partial" : "missing",
    url_validation_status: question.marketUrl ? "legacy" : "unresolved",
    warnings: question.marketContext
      ? [
          "Frontend prompt builder is using legacy console market context. Fresh shared evidence is added on the backend before execution.",
        ]
      : [],
    field_provenance: {
      canonical_market_url: {
        source: "frontend_snapshot",
        fetched_at_utc: currentTimeUtc,
        validation_status: question.marketUrl ? "legacy" : "missing",
        notes: [],
      },
    },
    field_fetched_at: {
      canonical_market_url: currentTimeUtc,
    },
    evidence_packet: {
      schema_version: 2,
      built_at_utc: currentTimeUtc,
      event_id: question.id,
      exact_resolution_question: question.question,
      search_objective: question.rules,
      queries: [],
      sources: [],
      claims: [],
      warnings: [
        "Frontend prompt preview uses legacy local context. The backend replaces this with a structured evidence packet before provider execution.",
      ],
      sufficiency_status: "missing",
    },
    legacy_preflight_evidence_block: null as string | null,
  } satisfies Record<string, unknown>;
  const basePayload: Omit<BullpenLlmPromptQuestionPayload, "preflight_evidence_block"> =
    {
      event_id: question.id,
      question_ref: getBullpenQuestionRef(index),
      question_id: question.id,
      market_id: question.id,
      question: question.question,
      stage2_context: stage2Context,
    };
  const preflightEvidenceBlock = buildBullpenPreflightEvidenceBlock(
    question,
    {
      question_ref: getBullpenQuestionRef(index),
      question_id: question.id,
      market_id: question.id,
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
    },
  );
  stage2Context.legacy_preflight_evidence_block = preflightEvidenceBlock;
  (stage2Context.evidence_packet as { legacy_preflight_evidence_block?: string }).legacy_preflight_evidence_block =
    preflightEvidenceBlock;

  return {
    promptPayload: {
      ...basePayload,
      preflight_evidence_block: preflightEvidenceBlock,
    } satisfies BullpenLlmPromptQuestionPayload,
    questionPayload: {
      question_ref: getBullpenQuestionRef(index),
      question_id: question.id,
      market_id: question.id,
      condition_id: null,
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
      market_slug: question.slug,
      event_slug: question.slug,
      polymarket_rules: question.rules,
      polymarket_market_context: question.marketContext,
      polymarket_resolution_source: question.resolutionSource,
      preflight_evidence_block: preflightEvidenceBlock,
      evidence_packet_v2: stage2Context.evidence_packet as PolymarketEventQuestionPayload["evidence_packet_v2"],
      stage2_context: stage2Context as PolymarketEventQuestionPayload["stage2_context"],
    } satisfies PolymarketEventQuestionPayload,
    preflightEvidenceBlock,
  };
}

function normalizeBullpenPromptReferenceTime(referenceTime: Date | undefined) {
  if (referenceTime && !Number.isNaN(referenceTime.getTime())) {
    return referenceTime;
  }
  return new Date();
}

export function buildBullpenQuestionPreflightEvidenceBlock(
  question: BullpenQuestionRow,
  referenceTime?: Date,
) {
  return buildBullpenLlmPromptQuestionPayload(
    question,
    0,
    normalizeBullpenPromptReferenceTime(
      referenceTime ??
        (question.llmCompletedAt ? new Date(question.llmCompletedAt) : undefined),
    ),
  ).preflightEvidenceBlock;
}

export function buildBullpenLlmPromptInputs(
  questions: BullpenQuestionRow[],
  referenceTime = new Date(),
): BullpenLlmPromptInputs {
  const normalizedReferenceTime =
    normalizeBullpenPromptReferenceTime(referenceTime);
  const promptEntries = questions.map((question, index) =>
    buildBullpenLlmPromptQuestionPayload(
      question,
      index,
      normalizedReferenceTime,
    ),
  );

  return {
    questionPayload: promptEntries.map((entry) => entry.questionPayload),
    promptPayload: promptEntries.map((entry) => entry.promptPayload),
    preflightEvidenceBlocksByQuestionId: Object.fromEntries(
      promptEntries.map((entry, index) => [
        questions[index]?.id ?? getBullpenQuestionRef(index),
        entry.preflightEvidenceBlock,
      ]),
    ),
  };
}

export function buildBullpenLlmPrompt(
  questions: BullpenQuestionRow[],
  template = DEFAULT_BULLPEN_LLM_PROMPT_TEMPLATE,
  promptInputs = buildBullpenLlmPromptInputs(questions),
) {
  const selectedQuestionsJson = JSON.stringify(
    promptInputs.promptPayload,
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
