import type { AutoRebalanceStageResponse } from '@/types/api';

export const RUN_HIERARCHY_HELP = 'A workflow contains stage runs; each stage run contains provider jobs with saved prompts and outputs.';

const STAGE_NAMES: Record<string, string> = {
  sync: 'Sync Portfolio', threats: 'Threats Scan', swing: 'Swing Scan',
  rebalance: 'Rebalance', technical: 'Technical Scan', actionables: 'Final Actionables',
};

export function recordedStageRunLabel(runId: number, stages: Pick<AutoRebalanceStageResponse, 'stage' | 'run_id'>[]) {
  const names = [...new Set(stages.filter(stage => stage.run_id === runId).map(stage => STAGE_NAMES[stage.stage]).filter(Boolean))];
  return names.length ? `${names.join(' / ')} stage run` : 'Stage run (stage name unavailable)';
}
