"use client";
import { stockTableCell, tradingViewText } from "@/components/shared/TradingViewSymbolLink";
import { stockIdentityForColumns } from "@/lib/tradingview";

export function Grid({ rows }: { rows: Record<string, unknown>[] }) {
  const columns = [...new Set(rows.flatMap(row => Object.keys(row)))];
  return <div className="max-h-[52vh] overflow-auto">
    <table className="w-full border-collapse text-left text-xs">
      <thead className="sticky top-0 bg-slate-100"><tr>
        {columns.map(column => <th className="whitespace-nowrap p-2" key={column}>{column}</th>)}
      </tr></thead>
      <tbody>{rows.map((row, index) => {
        const identity = stockIdentityForColumns(columns, columns.map(column => row[column]));
        return <tr className="border-b" key={index}>{columns.map(column => {
          const value = row[column];
          return <td className="max-w-96 p-2 align-top" key={column}>
            {value == null ? "—" : typeof value === "object"
              ? <details><summary>Details</summary><pre className="max-h-60 w-72 overflow-auto whitespace-pre-wrap">{tradingViewText(JSON.stringify(value, null, 2))}</pre></details>
              : stockTableCell(column, typeof value === "number" ? String(Number(value.toFixed(2))) : String(value), identity)}
          </td>;
        })}</tr>;
      })}</tbody>
    </table>
  </div>;
}
