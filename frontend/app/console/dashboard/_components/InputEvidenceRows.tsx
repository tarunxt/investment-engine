"use client";

import { Fragment, useId, useRef, useState } from "react";

type EvidenceSource = {
  id: string;
  source: string;
  label: string;
  jobNo: string;
  timestamp: string | null;
  status: string;
  error: string | null;
  costUsd: number | null;
  market?: "india" | "us";
};
type EvidenceProps = {
  candidates: EvidenceSource[];
  selectedIds: Set<string>;
  loading: boolean;
  error: string | null;
};

const sourceName = (source: EvidenceSource) => source.source === "next" ? "Upcoming output" : "Saved snapshot";
const marketName = (source: EvidenceSource) => source.market === "india" ? "INDIA" : source.market === "us" ? "US" : "Market unknown";

export function InputEvidenceSummary({ candidates, selectedIds, loading, error }: EvidenceProps) {
  const selected = candidates.filter(source => selectedIds.has(source.id));
  const missing = [...selectedIds].filter(id => !candidates.some(source => source.id === id));
  return <div role="status" className="min-w-0 break-words text-sm">
    <p className="font-semibold">Included in this run</p>
    <p>{loading ? "Checking selected sources…" : error ? "Selected sources could not be verified. Your choices are retained." : <>
      {selected.length ? `${selected.map(sourceName).join(" · ")} · ${selected.length} source${selected.length === 1 ? "" : "s"}` : "No available sources selected"}
      {missing.length ? ` · ${missing.length} selected source${missing.length === 1 ? " is" : "s are"} unavailable` : ""}
    </>}</p>
  </div>;
}

