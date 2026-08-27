export type BullpenActivePositionView = {
  key: string;
  marketId: string;
  marketSlug: string | null;
  eventSlug: string | null;
  slug: string | null;
  conditionId: string | null;
  marketTitle: string;
  outcome: string;
  heldSide?: "YES" | "NO" | null;
  shares: number;
  averagePrice: number | null;
  costBasis: number;
  yesOdds: number | null;
  noOdds: number | null;
  bestBidPrice?: number | null;
  bestAskPrice?: number | null;
  currentPrice: number | null;
  currentValue: number | null;
  expectedPayoutUsd: number | null;
  unrealizedPnl: number | null;
  unrealizedPnlPercent: number | null;
  marketUrl: string | null;
  closeTime: string | null;
  resolutionStatus: string | null;
  economicClassification: BullpenPositionEconomicClassification;
  classificationReason: string;
  isClaimable: boolean;
  claimableSignal: boolean;
  upstreamRedeemable: boolean;
  claimableValue: number | null;
  returnsPerDay: number | null;
  rules: string | null;
  marketContext: string | null;
  resolutionSource: string | null;
};

export type BullpenPositionEconomicClassification =
  | "active"
  | "positive_payout_claimable"
  | "settlement_pending"
  | "resolved_zero_payout"
  | "stale_or_unknown"
  | "closed";

export type BullpenExcludedPositionDiagnostic = {
  key: string;
  marketId: string;
  slug: string | null;
  conditionId: string | null;
  marketTitle: string;
  outcome: string;
  shares: number;
  closeTime: string | null;
  currentValue: number | null;
  expectedPayoutUsd: number | null;
  economicClassification: BullpenPositionEconomicClassification;
  classificationReason: string;
};

