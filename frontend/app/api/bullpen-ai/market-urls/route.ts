import { NextRequest, NextResponse } from "next/server";

import { resolvePolymarketMarkets } from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LookupQuestion = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
};

function normalizeLookupQuestion(value: unknown): LookupQuestion | null {
  if (!value || typeof value !== "object") return null;

  const record = value as Record<string, unknown>;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim() : null;
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
      return NextResponse.json({ marketUrls: {}, marketSlugs: {} });
    }

    const resolvedByQuestionId = await resolvePolymarketMarkets(questions);

    return NextResponse.json({
      marketUrls: Object.fromEntries(
        questions.map((question) => [
          question.id,
          resolvedByQuestionId[question.id]?.marketUrl ?? question.marketUrl,
        ]),
      ),
      marketSlugs: Object.fromEntries(
        questions.map((question) => [
          question.id,
          resolvedByQuestionId[question.id]?.slug ?? question.slug,
        ]),
      ),
    });
  } catch (error) {
    return NextResponse.json(
      {
        error:
          error instanceof Error
            ? error.message
            : "Failed to resolve Polymarket market URLs.",
      },
      { status: 400 },
    );
  }
}
