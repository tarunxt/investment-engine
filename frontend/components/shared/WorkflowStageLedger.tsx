"use client";

import { useId, useState, type ComponentProps, type ReactElement } from "react";
import type { RankedListing } from "@/lib/workflowScorecardRanking";
import { StageDurationBreakdownDialog } from "@/app/console/dashboard/_components/StageDurationBreakdownDialog";
import { StageErrorDetails } from "./StageErrorDetails";
import { getStageLedgerTone, getIdleStageRows, getStageTileLabel, STAGE_METADATA, type WorkflowStageTile } from "./WorkflowStageTile";

type Stage = ComponentProps<typeof WorkflowStageTile>;
function evidenceLabel(item: Stage) {
  if (item.info.evidence?.kind === "derived") return "Derived summary · saved final execution not established";
  if (item.info.evidence?.kind === "saved") return "Historical saved evidence";
  return item.info.state === "idle" ? "Source unavailable" : "Workflow stage state · see History for invocation identity";
}
export type WorkflowLedgerView = "ledger" | "evidence" | "execution";
export function WorkflowStageLedgerViews({ market, view, onChange, portfolioOnly = false }: {
  market: "zerodha" | "indmoneyUs";
  portfolioOnly?: boolean;
  view: WorkflowLedgerView;
  onChange: (market: "zerodha" | "indmoneyUs", view: WorkflowLedgerView) => void;
}) {
  if (portfolioOnly) return null;
  return <nav aria-label="Automated rebalance views" className="mb-3 flex flex-wrap gap-2">
    {([
      { label: "India stage ledger", market: "zerodha", view: "ledger" },
      { label: "US stage ledger", market: "indmoneyUs", view: "ledger" },
      { label: "Saved evidence and configuration", market, view: "evidence" },
      { label: "Run and order controls", market, view: "execution" },
    ] as const).map(item => {
      const active = market === item.market && view === item.view;
      return <button key={item.label} type="button" aria-pressed={active}
        onClick={() => onChange(item.market, item.view)}
        className={`min-h-10 rounded-lg border px-3 py-2 text-sm font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2 ${active ? "border-indigo-700 bg-indigo-700 text-white" : "border-indigo-200 bg-indigo-50 text-indigo-800 hover:bg-indigo-100"}`}>
        {item.label}
      </button>;
    })}
  </nav>;
}
const control = "inline-flex min-h-9 items-center rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2";

