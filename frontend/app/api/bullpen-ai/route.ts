import { NextRequest, NextResponse } from "next/server";

import {
  buildPolymarketEventUrl,
  getCanonicalPolymarketEventSlug,
} from "./_lib/polymarketMarketUrls";
import {
  collectPolymarketCategoryLabels,
  formatPolymarketCategory,
  inferPolymarketCategoryFromText,
  POLYMARKET_DEFAULT_CATEGORY,
} from "./_lib/polymarketCategory";
import { fetchBackendRuntimeJson } from "./_lib/backendBullpenRuntime";
import {
  createBackendSessionContext,
  fetchBackendJsonWithSession,
} from "./_lib/serverBackendSession";
import {
  BULLPEN_SOURCE_URLS,
  normalizeBullpenScanFilters,
  type BullpenQuestion,
  type BullpenScanFilters,
  type ScanMode,
} from "@/lib/bullpen-ai";
import {
  MARKET_CATEGORY_KEYWORDS,
  MARKET_PREDICTION_PATTERNS,
  MARKET_QUESTION_KEYWORDS,
  RELEASED_BY_EVENT_KEYWORDS,
  SOCIAL_POST_COUNT_KEYWORDS,
  SOCIAL_POST_COUNT_PATTERNS,
  isLikelySportsWinOnText,
  normalizeCustomExclusionKeywordVariants,
  SPORTS_KEYWORDS,
  SPORTS_PATTERNS,
  WEATHER_KEYWORDS,
} from "@/lib/bullpenScanExclusions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type WalkContext = {
  closeTime: string | null;
  category: string | null;
};

type FilterableBullpenQuestion = Omit<BullpenQuestion, "category"> & {
  category: string | null;
  _categorySearchText: string;
  _searchText: string;
  _customExcludeSportsKeywords: string[];
  _customExcludeWeatherKeywords: string[];
  _customExcludeMarketPredictionsKeywords: string[];
  _customExcludeTweetCountQuestionsKeywords: string[];
};

const CLI_SOURCE_LABEL = "Bullpen CLI";
const WEB_SOURCE_LABEL = "Bullpen trending page";
const GAMMA_SOURCE_LABEL = "Polymarket Gamma API";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const POLYMARKET_GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const GAMMA_EVENT_PAGE_SIZE = 100;
const GAMMA_PAGES_PER_POLL = 3;
const GAMMA_PAGE_TIMEOUT_MS = 8_000;
const GAMMA_SCAN_JOB_TTL_MS = 45 * 60 * 1000;

type GammaScanWindow = {
  start: string;
  end: string;
  offset: number;
};

type GammaScanJob = {
  startedAt: number;
  scannedAt: string;
  windows: GammaScanWindow[];
  candidates: Map<string, FilterableBullpenQuestion>;
};

const gammaScanJobGlobal = globalThis as typeof globalThis & {
  __bullpenGammaScanJobs?: Map<string, GammaScanJob>;
};
const gammaScanJobs =
  gammaScanJobGlobal.__bullpenGammaScanJobs ??
  (gammaScanJobGlobal.__bullpenGammaScanJobs = new Map<string, GammaScanJob>());
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const CATEGORY_KEYS = [
  "category",
  "categorySlug",
  "type",
  "topic",
  "primaryCategory",
  "categoryName",
  "group",
  "tag",
];
const CLOSE_TIME_KEYS = [
  "closeTime",
  "closingTime",
  "endDate",
  "end_date",
  "endTime",
  "resolutionDate",
  "endDateIso",
  "endDateISO",
  "closesAt",
  "closedAt",
  "deadline",
  "expiry",
];
const QUESTION_KEYS = [
  "question",
  "title",
  "name",
  "eventTitle",
  "marketQuestion",
];
const MARKET_SLUG_KEYS = ["slug", "marketSlug", "questionSlug"];
const EVENT_SLUG_KEYS = ["eventSlug", "urlSlug"];
const CATEGORY_TRAIL_KEYS = [
  "category",
  "categories",
  "tags",
  "breadcrumbs",
  "breadcrumb",
  "path",
  "pathname",
  "url",
  "href",
  "link",
  "marketUrl",
  "eventUrl",
  "groupTitle",
  "groupItemTitle",
  "league",
  "tournament",
  "sport",
] as const;
const FILTER_TEXT_KEYS = [
  ...CATEGORY_KEYS,
  ...QUESTION_KEYS,
  ...MARKET_SLUG_KEYS,
  ...EVENT_SLUG_KEYS,
  "tags",
  "categories",
  "description",
  "groupTitle",
  "groupItemTitle",
  "league",
  "tournament",
  "sport",
  "homeTeam",
  "awayTeam",
  "team",
  "team1",
  "team2",
  "competitor",
  "competitors",
  "url",
  "href",
  "link",
  "marketUrl",
  "eventUrl",
  "pathname",
  "breadcrumbs",
  "breadcrumb",
];
const GAMMA_MARKET_NORMALIZATION_KEYS = Array.from(
  new Set([
    "id",
    "marketId",
    "conditionId",
    "questionID",
    ...QUESTION_KEYS,
    ...MARKET_SLUG_KEYS,
    ...CLOSE_TIME_KEYS,
    ...CATEGORY_KEYS,
    ...FILTER_TEXT_KEYS,
    "outcomes",
    "options",
    "tokens",
    "outcomePrices",
    "volume",
    "volume24hr",
    "volume24h",
    "totalVolume",
    "volumeNum",
    "volumeUsd",
    "volumeUSD",
    "liquidity",
    "liquidityNum",
    "liquidityUsd",
    "liquidityUSD",
  ]),
);
const OUTCOME_LABEL_KEYS = ["name", "label", "outcome", "title", "side"];
const INSULT_MARKET_PATTERNS = [
  /\b(?:donald\s+)?trump\b.{0,80}\bpublic(?:ly)?\s+insult(?:s|ed|ing)?\b/i,
  /\bpublic(?:ly)?\s+insult(?:s|ed|ing)?\s+(?:someone|somebody|anyone)\b/i,
  /\binsult(?:s|ed|ing)?\s+(?:someone|somebody|anyone)\b/i,
  /\bname[\s-]?calling\b/i,
];
const MONTH_NAMES = [
  "january",
  "february",
  "march",
  "april",
  "may",
  "june",
  "july",
  "august",
  "september",
  "october",
  "november",
  "december",
];
const MONTH_INDEX_BY_NAME = Object.fromEntries(
  MONTH_NAMES.map((month, index) => [month, index]),
) as Record<string, number>;
function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return String(value);
  }
  return null;
}

function parseNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%x,$,]/g, ""));
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const parsed = parseNumber(record[key]);
    if (parsed !== null) return parsed;
  }
  return null;
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readDisplayValue(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value))
      return value.toLocaleString("en-US", { maximumFractionDigits: 2 });
  }
  return null;
}

function readLabelValue(value: unknown) {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (value && typeof value === "object") {
    return readString(value as Record<string, unknown>, [
      "label",
      "name",
      "title",
      "slug",
    ]);
  }
  return null;
}

function titleCaseCategorySegment(value: string) {
  return value
    .split(/[\s_-]+/)
    .filter(Boolean)
    .map((part) => {
      const lower = part.toLowerCase();
      const upperLabels = new Set([
        "cs2",
        "lol",
        "nba",
        "nfl",
        "mlb",
        "nhl",
        "ufc",
        "f1",
      ]);
      if (upperLabels.has(lower)) return lower.toUpperCase();
      if (/^dota\s*2$/i.test(part)) return "Dota 2";
      return lower.charAt(0).toUpperCase() + lower.slice(1);
    })
    .join(" ");
}

function addCategoryTrailLabel(
  labels: string[],
  seen: Set<string>,
  value: unknown,
) {
  const label = readLabelValue(value);
  const normalized = label?.trim().toLowerCase();
  if (!label || !normalized || seen.has(normalized)) return;
  seen.add(normalized);
  labels.push(label);
}

function addCategoryTrailFromPath(
  labels: string[],
  seen: Set<string>,
  value: unknown,
) {
  if (typeof value !== "string" || !value.trim()) return;
  let pathname = value.trim();
  try {
    pathname = new URL(pathname).pathname;
  } catch {
    // Plain path/slugs are accepted below.
  }

  const segments = pathname
    .split("/")
    .map((segment) => segment.trim())
    .filter(Boolean);
  const esportsIndex = segments.findIndex((segment) =>
    /^e-?sports$/i.test(segment),
  );
  if (esportsIndex < 0) return;

  segments
    .slice(esportsIndex, esportsIndex + 3)
    .map((segment) => decodeURIComponent(segment))
    .map((segment) => titleCaseCategorySegment(segment))
    .forEach((label) => addCategoryTrailLabel(labels, seen, label));
}

function isCategoryPathKey(key: (typeof CATEGORY_TRAIL_KEYS)[number]) {
  return [
    "path",
    "pathname",
    "url",
    "href",
    "link",
    "marketUrl",
    "eventUrl",
  ].includes(key);
}

function collectDeepCategoryTrailLabels(value: unknown) {
  const labels: string[] = [];
  const seenLabels = new Set<string>();
  const seenNodes = new Set<unknown>();
  const stack: unknown[] = [value];
  let inspected = 0;

  while (stack.length > 0 && inspected < 10_000) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seenNodes.has(current))
      continue;
    seenNodes.add(current);
    inspected += 1;

    if (Array.isArray(current)) {
      current.forEach((item) => {
        addCategoryTrailLabel(labels, seenLabels, item);
        addCategoryTrailFromPath(labels, seenLabels, item);
        stack.push(item);
      });
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of CATEGORY_TRAIL_KEYS) {
      const candidate = record[key];
      const shouldReadRawLabel = !isCategoryPathKey(key);
      if (Array.isArray(candidate)) {
        candidate.forEach((item) => {
          if (shouldReadRawLabel)
            addCategoryTrailLabel(labels, seenLabels, item);
          addCategoryTrailFromPath(labels, seenLabels, item);
        });
      } else {
        if (shouldReadRawLabel)
          addCategoryTrailLabel(labels, seenLabels, candidate);
        addCategoryTrailFromPath(labels, seenLabels, candidate);
      }
    }

    for (const child of Object.values(record)) {
      stack.push(child);
    }
  }

  return labels;
}

function collectCategoryLabels(
  record: Record<string, unknown>,
  contextCategory: string | null = null,
) {
  const labels = [
    ...collectPolymarketCategoryLabels(contextCategory),
    ...collectPolymarketCategoryLabels(record),
  ];
  const seen = new Set(labels.map((label) => label.toLowerCase()));
  const add = (value: unknown) => addCategoryTrailLabel(labels, seen, value);

  collectDeepCategoryTrailLabels(record).forEach(add);
  return labels;
}

function readCategory(
  record: Record<string, unknown>,
  contextCategory: string | null = null,
) {
  return formatPolymarketCategory(
    collectCategoryLabels(record, contextCategory),
  );
}

