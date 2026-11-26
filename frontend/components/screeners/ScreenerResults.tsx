"use client";
import { useEffect, useState } from "react";
import type { apiService } from "@/services/api";
import { screenerApi } from "@/lib/screenerLibrary";

type Run = {
  status: "queued" | "running" | "partial" | "completed" | "failed";
  market_as_of?: string;
  error?: string;
  report?: { total: number; universe_size: number; unknown: number; rows: {symbol: string; exchange: string; name: string}[] };
};
export function ScreenerResults({ id, client }: { id: string; client: typeof apiService }) {
  const base = screenerApi() + "/" + id;
  const [run, setRun] = useState<Run | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState("");
  const [retry, setRetry] = useState(0);
  const [limit, setLimit] = useState(50);
  const pending = run?.status === "queued" || run?.status === "running";
  useEffect(() => {
    let current = true;
    let timer: ReturnType<typeof setTimeout>;
    async function read() {
      try {
        const result = await client.get<Run | null>(base + "/result");
        if (!current) return;
        setRun(result); setError("");
        if (result?.status === "queued" || result?.status === "running") timer = setTimeout(read, 4000);
      } catch (reason) { if (current) setError(String(reason)); }
      finally { if (current) setBusy(false); }
    }
    void read();
    return () => { current = false; clearTimeout(timer); };
  }, [base, client, retry]);
  async function start() {
    if (busy || pending) return;
    setBusy(true); setError(""); setLimit(50);
    try {
      setRun(await client.post<Run>(base + "/run", {}));
      setRetry(value => value + 1);
    } catch (reason) { setError(String(reason)); setBusy(false); }
  }
  const report = run?.report;
  return <section className="space-y-3 border-t pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3"><h2 className="text-lg font-semibold">Stage 2 matches</h2>
      <button onClick={() => void start()} disabled={busy || pending} className="rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50">{pending ? (run.status === "queued" ? "Queued" : "Running…") : "Run screener"}</button>
    </div>
    {error && <p role="alert" className="text-rose-800">{error} <button className="underline" onClick={() => setRetry(n => n+1)}>Reload</button></p>}
    {run?.error && <p role="alert" className="text-rose-800">{run.error}</p>}
    {!error && !busy && !run && <p className="text-sm text-slate-600">Run this query to see matching NSE and BSE stocks.</p>}
    {report && <><p className="text-sm">{report.total} matches across {report.universe_size} listings · {report.unknown} with incomplete data
      {run?.market_as_of && " · " + new Date(run.market_as_of).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"}) + " IST"}</p>
      {report.rows.length > 0 && <div className="overflow-x-auto"><table className="w-full text-left text-sm"><thead><tr>
        <th scope="col">Listing</th><th scope="col">Company</th></tr></thead><tbody>{report.rows.slice(0,limit).map(row =>
          <tr key={row.exchange+":"+row.symbol} className="border-t"><td className="py-2">{row.exchange}:{row.symbol}</td><td>{row.name}</td></tr>)}</tbody></table></div>}
      {report.rows.length > limit && <button className="text-sm text-indigo-700 underline" onClick={() => setLimit(n => n+50)}>Show more matches</button>}
    </>}
  </section>;
}
