import { NextRequest, NextResponse } from "next/server";

import { resolvePolymarketMarketsWithQuestionFallback } from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

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
