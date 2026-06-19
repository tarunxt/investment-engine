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

const execFileAsync = promisify(execFile);

const TRENDING_URL = "https://app.bullpen.fi/predictions/trending?ref=intrepid-crane-3";
const CALENDAR_URL = "https://app.bullpen.fi/predictions/trending?primaryMode=calendar&ref=intrepid-crane-3";
const CLI_SOURCE_URL = "bullpen polymarket discover";
const EXCLUDED_CATEGORIES = ["sport", "sports", "esport", "weather", "market", "crypto"];
const END_OF_MONTH_DATE = "2026-06-30";
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
  }
  return null;
}

function readNumber(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value === "string") {
      const parsed = Number(value.replace(/[%x,$,]/g, ""));
      if (Number.isFinite(parsed)) return parsed;
    }
  }
  return null;
}

function walk(value: unknown, visit: (record: Record<string, unknown>) => void) {
  if (!value || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item) => walk(item, visit));
    return;
  }
  const record = value as Record<string, unknown>;
  visit(record);
  Object.values(record).forEach((child) => walk(child, visit));
}

function extractEmbeddedJson(html: string) {
  const scripts = [
    ...html.matchAll(/<script[^>]+id=["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/gi),
    ...html.matchAll(/<script[^>]+type=["']application\/json["'][^>]*>([\s\S]*?)<\/script>/gi),
  ];

  return scripts.flatMap((match) => {
    try {
      return [JSON.parse(match[1])];
    } catch {
      return [];
    }
  });
}

function normalizeQuestion(record: Record<string, unknown>, sourceUrl: string): BullpenQuestion | null {
  const question = readString(record, ["question", "title", "name", "eventTitle", "marketQuestion"]);
  if (!question || question.length < 8) return null;

  const category = readString(record, ["category", "categorySlug", "type", "topic", "primaryCategory"]) || "Uncategorized";
  const outcomes = toArray(record.outcomes || record.options || record.markets).map((item) =>
    typeof item === "string" ? item : readString((item || {}) as Record<string, unknown>, ["name", "label", "outcome", "title"]),
  ).filter(Boolean) as string[];
  const hasBinaryOutcomes = outcomes.length === 0 || (
    outcomes.length === 2 && outcomes.some((item) => /^yes$/i.test(item)) && outcomes.some((item) => /^no$/i.test(item))
  );
  if (!hasBinaryOutcomes) return null;

  const yesOdds = readNumber(record, ["yesOdds", "yes_odd", "yesPrice", "yes", "bestYesOdds", "probabilityYes"]);
  const noOdds = readNumber(record, ["noOdds", "no_odd", "noPrice", "no", "bestNoOdds", "probabilityNo"]);
  const closeTime = readString(record, ["closeTime", "closingTime", "endDate", "end_date", "endTime", "resolutionDate"]);
  const id = readString(record, ["id", "slug", "marketId", "eventId"]) || `${question}-${closeTime || "unknown"}`;

  return {
    id,
    question,
    closeTime,
    category,
    yesOdds,
    noOdds,
    volume: readString(record, ["volume", "volume24hr", "volume24h", "totalVolume"]),
    liquidity: readString(record, ["liquidity", "liquidityNum"]),
    sourceUrl,
  };
}

function passesFilters(question: BullpenQuestion, mode: ScanMode) {
  const categoryText = `${question.category} ${question.question}`.toLowerCase();
  if (EXCLUDED_CATEGORIES.some((category) => categoryText.includes(category))) return false;
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
  return closeDate.getTime() > now.getTime() && closeDate.getTime() - now.getTime() < thirtyDays;
}

function collectQuestions(payloads: unknown[], sourceUrl: string, mode: ScanMode, limit: number) {
  const candidates = new Map<string, BullpenQuestion>();
  for (const payload of payloads) {
    walk(payload, (record) => {
      const normalized = normalizeQuestion(record, sourceUrl);
      if (normalized && passesFilters(normalized, mode)) candidates.set(normalized.id, normalized);
    });
  }
  return Array.from(candidates.values()).slice(0, limit);
}

function bullpenProcessEnv() {
  const env: NodeJS.ProcessEnv = { ...process.env, BULLPEN_READ_ONLY: "true", BULLPEN_NON_INTERACTIVE: "true" };
  if (process.env.BULLPEN_HOME) env.HOME = process.env.BULLPEN_HOME;
  return env;
}

async function runBullpenDiscover(limit: number) {
  const errors: string[] = [];
  const commandVariants = [
    ["polymarket", "discover", "--sort", "ending-soon", "--limit", String(limit), "--output", "json"],
    ["polymarket", "discover", "--sort", "ending-soon", "--limit", String(limit), "--json"],
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
        errors.push(error instanceof Error ? `${command}: ${error.message}` : `${command}: failed`);
      }
    }
  }
  throw new Error(`Bullpen CLI scan failed (${errors.join("; ")})`);
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
  const mode = searchParams.get("mode") === "end-of-month" ? "end-of-month" : "30-days";
  const limit = Math.min(Math.max(Number(searchParams.get("limit")) || 100, 1), 500);
  const sourceUrl = mode === "end-of-month" ? CALENDAR_URL : TRENDING_URL;
  const scannedAt = new Date().toISOString();

  try {
    const cliPayload = await runBullpenDiscover(Math.max(limit, 100));
    return NextResponse.json({
      mode,
      sourceUrl: CLI_SOURCE_URL,
      limit,
      scannedAt,
      questions: collectQuestions([cliPayload], CLI_SOURCE_URL, mode, limit),
    });
  } catch (cliError) {
    try {
      const html = await fetchBullpenPage(sourceUrl);
      return NextResponse.json({
        mode,
        sourceUrl,
        limit,
        scannedAt,
        questions: collectQuestions(extractEmbeddedJson(html), sourceUrl, mode, limit),
        warning: cliError instanceof Error ? cliError.message : "Bullpen CLI scan failed",
      });
    } catch (webError) {
      return NextResponse.json(
        {
          mode,
          sourceUrl,
          limit,
          scannedAt,
          questions: [],
          error: webError instanceof Error ? webError.message : "Unable to scan Bullpen",
          details: cliError instanceof Error ? cliError.message : "Bullpen CLI scan failed",
        },
        { status: 502 },
      );
    }
  }
}
