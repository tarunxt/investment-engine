'use client';

import { useState } from 'react';
import { StageErrorDetails } from '@/components/shared/StageErrorDetails';
import { StageDurationBreakdownDialog } from '@/app/console/dashboard/_components/StageDurationBreakdownDialog';
import { getIdleStageRows, getStageTileLabel, type StageInfo, type WorkflowStageKey } from '@/components/shared/WorkflowStageTile';

/** Saved evidence only. History durations never advance with the current clock. */
export function HistoricalStageLedgerRow({ stage, info, now, onClick, onOutputClick, onPromptClick }: {
  stage: WorkflowStageKey;
  info: StageInfo;
  now: number;
  onClick?: () => void;
  onOutputClick?: () => void;
  onPromptClick?: () => void;
}) {
  const [durationOpen, setDurationOpen] = useState(false);
  const label = getStageTileLabel(stage);
  const rows = getIdleStageRows(stage, info, now);
  const actionClass = 'rounded text-blue-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500';
  return <article className="min-w-0 p-3 text-sm">
    <div className="flex flex-wrap items-center justify-between gap-2">
      <h3 className="font-semibold text-gray-950">{label}</h3>
      <span className={info.state === 'failed' ? 'font-semibold text-red-700' : 'font-semibold text-slate-700'}>Status: {info.runStatus || 'Not recorded'}</span>
    </div>
    <dl className="mt-2 grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-3 lg:grid-cols-6">
      {rows.map(row => <div key={row.label} className="min-w-0">
        <dt className="font-medium text-slate-500">{row.label}</dt>
        <dd className="mt-1 break-words text-slate-800">
          {row.label === 'Duration' && info.endedAt ? <button type="button" className={actionClass} aria-haspopup="dialog" aria-label={`Show duration breakdown for ${label}`} onClick={() => setDurationOpen(true)}>{row.value}</button>
            : row.label === 'Duration' ? 'n/a' : row.value}
          {row.label === 'Error' && row.detail ? <StageErrorDetails stageLabel={label} info={info} row={row} /> : null}
        </dd>
      </div>)}
    </dl>
    {onClick || onPromptClick || onOutputClick ? <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs">
      {onClick ? <button type="button" className={actionClass} onClick={onClick}>Open {label} stage</button> : null}
      {onPromptClick ? <button type="button" className={actionClass} onClick={onPromptClick}>Open prompt for {label}</button> : null}
      {onOutputClick ? <button type="button" className={actionClass} onClick={onOutputClick}>View output for {label}</button> : null}
    </div> : null}
    <StageDurationBreakdownDialog open={durationOpen} stageLabel={label} info={info} now={now} onClose={() => setDurationOpen(false)} />
  </article>;
}
