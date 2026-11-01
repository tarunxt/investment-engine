"use client";

import type { RunSideEffectPolicy } from "@/types/api";

export function AnalysisOnlyRunControl({ checked, disabled, onChange }: {
  checked: boolean; disabled: boolean; onChange: (value: boolean) => void;
}) {
  return <label className="flex items-center gap-2 text-xs text-slate-700">
    <input type="checkbox" checked={checked} disabled={disabled}
      onChange={event => onChange(event.target.checked)} />
    Suppress notifications and Sheets exports for this run
  </label>;
}

export function RunSideEffectPolicyNotice({ policy }: { policy?: RunSideEffectPolicy | null }) {
  if (policy?.version !== 1 || policy.mode !== "analysis_only") return null;
  return <p role="note" className="mt-2 text-xs font-semibold text-slate-700">
    Notifications and Sheets exports suppressed for this run.
  </p>;
}
