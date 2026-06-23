export type BullpenActivePositionView = {
  key: string;
  marketId: string;
  marketTitle: string;
  outcome: string;
  shares: number;
  averagePrice: number | null;
  costBasis: number;
  yesOdds: number | null;
  noOdds: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  marketUrl: string | null;
  closeTime: string | null;
  isClaimable: boolean;
  claimableValue: number | null;
  returnsPerDay: number | null;
  rules: string | null;
  marketContext: string | null;
  resolutionSource: string | null;
};

export type BullpenPositionsSummary = {
  activeCount: number;
  claimableCount: number;
  claimableValue: number;
  cashBalance: number | null;
  totalValue: number | null;
  unrealizedPnl: number | null;
  walletValue: number | null;
};

export type BullpenLiveHealthClassification =
  | "AUTH_EXPIRED"
  | "NETWORK_ERROR"
  | "BINARY_MISSING"
  | "JSON_PARSE_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_ERROR";

export type BullpenPositionsSource =
  | "live-cli"
  | "last-successful-live-snapshot"
  | "tracked-positions";

export type BullpenLiveHealth = {
  ok: boolean;
  classification: BullpenLiveHealthClassification | null;
  stdout: string | null;
  stderr: string | null;
  exitCode: number | null;
  signal: string | null;
  commandPath: string | null;
  attemptedPaths?: string[];
  timedOut: boolean;
  timestamp: string;
  credentialHome: string | null;
  message: string;
  actionNeeded: string | null;
};

export type BullpenLiveSnapshot = {
  positions: BullpenActivePositionView[];
  summary: BullpenPositionsSummary;
  fetchedAt: string;
  source: "live-cli";
};

export type BullpenPositionsFallback = {
  active: boolean;
  source: Exclude<BullpenPositionsSource, "live-cli"> | null;
  message: string | null;
};

export type BullpenPositionsResponse = {
  positions?: BullpenActivePositionView[];
  summary?: BullpenPositionsSummary;
  fetchedAt?: string;
  liveAvailable?: boolean;
  positionsSource?: BullpenPositionsSource | null;
  health?: BullpenLiveHealth | null;
  lastSuccessfulLiveSnapshot?: BullpenLiveSnapshot | null;
  fallback?: BullpenPositionsFallback | null;
  error?: string;
};

export type BullpenCliPosition = {
  action?: unknown;
  avg_price?: unknown;
  avgPrice?: unknown;
  claimable?: unknown;
  claimableValue?: unknown;
  claimable_value?: unknown;
  condition_id?: unknown;
  currentPrice?: unknown;
  current_price?: unknown;
  currentValue?: unknown;
  current_value?: unknown;
  endDate?: unknown;
  end_date?: unknown;
  eventSlug?: unknown;
  event_slug?: unknown;
  investedUsd?: unknown;
  invested_usd?: unknown;
  isClaimable?: unknown;
  isRedeemable?: unknown;
  market?: unknown;
  outcome?: unknown;
  pnlPercent?: unknown;
  pnl_percent?: unknown;
  redeemable?: unknown;
  redeemableValue?: unknown;
  redeemable_value?: unknown;
  shares?: unknown;
  slug?: unknown;
  status?: unknown;
  title?: unknown;
  unrealizedPnl?: unknown;
  unrealized_pnl?: unknown;
};

export type BullpenCliPositionsPayload = {
  positions?: unknown;
  summary?: Record<string, unknown> | null;
};

export type BullpenTrackedPositionInput = {
  key: string;
  market_id: string;
  market_title: string;
  outcome: string;
  shares: number;
  average_price: number;
  cost_basis: number;
};

