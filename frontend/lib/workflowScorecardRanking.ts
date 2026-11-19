import type { ZerodhaThreatReport } from "@/types/api";

export type RankedListing = { listing: string; score: number | null; pairwise: number | null; stock_threat: number | null; comparisons?: number | null; threat_reason?: string | null };

export function workflowRanking(rows: { exchange: string; symbol: string; effectiveScore: number | null }[], report?: ZerodhaThreatReport | null): RankedListing[] {
  const tables = report?.tables ?? [];
  const uniqueRows = (key: string, listing: (row: Record<string, string>) => string) => {
    const result = new Map<string, Record<string, string> | null>();
    for (const row of tables.filter(table => table.key === key).flatMap(table => table.rows)) {
      const id = listing(row);
      result.set(id, result.has(id) ? null : row);
    }
    return result;
  };
  const pairwise = uniqueRows("pairwise_scores", row => row.Listing);
  const threats = uniqueRows("stock_threat_scores", row => row.Exchange + ":" + row["Stock Symbol"]);
  function observation(text?: string) {
    if (!text?.trim()) return null;
    const n = Number(text);
    return Number.isFinite(n) && n >= 0 && n <= 100 ? n : null;
  }
  return rows.map(row => {
    const listing = row.exchange + ":" + row.symbol;
    const pairRow = pairwise.get(listing);
    const pair = observation(pairRow?.["Pairwise /100"]);
    const threatRow = threats.get(listing);
    const threat = observation(threatRow?.["Stock Threat /100"]);
    const threat_reason = threat != null ? null : !report ? "No scorecard manifest" :
      threatRow === undefined ? "Missing stock threat row" : threatRow === null ? "Duplicate stock threat rows" : "Invalid stock threat score";
    const count = pairRow?.["Valid comparisons"]?.trim();
    const comparisons = count && /^\d+$/.test(count) ? Number(count) : null;
    const signed = weightedSigned(row.effectiveScore, {pairwise: pair, stock_threat: threat});
    return { listing, threat_reason, score: signed === null ? null : (signed + 3) * 100 / 6, pairwise: pair, stock_threat: threat, comparisons };

  }).sort((a, b) => (b.score ?? -1) - (a.score ?? -1) || a.listing.localeCompare(b.listing));
}

export type SupplementalInputs = { pairwise: number | null; stock_threat: number | null; comparisons?: number | null; jobId?: number };

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
      result.set(row.listing, { pairwise: row.pairwise, stock_threat: row.stock_threat, comparisons: Number.isSafeInteger(row.comparisons) && row.comparisons >= 0 ? row.comparisons : null, jobId: manifest.job_id });
    }
    return result;
  } catch { return null; }
}
