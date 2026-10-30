export type BasketUnitsTrace = {
  initial?: { sourceUnits: number | null; baseUnits: number | null; requestedPercent: number; rawUnits: number | null; roundedUnits: number | null; cap: number | null; result: number | null; price: number | null };
  latest?: { kind: string; previousUnits: number | null; requestedUnits: number | null; roundedUnits: number | null; cap: number | null; result: number | null; percent?: number; baseUnits?: number | null };
  manualAdjusted?: boolean;
};

export type BasketUnitsRow = {
  symbol: string; exchange: string; units: number | null; baseUnits: number | null;
  currentUnits: number | null; price: number | null; availableBalance: number | null;
  side: "BUY" | "SELL"; percent: number; allowFractionalUnits?: boolean;
  wholeShareReview?: string; unitsTrace?: BasketUnitsTrace;
};

export function explainBasketUnits(row: BasketUnitsRow) {
  const number = (value: number | null | undefined) => typeof value === "number" && Number.isFinite(value)
    ? new Intl.NumberFormat("en-IN", { maximumFractionDigits: 8 }).format(value) : "Unavailable";
  const initial = row.unitsTrace?.initial;
  const latest = row.unitsTrace?.latest;
  const reconciles = (latest ?? initial)?.result === row.units;
  const rounding = row.allowFractionalUnits ? "Keep fractional units" : "FLOOR to whole shares";
  let formula = "Exact historical sizing inputs are unavailable; no reconstructed formula is claimed.";
  if (reconciles && latest) {
    formula = `${latest.kind}: requested ${number(latest.requestedUnits)} → ${rounding} ${number(latest.roundedUnits)} → cap ${number(latest.cap)} → ${number(row.units)} units.`;
  } else if (reconciles && initial) {
    formula = `${number(initial.baseUnits)} × ${number(initial.requestedPercent)}% = ${number(initial.rawUnits)} → ${rounding} ${number(initial.roundedUnits)} → cap ${number(initial.cap)} → ${number(row.units)} units.`;
  }
  const notice = row.wholeShareReview ? `Whole-share review: ${row.wholeShareReview}. The saved review choice controls this row; no order is placed here.`
    : !reconciles ? "The current Units value is preserved, but its full adjustment history was not captured. Allocation Shares and Target Weight do not explain executable Units."
    : row.unitsTrace?.manualAdjusted ? "Includes a manual Units adjustment. The original calculated baseline is shown separately; current Units remain the value used by the basket."
    : "Executable Units come from the captured row sizing inputs and quantity limits. They are separate from display-only allocation Shares and Target Weight.";
  return {
    summary: { label: "Executable basket units", value: number(row.units), subtitle: formula,
      metrics: [{ label: "Source / base units", value: number(initial?.baseUnits) },
        { label: "Rounded units", value: number(latest?.roundedUnits ?? initial?.roundedUnits) },
        { label: "Quantity cap", value: (latest ?? initial)?.cap === null ? "No recorded cap" : number((latest ?? initial)?.cap) }],
      notice, warning: true },
    number, initial, latest, reconciles, rounding,
  };
}
