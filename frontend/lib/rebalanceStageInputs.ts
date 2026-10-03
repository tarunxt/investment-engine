import type { IndMoneyUsThreatAnalysis, RunResponse, ZerodhaThreatAnalysis } from "@/types/api";
import type { SwingTradeMarket } from "@/lib/swingTrade";
import { isAnalysisRunForStage } from "@/lib/rebalanceRunIdentity";

type RunInputStage = "swing" | "rebalance";
type RunInputScope = { market: SwingTradeMarket; stage: RunInputStage };
type RunJobIdentity = RunInputScope & { kind: "run-job"; runId: number; jobId: number };
type ThreatJobIdentity = { kind: "threat-job"; market: SwingTradeMarket; stage: "threats"; jobId: number };
export type ThreatStageInput = {
  identity: ThreatJobIdentity;
  analysis: ZerodhaThreatAnalysis | IndMoneyUsThreatAnalysis;
  origin: "generated" | "selected";
};

function invalidSource(detail: string): never {
  throw new Error(`Stage input ${detail}. Refresh Select Inputs and start a new workflow before continuing.`);
}

function validId(id: number) {
  return Number.isSafeInteger(id) && id > 0;
}

function sourceKey(identity: RunJobIdentity | ThreatJobIdentity) {
  return identity.kind === "run-job"
    ? `${identity.market}:${identity.stage}:run:${identity.runId}:job:${identity.jobId}`
    : `${identity.market}:${identity.stage}:threat-job:${identity.jobId}`;
}

function assertSameSource(seen: Map<string, string>, key: string, representation: string) {
  const previous = seen.get(key);
  if (previous !== undefined && previous !== representation) {
    invalidSource(`${key} has conflicting saved output or provenance`);
  }
  seen.set(key, representation);
  return previous === undefined;
}

/**
 * Call only with sources read through authenticated run endpoints for this workflow.
 * Maps are local to this handoff: IDs are never cached/deduplicated across workflows
 * or users. Compare exact response text (the API has no separate output version),
 * not model names, tickers, normalized text or a collision-prone content hash.
 */
export function deduplicateStageRunInputs(runs: RunResponse[], scope: RunInputScope): RunResponse[] {
  const seenRuns = new Map<string, string>();
  const seenJobs = new Map<string, string>();
  return runs.flatMap((run) => {
    if (!validId(run.id) || !isAnalysisRunForStage(run, scope.stage, scope.market)) {
      invalidSource(`run #${run.id} does not match ${scope.market} ${scope.stage}`);
    }
    if (["pending", "processing"].includes(run.status.toLowerCase())) {
      invalidSource(`run #${run.id} is still running`);
    }
    if (!run.run_jobs?.length) invalidSource(`run #${run.id} has no saved jobs`);
    assertSameSource(seenRuns, `${scope.market}:${scope.stage}:run:${run.id}`, JSON.stringify([
      run.prompt, run.created_at, run.auto_rebalance_portfolio ?? null,
      run.auto_rebalance_sequence ?? null, run.auto_rebalance_label ?? null,
      run.synthesis_response, run.decision_response,
    ]));
    const runJobs = run.run_jobs.filter((link) => {
      const job = link.job;
      if (!job || !validId(link.job_id) || !validId(link.stage) || link.job_id !== job.id || link.run_id !== run.id) {
        invalidSource(`run #${run.id} has an invalid job link`);
      }
      if (!isAnalysisRunForStage(job, scope.stage, scope.market)) {
        invalidSource(`run #${run.id} / job #${job.id} does not match ${scope.market} ${scope.stage}`);
      }
      if (["pending", "processing"].includes(job.status.toLowerCase())) {
        invalidSource(`run #${run.id} / job #${job.id} is still running`);
      }
      const identity: RunJobIdentity = { kind: "run-job", ...scope, runId: run.id, jobId: job.id };
      return assertSameSource(seenJobs, sourceKey(identity), JSON.stringify([
        link.stage, job.prompt, job.response, job.status, job.provider, job.model,
        job.created_at, job.auto_rebalance_portfolio ?? null,
        job.auto_rebalance_sequence ?? null, job.auto_rebalance_label ?? null,
      ]));
    });
    return runJobs.length ? [{ ...run, run_jobs: runJobs }] : [];
  });
}

function selectedRunJobs(selectedIds: ReadonlySet<string>, stage: RunInputStage) {
  const nextId = stage === "swing" ? "rebalance:next" : "technical:next";
  return [...selectedIds].flatMap((id) => {
    if (id === nextId) return [];
    const match = /^run:([1-9]\d*):job:([1-9]\d*)$/.exec(id);
    if (!match || !validId(Number(match[1])) || !validId(Number(match[2]))) {
      invalidSource(`selection ${id} is invalid for ${stage}`);
    }
    return [{ id, runId: Number(match[1]), jobId: Number(match[2]) }];
  });
}

export function getSelectedStageRunIds(selectedIds: ReadonlySet<string>, stage: RunInputStage) {
  return [...new Set(selectedRunJobs(selectedIds, stage).map((item) => item.runId))];
}

/** Explicit selections may be historical; never replace missing selections with latest. */
export function selectStageRunInputs(
  runs: RunResponse[], selectedIds: ReadonlySet<string>, scope: RunInputScope,
): RunResponse[] {
  const requested = selectedRunJobs(selectedIds, scope.stage);
  const selected = runs.flatMap((run) => {
    const jobs = run.run_jobs.filter((link) => selectedIds.has(`run:${run.id}:job:${link.job_id}`));
    return jobs.length ? [{ ...run, run_jobs: jobs }] : [];
  });
  const present = new Set(selected.flatMap((run) => run.run_jobs.map((link) => `run:${run.id}:job:${link.job_id}`)));
  for (const item of requested) {
    if (!present.has(item.id)) invalidSource(`selection ${item.id} is no longer available`);
  }
  return deduplicateStageRunInputs(selected, scope);
}

export function getSelectedThreatJobIds(selectedIds: ReadonlySet<string>) {
  return [...selectedIds].flatMap((id) => {
    if (id === "swing:next") return [];
    const match = /^threat:([1-9]\d*)$/.exec(id);
    if (!match || !validId(Number(match[1]))) invalidSource(`threat selection ${id} is invalid`);
    return [Number(match[1])];
  });
}

/** The market comes from the authenticated, market-specific threat detail endpoint. */
export function deduplicateThreatStageInputs(inputs: ThreatStageInput[], market: SwingTradeMarket) {
  const seen = new Map<string, string>();
  return inputs.filter(({ identity, analysis }) => {
    if (identity.kind !== "threat-job" || identity.stage !== "threats" || identity.market !== market
      || !validId(identity.jobId) || identity.jobId !== analysis.job_id) {
      invalidSource(`threat job #${analysis.job_id} has an invalid market, stage or job identity`);
    }
    if (!["completed", "partial"].includes(analysis.status.toLowerCase()) || !analysis.report?.raw_markdown?.trim()) {
      invalidSource(`threat job #${analysis.job_id} has no completed output`);
    }
    return assertSameSource(seen, sourceKey(identity), JSON.stringify([
      analysis.status, analysis.provider, analysis.model, analysis.created_at,
      analysis.snapshot_date, analysis.captured_at, analysis.report.raw_markdown,
    ]));
  });
}
