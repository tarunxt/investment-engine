import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type BullpenQuestion = {
  id: string;
  question: string;
  closeTime: string | null;
  category: string;
  yesOdds: number | null;
  noOdds: number | null;
  volume: string | null;
  liquidity: string | null;
  sourceUrl: string;
};

type ScanMode = "30-days" | "end-of-month";
type WalkContext = {
  closeTime: string | null;
  category: string | null;
};

const execFileAsync = promisify(execFile);

const TRENDING_URL =
  "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3";
const CALENDAR_URL =
  "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3";
const CLI_SOURCE_URL = "bullpen polymarket discover";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const GAMMA_SOURCE_URL = "Polymarket Gamma API";
const EXCLUDED_CATEGORIES = [
  "sport",
  "sports",
  "esport",
  "weather",
  "market",
  "crypto",
];
const END_OF_MONTH_DATE = "2026-06-30";
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
      const label = readString(outcome, [
        "name",
        "label",
        "outcome",
        "title",
        "side",
      ]);
      if (!label || label.toLowerCase() !== outcomeName) continue;
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
  if (value === null || value <= 0) return null;
  return value <= 1 ? 1 / value : value;
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

function normalizeGammaMarket(
  record: Record<string, unknown>,
): BullpenQuestion | null {
  const question = readString(record, [
    "question",
    "title",
    "name",
    "eventTitle",
    "marketQuestion",
  ]);
  if (!question || question.length < 8) return null;

  const outcomes = parseJsonArray(record.outcomes).map(String);
  const outcomePrices = parseJsonArray(record.outcomePrices)
    .map((value) => parseNumber(value))
    .filter((value): value is number => value !== null);
  const yesIndex = outcomes.findIndex((outcome) => /^yes$/i.test(outcome));
  const noIndex = outcomes.findIndex((outcome) => /^no$/i.test(outcome));
  const yesPrice = yesIndex >= 0 ? outcomePrices[yesIndex] : null;
  const noPrice = noIndex >= 0 ? outcomePrices[noIndex] : null;

  return {
    id:
      readString(record, ["id", "slug", "marketId", "conditionId"]) || question,
    question,
    closeTime: readString(record, CLOSE_TIME_KEYS),
    category: readString(record, CATEGORY_KEYS) || "Uncategorized",
    yesOdds: normalizeOdds(yesPrice),
    noOdds: normalizeOdds(noPrice),
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
    sourceUrl: GAMMA_SOURCE_URL,
  };
}

function normalizeQuestion(
  record: Record<string, unknown>,
  sourceUrl: string,
  context: WalkContext,
): BullpenQuestion | null {
  const question = readString(record, [
    "question",
    "title",
    "name",
    "eventTitle",
    "marketQuestion",
  ]);
  if (!question || question.length < 8) return null;

  const category =
    readString(record, CATEGORY_KEYS) || context.category || "Uncategorized";
  const outcomes = [
    ...toArray(record.outcomes || record.options || record.markets),
    ...parseJsonArray(record.outcomes || record.options || record.markets),
  ]
    .map((item) =>
      typeof item === "string"
        ? item
        : readString((item || {}) as Record<string, unknown>, [
            "name",
            "label",
            "outcome",
            "title",
          ]),
    )
    .filter(Boolean) as string[];
  const hasBinaryOutcomes =
    outcomes.length === 0 ||
    (outcomes.length === 2 &&
      outcomes.some((item) => /^yes$/i.test(item)) &&
      outcomes.some((item) => /^no$/i.test(item)));
  if (!hasBinaryOutcomes) return null;

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
  const closeTime = readString(record, CLOSE_TIME_KEYS) || context.closeTime;
  const id =
    readString(record, ["id", "slug", "marketId", "eventId", "conditionId"]) ||
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
  };
}

function passesFilters(question: BullpenQuestion, mode: ScanMode) {
  const categoryText =
    `${question.category} ${question.question}`.toLowerCase();
  if (EXCLUDED_CATEGORIES.some((category) => categoryText.includes(category)))
    return false;
  if (question.yesOdds !== null && question.yesOdds <= 5) return false;
  if (question.noOdds !== null && question.noOdds <= 5) return false;

  if (!question.closeTime) return mode === "30-days";
  const closeDate = new Date(question.closeTime);
  if (Number.isNaN(closeDate.getTime())) return mode === "30-days";

  if (mode === "end-of-month") {
    return closeDate.toISOString().slice(0, 10) === END_OF_MONTH_DATE;
  }

  const now = new Date();
  const thirtyDays = 30 * 24 * 60 * 60 * 1000;
  return (
    closeDate.getTime() > now.getTime() &&
    closeDate.getTime() - now.getTime() < thirtyDays
  );
}