export type BullpenTrackedMarketRefresh = {
  yesOdds?: number | null;
  noOdds?: number | null;
  marketUrl?: string | null;
  rules?: string | null;
  marketContext?: string | null;
  resolutionSource?: string | null;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EASTERN_TIME_ZONE = "America/New_York";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const MONTH_INDEX_BY_NAME: Record<string, string> = {
  january: "01",
  february: "02",
  march: "03",
  april: "04",
  may: "05",
  june: "06",
  july: "07",
  august: "08",
  september: "09",
  october: "10",
  november: "11",
  december: "12",
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

function readPrice(value: unknown) {
  if (typeof value === "number" && Number.isFinite(value)) {
    return value > 1 && value <= 100 ? value / 100 : value;
  }
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (normalized.endsWith("c")) {
      const parsed = Number(normalized.replace(/[,$c\s]/g, ""));
      return Number.isFinite(parsed) ? parsed / 100 : null;
    }
    const parsed = readNumber(value);
    if (parsed === null) return null;
    return parsed > 1 && parsed <= 100 ? parsed / 100 : parsed;
  }
  return null;
}

function readBoolean(value: unknown) {
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return value !== 0;
  if (typeof value === "string") {
    const normalized = value.trim().toLowerCase();
    if (!normalized) return null;
    if (
      [
        "true",
        "yes",
        "y",
        "1",
        "claimable",
        "redeemable",
        "won",
      ].includes(normalized)
    ) {
      return true;
    }
    if (["false", "no", "n", "0", "open"].includes(normalized)) {
      return false;
    }
  }
  return null;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function getEasternUtcOffset(value: Date) {
  const timeZoneLabel = new Intl.DateTimeFormat("en-US", {
    timeZone: EASTERN_TIME_ZONE,
    timeZoneName: "longOffset",
  })
    .formatToParts(value)
    .find((part) => part.type === "timeZoneName")?.value;

  const match = timeZoneLabel?.match(/^GMT([+-])(\d{1,2})(?::?(\d{2}))?$/);
  if (!match) return null;

  const [, sign, hours, minutes = "00"] = match;
  return `${sign}${hours.padStart(2, "0")}:${minutes.padStart(2, "0")}`;
}

export function buildBullpenCloseTimeFromDateOnly(value: string | null) {
  if (!value || !DATE_ONLY_PATTERN.test(value)) return null;

  const offset = getEasternUtcOffset(new Date(`${value}T12:00:00.000Z`));
  const fallback = new Date(`${value}T23:59:59.999Z`);
  if (!offset) {
    return Number.isNaN(fallback.getTime()) ? null : fallback.toISOString();
  }

  const parsed = new Date(`${value}T23:59:59.999${offset}`);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

export function buildBullpenCloseTimeFromMarketTitle(value: string) {
  const matchedDate =
    value.match(
      /\b(?:by|on|before|after|through|until)\s+([A-Z][a-z]+ \d{1,2}, \d{4})\b/i,
    )?.[1] || value.match(/\b([A-Z][a-z]+ \d{1,2}, \d{4})\b/)?.[1];
  if (!matchedDate) return null;

  const match = matchedDate.match(
    /^([A-Z][a-z]+)\s+(\d{1,2}),\s+(\d{4})$/,
  );
  const monthName = match?.[1] || null;
  const day = match?.[2]?.padStart(2, "0");
  const year = match?.[3] || null;
  const month = monthName ? MONTH_INDEX_BY_NAME[monthName.toLowerCase()] : null;
  if (!month || !day || !year) return matchedDate;

  return buildBullpenCloseTimeFromDateOnly(`${year}-${month}-${day}`) || matchedDate;
}

export function getBullpenPositionDaysUntilClose(
  closeTime: string | null,
  nowMs = Date.now(),
) {
  if (!closeTime) return null;

  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;

  return round((closeDate.getTime() - nowMs) / MILLISECONDS_PER_DAY, 1);
}

export function calculateBullpenPositionReturnsPerDay({
  closeTime,
  currentPrice,
  isClaimable = false,
  nowMs = Date.now(),
}: {
  closeTime: string | null;
  currentPrice: number | null;
  isClaimable?: boolean;
  nowMs?: number;
}) {
  if (isClaimable || currentPrice === null) return null;

  const daysUntilClose = getBullpenPositionDaysUntilClose(closeTime, nowMs);
  if (daysUntilClose === null || daysUntilClose <= 0) return null;

  const normalizedPrice =
    currentPrice > 1 && currentPrice <= 100 ? currentPrice / 100 : currentPrice;

  return round(((100 - normalizedPrice * 100) / daysUntilClose), 2);
}

function toBullpenPositionCurrentPrice({
  currentPrice,
  outcome,
  yesOdds,
  noOdds,
}: {
  currentPrice: number | null;
  outcome: string;
  yesOdds: number | null | undefined;
  noOdds: number | null | undefined;
}) {
  const normalizedOutcome = outcome.trim().toLowerCase();
  const refreshedOdds =
    normalizedOutcome === "yes"
      ? yesOdds ?? null
      : normalizedOutcome === "no"
        ? noOdds ?? null
        : null;

  return refreshedOdds === null ? currentPrice : round(refreshedOdds / 100, 4);
}

function deriveBullpenPositionOddsPair({
  outcome,
  currentPrice,
}: {
  outcome: string;
  currentPrice: number | null;
}) {
  if (currentPrice === null) {
    return {
      yesOdds: null,
      noOdds: null,
    };
  }

  const normalizedOutcome = outcome.trim().toLowerCase();
  const normalizedPrice =
    currentPrice > 1 && currentPrice <= 100 ? currentPrice / 100 : currentPrice;
  const heldSideOdds = round(normalizedPrice * 100, 2);
  const oppositeSideOdds = round(100 - heldSideOdds, 2);

  if (normalizedOutcome === "yes") {
    return {
      yesOdds: heldSideOdds,
      noOdds: oppositeSideOdds,
    };
  }

  if (normalizedOutcome === "no") {
    return {
      yesOdds: oppositeSideOdds,
      noOdds: heldSideOdds,
    };
  }

  return {
    yesOdds: null,
    noOdds: null,
  };
}

function extractClaimableStatus(value: BullpenCliPosition) {
  const flags = [
    value.redeemable,
    value.isRedeemable,
    value.claimable,
    value.isClaimable,
  ]
    .map(readBoolean)
    .filter((flag): flag is boolean => flag !== null);
  if (flags.includes(true)) return true;

  const claimText = [value.action, value.status]
    .map(readString)
    .filter((entry): entry is string => Boolean(entry))
    .join(" ")
    .toLowerCase();

  return /\b(claim|redeem|claimable|redeemable|won)\b/.test(claimText);
}

export function normalizeBullpenPosition(
  value: BullpenCliPosition,
  buildMarketUrl: (eventSlug: string | null) => string | null,
): BullpenActivePositionView {
  const marketId =
    readString(value.slug) ||
    readString(value.condition_id) ||
    readString(value.market) ||
    "unknown-market";
  const marketTitle =
    readString(value.market) || readString(value.title) || marketId;
  const outcome = readString(value.outcome) || "—";
  const shares = readNumber(value.shares) || 0;
  const averagePrice = readPrice(value.avg_price ?? value.avgPrice);
  const costBasis =
    readNumber(value.invested_usd ?? value.investedUsd) ??
    (averagePrice !== null ? shares * averagePrice : 0);
  const currentPrice = readPrice(value.current_price ?? value.currentPrice);
  const currentValue =
    readNumber(value.current_value ?? value.currentValue) ??
    (currentPrice !== null ? shares * currentPrice : null);
  const unrealizedPnl =
    readNumber(value.unrealized_pnl ?? value.unrealizedPnl) ??
    (currentValue !== null ? currentValue - costBasis : null);
  const unrealizedPnlPercent =
    readNumber(value.pnl_percent ?? value.pnlPercent) ??
    (costBasis > 0 && unrealizedPnl !== null
      ? (unrealizedPnl / costBasis) * 100
      : null);
  const eventSlug = readString(value.event_slug ?? value.eventSlug);
  const closeDate = readString(value.end_date ?? value.endDate);
  const closeTime = buildBullpenCloseTimeFromDateOnly(closeDate);
  const isClaimable = extractClaimableStatus(value);
  const { yesOdds, noOdds } = deriveBullpenPositionOddsPair({
    outcome,
    currentPrice,
  });
  const claimableValue =
    readNumber(value.claimableValue) ??
    readNumber(value.claimable_value) ??
    readNumber(value.redeemableValue) ??
    readNumber(value.redeemable_value) ??
    (isClaimable ? currentValue ?? costBasis : null);

  return {
    key: `${marketId}::${outcome}`,
    marketId,
    marketTitle,
    outcome,
    shares: round(shares, 4),
    averagePrice: averagePrice === null ? null : round(averagePrice, 4),
    costBasis: round(costBasis, 2),
    yesOdds,
    noOdds,
    currentPrice: currentPrice === null ? null : round(currentPrice, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    unrealizedPnl: unrealizedPnl === null ? null : round(unrealizedPnl, 2),
    unrealizedPnlPercent:
      unrealizedPnlPercent === null ? null : round(unrealizedPnlPercent, 2),
    marketUrl: buildMarketUrl(eventSlug),
    closeTime,
    isClaimable,
    claimableValue: claimableValue === null ? null : round(claimableValue, 2),
    returnsPerDay: calculateBullpenPositionReturnsPerDay({
      closeTime,
      currentPrice,
      isClaimable,
    }),
    rules: null,
    marketContext: null,
    resolutionSource: null,
  };
}

export function applyBullpenPositionMarketData(
  position: BullpenActivePositionView,
  marketData: {
    yesOdds?: number | null;
    noOdds?: number | null;
    marketUrl?: string | null;
    rules?: string | null;
    marketContext?: string | null;
    resolutionSource?: string | null;
  },
) {
  const currentPrice = toBullpenPositionCurrentPrice({
    currentPrice: position.currentPrice,
    outcome: position.outcome,
    yesOdds: marketData.yesOdds,
    noOdds: marketData.noOdds,
  });
  const derivedOdds = deriveBullpenPositionOddsPair({
    outcome: position.outcome,
    currentPrice,
  });
  const yesOdds = marketData.yesOdds ?? derivedOdds.yesOdds ?? position.yesOdds;
  const noOdds = marketData.noOdds ?? derivedOdds.noOdds ?? position.noOdds;
  const currentValue =
    currentPrice === null ? null : round(position.shares * currentPrice, 2);
  const unrealizedPnl =
    currentValue === null ? null : round(currentValue - position.costBasis, 2);
  const unrealizedPnlPercent =
    unrealizedPnl === null || position.costBasis <= 0
      ? null
      : round((unrealizedPnl / position.costBasis) * 100, 2);

  return {
    ...position,
    yesOdds,
    noOdds,
    currentPrice,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    marketUrl: marketData.marketUrl ?? position.marketUrl,
    returnsPerDay: calculateBullpenPositionReturnsPerDay({
      closeTime: position.closeTime,
      currentPrice,
      isClaimable: position.isClaimable,
    }),
    rules: marketData.rules ?? position.rules,
    marketContext: marketData.marketContext ?? position.marketContext,
    resolutionSource:
      marketData.resolutionSource ?? position.resolutionSource,
  } satisfies BullpenActivePositionView;
}

export function buildTrackedBullpenPositionViews(
  openPositions: BullpenTrackedPositionInput[],
  marketUpdates: Record<string, BullpenTrackedMarketRefresh>,
  resolveCloseTime: (marketTitle: string) => string | null = (marketTitle) =>
    buildBullpenCloseTimeFromMarketTitle(marketTitle),
) {
  return openPositions
    .filter((position) => position.shares > 0)
    .map((position) => {
      const marketUpdate = marketUpdates[position.key];
      const closeTime = resolveCloseTime(position.market_title);
      const basePosition = {
        key: position.key,
        marketId: position.market_id,
        marketTitle: position.market_title,
        outcome: position.outcome,
        shares: position.shares,
        averagePrice: round(position.average_price, 4),
        costBasis: round(position.cost_basis, 2),
        yesOdds: marketUpdate?.yesOdds ?? null,
        noOdds: marketUpdate?.noOdds ?? null,
        currentPrice: null,
        currentValue: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        marketUrl: marketUpdate?.marketUrl ?? null,
        closeTime,
        isClaimable: false,
        claimableValue: null,
        returnsPerDay: calculateBullpenPositionReturnsPerDay({
          closeTime,
          currentPrice: null,
        }),
        rules: marketUpdate?.rules ?? null,
        marketContext: marketUpdate?.marketContext ?? null,
        resolutionSource: marketUpdate?.resolutionSource ?? null,
      } satisfies BullpenActivePositionView;

      return applyBullpenPositionMarketData(basePosition, marketUpdate || {});
    });
}

function sumCurrentPositionValue(positions: BullpenActivePositionView[]) {
  return round(
    positions.reduce(
      (total, position) => total + (position.currentValue ?? position.costBasis),
      0,
    ),
    2,
  );
}

function sumUnrealizedPnl(positions: BullpenActivePositionView[]) {
  return round(
    positions.reduce(
      (total, position) => total + (position.unrealizedPnl ?? 0),
      0,
    ),
    2,
  );
}

export function summarizeBullpenPositions(
  positions: BullpenActivePositionView[],
  summary?: Record<string, unknown> | null,
): BullpenPositionsSummary {
  const claimablePositions = positions.filter((position) => position.isClaimable);
  const claimableValue = round(
    claimablePositions.reduce(
      (total, position) =>
        total +
        (position.claimableValue ?? position.currentValue ?? position.costBasis),
      0,
    ),
    2,
  );

  return {
    activeCount: readNumber(summary?.active_count) ?? positions.length,
    claimableCount: claimablePositions.length,
    claimableValue,
    cashBalance: readNumber(summary?.cash_balance),
    totalValue:
      readNumber(summary?.total_value) ?? sumCurrentPositionValue(positions),
    unrealizedPnl:
      readNumber(summary?.unrealized_pnl) ?? sumUnrealizedPnl(positions),
    walletValue: readNumber(summary?.wallet_value),
  };
}

export function buildClaimableBullpenSignature(
  positions: BullpenActivePositionView[],
) {
  return positions
    .filter((position) => position.isClaimable)
    .map((position) => position.key)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}
