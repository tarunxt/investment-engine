"use client";
import { BasketMetricPopup } from "./BasketMetricPopup";
import { explainBasketUnits, type BasketUnitsRow } from "@/lib/basketUnitsExplanation";

export function BasketUnitsPopup({ row, broker, onClose }: { row: BasketUnitsRow; broker: string; onClose: () => void }) {
  const explanation = explainBasketUnits(row);
  const { number, initial, latest } = explanation;
  return <BasketMetricPopup title="Units calculation" eyebrow={`${row.exchange}:${row.symbol} / ${broker}`} summary={explanation.summary} onClose={onClose} wide>
    <p>Current executable Units = {number(row.units)}. This popup does not change Units, selection, limit price or order guards.</p>
    {initial ? <>
      <p>Original source: {row.side === "SELL" ? "synced holding units" : "Final Actionables formula estimate"}. Estimate units: {number(initial.sourceUnits)}. Base units: {number(initial.baseUnits)}. Requested percentage: {number(initial.requestedPercent)}%.</p>
      <p>Unrounded units = {number(initial.baseUnits)} × {number(initial.requestedPercent)} / 100 = {number(initial.rawUnits)}. {explanation.rounding}: {number(initial.roundedUnits)}. Original quantity cap: {initial.cap === null ? "no recorded cap" : number(initial.cap)}. Calculated baseline after cap = {number(initial.result)}.</p>
      <p>For whole-share partial percentages below one share, no quantity is invented. Whole-share results use FLOOR, with the existing minimum-one rule for a full percentage, followed by the existing cap. Fractional sell quantities keep their fractional value where supported.</p>
    </> : <p>Original calculation and historical LLM constituent inputs are unavailable for this row. Current values are not reverse-engineered into a claimed original calculation.</p>}
    {latest ? <p>Latest recorded change: {latest.kind}. Previous units: {number(latest.previousUnits)}. Requested units: {number(latest.requestedUnits)}. Rounded units: {number(latest.roundedUnits)}. Applied cap: {latest.cap === null ? "no recorded cap" : number(latest.cap)}. Result: {number(latest.result)}. {explanation.reconciles ? "Reconciles to displayed Units." : "A later change is not captured; displayed Units remain authoritative."}</p> : null}
    <p>Current row Limit Price: {number(row.price)}. Row buying-power budget: {number(row.availableBalance)}. Current holding units: {number(row.currentUnits)}. Buy caps use FLOOR(row buying-power budget / row Limit Price) when both are available; sell caps use the available holding quantity. Missing price does not invalidate an already captured quantity, and does not imply executable pricing is available.</p>
    <p>The recorded baseline uses the basket row's captured formula estimate or synced holding quantity. Historical per-model constituent calculations are not reconstructed here.</p>
    <p>Current row amount = |Units × row Limit Price| when both exist. Upstox LTP and the independent allocation-share calculation do not change executable Units.</p>
  </BasketMetricPopup>;
}