/** Presentation adapter: the workflow continues to own every value and callback. */
export function WorkflowStageLedger({ children, enabled, view = "ledger", historyHref, onStockFlowClick, market, active = false }: {
  children: ReactElement<Stage>[];
  enabled: boolean;
  active?: boolean;
  view?: WorkflowLedgerView;
  market?: "zerodha" | "indmoneyUs";
  historyHref: string;
  onStockFlowClick: () => void;
}) {
  const [selectedStage, setSelectedStage] = useState("sync");
  const [durationStage, setDurationStage] = useState<Stage | null>(null);
  const detailId = useId();
  if (!enabled) return <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
  const stages = children.map(child => {
    const item = child.props;
    // Upcoming stages have no current execution evidence, including restored tabs.
    return active && (item.info.state === "idle" || item.info.state === "queued")
      ? { ...item, info: { state: item.info.state } } : item;
  });
  const selected = stages.find(item => item.stage === selectedStage) ?? stages[0];
  const openDuration = (item: Stage) => {
    setDurationStage(item);
  };
  const evidenceControls = (selected: Stage) => <div className="mt-3 flex flex-wrap gap-1">
        {selected.onInputClick ? <button type="button" className={control} onClick={selected.onInputClick}>Inputs</button> : null}
        {selected.onInfoClick ? <button type="button" className={control} onClick={selected.onInfoClick}>Models</button> : null}
        {selected.onPromptClick ? <button type="button" className={control} onClick={selected.onPromptClick}>Prompt</button> : null}
        {selected.onOutputClick ? <button type="button" className={control} onClick={selected.onOutputClick}>Saved output</button> : null}
        {getIdleStageRows(selected.stage, selected.info, selected.now).some(row => row.label === "Duration") ? <button type="button" className={control} aria-haspopup="dialog" onClick={() => openDuration(selected)}>Duration</button> : null}
        {selected.onCalculationsClick ? <button type="button" className={control} onClick={selected.onCalculationsClick}>Calculation</button> : null}
        <button type="button" className={control} onClick={onStockFlowClick}>Stock Flow</button>
        <a className={control} href={historyHref}>History</a>
        {!selected.selectable && selected.onClick ? <button type="button" className={control} onClick={selected.onClick}>Open stage</button> : null}
  </div>;
  if (view === "ledger") {
    const lanes = [
      { title: "Sync portfolio", keys: ["sync"] },
      { title: "Discover contenders", keys: ["swing"] },
      { title: "Score & check threats", keys: ["rebalance", "technical", "threats"] },
      { title: "Build Actionables", keys: ["actionables"] },
    ];
    return <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Rebalance workflow">
      {lanes.map((lane, index) => <section key={lane.title} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
        <h3 className="mb-3 font-semibold">{index + 1} · {lane.title}</h3>
        {lane.keys.map(key => {
          const item = stages.find(stage => stage.stage === key);
          if (!item) return null;
          const rows = getIdleStageRows(item.stage, item.info, item.now);
          const ranking = item.info.frozenFinal?.actionable_ranking as { rows?: RankedListing[] } | undefined;
          const upcoming = active && (item.info.state === "idle" || item.info.state === "queued");
          return <div key={key} className="mb-3">
            <article className={`rounded-lg border border-slate-200 p-3 ${getStageLedgerTone(item.info)}`}>
              <h4 className="font-semibold">{getStageTileLabel(item.stage)}</h4>
              <p className="text-sm capitalize">{item.info.state} {item.info.runStatus}</p>
              {item.selectable && <label className="text-xs"><input type="checkbox" checked={Boolean(item.selected)} onChange={item.onClick} /> Select for next run</label>}
              {!upcoming && <><p className="text-xs">{evidenceLabel(item)}</p>
                <dl className="mt-2 text-xs">{rows.map(row => <div key={row.label} className="flex justify-between gap-2">
                  <dt>{row.label}</dt><dd>{row.label === "LLMs completed" && market ? <button type="button"
                    data-auto-rebalance-llm-metric="true" data-workflow-stage={item.stage}
                    data-workflow-portfolio={market === "zerodha" ? "india" : "indmoney_us"}
                    data-workflow-total={item.info.totalLlms ?? undefined} data-workflow-run-id={item.info.activeRunId ?? item.info.lastRunId ?? undefined}
                    data-workflow-job-id={item.info.jobId ?? undefined} data-workflow-sequence={item.info.workflowSequence ?? undefined}
                    data-workflow-passed={item.info.passedLlms ?? undefined} data-workflow-partial={item.info.partialLlms ?? undefined}
                    data-workflow-failed={item.info.failedLlms ?? undefined} className="text-indigo-700 underline">{row.value}</button> : row.value}{row.detail && <StageErrorDetails stageLabel={getStageTileLabel(item.stage)} info={item.info} row={row} />}</dd>
                </div>)}</dl></>}
              {item.stage === "actionables" && ranking?.rows && <details className="mt-2 text-xs">
                <summary>Final scores · {ranking.rows.length} stocks</summary>
                <table className="my-2 w-full text-left"><thead><tr><th>Listing</th><th>Pairwise</th><th>Threat</th><th>Final /100</th></tr></thead>
                  <tbody>{ranking.rows.map(row => <tr key={row.listing}><th>{row.listing}</th><td>{row.pairwise?.toFixed(1) ?? "—"}</td>
                    <td>{row.stock_threat?.toFixed(1) ?? "—"}</td><td>{row.score?.toFixed(2) ?? "—"}</td></tr>)}</tbody></table>
              </details>}
              {item.info.portfolioThreat && <p className="mt-2 text-sm">Portfolio Threat · {item.info.portfolioThreat}</p>}
              {evidenceControls(item)}
              {item.onSyncNowClick && <button type="button" className={control} onClick={item.onSyncNowClick}>Sync Now</button>}
            </article>
            {item.stage === "swing" && <div className="mt-2 rounded-lg border p-3 text-sm">
              <h4 className="font-semibold">Merge contenders</h4>
              <p>{item.info.recommendedStocks != null ? item.info.recommendedStocks + " unique listings" : "Awaiting scan evidence"}</p></div>}
            {item.stage === "threats" && <div className="mt-2 rounded-lg border p-3 text-sm">
              <h4 className="font-semibold">Pairwise scorecard</h4><p>{item.info.pairCoverage ?? (item.info.state === "running" ? "Assessing stock pairs" : "No saved comparisons")}</p>
              {item.onOutputClick && <button type="button" className={control} onClick={item.onOutputClick}>Saved output</button>}
            </div>}
            {item.onPlaceOrderClick && <button type="button" className="mt-2 w-full rounded-lg bg-indigo-700 p-2 text-white" onClick={item.onPlaceOrderClick}>Place Order</button>}
          </div>;
        })}
      </section>)}
      <StageDurationBreakdownDialog open={Boolean(durationStage)} stageLabel={durationStage ? STAGE_METADATA[durationStage.stage].idle : ""} info={durationStage?.info ?? { state: "idle" }} now={durationStage?.now ?? 0} onClose={() => setDurationStage(null)} />
    </div>;
  }
  return <div className="mt-4 min-w-0 space-y-3 text-sm text-slate-600">
    {view !== "execution" ? <section id={detailId} aria-label="Saved evidence and configuration" className="rounded-xl border border-indigo-100 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">Saved evidence and configuration · {getStageTileLabel(selected.stage)}</h3>
        {view === "evidence" ? <label className="text-xs">Stage <select aria-label="Stage" value={selected.stage} onChange={event => setSelectedStage(event.target.value)} className="ml-2 rounded border border-indigo-200 bg-white p-2 text-sm text-slate-900">{stages.map(item => <option key={item.stage} value={item.stage}>{STAGE_METADATA[item.stage].step} {getStageTileLabel(item.stage)}</option>)}</select></label> : null}
      </div>
      {selected.stage !== "sync" && <p className="mt-1 text-xs">{STAGE_METADATA[selected.stage].tileDescription}</p>}
      <ul aria-label="Evidence sources" className="mt-1 text-xs">
        {(selected.info.evidence?.references ?? [
          selected.info.activeRunId || selected.info.lastRunId ? `Run #${selected.info.activeRunId || selected.info.lastRunId}` : null,
          selected.info.jobId ? `Job #${selected.info.jobId}` : null,
        ].filter((value): value is string => Boolean(value))).map((reference, index) => <li key={index}>{reference}</li>)}
      </ul>
      {evidenceControls(selected)}
    </section> : null}
    <section aria-label="Sync and order controls" className="rounded-xl border border-slate-300 bg-slate-50 p-3">
      <h3 className="font-semibold text-slate-900">Run and order controls</h3>
      <p className="mt-1 text-xs">Next run: {stages.some(item => item.selectable) ? stages.filter(item => item.selected).map(item => getStageTileLabel(item.stage)).join(", ") || "No stages selected" : "Use the Run controls above"}.</p>
      {view === "execution" && stages.some(item => item.selectable) ? <fieldset className="mt-2 flex flex-wrap gap-3">
        <legend className="mb-1 text-xs font-semibold">Run specific Stages</legend>
        {stages.map(item => <label key={item.stage} className="inline-flex items-center gap-2 text-xs"><input type="checkbox" disabled={!item.selectable} checked={Boolean(item.selected)} onChange={item.onClick} className="size-4 accent-indigo-700" />{getStageTileLabel(item.stage)}</label>)}
      </fieldset> : null}
      <div className="mt-3 flex flex-wrap gap-2">{stages.map(item => <span key={item.stage}>
        {item.onSyncNowClick ? <button type="button" className={control} onClick={item.onSyncNowClick}>Sync Now</button> : null}
        {item.onPlaceOrderClick ? <button type="button" className="inline-flex min-h-9 items-center rounded-lg border border-indigo-700 bg-indigo-700 px-3 py-1.5 text-sm font-medium text-white hover:bg-indigo-800 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600 focus-visible:ring-offset-2" onClick={item.onPlaceOrderClick}>{item.placeOrderLabel ?? "Place Order"}</button> : null}
      </span>)}</div>
    </section>
    <StageDurationBreakdownDialog open={Boolean(durationStage)} stageLabel={durationStage ? STAGE_METADATA[durationStage.stage].idle : ""} info={durationStage?.info ?? { state: "idle" }} now={durationStage?.now ?? 0} onClose={() => setDurationStage(null)} />
  </div>;
}