export function InputEvidenceRows({ candidates, selectedIds, loading, error, onToggle, formatTimestamp, formatCost }: EvidenceProps & {
  onToggle: (id: string) => void;
  formatTimestamp: (value: string) => string;
  formatCost: (value: number) => string;
}) {
  const [view, setView] = useState<"sources" | "included">("sources");
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const id = useId();
  const tabRefs = useRef<(HTMLButtonElement | null)[]>([]);
  const timestamp = (source: EvidenceSource) => source.timestamp ? formatTimestamp(source.timestamp) : source.source === "next" ? "Reserved for next output — not yet generated" : "Source time unavailable";
  const cost = (source: EvidenceSource) => typeof source.costUsd === "number" ? formatCost(source.costUsd) : "n/a";
  const toggleExpanded = (source: EvidenceSource) => setExpanded(current => {
    const next = new Set(current);
    if (next.has(source.id)) next.delete(source.id); else next.add(source.id);
    return next;
  });
  const renderTable = (sources: EvidenceSource[], caption: string) => <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white" tabIndex={0} role="region" aria-label={`${caption} source table`}>
    <table className="w-full min-w-[700px] text-left text-sm">
      <caption className="sr-only">{caption}</caption>
      <thead className="bg-slate-100 text-xs font-semibold text-slate-600"><tr>{["Input", "Selected", "Timestamp / reservation", "State", "Cost"].map(label => <th key={label} scope="col" className="px-3 py-2">{label}</th>)}</tr></thead>
      <tbody className="divide-y divide-slate-200">{sources.map(source => <Fragment key={source.id}>
        <tr className="align-top">
          <th scope="row" className="px-3 py-3 font-normal">
            <button type="button" className="inline-flex items-center gap-2 rounded px-1 py-1 text-left font-semibold text-slate-950 focus-visible:outline-2 focus-visible:outline-purple-600" aria-expanded={expanded.has(source.id)} aria-controls={`${id}-${source.id}-details`} aria-label={`${expanded.has(source.id) ? "Collapse" : "Expand"} ${source.jobNo}`} onClick={() => toggleExpanded(source)}><span aria-hidden="true">{expanded.has(source.id) ? "▾" : "▸"}</span>{sourceName(source)}</button>
            <span className="block pl-5 text-xs text-slate-500">{marketName(source)}</span>
          </th>
          <td className="px-3 py-3"><label className="flex items-start gap-2"><input type="checkbox" className="mt-1 size-4 accent-purple-700" checked={selectedIds.has(source.id)} onChange={() => onToggle(source.id)} aria-label={`Include ${sourceName(source)}`} /><span>{selectedIds.has(source.id) ? "1 / 1 selected" : "0 / 1 selected"}</span></label></td>
          <td className="max-w-64 px-3 py-3 text-slate-600">{timestamp(source)}</td>
          <td className="px-3 py-3 text-slate-700"><span className="capitalize">{source.source === "next" ? "Reserved" : source.status || "Availability unknown"}</span>{source.source !== "next" ? <span className="block text-xs text-slate-500">Existing snapshot</span> : null}{source.error ? <span className="mt-1 block max-w-48 text-xs text-red-800">{source.error}</span> : null}</td>
          <td className="whitespace-nowrap px-3 py-3 text-slate-600">{cost(source)}</td>
        </tr>
        {expanded.has(source.id) ? <tr id={`${id}-${source.id}-details`}><td colSpan={5} className="bg-slate-50 px-3 py-2">
          <table className="w-full min-w-[760px] text-left text-sm"><caption className="sr-only">{sourceName(source)} details</caption>
            <thead className="text-xs font-semibold text-slate-500"><tr>{["Select", "Job", "Timestamp", "Status", "Market", "LLM / Source", "Cost (INR)", "Error"].map(label => <th key={label} scope="col" className="px-2 py-2">{label}</th>)}</tr></thead>
            <tbody><tr className="align-top text-slate-700"><td className="px-2 py-2"><input type="checkbox" checked={selectedIds.has(source.id)} onChange={() => onToggle(source.id)} aria-label={`Select ${source.label}`} /></td><td className="px-2 py-2">{source.jobNo}</td><td className="px-2 py-2">{timestamp(source)}</td><td className="px-2 py-2">{source.status}</td><td className="px-2 py-2">{marketName(source)}</td><td className="px-2 py-2">{source.label}</td><td className="px-2 py-2">{cost(source)}</td><td className="px-2 py-2 text-xs text-red-800">{source.error || "—"}</td></tr></tbody>
          </table>
        </td></tr> : null}
      </Fragment>)}</tbody>
    </table>
  </div>;
  const selected = candidates.filter(source => selectedIds.has(source.id));
  const excluded = candidates.filter(source => !selectedIds.has(source.id));
  return <div className="space-y-3">
    <div role="tablist" aria-label="Evidence views" className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap">
      {([['sources', 'Select sources'], ['included', 'Included evidence']] as const).map(([key, label], index) => <button key={key} ref={element => { tabRefs.current[index] = element; }} type="button" role="tab" id={`${id}-${key}-tab`} aria-controls={`${id}-panel`} aria-selected={view === key} tabIndex={view === key ? 0 : -1} onClick={() => setView(key)} onKeyDown={event => {
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
        event.preventDefault(); const next = event.key === "Home" ? 0 : event.key === "End" ? 1 : 1 - index;
        setView(next === 0 ? "sources" : "included"); tabRefs.current[next]?.focus();
      }} className={view === key ? "rounded-lg bg-purple-700 px-2 py-2 text-xs font-semibold sm:px-4 sm:text-sm text-white focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-purple-700" : "rounded-lg bg-purple-100 px-2 py-2 text-xs font-semibold sm:px-4 sm:text-sm text-purple-800 focus-visible:outline-2 focus-visible:outline-purple-700"}>{label}</button>)}
    </div>
    <div role="tabpanel" id={`${id}-panel`} aria-labelledby={`${id}-${view}-tab`} className="space-y-3">
      {loading ? <p className="p-3 text-sm text-slate-600">Loading evidence sources…</p> : error ? <p role="alert" className="break-words p-3 text-sm text-red-800">Could not load evidence sources: {error}. Close and reopen the picker to try again. Your choices are retained.</p> : <>
        <p className="text-sm text-slate-600">An upcoming output is a reservation, not an existing result.</p>
        {view === "sources" ? renderTable(candidates, "Select sources") : <>
          <button type="button" onClick={() => { setView("sources"); tabRefs.current[0]?.focus(); }} className="rounded px-1 text-sm font-semibold text-purple-800 underline focus-visible:outline-2">Return to Select sources</button>
          <section aria-label="Included"><h4 className="mb-2 text-sm font-semibold text-slate-950">Included</h4>{selected.length ? renderTable(selected, "Included") : <p className="text-sm text-slate-600">No available sources selected.</p>}</section>
          <section aria-label="Not included"><h4 className="mb-2 text-sm font-semibold text-slate-950">Not included</h4>{excluded.length ? renderTable(excluded, "Not included") : <p className="text-sm text-slate-600">No available sources excluded.</p>}</section>
        </>}
        {!candidates.some(source => source.source !== "next") ? <p className="text-sm text-slate-600">Saved snapshot unavailable. No saved source has been added.</p> : null}
        {!candidates.length ? <p className="text-sm text-slate-600">No eligible sources are available yet.</p> : null}
      </>}
    </div>
  </div>;
}