function collectQuestions(
  payloads: unknown[],
  sourceUrl: string,
  mode: ScanMode,
  limit: number,
) {
  const candidates = new Map<string, BullpenQuestion>();
  for (const payload of payloads) {
    walk(payload, (record, context) => {
      const normalized = normalizeQuestion(record, sourceUrl, context);
      if (normalized && passesFilters(normalized, mode))
        candidates.set(normalized.id, normalized);
    });
  }
  return Array.from(candidates.values()).slice(0, limit);
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

async function runBullpenDiscover(limit: number) {
  const errors: string[] = [];
  const commandVariants = [
    [
      "polymarket",
      "discover",
      "--sort",
      "ending-soon",
      "--limit",
      String(limit),
      "--output",
      "json",
    ],
    [
      "polymarket",
      "discover",
      "--sort",
      "ending-soon",
      "--limit",
      String(limit),
      "--json",
    ],
    ["polymarket", "discover", "--limit", String(limit), "--output", "json"],
    ["polymarket", "discover", "--limit", String(limit), "--json"],
  ];

  for (const candidate of BULLPEN_BIN_CANDIDATES) {
    for (const args of commandVariants) {
      try {
        const { stdout } = await execFileAsync(candidate, args, {
          env: bullpenProcessEnv(),
          timeout: 25_000,
          maxBuffer: 10 * 1024 * 1024,
        });
        return JSON.parse(stdout);
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

async function fetchGammaMarkets(mode: ScanMode, limit: number) {
  const params = new URLSearchParams({
    active: "true",
    archived: "false",
    closed: "false",
    limit: String(Math.max(limit, 500)),
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
  const candidates = new Map<string, BullpenQuestion>();
  for (const row of rows) {
    if (!row || typeof row !== "object") continue;
    const normalized = normalizeGammaMarket(row as Record<string, unknown>);
    if (normalized && passesFilters(normalized, mode))
      candidates.set(normalized.id, normalized);
  }
  return Array.from(candidates.values()).slice(0, limit);
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

  return response.text();
}

export async function GET(request: NextRequest) {
  const searchParams = request.nextUrl.searchParams;
  const mode =
    searchParams.get("mode") === "end-of-month" ? "end-of-month" : "30-days";
  const limit = Math.min(
    Math.max(Number(searchParams.get("limit")) || 100, 1),
    500,
  );
  const sourceUrl = mode === "end-of-month" ? CALENDAR_URL : TRENDING_URL;
  const scannedAt = new Date().toISOString();

  try {
    const cliPayload = await runBullpenDiscover(Math.max(limit, 500));
    const questions = collectQuestions(
      [cliPayload],
      CLI_SOURCE_URL,
      mode,
      limit,
    );
    if (questions.length > 0 || mode === "30-days") {
      return NextResponse.json({
        mode,
        sourceUrl: CLI_SOURCE_URL,
        limit,
        scannedAt,
        questions,
      });
    }
    throw new Error("Bullpen CLI returned no June 30 calendar results");
  } catch (cliError) {
    try {
      const html = await fetchBullpenPage(sourceUrl);
      const questions = collectQuestions(
        extractEmbeddedJson(html),
        sourceUrl,
        mode,
        limit,
      );
      return NextResponse.json({
        mode,
        sourceUrl,
        limit,
        scannedAt,
        questions,
        warning: questions.length === 0
          ? "No eligible prediction markets matched the current Bullpen scan filters"
          : cliError instanceof Error
            ? cliError.message
            : "Bullpen CLI scan failed",
      });
    } catch (webError) {
      try {
        const questions = await fetchGammaMarkets(mode, limit);
        return NextResponse.json({
          mode,
          sourceUrl: GAMMA_SOURCE_URL,
          limit,
          scannedAt,
          questions,
          warning: questions.length === 0
            ? "No eligible prediction markets matched the current Bullpen scan filters"
            : webError instanceof Error
              ? webError.message
              : "Bullpen web scan failed",
        });
      } catch (gammaError) {
        return NextResponse.json(
          {
            mode,
            sourceUrl,
            limit,
            scannedAt,
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
