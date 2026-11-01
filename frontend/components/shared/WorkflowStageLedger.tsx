"use client";

import { useId, useState, type ComponentProps, type ReactElement } from "react";
import { StageDurationBreakdownDialog } from "@/app/console/dashboard/_components/StageDurationBreakdownDialog";
import { StageErrorDetails } from "./StageErrorDetails";
import { getIdleStageRows, getStageTileLabel, STAGE_METADATA, type WorkflowStageTile } from "./WorkflowStageTile";

type Stage = ComponentProps<typeof WorkflowStageTile>;
export type WorkflowLedgerView = "ledger" | "evidence" | "execution";
export function WorkflowStageLedgerViews({ market, view, onChange }: {
  market: "zerodha" | "indmoneyUs";
  view: WorkflowLedgerView;
  onChange: (market: "zerodha" | "indmoneyUs", view: WorkflowLedgerView) => void;
}) {
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
export function WorkflowStageLedger({ children, enabled, view = "ledger", historyHref, onStockFlowClick }: {
  children: ReactElement<Stage>[];
  enabled: boolean;
  view?: WorkflowLedgerView;
  historyHref: string;
  onStockFlowClick: () => void;
}) {
  const [selectedStage, setSelectedStage] = useState("sync");
  const [durationStage, setDurationStage] = useState<Stage | null>(null);
  const detailId = useId();
  if (!enabled) return <div className="mt-8 grid gap-4 sm:grid-cols-2 xl:grid-cols-3">{children}</div>;
  const stages = children.map(child => child.props);
  const selected = stages.find(item => item.stage === selectedStage) ?? stages[0];
  const rowValue = (item: Stage, label: string, fallback = "—") => getIdleStageRows(item.stage, item.info, item.now).find(row => row.label === label)?.value ?? fallback;
  const openDuration = (item: Stage) => {
    setDurationStage(item);
  };
  const partialStages = stages.filter(item => item.info.runStatus === "partial" || (item.info.partialLlms ?? 0) > 0 || item.info.partialNotice);
  return <div className="mt-4 min-w-0 space-y-3 text-sm text-slate-600">
    {view !== "execution" && partialStages.map(item => <p key={item.stage} role="status" className="rounded-lg border border-amber-300 bg-amber-50 px-3 py-2 text-amber-950">
      <strong>{getStageTileLabel(item.stage)} has partial output.</strong>{" "}
      {rowValue(item, "LLMs completed", "Completion unavailable")}. Inspect this stage’s error details before relying on its output.
    </p>)}
    {view === "ledger" ? <div role="region" aria-label="Saved stage ledger, scroll for all columns" tabIndex={0} className="overflow-x-auto rounded-xl border border-indigo-100 bg-white focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600">
      <table className="w-full min-w-[790px] border-collapse text-left text-sm">
        <caption className="sr-only">Saved workflow stages. Select a stage to inspect its evidence; execution controls are separate.</caption>
        <thead className="bg-slate-100 text-xs text-slate-700"><tr>{["Stage", "Saved time", "Completion / inputs", "Stocks", "Duration", "Error"].map(label => <th key={label} scope="col" className="px-3 py-2 font-semibold">{label}</th>)}</tr></thead>
        <tbody>{stages.map(item => {
          const rows = getIdleStageRows(item.stage, item.info, item.now);
          const error = rows.find(row => row.label === "Error")!;
          const time = rows[0].value;
          return <tr key={item.stage} className={`border-t border-slate-200 align-top ${selected.stage === item.stage ? "bg-indigo-50" : ""}`}>
            <th scope="row" className="px-3 py-2 font-normal">
              <div className="flex items-start gap-2">
                {item.selectable ? <input type="checkbox" checked={Boolean(item.selected)} onChange={item.onClick} aria-label={`Select ${getStageTileLabel(item.stage)} for the next run`} className="mt-2 size-4 accent-indigo-700" /> : null}
                <button type="button" className="rounded text-left font-semibold text-slate-900 hover:text-indigo-700 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" aria-pressed={selected.stage === item.stage} aria-controls={detailId} onClick={() => setSelectedStage(item.stage)}>
                  {STAGE_METADATA[item.stage].step} {getStageTileLabel(item.stage)}
                  <span className="mt-0.5 block text-xs font-normal capitalize text-slate-500">{item.info.state}{item.info.runStatus ? ` · ${item.info.runStatus}` : ""}</span>
                </button>
              </div>
            </th>
            <td className="px-3 py-2 whitespace-nowrap">{time}</td>
            <td className="max-w-56 px-3 py-2">{rowValue(item, "LLMs completed", item.stage === "actionables" ? `Rebalance inputs ${rowValue(item, "Rebalance inputs")}` : "—")}{rows.some(row => row.label === "Cost incurred") ? <span className="mt-1 block text-xs text-slate-500">Cost incurred: {rowValue(item, "Cost incurred")}</span> : null}</td>
            <td className="px-3 py-2">{rowValue(item, "Stocks recommended")}</td>
            <td className="px-3 py-2 whitespace-nowrap">{rows.some(row => row.label === "Duration") ? <button type="button" aria-haspopup="dialog" aria-label={`Show duration breakdown for ${STAGE_METADATA[item.stage].idle}`} className="rounded text-indigo-700 underline underline-offset-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-indigo-600" onClick={() => openDuration(item)}>{rowValue(item, "Duration")}</button> : "—"}</td>
            <td className={`max-w-44 px-3 py-2 ${error.detail ? "text-amber-900" : ""}`}>{error.value}{error.detail ? <StageErrorDetails stageLabel={STAGE_METADATA[item.stage].idle} info={item.info} row={error} /> : null}</td>
          </tr>;
        })}</tbody>
      </table>
    </div> : null}
    {view !== "execution" ? <section id={detailId} aria-label="Saved evidence and configuration" className="rounded-xl border border-indigo-100 bg-white p-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h3 className="font-semibold text-slate-900">Saved evidence and configuration · {getStageTileLabel(selected.stage)}</h3>
        {view === "evidence" ? <label className="text-xs">Stage <select aria-label="Stage" value={selected.stage} onChange={event => setSelectedStage(event.target.value)} className="ml-2 rounded border border-indigo-200 bg-white p-2 text-sm text-slate-900">{stages.map(item => <option key={item.stage} value={item.stage}>{STAGE_METADATA[item.stage].step} {getStageTileLabel(item.stage)}</option>)}</select></label> : null}
      </div>
      <p className="mt-1 text-xs">{selected.stage === "sync" ? "Inspect the saved holdings, cash, and exposure snapshot." : STAGE_METADATA[selected.stage].tileDescription}</p>
      <div className="mt-3 flex flex-wrap gap-2">
        {selected.onInputClick ? <button type="button" className={control} onClick={selected.onInputClick}>Inputs</button> : null}
        {selected.onInfoClick ? <button type="button" className={control} onClick={selected.onInfoClick}>Models</button> : null}
        {selected.onPromptClick ? <button type="button" className={control} onClick={selected.onPromptClick}>Prompt</button> : null}
        {selected.onOutputClick ? <button type="button" className={control} onClick={selected.onOutputClick}>Saved output</button> : null}
        {getIdleStageRows(selected.stage, selected.info, selected.now).some(row => row.label === "Duration") ? <button type="button" className={control} aria-haspopup="dialog" onClick={() => openDuration(selected)}>Duration</button> : null}
        {selected.onCalculationsClick ? <button type="button" className={control} onClick={selected.onCalculationsClick}>Calculation</button> : null}
        <button type="button" className={control} onClick={onStockFlowClick}>Stock Flow</button>
        <a className={control} href={historyHref}>History</a>
        {!selected.selectable && selected.onClick ? <button type="button" className={control} onClick={selected.onClick}>Open stage</button> : null}
      </div>
    </section> : null}
    <section aria-label="Sync and order controls" className="rounded-xl border border-slate-300 bg-slate-50 p-3">
      <h3 className="font-semibold text-slate-900">Run and order controls</h3>
      <p className="mt-1 text-xs">Review saved evidence before syncing holdings or placing an order.</p>
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
