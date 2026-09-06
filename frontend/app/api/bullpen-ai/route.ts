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
} from "./_lib/serverBackendSession";
import {
  appendStageOneGammaExportPage,
  reapplyStageOneGammaExportFilters,
  type StageOneGammaExportRow,
} from "./_lib/stageOneGammaExport";
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
import type { BullpenActivePositionView } from "@/lib/bullpenPositions";

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
  _customExcludeOtherPhrases: string[];
};

const CLI_SOURCE_LABEL = "Bullpen CLI";
const WEB_SOURCE_LABEL = "Bullpen trending page";
const GAMMA_SOURCE_LABEL = "Polymarket Gamma API";
const POLYMARKET_GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const POLYMARKET_GAMMA_EVENTS_KEYSET_URL = `${POLYMARKET_GAMMA_EVENTS_URL}/keyset`;
const GAMMA_EVENT_PAGE_SIZE = 500;
const GAMMA_PAGE_TIMEOUT_MS = 20_000;
const GAMMA_TERMINAL_CURSOR = "LTE=";

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
  const indicativeYesOdds = normalizeOdds(yesPrice);
  const indicativeNoOdds = normalizeOdds(noPrice);
  const bestAskOdds = normalizeOdds(parseNumber(record.bestAsk));
  const bestBidOdds = normalizeOdds(parseNumber(record.bestBid));
  const isBinaryYesNo =
    new Set(normalizedOutcomeLabels).size === 2 &&
    normalizedOutcomeLabels.includes("yes") &&
    normalizedOutcomeLabels.includes("no");
  // Use executable order-book asks. Gamma's market-level book is the YES
  // token, so Buy No is the complement of the best YES bid.
  const yesOdds =
    isBinaryYesNo && bestAskOdds !== null ? bestAskOdds : indicativeYesOdds;
  const noOdds =
    isBinaryYesNo && bestBidOdds !== null
      ? Number((100 - bestBidOdds).toFixed(2))
      : indicativeNoOdds;
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
    volume24hr: readDisplayValue(record, ["volume24hr", "volume24h"]),
    spreadCents: normalizeOdds(readNumber(record, ["spread"])),
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
    _customExcludeOtherPhrases: [],
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
    volume24hr: readDisplayValue(record, ["volume24hr", "volume24h"]),
    spreadCents: normalizeOdds(readNumber(record, ["spread"])),
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
    _customExcludeOtherPhrases: [],
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
  const volumeUsd = question.volume === null ? null : Number(question.volume);
  const liquidityUsd = question.liquidity === null ? null : Number(question.liquidity);
  if (volumeUsd === null || !Number.isFinite(volumeUsd) || volumeUsd <= filters.minVolumeUsd) {
    reasons.push(`Excluded market with Volume USD not greater than ${filters.minVolumeUsd}.`);
  }
  if (liquidityUsd === null || !Number.isFinite(liquidityUsd) || liquidityUsd <= filters.minLiquidityUsd) {
    reasons.push(`Excluded market with Liquidity USD not greater than ${filters.minLiquidityUsd}.`);
  }
  const volume24hrUsd = question.volume24hr === null || question.volume24hr === undefined
    ? null
    : Number(question.volume24hr.replace(/,/g, ""));
  if (volume24hrUsd === null || !Number.isFinite(volume24hrUsd) || volume24hrUsd <= filters.minVolume24hrUsd) {
    reasons.push(`Excluded market with volume24hr USD not greater than ${filters.minVolume24hrUsd}.`);
  }
  if (question.spreadCents === null || question.spreadCents === undefined || question.spreadCents >= filters.maxSpreadCents) {
    reasons.push(`Excluded market with spread not below ${filters.maxSpreadCents} cents.`);
  }
  if (filters.rejectedThemePattern) {
    try {
      if (new RegExp(filters.rejectedThemePattern, "i").test(question.category ?? "")) {
        reasons.push("Excluded by the Theme Names pattern.");
      }
    } catch {
      // The persisted settings API validates the expression. Ignore malformed
      // direct query-string values so this compatibility route remains usable.
    }
  }
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
  if (includesAnyCustomKeyword(question._searchText, question._customExcludeOtherPhrases)) {
    reasons.push("Excluded by a custom phrase in Others.");
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
  if (filters.minLowerOutcomeOdds > 0) {
    const lowerOutcomeOdds =
      question.yesOdds === null || question.noOdds === null
        ? null
        : Math.min(question.yesOdds, question.noOdds);
    if (lowerOutcomeOdds === null || lowerOutcomeOdds <= filters.minLowerOutcomeOdds) {
      reasons.push(
        lowerOutcomeOdds === null
          ? "Excluded market without a complete Yes/No odds pair."
          : `Excluded because min(Yes, No) must be above ${filters.minLowerOutcomeOdds}%.`,
      );
    }
  }
  if (filters.minHigherOutcomeOdds > 0) {
    const higherOutcomeOdds =
      question.yesOdds === null || question.noOdds === null
        ? null
        : Math.max(question.yesOdds, question.noOdds);
    if (higherOutcomeOdds === null || higherOutcomeOdds <= filters.minHigherOutcomeOdds) {
      reasons.push(
        higherOutcomeOdds === null
          ? "Excluded market without a complete Yes/No odds pair."
          : `Excluded because max(Yes, No) must be above ${filters.minHigherOutcomeOdds}%.`,
      );
    }
  }
  return reasons;
}

