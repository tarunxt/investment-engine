import { parseInvestmentRecommendationContent } from "@/components/InvestmentRecommendationTable";
import { isAnalysisRunForStage } from "@/lib/rebalanceRunIdentity";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import type { RunResponse } from "@/types/api";

export type StockOutputState = "populated" | "empty" | "unparseable" | "missing" | "incomplete" | "failed" | "partial";
export type SwingFlowStock = { key: string; symbol: string; exchange: string; totalSuggestions: number };
export type SwingJobOutput = {
  key: string; runId: number; jobId: number; provider: string; model: string;
  status: string; state: StockOutputState; symbols: string[]; actions: Map<string, string>;
};

export function stockOutputMessage(state: StockOutputState) {
  return {
    populated: "Parsed stock output", empty: "Completed output explicitly contains zero stock rows",
    unparseable: "Completed response could not be parsed as the expected stock table; review the saved raw output",
    missing: "Completed job has no saved response; zero stocks is not established",
    incomplete: "Job has not completed; stock output is unavailable",
    failed: "Job failed or was canceled; zero stocks is not established",
    partial: "Partial job output; coverage is incomplete",
  }[state];
}

function explicitEmpty(content: string) {
  try {
    const value: unknown = JSON.parse(content.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, ""));
    if (Array.isArray(value)) return value.length === 0;
    if (value && typeof value === "object") {
      const rows = (value as { stocks?: unknown }).stocks;
      return Array.isArray(rows) && rows.length === 0;
    }
  } catch { /* A valid empty Markdown table is checked below. */ }
  const lines = content.split("\n").map(line => line.trim()).filter(line => line.includes("|"));
  return lines.length === 2 && /Stock Symbol/i.test(lines[0]) && /^\s*\|?[\s:|\-]+\|?\s*$/.test(lines[1]);
}

export function inspectStockJob(run: RunResponse, link: RunResponse["run_jobs"][number], requireAction = false) {
  const job = link.job, status = (job?.status ?? "unknown").toLowerCase();
  if (["failed", "canceled", "cancelled"].includes(status)) return { state: "failed" as const, rows: [] };
  if (!["completed", "partial"].includes(status)) return { state: "incomplete" as const, rows: [] };
  if (!job?.response?.trim()) return { state: "missing" as const, rows: [] };
  const parsed = parseInvestmentRecommendationContent(job.response, { provider: job.provider, model: job.model, runNumber: run.id, runCreatedAt: run.created_at });
  if (!parsed || !parsed.headers.includes("Stock Symbol") || (requireAction && !parsed.headers.includes("Action (Buy/Add/Sell All/Trim/Hold/Buy New)"))) {
    return { state: status === "partial" ? "partial" as const : explicitEmpty(job.response) ? "empty" as const : "unparseable" as const, rows: [] };
  }
  const rows = parsed.rows.filter(row => row["Stock Symbol"]?.trim());
  return { state: status === "partial" ? "partial" as const : rows.length ? "populated" as const : explicitEmpty(job.response) ? "empty" as const : "unparseable" as const, rows };
}

export function buildSwingFlow(runs: RunResponse[]) {
  const stocks = new Map<string, SwingFlowStock>();
  const outputs: SwingJobOutput[] = runs.flatMap(run => (run.run_jobs ?? []).map(link => {
    const parsed = inspectStockJob(run, link), symbols: string[] = [], seenKeys = new Set<string>();
    parsed.rows.forEach(row => {
      const symbol = row["Stock Symbol"].trim().toUpperCase();
      const exchange = (row["Exchange Symbol"] ?? "").trim().toUpperCase();
      const key = `${exchange}:${symbol}`;
      if (!seenKeys.has(key)) {
        seenKeys.add(key);
        if (!symbols.includes(symbol)) symbols.push(symbol);
        const existing = stocks.get(key);
        stocks.set(key, { key, symbol, exchange, totalSuggestions: (existing?.totalSuggestions ?? 0) + 1 });
      }
    });
    return { key: `${run.id}:${link.job_id}`, runId: run.id, jobId: link.job_id, provider: link.job?.provider ?? "Provider unavailable", model: link.job?.model ?? "Model unavailable", status: link.job?.status ?? "unknown", state: parsed.state, symbols: symbols.sort(), actions: new Map<string, string>() };
  }));
  return { stocks: [...stocks.values()].sort((a, b) => a.key.localeCompare(b.key)), outputs };
}

export function selectFlowStage(runs: RunResponse[], stage: "swing" | "technical", market: SwingTradeMarket) {
  const matching = runs.filter(run => isAnalysisRunForStage(run, stage, market)).sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  const latest = matching[0];
  const completed = matching.find(run => ["completed", "partial"].includes((run.status ?? "").toLowerCase()) || run.run_jobs?.some(link => ["completed", "partial"].includes((link.job?.status ?? "").toLowerCase())));
  return { selected: completed ?? latest, latest, newerIncomplete: completed && latest?.id !== completed.id ? latest : undefined };
}

export function sameFlowSequence(a: RunResponse | undefined, b: RunResponse | undefined) {
  return Boolean(a && b && a.auto_rebalance_portfolio && a.auto_rebalance_portfolio === b.auto_rebalance_portfolio && typeof a.auto_rebalance_sequence === "number" && a.auto_rebalance_sequence === b.auto_rebalance_sequence);
}

export function mergeStageEvidence<T extends { completedAt?: string | null }>(observed: T, history: T): T {
  const observedAt = Date.parse(observed.completedAt ?? ""), historyAt = Date.parse(history.completedAt ?? "");
  return Number.isFinite(historyAt) && (!Number.isFinite(observedAt) || historyAt > observedAt) ? { ...history } : { ...observed };
}
