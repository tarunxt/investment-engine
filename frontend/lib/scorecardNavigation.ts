import { isCard, type CardKey } from "./independentScorecards";
import { getAnalysisRunIdentity } from "./rebalanceRunIdentity";
import type { AutoRebalanceHistoryDetailResponse, AutoRebalanceStageResponse } from "@/types/api";

export type ScorecardMarket = "zerodha" | "indmoneyUs";
export type ScorecardPath = { card?: CardKey; sequence?: number };
export const cardNames = {
  rebalance: "Rebalance",
  technical: "Technical",
  threats: "Threats",
  pairwise: "Pairwise",
};
export const scorecardTabs = {
  inputs: "Inputs",
  models: "Models",
  prompts: "Prompts",
  output: "Saved output",
  duration: "Duration",
  flow: "Stock Flow",
  history: "History",
  account: "Account",
};
export type ScorecardTab = keyof typeof scorecardTabs;
export function scorecardPath(parts: string[] = []): ScorecardPath | null {
  if (!parts.length) return {};
  const [card, raw] = parts;
  if (!isCard(card) || parts.length > 2) return null;
  if (raw === undefined) return { card };
  const sequence = Number(raw);
  return /^[1-9]\d*$/.test(raw) && Number.isSafeInteger(sequence) ? { card, sequence } : null;
}
export function scorecardHref(
  market: ScorecardMarket,
  card?: CardKey,
  sequence?: number | null,
  tab?: ScorecardTab,
  execution?: number | null,
) {
  const root = "/console/" + (market === "zerodha" ? "zerodha" : "indmoney-us") + "/scorecards";
  const path = root + (card ? "/" + card : "") + (card && sequence ? "/" + sequence : "");
  const query = new URLSearchParams();
  if (tab) query.set("tab", tab);
  if (execution) query.set("execution", String(execution));
  return path + (query.size ? "?" + query.toString() : "");
}
export function stageExecutions(
  detail: AutoRebalanceHistoryDetailResponse,
  stage: AutoRebalanceStageResponse,
) {
  const market = detail.portfolio === "india" ? "india" : "us";
  const belongs = (entry: { prompt: string }) => {
    const identity = getAnalysisRunIdentity({
      prompt: entry.prompt,
      auto_rebalance_portfolio: detail.portfolio,
    });
    return identity.stage === stage.stage && identity.market === market;
  };
  return {
    runs: detail.runs.filter((run) => run.id === stage.run_id || belongs(run)).sort((a, b) => b.id - a.id),
    standalone: detail.standalone_jobs.filter((job) => job.id === stage.job_id || belongs(job)),
  };
}
export function inputRevision(prompt: string | undefined, card: CardKey, market: ScorecardMarket) {
  const match = prompt?.match(
    /^\[INDEPENDENT_SCORECARD:(india|us):(rebalance|technical|threats|pairwise):(\d+)\]/,
  );
  return match && match[1] === (market === "zerodha" ? "india" : "us") && match[2] === card
    ? Number(match[3])
    : null;
}
