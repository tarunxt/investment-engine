import type { ProviderInfo, ProviderModelTarget } from "@/types/api";

export type ModelStage = "swing" | "rebalance" | "technical" | "threats" | "pairwise";
export type StageModelPreferences = Partial<Record<ModelStage, string[]>>;

export function isModelStage(stage: string): stage is ModelStage {
  return ["swing", "rebalance", "technical", "threats", "pairwise"].includes(stage);
}

export function defaultStageModelKeys(stage: ModelStage): string[] {
  const count = stage === "swing" || stage === "rebalance" ? 2 : 1;
  return Array<string>(count).fill("deepseek::deepseek-v4-flash");
}

export function usesSingleScorecardJob(stage: string, portfolio?: string | null) {
  return portfolio === "zerodha" && (stage === "threats" || stage === "pairwise");
}

export function resolveStageModelKeys(stage: ModelStage, saved: StageModelPreferences, portfolio?: string | null) {
  const keys = saved[stage] ?? defaultStageModelKeys(stage);
  return usesSingleScorecardJob(stage, portfolio) ? keys.slice(0, 1) : keys;
}

export function getCompatibleTargets(providers: ProviderInfo[]): ProviderModelTarget[] {
  return providers.flatMap(provider => provider.configured
    ? provider.models.filter(model => provider.model_compatibility?.[model]?.compatible !== false)
      .map(model => ({ provider: provider.name, model }))
    : []);
}

// Older browser selections had no account identifier. Import only on explicit selection.
export function previousBrowserSelection(stage: ModelStage) {
  try {
    const value = JSON.parse(localStorage.getItem("investment-engine:dashboard-stage-llms:v1") ?? "{}")[stage];
    return Array.isArray(value) && value.every(key => typeof key === "string") ? value as string[] : null;
  } catch {
    return null;
  }
}
