import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NextResponse } from "next/server";

import {
  BULLPEN_BIN_CANDIDATES,
  buildBullpenProcessEnv,
  parseBullpenJsonOutput,
} from "../_lib/bullpenCli";
import {
  buildPolymarketEventUrl,
  resolvePolymarketMarkets,
} from "../_lib/polymarketMarketUrls";
import {
  applyBullpenPositionMarketData,
  normalizeBullpenPosition,
  summarizeBullpenPositions,
  type BullpenCliPosition,
  type BullpenCliPositionsPayload,
} from "@/lib/bullpenPositions";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const execFileAsync = promisify(execFile);

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
      const positions = rawPositions.map((position) =>
        normalizeBullpenPosition(position, buildPolymarketEventUrl),
      );
      let refreshedPositions = positions;

      try {
        const refreshedMarkets = await resolvePolymarketMarkets(
          rawPositions.map((position, index) => ({
            id: positions[index]?.key || `bullpen-position-${index + 1}`,
            slug:
              typeof position.slug === "string" && position.slug.trim()
                ? position.slug.trim()
                : null,
            marketUrl: positions[index]?.marketUrl ?? null,
          })),
        );
        refreshedPositions = positions.map((position) => {
          const refreshedMarket = refreshedMarkets[position.key];
          return refreshedMarket
            ? applyBullpenPositionMarketData(position, refreshedMarket)
            : position;
        });
      } catch {
        // Fall back to Bullpen's wallet snapshot if Polymarket quote refresh fails.
      }

      return NextResponse.json({
        positions: refreshedPositions,
        summary: summarizeBullpenPositions(
          refreshedPositions,
          payload.summary || {},
        ),
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
