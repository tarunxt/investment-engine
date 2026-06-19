import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import {
  BULLPEN_SOURCE_URLS,
  normalizeBullpenScanFilters,
  type BullpenQuestion,
  type BullpenScanFilters,
  type ScanMode,
} from "@/lib/bullpen-ai";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type WalkContext = {
  closeTime: string | null;
  category: string | null;
};

const execFileAsync = promisify(execFile);

const CLI_SOURCE_LABEL = "Bullpen CLI";
const WEB_SOURCE_LABEL = "Bullpen trending page";
const GAMMA_SOURCE_LABEL = "Polymarket Gamma API";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event";
const CLI_DISCOVER_LIMIT = 1_000;
const DISCOVER_FALLBACK_LIMIT = 10_000;
const GAMMA_PAGE_SIZE = 500;
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
const SLUG_KEYS = [
  "slug",
  "marketSlug",
  "questionSlug",
  "eventSlug",
  "urlSlug",
];
const OUTCOME_LABEL_KEYS = ["name", "label", "outcome", "title", "side"];
const SPORTS_KEYWORDS = [
  "sports",
  "nba",
  "nfl",
  "mlb",
  "nhl",
  "ncaa",
  "soccer",
  "football",
  "baseball",
  "basketball",
  "cricket",
  "tennis",
  "golf",
  "mma",
  "ufc",
  "boxing",
  "formula 1",
  "f1",
  "world cup",
  "premier league",
  "champions league",
  "la liga",
];
const WEATHER_KEYWORDS = [
  "weather",
  "temperature",
  "rain",
  "snow",
  "hurricane",
  "storm",
  "tornado",
  "heatwave",
  "forecast",
  "climate",
  "wind",
  "precipitation",
  "monsoon",
];
const MARKET_CATEGORY_KEYWORDS = [
  "finance",
  "business",
  "markets",
  "crypto",
  "economy",
  "economics",
  "stocks",
  "commodities",
  "forex",
];
const MARKET_QUESTION_KEYWORDS = [
  "bitcoin",
  "ethereum",
  "solana",
  "dogecoin",
  "memecoin",
  "crypto",
  "stock",
  "stocks",
  "share price",
  "nasdaq",
  "s&p",
  "dow",
  "oil",
  "gold",
  "silver",
  "yield",
  "bond",
  "bonds",
  "commodity",
  "commodities",
  "forex",
  "inflation",
  "interest rate",
  "fed",
  "etf",
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
const BULLPEN_BIN_CANDIDATES = [
  process.env.BULLPEN_BIN,
  "/usr/local/bin/bullpen",
  "/home/investor/.bullpen/bin/bullpen",
  "/home/appuser/.bullpen/bin/bullpen",
  "bullpen",
].filter((candidate): candidate is string => Boolean(candidate));

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

function readDeepString(
  value: unknown,
  keys: string[],
): string | null {
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
    for (const item of [...toArray(collection), ...parseJsonArray(collection)]) {
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
    category: readString(record, CATEGORY_KEYS) || context.category,
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
    for (const item of [...toArray(collection), ...parseJsonArray(collection)]) {
      if (typeof item === "string" && item.trim()) {
        labels.push(item.trim());
        continue;
      }
      if (!item || typeof item !== "object") continue;
      const label = readString(item as Record<string, unknown>, OUTCOME_LABEL_KEYS);
      if (label) labels.push(label);
    }
  }

  return dedupeOutcomeLabels(labels);
}

function isBinaryYesNoQuestion(outcomeLabels: string[], yesOdds: number | null, noOdds: number | null) {
  if (outcomeLabels.length === 0) return yesOdds !== null && noOdds !== null;
  if (outcomeLabels.length !== 2) return false;
  const normalized = outcomeLabels.map(normalizeLabel);
  return normalized.includes("yes") && normalized.includes("no");
}

function buildMarketUrl(slug: string | null) {
  if (!slug) return null;
  return `${POLYMARKET_EVENT_BASE_URL}/${slug}`;
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

function inferSemanticCloseTime(record: Record<string, unknown>, question: string) {
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

function chooseCloseTime(rawCloseTime: string | null, semanticCloseTime: string | null) {
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

function includesAnyKeyword(text: string, keywords: string[]) {
  return keywords.some((keyword) => matchesKeyword(text, keyword));
}

function getQuestionSearchText(question: BullpenQuestion) {
  return [
    question.question,
    question.category,
    question.slug,
    question.outcomeLabels.join(" "),
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function isSportsQuestion(question: BullpenQuestion) {
  return includesAnyKeyword(getQuestionSearchText(question), SPORTS_KEYWORDS);
}

function isWeatherQuestion(question: BullpenQuestion) {
  return includesAnyKeyword(getQuestionSearchText(question), WEATHER_KEYWORDS);
}

function isMarketPredictionQuestion(question: BullpenQuestion) {
  const searchText = getQuestionSearchText(question);
  return (
    includesAnyKeyword(question.category.toLowerCase(), MARKET_CATEGORY_KEYWORDS) ||
    includesAnyKeyword(searchText, MARKET_QUESTION_KEYWORDS)
  );
}

function sortQuestions(questions: BullpenQuestion[]) {
  return [...questions].sort((left, right) => {
    const leftTime = left.closeTime ? new Date(left.closeTime).getTime() : Number.POSITIVE_INFINITY;
    const rightTime = right.closeTime ? new Date(right.closeTime).getTime() : Number.POSITIVE_INFINITY;

    if (leftTime !== rightTime) return leftTime - rightTime;
    return left.question.localeCompare(right.question);
  });
}

function normalizeGammaMarket(
  record: Record<string, unknown>,
  sourceUrl: string,
): BullpenQuestion | null {
  const question = readString(record, QUESTION_KEYS);
  if (!question || question.length < 8) return null;

  const outcomeLabels = readOutcomeLabels(record);
  const outcomePrices = parseJsonArray(record.outcomePrices)
    .map((value) => parseNumber(value))
    .filter((value): value is number => value !== null);
  const normalizedOutcomeLabels = outcomeLabels.map(normalizeLabel);
  const yesIndex = normalizedOutcomeLabels.findIndex((outcome) => outcome === "yes");
  const noIndex = normalizedOutcomeLabels.findIndex((outcome) => outcome === "no");
  const yesPrice = yesIndex >= 0 ? outcomePrices[yesIndex] : null;
  const noPrice = noIndex >= 0 ? outcomePrices[noIndex] : null;
  const yesOdds = normalizeOdds(yesPrice);
  const noOdds = normalizeOdds(noPrice);
  const slug = readString(record, SLUG_KEYS);
  const closeTime = chooseCloseTime(
    readString(record, CLOSE_TIME_KEYS),
    inferSemanticCloseTime(record, question),
  );

  return {
    id: readString(record, ["id", ...SLUG_KEYS, "marketId", "conditionId"]) || question,
    question,
    closeTime,
    category: readString(record, CATEGORY_KEYS) || "Uncategorized",
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
    marketUrl: buildMarketUrl(slug),
    outcomeLabels,
    outcomeCount:
      outcomeLabels.length > 0
        ? outcomeLabels.length
        : yesOdds !== null && noOdds !== null
          ? 2
          : null,
    isBinaryYesNo: isBinaryYesNoQuestion(outcomeLabels, yesOdds, noOdds),
    daysUntilClose: getDaysUntilClose(closeTime),
  };
}

function normalizeQuestion(
  record: Record<string, unknown>,
  sourceUrl: string,
  context: WalkContext,
): BullpenQuestion | null {
  const question = readString(record, QUESTION_KEYS);
  if (!question || question.length < 8) return null;

  const category =
    readString(record, CATEGORY_KEYS) || context.category || "Uncategorized";
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
  const slug = readString(record, SLUG_KEYS) || readDeepString(record, SLUG_KEYS);
  const outcomeLabels = readOutcomeLabels(record);
  const id =
    readString(record, ["id", ...SLUG_KEYS, "marketId", "eventId", "conditionId"]) ||
    `${question}-${closeTime || "unknown"}`;

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
    marketUrl: buildMarketUrl(slug),
    outcomeLabels,
    outcomeCount:
      outcomeLabels.length > 0
        ? outcomeLabels.length
        : yesOdds !== null && noOdds !== null
          ? 2
          : null,
    isBinaryYesNo: isBinaryYesNoQuestion(outcomeLabels, yesOdds, noOdds),
    daysUntilClose: getDaysUntilClose(closeTime),
  };
}

function passesTimeFilter(question: BullpenQuestion, mode: ScanMode, filters: BullpenScanFilters) {
  if (!question.closeTime) return false;
  const closeDate = new Date(question.closeTime);
  if (Number.isNaN(closeDate.getTime())) return false;

  if (mode === "end-of-month") {
    return getDateKey(question.closeTime) === filters.targetDate;
  }

  const difference = closeDate.getTime() - Date.now();
  return difference > 0 && difference <= filters.maxClosingDays * MILLISECONDS_PER_DAY;
}

function passesFilters(question: BullpenQuestion, mode: ScanMode, filters: BullpenScanFilters) {
  if (!passesTimeFilter(question, mode, filters)) return false;
  if (filters.excludeSports && isSportsQuestion(question)) return false;
  if (filters.excludeWeather && isWeatherQuestion(question)) return false;
  if (filters.excludeMarketPredictions && isMarketPredictionQuestion(question))
    return false;
  if (filters.onlyBinaryYesNo && !question.isBinaryYesNo) return false;
  if (filters.minYesOdds > 0 && (question.yesOdds === null || question.yesOdds < filters.minYesOdds))
    return false;
  if (filters.minNoOdds > 0 && (question.noOdds === null || question.noOdds < filters.minNoOdds))
    return false;
  return true;
}

function collectQuestions(payloads: unknown[], sourceUrl: string) {
  const candidates = new Map<string, BullpenQuestion>();
  for (const payload of payloads) {
    walk(payload, (record, context) => {
      const normalized = normalizeQuestion(record, sourceUrl, context);
      if (normalized) candidates.set(normalized.id, normalized);
    });
  }
  return sortQuestions(Array.from(candidates.values()));
}

function applyFilters(
  candidates: BullpenQuestion[],
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  return sortQuestions(
    candidates.filter((question) => passesFilters(question, mode, filters)),
  );
}

function sourceHasFutureCandidates(candidates: BullpenQuestion[]) {
  return candidates.some((candidate) => {
    const closeDate = toValidDate(candidate.closeTime);
    return closeDate !== null && closeDate.getTime() >= Date.now();
  });
}

function parseBullpenJsonOutput(stdout: string) {
  const sanitized = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("Update available:"))
    .join("\n");

  return JSON.parse(sanitized);
}

function bullpenProcessEnv() {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    BULLPEN_READ_ONLY: "true",
    BULLPEN_NON_INTERACTIVE: "true",
  };
  if (process.env.BULLPEN_HOME) env.HOME = process.env.BULLPEN_HOME;
  return env;
}

async function runBullpenDiscover() {
  const errors: string[] = [];
  const commandVariants = [
    [
      "polymarket",
      "discover",
      "--status",
      "active",
      "--limit",
      String(CLI_DISCOVER_LIMIT),
      "--output",
      "json",
    ],
    [
      "polymarket",
      "discover",
      "--status",
      "active",
      "--sort",
      "newest",
      "--limit",
      String(CLI_DISCOVER_LIMIT),
      "--output",
      "json",
    ],
  ];

  for (const candidate of BULLPEN_BIN_CANDIDATES) {
    for (const args of commandVariants) {
      try {
        const { stdout } = await execFileAsync(candidate, args, {
          env: bullpenProcessEnv(),
          timeout: 25_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return parseBullpenJsonOutput(stdout);
      } catch (error) {
        const command = `${candidate} ${args.join(" ")}`;
        errors.push(
          error instanceof Error
            ? `${command}: ${error.message}`
            : `${command}: failed`,
        );
      }
    }
  }

  throw new Error(`Bullpen CLI scan failed (${errors.join("; ")})`);
}

async function fetchGammaMarkets(
  mode: ScanMode,
  filters: BullpenScanFilters,
) {
  const candidates = new Map<string, BullpenQuestion>();
  let offset = 0;

  while (offset < DISCOVER_FALLBACK_LIMIT) {
    const params = new URLSearchParams({
      active: "true",
      archived: "false",
      closed: "false",
      limit: String(GAMMA_PAGE_SIZE),
      offset: String(offset),
      order: "endDate",
      ascending: "true",
    });

    const response = await fetch(
      `${POLYMARKET_GAMMA_MARKETS_URL}?${params.toString()}`,
      {
        cache: "no-store",
        headers: { accept: "application/json" },
      },
    );

    if (!response.ok) {
      throw new Error(`Polymarket Gamma returned HTTP ${response.status}`);
    }

    const payload = await response.json();
    const rows = Array.isArray(payload) ? payload : [];
    for (const row of rows) {
      if (!row || typeof row !== "object") continue;
      const normalized = normalizeGammaMarket(
        row as Record<string, unknown>,
        POLYMARKET_GAMMA_MARKETS_URL,
      );
      if (normalized) candidates.set(normalized.id, normalized);
    }

    if (rows.length < GAMMA_PAGE_SIZE) break;
    offset += GAMMA_PAGE_SIZE;

    const earliestOutsideWindow = rows.every((row) => {
      if (!row || typeof row !== "object") return false;
      const closeTime = readString(
        row as Record<string, unknown>,
        CLOSE_TIME_KEYS,
      );
      if (!closeTime) return false;
      const closeDate = new Date(closeTime);
      if (Number.isNaN(closeDate.getTime())) return false;

      if (mode === "end-of-month") {
        const targetDate = filters.targetDate;
        const rowDate = getDateKey(closeTime);
        return rowDate !== null && rowDate > targetDate;
      }

      return (
        closeDate.getTime() - Date.now() >=
        filters.maxClosingDays * MILLISECONDS_PER_DAY
      );
    });

    if (earliestOutsideWindow) break;
  }

  return sortQuestions(Array.from(candidates.values()));
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

function buildResponse({
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
  candidates: BullpenQuestion[];
  warning?: string;
  details?: string;
}) {
  return {
    mode,
    sourceUrl,
    sourceLabel,
    scannedAt,
    filters,
    totalCandidates: candidates.length,
    questions: applyFilters(candidates, mode, filters),
    ...(warning ? { warning } : {}),
    ...(details ? { details } : {}),
  };
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode: ScanMode =
    searchParams.get("mode") === "end-of-month" ? "end-of-month" : "30-days";
  const filters = normalizeBullpenScanFilters(mode, searchParams);
  const sourceUrl = BULLPEN_SOURCE_URLS[mode];
  const scannedAt = new Date().toISOString();

  try {
    const cliPayload = await runBullpenDiscover();
    const candidates = collectQuestions([cliPayload], sourceUrl);
    if (!sourceHasFutureCandidates(candidates)) {
      throw new Error("Bullpen CLI returned stale markets with past close dates");
    }
    if (candidates.length > 0) {
      return NextResponse.json(
        buildResponse({
          mode,
          sourceUrl,
          sourceLabel: CLI_SOURCE_LABEL,
          scannedAt,
          filters,
          candidates,
        }),
      );
    }
    throw new Error("Bullpen CLI returned no discoverable markets");
  } catch (cliError) {
    try {
      const html = await fetchBullpenPage(sourceUrl);
      const candidates = collectQuestions(extractEmbeddedJson(html), sourceUrl);
      if (!sourceHasFutureCandidates(candidates)) {
        throw new Error("Bullpen web returned stale markets with past close dates");
      }
      if (candidates.length > 0) {
        return NextResponse.json(
          buildResponse({
            mode,
            sourceUrl,
            sourceLabel: WEB_SOURCE_LABEL,
            scannedAt,
            filters,
            candidates,
            warning:
              cliError instanceof Error
                ? `Using Bullpen web fallback because the CLI scan failed. ${cliError.message}`
                : "Using Bullpen web fallback because the CLI scan failed.",
          }),
        );
      }
      throw new Error("Bullpen web returned no discoverable markets");
    } catch (webError) {
      try {
        const candidates = await fetchGammaMarkets(mode, filters);
        if (candidates.length > 0) {
          return NextResponse.json(
            buildResponse({
              mode,
              sourceUrl: POLYMARKET_GAMMA_MARKETS_URL,
              sourceLabel: GAMMA_SOURCE_LABEL,
              scannedAt,
              filters,
              candidates,
              warning:
                "Using Polymarket Gamma API fallback because Bullpen sources were unavailable.",
              details: [
                cliError instanceof Error
                  ? cliError.message
                  : "Bullpen CLI scan failed",
                webError instanceof Error
                  ? webError.message
                  : "Bullpen web scan failed",
              ].join("; "),
            }),
          );
        }
        throw new Error("Polymarket Gamma returned no discoverable markets");
      } catch (gammaError) {
        return NextResponse.json(
          {
            mode,
            sourceUrl,
            sourceLabel: WEB_SOURCE_LABEL,
            scannedAt,
            filters,
            totalCandidates: 0,
            questions: [],
            error:
              gammaError instanceof Error
                ? gammaError.message
                : "Unable to scan prediction markets",
            details: [
              cliError instanceof Error
                ? cliError.message
                : "Bullpen CLI scan failed",
              webError instanceof Error
                ? webError.message
                : "Bullpen web scan failed",
            ].join("; "),
          },
          { status: 502 },
        );
      }
    }
  }
}
