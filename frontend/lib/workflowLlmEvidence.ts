/** One classification contract for stage tiles, saved-output summaries and model dialogs. */
export type WorkflowLlmJob = { status?: string | null; error_message?: string | null; response?: string | null };
export function classifyWorkflowLlmJob(job: WorkflowLlmJob | null | undefined): "completed" | "partial" | "failed" | "other" {
  const status = (job?.status || "").toLowerCase();
  const issueText = `${job?.error_message || ""}\n${job?.response || ""}`.toLowerCase();
  const hasSavedRows = Boolean(job?.response?.trim());
  if (status === "partial" || issueText.includes("partial rebalance table") ||
      (issueText.includes("malformed table output") && hasSavedRows) ||
      (hasSavedRows && status !== "completed" && status !== "failed")) return "partial";
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "other";
}
export function summarizeWorkflowLlmJobs(jobs: WorkflowLlmJob[]) {
  const states = jobs.map(classifyWorkflowLlmJob);
  return { total: jobs.length, passed: states.filter(s => s === "completed").length,
    partial: states.filter(s => s === "partial").length, failed: states.filter(s => s === "failed").length,
    unresolved: states.filter(s => s === "other").length };
}
