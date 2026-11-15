const STAGES = ["sync", "threats", "swing", "rebalance", "technical", "actionables"] as const;
const STATES = new Set(["idle", "queued", "running", "completed", "failed"]);
export const WORKFLOW_STATE_KEY = "investment-engine:rebalance-workflow-state:v1";
export const WORKFLOW_CACHE_OWNER_KEY = "investment-engine:private-cache-owner:v1";
export function workflowCompatibilityDestination(raw: string | null, reconciledOwner: string | null, authenticatedOwner: number) {
  const fallback = "/console/zerodha#india-workflow";
  if (!Number.isSafeInteger(authenticatedOwner) || authenticatedOwner <= 0 || reconciledOwner !== String(authenticatedOwner) || !raw) return fallback;
  try {
    const value = JSON.parse(raw);
    if (!value || typeof value !== "object" || !["zerodha", "indmoneyUs"].includes(value.runningPortfolio)) return fallback;
    for (const market of ["zerodha", "indmoneyUs"]) {
      if (!value.states?.[market] || !STAGES.every(stage => STATES.has(value.states[market][stage]?.state))) return fallback;
    }
    const eligible = STAGES.some(stage => ["queued", "running"].includes(value.states[value.runningPortfolio][stage].state));
    return eligible && value.runningPortfolio === "indmoneyUs" ? "/console/indmoney-us#us-workflow" : fallback;
  } catch { return fallback; }
}
