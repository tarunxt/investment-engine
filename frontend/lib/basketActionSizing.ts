import { excelRound } from "./basketDisplayCalculations";

export type BasketActionSizingInput = {
  totalAssets: number | null; currentWeight: number | null; targetWeight: number | null;
  upstoxLtp: number | null; holdingQuantity: number | null;
};

/** Signed display quantities only. Positive buys, negative sells; never an order. */
export function basketActionSizing(input: BasketActionSizingInput) {
  const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value);
  const assets = finite(input.totalAssets) && input.totalAssets > 0 ? input.totalAssets : null;
  const current = finite(input.currentWeight) && input.currentWeight >= 0 ? input.currentWeight : null;
  const target = finite(input.targetWeight) && input.targetWeight >= 0 && input.targetWeight <= 1 ? input.targetWeight : null;
  const price = finite(input.upstoxLtp) && input.upstoxLtp > 0 ? input.upstoxLtp : null;
  const holding = finite(input.holdingQuantity) && input.holdingQuantity >= 0 ? input.holdingQuantity : null;
  const difference = current !== null && target !== null ? target - current : null;
  const rawAmount = assets !== null && difference !== null && finite(assets * difference) ? assets * difference : null;
  const result = {
    totalAssets: assets, currentWeight: current, targetWeight: target, price, holdingQuantity: holding,
    difference, rawAmount, rawStocks: null as number | null, roundedStocks: null as number | null,
    sellCap: null as number | null, stocks: null as number | null, amount: null as number | null,
    fullExit: false, direction: "Unavailable", reason: "" as string,
  };
  if (target === 0 && holding !== null) {
    result.fullExit = true;
    result.rawStocks = result.roundedStocks = result.stocks = holding === 0 ? 0 : -holding;
    result.sellCap = holding;
    result.direction = holding === 0 ? "Hold" : "Sell All";
    if (price !== null && finite(result.stocks * price)) result.amount = result.stocks * price;
    else result.reason = "Full-exit quantity is known from Kite holdings; the amount needs a genuine positive Upstox LTP.";
    return result;
  }
  if (target === null) result.reason = "Target Weight is unavailable or invalid.";
  else if (assets === null) result.reason = "Current Portfolio Value plus Available Margin is unavailable or not positive.";
  else if (current === null) result.reason = "Current Weight is unavailable or invalid.";
  else if (price === null) result.reason = "A genuine positive Upstox LTP with source and time is required. No Kite or Limit Price fallback is used.";
  else if (difference !== null && difference < 0 && holding === null) result.reason = "Current exact-venue holdings are unavailable, so the sell quantity cannot be capped safely.";
  else if (rawAmount === null || !finite(rawAmount / price!)) result.reason = "The requested calculation is outside the finite numeric range.";
  if (result.reason) return result;
  result.rawStocks = rawAmount! / price!;
  result.roundedStocks = excelRound(result.rawStocks);
  if (Object.is(result.roundedStocks, -0)) result.roundedStocks = 0;
  if (!Number.isSafeInteger(result.roundedStocks)) {
    result.reason = "Rounded share quantity is outside the safe whole-share range.";
    return result;
  }
  result.sellCap = difference! < 0 ? Math.floor(holding!) : null;
  const quantity = result.roundedStocks < 0 ? -Math.min(Math.abs(result.roundedStocks), result.sellCap!) : result.roundedStocks;
  result.stocks = Object.is(quantity, -0) ? 0 : quantity;
  const amount = result.stocks * price!;
  result.amount = finite(amount) ? amount : null;
  result.direction = result.stocks > 0 ? "Buy" : result.stocks < 0 ? "Sell" : "Hold";
  if (result.amount === null) result.reason = "The action amount is outside the finite numeric range.";
  return result;
}
