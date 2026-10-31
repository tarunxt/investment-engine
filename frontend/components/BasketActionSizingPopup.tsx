"use client";
import { BasketMetricPopup } from "./BasketMetricPopup";
import { formatBasketDisplayCurrency, formatBasketIntegerCurrency } from "@/lib/basketDisplayCalculations";
import type { basketActionSizing } from "@/lib/basketActionSizing";

export function BasketActionSizingPopup({ title, symbol, exchange, calculation, portfolioValue, availableMargin, snapshot, priceSource, priceAsOf, holdingSource, onClose }: {
  title: "Action Zerodha Stocks" | "Action Zerodha Amount"; symbol: string; exchange: string;
  calculation: ReturnType<typeof basketActionSizing>; portfolioValue?: number | null; availableMargin?: number | null;
  snapshot: string | null; priceSource?: string; priceAsOf?: string; holdingSource?: string; onClose: () => void;
}) {
  const c = calculation, shares = title === "Action Zerodha Stocks";
  const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value) ? value.toLocaleString("en-IN", { maximumFractionDigits: 10 }) : "Unavailable";
  const signed = (value: number | null) => value === null ? "Unavailable" : `${value > 0 ? "+" : ""}${number(value)}`;
  const money = (value: number | null | undefined) => value == null ? "Unavailable" : `${value > 0 ? "+" : ""}${formatBasketDisplayCurrency(value, "INR")}`;
  const percent = (value: number | null) => value === null ? "Unavailable" : `${number(value * 100)}%`;
  const summary = {
    label: `${c.direction} · display action`, value: shares ? signed(c.stocks) : formatBasketIntegerCurrency(c.amount, true),
    subtitle: shares ? c.fullExit ? `Target Weight = 0: sell the known holding quantity, ${number(c.holdingQuantity)} shares.` : `ROUND((${number(c.totalAssets)} × ${number(c.difference)}) / ${number(c.price)}, 0), capped at current holdings for sells.` : `${signed(c.stocks)} shares × ${formatBasketDisplayCurrency(c.price, "INR")} = ${money(c.amount)}`,
    metrics: shares ? [{ label: "Total Assets", value: formatBasketDisplayCurrency(c.totalAssets, "INR") }, { label: "Weight Difference", value: percent(c.difference) }, { label: "Upstox LTP", value: formatBasketDisplayCurrency(c.price, "INR") }] : [{ label: "Action shares", value: signed(c.stocks) }, { label: "Upstox LTP", value: formatBasketDisplayCurrency(c.price, "INR") }, { label: "Direction", value: c.direction }],
    notice: c.reason || "Uses genuine Upstox LTP only. Positive values buy; negative values sell. Displayed Units mirror Action Zerodha Stocks; executable drafts, selection and order guards remain separate.", warning: true,
  };
  return <BasketMetricPopup title={title} eyebrow={`${exchange}:${symbol} / Zerodha`} summary={summary} onClose={onClose} wide>
    <p>Total Assets = Current Portfolio Value + Available Margin = {number(portfolioValue)} + {number(availableMargin)} = {number(c.totalAssets)} INR. Snapshot: {snapshot ?? "Unavailable"}.</p>
    <p>Weight Difference = Target Weight − Current Weight = {percent(c.targetWeight)} − {percent(c.currentWeight)} = {percent(c.difference)}. The formula uses the fraction {number(c.difference)}, not its percentage display.</p>
    <p>Upstox LTP: {number(c.price)} INR. Source: {priceSource ?? "Unavailable"}. Price as of: {priceAsOf ?? "Unavailable"}. No Quoted LTP, holdings-price or Limit Price substitute is used.</p>
    {c.fullExit ? <p>Zero-target Sell All rule: Action Zerodha Stocks = −current holding quantity = {signed(c.stocks)}. The exact known holding quantity is retained without rounding, including a fractional display total. Amount still requires Upstox LTP. This is not a claim that every holding unit is immediately sellable.</p> : <>
      <p>Raw action value = Total Assets × Weight Difference = {number(c.totalAssets)} × {number(c.difference)} = {number(c.rawAmount)} INR.</p>
      <p>Raw action shares = {number(c.rawAmount)} / {number(c.price)} = {number(c.rawStocks)}. Nearest whole-share ROUND, halves away from zero = {number(c.roundedStocks)}. Sell cap = FLOOR(current holdings) = {number(c.sellCap)} when selling. Final Action Zerodha Stocks = {signed(c.stocks)}.</p>
    </>}
    <p>Current exact-venue holding quantity: {number(c.holdingQuantity)}. Source: {holdingSource ?? "Unavailable"}. A sell cannot exceed the known holdings; missing holdings prevent a capped sell calculation.</p>
    <p>Action Zerodha Amount = Action Zerodha Stocks × Upstox LTP = {signed(c.stocks)} × {number(c.price)} = {money(c.amount)}. {c.reason}</p>
    <p>Display only · Orders unchanged. Displayed Units use this same Action quantity and popup. Target Zerodha Stocks/Amount and executable order drafts remain separate. Amounts are shown rounded to nearest integer while these calculations retain full precision. Existing cash, whole-share, selection and broker validation safeguards remain in force.</p>
  </BasketMetricPopup>;
}
