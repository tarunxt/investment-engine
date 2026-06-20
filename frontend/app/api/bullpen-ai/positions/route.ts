import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import {
  BULLPEN_BIN_CANDIDATES,
  buildBullpenProcessEnv,
  parseBullpenJsonOutput,
} from "../_lib/bullpenCli";
import { buildPolymarketEventUrl } from "../_lib/polymarketMarketUrls";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

type BullpenCliPosition = {
  avg_price?: unknown;
  condition_id?: unknown;
  current_price?: unknown;
  current_value?: unknown;
  end_date?: unknown;
  event_slug?: unknown;
  invested_usd?: unknown;
  market?: unknown;
  outcome?: unknown;
  pnl_percent?: unknown;
  shares?: unknown;
  slug?: unknown;
  unrealized_pnl?: unknown;
};

type BullpenCliPositionsPayload = {
  positions?: unknown;
  summary?: Record<string, unknown> | null;
};

function readString(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function readNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,$\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function normalizePosition(value: BullpenCliPosition) {
  const marketId =
    readString(value.slug) ||
    readString(value.condition_id) ||
    readString(value.market) ||
    "unknown-market";
  const marketTitle = readString(value.market) || marketId;
  const outcome = readString(value.outcome) || "—";
  const shares = readNumber(value.shares) || 0;
  const averagePrice = readNumber(value.avg_price);
  const costBasis =
    readNumber(value.invested_usd) ??
    (averagePrice !== null ? shares * averagePrice : 0);
  const currentPrice = readNumber(value.current_price);
  const currentValue =
    readNumber(value.current_value) ??
    (currentPrice !== null ? shares * currentPrice : null);
  const unrealizedPnl =
    readNumber(value.unrealized_pnl) ??
    (currentValue !== null ? currentValue - costBasis : null);
  const unrealizedPnlPercent =
    readNumber(value.pnl_percent) ??
    (costBasis > 0 && unrealizedPnl !== null
      ? (unrealizedPnl / costBasis) * 100
      : null);
  const eventSlug = readString(value.event_slug);
  const closeDate = readString(value.end_date);

  return {
    key: `${marketId}::${outcome}`,
    marketId,
    marketTitle,
    outcome,
    shares: round(shares, 4),
    averagePrice: averagePrice === null ? null : round(averagePrice, 4),
    costBasis: round(costBasis, 2),
    currentPrice: currentPrice === null ? null : round(currentPrice, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    unrealizedPnl: unrealizedPnl === null ? null : round(unrealizedPnl, 2),
    unrealizedPnlPercent:
      unrealizedPnlPercent === null ? null : round(unrealizedPnlPercent, 2),
    marketUrl: buildPolymarketEventUrl(eventSlug),
    closeTime: closeDate ? `${closeDate}T00:00:00.000Z` : null,
  };
}

export async function GET() {
  const errors: string[] = [];

  for (const candidate of BULLPEN_BIN_CANDIDATES) {
    try {
      const { stdout } = await execFileAsync(
        candidate,
        ["polymarket", "positions", "--output", "json"],
        {
          env: buildBullpenProcessEnv({ readOnly: true }),
          timeout: 30_000,
          maxBuffer: 10 * 1024 * 1024,
        },
      );

      const payload = parseBullpenJsonOutput(stdout) as BullpenCliPositionsPayload;
      const rawPositions = Array.isArray(payload.positions)
        ? (payload.positions as BullpenCliPosition[])
        : [];
      const summary = payload.summary || {};

      return NextResponse.json({
        positions: rawPositions.map((position) => normalizePosition(position)),
        summary: {
          activeCount: readNumber(summary.active_count) ?? rawPositions.length,
          cashBalance: readNumber(summary.cash_balance),
          totalValue: readNumber(summary.total_value),
          unrealizedPnl: readNumber(summary.unrealized_pnl),
          walletValue: readNumber(summary.wallet_value),
        },
        fetchedAt: new Date().toISOString(),
      });
    } catch (error) {
      errors.push(
        error instanceof Error ? error.message : "Unknown Bullpen CLI error.",
      );
    }
  }

  return NextResponse.json(
    {
      error:
        errors[0] || "Unable to load active Bullpen wallet positions right now.",
    },
    { status: 500 },
  );
}
