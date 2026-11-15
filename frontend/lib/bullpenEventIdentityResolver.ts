import type { BullpenQuestionRow } from "./bullpen-ai";
import type { BullpenActivePositionView } from "./bullpenPositions";
import type { BullpenAutoLiveDecision } from "@/types/api";

export type BullpenEventMatchMethod =
  | "position_key"
  | "condition_id"
  | "market_id"
  | "question_id"
  | "slug"
  | "market_url"
  | "title";

export type BullpenEventIdentity = {
  positionKeys: string[];
  conditionIds: string[];
  marketIds: string[];
  questionIds: string[];
  slugs: string[];
  canonicalMarketUrls: string[];
  normalizedTitles: string[];
};

export type BullpenEventIdentityInput = {
  positionKey?: string | null;
  conditionId?: string | null;
  marketId?: string | null;
  questionId?: string | null;
  slug?: string | null;
  marketUrl?: string | null;
  canonicalMarketUrl?: string | null;
  title?: string | null;
};

export type BullpenEventMatchCandidate<T> = {
  item: T;
  identity: BullpenEventIdentity;
  score: number;
  matchedMethods: BullpenEventMatchMethod[];
  primaryMethod: BullpenEventMatchMethod | null;
  matchedFieldCount: number;
  richness: number;
};

export type BullpenEventMatchResult<T> = {
  status: "matched" | "ambiguous" | "unmatched";
  match: BullpenEventMatchCandidate<T> | null;
  matches: BullpenEventMatchCandidate<T>[];
  reason: string;
};

const MATCH_METHOD_ORDER: BullpenEventMatchMethod[] = [
  "position_key",
  "condition_id",
  "market_id",
  "question_id",
  "slug",
  "market_url",
  "title",
];

const MATCH_METHOD_WEIGHTS: Record<BullpenEventMatchMethod, number> = {
  position_key: 100,
  condition_id: 100,
  market_id: 90,
  question_id: 90,
  slug: 70,
  market_url: 60,
  title: 20,
};

