import type { BullpenQuestion } from "@/lib/bullpen-ai";

const POLYMARKET_EVENT_BASE_URL = "https://polymarket.com/event";
const POLYMARKET_GAMMA_MARKETS_URL = "https://gamma-api.polymarket.com/markets";
const MAX_GAMMA_LOOKUP_BATCH_SIZE = 25;
const MAX_EVENT_DETAIL_BATCH_SIZE = 8;
const MARKET_CONTEXT_CAPTURE_CHARS = 40_000;
const MAX_MARKET_CONTEXT_UPDATES = 6;
const POLYMARKET_MARKET_CONTEXT_LABEL =
  "Experimental AI-generated summary referencing Polymarket data.";

type CanonicalizableQuestion = Pick<BullpenQuestion, "id" | "slug" | "marketUrl">;

export type ResolvedPolymarketMarket = {
  id: string;
  slug: string | null;
  marketUrl: string | null;
  yesOdds: number | null;
  noOdds: number | null;
  rules: string | null;
  marketContext: string | null;
  resolutionSource: string | null;
};

type PolymarketEventSupplement = {
  marketContext: string | null;
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

function normalizeText(value: string | null) {
  return value ? value.replace(/\s+/g, " ").trim() : null;
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

function extractRulesText(record: Record<string, unknown>) {
  return normalizeText(readString(record, ["description", "rules"]));
}

function extractResolutionSourceText(
  record: Record<string, unknown>,
  rulesText: string | null,
) {
  const direct = normalizeText(
    readString(record, ["resolutionSource", "resolution_source"]),
  );
  if (direct) return direct;

  const match = rulesText?.match(
    /The resolution source for this market will be.+?(?:\.|$)/i,
  );
  return normalizeText(match?.[0] || null);
}

function decodeHtmlEntities(value: string) {
  const namedEntities: Record<string, string> = {
    amp: "&",
    apos: "'",
    gt: ">",
    lt: "<",
    nbsp: " ",
    quot: '"',
  };

  return value.replace(
    /&(#x[0-9a-f]+|#\d+|[a-z]+);/gi,
    (entity, token: string) => {
      const normalizedToken = token.toLowerCase();
      if (normalizedToken.startsWith("#x")) {
        const parsed = Number.parseInt(normalizedToken.slice(2), 16);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
      }
      if (normalizedToken.startsWith("#")) {
        const parsed = Number.parseInt(normalizedToken.slice(1), 10);
        return Number.isFinite(parsed) ? String.fromCodePoint(parsed) : entity;
      }
      return namedEntities[normalizedToken] ?? entity;
    },
  );
}

function htmlToText(value: string | null) {
  if (!value) return null;

  const normalized = decodeHtmlEntities(
    value
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(/<br\s*\/?>/gi, "\n")
      .replace(/<\/(p|div|section|article|small|h[1-6]|li|ul|ol|time)>/gi, "\n")
      .replace(/<li[^>]*>/gi, "- ")
      .replace(/<[^>]+>/g, " "),
  )
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n")
    .replace(/[ \t]{2,}/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();

  return normalized || null;
}

function extractContextPanelSlice(html: string) {
  const panelMatch = html.match(
    /<(?:div|section)[^>]*\brole=["']tabpanel["'][^>]*\bid=["'][^"']*-panel-context["'][^>]*>/i,
  );
  if (panelMatch?.index !== undefined) {
    return html.slice(
      panelMatch.index,
      panelMatch.index + MARKET_CONTEXT_CAPTURE_CHARS,
    );
  }

  const labelIndex = html.indexOf(POLYMARKET_MARKET_CONTEXT_LABEL);
  if (labelIndex >= 0) {
    return html.slice(
      Math.max(0, labelIndex - 5_000),
      labelIndex + MARKET_CONTEXT_CAPTURE_CHARS,
    );
  }

  return null;
}

function extractMarketContextTimeline(panelSlice: string) {
  const timelineEntries: string[] = [];
  const timelinePattern =
    /<span[^>]*>(.*?)<\/span>\s*<p[^>]*>(.*?)<\/p>\s*<p[^>]*>(.*?)<\/p>\s*<p[^>]*>(.*?)<\/p>/gi;

  for (const match of panelSlice.matchAll(timelinePattern)) {
    const entry = [
      htmlToText(match[1] || null),
      htmlToText(match[2] || null),
      htmlToText(match[3] || null),
      htmlToText(match[4] || null),
    ];
    const [date, headline, oddsMove, detail] = entry;
    if (!date || !headline || !detail) {
      continue;
    }
    timelineEntries.push(
      [
        `${date}: ${headline}`,
        oddsMove ? `odds: ${oddsMove}` : null,
        detail,
      ]
        .filter(Boolean)
        .join(" | "),
    );
    if (timelineEntries.length >= MAX_MARKET_CONTEXT_UPDATES) {
      break;
    }
  }

  return timelineEntries;
}

function extractMarketContextText(html: string) {
  const panelSlice = extractContextPanelSlice(html);
  if (!panelSlice) return null;

  const articleStart = panelSlice.indexOf("<article>");
  const articleSlice =
    articleStart >= 0 ? panelSlice.slice(articleStart) : panelSlice;
  const summary = htmlToText(
    articleSlice.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1] || null,
  );
  const disclaimer = htmlToText(
    articleSlice.match(/<small[^>]*>([\s\S]*?)<\/small>/i)?.[1] || null,
  );
  const timelineEntries = extractMarketContextTimeline(articleSlice);

  const sections = [summary, disclaimer].filter(
    (section): section is string => Boolean(section),
  );
  if (timelineEntries.length > 0) {
    sections.push(`Timeline updates:\n- ${timelineEntries.join("\n- ")}`);
  }
  if (sections.length > 0) {
    return sections.join("\n\n");
  }

  return htmlToText(articleSlice.slice(0, 12_000));
}

async function fetchPolymarketEventSupplement(
  marketUrl: string,
): Promise<PolymarketEventSupplement | null> {
  const response = await fetch(marketUrl, {
    cache: "no-store",
    headers: {
      accept: "text/html,application/xhtml+xml",
      "user-agent": "Mozilla/5.0 investment-engine-bullpen-ai",
    },
  });
  if (!response.ok) {
    throw new Error(`Polymarket event page returned HTTP ${response.status}`);
  }

  const html = await response.text();

  return {
    marketContext: extractMarketContextText(html),
  };
}

async function fetchPolymarketEventSupplements(marketUrls: string[]) {
  const supplementsByMarketUrl: Record<string, PolymarketEventSupplement> = {};

  for (
    let index = 0;
    index < marketUrls.length;
    index += MAX_EVENT_DETAIL_BATCH_SIZE
  ) {
    const batch = marketUrls.slice(index, index + MAX_EVENT_DETAIL_BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async (marketUrl) => {
        try {
          const supplement = await fetchPolymarketEventSupplement(marketUrl);
          return supplement
            ? ([marketUrl, supplement] as const)
            : null;
        } catch {
          return null;
        }
      }),
    );

    for (const result of results) {
      if (!result) continue;
      const [marketUrl, supplement] = result;
      supplementsByMarketUrl[marketUrl] = supplement;
    }
  }

  return supplementsByMarketUrl;
}

function normalizeResolvedMarket(
  record: Record<string, unknown>,
  fallbackSlug: string | null = null,
): ResolvedPolymarketMarket | null {
  const id = readString(record, ["id"]);
  const slug = getCanonicalPolymarketMarketSlug(record, fallbackSlug);
  const eventSlug = getCanonicalPolymarketEventSlug(record, slug);
  const { yesOdds, noOdds } = readOutcomeOdds(record);
  const rules = extractRulesText(record);

  if (!id) return null;

  return {
    id,
    slug,
    marketUrl: buildPolymarketEventUrl(eventSlug),
    yesOdds,
    noOdds,
    rules,
    marketContext: null,
    resolutionSource: extractResolutionSourceText(record, rules),
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

  const uniqueMarketUrls = new Set<string>();

  for (const question of questions) {
    const record =
      recordsById.get(question.id.trim()) ||
      (question.slug ? recordsBySlug.get(question.slug.trim()) : undefined);
    if (!record) continue;

    const resolved = normalizeResolvedMarket(record, question.slug?.trim() || null);
    if (resolved) {
      resolvedByQuestionId[question.id] = resolved;
      if (resolved.marketUrl) {
        uniqueMarketUrls.add(resolved.marketUrl);
      }
    }
  }

  const supplementsByMarketUrl = await fetchPolymarketEventSupplements(
    [...uniqueMarketUrls],
  );

  for (const questionId of Object.keys(resolvedByQuestionId)) {
    const resolved = resolvedByQuestionId[questionId];
    if (!resolved.marketUrl) continue;

    const supplement = supplementsByMarketUrl[resolved.marketUrl];
    if (!supplement) continue;

    resolvedByQuestionId[questionId] = {
      ...resolved,
      marketContext: supplement.marketContext,
    };
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
        resolved.slug === question.slug &&
        ("rules" in question ? resolved.rules === question.rules : resolved.rules === null) &&
        ("marketContext" in question
          ? resolved.marketContext === question.marketContext
          : resolved.marketContext === null) &&
        ("resolutionSource" in question
          ? resolved.resolutionSource === question.resolutionSource
          : resolved.resolutionSource === null)
      ) {
        return question;
      }

      changed = true;
      return {
        ...question,
        slug: resolved.slug,
        marketUrl: resolved.marketUrl,
        ...(question as Partial<BullpenQuestion>),
        rules: resolved.rules,
        marketContext: resolved.marketContext,
        resolutionSource: resolved.resolutionSource,
      } as T;
    });

    return changed ? nextQuestions : questions;
  } catch {
    return questions;
  }
}