export type BullpenPositionsDiagnostics = {
  excludedPositionCount: number;
  diagnosticPositionCount: number;
  settlementPendingCount: number;
  staleOrUnknownCount: number;
  closedPositionCount: number;
  resolvedZeroPayoutCount: number;
  settlementPendingPositions: BullpenExcludedPositionDiagnostic[];
  diagnosticPositions: BullpenExcludedPositionDiagnostic[];
  excludedPositions: BullpenExcludedPositionDiagnostic[];
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
  | "AUTH_REQUIRED"
  | "AUTH_EXPIRED"
  | "NETWORK_ERROR"
  | "BINARY_MISSING"
  | "JSON_PARSE_ERROR"
  | "TIMEOUT"
  | "UNKNOWN_ERROR";

export type BullpenPositionsSource =
  | "live-cli"
  | "redis-cache"
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

export type BullpenPositionsSnapshotLineage = {
  accountIdentity: string | null;
  credentialArtifact: {
    inode: number | null;
    mtimeNs: number | null;
    size: number | null;
  };
  positionClassifierVersion: number | null;
  source: string | null;
  freshnessState: string | null;
};

export type BullpenPositionsLineageMismatchField =
  | "lineage"
  | "account-identity"
  | "credential-inode"
  | "credential-mtime"
  | "credential-size"
  | "position-classifier";

export type BullpenLiveSnapshot = {
  positions: BullpenActivePositionView[];
  summary: BullpenPositionsSummary;
  diagnostics: BullpenPositionsDiagnostics;
  fetchedAt: string;
  source: "live-cli" | "redis-cache";
  lineage?: BullpenPositionsSnapshotLineage | null;
};

export type BullpenPositionsFallback = {
  active: boolean;
  source: Exclude<BullpenPositionsSource, "live-cli"> | null;
  message: string | null;
};

export type BullpenPositionsResponse = {
  positions?: BullpenActivePositionView[];
  summary?: BullpenPositionsSummary;
  diagnostics?: BullpenPositionsDiagnostics;
  fetchedAt?: string;
  liveAvailable?: boolean;
  positionsSource?: BullpenPositionsSource | null;
  health?: BullpenLiveHealth | null;
  lastSuccessfulLiveSnapshot?: BullpenLiveSnapshot | null;
  lineage?: BullpenPositionsSnapshotLineage | null;
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
  conditionId?: unknown;
  condition_id?: unknown;
  currentPrice?: unknown;
  current_price?: unknown;
  curPrice?: unknown;
  cur_price?: unknown;
  currentValue?: unknown;
  current_value?: unknown;
  expectedPayoutUsd?: unknown;
  expectedPayoutUSDC?: unknown;
  expected_payout_usdc?: unknown;
  endDate?: unknown;
  end_date?: unknown;
  eventSlug?: unknown;
  event_slug?: unknown;
  investedUsd?: unknown;
  invested_usd?: unknown;
  initialValue?: unknown;
  initial_value?: unknown;
  isClaimable?: unknown;
  isRedeemable?: unknown;
  market?: unknown;
  marketSlug?: unknown;
  market_slug?: unknown;
  outcome?: unknown;
  pnlPercent?: unknown;
  pnl_percent?: unknown;
  percentPnl?: unknown;
  percent_pnl?: unknown;
  redeemable?: unknown;
  redeemableValue?: unknown;
  redeemable_value?: unknown;
  resolutionStatus?: unknown;
  resolution_status?: unknown;
  shares?: unknown;
  size?: unknown;
  slug?: unknown;
  status?: unknown;
  title?: unknown;
  unrealizedPnl?: unknown;
  unrealized_pnl?: unknown;
  cashPnl?: unknown;
  cash_pnl?: unknown;
  upstream_redeemable?: unknown;
  upstreamRedeemable?: unknown;
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
  conditionId?: string | null;
  marketSlug?: string | null;
  eventSlug?: string | null;
  slug?: string | null;
  authoritativeMarketOpen?: boolean | null;
  yesOdds?: number | null;
  noOdds?: number | null;
  bestBidPrice?: number | null;
  bestAskPrice?: number | null;
  marketUrl?: string | null;
  rules?: string | null;
  marketContext?: string | null;
  resolutionSource?: string | null;
};

const DATE_ONLY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const EASTERN_TIME_ZONE = "America/New_York";
const MILLISECONDS_PER_DAY = 24 * 60 * 60 * 1000;
const CONDITION_ID_PATTERN = /^0x[a-f0-9]{64}$/i;
const VALUE_EPSILON = 0.000001;
const BULLPEN_POSITION_HISTORY_CONTAINER_KEYS = new Set([
  "activities",
  "activity",
  "history",
  "transactions",
  "trades",
  "redemptions",
]);
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

function isPositiveValue(value: number | null) {
  return value !== null && value > VALUE_EPSILON;
}

function isExplicitZeroValue(value: number | null) {
  return value !== null && Math.abs(value) <= VALUE_EPSILON;
}

function deriveHeldSide(outcome: string) {
  const normalized = outcome.trim().toUpperCase();
  if (normalized === "YES" || normalized === "NO") {
    return normalized;
  }
  return null;
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

  return round(((100 - normalizedPrice * 100) / (daysUntilClose + 4)), 2);
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

  return /\b(claim|redeem|claimable|redeemable)\b/.test(claimText);
}

function extractUpstreamRedeemableStatus(value: BullpenCliPosition) {
  return Boolean(
    readBoolean(value.upstream_redeemable) ??
      readBoolean(value.upstreamRedeemable),
  );
}

function readResolutionStatus(value: BullpenCliPosition) {
  return readString(value.resolution_status ?? value.resolutionStatus ?? value.status);
}

function hasPastCloseTime(closeTime: string | null, nowMs = Date.now()) {
  if (!closeTime) return null;
  const closeDate = new Date(closeTime);
  if (Number.isNaN(closeDate.getTime())) return null;
  return closeDate.getTime() <= nowMs;
}

function classifyBullpenPosition({
  shares,
  closeTime,
  currentPrice,
  currentValue,
  expectedPayoutUsd,
  payoutValueUsd,
  claimableFlag,
  upstreamRedeemable,
  resolutionStatus,
  authoritativeMarketOpen = null,
  nowMs = Date.now(),
}: {
  shares: number;
  closeTime: string | null;
  currentPrice: number | null;
  currentValue: number | null;
  expectedPayoutUsd: number | null;
  payoutValueUsd: number | null;
  claimableFlag: boolean;
  upstreamRedeemable: boolean;
  resolutionStatus: string | null;
  authoritativeMarketOpen?: boolean | null;
  nowMs?: number;
}): {
  economicClassification: BullpenPositionEconomicClassification;
  classificationReason: string;
  isClaimable: boolean;
  claimableValue: number | null;
  claimableSignal: boolean;
  upstreamRedeemable: boolean;
} {
  const pastCloseTime = hasPastCloseTime(closeTime, nowMs);
  const normalizedResolutionStatus = resolutionStatus?.trim().toLowerCase() || null;
  const currentMarketIsOpen = authoritativeMarketOpen === true;
  const currentMarketIsClosed = authoritativeMarketOpen === false;
  const resolvedByStatus =
    normalizedResolutionStatus !== null &&
    /won|resolved|closed|expired|settled|redeemed|claimable|redeemable|final/i.test(
      normalizedResolutionStatus,
    );
  // Keep this in lockstep with backend classifier v4. A fresh authoritative
  // open-market match is stronger than stale wallet redeemability or payout
  // hints. Bullpen has emitted redeemable flags for still-open child markets.
  const positivePayoutVerified =
    !currentMarketIsOpen &&
    (isPositiveValue(expectedPayoutUsd) ||
      isPositiveValue(payoutValueUsd) ||
      ((pastCloseTime === true || resolvedByStatus) &&
        isPositiveValue(currentValue)));
  const closeTimeIsPast = pastCloseTime === true && !currentMarketIsOpen;
  const redeemabilityExists = claimableFlag || upstreamRedeemable;

  if (shares <= VALUE_EPSILON && !positivePayoutVerified) {
    return {
      economicClassification: "closed",
      classificationReason:
        "No economically meaningful Bullpen exposure remains for this row.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (positivePayoutVerified) {
    const claimableValue =
      payoutValueUsd ?? expectedPayoutUsd ?? currentValue ?? null;
    return {
      economicClassification: "positive_payout_claimable",
      classificationReason:
        "Bullpen reported verified positive payout evidence for this resolved position.",
      isClaimable: true,
      claimableValue: claimableValue === null ? null : round(claimableValue, 2),
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (
    closeTimeIsPast &&
    isExplicitZeroValue(currentValue) &&
    isExplicitZeroValue(expectedPayoutUsd)
  ) {
    return {
      economicClassification: "resolved_zero_payout",
      classificationReason:
        "The market has closed and both current value and expected payout are explicitly zero.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (closeTimeIsPast && redeemabilityExists) {
    return {
      economicClassification: "settlement_pending",
      classificationReason:
        "The market has closed and Bullpen exposes redeemability, but no verified payout amount is available yet.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (currentPrice === null && currentValue === null) {
    return {
      economicClassification: "stale_or_unknown",
      classificationReason:
        "Bullpen did not provide enough fresh pricing to treat this row as an economically active position.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (closeTimeIsPast) {
    return {
      economicClassification: "stale_or_unknown",
      classificationReason:
        "The event close time has passed, but Bullpen did not provide enough settlement evidence to keep it active.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (resolvedByStatus && !currentMarketIsOpen) {
    return {
      economicClassification: "stale_or_unknown",
      classificationReason:
        "Bullpen marked the row as resolved or closed, but did not provide verified payout evidence.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  if (currentMarketIsClosed) {
    return {
      economicClassification: "stale_or_unknown",
      classificationReason:
        "An authoritative market lookup confirmed that this market is not open, but no verified settlement payout is available.",
      isClaimable: false,
      claimableValue: null,
      claimableSignal: claimableFlag,
      upstreamRedeemable,
    };
  }

  return {
    economicClassification: "active",
    classificationReason:
      currentMarketIsOpen
        ? "An authoritative live market lookup confirmed that this position is still open."
        : "This row still looks like an economically active Bullpen position.",
    isClaimable: false,
    claimableValue: null,
    claimableSignal: claimableFlag,
    upstreamRedeemable,
  };
}

function applyBullpenPositionClassification(
  position: Omit<
    BullpenActivePositionView,
    | "economicClassification"
    | "classificationReason"
    | "isClaimable"
    | "claimableSignal"
    | "upstreamRedeemable"
    | "claimableValue"
    | "returnsPerDay"
  > & {
    rawClaimableFlag?: boolean;
    rawUpstreamRedeemable?: boolean;
    claimableValue: number | null;
    returnsPerDay?: number | null;
    authoritativeMarketOpen?: boolean | null;
  },
) {
  const classification = classifyBullpenPosition({
    shares: position.shares,
    closeTime: position.closeTime,
    currentPrice: position.currentPrice,
    currentValue: position.currentValue,
    expectedPayoutUsd: position.expectedPayoutUsd,
    payoutValueUsd: position.claimableValue,
    claimableFlag: Boolean(position.rawClaimableFlag),
    upstreamRedeemable: Boolean(position.rawUpstreamRedeemable),
    resolutionStatus: position.resolutionStatus,
    authoritativeMarketOpen: position.authoritativeMarketOpen,
  });
  const basePosition = { ...position };
  delete basePosition.rawClaimableFlag;
  delete basePosition.rawUpstreamRedeemable;
  delete basePosition.authoritativeMarketOpen;

  return {
    ...basePosition,
    economicClassification: classification.economicClassification,
    classificationReason: classification.classificationReason,
    isClaimable: classification.isClaimable,
    claimableSignal: classification.claimableSignal,
    upstreamRedeemable: classification.upstreamRedeemable,
    claimableValue: classification.claimableValue,
    returnsPerDay: calculateBullpenPositionReturnsPerDay({
      closeTime: position.closeTime,
      currentPrice: position.currentPrice,
      isClaimable: classification.isClaimable,
    }),
  } satisfies BullpenActivePositionView;
}

function isBullpenCliPositionRecord(value: unknown): value is BullpenCliPosition {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return false;
  }

  const record = value as Record<string, unknown>;
  const hasIdentifier = Boolean(
    readString(record.slug) ||
      readString(record.market_slug ?? record.marketSlug) ||
      readString(record.condition_id ?? record.conditionId) ||
      readString(record.market) ||
      readString(record.title) ||
      readString(record.event_slug ?? record.eventSlug),
  );
  const hasPositionSignal = [
    "avg_price",
    "avgPrice",
    "current_price",
    "currentPrice",
    "cur_price",
    "curPrice",
    "current_value",
    "currentValue",
    "invested_usd",
    "investedUsd",
    "initial_value",
    "initialValue",
    "cash_pnl",
    "cashPnl",
    "percent_pnl",
    "percentPnl",
    "claimableValue",
    "claimable_value",
    "redeemableValue",
    "redeemable_value",
    "redeemable",
    "isRedeemable",
    "claimable",
    "isClaimable",
    "end_date",
    "endDate",
  ].some((key) => key in record);

  return hasIdentifier && hasPositionSignal;
}

export function extractBullpenCliPositionRows(value: unknown) {
  const rows: BullpenCliPosition[] = [];
  const seen = new Set<object>();

  const walk = (current: unknown) => {
    if (Array.isArray(current)) {
      current.forEach(walk);
      return;
    }
    if (!current || typeof current !== "object") {
      return;
    }

    const record = current as Record<string, unknown>;
    if (seen.has(record)) {
      return;
    }
    seen.add(record);

    if (isBullpenCliPositionRecord(record)) {
      rows.push(record);
      return;
    }

    Object.entries(record).forEach(([key, nested]) => {
      if (BULLPEN_POSITION_HISTORY_CONTAINER_KEYS.has(key)) {
        return;
      }
      if (nested && typeof nested === "object") {
        walk(nested);
      }
    });
  };

  walk(value);
  return rows;
}

function buildBullpenCliAliases(position: BullpenCliPosition) {
  const market = readString(position.market) || readString(position.title);
  const aliases = [
    readString(position.slug),
    readString(position.market_slug ?? position.marketSlug),
    readString(position.condition_id ?? position.conditionId),
    market,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(aliases)];
}

function mergeBullpenCliPosition(
  existing: BullpenCliPosition,
  incoming: BullpenCliPosition,
) {
  const existingShares = readNumber(existing.shares ?? existing.size) || 0;
  const incomingShares = readNumber(incoming.shares ?? incoming.size) || 0;
  const shares = round(existingShares + incomingShares, 4);
  const existingCostBasis =
    readNumber(
      existing.invested_usd ??
        existing.investedUsd ??
        existing.initial_value ??
        existing.initialValue,
    ) ?? 0;
  const incomingCostBasis =
    readNumber(
      incoming.invested_usd ??
        incoming.investedUsd ??
        incoming.initial_value ??
        incoming.initialValue,
    ) ?? 0;
  const investedUsd = round(existingCostBasis + incomingCostBasis, 2);
  const averagePrice =
    shares > 0 ? round(investedUsd / shares, 4) : readPrice(existing.avg_price ?? existing.avgPrice);
  const existingCurrentValue =
    readNumber(existing.current_value ?? existing.currentValue) ??
    ((readPrice(
      existing.current_price ??
        existing.currentPrice ??
        existing.cur_price ??
        existing.curPrice,
    ) ?? 0) * existingShares);
  const incomingCurrentValue =
    readNumber(incoming.current_value ?? incoming.currentValue) ??
    ((readPrice(
      incoming.current_price ??
        incoming.currentPrice ??
        incoming.cur_price ??
        incoming.curPrice,
    ) ?? 0) * incomingShares);
  const currentValue = round(existingCurrentValue + incomingCurrentValue, 2);
  const currentPrice = shares > 0 ? round(currentValue / shares, 4) : null;

  return {
    ...existing,
    slug:
      readString(existing.slug) ??
      readString(existing.market_slug ?? existing.marketSlug) ??
      readString(incoming.slug) ??
      readString(incoming.market_slug ?? incoming.marketSlug) ??
      existing.slug ??
      incoming.slug,
    market_slug:
      readString(existing.market_slug ?? existing.marketSlug) ??
      readString(incoming.market_slug ?? incoming.marketSlug) ??
      existing.market_slug ??
      existing.marketSlug ??
      incoming.market_slug ??
      incoming.marketSlug,
    condition_id:
      readString(existing.condition_id ?? existing.conditionId) ??
      readString(incoming.condition_id ?? incoming.conditionId) ??
      existing.condition_id ??
      existing.conditionId ??
      incoming.condition_id ??
      incoming.conditionId,
    market: readString(existing.market) ?? readString(incoming.market) ?? existing.market ?? incoming.market,
    shares,
    avg_price: averagePrice,
    invested_usd: investedUsd,
    current_price: currentPrice,
    current_value: currentValue,
    expected_payout_usdc:
      readNumber(existing.expected_payout_usdc ?? existing.expectedPayoutUSDC ?? existing.expectedPayoutUsd) !== null ||
      readNumber(incoming.expected_payout_usdc ?? incoming.expectedPayoutUSDC ?? incoming.expectedPayoutUsd) !== null
        ? round(
            Math.max(
              readNumber(existing.expected_payout_usdc ?? existing.expectedPayoutUSDC ?? existing.expectedPayoutUsd) ?? 0,
              readNumber(incoming.expected_payout_usdc ?? incoming.expectedPayoutUSDC ?? incoming.expectedPayoutUsd) ?? 0,
            ),
            2,
          )
        : existing.expected_payout_usdc ??
          existing.expectedPayoutUSDC ??
          existing.expectedPayoutUsd ??
          incoming.expected_payout_usdc ??
          incoming.expectedPayoutUSDC ??
          incoming.expectedPayoutUsd,
    claimableValue:
      readNumber(existing.claimableValue ?? existing.claimable_value) !== null ||
      readNumber(incoming.claimableValue ?? incoming.claimable_value) !== null
        ? round(
            (readNumber(existing.claimableValue ?? existing.claimable_value) ?? 0) +
              (readNumber(incoming.claimableValue ?? incoming.claimable_value) ?? 0),
            2,
          )
        : existing.claimableValue ?? existing.claimable_value ?? incoming.claimableValue ?? incoming.claimable_value,
    end_date:
      readString(existing.end_date ?? existing.endDate) ??
      readString(incoming.end_date ?? incoming.endDate) ??
      existing.end_date ??
      existing.endDate ??
      incoming.end_date ??
      incoming.endDate,
    event_slug:
      readString(existing.event_slug ?? existing.eventSlug) ??
      readString(incoming.event_slug ?? incoming.eventSlug) ??
      existing.event_slug ??
      existing.eventSlug ??
      incoming.event_slug ??
      incoming.eventSlug,
    resolution_status:
      readString(existing.resolution_status ?? existing.resolutionStatus) ??
      readString(incoming.resolution_status ?? incoming.resolutionStatus) ??
      existing.resolution_status ??
      existing.resolutionStatus ??
      incoming.resolution_status ??
      incoming.resolutionStatus,
    upstream_redeemable:
      readBoolean(existing.upstream_redeemable ?? existing.upstreamRedeemable) ??
      readBoolean(incoming.upstream_redeemable ?? incoming.upstreamRedeemable) ??
      existing.upstream_redeemable ??
      existing.upstreamRedeemable ??
      incoming.upstream_redeemable ??
      incoming.upstreamRedeemable,
  } satisfies BullpenCliPosition;
}

export function aggregateBullpenCliPositions(positions: BullpenCliPosition[]) {
  const grouped = new Map<string, BullpenCliPosition>();
  const aliasToGroup = new Map<string, string>();

  for (const [index, position] of positions.entries()) {
    const outcome = (readString(position.outcome) || "—").toLowerCase();
    const isClaimable = extractClaimableStatus(position) ? "claimable" : "open";
    const aliases = buildBullpenCliAliases(position).map(
      (alias) => `${outcome}::${isClaimable}::${alias}`,
    );
    const existingGroupKey = aliases.find((alias) => aliasToGroup.has(alias));
    const groupKey = existingGroupKey
      ? (aliasToGroup.get(existingGroupKey) ?? existingGroupKey)
      : aliases[0] ?? `${outcome}::${isClaimable}::bullpen-position-${index + 1}`;
    const existing = groupKey ? grouped.get(groupKey) : undefined;

    if (existing && groupKey) {
      grouped.set(groupKey, mergeBullpenCliPosition(existing, position));
    } else if (groupKey) {
      grouped.set(groupKey, position);
    }

    for (const alias of aliases) {
      if (groupKey) {
        aliasToGroup.set(alias, groupKey);
      }
    }
  }

  return Array.from(grouped.values());
}

export function normalizeBullpenPosition(
  value: BullpenCliPosition,
  buildMarketUrl: (eventSlug: string | null) => string | null,
): BullpenActivePositionView {
  const rawConditionId = readString(value.condition_id ?? value.conditionId);
  const marketSlug =
    readString(value.market_slug ?? value.marketSlug) ??
    readString(value.slug);
  const marketId =
    marketSlug ||
    rawConditionId ||
    readString(value.market) ||
    "unknown-market";
  const conditionId =
    rawConditionId || (CONDITION_ID_PATTERN.test(marketId) ? marketId : null);
  const marketTitle =
    readString(value.market) || readString(value.title) || marketId;
  const outcome = readString(value.outcome) || "—";
  const shares = readNumber(value.shares ?? value.size) || 0;
  const averagePrice = readPrice(value.avg_price ?? value.avgPrice);
  const costBasis =
    readNumber(
      value.invested_usd ??
        value.investedUsd ??
        value.initial_value ??
        value.initialValue,
    ) ?? (averagePrice !== null ? shares * averagePrice : 0);
  const currentPrice = readPrice(
    value.current_price ??
      value.currentPrice ??
      value.cur_price ??
      value.curPrice,
  );
  const currentValue =
    readNumber(value.current_value ?? value.currentValue) ??
    (currentPrice !== null ? shares * currentPrice : null);
  const unrealizedPnl =
    readNumber(
      value.unrealized_pnl ??
        value.unrealizedPnl ??
        value.cash_pnl ??
        value.cashPnl,
    ) ??
    (currentValue !== null ? currentValue - costBasis : null);
  const unrealizedPnlPercent =
    readNumber(
      value.pnl_percent ??
        value.pnlPercent ??
        value.percent_pnl ??
        value.percentPnl,
    ) ??
    (costBasis > 0 && unrealizedPnl !== null
      ? (unrealizedPnl / costBasis) * 100
      : null);
  const eventSlug = readString(value.event_slug ?? value.eventSlug);
  const closeDate = readString(value.end_date ?? value.endDate);
  const closeTime = buildBullpenCloseTimeFromDateOnly(closeDate);
  const rawClaimableFlag = extractClaimableStatus(value);
  const rawUpstreamRedeemable = extractUpstreamRedeemableStatus(value);
  const { yesOdds, noOdds } = deriveBullpenPositionOddsPair({
    outcome,
    currentPrice,
  });
  const claimableValue =
    readNumber(value.claimableValue) ??
    readNumber(value.claimable_value) ??
    readNumber(value.redeemableValue) ??
    readNumber(value.redeemable_value) ??
    null;
  const expectedPayoutUsd =
    readNumber(
      value.expected_payout_usdc ??
        value.expectedPayoutUSDC ??
        value.expectedPayoutUsd,
    ) ?? null;
  const resolutionStatus = readResolutionStatus(value);

  return applyBullpenPositionClassification({
    key: `${marketId}::${outcome}`,
    marketId,
    marketSlug,
    eventSlug,
    // Preserve the legacy raw-wallet alias while retaining both canonical
    // identities explicitly. Successful market enrichment may update this
    // compatibility field to the matched market slug, as it did previously.
    slug: eventSlug,
    conditionId,
    marketTitle,
    outcome,
    heldSide: deriveHeldSide(outcome),
    shares: round(shares, 4),
    averagePrice: averagePrice === null ? null : round(averagePrice, 4),
    costBasis: round(costBasis, 2),
    yesOdds,
    noOdds,
    bestBidPrice: null,
    bestAskPrice: null,
    currentPrice: currentPrice === null ? null : round(currentPrice, 4),
    currentValue: currentValue === null ? null : round(currentValue, 2),
    expectedPayoutUsd:
      expectedPayoutUsd === null ? null : round(expectedPayoutUsd, 2),
    unrealizedPnl: unrealizedPnl === null ? null : round(unrealizedPnl, 2),
    unrealizedPnlPercent:
      unrealizedPnlPercent === null ? null : round(unrealizedPnlPercent, 2),
    marketUrl: buildMarketUrl(eventSlug),
    closeTime,
    resolutionStatus,
    rawClaimableFlag,
    rawUpstreamRedeemable,
    claimableValue: claimableValue === null ? null : round(claimableValue, 2),
    rules: null,
    marketContext: null,
    resolutionSource: null,
  });
}

function buildBullpenPositionAliases(position: BullpenActivePositionView) {
  const aliases = [
    position.marketId,
    position.marketSlug,
    position.eventSlug,
    position.slug,
    position.conditionId,
    position.marketTitle,
  ].filter((value): value is string => Boolean(value));
  return [...new Set(aliases)];
}

function mergeBullpenPositionViews(
  existing: BullpenActivePositionView,
  incoming: BullpenActivePositionView,
) {
  const shares = round(existing.shares + incoming.shares, 4);
  const costBasis = round(existing.costBasis + incoming.costBasis, 2);
  const averagePrice =
    shares > 0 ? round(costBasis / shares, 4) : existing.averagePrice ?? incoming.averagePrice;
  const currentValue =
    existing.currentValue !== null || incoming.currentValue !== null
      ? round((existing.currentValue ?? 0) + (incoming.currentValue ?? 0), 2)
      : null;
  const currentPrice =
    currentValue !== null && shares > 0 ? round(currentValue / shares, 4) : existing.currentPrice;
  const normalizedOutcome = existing.outcome.trim().toLowerCase();
  const heldSideOdds =
    currentPrice === null ? null : round((currentPrice > 1 ? currentPrice / 100 : currentPrice) * 100, 2);
  const yesOdds =
    normalizedOutcome === "yes"
      ? heldSideOdds
      : heldSideOdds === null
        ? existing.yesOdds ?? incoming.yesOdds
        : round(100 - heldSideOdds, 2);
  const noOdds =
    normalizedOutcome === "no"
      ? heldSideOdds
      : heldSideOdds === null
        ? existing.noOdds ?? incoming.noOdds
        : round(100 - heldSideOdds, 2);
  const unrealizedPnl = currentValue === null ? null : round(currentValue - costBasis, 2);
  const unrealizedPnlPercent =
    unrealizedPnl === null || costBasis <= 0
      ? null
      : round((unrealizedPnl / costBasis) * 100, 2);
  const claimableValue =
    existing.claimableValue !== null || incoming.claimableValue !== null
      ? round((existing.claimableValue ?? 0) + (incoming.claimableValue ?? 0), 2)
      : null;

  return applyBullpenPositionClassification({
    ...existing,
    key: existing.key,
    marketSlug: existing.marketSlug ?? incoming.marketSlug,
    eventSlug: existing.eventSlug ?? incoming.eventSlug,
    slug: existing.slug ?? incoming.slug,
    conditionId: existing.conditionId ?? incoming.conditionId,
    marketTitle:
      existing.marketTitle && existing.marketTitle !== existing.marketId
        ? existing.marketTitle
        : incoming.marketTitle,
    heldSide: existing.heldSide ?? incoming.heldSide,
    shares,
    averagePrice,
    costBasis,
    bestBidPrice: existing.bestBidPrice ?? incoming.bestBidPrice,
    bestAskPrice: existing.bestAskPrice ?? incoming.bestAskPrice,
    currentPrice,
    currentValue,
    expectedPayoutUsd:
      existing.expectedPayoutUsd ?? incoming.expectedPayoutUsd,
    unrealizedPnl,
    unrealizedPnlPercent,
    marketUrl: existing.marketUrl ?? incoming.marketUrl,
    closeTime: existing.closeTime ?? incoming.closeTime,
    yesOdds,
    noOdds,
    resolutionStatus:
      existing.resolutionStatus ?? incoming.resolutionStatus,
    rawClaimableFlag:
      existing.claimableSignal || incoming.claimableSignal,
    rawUpstreamRedeemable:
      existing.upstreamRedeemable || incoming.upstreamRedeemable,
    claimableValue,
    rules: existing.rules ?? incoming.rules,
    marketContext: existing.marketContext ?? incoming.marketContext,
    resolutionSource: existing.resolutionSource ?? incoming.resolutionSource,
  });
}

export function aggregateBullpenPositionViews(
  positions: BullpenActivePositionView[],
) {
  const grouped = new Map<string, BullpenActivePositionView>();
  const aliasToGroup = new Map<string, string>();

  for (const [index, position] of positions.entries()) {
    const scope = `${position.outcome.trim().toLowerCase()}::${position.economicClassification}`;
    const aliases = buildBullpenPositionAliases(position).map((alias) => `${scope}::${alias}`);
    const existingGroupKey = aliases.find((alias) => aliasToGroup.has(alias));
    const groupKey = existingGroupKey
      ? (aliasToGroup.get(existingGroupKey) ?? existingGroupKey)
      : aliases[0] ?? `${scope}::bullpen-position-${index + 1}`;
    const existing = groupKey ? grouped.get(groupKey) : undefined;

    if (existing && groupKey) {
      grouped.set(groupKey, mergeBullpenPositionViews(existing, position));
    } else if (groupKey) {
      grouped.set(groupKey, position);
    }

    for (const alias of aliases) {
      if (groupKey) {
        aliasToGroup.set(alias, groupKey);
      }
    }
  }

  return Array.from(grouped.values());
}

export function applyBullpenPositionMarketData(
  position: BullpenActivePositionView,
  marketData: BullpenTrackedMarketRefresh,
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

  return applyBullpenPositionClassification({
    ...position,
    conditionId: marketData.conditionId ?? position.conditionId,
    marketSlug:
      marketData.marketSlug ?? marketData.slug ?? position.marketSlug,
    eventSlug: marketData.eventSlug ?? position.eventSlug,
    slug:
      marketData.marketSlug ??
      marketData.slug ??
      position.marketSlug ??
      position.slug ??
      marketData.eventSlug ??
      position.eventSlug,
    yesOdds,
    noOdds,
    bestBidPrice: marketData.bestBidPrice ?? position.bestBidPrice,
    bestAskPrice: marketData.bestAskPrice ?? position.bestAskPrice,
    currentPrice,
    currentValue,
    unrealizedPnl,
    unrealizedPnlPercent,
    marketUrl: marketData.marketUrl ?? position.marketUrl,
    rawClaimableFlag: position.claimableSignal,
    rawUpstreamRedeemable: position.upstreamRedeemable,
    authoritativeMarketOpen: marketData.authoritativeMarketOpen,
    rules: marketData.rules ?? position.rules,
    marketContext: marketData.marketContext ?? position.marketContext,
    resolutionSource:
      marketData.resolutionSource ?? position.resolutionSource,
  });
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
        marketSlug: marketUpdate?.marketSlug ?? marketUpdate?.slug ?? null,
        eventSlug: marketUpdate?.eventSlug ?? null,
        slug:
          marketUpdate?.marketSlug ??
          marketUpdate?.slug ??
          marketUpdate?.eventSlug ??
          null,
        conditionId: null,
        marketTitle: position.market_title,
        outcome: position.outcome,
        heldSide: deriveHeldSide(position.outcome),
        shares: position.shares,
        averagePrice: round(position.average_price, 4),
        costBasis: round(position.cost_basis, 2),
        yesOdds: marketUpdate?.yesOdds ?? null,
        noOdds: marketUpdate?.noOdds ?? null,
        bestBidPrice: marketUpdate?.bestBidPrice ?? null,
        bestAskPrice: marketUpdate?.bestAskPrice ?? null,
        currentPrice: null,
        currentValue: null,
        expectedPayoutUsd: null,
        unrealizedPnl: null,
        unrealizedPnlPercent: null,
        marketUrl: marketUpdate?.marketUrl ?? null,
        closeTime,
        resolutionStatus: "open",
        rawClaimableFlag: false,
        rawUpstreamRedeemable: false,
        claimableValue: null,
        rules: marketUpdate?.rules ?? null,
        marketContext: marketUpdate?.marketContext ?? null,
        resolutionSource: marketUpdate?.resolutionSource ?? null,
      } satisfies Parameters<typeof applyBullpenPositionClassification>[0];

      return applyBullpenPositionMarketData(
        applyBullpenPositionClassification(basePosition),
        marketUpdate || {},
      );
    });
}

export function sumCurrentPositionValue(positions: BullpenActivePositionView[]) {
  return round(
    positions.reduce(
      (total, position) => total + (position.currentValue ?? position.costBasis),
      0,
    ),
    2,
  );
}

export function sumBullpenPortfolioPositionValue(
  positions: BullpenActivePositionView[],
) {
  return round(
    positions.reduce((total, position) => {
      const value = isClaimableBullpenPosition(position)
        ? position.claimableValue ??
          position.expectedPayoutUsd ??
          position.currentValue ??
          position.costBasis
        : position.currentValue ?? position.costBasis;
      return total + Math.max(0, value);
    }, 0),
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

export function isActiveBullpenPosition(position: BullpenActivePositionView) {
  return position.economicClassification === "active";
}

export function isClaimableBullpenPosition(position: BullpenActivePositionView) {
  return position.economicClassification === "positive_payout_claimable";
}

export function isDiagnosticBullpenPosition(position: BullpenActivePositionView) {
  return (
    position.economicClassification === "settlement_pending" ||
    position.economicClassification === "stale_or_unknown" ||
    position.economicClassification === "resolved_zero_payout" ||
    position.economicClassification === "closed"
  );
}

type BullpenPositionPartitions = {
  activePositions: BullpenActivePositionView[];
  positiveClaimablePositions: BullpenActivePositionView[];
  settlementPendingPositions: BullpenActivePositionView[];
  staleOrUnknownPositions: BullpenActivePositionView[];
  resolvedZeroPayoutPositions: BullpenActivePositionView[];
  closedPositions: BullpenActivePositionView[];
};

export function partitionBullpenPositions(
  positions: BullpenActivePositionView[],
): BullpenPositionPartitions {
  const partitions: BullpenPositionPartitions = {
    activePositions: [],
    positiveClaimablePositions: [],
    settlementPendingPositions: [],
    staleOrUnknownPositions: [],
    resolvedZeroPayoutPositions: [],
    closedPositions: [],
  };

  for (const position of positions) {
    switch (position.economicClassification) {
      case "active":
        partitions.activePositions.push(position);
        break;
      case "positive_payout_claimable":
        partitions.positiveClaimablePositions.push(position);
        break;
      case "settlement_pending":
        partitions.settlementPendingPositions.push(position);
        break;
      case "stale_or_unknown":
        partitions.staleOrUnknownPositions.push(position);
        break;
      case "resolved_zero_payout":
        partitions.resolvedZeroPayoutPositions.push(position);
        break;
      case "closed":
        partitions.closedPositions.push(position);
        break;
    }
  }

  return partitions;
}

function toDiagnosticPosition(
  position: BullpenActivePositionView,
): BullpenExcludedPositionDiagnostic {
  return {
    key: position.key,
    marketId: position.marketId,
    slug: position.slug,
    conditionId: position.conditionId,
    marketTitle: position.marketTitle,
    outcome: position.outcome,
    shares: position.shares,
    closeTime: position.closeTime,
    currentValue: position.currentValue,
    expectedPayoutUsd: position.expectedPayoutUsd,
    economicClassification: position.economicClassification,
    classificationReason: position.classificationReason,
  };
}

export function buildBullpenPositionsDiagnostics(
  positions: BullpenActivePositionView[],
): BullpenPositionsDiagnostics {
  const partitions = partitionBullpenPositions(positions);
  const settlementPendingPositions = partitions.settlementPendingPositions.map(
    toDiagnosticPosition,
  );
  const excludedPositions = [
    ...partitions.staleOrUnknownPositions,
    ...partitions.resolvedZeroPayoutPositions,
    ...partitions.closedPositions,
  ].map(toDiagnosticPosition);
  const diagnosticPositions = [
    ...settlementPendingPositions,
    ...excludedPositions,
  ];

  return {
    excludedPositionCount: excludedPositions.length,
    diagnosticPositionCount: diagnosticPositions.length,
    settlementPendingCount: settlementPendingPositions.length,
    staleOrUnknownCount: partitions.staleOrUnknownPositions.length,
    closedPositionCount: partitions.closedPositions.length,
    resolvedZeroPayoutCount: partitions.resolvedZeroPayoutPositions.length,
    settlementPendingPositions,
    diagnosticPositions,
    excludedPositions,
  };
}

export function filterDisplayBullpenPositions(
  positions: BullpenActivePositionView[],
) {
  return positions.filter(
    (position) =>
      isActiveBullpenPosition(position) ||
      isClaimableBullpenPosition(position),
  );
}

export function summarizeBullpenPositions(
  positions: BullpenActivePositionView[],
  summary?: Record<string, unknown> | null,
): BullpenPositionsSummary {
  const partitions = partitionBullpenPositions(positions);
  const claimablePositions = partitions.positiveClaimablePositions;
  const activePositions = partitions.activePositions;
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
    activeCount: activePositions.length,
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

export function isUsableBullpenPositionsSnapshot({
  positionsSource,
  liveAvailable,
}: {
  positionsSource: BullpenPositionsSource | null | undefined;
  liveAvailable: boolean | null | undefined;
}) {
  return Boolean(
    liveAvailable ||
      positionsSource === "live-cli" ||
      positionsSource === "redis-cache" ||
      positionsSource === "last-successful-live-snapshot",
  );
}

function normalizeLineageAccountIdentity(value: string | null | undefined) {
  const normalized = value?.trim().toLowerCase();
  return normalized || null;
}

function hasKnownLineageValue(
  value: number | string | null | undefined,
): value is number | string {
  return (
    (typeof value === "number" && Number.isFinite(value)) ||
    (typeof value === "string" && Boolean(value.trim()))
  );
}

/**
 * Detects whether a newly fetched wallet snapshot can safely replace the
 * verified snapshot already displayed in the tab. Source and freshness are
 * intentionally excluded: live-cli/redis-cache and fresh/stale are delivery
 * properties, while account, credential artifact and classifier identify the
 * evidence lineage itself.
 *
 * A missing incoming value is incompatible when the verified baseline knew
 * that value. This prevents a lineage downgrade from silently bypassing the
 * comparison while still allowing legacy snapshots with no lineage to be
 * upgraded by the first fully identified response.
 */
export function getBullpenPositionsLineageMismatchFields({
  current,
  incoming,
}: {
  current: BullpenPositionsSnapshotLineage | null | undefined;
  incoming: BullpenPositionsSnapshotLineage | null | undefined;
}): BullpenPositionsLineageMismatchField[] {
  if (!current) return [];
  if (!incoming) return ["lineage"];

  const mismatches: BullpenPositionsLineageMismatchField[] = [];
  const currentAccountIdentity = normalizeLineageAccountIdentity(
    current.accountIdentity,
  );
  const incomingAccountIdentity = normalizeLineageAccountIdentity(
    incoming.accountIdentity,
  );
  if (
    currentAccountIdentity &&
    currentAccountIdentity !== incomingAccountIdentity
  ) {
    mismatches.push("account-identity");
  }

  const credentialComparisons = [
    [
      "credential-inode",
      current.credentialArtifact?.inode,
      incoming.credentialArtifact?.inode,
    ],
    [
      "credential-mtime",
      current.credentialArtifact?.mtimeNs,
      incoming.credentialArtifact?.mtimeNs,
    ],
    [
      "credential-size",
      current.credentialArtifact?.size,
      incoming.credentialArtifact?.size,
    ],
  ] as const;
  for (const [field, currentValue, incomingValue] of credentialComparisons) {
    if (
      hasKnownLineageValue(currentValue) &&
      currentValue !== incomingValue
    ) {
      mismatches.push(field);
    }
  }

  if (
    hasKnownLineageValue(current.positionClassifierVersion) &&
    current.positionClassifierVersion !== incoming.positionClassifierVersion
  ) {
    mismatches.push("position-classifier");
  }

  return mismatches;
}

export function canAutoRebaselineBullpenPositionsLineage({
  current,
  incoming,
  incomingIsFreshLive,
}: {
  current: BullpenPositionsSnapshotLineage | null | undefined;
  incoming: BullpenPositionsSnapshotLineage | null | undefined;
  incomingIsFreshLive: boolean;
}) {
  if (!incomingIsFreshLive || !current || !incoming) return false;
  const currentAccountIdentity = normalizeLineageAccountIdentity(
    current.accountIdentity,
  );
  const incomingAccountIdentity = normalizeLineageAccountIdentity(
    incoming.accountIdentity,
  );
  const incomingFreshness = incoming.freshnessState?.trim().toLowerCase();
  const incomingSource = incoming.source?.trim().toLowerCase();
  const preservesKnownLineage = (
    currentValue: number | string | null | undefined,
    incomingValue: number | string | null | undefined,
  ) => !hasKnownLineageValue(currentValue) || hasKnownLineageValue(incomingValue);

  return Boolean(
    currentAccountIdentity &&
      incomingAccountIdentity &&
      currentAccountIdentity === incomingAccountIdentity &&
      incomingFreshness === "fresh" &&
      incomingSource === "live-cli" &&
      preservesKnownLineage(
        current.credentialArtifact?.inode,
        incoming.credentialArtifact?.inode,
      ) &&
      preservesKnownLineage(
        current.credentialArtifact?.mtimeNs,
        incoming.credentialArtifact?.mtimeNs,
      ) &&
      preservesKnownLineage(
        current.credentialArtifact?.size,
        incoming.credentialArtifact?.size,
      ) &&
      preservesKnownLineage(
        current.positionClassifierVersion,
        incoming.positionClassifierVersion,
      ),
  );
}

export function canUseBullpenDisplayCacheWithVerifiedLineage({
  current,
  incoming,
  incomingSource,
}: {
  current: BullpenPositionsSnapshotLineage | null | undefined;
  incoming: BullpenPositionsSnapshotLineage | null | undefined;
  incomingSource: BullpenPositionsSource | null | undefined;
}) {
  if (incomingSource !== "redis-cache" || !current || !incoming) return false;
  if (incoming.source?.trim().toLowerCase() !== "redis-cache") return false;

  const currentAccount = normalizeLineageAccountIdentity(current.accountIdentity);
  const incomingAccount = normalizeLineageAccountIdentity(incoming.accountIdentity);
  if (currentAccount && incomingAccount !== currentAccount) return false;

  if (
    hasKnownLineageValue(current.positionClassifierVersion) &&
    current.positionClassifierVersion !== incoming.positionClassifierVersion
  ) {
    return false;
  }

  // Display caches may be produced by the read-only operator bridge and thus
  // carry a different (or sanitized-away) credential artifact. Same-account,
  // same-classifier evidence is safe to render, while the verified live
  // snapshot remains the execution baseline.
  return true;
}


export function shouldPreserveBullpenPositionsOnRefresh({
  incomingPositions,
  incomingSource,
  liveAvailable,
  currentPositions,
  currentSource,
  lastSuccessfulLiveSnapshot,
}: {
  incomingPositions: BullpenActivePositionView[];
  incomingSource: BullpenPositionsSource | null | undefined;
  liveAvailable: boolean | null | undefined;
  currentPositions: BullpenActivePositionView[];
  currentSource: BullpenPositionsSource | null | undefined;
  lastSuccessfulLiveSnapshot: BullpenLiveSnapshot | null | undefined;
}) {
  const hasVerifiedCurrentSnapshot =
    currentSource === "live-cli" ||
    currentSource === "last-successful-live-snapshot";
  return Boolean(
    !liveAvailable &&
      incomingSource === "tracked-positions" &&
      (lastSuccessfulLiveSnapshot ||
        hasVerifiedCurrentSnapshot ||
        (incomingPositions.length === 0 && currentPositions.length > 0)),
  );
}

export function resolveBullpenPreferredPortfolioValue(
  values: Array<number | null | undefined>,
) {
  // Callers provide values in source-authority order. A verified zero is a
  // real value after spending cash or closing the final position; searching
  // for any later positive value would resurrect stale portfolio state.
  const knownValue = values.find(
    (value): value is number =>
      typeof value === "number" && Number.isFinite(value),
  );
  return knownValue === undefined ? null : round(knownValue, 2);
}

/**
 * Reconciles independent wallet and position reads without letting a known
 * zero from one degraded source mask a verified non-zero account or cash
 * value. Stage 1 callers may prefer their worker-verified component sum.
 */
export function resolveBullpenTotalPortfolioValue({
  walletValue,
  accountValue,
  summaryTotalValue,
  cashBalance,
  positionsValue,
  hasPositionsSnapshot,
  preferVerifiedComponents = false,
}: {
  walletValue: number | null | undefined;
  accountValue: number | null | undefined;
  summaryTotalValue: number | null | undefined;
  cashBalance: number | null | undefined;
  positionsValue: number | null | undefined;
  hasPositionsSnapshot: boolean;
  preferVerifiedComponents?: boolean;
}) {
  const hasKnownCash =
    typeof cashBalance === "number" && Number.isFinite(cashBalance);
  const hasKnownPositionsValue =
    typeof positionsValue === "number" && Number.isFinite(positionsValue);
  const componentTotal =
    hasPositionsSnapshot &&
    hasKnownCash &&
    hasKnownPositionsValue
      ? round((cashBalance ?? 0) + (positionsValue ?? 0), 2)
      : null;

  if ((preferVerifiedComponents || hasPositionsSnapshot) && componentTotal !== null) {
    return componentTotal;
  }

  return resolveBullpenPreferredPortfolioValue([
    walletValue,
    accountValue,
    summaryTotalValue,
    componentTotal,
    cashBalance,
    positionsValue,
  ]);
}

export function buildClaimableBullpenSignature(
  positions: BullpenActivePositionView[],
) {
  return positions
    .filter((position) => isClaimableBullpenPosition(position))
    .map((position) => position.key)
    .sort((left, right) => left.localeCompare(right))
    .join("|");
}
