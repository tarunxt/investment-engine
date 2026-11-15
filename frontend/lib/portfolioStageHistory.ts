import type { AutoRebalanceHistoryItemResponse, AutoRebalanceStageResponse, RunListItem } from '@/types/api';
import type { StageInfo } from '@/components/shared/WorkflowStageTile';

// Only server-verified portfolio + sequence metadata establishes membership.
// The API scopes both workflow records and their children to the current owner.
export function buildPortfolioHistoryEntries(groups: AutoRebalanceHistoryItemResponse[], runs: RunListItem[]) {
  const verified = new Map(groups.map(group => [`${group.portfolio}:${group.sequence}`, group]));
  const ungrouped = runs.filter(run => !verified.has(`${run.auto_rebalance_portfolio}:${run.auto_rebalance_sequence}`));
  return [
    ...groups.map(group => ({ key: `${group.portfolio}:${group.sequence}`, created_at: group.created_at, group, run: null })),
    ...ungrouped.map(run => ({ key: `run:${run.id}`, created_at: run.created_at, group: null, run })),
  ].sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at) ||
    (a.group && b.group && a.group.portfolio === b.group.portfolio ? b.group.sequence - a.group.sequence : b.key.localeCompare(a.key)));
}

export function historicalStageInfo(stage?: AutoRebalanceStageResponse): StageInfo {
  if (!stage) return { state: 'idle', runStatus: 'Not recorded' };
  const summary = stage.summary;
  const number = (key: string) => typeof summary[key] === 'number' && Number.isFinite(summary[key]) ? summary[key] as number : null;
  const partial = number('partial_llms') ?? stage.partial_provider_count ?? 0;
  const failed = number('failed_llms') ?? stage.failed_provider_count;
  return {
    state: ['processing', 'running'].includes(stage.status) ? 'running'
      : ['pending', 'queued'].includes(stage.status) ? 'queued'
      : stage.status === 'completed' ? 'completed'
      : ['failed', 'interrupted', 'cancelled'].includes(stage.status) ? 'failed' : 'idle',
    runStatus: stage.status,
    startedAt: stage.started_at,
    endedAt: stage.completed_at,
    completedAt: stage.completed_at,
    lastRunId: stage.run_id,
    jobId: stage.job_id,
    totalLlms: number('total_llms') ?? stage.provider_count,
    completedLlms: number('completed_llms') ?? stage.completed_provider_count + failed,
    passedLlms: number('passed_llms') ?? Math.max(0, stage.completed_provider_count - partial),
    partialLlms: partial,
    failedLlms: failed,
    recommendedStocks: number('recommended_stocks'),
    rebalanceInputs: number('rebalance_inputs'),
    costUsd: number('cost_usd') ?? stage.estimated_cost,
    // Keep saved currency evidence; never reprice old runs using today's FX.
    costInr: number('cost_inr'),
    partialNotice: typeof summary.partial_notice === 'string' ? summary.partial_notice : null,
    error: stage.error_message,
    frozenFinal: typeof summary.frozen_final === 'object' && summary.frozen_final !== null ? summary.frozen_final as Record<string, unknown> : undefined,
  };
}

// Presentation only: execution status and historical source records stay intact.
export function portfolioResultCompleteness(group: AutoRebalanceHistoryItemResponse) {
  const status = group.status.trim().toLowerCase();
  if (!['completed', 'partial', 'partial_success'].includes(status)) {
    return { label: status.replaceAll('_', ' ') || 'Status unavailable', complete: false };
  }
  const stages = group.stages.map(historicalStageInfo);
  const partial = ['partial', 'partial_success'].includes(status) || group.stages.some(stage => (stage.partial_provider_count ?? 0) > 0 || stage.failed_provider_count > 0) || stages.some(stage =>
    ['partial', 'partial_success'].includes(stage.runStatus ?? '') ||
    (stage.partialLlms ?? 0) > 0 || (stage.failedLlms ?? 0) > 0 ||
    Boolean(stage.partialNotice?.trim()) || Boolean(stage.error?.trim()) || stage.state === 'failed');
  if (partial) return { label: 'Finished with partial results', complete: false };
  const keys = ['sync', 'threats', 'swing', 'rebalance', 'technical', 'actionables'];
  const complete = group.stages.length === keys.length && !group.error_message?.trim() && keys.every(key => {
    const recorded = group.stages.filter(stage => stage.stage === key);
    if (recorded.length !== 1) return false;
    const raw = recorded[0];
    if (![raw.provider_count, raw.completed_provider_count, raw.failed_provider_count].every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)) return false;
    if (raw.provider_count !== raw.completed_provider_count) return false;
    if (raw.partial_provider_count == null && typeof raw.summary.partial_llms !== 'number') return false;
    const stage = historicalStageInfo(raw);
    const counts = [stage.totalLlms, stage.passedLlms, stage.partialLlms, stage.failedLlms];
    return stage.state === 'completed' && counts.every(value => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      && stage.totalLlms === stage.passedLlms && stage.partialLlms === 0 && stage.failedLlms === 0;
  });
  return { label: complete ? 'Fully complete' : 'Finished · completeness unverified', complete };
}