function hydrateStoredCandidateForFiltering(
  question: BullpenQuestion,
  filters: BullpenScanFilters,
  market: Record<string, unknown>,
  event: Record<string, unknown>,
): FilterableBullpenQuestion {
  const theme = question.category ?? "";
  return {
    ...question,
    volume24hr:
      question.volume24hr ??
      readDisplayValue(market, ["volume24hr", "volume24h"]) ??
      readDisplayValue(event, ["volume24hr", "volume24h"]),
    spreadCents:
      question.spreadCents ??
      normalizeOdds(readNumber(market, ["spread"])) ??
      normalizeOdds(readNumber(event, ["spread"])),
    category: question.category,
    // Gamma's complete dot-separated Theme trail is persisted in `category`.
    // Re-filter it as one composite value, matching the Theme Excel column.
    _categorySearchText: normalizeSearchTextParts([theme]),
    _searchText: normalizeSearchTextParts([
      question.question,
      theme,
      question.slug,
      question.outcomeLabels.join(" "),
    ]),
    _customExcludeSportsKeywords: filters.customExcludeSportsKeywords,
    _customExcludeWeatherKeywords: filters.customExcludeWeatherKeywords,
    _customExcludeMarketPredictionsKeywords:
      filters.customExcludeMarketPredictionsKeywords,
    _customExcludeTweetCountQuestionsKeywords:
      filters.customExcludeTweetCountQuestionsKeywords,
    _customExcludeOtherPhrases: filters.customExcludeOtherPhrases,
  };
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
    _customExcludeOtherPhrases,
    ...publicQuestion
  } = question;
  void _categorySearchText;
  void _searchText;
  void _customExcludeSportsKeywords;
  void _customExcludeWeatherKeywords;
  void _customExcludeMarketPredictionsKeywords;
  void _customExcludeTweetCountQuestionsKeywords;
  void _customExcludeOtherPhrases;
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

type GammaPageCandidate = {
  candidateId: string;
  candidate: FilterableBullpenQuestion;
  event: Record<string, unknown>;
  market: Record<string, unknown>;
};

