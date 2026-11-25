import { formatBasketDisplayCurrency } from "@/lib/basketDisplayCalculations";

type Amount = number | null | undefined;
type Allocation = { investments: Amount; cash: Amount };

export function renderBasketAllocation(
  current: Allocation, recommended: Allocation, selected: Allocation, totalAssets: Amount, currency: "INR" | "USD",
) {
  const columns = [
    { label: "Current", tone: "bg-sky-100 text-sky-950", bar: "bg-sky-600", ...current },
    { label: "Recommended", tone: "bg-violet-100 text-violet-950", bar: "bg-violet-600", ...recommended },
    { label: "Selected", tone: "bg-emerald-100 text-emerald-950", bar: "bg-emerald-600", ...selected },
  ];
  const balanceCell = (amount: number | null | undefined) => {
    if (amount == null || !Number.isFinite(amount)) return "Unavailable";
    const formatted = formatBasketDisplayCurrency(amount, currency);
    return totalAssets != null && totalAssets > 0
      ? formatted + " (" + (100 * amount / totalAssets).toFixed(2) + "%)"
      : formatted + " (—)";
  };
  return <div className="mb-3 overflow-x-auto rounded-xl border border-slate-200">
        <table aria-label="Portfolio allocation" className="w-full border-collapse text-sm tabular-nums">
          <thead><tr>{columns.map(column => <th key={column.label} scope="colgroup" colSpan={2} className={`p-2 text-center font-bold ${column.tone}`}>{column.label}</th>)}</tr></thead>
          <tbody>{(["investments", "cash"] as const).map(key => <tr key={key}>
            {columns.flatMap(column => [
              <td key={column.label + "-label"} className="border-t border-slate-200 px-3 py-2 text-slate-600">{key === "investments" ? "Investments" : "Cash"}</td>,
              <td key={column.label} className="whitespace-nowrap border-t border-slate-200 px-3 py-2 text-right font-semibold">{balanceCell(column[key])}
                {totalAssets != null && totalAssets > 0 && column[key] != null && column[key] >= 0 && column[key] <= totalAssets && <div aria-hidden="true" className="mt-1 h-1 overflow-hidden rounded-full bg-slate-100">
                  <div className={`h-full rounded-full ${column.bar}`} style={{ width: `${100 * column[key] / totalAssets}%` }} />
                </div>}</td>
            ])}
          </tr>)}</tbody>
        </table>
      </div>;
}
