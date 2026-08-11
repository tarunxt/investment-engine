import { NextRequest, NextResponse } from "next/server";

import { buildBullpenCanonicalMarketUrl } from "@/lib/bullpenMarketLinks";

const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";

type JsonRecord = Record<string, unknown>;

function toRecord(value: unknown): JsonRecord | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as JsonRecord)
    : null;
}

function readString(record: JsonRecord | null, keys: string[]) {
  if (!record) return null;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) return String(value);
  }
  return null;
}

function readNestedEventSlug(record: JsonRecord) {
  const candidates = [record.events, record.event];
  for (const candidate of candidates) {
    const values = Array.isArray(candidate) ? candidate : [candidate];
    for (const value of values) {
      const eventRecord = toRecord(value);
      const slug = readString(eventRecord, ["slug", "eventSlug", "urlSlug"]);
      if (slug) return slug;
    }
  }
  return null;
}

async function resolveCanonicalPolymarketSlugs(marketId: string) {
  const gammaUrl = new URL(POLYMARKET_GAMMA_MARKETS_URL);
  gammaUrl.searchParams.append("id", marketId);
  const response = await fetch(gammaUrl, {
    cache: "no-store",
    headers: { accept: "application/json" },
  });

  if (!response.ok) {
    throw new Error(`Polymarket Gamma lookup returned HTTP ${response.status}`);
  }

  const payload: unknown = await response.json();
  const market = Array.isArray(payload) ? toRecord(payload[0]) : toRecord(payload);
  if (!market) {
    throw new Error(`Polymarket Gamma returned no market for id ${marketId}`);
  }

  const marketSlug = readString(market, ["slug", "marketSlug", "questionSlug"]);
  const eventSlug =
    readString(market, ["eventSlug", "urlSlug"]) || readNestedEventSlug(market);

  if (!eventSlug) {
    throw new Error(`Polymarket Gamma returned no event slug for id ${marketId}`);
  }

  return { eventSlug, marketSlug };
}

export async function GET(request: NextRequest) {
  const marketId = request.nextUrl.searchParams.get("marketId")?.trim() || "";
  if (!marketId) {
    return NextResponse.json({ error: "marketId is required" }, { status: 400 });
  }

  try {
    const { eventSlug, marketSlug } = await resolveCanonicalPolymarketSlugs(marketId);
    return NextResponse.redirect(
      buildBullpenCanonicalMarketUrl({
        marketId,
        eventSlug,
        marketSlug,
        outcome: "Yes",
      }),
      307,
    );
  } catch (error) {
    console.error("Unable to resolve canonical Bullpen market link", {
      marketId,
      error,
    });
    return NextResponse.json(
      { error: "Unable to resolve this Bullpen market link." },
      { status: 502 },
    );
  }
}
