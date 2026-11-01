'use client';

import { useState } from 'react';
import { StageErrorDetails } from '@/components/shared/StageErrorDetails';
import { StageDurationBreakdownDialog } from '@/app/console/dashboard/_components/StageDurationBreakdownDialog';
import { formatDuration, formatInrCost, formatLlmCompletion, formatRecommendedStockProgress, getStageTileError, getStageTileLabel, type StageInfo, type WorkflowStageKey } from '@/components/shared/WorkflowStageTile';
import { formatCompactStageTime } from '@/lib/datetime';

export function HistoricalStageLedgerRow({ stage, info, now, onClick, onOutputClick, onPromptClick, additional = false }: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  onClick?: () => void;
  onOutputClick?: () => void;
  onPromptClick?: () => void;
  additional?: boolean;
}) {
  const [durationOpen, setDurationOpen] = useState(false);
  const label = getStageTileLabel(stage);
  const error = getStageTileError(info);
  const llm = !['sync', 'actionables'].includes(stage);
  const duration = info.endedAt ? formatDuration(info.startedAt, info.endedAt, now) ?? 'n/a' : 'n/a';
  const actionClass = 'rounded text-violet-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 dark:text-violet-300';
  if (additional) return <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-slate-200 py-2 text-xs dark:border-slate-700">
    <span className="font-semibold">{label}</span>
    {llm ? <span>Measured scan cost: {formatInrCost(info.costInr)}{info.costUsd != null ? ` · USD ${info.costUsd}` : ''}</span> : null}
    {onClick ? <button type="button" className={actionClass} onClick={onClick}>Open stage</button> : null}
    {onOutputClick ? <button type="button" className={actionClass} onClick={onOutputClick}>Saved output for {label}</button> : null}
    {onPromptClick ? <button type="button" className={actionClass} onClick={onPromptClick}>Prompt for {label}</button> : null}
    {llm && info.endedAt ? <button type="button" className={actionClass} aria-haspopup="dialog" aria-label={`Show duration breakdown for ${label}`} onClick={() => setDurationOpen(true)}>Duration: {duration}</button> : null}
    {error.detail ? <span>Error detail <StageErrorDetails stageLabel={label} info={info} row={error} /></span> : null}
    <StageDurationBreakdownDialog open={durationOpen} stageLabel={label} info={info} now={now} onClose={() => setDurationOpen(false)} />
  </div>;
  return <tr className="border-t border-slate-200 align-top dark:border-slate-700">
    <th scope="row" className="px-2 py-3 text-left font-semibold">{label}</th>
    <td className="px-2 py-3">{info.runStatus || 'Not recorded'}</td>
    <td className="px-2 py-3">{formatCompactStageTime(info.completedAt ?? (stage === 'sync' ? null : info.startedAt))}</td>
    <td className="px-2 py-3">{stage === 'sync' ? '—' : stage === 'actionables' ? `Rebalance inputs ${info.rebalanceInputs ?? 'n/a'}` : formatLlmCompletion(info)}</td>
    <td className="px-2 py-3">{stage === 'sync' ? '—' : formatRecommendedStockProgress(info)}</td>
    <td className="px-2 py-3 whitespace-nowrap">{llm ? duration : '—'}</td>
    <td className="px-2 py-3">{error.value}</td>
  </tr>;
}