function readDeepString(value: unknown, keys: string[]): string | null {
  const seen = new Set<unknown>();
  const stack: unknown[] = [value];
  let inspected = 0;

  while (stack.length > 0) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seen.has(current)) continue;
    seen.add(current);
    inspected += 1;

    // Bound the traversal so a very large payload cannot blow up route latency.
    if (inspected > 10_000) break;

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    const direct = readString(record, keys);
    if (direct) return direct;

    for (const child of Object.values(record)) {
      stack.push(child);
    }
  }

  return null;
}

function collectDeepStrings(
  value: unknown,
  keys: string[],
  { maxNodes = 10_000, maxValues = 128 } = {},
) {
  const values: string[] = [];
  const seenNodes = new Set<unknown>();
  const stack: unknown[] = [value];
  let inspected = 0;

  while (
    stack.length > 0 &&
    inspected < maxNodes &&
    values.length < maxValues
  ) {
    const current = stack.pop();
    if (!current || typeof current !== "object" || seenNodes.has(current))
      continue;
    seenNodes.add(current);
    inspected += 1;

    if (Array.isArray(current)) {
      for (let index = current.length - 1; index >= 0; index -= 1) {
        stack.push(current[index]);
      }
      continue;
    }

    const record = current as Record<string, unknown>;
    for (const key of keys) {
      const candidate = record[key];
      if (typeof candidate === "string" && candidate.trim()) {
        values.push(candidate.trim());
      } else if (typeof candidate === "number" && Number.isFinite(candidate)) {
        values.push(String(candidate));
      } else if (Array.isArray(candidate)) {
        for (const item of candidate) {
          if (typeof item === "string" && item.trim()) {
            values.push(item.trim());
            if (values.length >= maxValues) break;
          }
        }
      }
      if (values.length >= maxValues) break;
    }

    for (const child of Object.values(record)) {
      stack.push(child);
    }
  }

  return values;
}

function readOutcomeNumber(
  record: Record<string, unknown>,
  outcomeName: "yes" | "no",
  keys: string[],
) {
  const direct = readNumber(record, keys);
  if (direct !== null) return direct;

  for (const collection of [
    record.outcomes,
    record.options,
    record.tokens,
    record.markets,
  ]) {
    for (const item of [
      ...toArray(collection),
      ...parseJsonArray(collection),
    ]) {
      if (!item || typeof item !== "object") continue;
      const outcome = item as Record<string, unknown>;
      const label = readString(outcome, OUTCOME_LABEL_KEYS);
      if (!label || normalizeLabel(label) !== outcomeName) continue;
      const value = readNumber(outcome, [
        "odds",
        "decimalOdds",
        "price",
        "lastPrice",
        "bestAsk",
        "bestBid",
        "probability",
        "probabilityValue",
      ]);
      if (value !== null) return value;
    }
  }

  return null;
}

function normalizeOdds(value: number | null) {
  if (value === null || value < 0) return null;
  if (value <= 1) {
    return Number((value * 100).toFixed(2));
  }
  return value;
}

function walk(
  value: unknown,
  visit: (record: Record<string, unknown>, context: WalkContext) => void,
  context: WalkContext = { closeTime: null, category: null },
) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit, context));
    return;
  }
  const record = value as Record<string, unknown>;
  const nextContext = {
    closeTime: readString(record, CLOSE_TIME_KEYS) || context.closeTime,
    category: readCategory(record, context.category),
  };
  visit(record, nextContext);
  Object.values(record).forEach((child) => walk(child, visit, nextContext));
}

