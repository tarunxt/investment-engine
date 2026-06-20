import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextRequest, NextResponse } from "next/server";

import { buildPolymarketEventUrl } from "../_lib/polymarketMarketUrls";
import { resolvePolymarketMarkets } from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);
const BULLPEN_BIN_CANDIDATES = [
  process.env.BULLPEN_BIN,
  "/usr/local/bin/bullpen",
  "/home/investor/.bullpen/bin/bullpen",
  "/home/appuser/.bullpen/bin/bullpen",
  "bullpen",
].filter((candidate): candidate is string => Boolean(candidate));

type LookupQuestion = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  question: string | null;
};

function normalizeLookupQuestion(value: unknown): LookupQuestion | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const id =
    typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
  if (!id) return null;

  return {
    id,
    slug:
      typeof record.slug === "string" && record.slug.trim()
        ? record.slug.trim()
        : null,
    marketUrl:
      typeof record.marketUrl === "string" && record.marketUrl.trim()
        ? record.marketUrl.trim()
        : null,
    question:
      typeof record.question === "string" && record.question.trim()
        ? record.question.trim()
        : null,
  };
}

function parseBullpenJsonOutput(stdout: string) {
  const sanitized = stdout
    .split(/\r?\n/)
    .filter((line) => line.trim() && !line.startsWith("Update available:"))
    .join("\n");

  return JSON.parse(sanitized);
}

function normalizeQuestionText(value: string) {
  return value.trim().toLowerCase().replace(/\s+/g, " ");
}

async function searchBullpenMarketByQuestion(question: string) {
  const normalizedQuestion = normalizeQuestionText(question);

  for (const candidate of BULLPEN_BIN_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        candidate,
        ["polymarket", "search", question, "--output", "json"],
        {
          env: {
            ...process.env,
            BULLPEN_READ_ONLY: "true",
            BULLPEN_NON_INTERACTIVE: "true",
          },
          timeout: 20_000,
          maxBuffer: 5 * 1024 * 1024,
        },
      );
      const payload = parseBullpenJsonOutput(stdout) as {
        events?: Array<{
          slug?: string | null;
          markets?: Array<{
            question?: string | null;
            slug?: string | null;
            outcomes?: Array<{
              name?: string | null;
              price?: number | null;
              probability?: number | null;
            }>;
          }>;
        }>;
      };
      const markets = payload.events?.flatMap((event) =>
        (event.markets || []).map((market) => ({
          ...market,
          eventSlug: event.slug || null,
        })),
      );
      const matchedMarket = markets?.find(
        (market) =>
          typeof market.question === "string" &&
          normalizeQuestionText(market.question) === normalizedQuestion,
      );
      if (!matchedMarket || !matchedMarket.slug) {
        continue;
      }

      const yesOutcome = matchedMarket.outcomes?.find(
        (outcome) => normalizeQuestionText(outcome.name || "") === "yes",
      );
      const noOutcome = matchedMarket.outcomes?.find(
        (outcome) => normalizeQuestionText(outcome.name || "") === "no",
      );
      const toPercent = (value: number | null | undefined) =>
        typeof value === "number" ? Number((value * 100).toFixed(2)) : null;

      return {
        id: matchedMarket.slug,
        slug: matchedMarket.slug,
        marketUrl: buildPolymarketEventUrl(matchedMarket.eventSlug || null),
        yesOdds: toPercent(yesOutcome?.price ?? yesOutcome?.probability),
        noOdds: toPercent(noOutcome?.price ?? noOutcome?.probability),
      };
    } catch {
      continue;
    }
  }

  return null;
}

export async function POST(request: NextRequest) {
  try {
    const body = (await request.json()) as {
      questions?: unknown[];
    };
    const questions = Array.isArray(body.questions)
      ? body.questions
          .map((question) => normalizeLookupQuestion(question))
          .filter((question): question is LookupQuestion => Boolean(question))
      : [];

    if (questions.length === 0) {
      return NextResponse.json({
        markets: {},
        unresolvedQuestionIds: [],
      });
    }

    const resolvedByQuestionId = await resolvePolymarketMarkets(questions);
    const unresolvedQuestions = questions.filter(
      (question) => !resolvedByQuestionId[question.id],
    );
    for (const question of unresolvedQuestions) {
      if (!question.question) continue;
      const searchedMarket = await searchBullpenMarketByQuestion(question.question);
      if (searchedMarket) {
        resolvedByQuestionId[question.id] = searchedMarket;
      }
    }
    const unresolvedQuestionIds = questions
      .map((question) => question.id)
      .filter((questionId) => !resolvedByQuestionId[questionId]);

    return NextResponse.json({
      markets: resolvedByQuestionId,
      unresolvedQuestionIds,
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to refresh current Polymarket odds.",
      },
      { status: 400 },
    );
  }
}
