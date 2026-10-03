import type { OutputSourceJobReference, RunResponse } from "@/types/api";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import { deduplicateStageRunInputs } from "@/lib/rebalanceStageInputs";
import { getAnalysisRunIdentity } from "@/lib/rebalanceRunIdentity";

export const MAX_OUTPUT_SOURCE_JOBS = 200;
export const MAX_OUTPUT_SOURCE_BYTES = 2_000_000;

export type OutputSourceSelection = {
  market: SwingTradeMarket;
  runs: RunResponse[];
  inputBundle: string;
};

/** Bind exact selected response versions outside the prompt; never merge samples. */
export async function buildOutputSourceJobs(
  runs: RunResponse[], market: SwingTradeMarket,
): Promise<OutputSourceJobReference[]> {
  const selected = deduplicateStageRunInputs(runs, { market, stage: "swing" });
  const jobs = selected.flatMap((run) => run.run_jobs
    .filter((link) => ["completed", "partial"].includes(run.status.toLowerCase())
      && ["completed", "partial"].includes(link.job.status.toLowerCase()) && link.job.response?.trim())
    .map((link) => ({ run, link })));
  if (jobs.length > MAX_OUTPUT_SOURCE_JOBS) {
    throw new Error(`At most ${MAX_OUTPUT_SOURCE_JOBS} Swing source jobs are supported. Reduce the selection.`);
  }
  const encoder = new TextEncoder();
  let byteCount = 0;
  const sources: OutputSourceJobReference[] = [];
  for (const { run, link } of jobs) {
    const bytes = encoder.encode(link.job.response!);
    byteCount += bytes.byteLength;
    if (byteCount > MAX_OUTPUT_SOURCE_BYTES) {
      throw new Error(`Selected Swing output exceeds ${MAX_OUTPUT_SOURCE_BYTES} UTF-8 bytes. Reduce the selection.`);
    }
    const digest = await crypto.subtle.digest("SHA-256", bytes);
    sources.push({ run_id: run.id, job_id: link.job_id,
      response_sha256: [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("") });
  }
  return sources;
}

/** Edited/custom prompts that no longer contain the selected bundle stay unchecked. */
export async function outputSourceJobsForPrompt(prompt: string, selection: OutputSourceSelection | null) {
  if (!selection?.inputBundle || !prompt.includes(selection.inputBundle)) return undefined;
  const target = getAnalysisRunIdentity({ prompt });
  if (target.stage !== "rebalance" || target.market !== selection.market) return undefined;
  return buildOutputSourceJobs(selection.runs, selection.market);
}
