import type {
  AutoRebalanceHistoryDetailResponse,
  AutoRebalanceJobDetailResponse,
  AutoRebalanceStageKey,
  RunResponse,
} from "@/types/api";

export type SavedJobAttribution = {
  stage: AutoRebalanceStageKey | null;
  jobStageLinks: AutoRebalanceStageKey[];
  runStageLinks: AutoRebalanceStageKey[];
  runIds: number[];
  standalone: boolean;
  evidence: "job-link" | "run-link" | "analysis-endpoint" | "unknown";
};

const unique = <T,>(values: T[]) => [...new Set(values)];

export function unknownJobAttribution(): SavedJobAttribution {
  return { stage: null, jobStageLinks: [], runStageLinks: [], runIds: [], standalone: false, evidence: "unknown" };
}

/** Describe saved membership; never select, rewrite or infer a job's stage from prompt text. */
export function describeWorkflowJobs(
  detail: AutoRebalanceHistoryDetailResponse,
  jobs: AutoRebalanceJobDetailResponse[],
): Record<number, SavedJobAttribution> {
  return Object.fromEntries(jobs.map(job => {
    const runIds = unique(detail.runs.filter(run => Array.isArray(run.jobs) && run.jobs.some(item => item.id === job.id)).map(run => run.id));
    const jobStageLinks = unique(detail.stages.filter(item => item.job_id === job.id).map(item => item.stage));
    const runStageLinks = unique(detail.stages.filter(item => item.run_id != null && runIds.includes(item.run_id)).map(item => item.stage));
    const stages = unique([...jobStageLinks, ...runStageLinks]);
    return [job.id, {
      stage: stages.length === 1 ? stages[0] : null,
      jobStageLinks, runStageLinks, runIds,
      standalone: runIds.length === 0 && detail.standalone_jobs.some(item => item.id === job.id),
      evidence: stages.length === 1 ? jobStageLinks.length ? "job-link" : "run-link" : "unknown",
    } satisfies SavedJobAttribution];
  }));
}

/** The verified history contract binds stages to saved run/job IDs, not prompt mentions. */
export function selectWorkflowStageJobs(detail: AutoRebalanceHistoryDetailResponse, stage: AutoRebalanceStageKey) {
  const refs = detail.stages.filter(item => item.stage === stage);
  const runIds = unique(refs.flatMap(item => item.run_id == null ? [] : [item.run_id]));
  const jobIds = unique(refs.flatMap(item => item.job_id == null ? [] : [item.job_id]));
  const candidates = [
    ...detail.runs.flatMap(run => (Array.isArray(run.jobs) ? run.jobs : []).filter(job => runIds.includes(run.id) || jobIds.includes(job.id))),
    ...detail.standalone_jobs.filter(job => jobIds.includes(job.id)),
  ];
  const jobs = [...new Map(candidates.map(job => [job.id, job])).values()].sort((a, b) => a.id - b.id);
  const missing = [
    ...runIds.filter(id => !detail.runs.some(run => run.id === id && Array.isArray(run.jobs))).map(id => `Run #${id}`),
    ...jobIds.filter(id => !jobs.some(job => job.id === id)).map(id => `Job #${id}`),
  ];
  const warning = !runIds.length && !jobIds.length
    ? "No saved run/job link proves this stage's record membership. Unrelated records are not substituted."
    : missing.length ? `Saved stage references are missing from this response: ${missing.join(", ")}. The record list is incomplete; unrelated records are not substituted.` : null;
  return { jobs, warning };
}

export function describeRecentJobs(
  runs: RunResponse[],
  jobs: AutoRebalanceJobDetailResponse[],
): Record<number, SavedJobAttribution> {
  return Object.fromEntries(jobs.map(job => [job.id, {
    ...unknownJobAttribution(),
    runIds: unique(runs.filter(run => run.run_jobs.some(link => link.job?.id === job.id)).map(run => run.id)),
  }]));
}

export function describeSavedThreat(jobId: number): Record<number, SavedJobAttribution> {
  return { [jobId]: { ...unknownJobAttribution(), stage: "threats", evidence: "analysis-endpoint" } };
}

export function savedStageLabel(stage: AutoRebalanceStageKey) {
  return { sync: "Portfolio Sync", threats: "Threats Scan", swing: "Swing Scan", rebalance: "Rebalance", technical: "Technical Scan", actionables: "Final Actionables" }[stage];
}
