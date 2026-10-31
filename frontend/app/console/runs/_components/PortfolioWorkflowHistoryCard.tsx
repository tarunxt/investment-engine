'use client';

import Link from 'next/link';
import { STAGE_ORDER, WorkflowStageTile } from '@/components/shared/WorkflowStageTile';
import { historicalStageInfo } from '@/lib/portfolioStageHistory';
import { getRunDetailPathFromPrompt } from '@/lib/runPresentation';
import { formatCompactStageTime } from '@/lib/datetime';
import { URLs } from '@/lib/urls';
import type { AutoRebalanceHistoryItemResponse, RunListItem } from '@/types/api';

export function PortfolioWorkflowHistoryCard({ group, runs, onOpen }: {
  group: AutoRebalanceHistoryItemResponse;
  runs: RunListItem[];
  onOpen: (path: string) => void;
}) {
  const detailPath = URLs.routes.console.autoRebalanceRunDetail(group.portfolio === 'india' ? 'zerodha' : 'indmoneyUs', group.sequence);
  const children = runs.filter(run => run.auto_rebalance_portfolio === group.portfolio && run.auto_rebalance_sequence === group.sequence);
  return (
    <section className="min-w-0 rounded-2xl border border-gray-200 bg-white p-5 shadow-sm" aria-label={group.label}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-950"><Link href={detailPath} className="text-blue-700 underline underline-offset-2">{group.label}</Link></h2>
        <span className="text-sm capitalize text-gray-600">{group.status.replaceAll('_', ' ')}</span>
      </div>
      <div role="region" aria-label={`${group.label} six stages; scroll horizontally`} tabIndex={0}
        className="mt-4 overflow-x-auto rounded-xl pb-3 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500">
        <div className="grid grid-flow-col auto-cols-[minmax(17rem,1fr)] gap-4">
          {STAGE_ORDER.map(key => {
            const stage = group.stages.find(item => item.stage === key);
            const source = children.find(run => run.id === stage?.run_id);
            const path = stage?.run_id ? getRunDetailPathFromPrompt(stage.run_id, source?.prompt_preview) : detailPath;
            return <WorkflowStageTile key={key} stage={key} info={historicalStageInfo(stage)} now={Date.parse(group.updated_at)} historical
              onClick={stage ? () => onOpen(path) : undefined}
              onOutputClick={stage ? () => onOpen(path) : undefined}
              onPromptClick={stage?.run_id ? () => onOpen(path) : undefined} />;
          })}
        </div>
      </div>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-gray-500">
        <span>Started: {formatCompactStageTime(group.created_at)}</span>
        <span>{children.length} stage run{children.length === 1 ? '' : 's'}</span>
        <Link href={detailPath} className="text-blue-700 underline">Stage history and diagnostics</Link>
        {children.map(run => <Link key={run.id} href={getRunDetailPathFromPrompt(run.id, run.prompt_preview)} className="text-blue-700 underline">Run #{run.id} · {run.status} · {run.run_jobs.length} provider jobs</Link>)}
      </div>
    </section>
  );
}
