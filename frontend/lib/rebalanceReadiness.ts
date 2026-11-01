export type InputReadiness = "Loading" | "Failed" | "Missing" | "Ready";

export function inputReadiness(loading: boolean, error: string | null, present: boolean, status?: string): InputReadiness {
  if (loading) return "Loading";
  if (error) return "Failed";
  if (status && ["failed", "error", "cancelled"].includes(status.toLowerCase())) return "Failed";
  if (status && status.toLowerCase() !== "completed") return "Loading";
  return present ? "Ready" : "Missing";
}

export function isKnownEstimate(value: number | null | undefined): value is number {
  // The provider API has no verified-free provenance. Zero may be a fallback
  // or a rounded estimate and cannot establish that a future run is free.
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

export function estimateReadinessLabel(cost: number, unknown: number, loading: boolean, selected: number) {
  if (loading) return "Loading pricing…";
  if (unknown > 0) return `Unknown (${unknown} model estimate${unknown === 1 ? "" : "s"} unavailable)`;
  if (selected === 0) return "Select models";
  if (cost === 0) return "Unknown (reported zero; free cost not verified)";
  return `₹${cost.toFixed(2)}`;
}
