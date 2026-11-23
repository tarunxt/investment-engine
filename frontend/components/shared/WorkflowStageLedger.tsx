"use client";

import { useId, useState, type ComponentProps, type ReactElement } from "react";
import type { RankedListing } from "@/lib/workflowScorecardRanking";
import { StageDurationBreakdownDialog } from "@/app/console/dashboard/_components/StageDurationBreakdownDialog";
import { WorkflowTileMenu, type TileAction } from "./WorkflowTileMenu";
import { StageErrorDetails } from "./StageErrorDetails";
import { StageStatusIcon, stageTileBorder, getStageLedgerTone, getIdleStageRows, getStageTileLabel, STAGE_METADATA, type WorkflowStageTile } from "./WorkflowStageTile";

import Link from "next/link";
import { isCard, type CardKey } from "@/lib/independentScorecards";
import { cardNames, scorecardHref } from "@/lib/scorecardNavigation";

type Stage = ComponentProps<typeof WorkflowStageTile>;
function kiteBoardRows(item: Stage, rebalance: Stage["info"] | undefined) {
  if (item.stage !== "technical" && isCard(item.stage)) {
    const sameWorkflow = item.info.workflowSequence === rebalance?.workflowSequence;
    const recommendedStocks = sameWorkflow ? rebalance?.recommendedStocks : null;
    return getIdleStageRows(item.stage, { ...item.info, recommendedStocks }, item.now);
  }
  const rows = getIdleStageRows(item.stage, item.info, item.now);
  if (item.stage === "sync") {
    rows.splice(1, 0, { label: "Stocks synced", value: String(item.info.portfolioStockCount ?? "n/a") });
  }
  return rows;
}

