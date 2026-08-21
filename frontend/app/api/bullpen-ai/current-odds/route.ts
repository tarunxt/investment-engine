import { NextRequest, NextResponse } from "next/server";

import { shouldReplaceCategory } from "../_lib/polymarketCategory";
import { resolvePolymarketMarketsWithQuestionFallback } from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LookupQuestion = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  question: string | null;
  category: string | null;
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
    category:
      typeof record.category === "string" && record.category.trim()
        ? record.category.trim()
        : null,
  };
}

function logResolvedCategory(
  question: LookupQuestion,
  resolved: {
    slug: string | null;
    marketUrl: string | null;
    category: string | null;
  } | null,
) {
  if (process.env.BULLPEN_AI_DEBUG_CATEGORIES !== "1") return;
  if (!shouldReplaceCategory(question.category, resolved?.category ?? null)) return;

  console.info("[bullpen-ai:category-debug]", {
    questionId: question.id,
    title: question.question,
    originalCategory: question.category,
    resolvedCategory: resolved?.category ?? null,
    slug: resolved?.slug ?? question.slug,
    marketUrl: resolved?.marketUrl ?? question.marketUrl,
  });
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

    const resolvedByQuestionId =
      await resolvePolymarketMarketsWithQuestionFallback(questions);
    questions.forEach((question) => {
      const resolved = resolvedByQuestionId[question.id];
      logResolvedCategory(question, resolved ?? null);
    });
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
