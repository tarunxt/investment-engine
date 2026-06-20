import type { BullpenQuestion } from "@/lib/bullpen-ai";

const POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const MAX_GAMMA_LOOKUP_BATCH_SIZE = 25;

type CanonicalizableQuestion = Pick<BullpenQuestion, "id" | "slug" | "marketUrl">;

export type ResolvedPolymarketMarket = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  yesOdds: number | null;
  noOdds: number | null;
};

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

function parseNumber(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string") {
    const parsed = Number(value.replace(/[%,$\s]/g, ""));
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function normalizeOdds(value: number | null) {
  if (value === null || value < 0) return null;
  if (value <= 1) return Number((value * 100).toFixed(2));
  return Number(value.toFixed(2));
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

function getCanonicalPolymarketMarketSlug(
  record: Record<string, unknown>,
  fallbackSlug: string | null = null,
) {
  return (
    readString(record, ["slug", "marketSlug", "questionSlug"]) || fallbackSlug
  );
}

function readOutcomeOdds(record: Record<string, unknown>) {
  const outcomes = parseJsonArray(record.outcomes);
  const outcomeLabels = outcomes
    .map((value) => {
      if (typeof value === "string") return value.trim();
      if (!value || typeof value !== "object") return null;
      return readString(value as Record<string, unknown>, ["name", "label", "title"]);
    })
    .filter((value): value is string => Boolean(value))
    .map((value) => value.toLowerCase());
  const outcomePrices = parseJsonArray(record.outcomePrices).map((value) =>
    parseNumber(value),
  );
  const yesIndex = outcomeLabels.findIndex((label) => label === "yes");
  const noIndex = outcomeLabels.findIndex((label) => label === "no");
  const readFallbackOutcomeOdds = (index: number) => {
    const outcome = outcomes[index];
    if (!outcome || typeof outcome !== "object") return null;
    return parseNumber(
      (outcome as Record<string, unknown>).price ??
        (outcome as Record<string, unknown>).probability,
    );
  };
  const yesOdds =
    yesIndex >= 0
      ? normalizeOdds(outcomePrices[yesIndex] ?? readFallbackOutcomeOdds(yesIndex))
      : null;
  const noOdds =
    noIndex >= 0
      ? normalizeOdds(outcomePrices[noIndex] ?? readFallbackOutcomeOdds(noIndex))
      : null;

  return {
    yesOdds,
    noOdds,
  };
}

function normalizeResolvedMarket(
  record: Record<string, unknown>,
  fallbackSlug: string | null = null,
): ResolvedPolymarketMarket | null {
  const id = readString(record, ["id"]);
  const slug = getCanonicalPolymarketMarketSlug(record, fallbackSlug);
  const eventSlug = getCanonicalPolymarketEventSlug(record, slug);
  const { yesOdds, noOdds } = readOutcomeOdds(record);

  if (!id) return null;

  return {
    id,
    slug,
    marketUrl: buildPolymarketEventUrl(eventSlug),
    yesOdds,
    noOdds,
  };
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

export async function resolvePolymarketMarkets<
  T extends CanonicalizableQuestion,
>(questions: T[]) {
  const resolvedByQuestionId: Record<string, ResolvedPolymarketMarket> = {};
  if (questions.length === 0) return resolvedByQuestionId;

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
      const slug = getCanonicalPolymarketMarketSlug(record);
      if (id) recordsById.set(id, record);
      if (slug) recordsBySlug.set(slug, record);
    }
  }

  for (const question of questions) {
    const record =
      recordsById.get(question.id.trim()) ||
      (question.slug ? recordsBySlug.get(question.slug.trim()) : undefined);
    if (!record) continue;

    const resolved = normalizeResolvedMarket(record, question.slug?.trim() || null);
    if (resolved) {
      resolvedByQuestionId[question.id] = resolved;
    }
  }

  return resolvedByQuestionId;
}

export async function applyCanonicalPolymarketMarketUrls<
  T extends CanonicalizableQuestion,
>(questions: T[]) {
  if (questions.length === 0) return questions;

  try {
    const resolvedByQuestionId = await resolvePolymarketMarkets(questions);

    let changed = false;
    const nextQuestions = questions.map((question) => {
      const resolved = resolvedByQuestionId[question.id];
      if (!resolved) return question;

      if (
        resolved.marketUrl === question.marketUrl &&
        resolved.slug === question.slug
      ) {
        return question;
      }

      changed = true;
      return {
        ...question,
        slug: resolved.slug,
        marketUrl: resolved.marketUrl,
      };
    });

    return changed ? nextQuestions : questions;
  } catch {
    return questions;
  }
}