function evidenceLabel(item: Stage) {
  if (item.info.runStatus === "not started") return null;
  if (item.info.evidence?.kind === "derived") return "Derived summary · saved final execution not established";
  if (item.info.evidence?.kind === "saved") return null;
  return item.info.state === "idle" ? "Source unavailable" : null;
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
export function WorkflowStageLedger({ children, enabled, view = "ledger", historyHref, onStockFlowClick, onManageSource, onManageCard, market, active = false, basketReady = false, board = false }: {
  children: ReactElement<Stage>[];
  enabled: boolean;
  basketReady?: boolean;
  board?: boolean;
  active?: boolean;
  view?: WorkflowLedgerView;
  market?: "zerodha" | "indmoneyUs";
  historyHref: string;
  onStockFlowClick: () => void;
  onManageSource?: () => void;
  onManageCard?: (card: CardKey) => void;
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
  if (!board) stages.sort((a, b) => STAGE_METADATA[a.stage].step.localeCompare(STAGE_METADATA[b.stage].step));
  const selected = stages.find(item => item.stage === selectedStage) ?? stages[0];
  const openDuration = (item: Stage) => {
    setDurationStage(item);
  };
  const evidenceActions = (item: Stage): TileAction[] => {
    const controls: [string, (() => void) | undefined][] = [
      ["Inputs", item.onInputClick], ["Models", item.onInfoClick], ["Prompt", item.onPromptClick],
      ["Saved output", item.onOutputClick],
      ["Duration", getIdleStageRows(item.stage, item.info, item.now).some(row => row.label === "Duration") ? () => openDuration(item) : undefined],
      ["Calculation", item.onCalculationsClick], ["Stock Flow", onStockFlowClick],
    ];
    const actions: TileAction[] = controls.flatMap(([label, onSelect]) => onSelect ? [{ label, onSelect }] : []);
    actions.push({ label: "History", href: historyHref });
    const card = item.stage;
    if (market && isCard(card)) {
      actions.push({label:"Scorecard history",href:scorecardHref(market,card)});
      if (onManageCard) actions.push({label:"Scorecard controls",onSelect:() => onManageCard(card)});
    }
    if (!item.selectable && item.onClick) actions.push({ label: "Open stage", onSelect: item.onClick });
    return actions;
  };
  const tileHeader = (title: string, actions: TileAction[], info?: Stage["info"]) => <div className="flex items-start justify-between gap-2">
    <h4 className="font-semibold">{title}{info && <StageStatusIcon info={info} />}</h4><WorkflowTileMenu title={title} actions={actions} />
  </div>;
  if (board && view === "ledger") {
    const rebalance = stages.find(item => item.stage === "rebalance")?.info;
    const lanes = [
      { title: "Sync portfolio", keys: ["sync"] },
      { title: market === "zerodha" ? "Find New Promising Stocks" : "Discover contenders", keys: ["swing"] },
      { title: "Scorecards", keys: ["rebalance", "technical", "threats", "pairwise"] },
      { title: market === "zerodha" ? "Final Actionables" : "Build Actionables", keys: ["actionables"] },
    ];
    return <div className="mt-4 grid gap-3 sm:grid-cols-2 xl:grid-cols-4" aria-label="Rebalance workflow">
      {lanes.map((lane, index) => <section key={lane.title} className="min-w-0 rounded-xl border border-slate-200 bg-white p-3">
        <h3 className="mb-3 font-semibold">{index + 1} · {lane.title === "Scorecards" && market ? <Link className="text-indigo-800 underline-offset-4 hover:underline" href={scorecardHref(market)}>Scorecards</Link> : lane.title}</h3>
        {lane.keys.map(key => {
          const item = stages.find(stage => stage.stage === key);
          if (!item) return null;
          const rows = market === "zerodha" ? kiteBoardRows(item, rebalance) : getIdleStageRows(item.stage, item.info, item.now);
          let title = getStageTileLabel(item.stage);
          if (market === "zerodha") {
            if (item.stage === "sync") title = "Sync Kite Portfolio";
            if (item.stage !== "technical" && isCard(item.stage)) title = cardNames[item.stage];
          }
          const ranking = item.info.frozenFinal?.actionable_ranking as { rows?: RankedListing[] } | undefined;
          const label = evidenceLabel(item);
          const upcoming = active && (item.info.state === "idle" || item.info.state === "queued");
          const actions = evidenceActions(item);
          if (item.onSyncNowClick) actions.push({ label: "Sync Now", onSelect: item.onSyncNowClick });
          return <div key={key} className="mb-3">
            <article className={`rounded-lg p-3 ${stageTileBorder(item.info, "border border-slate-200")} ${getStageLedgerTone(item.info)}`}>
              {tileHeader(title, actions, item.info)}
              {item.selectable && <label className="text-xs"><input type="checkbox" checked={Boolean(item.selected)} onChange={item.onClick} /> Select for next run</label>}
              {!upcoming && <>{label && <p className="text-xs">{label}</p>}
                <dl className="mt-2 text-xs">{rows.map(row => <div key={row.label} className="flex justify-between gap-2">
                  <dt>{row.label}</dt><dd>{row.label === "LLMs Used" && market ? <button type="button"
                    data-auto-rebalance-llm-metric="true" data-workflow-stage={item.stage}
                    data-workflow-portfolio={market === "zerodha" ? "india" : "indmoney_us"}
                    data-workflow-total={item.info.totalLlms ?? undefined} data-workflow-run-id={item.info.activeRunId ?? item.info.lastRunId ?? undefined}
                    data-workflow-job-id={item.info.jobId ?? undefined} data-workflow-sequence={item.info.workflowSequence ?? undefined}
                    data-workflow-passed={item.info.passedLlms ?? undefined} data-workflow-partial={item.info.partialLlms ?? undefined}
                    data-workflow-failed={item.info.failedLlms ?? undefined} className="text-indigo-700 underline">{row.value}</button> : row.value}{row.detail && <StageErrorDetails stageLabel={title} info={item.info} row={row} />}</dd>
                </div>)}</dl></>}
              {item.stage === "actionables" && ranking?.rows && <details className="mt-2 text-xs">
                <summary>Final scores · {ranking.rows.length} stocks</summary>
                <table className="my-2 w-full text-left"><thead><tr><th>Listing</th><th>Pairwise</th><th>Threat</th><th>Final /100</th></tr></thead>
                  <tbody>{ranking.rows.map(row => <tr key={row.listing}><th>{row.listing}</th><td>{row.pairwise?.toFixed(1) ?? "—"}</td>
                    <td>{row.stock_threat?.toFixed(1) ?? "—"}</td><td>{row.score?.toFixed(2) ?? "—"}</td></tr>)}</tbody></table>
              </details>}
              {item.info.portfolioThreat && <p className="mt-2 text-sm">Portfolio Threat · {item.info.portfolioThreat}</p>}
            </article>
            {item.onPlaceOrderClick && <button type="button" onClick={item.onPlaceOrderClick}
              className={`mx-auto mt-3 block min-h-12 max-w-full rounded-lg px-8 text-base font-semibold text-white ${basketReady && !active ? "bg-green-700 hover:bg-green-800" : "bg-blue-700 hover:bg-blue-800"}`}>
              {item.placeOrderLabel ?? "Place Order"}
            </button>}
            {item.stage === "swing" && <div className="mt-2 rounded-lg border p-3 text-sm">
              {tileHeader("Merge contenders", [...(onManageSource ? [{label:"Manage Stage 2 inputs",onSelect:onManageSource}] : []), { label: "Stock Flow", onSelect: onStockFlowClick }, { label: "History", href: historyHref }], (market === "zerodha" ? item.info.sourceRevision != null : item.info.recommendedStocks != null) ? {state:"completed"} : { state: "idle" })}
              <p>{market === "zerodha"
                ? item.info.sourceRevision ? `Revision #${item.info.sourceRevision}${item.info.sourceListingCount != null ? " · " + item.info.sourceListingCount + " merged listings" : ""}`
                  : item.info.recommendedStocks != null ? `${item.info.recommendedStocks} Swing listings · Stage 2 inputs pending` : "Awaiting scan evidence"
                : item.info.recommendedStocks != null ? item.info.recommendedStocks + " unique listings" : "Awaiting scan evidence"}</p></div>}

          </div>;
        })}
      </section>)}
      <StageDurationBreakdownDialog open={Boolean(durationStage)} stageLabel={durationStage ? STAGE_METADATA[durationStage.stage].idle : ""} info={durationStage?.info ?? { state: "idle" }} now={durationStage?.now ?? 0} onClose={() => setDurationStage(null)} />
    </div>;
  }
  const rowValue = (item: Stage, label: string, fallback = "—") => getIdleStageRows(item.stage, item.info, item.now).find(row => row.label === label)?.value ?? fallback;
  const syncedStockCount = market === "zerodha" ? stages.find(item => item.stage === "sync")?.info.portfolioStockCount : undefined;
  return <div className="mt-4 min-w-0 space-y-3 text-sm text-slate-600">
    {view === "ledger" ? <div role="region" aria-label="Saved stage ledger, scroll for all columns" tabIndex={0} className="overflow-x-auto rounded-xl border border-indigo-100 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600">
      <table className="w-full min-w-[790px] border-collapse text-left text-sm">
        <caption className="sr-only">Saved workflow stages. Select a stage to inspect its evidence; execution controls are separate.</caption>
        <thead className="bg-slate-100 text-xs text-slate-700"><tr>{["Stage", "Evidence time", "Completion / inputs", "Stocks", "Duration", "Error"].map(label => <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{stages.map(item => {
          const label = evidenceLabel(item);
          const upcoming = active && (item.info.state === "idle" || item.info.state === "queued");
          const rows = getIdleStageRows(item.stage, item.info, item.now);
          const error = rows.find(row => row.label === "Error");
          const time = rows[0].value;
          const inspecting = selected.stage === item.stage;
          const usesSyncStockCount = market === "zerodha" && item.stage === "sync";
          const stockCell = usesSyncStockCount ? String(syncedStockCount ?? "n/a") : rowValue(item, "Stocks recommended");
          return <tr key={item.stage} className={`border-t border-slate-200 align-top ${getStageLedgerTone(item.info)}`}>
            <th scope="row" className={`px-3 py-2 font-normal ${inspecting ? "bg-blue-100 shadow-[inset_3px_0_0_var(--color-blue-600)] dark:bg-blue-950/65" : ""}`}>
              <div className="flex items-start gap-2">
                {item.selectable ? <input type="checkbox" checked={Boolean(item.selected)} onChange={item.onClick} aria-label={`Select ${getStageTileLabel(item.stage)} for the next run`} className="mt-2 size-4 accent-indigo-700" /> : null}
                <button type="button" className="rounded text-left font-semibold text-slate-900 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" aria-pressed={inspecting} aria-controls={detailId} onClick={() => setSelectedStage(item.stage)}>
                  {STAGE_METADATA[item.stage].step} {getStageTileLabel(item.stage)}
                  <StageStatusIcon info={item.info} />
                  {label && <span className="mt-0.5 block text-xs font-normal text-slate-600">{label}</span>}
                </button>
              </div>
            </th>
            <td className="px-3 py-2 whitespace-nowrap">{upcoming ? null : time}</td>
            <td className="max-w-56 px-3 py-2">{!upcoming && <>{market && ["threats", "swing", "rebalance", "technical", "pairwise"].includes(item.stage) ? <button type="button" data-auto-rebalance-llm-metric="true" data-workflow-stage={item.stage} data-workflow-portfolio={market === "zerodha" ? "india" : "indmoney_us"} data-workflow-total={item.info.totalLlms ?? undefined}
              data-workflow-run-id={item.info.activeRunId ?? item.info.lastRunId ?? undefined}
              data-workflow-job-id={item.info.jobId ?? undefined}
              data-workflow-sequence={item.info.workflowSequence ?? undefined}
              data-workflow-passed={item.info.passedLlms ?? undefined}
              data-workflow-failed={item.info.failedLlms ?? undefined}
              data-workflow-partial={item.info.partialLlms ?? undefined}
              aria-label={`Open ${STAGE_METADATA[item.stage].idle} LLM details`} aria-haspopup="dialog" className="rounded text-indigo-700 underline decoration-dotted underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600">{rowValue(item, "LLMs Used")}</button> : rowValue(item, "LLMs Used", item.stage === "actionables" ? `Rebalance inputs ${rowValue(item, "Rebalance inputs")}` : "—")}{rows.some(row => row.label === "Cost incurred") ? <span className="mt-1 block text-xs text-slate-500">Cost incurred: {rowValue(item, "Cost incurred")}</span> : null}</>}</td>
            <td className="px-3 py-2" title={usesSyncStockCount ? "Holdings count from the latest saved Zerodha portfolio snapshot" : undefined}>{upcoming ? null : stockCell}</td>
            <td className="px-3 py-2 whitespace-nowrap">{upcoming ? null : rows.some(row => row.label === "Duration") ? <button type="button" aria-haspopup="dialog" aria-label={`Show duration breakdown for ${STAGE_METADATA[item.stage].idle}`} className="rounded text-indigo-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" onClick={() => openDuration(item)}>{rowValue(item, "Duration")}</button> : "—"}</td>
            <td className={`max-w-44 px-3 py-2 ${error?.detail ? "text-amber-900" : ""}`}>{upcoming ? null : error?.value}{!upcoming && error?.detail ? <StageErrorDetails stageLabel={STAGE_METADATA[item.stage].idle} info={item.info} row={error} /> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : null}
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
      <div className="mt-3 flex flex-wrap gap-1">{evidenceActions(selected).map(action => "href" in action
        ? <Link key={action.label} className={control} href={action.href}>{action.label}</Link>
        : <button key={action.label} type="button" className={control} onClick={action.onSelect}>{action.label}</button>)}</div>
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
