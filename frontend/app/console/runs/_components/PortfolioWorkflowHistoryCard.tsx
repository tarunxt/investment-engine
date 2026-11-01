'use client';

import Link from 'next/link';
import { recordedStageRunLabel, RUN_HIERARCHY_HELP } from '@/lib/runHierarchy';
import { useEffect, useId, useState } from 'react';
import { getStageTileLabel, STAGE_ORDER } from '@/components/shared/WorkflowStageTile';
import { HistoricalStageLedgerRow } from './HistoricalStageLedgerRow';
import { historicalStageInfo, portfolioResultCompleteness } from '@/lib/portfolioStageHistory';
import { getRunDetailPathFromPrompt } from '@/lib/runPresentation';
import { formatCompactStageTime } from '@/lib/datetime';
import { URLs } from '@/lib/urls';
import type { AutoRebalanceHistoryItemResponse, RunListItem } from '@/types/api';

export function PortfolioWorkflowHistoryCard({ group, runs, onOpen, runLinksAvailable = true, initialView = 'summary', adjacentGroups = [], lastRefreshed }: {
  initialView?: 'summary' | 'evidence' | 'diagnostics';
  adjacentGroups?: AutoRebalanceHistoryItemResponse[];
  lastRefreshed?: string;
  group: AutoRebalanceHistoryItemResponse;
  runs: RunListItem[];
  runLinksAvailable?: boolean;
  onOpen: (path: string) => void;
}) {
  const detailPath = URLs.routes.console.autoRebalanceRunDetail(group.portfolio === 'india' ? 'zerodha' : 'indmoneyUs', group.sequence);
  const children = runs.filter(run => run.auto_rebalance_portfolio === group.portfolio && run.auto_rebalance_sequence === group.sequence);
  const completeness = portfolioResultCompleteness(group);
  const [view, setView] = useState(initialView);
  const id = useId();
  const identity = `${group.portfolio}:${group.sequence}`;
  useEffect(() => {
    const restore = () => {
      const params = new URLSearchParams(window.location.search);
      const requested = params.get('runView');
      setView(params.get('selectedRun') === identity && ['summary', 'evidence', 'diagnostics'].includes(requested || '') ? requested as typeof view : initialView);
    };
    restore();
    window.addEventListener('popstate', restore);
    return () => window.removeEventListener('popstate', restore);
  }, [identity, initialView]);
  function selectView(next: typeof view) {
    setView(next);
    const url = new URL(window.location.href);
    url.searchParams.set('selectedRun', identity);
    url.searchParams.set('runView', next);
    window.history.pushState(null, '', url);
  }
  const tabs = [{ key: 'summary', label: 'Run summary' }, { key: 'evidence', label: `Run ${group.sequence} stage evidence` }, { key: 'diagnostics', label: 'Diagnostics and earlier context' }] as const;
  const renderStage = (key: typeof STAGE_ORDER[number], additional = false) => {
    const stage = group.stages.find(item => item.stage === key);
    const source = children.find(run => run.id === stage?.run_id);
    const path = stage?.run_id ? getRunDetailPathFromPrompt(stage.run_id, source?.prompt_preview) : detailPath;
    return <HistoricalStageLedgerRow key={key} stage={key} info={historicalStageInfo(stage)} now={Date.parse(group.updated_at)} additional={additional}
      onClick={stage ? () => onOpen(path) : undefined} onOutputClick={stage ? () => onOpen(path) : undefined} onPromptClick={stage?.run_id ? () => onOpen(path) : undefined} />;
  };
  return (
    <section className="min-w-0 rounded-2xl border border-gray-200 bg-slate-50 p-4 shadow-sm dark:border-slate-700 dark:bg-slate-900 dark:text-slate-100" aria-label={group.label}>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h2 className="font-semibold text-gray-950 dark:text-slate-100"><Link href={detailPath} className="text-blue-700 dark:text-violet-300 underline underline-offset-2">Workflow · {group.label}</Link></h2>
        <div className="text-right text-sm">
          <span className={completeness.complete ? 'font-semibold text-emerald-700 dark:text-emerald-300' : 'font-semibold text-amber-800 dark:text-amber-200'}>{completeness.label}</span>
          <p className="text-xs text-gray-500">Execution: {group.status.replaceAll('_', ' ')}</p>
        </div>
      </div>
      <p className="mt-2 text-xs text-slate-500">{RUN_HIERARCHY_HELP}</p>
      <div role="tablist" aria-label={`${group.label} views`} className="mt-3 flex flex-wrap gap-1">
        {tabs.map((tab, index) => <button key={tab.key} type="button" role="tab" id={`${id}-${tab.key}-tab`} aria-controls={`${id}-${tab.key}`} aria-selected={view === tab.key} tabIndex={view === tab.key ? 0 : -1}
          onClick={() => selectView(tab.key)} onKeyDown={event => {
            const next = event.key === 'ArrowRight' ? (index + 1) % tabs.length : event.key === 'ArrowLeft' ? (index + tabs.length - 1) % tabs.length : event.key === 'Home' ? 0 : event.key === 'End' ? tabs.length - 1 : null;
            if (next !== null) { event.preventDefault(); selectView(tabs[next].key); document.getElementById(`${id}-${tabs[next].key}-tab`)?.focus(); }
          }} className={`rounded-md px-3 py-2 text-xs font-semibold focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-violet-500 ${view === tab.key ? 'bg-violet-700 text-white' : 'bg-violet-100 text-violet-900 dark:bg-violet-950 dark:text-violet-200'}`}>{tab.label}</button>)}
      </div>
      <div id={`${id}-summary`} role="tabpanel" aria-labelledby={`${id}-summary-tab`} hidden={view !== 'summary'} className="mt-3 text-sm">
        <dl className="grid grid-cols-2 gap-3">
          <div><dt className="text-slate-500">Selected run</dt><dd>{group.label}</dd></div>
          <div><dt className="text-slate-500">Execution</dt><dd>{group.status.replaceAll('_', ' ')}</dd></div>
          <div><dt className="text-slate-500">Result quality</dt><dd>{completeness.label}</dd></div>
          <div><dt className="text-slate-500">Started</dt><dd>{formatCompactStageTime(group.created_at)}</dd></div>
          <div><dt className="text-slate-500">Last refreshed</dt><dd>{lastRefreshed || 'Not yet refreshed'}</dd></div>
        </dl>
        <Link href={detailPath} className="mt-3 inline-block text-violet-700 underline dark:text-violet-300">Open workflow details · {group.label}</Link>
      </div>
      {!completeness.complete && ['completed', 'partial', 'partial_success'].includes(group.status) ? <p className="mt-3 rounded-md border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-900 dark:border-amber-800 dark:bg-amber-950 dark:text-amber-200">{completeness.label}. Completed execution is not equivalent to fully successful results.</p> : null}
      <div id={`${id}-evidence`} role="tabpanel" aria-labelledby={`${id}-evidence-tab`} hidden={view !== 'evidence'}>
        <div role="region" aria-label={`${group.label} stage evidence`} tabIndex={0} className="mt-3 overflow-x-auto rounded-lg border border-slate-200 bg-white focus-visible:ring-2 focus-visible:ring-violet-500 dark:border-slate-700 dark:bg-slate-900">
          <table className="w-full min-w-[680px] table-fixed text-xs"><colgroup><col className="w-[16%]"/><col className="w-[12%]"/><col className="w-[14%]"/><col className="w-[21%]"/><col className="w-[7%]"/><col className="w-[12%]"/><col className="w-[18%]"/></colgroup>
            <thead className="bg-slate-100 text-left dark:bg-slate-800"><tr>{['Stage', 'Status', 'Saved time', 'Completion / inputs', 'Stocks', 'Duration', 'Error'].map(label => <th key={label} scope="col" className="px-2 py-2 font-semibold">{label}</th>)}</tr></thead>
            <tbody>{STAGE_ORDER.map(key => renderStage(key))}</tbody>
          </table>
        </div>
        <div className="mt-3"><h3 className="text-sm font-semibold">Additional details</h3>{STAGE_ORDER.map(key => renderStage(key, true))}<p className="mt-2 text-xs text-slate-500">History values remain in their own source context; workflow-summary values are preserved separately.</p></div>
      </div>
      <div id={`${id}-diagnostics`} role="tabpanel" aria-labelledby={`${id}-diagnostics-tab`} hidden={view !== 'diagnostics'}>
      <div className="mt-2 flex flex-wrap gap-x-4 gap-y-2 text-xs text-gray-500">

        <span>{runLinksAvailable ? `${children.length} stage run${children.length === 1 ? '' : 's'}` : 'Stage run links are still loading or unavailable'}</span>
        <Link href={detailPath} className="text-blue-700 dark:text-violet-300 underline">Workflow details and diagnostics · {group.label}</Link>
        {children.map(run => <Link key={run.id} href={getRunDetailPathFromPrompt(run.id, run.prompt_preview)} className="text-blue-700 dark:text-violet-300 underline">{recordedStageRunLabel(run.id, group.stages)} · Run #{run.id} · {run.status} · {run.run_jobs.length} provider job{run.run_jobs.length === 1 ? '' : 's'}</Link>)}
      </div>
      {group.error_message ? <p className="mt-3 whitespace-pre-wrap break-words text-xs text-red-700 dark:text-red-300">{group.error_message}</p> : null}
      {adjacentGroups.map(other => <div key={`${other.portfolio}:${other.sequence}`} className="mt-3 border-t border-slate-200 pt-3 text-xs dark:border-slate-700">
        <p className="mb-1 text-slate-500">{Date.parse(other.created_at) > Date.parse(group.created_at) ? 'Later record' : 'Earlier record'}</p>
        <Link className="text-violet-700 underline dark:text-violet-300" href={URLs.routes.console.autoRebalanceRunDetail(other.portfolio === 'india' ? 'zerodha' : 'indmoneyUs', other.sequence)}>Open workflow · {other.label}</Link>
        <p className="mt-1">Execution: {other.status}</p>
        <p>{STAGE_ORDER.map(key => `${getStageTileLabel(key)}: ${other.stages.find(stage => stage.stage === key)?.status || 'Not recorded'}`).join(' · ')}</p>
      </div>)}
      </div>
    </section>
  );
}
