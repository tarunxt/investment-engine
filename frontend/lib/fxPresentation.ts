type DashboardFxLike = {
  value: number | null;
  as_of: string | null;
  stale_after_seconds: number;
  status: "valid" | "stale" | "unavailable";
};

export function validDashboardFxRate(
  fx: DashboardFxLike | null,
  nowMs = Date.now(),
) {
  if (
    !fx ||
    fx.status !== "valid" ||
    fx.value == null ||
    !Number.isFinite(fx.value) ||
    fx.value <= 0 ||
    !fx.as_of
  ) {
    return null;
  }
  const asOfMs = Date.parse(fx.as_of);
  if (!Number.isFinite(asOfMs)) return null;
  const ageMs = Math.max(0, nowMs - asOfMs);
  return ageMs <= fx.stale_after_seconds * 1000 ? fx.value : null;
}

export function isVerifiedFxRate(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function formatUsdWithoutFx(value: number) {
  return `$${value.toFixed(value < 0.01 && value > 0 ? 6 : 2)} (FX unavailable)`;
}

export function formatUsdAsVerifiedInr(
  value: number,
  usdInrRate: number | null | undefined,
  fractionDigits = 2,
) {
  if (!isVerifiedFxRate(usdInrRate)) {
    return formatUsdWithoutFx(value);
  }
  return `₹${(value * usdInrRate).toFixed(fractionDigits)}`;
}
