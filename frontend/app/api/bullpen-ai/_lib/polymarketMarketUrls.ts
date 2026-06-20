import type { BullpenQuestion } from "@/lib/bullpen-ai";

const POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const MAX_GAMMA_LOOKUP_BATCH_SIZE = 25;

type CanonicalizableQuestion = Pick<BullpenQuestion, "id" | "slug" | "marketUrl">;

function toArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function parseJsonArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value !== "string" || !value.trim()) return [];

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function readString(record: Record<string, unknown>, keys: string[]) {
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" && Number.isFinite(value)) {
      return String(value);
    }
  }

  return null;
}

function toRecord(value: unknown) {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function getNestedEventSlug(value: unknown) {
  for (const item of [...toArray(value), ...parseJsonArray(value)]) {
    const record = toRecord(item);
    if (!record) continue;

    const slug = readString(record, ["slug", "eventSlug", "urlSlug"]);
    if (slug) return slug;
  }

  const record = toRecord(value);
  if (!record) return null;

  return readString(record, ["slug", "eventSlug", "urlSlug"]);
}

function getNestedSeriesSlug(value: unknown) {
  for (const item of [...toArray(value), ...parseJsonArray(value)]) {
    const record = toRecord(item);
    if (!record) continue;

    const slug = readString(record, ["slug", "seriesSlug"]);
    if (slug) return slug;
  }

  return null;
}

function isNumericQuestionId(value: string) {
  return /^\d+$/.test(value.trim());
}

export function buildPolymarketEventUrl(slug: string | null) {
  if (!slug) return null;
  return `${POLYMARKET_EVENT_BASE_URL}/${slug}`;
}

export function getCanonicalPolymarketEventSlug(
  record: Record<string, unknown>,
  fallbackSlug: string | null = null,
) {
  return (
    readString(record, ["eventSlug", "urlSlug"]) ||
    getNestedEventSlug(record.events) ||
    getNestedEventSlug(record.event) ||
    readString(record, ["seriesSlug"]) ||
    getNestedSeriesSlug(record.series) ||
    fallbackSlug
  );
}

async function fetchGammaMarketLookupBatch(
  questions: CanonicalizableQuestion[],
) {
  const params = new URLSearchParams();
  const seenIds = new Set<string>();
  const seenSlugs = new Set<string>();

  for (const question of questions) {
    const id = question.id.trim();
    const slug = question.slug?.trim() || null;

    if (isNumericQuestionId(id) && !seenIds.has(id)) {
      seenIds.add(id);
      params.append("id", id);
      continue;
    }

    if (slug && !seenSlugs.has(slug)) {
      seenSlugs.add(slug);
      params.append("slug", slug);
    }
  }

  if (!params.toString()) {
    return [];
  }

  const response = await fetch(
    `${POLYMARKET_GAMMA_MARKETS_URL}?${params.toString()}`,
    {
      cache: "no-store",
      headers: { accept: "application/json" },
    },
  );
  if (!response.ok) {
    throw new Error(`Polymarket Gamma lookup returned HTTP ${response.status}`);
  }

  const payload = await response.json();
  return Array.isArray(payload)
    ? payload.filter(
        (entry): entry is Record<string, unknown> =>
          Boolean(entry) && typeof entry === "object" && !Array.isArray(entry),
      )
    : [];
}

export async function applyCanonicalPolymarketMarketUrls<
  T extends CanonicalizableQuestion,
>(questions: T[]) {
  if (questions.length === 0) return questions;

  try {
    const recordsById = new Map<string, Record<string, unknown>>();
    const recordsBySlug = new Map<string, Record<string, unknown>>();

    for (
      let index = 0;
      index < questions.length;
      index += MAX_GAMMA_LOOKUP_BATCH_SIZE
    ) {
      const batch = questions.slice(index, index + MAX_GAMMA_LOOKUP_BATCH_SIZE);
      const records = await fetchGammaMarketLookupBatch(batch);

      for (const record of records) {
        const id = readString(record, ["id"]);
        const slug = readString(record, ["slug"]);
        if (id) recordsById.set(id, record);
        if (slug) recordsBySlug.set(slug, record);
      }
    }

    let changed = false;
    const nextQuestions = questions.map((question) => {
      const record =
        recordsById.get(question.id.trim()) ||
        (question.slug ? recordsBySlug.get(question.slug) : undefined);
      if (!record) return question;

      const nextMarketUrl = buildPolymarketEventUrl(
        getCanonicalPolymarketEventSlug(record, question.slug),
      );
      if (!nextMarketUrl || nextMarketUrl === question.marketUrl) {
        return question;
      }

      changed = true;
      return {
        ...question,
        marketUrl: nextMarketUrl,
      };
    });

    return changed ? nextQuestions : questions;
  } catch {
    return questions;
  }
}
