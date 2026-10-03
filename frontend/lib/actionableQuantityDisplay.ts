// Presentation only. Never feed these strings back into sizing or execution.
const QUANTITY_HEADERS = new Set([
  "Current Units", "Units Change", "Final Units", "Units to Buy", "Units to Sell/Buy",
]);
const quantityFormat = new Intl.NumberFormat("en-US", {
  useGrouping: false,
  maximumSignificantDigits: 15,
});

function numeric(value: unknown): number | null {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const text = String(value).trim().replace(/,/g, "");
  if (!/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?$/.test(text)) return null;
  const parsed = Number(text);
  return Number.isFinite(parsed) ? parsed : null;
}

export function formatConsolidatedQuantityCell(
  row: Readonly<Record<string, string | undefined>>,
  header: string,
): string | null {
  if (!QUANTITY_HEADERS.has(header)) return null;
  let value = numeric(row[header]);
  if (value === null) return null;
  if (header === "Final Units") {
    const current = numeric(row["Current Units"]);
    const change = numeric(row["Units Change"]);
    if (current !== null && change !== null && current * change < 0) {
      // Cancel only machine-precision residue from subtracting the position.
      // A genuinely small stand-alone holding or material residual stays visible.
      const tolerance = Math.min(1e-12, Number.EPSILON * Math.max(Math.abs(current), Math.abs(change)) * 2);
      if (Math.abs(value) < tolerance && Math.abs(current + change) < tolerance) value = 0;
    }
  }
  return quantityFormat.format(Object.is(value, -0) ? 0 : value);
}