async function fetchGammaEventPage({
  cursor,
}: {
  cursor: string | null;
}) {
  const candidates = new Map<string, FilterableBullpenQuestion>();
  const exportCandidates: GammaPageCandidate[] = [];
  const params = new URLSearchParams({
    archived: "false",
    closed: "false",
    limit: String(GAMMA_EVENT_PAGE_SIZE),
  });
  if (cursor) params.set("after_cursor", cursor);

  let response: Response;
  try {
    response = await fetch(
      `${POLYMARKET_GAMMA_EVENTS_KEYSET_URL}?${params.toString()}`,
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
        exportCandidates,
        nextCursor: cursor,
        retryableFailure: true,
        retryReason:
          name === "TimeoutError" || name === "AbortError"
            ? "Polymarket Gamma page request timed out."
            : "Polymarket Gamma page request failed at the network layer.",
      };
    }
    throw error;
  }
  if (response.status === 429 || response.status >= 500) {
    return {
      candidates,
      exportCandidates,
      nextCursor: cursor,
      retryableFailure: true,
      retryReason:
        response.status === 429
          ? "Polymarket Gamma rate-limited this page (HTTP 429)."
          : `Polymarket Gamma returned a temporary server error (HTTP ${response.status}).`,
    };
  }
  if (!response.ok) {
    throw new Error(`Polymarket Gamma returned HTTP ${response.status}`);
  }

  const payload = (await response.json()) as Record<string, unknown>;
  const events = Array.isArray(payload.events) ? payload.events : [];
  for (const eventValue of events) {
    if (!eventValue || typeof eventValue !== "object") continue;
    const event = eventValue as Record<string, unknown>;
    if (event.closed === true || event.archived === true) continue;
    const eventWithoutMarkets = Object.fromEntries(
      Object.entries(event).filter(([key]) => key !== "markets"),
    );
    for (const marketValue of toArray(event.markets)) {
      if (!marketValue || typeof marketValue !== "object") continue;
      const market = marketValue as Record<string, unknown>;
      if (market.closed === true || market.archived === true) continue;
      const marketForNormalization = {
        ...market,
        events: [eventWithoutMarkets],
      };
      const normalized = normalizeGammaMarket(
        marketForNormalization,
        POLYMARKET_GAMMA_EVENTS_URL,
      );
      if (!normalized) continue;
      candidates.set(normalized.id, normalized);
      exportCandidates.push({
        candidateId: normalized.id,
        candidate: normalized,
        event: eventWithoutMarkets,
        market,
      });
    }
  }

  const rawNextCursor =
    typeof payload.next_cursor === "string" && payload.next_cursor
      ? payload.next_cursor
      : null;
  const reachedEnd =
    !rawNextCursor ||
    rawNextCursor === GAMMA_TERMINAL_CURSOR ||
    rawNextCursor === cursor;
  const nextCursor = reachedEnd ? null : rawNextCursor;
  return {
    candidates,
    exportCandidates,
    nextCursor,
    retryableFailure: false,
    retryReason: null,
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
  forcedIdentityKeys = new Set<string>(),
}: {
  mode: ScanMode;
  sourceUrl: string;
  sourceLabel: string;
  scannedAt: string;
  filters: BullpenScanFilters;
  candidates: FilterableBullpenQuestion[];
  warning?: string;
  details?: string;
  forcedIdentityKeys?: Set<string>;
}) {
  const candidatesWithFilters = candidates.map((question) => ({
    ...question,
    _customExcludeSportsKeywords: filters.customExcludeSportsKeywords,
    _customExcludeWeatherKeywords: filters.customExcludeWeatherKeywords,
    _customExcludeMarketPredictionsKeywords:
      filters.customExcludeMarketPredictionsKeywords,
    _customExcludeTweetCountQuestionsKeywords:
      filters.customExcludeTweetCountQuestionsKeywords,
    _customExcludeOtherPhrases: filters.customExcludeOtherPhrases,
  }));
  const evaluatedCandidates = candidatesWithFilters.map((question) => ({
    question,
    filterReasons: questionIdentityKeys(question).some((key) =>
      forcedIdentityKeys.has(key),
    )
      ? []
      : getFilterReasons(question, mode, filters),
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

function normalizeIdentity(value: unknown) {
  return typeof value === "string" && value.trim()
    ? value.trim().toLowerCase()
    : null;
}

function questionIdentityKeys(question: {
  conditionId?: string | null;
  marketId?: string | null;
  slug?: string | null;
  id: string;
}) {
  return [
    question.conditionId,
    question.marketId,
    question.slug,
    question.id,
  ]
    .map(normalizeIdentity)
    .filter((value): value is string => Boolean(value));
}

function positionIdentityKeys(position: BullpenActivePositionView) {
  return [position.conditionId, position.marketId, position.marketSlug, position.slug]
    .map(normalizeIdentity)
    .filter((value): value is string => Boolean(value));
}

function activePositionCandidate(position: BullpenActivePositionView): FilterableBullpenQuestion {
  const id = position.conditionId || position.marketId || position.marketSlug || position.key;
  const publicQuestion: BullpenQuestion = {
    id,
    question: position.marketTitle,
    positionKey: position.key,
    conditionId: position.conditionId,
    marketId: position.marketId,
    closeTime: position.closeTime,
    category: "Active Bullpen Position",
    yesOdds: position.yesOdds,
    noOdds: position.noOdds,
    volume: null,
    liquidity: null,
    sourceUrl: position.marketUrl || POLYMARKET_GAMMA_EVENTS_URL,
    slug: position.marketSlug || position.slug,
    marketUrl: position.marketUrl,
    outcomeLabels: ["Yes", "No"],
    outcomeCount: 2,
    isBinaryYesNo: true,
    daysUntilClose: null,
    rules: position.rules,
    marketContext: position.marketContext,
    resolutionSource: position.resolutionSource,
  };
  return {
    ...publicQuestion,
    _categorySearchText: "",
    _searchText: "",
    _customExcludeSportsKeywords: [],
    _customExcludeWeatherKeywords: [],
    _customExcludeMarketPredictionsKeywords: [],
    _customExcludeTweetCountQuestionsKeywords: [],
    _customExcludeOtherPhrases: [],
  };
}

async function handleScan(
  request: NextRequest,
  activePositions: BullpenActivePositionView[],
) {
  const backendSession = await createBackendSessionContext(request);
  if (!backendSession.hasAuthJsSession || !backendSession.accessToken) {
    return NextResponse.json({ error: "Not authenticated" }, { status: 401 });
  }
  const searchParams = request.nextUrl.searchParams;
  const mode: ScanMode =
    searchParams.get("mode") === "end-of-month" ? "end-of-month" : "30-days";
  const filters = normalizeBullpenScanFilters(mode, searchParams);
  const requestedScannedAt = searchParams.get("scanStartedAt");
  const requestedScannedAtDate = requestedScannedAt
    ? new Date(requestedScannedAt)
    : null;
  const scannedAt =
    requestedScannedAtDate &&
    !Number.isNaN(requestedScannedAtDate.getTime())
      ? requestedScannedAtDate.toISOString()
      : new Date().toISOString();
  const cursor = searchParams.get("scanCursor");
  const requestedExportId = searchParams.get("scanExportId");
  const reapplyExportId = searchParams.get("reapplyExportId");
  const reapplyCursorValue = searchParams.get("reapplyCursor");
  const reapplyCursor = reapplyCursorValue === null
    ? undefined
    : Number.parseInt(reapplyCursorValue, 10);
  const forcedIdentityKeys = new Set(
    activePositions.flatMap(positionIdentityKeys),
  );

  try {
    if (reapplyExportId) {
      const reapplyResult = await reapplyStageOneGammaExportFilters({
        exportId: reapplyExportId,
        ownerKey:
          backendSession.sessionSubject ?? backendSession.sessionGeneration,
        filters,
        cursor: Number.isFinite(reapplyCursor) ? reapplyCursor : undefined,
        evaluate: (candidate, market, event) =>
          getFilterReasons(
            hydrateStoredCandidateForFiltering(candidate, filters, market, event),
            mode,
            filters,
          ),
      });
      const metadata = reapplyResult.metadata;
      if (!reapplyResult.completed) {
        return NextResponse.json(
          {
            status: "reapplying",
            retryAfterMs: 100,
            reapplyCursor: metadata.reapplyState?.processedCount ?? 0,
            processedCandidates: metadata.reapplyState?.processedCount ?? 0,
            totalCandidates: metadata.rowCount,
          },
          { status: 202 },
        );
      }
      return NextResponse.json({
        mode,
        sourceUrl:
          metadata.sourceUrl ?? POLYMARKET_GAMMA_EVENTS_KEYSET_URL,
        sourceLabel: metadata.sourceLabel ?? GAMMA_SOURCE_LABEL,
        scannedAt: new Date().toISOString(),
        filters,
        totalCandidates: metadata.rowCount,
        questions: metadata.acceptedSample ?? [],
        rejectedQuestions: metadata.rejectedSample ?? [],
        totalAcceptedQuestions: metadata.acceptedCount ?? 0,
        totalRejectedQuestions: metadata.rejectedCount ?? 0,
        pagesScanned: metadata.processedPages.length,
        scanExportId: metadata.exportId,
        details:
          "Reapplied saved Stage 1 filters to the existing Full Universe data without fetching Gamma again.",
      });
    }
    const {
      candidates,
      exportCandidates,
      nextCursor,
      retryableFailure,
      retryReason,
    } = await fetchGammaEventPage({
      cursor,
    });

    if (retryableFailure) {
      return NextResponse.json(
        {
          status: "scanning",
          retryAfterMs: 1_000,
          resultChunk: true,
          scanStartedAt: scannedAt,
          nextCursor: cursor,
          scanExportId: requestedExportId,
          retryReason,
          totalCandidates: 0,
          questions: [],
          rejectedQuestions: [],
        },
        { status: 202 },
      );
    }

    const gammaCandidates = Array.from(candidates.values());
    const resultCandidates = nextCursor
      ? gammaCandidates
      : [...gammaCandidates, ...activePositions.map(activePositionCandidate)];
    const result = await buildResponse({
      mode,
      sourceUrl: POLYMARKET_GAMMA_EVENTS_KEYSET_URL,
      sourceLabel: GAMMA_SOURCE_LABEL,
      scannedAt,
      filters,
      candidates: sortQuestions(resultCandidates),
      forcedIdentityKeys,
      ...(nextCursor
        ? {}
        : {
            details:
              "Polymarket Gamma scanned every open parent event, applied the configured window to child markets, and merged active wallet positions.",
          }),
    });
    const acceptedIds = new Set(result.questions.map((question) => question.id));
    const rejectedReasons = new Map(
      result.rejectedQuestions.map((question) => [
        question.id,
        question.filterReasons,
      ]),
    );
    const exportRows: StageOneGammaExportRow[] = exportCandidates.map(
      ({ candidateId, candidate, event, market }) => ({
        candidate: stripFilterMetadata(candidate),
        event,
        market,
        scanStatus: acceptedIds.has(candidateId) ? "passed" : "filtered",
        filterReasons: rejectedReasons.get(candidateId) ?? [],
        forceIncluded: questionIdentityKeys(candidate).some((key) =>
          forcedIdentityKeys.has(key),
        ),
        forceIncludedPosition: questionIdentityKeys(candidate).some((key) =>
          forcedIdentityKeys.has(key),
        ),
      }),
    );
    if (nextCursor === null) {
      for (const position of activePositions) {
        const candidate = activePositionCandidate(position);
        exportRows.push({
          candidate: stripFilterMetadata(candidate),
          event: { source: "active_wallet_position" },
          market: {
            id: position.marketId,
            conditionId: position.conditionId,
            slug: position.marketSlug || position.slug,
            source: "active_wallet_position",
          },
          scanStatus: "passed",
          filterReasons: [],
          forceIncluded: true,
          forceIncludedPosition: true,
        });
      }
    }
    const exportState = request.signal.aborted
      ? { exportId: requestedExportId, rowCount: 0 }
      : await appendStageOneGammaExportPage({
          exportId: requestedExportId,
          ownerKey:
            backendSession.sessionSubject ?? backendSession.sessionGeneration,
          pageKey: cursor || "__FIRST__",
        rows: exportRows,
        completed: nextCursor === null,
        snapshot: {
          mode,
          filters,
          sourceUrl: POLYMARKET_GAMMA_EVENTS_KEYSET_URL,
          sourceLabel: GAMMA_SOURCE_LABEL,
          scannedAt,
        },
      });
    const chunk = {
      ...result,
      resultChunk: true,
      scanStartedAt: scannedAt,
      nextCursor,
      scanExportId: exportState.exportId,
      ...(nextCursor
        ? {
            status: "scanning",
            retryAfterMs: 250,
          }
        : {}),
    };

    return NextResponse.json(chunk, { status: nextCursor ? 202 : 200 });
  } catch (error: unknown) {
    const message =
      error instanceof Error ? error.message : "Complete Gamma scan failed";
    return NextResponse.json(
      {
        mode,
        sourceUrl: POLYMARKET_GAMMA_EVENTS_URL,
        sourceLabel: GAMMA_SOURCE_LABEL,
        scannedAt,
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

export async function GET(request: NextRequest) {
  return handleScan(request, []);
}

export async function POST(request: NextRequest) {
  const payload = (await request.json().catch(() => ({}))) as {
    activePositions?: BullpenActivePositionView[];
  };
  return handleScan(
    request,
    Array.isArray(payload.activePositions) ? payload.activePositions.slice(0, 250) : [],
  );
}