function readString(value: unknown) {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function normalizeIdentityValue(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function normalizeTitle(value: string | null | undefined) {
  if (!value) return null;
  const normalized = value.trim().toLowerCase().replace(/\s+/g, " ");
  return normalized.length > 0 ? normalized : null;
}

function unique(values: (string | null)[]) {
  return [...new Set(values.filter((value): value is string => Boolean(value)))];
}

function normalizePathname(pathname: string) {
  const decoded = pathname.trim() ? decodeURIComponent(pathname) : "/";
  const collapsed = decoded.replace(/\/+/g, "/").toLowerCase();
  const withoutTrailingSlash =
    collapsed.length > 1 ? collapsed.replace(/\/+$/, "") : collapsed;
  return withoutTrailingSlash === "/" ? "" : withoutTrailingSlash;
}

export function canonicalizeBullpenMarketUrl(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  try {
    const parsed = new URL(trimmed);
    const host = parsed.hostname.toLowerCase().replace(/^www\./, "");
    const pathname = normalizePathname(parsed.pathname);
    return `${host}${pathname}` || null;
  } catch {
    const withoutHash = trimmed.split("#", 1)[0] ?? trimmed;
    const withoutQuery = withoutHash.split("?", 1)[0] ?? withoutHash;
    const withoutProtocol = withoutQuery
      .toLowerCase()
      .replace(/^https?:\/\//, "")
      .replace(/^www\./, "");
    const [host = "", ...pathParts] = withoutProtocol.split("/");
    const pathname = normalizePathname(`/${pathParts.join("/")}`);
    const normalizedHost = host.trim();
    if (!normalizedHost) return null;
    return `${normalizedHost}${pathname}` || null;
  }
}

function hasSharedValue(left: string[], right: string[]) {
  if (left.length === 0 || right.length === 0) return false;
  const rightSet = new Set(right);
  return left.some((value) => rightSet.has(value));
}

function totalIdentityValues(identity: BullpenEventIdentity) {
  return (
    identity.positionKeys.length +
    identity.conditionIds.length +
    identity.marketIds.length +
    identity.questionIds.length +
    identity.slugs.length +
    identity.canonicalMarketUrls.length +
    identity.normalizedTitles.length
  );
}

function summarizeIdentityMatch(
  target: BullpenEventIdentity,
  candidate: BullpenEventIdentity,
) {
  const matchedMethods = MATCH_METHOD_ORDER.filter((method) => {
    switch (method) {
      case "position_key":
        return hasSharedValue(target.positionKeys, candidate.positionKeys);
      case "condition_id":
        return hasSharedValue(target.conditionIds, candidate.conditionIds);
      case "market_id":
        return hasSharedValue(target.marketIds, candidate.marketIds);
      case "question_id":
        return hasSharedValue(target.questionIds, candidate.questionIds);
      case "slug":
        return hasSharedValue(target.slugs, candidate.slugs);
      case "market_url":
        return hasSharedValue(
          target.canonicalMarketUrls,
          candidate.canonicalMarketUrls,
        );
      case "title":
        return hasSharedValue(target.normalizedTitles, candidate.normalizedTitles);
      default:
        return false;
    }
  });

  const score = matchedMethods.reduce(
    (total, method) => total + MATCH_METHOD_WEIGHTS[method],
    0,
  );

  return {
    score,
    matchedMethods,
    primaryMethod: matchedMethods[0] ?? null,
    matchedFieldCount: matchedMethods.length,
    richness: totalIdentityValues(candidate),
  };
}

function getSortValueMs(value: string | null | undefined) {
  if (!value) return Number.NEGATIVE_INFINITY;
  const timestamp = Date.parse(value);
  return Number.isFinite(timestamp) ? timestamp : Number.NEGATIVE_INFINITY;
}

export function buildBullpenEventIdentity(
  input: BullpenEventIdentityInput,
): BullpenEventIdentity {
  return {
    positionKeys: unique([normalizeIdentityValue(input.positionKey)]),
    conditionIds: unique([normalizeIdentityValue(input.conditionId)]),
    marketIds: unique([normalizeIdentityValue(input.marketId)]),
    questionIds: unique([normalizeIdentityValue(input.questionId)]),
    slugs: unique([normalizeIdentityValue(input.slug)]),
    canonicalMarketUrls: unique([
      canonicalizeBullpenMarketUrl(input.canonicalMarketUrl ?? input.marketUrl),
    ]),
    normalizedTitles: unique([normalizeTitle(input.title)]),
  };
}

export function buildBullpenEventIdentityFromQuestion(
  question: Pick<
    BullpenQuestionRow,
    | "id"
    | "question"
    | "slug"
    | "marketUrl"
    | "sourceUrl"
    | "positionKey"
    | "conditionId"
    | "marketId"
    | "questionId"
  >,
) {
  return buildBullpenEventIdentity({
    positionKey: question.positionKey ?? null,
    conditionId: question.conditionId ?? null,
    marketId: question.marketId ?? null,
    questionId: question.questionId ?? question.id,
    slug: question.slug,
    marketUrl: question.marketUrl ?? question.sourceUrl,
    title: question.question,
  });
}

export function buildBullpenEventIdentityFromPosition(
  position: Pick<
    BullpenActivePositionView,
    "key" | "conditionId" | "marketId" | "slug" | "marketUrl" | "marketTitle"
  >,
) {
  return buildBullpenEventIdentity({
    positionKey: position.key,
    conditionId: position.conditionId,
    marketId: position.marketId,
    slug: position.slug,
    marketUrl: position.marketUrl,
    title: position.marketTitle,
  });
}

export function buildBullpenEventIdentityFromDecision(
  decision: Pick<
    BullpenAutoLiveDecision,
    "market_id" | "slug" | "market_url" | "market_title"
  >,
) {
  return buildBullpenEventIdentity({
    marketId: decision.market_id,
    slug: decision.slug ?? null,
    marketUrl: decision.market_url ?? null,
    title: decision.market_title,
  });
}

export function buildBullpenEventIdentityFromRecord(
  record: Record<string, unknown>,
) {
  return buildBullpenEventIdentity({
    positionKey: readString(record.position_key ?? record.positionKey),
    conditionId: readString(record.condition_id ?? record.conditionId),
    marketId: readString(record.market_id ?? record.marketId),
    questionId:
      readString(record.question_id ?? record.questionId) ??
      readString(record.id),
    slug: readString(record.slug),
    canonicalMarketUrl: readString(
      record.canonical_market_url ?? record.canonicalMarketUrl,
    ),
    marketUrl:
      readString(record.market_url ?? record.marketUrl) ??
      readString(record.source_url ?? record.sourceUrl) ??
      readString(record.url),
    title:
      readString(record.question) ??
      readString(record.market_title ?? record.marketTitle),
  });
}

export function describeBullpenEventMatchMethod(
  method: BullpenEventMatchMethod | null,
) {
  switch (method) {
    case "position_key":
      return "position key";
    case "condition_id":
      return "condition ID";
    case "market_id":
      return "market ID";
    case "question_id":
      return "question ID";
    case "slug":
      return "slug";
    case "market_url":
      return "market URL";
    case "title":
      return "title";
    default:
      return "unknown key";
  }
}

export function resolveBullpenEventMatch<T>({
  target,
  candidates,
  getIdentity,
  getSortTimestamp,
}: {
  target: BullpenEventIdentity;
  candidates: T[];
  getIdentity: (candidate: T) => BullpenEventIdentity;
  getSortTimestamp?: (candidate: T) => string | null | undefined;
}): BullpenEventMatchResult<T> {
  const ranked = candidates
    .map((item) => {
      const identity = getIdentity(item);
      const summary = summarizeIdentityMatch(target, identity);
      return {
        item,
        identity,
        score: summary.score,
        matchedMethods: summary.matchedMethods,
        primaryMethod: summary.primaryMethod,
        matchedFieldCount: summary.matchedFieldCount,
        richness: summary.richness,
      } satisfies BullpenEventMatchCandidate<T>;
    })
    .filter((candidate) => candidate.score > 0);

  if (ranked.length === 0) {
    return {
      status: "unmatched",
      match: null,
      matches: [],
      reason: "No shared identity fields matched this event.",
    };
  }

  ranked.sort((left, right) => {
    if (right.score !== left.score) return right.score - left.score;
    if (right.matchedFieldCount !== left.matchedFieldCount) {
      return right.matchedFieldCount - left.matchedFieldCount;
    }
    if (right.richness !== left.richness) {
      return right.richness - left.richness;
    }
    if (getSortTimestamp) {
      const timestampOrder =
        getSortValueMs(getSortTimestamp(right.item)) -
        getSortValueMs(getSortTimestamp(left.item));
      if (timestampOrder !== 0) return timestampOrder;
    }
    return 0;
  });

  const best = ranked[0] ?? null;
  if (!best) {
    return {
      status: "unmatched",
      match: null,
      matches: [],
      reason: "No shared identity fields matched this event.",
    };
  }

  const equivalentTopMatches = ranked.filter(
    (candidate) =>
      candidate.score === best.score &&
      candidate.matchedFieldCount === best.matchedFieldCount &&
      candidate.richness === best.richness &&
      candidate.primaryMethod === best.primaryMethod,
  );

  const isTitleOnlyMatch =
    best.matchedMethods.length > 0 &&
    best.matchedMethods.every((method) => method === "title");
  if (isTitleOnlyMatch && equivalentTopMatches.length > 1) {
    return {
      status: "ambiguous",
      match: null,
      matches: equivalentTopMatches,
      reason:
        "Multiple events matched only by normalized title, so the resolver rejected the match.",
    };
  }

  return {
    status: "matched",
    match: best,
    matches: [best],
    reason: best.primaryMethod
      ? `Matched by ${describeBullpenEventMatchMethod(best.primaryMethod)}.`
      : "Matched by shared event identity.",
  };
}

export const BullpenEventIdentityResolver = {
  canonicalizeBullpenMarketUrl,
  buildIdentity: buildBullpenEventIdentity,
  fromDecision: buildBullpenEventIdentityFromDecision,
  fromPosition: buildBullpenEventIdentityFromPosition,
  fromQuestion: buildBullpenEventIdentityFromQuestion,
  fromRecord: buildBullpenEventIdentityFromRecord,
  resolveMatch: resolveBullpenEventMatch,
  describeMatchMethod: describeBullpenEventMatchMethod,
} as const;
