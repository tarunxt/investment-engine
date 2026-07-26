export type PortfolioHistoryRange =
  | "1D"
  | "1W"
  | "1M"
  | "1Y"
  | "YTD"
  | "ALL";

export type GenuinePortfolioPoint = {
  timestamp: number;
  value: number;
};

type GenuineInrSnapshot = {
  captured_at: string;
  holdings_market_value: number;
  available_margin: number;
};

export const MIN_GENUINE_PORTFOLIO_POINTS = 4;

function rangeStart(range: PortfolioHistoryRange, endTimestamp: number) {
  const endDate = new Date(endTimestamp);
  if (range === "ALL") return null;
  if (range === "YTD") return Date.UTC(endDate.getUTCFullYear(), 0, 1);

  const startDate = new Date(endTimestamp);
  if (range === "1D") startDate.setUTCDate(startDate.getUTCDate() - 1);
  if (range === "1W") startDate.setUTCDate(startDate.getUTCDate() - 7);
  if (range === "1M") startDate.setUTCMonth(startDate.getUTCMonth() - 1);
  if (range === "1Y") startDate.setUTCFullYear(startDate.getUTCFullYear() - 1);
  return startDate.getTime();
}

export function buildGenuineInrPortfolioTrend(
  snapshots: GenuineInrSnapshot[],
): GenuinePortfolioPoint[] {
  const points = snapshots
    .map((snapshot) => ({
      timestamp: Date.parse(snapshot.captured_at),
      value: snapshot.holdings_market_value + snapshot.available_margin,
    }))
    .filter(
      (point) =>
        Number.isFinite(point.timestamp) &&
        Number.isFinite(point.value) &&
        point.value >= 0,
    )
    .sort((left, right) => left.timestamp - right.timestamp);

  const uniquePoints = points.filter(
    (point, index) =>
      index === 0 || point.timestamp !== points[index - 1].timestamp,
  );
  return uniquePoints.length >= MIN_GENUINE_PORTFOLIO_POINTS
    ? uniquePoints
    : [];
}

export function filterGenuinePortfolioTrend(
  points: GenuinePortfolioPoint[],
  range: PortfolioHistoryRange,
): GenuinePortfolioPoint[] {
  if (points.length < MIN_GENUINE_PORTFOLIO_POINTS) return [];
  const lastPoint = points[points.length - 1];
  const start = rangeStart(range, lastPoint.timestamp);
  const visible =
    start == null
      ? points
      : points.filter((point) => point.timestamp >= start);
  return visible.length >= MIN_GENUINE_PORTFOLIO_POINTS ? visible : [];
}
