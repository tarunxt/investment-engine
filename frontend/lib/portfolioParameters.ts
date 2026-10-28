import type { IndMoneyUsPortfolioSnapshotDetail, ZerodhaPortfolioSnapshotDetail } from "@/types/api";

type Ratio = { n: bigint; d: bigint };
export type PortfolioParameterKey = "cash" | "max" | "normalised";
export type PortfolioParameters = Record<PortfolioParameterKey, Ratio>;
const zero = BigInt(0), one = BigInt(1), hundred = BigInt(100);
function ratio(n: bigint, d = one): Ratio {
  let a = n < zero ? -n : n, b = d;
  while (b !== zero) { const next = a % b; a = b; b = next; }
  return { n: n / (a || one), d: d / (a || one) };
}
function multiply(a: Ratio, b: Ratio) { return ratio(a.n * b.n, a.d * b.d); }
function cashRemaining(cash: Ratio) { return ratio(hundred * cash.d - cash.n, hundred * cash.d); }
function parse(value: string): Ratio | null {
  if (!/^-?(?:\d+(?:\.\d{0,12})?|\.\d{1,12})$/.test(value)) return null;
  const [whole, decimal = ""] = value.split(".");
  return ratio(BigInt(whole + decimal), BigInt(10) ** BigInt(decimal.length));
}
export function defaultPortfolioParameters(): PortfolioParameters {
  return { cash: ratio(BigInt(5)), max: ratio(BigInt(10)), normalised: ratio(BigInt(19), BigInt(2)) };
}
function update(state: PortfolioParameters, key: PortfolioParameterKey, value: Ratio): { state: PortfolioParameters; error: null } | { state: null; error: string } {
  if (value.n < zero || value.n > hundred * value.d) return { state: null, error: "Enter a percentage between 0 and 100." };
  if (key === "cash") return { state: { cash: value, max: state.max, normalised: multiply(cashRemaining(value), state.max) }, error: null };
  if (key === "max") return { state: { ...state, max: value, normalised: multiply(cashRemaining(state.cash), value) }, error: null };
  const remaining = cashRemaining(state.cash);
  if (remaining.n === zero) return value.n === zero ? { state, error: null } : { state: null, error: "At 100% Min Cash, Normalised Max Weight must be 0%." };
  const max = ratio(value.n * remaining.d, value.d * remaining.n);
  if (max.n > hundred * max.d) return { state: null, error: "Normalised Max Weight would require Max Weight above 100%." };
  return { state: { ...state, max, normalised: value }, error: null };
}
export function editPortfolioParameter(state: PortfolioParameters, key: PortfolioParameterKey, value: string) {
  const parsed = parse(value);
  return parsed ? update(state, key, parsed) : { state: null, error: "Enter a percentage with up to 12 decimal places." };
}
export function stepPortfolioParameter(state: PortfolioParameters, key: PortfolioParameterKey, direction: -1 | 1) {
  const current = state[key];
  return update(state, key, ratio(current.n * hundred + BigInt(direction) * current.d, current.d * hundred));
}
export function displayPortfolioParameter(state: PortfolioParameters, key: PortfolioParameterKey) {
  const value = state[key], scale = BigInt(10) ** BigInt(12);
  let scaled = value.n * scale / value.d;
  if ((value.n * scale % value.d) * BigInt(2) >= value.d) scaled += one;
  const digits = scaled.toString().padStart(13, "0");
  const decimals = digits.slice(-12).replace(/0+$/, "").padEnd(2, "0");
  return { text: `${digits.slice(0, -12)}.${decimals}`, rounded: scaled * value.d !== value.n * scale };
}

export function portfolioParameterAssets(snapshot: ZerodhaPortfolioSnapshotDetail | IndMoneyUsPortfolioSnapshotDetail | null, market: "india" | "us", margin: number | null) {
  const expectedSnapshot = snapshot && (market === "india" ? "holdings_market_value" in snapshot : "parse_status" in snapshot);
  const availableMargin = expectedSnapshot && typeof margin === "number" && Number.isFinite(margin) ? margin : null;
  let portfolioValue: number | null = null;
  if (snapshot && Array.isArray(snapshot.holdings) && snapshot.holdings_count === snapshot.holdings.length && Number.isFinite(Date.parse(snapshot.captured_at))) {
    if (market === "india" && "holdings_market_value" in snapshot && typeof snapshot.holdings_market_value === "number" && Number.isFinite(snapshot.holdings_market_value) && snapshot.holdings_market_value >= 0) {
      portfolioValue = snapshot.holdings_market_value; // Broker holdings summary; never add net/day positions.
    } else if (market === "us" && "parse_status" in snapshot && snapshot.parse_status === "parsed" && (snapshot.reported_holdings_count === null || snapshot.reported_holdings_count === snapshot.holdings.length)) {
      const values = snapshot.holdings.map(holding => holding.current_value);
      if ((values.length > 0 || (snapshot.reported_holdings_count === 0 && snapshot.current_value === 0)) && values.every(value => typeof value === "number" && Number.isFinite(value) && value >= 0)) portfolioValue = values.reduce<number>((sum, value) => sum + (value as number), 0);
    }
  }
  const total = portfolioValue === null || availableMargin === null ? null : portfolioValue + availableMargin;
  return { portfolioValue, availableMargin, totalAssets: total !== null && Number.isFinite(total) ? total : null };
}

// A local display preference only; no selection or allocation consumers.
export const DEFAULT_MAXIMUM_STOCKS = 20;
export function parseMaximumStocks(value: string): number | null {
  if (!/^\d+$/.test(value)) return null;
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : null;
}
