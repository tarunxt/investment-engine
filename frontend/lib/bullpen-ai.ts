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
  llmNotes: string | null;
  llmProvider: string | null;
  llmModel: string | null;
  llmRunId: number | null;
  llmCompletedAt: string | null;
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
};

export type BullpenLlmAnalysisPayload = {
  markets: BullpenLlmAnalysisItem[];
};

export const END_OF_MONTH_DATE = "2026-06-30";

export const BULLPEN_SOURCE_URLS: Record<ScanMode, string> = {
  "30-days": "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3",
  "end-of-month":
    "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3",
};

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

export function createBullpenQuestionRow(
  question: BullpenQuestion | BullpenQuestionRow,
): BullpenQuestionRow {
  const analysisFields = question as Partial<BullpenQuestionAnalysis>;

  return {
    ...question,
    llmYesOdds: analysisFields.llmYesOdds ?? null,
    llmNoOdds: analysisFields.llmNoOdds ?? null,
    currentVsLlmOddsDifference:
      analysisFields.currentVsLlmOddsDifference ?? null,
    llmNotes: analysisFields.llmNotes ?? null,
    llmProvider: analysisFields.llmProvider ?? null,
    llmModel: analysisFields.llmModel ?? null,
    llmRunId: analysisFields.llmRunId ?? null,
    llmCompletedAt: analysisFields.llmCompletedAt ?? null,
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
        typeof record.notes === "string"
          ? record.notes.trim()
          : typeof record.note === "string"
            ? record.note.trim()
          : typeof record.reasoning === "string"
            ? record.reasoning.trim()
            : typeof record.explanation === "string"
              ? record.explanation.trim()
              : typeof record.summary === "string"
                ? record.summary.trim()
            : null;

      return {
        questionId,
        llmYesOdds: normalizedOdds.yes,
        llmNoOdds: normalizedOdds.no,
        currentVsLlmOddsDifference: null,
        notes: notes || null,
      };
    })
    .filter(
      (item): item is BullpenLlmAnalysisItem => item !== null,
    );

  return {
    markets: normalizedMarkets,
  };
}

export function buildBullpenLlmPrompt(questions: BullpenQuestionRow[]) {
  return `You are analyzing live prediction-market questions. You must use live internet search before estimating odds.

Return ONLY valid JSON in this exact shape:
{
  "markets": [
    {
      "question_ref": "Q1",
      "llm_yes_odds": 0,
      "llm_no_odds": 0,
      "notes": "short explanation"
    }
  ]
}

Rules:
- Analyze every provided question independently using live web research.
- The provided current market odds are context only. Do not anchor blindly to them.
- Copy each "question_ref" exactly as provided for the matching market.
- Use numbers from 0 to 100 with up to 2 decimals.
- If both yes and no odds are present, they must sum to 100.
- If evidence is insufficient, return null for both odds and explain briefly in notes.
- Do not add markdown, prose, code fences, or extra keys outside the required JSON shape.

Questions:
${JSON.stringify(
    questions.map((question, index) => ({
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
    })),
    null,
    2,
  )}`;
}
