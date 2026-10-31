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
