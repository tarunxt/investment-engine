import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GAMMA_EVENT_BY_SLUG = "https://gamma-api.polymarket.com/events/slug";
const MAX_EVENTS = 200;
const CONCURRENCY = 12;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

type CachedEvent = { eventSlug: string; eventTitle: string | null; expiresAt: number };
const cache = new Map<string, CachedEvent>();

function normalizedSlug(value: unknown) {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,298}[a-z0-9]$/.test(slug) ? slug : null;
}

async function fetchEvent(slug: string): Promise<CachedEvent> {
  const existing = cache.get(slug);
  if (existing && existing.expiresAt > Date.now()) return existing;
  const response = await fetch(`${GAMMA_EVENT_BY_SLUG}/${encodeURIComponent(slug)}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(6_000),
  });
  if (!response.ok) throw new Error(`Gamma event ${slug} returned HTTP ${response.status}`);
  const payload = (await response.json()) as { title?: unknown };
  const eventTitle = typeof payload.title === "string" && payload.title.trim() ? payload.title.trim() : null;
  const result = { eventSlug: slug, eventTitle, expiresAt: Date.now() + CACHE_TTL_MS };
  cache.set(slug, result);
  return result;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { slugs?: unknown[] };
  const slugs = Array.from(new Set((body.slugs ?? []).map(normalizedSlug).filter((slug): slug is string => Boolean(slug)))).slice(0, MAX_EVENTS);
  const events: Record<string, { eventSlug: string; eventTitle: string | null }> = {};
  for (let index = 0; index < slugs.length; index += CONCURRENCY) {
    const results = await Promise.allSettled(slugs.slice(index, index + CONCURRENCY).map(fetchEvent));
    for (const result of results) {
      if (result.status === "fulfilled") {
        events[result.value.eventSlug] = { eventSlug: result.value.eventSlug, eventTitle: result.value.eventTitle };
      }
    }
  }
  return NextResponse.json({ events });
}
