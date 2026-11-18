import type { ZerodhaThreatReport } from "@/types/api";

export type RankedListing = { listing: string; score: number | null; pairwise: number | null; stock_threat: number | null };

export function workflowRanking(rows: { exchange: string; symbol: string; effectiveScore: number | null }[], report?: ZerodhaThreatReport | null): RankedListing[] {
  const tables = report?.tables ?? [];
  const pairwise = new Map(tables.find(t => t.key === "pairwise_scores")?.rows.map(r => [r.Listing, r["Pairwise /100"]]));
  const threats = new Map(tables.find(t => t.key === "stock_threat_scores")?.rows.map(r => [r.Exchange + ":" + r["Stock Symbol"], r["Stock Threat /100"]]));
  function observation(text?: string) {
    if (!text?.trim()) return null;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }
  return rows.map(row => {
    const listing = row.exchange + ":" + row.symbol;
    const pair = observation(pairwise.get(listing));
    const threat = observation(threats.get(listing));
    const weight = 98 + Number(pair !== null) + Number(threat !== null);
    const score = row.effectiveScore === null ? null :
      (98 * (row.effectiveScore + 3) * 100 / 6 + (pair ?? 0) + (threat === null ? 0 : 100 - threat)) / weight;
    return { listing, score, pairwise: pair, stock_threat: threat };
  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.listing.localeCompare(b.listing));
}

export type SupplementalInputs = { pairwise: number | null; stock_threat: number | null };

export function weightedSigned(base: number | null, inputs?: SupplementalInputs) {
  if (base === null || !inputs || (inputs.pairwise === null && inputs.stock_threat === null)) return base;
  let numerator = Math.max(-3, Math.min(3, base)) * 98;
  let denominator = 98;
  for (const value of [inputs.pairwise, inputs.stock_threat === null ? null : 100 - inputs.stock_threat]) {
    if (value !== null) {
      numerator += 6 * value / 100 - 3;
      denominator += 1;
    }
  }
  return numerator / denominator;
}

export function readScorecardManifest(prompt: string) {
  const line = prompt.split("\n").find(text => text.startsWith("[WORKFLOW_SCORECARDS_V1]"));
  if (!line) return null;
  try {
    const manifest = JSON.parse(line.slice("[WORKFLOW_SCORECARDS_V1]".length));
    if (!Number.isSafeInteger(manifest.job_id) || !Array.isArray(manifest.rows)) return null;
    const result = new Map<string, SupplementalInputs>();
    for (const row of manifest.rows) {
      if (typeof row?.listing !== "string" || result.has(row.listing) ||
          ![row.pairwise, row.stock_threat].every(n => n === null || (Number.isFinite(n) && n >= 0 && n <= 100))) return null;
      result.set(row.listing, { pairwise: row.pairwise, stock_threat: row.stock_threat });
    }
    return result;
  } catch { return null; }
}
