import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const GAMMA_EVENTS_URL = "https://gamma-api.polymarket.com/events";
const MAX_EVENTS = 200;
const CACHE_TTL_MS = 6 * 60 * 60 * 1_000;

type CachedEvent = { eventSlug: string; eventTitle: string | null; expiresAt: number };
const cache = new Map<string, CachedEvent>();

function normalizedSlug(value: unknown) {
  if (typeof value !== "string") return null;
  const slug = value.trim().toLowerCase();
  return /^[a-z0-9][a-z0-9-]{1,298}[a-z0-9]$/.test(slug) ? slug : null;
}

async function fetchEvents(slugs: string[]): Promise<CachedEvent[]> {
  if (!slugs.length) return [];
  const params = new URLSearchParams({ limit: String(slugs.length) });
  for (const slug of slugs) params.append("slug", slug);
  const response = await fetch(`${GAMMA_EVENTS_URL}?${params.toString()}`, {
    cache: "no-store",
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Gamma events returned HTTP ${response.status}`);
  const payload = (await response.json()) as Array<{ slug?: unknown; title?: unknown }>;
  const requested = new Set(slugs);
  const results: CachedEvent[] = [];
  for (const item of Array.isArray(payload) ? payload : []) {
    const eventSlug = normalizedSlug(item.slug);
    if (!eventSlug || !requested.has(eventSlug)) continue;
    const eventTitle = typeof item.title === "string" && item.title.trim() ? item.title.trim() : null;
    const result = { eventSlug, eventTitle, expiresAt: Date.now() + CACHE_TTL_MS };
    cache.set(eventSlug, result);
    results.push(result);
  }
  return results;
}

export async function POST(request: NextRequest) {
  const body = (await request.json()) as { slugs?: unknown[] };
  const slugs = Array.from(new Set((body.slugs ?? []).map(normalizedSlug).filter((slug): slug is string => Boolean(slug)))).slice(0, MAX_EVENTS);
  const events: Record<string, { eventSlug: string; eventTitle: string | null }> = {};
  const missing: string[] = [];
  for (const slug of slugs) {
    const existing = cache.get(slug);
    if (existing && existing.expiresAt > Date.now()) {
      events[slug] = { eventSlug: slug, eventTitle: existing.eventTitle };
    } else {
      missing.push(slug);
    }
  }
  try {
    for (const result of await fetchEvents(missing)) {
      events[result.eventSlug] = { eventSlug: result.eventSlug, eventTitle: result.eventTitle };
    }
  } catch (error) {
    console.warn("Unable to load batched Gamma event metadata", error);
  }
  return NextResponse.json({ events });
}
