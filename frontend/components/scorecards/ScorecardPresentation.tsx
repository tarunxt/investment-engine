import type {ReactNode} from "react";

export const scorecardPage = "mx-auto min-w-0 max-w-[100rem] space-y-5 p-3 pb-10 md:p-6";
export const scorecardBreadcrumbs = "flex flex-wrap items-center gap-2 text-sm text-slate-600";
export const scorecardPanel = "min-w-0 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm md:p-6";
export const scorecardButton = "inline-flex items-center gap-2 rounded-full border border-indigo-200 bg-white px-4 py-2 text-sm font-semibold text-indigo-800 hover:bg-indigo-50 disabled:opacity-50";
export const scorecardHeader = "rounded-2xl border p-5 ";
export function scorecardTab(active: boolean) {
  return "rounded-full px-4 py-2 text-sm font-semibold " + (active
    ? "bg-indigo-700 text-white" : "bg-indigo-50 text-indigo-800 hover:bg-indigo-100");
}

export function Status({ value }: { value: string }) {
  const color =
    value === "completed"
      ? "bg-emerald-100 text-emerald-900"
      : ["failed", "interrupted", "cancelled"].includes(value)
        ? "bg-rose-100 text-rose-900"
        : value === "partial"
          ? "bg-amber-100 text-amber-950"
          : "bg-sky-100 text-sky-950";
  return (
    <span className={"inline-block rounded-full px-2.5 py-1 text-xs font-semibold capitalize " + color}>
      {value}
    </span>
  );
}
export function Table({
  columns,
  rows,
  empty,
}: {
  columns: string[];
  rows: { key: string | number; cells: ReactNode[] }[];
  empty: string;
}) {
  return (
    <div className="overflow-x-auto rounded-xl border border-slate-200">
      <table className="w-full border-collapse text-left text-sm">
        <thead className="bg-slate-100 text-xs uppercase tracking-wide text-slate-600">
          <tr>
            {columns.map((c) => (
              <th key={c} scope="col" className="whitespace-nowrap px-4 py-3">
                {c}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-100">
          {rows.map((row) => (
            <tr key={row.key} className="even:bg-slate-50/60">
              {row.cells.map((cell, i) => (
                <td key={columns[i]} className="px-4 py-3 align-top">
                  {cell}
                </td>
              ))}
            </tr>
          ))}
          {!rows.length && (
            <tr>
              <td colSpan={columns.length} className="p-4 text-slate-600">
                {empty}
              </td>
            </tr>
          )}
        </tbody>
      </table>
    </div>
  );
}