function extractEmbeddedJson(html: string) {
  const scripts = [
    ...html.matchAll(
      /<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
    ...html.matchAll(
      /<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi,
    ),
  ];

  return scripts.flatMap((match) => {
    try {
      return [JSON.parse(match[1])];
    } catch {
      return [];
    }
  });
}

function normalizeLabel(value: string) {
  return value.trim().toLowerCase();
}

function dedupeOutcomeLabels(labels: string[]) {
  const seen = new Set<string>();
  const deduped: string[] = [];

  for (const label of labels) {
    const normalized = normalizeLabel(label);
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(label.trim());
  }

  return deduped;
}

function readOutcomeLabels(record: Record<string, unknown>) {
  const labels: string[] = [];

  for (const collection of [
    record.outcomes,
    record.options,
    record.tokens,
    record.markets,
  ]) {
    for (const item of [
      ...toArray(collection),
      ...parseJsonArray(collection),
    ]) {
      if (typeof item === "string" && item.trim()) {
        labels.push(item.trim());
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const label = readString(
        item as Record<string, unknown>,
        OUTCOME_LABEL_KEYS,
      );
      if (label) labels.push(label);
    }
  }

  return dedupeOutcomeLabels(labels);
}

function isBinaryYesNoQuestion(
  outcomeLabels: string[],
  yesOdds: number | null,
  noOdds: number | null,
) {
  if (outcomeLabels.length === 0) return yesOdds !== null && noOdds !== null;
  if (outcomeLabels.length !== 2) return false;
  const normalized = outcomeLabels.map(normalizeLabel);
  return normalized.includes("yes") && normalized.includes("no");
}

function getDateKey(value: string | null) {
  if (!value) return null;
  const directMatch = value.match(/^(\d{4}-\d{2}-\d{2})/);
  if (directMatch) return directMatch[1];
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function getDaysUntilClose(closeTime: string | null) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return Number(
    ((closeDate.getTime() - Date.now()) / MILLISECONDS_PER_DAY).toFixed(1),
  );
}

function toValidDate(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function extractMentionedDate(
  value: string | null,
  fallbackYear = new Date().getUTCFullYear(),
) {
  if (!value) return null;
  const match = value.match(
    /\b(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2})(?:,\s*(\d{4}))?\b/i,
  );
  if (!match) return null;

  const monthIndex = MONTH_INDEX_BY_NAME[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = match[3] ? Number(match[3]) : fallbackYear;
  if (
    monthIndex === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year)
  ) {
    return null;
  }

  return new Date(Date.UTC(year, monthIndex, day, 23, 59, 0)).toISOString();
}

function inferSemanticCloseTime(
  record: Record<string, unknown>,
  question: string,
) {
  const candidates = [
    readString(record, ["description"]),
    readString(record, ["groupItemTitle", "groupTitle"]),
    question,
    readDeepString(record, ["groupItemTitle", "groupTitle", "description"]),
  ];

  for (const candidate of candidates) {
    const parsed = extractMentionedDate(candidate);
    if (parsed) return parsed;
  }

  return null;
}

function chooseCloseTime(
  rawCloseTime: string | null,
  semanticCloseTime: string | null,
) {
  const rawDate = toValidDate(rawCloseTime);
  const semanticDate = toValidDate(semanticCloseTime);

  if (!semanticDate) return rawCloseTime;
  if (!rawDate) return semanticCloseTime;

  const now = Date.now();
  const rawIsPast = rawDate.getTime() < now;
  const semanticIsFuture = semanticDate.getTime() >= now;

  if (rawIsPast && semanticIsFuture) return semanticCloseTime;
  if (
    rawDate.getUTCFullYear() < semanticDate.getUTCFullYear() &&
    semanticDate.getTime() >= now - MILLISECONDS_PER_DAY
  ) {
    return semanticCloseTime;
  }

  return rawCloseTime;
}

function escapeRegExp(value: string) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchesKeyword(text: string, keyword: string) {
  return new RegExp(`(^|\\W)${escapeRegExp(keyword)}(?=$|\\W)`, "i").test(text);
}

function includesAnyKeyword(text: string, keywords: readonly string[]) {
  return keywords.some((keyword) => matchesKeyword(text, keyword));
}

function includesAnyCustomKeyword(text: string, keywords: readonly string[]) {
  return keywords.some((keyword) =>
    normalizeCustomExclusionKeywordVariants(keyword).some((variant) =>
      matchesKeyword(text, variant),
    ),
  );
}

function normalizeSearchTextParts(parts: Array<string | null | undefined>) {
  const deduped: string[] = [];
  const seen = new Set<string>();

  for (const part of parts) {
    const normalized = (part || "").trim().toLowerCase();
    if (!normalized || seen.has(normalized)) continue;
    seen.add(normalized);
    deduped.push(normalized);
  }

  return deduped.join(" ");
}

function getQuestionSearchText(question: FilterableBullpenQuestion) {
  return question._searchText;
}

function isSportsQuestion(question: FilterableBullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return (
    includesAnyKeyword(searchText, SPORTS_KEYWORDS) ||
    includesAnyCustomKeyword(searchText, question._customExcludeSportsKeywords) ||
    SPORTS_PATTERNS.some((pattern) => pattern.test(searchText)) ||
    isLikelySportsWinOnText(searchText)
  );
}

function isWeatherQuestion(question: FilterableBullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return (
    includesAnyKeyword(searchText, WEATHER_KEYWORDS) ||
    includesAnyCustomKeyword(searchText, question._customExcludeWeatherKeywords)
  );
}

function isMarketPredictionQuestion(question: FilterableBullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return (
    includesAnyKeyword(question._categorySearchText, MARKET_CATEGORY_KEYWORDS) ||
    includesAnyCustomKeyword(
      question._categorySearchText,
      question._customExcludeMarketPredictionsKeywords,
    ) ||
    includesAnyKeyword(searchText, MARKET_QUESTION_KEYWORDS) ||
    includesAnyCustomKeyword(
      searchText,
      question._customExcludeMarketPredictionsKeywords,
    ) ||
    MARKET_PREDICTION_PATTERNS.some((pattern) => pattern.test(searchText))
  );
}

function isTweetCountQuestion(question: FilterableBullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return (
    (includesAnyKeyword(searchText, SOCIAL_POST_COUNT_KEYWORDS) ||
      includesAnyCustomKeyword(
        searchText,
        question._customExcludeTweetCountQuestionsKeywords,
      )) &&
    SOCIAL_POST_COUNT_PATTERNS.some((pattern) => pattern.test(searchText))
  );
}

function isReleasedByEventQuestion(question: FilterableBullpenQuestion) {
  return includesAnyKeyword(
    getQuestionSearchText(question),
    RELEASED_BY_EVENT_KEYWORDS,
  );
}

function isInsultMarket(question: FilterableBullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return INSULT_MARKET_PATTERNS.some((pattern) => pattern.test(searchText));
}

function sortQuestions<
  T extends Pick<BullpenQuestion, "question" | "closeTime">,
>(questions: T[]) {
  return [...questions].sort((left, right) => {
    const leftTime = left.closeTime
      ? new Date(left.closeTime).getTime()
      : Number.POSITIVE_INFINITY;
    const rightTime = right.closeTime
      ? new Date(right.closeTime).getTime()
      : Number.POSITIVE_INFINITY;

    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.question.localeCompare(right.question);
  });
}

function buildQuestionFilterSearchText({
  question,
  category,
  slug,
  outcomeLabels,
  record,
  contextCategory,
}: {
  question: string;
  category: string | null;
  slug: string | null;
  outcomeLabels: string[];
  record: Record<string, unknown>;
  contextCategory?: string | null;
}) {
  return normalizeSearchTextParts([
    question,
    category,
    slug,
    outcomeLabels.join(" "),
    contextCategory || null,
    ...collectDeepStrings(record, FILTER_TEXT_KEYS),
  ]);
}

function normalizeGammaMarket(
  record: Record<string, unknown>,
  sourceUrl: string,
): FilterableBullpenQuestion | null {
  const question = readString(record, QUESTION_KEYS);
  if (!question || question.length < 8) return null;

  const outcomeLabels = readOutcomeLabels(record);
  const outcomePrices = parseJsonArray(record.outcomePrices)
    .map((value) => parseNumber(value))
    .filter((value): value is number => value !== null);
  const normalizedOutcomeLabels = outcomeLabels.map(normalizeLabel);
  const yesIndex = normalizedOutcomeLabels.findIndex(
    (outcome) => outcome === "yes",
  );
  const noIndex = normalizedOutcomeLabels.findIndex(
    (outcome) => outcome === "no",
  );
  const yesPrice = yesIndex >= 0 ? outcomePrices[yesIndex] : null;
  const noPrice = noIndex >= 0 ? outcomePrices[noIndex] : null;
  const yesOdds = normalizeOdds(yesPrice);
  const noOdds = normalizeOdds(noPrice);
  const slug = readString(record, MARKET_SLUG_KEYS);
  const closeTime = chooseCloseTime(
    readString(record, CLOSE_TIME_KEYS),
    inferSemanticCloseTime(record, question),
  );
  const eventSlug = getCanonicalPolymarketEventSlug(record, slug);
  const category =
    readCategory(record) ??
    inferPolymarketCategoryFromText(
      question,
      slug,
      outcomeLabels.join(" "),
      collectDeepStrings(record, FILTER_TEXT_KEYS).join(" "),
    );
  const categoryLabels = collectCategoryLabels(record);
  const categorySearchText = normalizeSearchTextParts([
    category,
    ...categoryLabels,
  ]);
  const searchText = buildQuestionFilterSearchText({
    question,
    category,
    slug,
    outcomeLabels,
    record,
  });

  return {
    id:
      readString(record, [
        "id",
        ...MARKET_SLUG_KEYS,
        "marketId",
        "conditionId",
      ]) || question,
    question,
    closeTime,
    category,
    yesOdds,
    noOdds,
    volume: readDisplayValue(record, [
      "volume",
      "volume24hr",
      "volume24h",
      "totalVolume",
      "volumeNum",
      "volumeUsd",
      "volumeUSD",
    ]),
    liquidity: readDisplayValue(record, [
      "liquidity",
      "liquidityNum",
      "liquidityUsd",
      "liquidityUSD",
    ]),
    sourceUrl,
    slug,
    marketUrl: buildPolymarketEventUrl(eventSlug),
    outcomeLabels,
    outcomeCount:
      outcomeLabels.length > 0
        ? outcomeLabels.length
        : yesOdds !== null && noOdds !== null
          ? 2
          : null,
    isBinaryYesNo: isBinaryYesNoQuestion(outcomeLabels, yesOdds, noOdds),
    daysUntilClose: getDaysUntilClose(closeTime),
    rules: null,
    marketContext: null,
    resolutionSource: null,
    _categorySearchText: categorySearchText,
    _searchText: searchText,
    _customExcludeSportsKeywords: [],
    _customExcludeWeatherKeywords: [],
    _customExcludeMarketPredictionsKeywords: [],
    _customExcludeTweetCountQuestionsKeywords: [],
  };
}

function normalizeQuestion(
  record: Record<string, unknown>,
  sourceUrl: string,
  context: WalkContext,
): FilterableBullpenQuestion | null {
  const question = readString(record, QUESTION_KEYS);
  if (!question || question.length < 8) return null;

  const category =
    readCategory(record, context.category) ??
    inferPolymarketCategoryFromText(
      question,
      context.category,
      readString(record, MARKET_SLUG_KEYS),
      collectDeepStrings(record, FILTER_TEXT_KEYS).join(" "),
    );
  const categoryLabels = collectCategoryLabels(record, context.category);
  const yesOdds = normalizeOdds(
    readOutcomeNumber(record, "yes", [
      "yesOdds",
      "yes_odd",
      "yesDecimalOdds",
      "yesPrice",
      "yes",
      "bestYesOdds",
      "probabilityYes",
      "yesProbability",
    ]),
  );
  const noOdds = normalizeOdds(
    readOutcomeNumber(record, "no", [
      "noOdds",
      "no_odd",
      "noDecimalOdds",
      "noPrice",
      "no",
      "bestNoOdds",
      "probabilityNo",
      "noProbability",
    ]),
  );
  const rawCloseTime =
    readString(record, CLOSE_TIME_KEYS) ||
    readDeepString(record, CLOSE_TIME_KEYS) ||
    context.closeTime;
  const closeTime = chooseCloseTime(
    rawCloseTime,
    inferSemanticCloseTime(record, question),
  );
  const slug =
    readString(record, MARKET_SLUG_KEYS) ||
    readDeepString(record, MARKET_SLUG_KEYS);
  const eventSlug = getCanonicalPolymarketEventSlug(record, slug);
  const outcomeLabels = readOutcomeLabels(record);
  const id =
    readString(record, [
      "id",
      ...MARKET_SLUG_KEYS,
      "marketId",
      "conditionId",
      ...EVENT_SLUG_KEYS,
      "eventId",
    ]) || `${question}-${closeTime || "unknown"}`;
  const categorySearchText = normalizeSearchTextParts([
    category,
    context.category,
    ...categoryLabels,
  ]);
  const searchText = buildQuestionFilterSearchText({
    question,
    category,
    slug,
    outcomeLabels,
    record,
    contextCategory: context.category,
  });

  return {
    id,
    question,
    closeTime,
    category,
    yesOdds,
    noOdds,
    volume: readDisplayValue(record, [
      "volume",
      "volume24hr",
      "volume24h",
      "totalVolume",
      "volumeNum",
      "volumeUsd",
      "volumeUSD",
      "dollarVolume",
    ]),
    liquidity: readDisplayValue(record, [
      "liquidity",
      "liquidityNum",
      "liquidityUsd",
      "liquidityUSD",
    ]),
    sourceUrl,
    slug,
    marketUrl: buildPolymarketEventUrl(eventSlug),
    outcomeLabels,
    outcomeCount:
      outcomeLabels.length > 0
        ? outcomeLabels.length
        : yesOdds !== null && noOdds !== null
          ? 2
          : null,
    isBinaryYesNo: isBinaryYesNoQuestion(outcomeLabels, yesOdds, noOdds),
    daysUntilClose: getDaysUntilClose(closeTime),
    rules: null,
    marketContext: null,
    resolutionSource: null,
    _categorySearchText: categorySearchText,
    _searchText: searchText,
    _customExcludeSportsKeywords: [],
    _customExcludeWeatherKeywords: [],
    _customExcludeMarketPredictionsKeywords: [],
    _customExcludeTweetCountQuestionsKeywords: [],
  };
}

function passesTimeFilter(
  question: Pick<BullpenQuestion, "closeTime">,
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  if (!question.closeTime) return false;
  const closeDate = new Date(question.closeTime);
  if (Number.isNaN(closeDate.getTime())) return false;

  if (mode === "end-of-month") {
    return getDateKey(question.closeTime) === filters.targetDate;
  }

  const difference = closeDate.getTime() - Date.now();
  return (
    difference > 0 &&
    difference <= filters.maxClosingDays * MILLISECONDS_PER_DAY
  );
}

function getFilterReasons(
  question: FilterableBullpenQuestion,
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  const reasons: string[] = [];
  if (!passesTimeFilter(question, mode, filters)) {
    reasons.push("Excluded market outside the selected scan window.");
  }
  if (filters.excludeSports && isSportsQuestion(question)) {
    reasons.push("Excluded sports market.");
  }
  if (filters.excludeWeather && isWeatherQuestion(question)) {
    reasons.push("Excluded weather market.");
  }
  if (
    filters.excludeMarketPredictions &&
    isMarketPredictionQuestion(question)
  ) {
    reasons.push("Excluded market-prediction or finance market.");
  }
  if (
    filters.excludeTweetCountQuestions &&
    isTweetCountQuestion(question)
  ) {
    reasons.push("Excluded tweet-count or social-post-count market.");
  }
  if (
    filters.excludeReleasedByEvents &&
    isReleasedByEventQuestion(question)
  ) {
    reasons.push("Excluded release-by event market.");
  }
  if (isInsultMarket(question)) {
    reasons.push("Excluded insult or name-calling market.");
  }
  if (filters.onlyBinaryYesNo && !question.isBinaryYesNo) {
    reasons.push("Excluded unclear non-binary market.");
  }
  if (
    filters.minYesOdds > 0 &&
    (question.yesOdds === null || question.yesOdds < filters.minYesOdds)
  ) {
    reasons.push(
      question.yesOdds === null
        ? "Excluded market without Yes odds."
        : `Excluded market below the ${filters.minYesOdds}% Yes odds floor.`,
    );
  }
  if (
    filters.minNoOdds > 0 &&
    (question.noOdds === null || question.noOdds < filters.minNoOdds)
  ) {
    reasons.push(
      question.noOdds === null
        ? "Excluded market without No odds."
        : `Excluded market below the ${filters.minNoOdds}% No odds floor.`,
    );
  }
  return reasons;
}

function collectQuestions(payloads: unknown[], sourceUrl: string) {
  const candidates = new Map<string, FilterableBullpenQuestion>();
  for (const payload of payloads) {
    walk(payload, (record, context) => {
      const normalized = normalizeQuestion(record, sourceUrl, context);
      if (normalized) candidates.set(normalized.id, normalized);
    });
  }
  return sortQuestions(Array.from(candidates.values()));
}

function stripFilterMetadata(question: FilterableBullpenQuestion): BullpenQuestion {
  const {
    _categorySearchText,
    _searchText,
    _customExcludeSportsKeywords,
    _customExcludeWeatherKeywords,
    _customExcludeMarketPredictionsKeywords,
    _customExcludeTweetCountQuestionsKeywords,
    ...publicQuestion
  } = question;
  void _categorySearchText;
  void _searchText;
  void _customExcludeSportsKeywords;
  void _customExcludeWeatherKeywords;
  void _customExcludeMarketPredictionsKeywords;
  void _customExcludeTweetCountQuestionsKeywords;
  return {
    ...publicQuestion,
    category:
      publicQuestion.category ??
      inferPolymarketCategoryFromText(
        publicQuestion.question,
        publicQuestion.slug,
        publicQuestion.outcomeLabels.join(" "),
      ) ??
      POLYMARKET_DEFAULT_CATEGORY,
  };
}

function sourceHasFutureCandidates<
  T extends Pick<BullpenQuestion, "closeTime">,
>(candidates: T[]) {
  return candidates.some((candidate) => {
    const closeDate = toValidDate(candidate.closeTime);
    return closeDate !== null && closeDate.getTime() >= Date.now();
  });
}

async function runBullpenDiscover() {
  return fetchBackendRuntimeJson("/polymarket/runtime/discover");
}

function buildGammaScanWindows(scannedAt: string) {
  const windows: GammaScanWindow[] = [];
  let start = new Date(scannedAt);
  const horizon = new Date(Date.UTC(2101, 0, 1));

  while (start < horizon) {
    const end = new Date(
      Date.UTC(
        Math.min(start.getUTCFullYear() + 1, 2101),
        start.getUTCMonth(),
        start.getUTCDate(),
        start.getUTCHours(),
        start.getUTCMinutes(),
        start.getUTCSeconds(),
        start.getUTCMilliseconds(),
      ),
    );
    windows.push({
      start: start.toISOString(),
      end: (end < horizon ? end : horizon).toISOString(),
      offset: 0,
    });
    start = end;
  }
  return windows;
}

function splitGammaScanWindow(window: GammaScanWindow) {
  const startMs = new Date(window.start).getTime();
  const endMs = new Date(window.end).getTime();
  const midpoint = new Date(startMs + Math.floor((endMs - startMs) / 2));
  return [
    { start: window.start, end: midpoint.toISOString(), offset: 0 },
    { start: midpoint.toISOString(), end: window.end, offset: 0 },
  ];
}

async function fetchGammaMarketPage(window: GammaScanWindow) {
  const candidates = new Map<string, FilterableBullpenQuestion>();
  const params = new URLSearchParams({
    active: "true",
    archived: "false",
    closed: "false",
    end_date_min: window.start,
    end_date_max: window.end,
    limit: String(GAMMA_EVENT_PAGE_SIZE),
    offset: String(window.offset),
  });

  let response: Response;
  try {
    response = await fetch(
      `${POLYMARKET_GAMMA_EVENTS_URL}?${params.toString()}`,
      {
        cache: "no-store",
        headers: { accept: "application/json" },
        signal: AbortSignal.timeout(GAMMA_PAGE_TIMEOUT_MS),
      },
    );
  } catch (error: unknown) {
    const name = error instanceof Error ? error.name : "";
    if (
      error instanceof TypeError ||
      name === "AbortError" ||
      name === "TimeoutError"
    ) {
      return {
        candidates,
        eventCount: 0,
        offsetLimited: false,
        retryableFailure: true,
      };
    }
    throw error;
  }
  if (response.status === 422 && window.offset > 0) {
    return {
      candidates,
      eventCount: 0,
      offsetLimited: true,
      retryableFailure: false,
    };
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      candidates,
      eventCount: 0,
      offsetLimited: false,
      retryableFailure: true,
    };
  }
  if (!response.ok) {
    throw new Error(`Polymarket Gamma returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  const events = Array.isArray(payload) ? payload : [];
  for (const eventValue of events) {
    if (!eventValue || typeof eventValue !== "object") continue;
    const event = eventValue as Record<string, unknown>;
    if (
      event.closed === true ||
      event.active === false ||
      event.archived === true
    ) {
      continue;
    }
    const eventIdentity = {
      id: event.id,
      slug: event.slug,
      title: event.title,
    };
    for (const marketValue of toArray(event.markets)) {
      if (!marketValue || typeof marketValue !== "object") continue;
      const market = marketValue as Record<string, unknown>;
      if (
        market.closed === true ||
        market.active === false ||
        market.archived === true
      ) {
        continue;
      }
      const marketForNormalization = Object.fromEntries(
        GAMMA_MARKET_NORMALIZATION_KEYS.flatMap((key) =>
          key in market ? [[key, market[key]]] : [],
        ),
      );
      marketForNormalization.events = [eventIdentity];
      const normalized = normalizeGammaMarket(
        marketForNormalization,
        POLYMARKET_GAMMA_MARKETS_URL,
      );
      if (normalized) candidates.set(normalized.id, normalized);
    }
  }
  return {
    candidates,
    eventCount: events.length,
    offsetLimited: false,
    retryableFailure: false,
  };
}

function isVercelSecurityCheckpoint(html: string) {
  return /Vercel Security Checkpoint/i.test(html);
}

async function fetchBullpenPage(sourceUrl: string) {
  const response = await fetch(sourceUrl, {
    cache: "no-store",
    headers: {
      accept: "text/html,application/xhtml+xml,application/json",
      "user-agent": "Mozilla/5.0 Bullpen AI scanner",
    },
  });

  if (!response.ok) {
    throw new Error(`Bullpen web returned HTTP ${response.status}`);
  }

  const html = await response.text();
  if (isVercelSecurityCheckpoint(html)) {
    throw new Error("Bullpen web is behind a Vercel Security Checkpoint");
  }

  return html;
}

async function buildResponse({
  mode,
  sourceUrl,
  sourceLabel,
  scannedAt,
  filters,
  candidates,
  warning,
  details,
}: {
  mode: ScanMode;
  sourceUrl: string;
  sourceLabel: string;
  scannedAt: string;
  filters: BullpenScanFilters;
  candidates: FilterableBullpenQuestion[];
  warning?: string;
  details?: string;
}) {
  const candidatesWithFilters = candidates.map((question) => ({
    ...question,
    _customExcludeSportsKeywords: filters.customExcludeSportsKeywords,
    _customExcludeWeatherKeywords: filters.customExcludeWeatherKeywords,
    _customExcludeMarketPredictionsKeywords:
      filters.customExcludeMarketPredictionsKeywords,
    _customExcludeTweetCountQuestionsKeywords:
      filters.customExcludeTweetCountQuestionsKeywords,
  }));
  const evaluatedCandidates = candidatesWithFilters.map((question) => ({
    question,
    filterReasons: getFilterReasons(question, mode, filters),
  }));
  const acceptedCandidates = evaluatedCandidates
    .filter(({ filterReasons }) => filterReasons.length === 0)
    .map(({ question }) => question);
  const rejectedCandidates = evaluatedCandidates.filter(
    ({ filterReasons }) => filterReasons.length > 0,
  );
  const questions = sortQuestions(
    acceptedCandidates.map((question) => stripFilterMetadata(question)),
  );
  const rejectedQuestions = sortQuestions(
    rejectedCandidates.map(({ question, filterReasons }) => ({
      ...stripFilterMetadata(question),
      filterReasons,
    })),
  );

  return {
    mode,
    sourceUrl,
    sourceLabel,
    scannedAt,
    filters,
    totalCandidates: candidates.length,
    questions,
    rejectedQuestions,
    ...(warning ? { warning } : {}),
    ...(details ? { details } : {}),
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode: ScanMode =
    searchParams.get("mode") === "end-of-month" ? "end-of-month" : "30-days";
  const filters = normalizeBullpenScanFilters(mode, searchParams);
  const scannedAt = new Date().toISOString();

  const gammaScanJobKey = `${mode}:${searchParams.toString()}`;
  const nowMs = Date.now();
  for (const [jobKey, job] of gammaScanJobs) {
    if (nowMs - job.startedAt > GAMMA_SCAN_JOB_TTL_MS) {
      gammaScanJobs.delete(jobKey);
    }
  }

  let gammaJob = gammaScanJobs.get(gammaScanJobKey);
  if (!gammaJob) {
    gammaJob = {
      startedAt: nowMs,
      scannedAt,
      windows: buildGammaScanWindows(scannedAt),
      candidates: new Map<string, FilterableBullpenQuestion>(),
    };
    gammaScanJobs.set(gammaScanJobKey, gammaJob);
    return NextResponse.json(
      { status: "scanning", retryAfterMs: 250 },
      { status: 202 },
    );
  }

  try {
    const currentWindow = gammaJob.windows[0];
    if (currentWindow) {
      const pages = await Promise.all(
        Array.from({ length: GAMMA_PAGES_PER_POLL }, (_, page) =>
          fetchGammaMarketPage({
            ...currentWindow,
            offset:
              currentWindow.offset + page * GAMMA_EVENT_PAGE_SIZE,
          }),
        ),
      );

      for (const { candidates } of pages) {
        for (const candidate of candidates.values()) {
          gammaJob.candidates.set(candidate.id, candidate);
        }
      }

      if (pages.some(({ retryableFailure }) => retryableFailure)) {
        return NextResponse.json(
          {
            status: "scanning",
            retryAfterMs: 1_000,
            candidateCount: gammaJob.candidates.size,
            windowsRemaining: gammaJob.windows.length,
          },
          { status: 202 },
        );
      } else if (pages.some(({ offsetLimited }) => offsetLimited)) {
        const [leftWindow, rightWindow] = splitGammaScanWindow(currentWindow);
        gammaJob.windows.splice(0, 1, leftWindow, rightWindow);
      } else if (
        pages.some(({ eventCount }) => eventCount < GAMMA_EVENT_PAGE_SIZE)
      ) {
        gammaJob.windows.shift();
      } else {
        currentWindow.offset +=
          GAMMA_EVENT_PAGE_SIZE * GAMMA_PAGES_PER_POLL;
      }
    }

    if (gammaJob.windows.length > 0) {
      return NextResponse.json(
        {
          status: "scanning",
          retryAfterMs: 250,
          candidateCount: gammaJob.candidates.size,
          windowsRemaining: gammaJob.windows.length,
        },
        { status: 202 },
      );
    }

    const allCandidates = sortQuestions(
      Array.from(gammaJob.candidates.values()),
    );
    if (allCandidates.length === 0) {
      throw new Error("Polymarket Gamma returned no active current markets");
    }
    const result = await buildResponse({
      mode,
      sourceUrl: POLYMARKET_GAMMA_MARKETS_URL,
      sourceLabel: GAMMA_SOURCE_LABEL,
      scannedAt: gammaJob.scannedAt,
      filters,
      candidates: allCandidates,
      details: `Polymarket Gamma scanned the complete current universe of ${allCandidates.length} active markets before filters were applied.`,
    });
    gammaScanJobs.delete(gammaScanJobKey);
    return NextResponse.json(result);
  } catch (error: unknown) {
    gammaScanJobs.delete(gammaScanJobKey);
    const message =
      error instanceof Error ? error.message : "Complete Gamma scan failed";
    return NextResponse.json(
      {
        mode,
        sourceUrl: POLYMARKET_GAMMA_MARKETS_URL,
        sourceLabel: GAMMA_SOURCE_LABEL,
        scannedAt: gammaJob.scannedAt,
        filters,
        totalCandidates: 0,
        questions: [],
        rejectedQuestions: [],
        error: message,
      },
      { status: 502 },
    );
  }
}
