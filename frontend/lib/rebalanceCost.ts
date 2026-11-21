export type StageCost = {
  costUsd?: number | null;
  costInr?: number | null;
  costIncomplete?: boolean;
};

export function knownCost(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function formatRebalanceCost({ costUsd, costInr, costIncomplete }: StageCost) {
  const suffix = costIncomplete ? " (partial estimate)" : " (est.)";
  const amount = (symbol: string, value: number, digits: number) =>
    value > 0 && value < 10 ** -digits ? `<${symbol}${(10 ** -digits).toFixed(digits)}` : `${symbol}${value.toFixed(digits)}`;
  if (knownCost(costInr) && (costInr > 0 || !costUsd)) return amount("₹", costInr, 2) + suffix;
  if (knownCost(costUsd)) return amount("$", costUsd, costUsd > 0 && costUsd < 1 ? 6 : 2) + suffix;
  return "Usage unavailable";
}

// All inputs belong to one invocation. Older rows can carry INR alone.
export function sumRebalanceCosts(items: StageCost[], fx: number): StageCost {
  if (!items.length) return {};
  const usd = items.filter(item => knownCost(item.costUsd));
  const converted = items.map(item =>
    knownCost(item.costInr) && (item.costInr > 0 || !item.costUsd) ? item.costInr :
    knownCost(item.costUsd) && Number.isFinite(fx) && fx > 0 ? item.costUsd * fx : null);
  const inr = converted.filter(knownCost);
  const useInr = inr.length > 0 && inr.length >= usd.length;
  return {
    costUsd: usd.length ? usd.reduce((total, item) => total + item.costUsd!, 0) : null,
    costInr: useInr ? inr.reduce((total, value) => total + value, 0) : null,
    costIncomplete: items.some(item => item.costIncomplete) || (useInr ? inr.length : usd.length) < items.length,
  };
}
