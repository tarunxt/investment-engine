import { NextRequest, NextResponse } from "next/server";

import { shouldReplaceCategory } from "../_lib/polymarketCategory";
import {
  resolvePolymarketMarketsWithQuestionFallback,
  type ResolvedPolymarketMarket,
} from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

type LookupQuestion = {
  id: string;
  conditionId: string | null;
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
    conditionId:
      typeof record.conditionId === "string" && record.conditionId.trim()
        ? record.conditionId.trim()
        : typeof record.condition_id === "string" && record.condition_id.trim()
          ? record.condition_id.trim()
          : null,
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

type ClobOrderBook = {
  asset_id?: string;
  asks?: Array<{ price?: string | number; size?: string | number }>;
};

function bestExecutableAsk(book: ClobOrderBook | undefined) {
  const asks = (book?.asks ?? [])
    .map((level) => Number(level.price))
    .filter((price) => Number.isFinite(price) && price >= 0 && price <= 1);
  if (asks.length === 0) return null;
  return Number((Math.min(...asks) * 100).toFixed(2));
}

async function applyClobOrderBooks(
  markets: Record<string, ResolvedPolymarketMarket>,
) {
  const tokenIds = Array.from(
    new Set(
      Object.values(markets)
        .flatMap((market) => [market.yesTokenId, market.noTokenId])
        .filter((tokenId): tokenId is string => Boolean(tokenId)),
    ),
  );
  if (tokenIds.length === 0) return markets;

  try {
    const response = await fetch("https://clob.polymarket.com/books", {
      method: "POST",
      cache: "no-store",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(tokenIds.map((token_id) => ({ token_id }))),
      signal: AbortSignal.timeout(8_000),
    });
    if (!response.ok) return markets;
    const payload = (await response.json()) as ClobOrderBook[];
    const books = new Map(
      payload
        .filter((book) => typeof book.asset_id === "string")
        .map((book) => [book.asset_id as string, book]),
    );
    return Object.fromEntries(
      Object.entries(markets).map(([questionId, market]) => {
        const yesAsk = market.yesTokenId
          ? bestExecutableAsk(books.get(market.yesTokenId))
          : null;
        const noAsk = market.noTokenId
          ? bestExecutableAsk(books.get(market.noTokenId))
          : null;
        return [
          questionId,
          {
            ...market,
            yesOdds: yesAsk ?? market.yesOdds,
            noOdds: noAsk ?? market.noOdds,
          },
        ];
      }),
    ) as Record<string, ResolvedPolymarketMarket>;
  } catch {
    return markets;
  }
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
        fetchedAt: new Date().toISOString(),
      });
    }

    const gammaMarkets = await resolvePolymarketMarketsWithQuestionFallback(
      questions,
      {
        allowPartialGammaLookups: true,
        includeEventSupplements: false,
      },
    );
    const resolvedByQuestionId = await applyClobOrderBooks(gammaMarkets);
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
      fetchedAt: new Date().toISOString(),
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
