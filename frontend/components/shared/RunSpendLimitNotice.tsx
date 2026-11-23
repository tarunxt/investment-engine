import type { WorkflowSpendLimit } from "@/types/api";

const rupees = new Intl.NumberFormat("en-IN", { style: "currency", currency: "INR" });

export function RunSpendLimitNotice({ budget }: { budget?: WorkflowSpendLimit | null }) {
  if (budget?.max_cost_inr == null) return null;
  const headroom = budget.headroom_inr;
  return <p className="mt-2 text-xs font-semibold text-slate-700">
    Run spending limit {rupees.format(budget.max_cost_inr)} · Remaining at last update{" "}
    {headroom == null ? "unavailable" : rupees.format(headroom)}
  </p>;
}
