export type StageCost = {
  costUsd?: number | null;
  costInr?: number | null;
  costIncomplete?: boolean;
};

export function knownCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

// FBIL USD/INR reference published by the RBI on 20 November 2026.
export const referenceCostQuote = { rate: 92.9699, date: "2026-11-20", source: "FBIL" };

function costInRupees({ costUsd, costInr }: StageCost, fx: number) {
  if (knownCost(costInr) && (costInr > 0 || !costUsd)) return costInr;
  const rate = Number.isFinite(fx) && fx > 0 ? fx : referenceCostQuote.rate;
  return knownCost(costUsd) ? costUsd * rate : null;
}

export function formatRebalanceCost(cost: StageCost, fx = referenceCostQuote.rate) {
  const value = costInRupees(cost, fx);
  if (value == null) return "Usage unavailable";
  const amount = value > 0 && value < 0.01 ? "<₹0.01" : `₹${value.toFixed(2)}`;
  return amount + (cost.costIncomplete ? " (partial estimate)" : " (est.)");
}

// Sum unrounded rupees so tiny jobs and older INR-only rows contribute once.
export function sumRebalanceCosts(items: StageCost[], fx: number): StageCost {
  if (!items.length) return {};
  const usd = items.map(item => item.costUsd).filter(knownCost);
  const inr = items.map(item => costInRupees(item, fx)).filter(knownCost);
  return {
    costUsd: usd.length ? usd.reduce((total, value) => total + value, 0) : null,
    costInr: inr.length ? inr.reduce((total, value) => total + value, 0) : null,
    costIncomplete: items.some(item => item.costIncomplete) || inr.length < items.length,
  };
}
