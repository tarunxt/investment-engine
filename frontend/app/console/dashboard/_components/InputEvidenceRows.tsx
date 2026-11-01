"use client";

type EvidenceSource = {
  id: string;
  source: string;
  label: string;
  timestamp: string | null;
  status: string;
  error: string | null;
};
type EvidenceProps = {
  candidates: EvidenceSource[];
  selectedIds: Set<string>;
  loading: boolean;
  error: string | null;
};

const sourceName = (source: EvidenceSource) => source.source === "next" ? "Upcoming output" : "Saved snapshot";

export function InputEvidenceSummary({ candidates, selectedIds, loading, error }: EvidenceProps) {
  const selected = candidates.filter(source => selectedIds.has(source.id));
  const missing = [...selectedIds].filter(id => !candidates.some(source => source.id === id));
  return <div role="status" className="min-w-0 break-words text-sm">
    <p className="font-semibold">Included in this run</p>
    <p>{loading ? "Checking selected sources…" : error ? "Selected sources could not be verified. Your choices are retained." : <>
      {selected.length ? selected.map(sourceName).join(" · ") : "No available sources selected"}
      {missing.length ? ` · ${missing.length} selected source${missing.length === 1 ? " is" : "s are"} unavailable` : ""}
    </>}</p>
  </div>;
}

export function InputEvidenceRows({ candidates, selectedIds, loading, error, onToggle, formatTimestamp }: EvidenceProps & {
  onToggle: (id: string) => void;
  formatTimestamp: (value: string) => string;
}) {
  if (loading) return <p role="status" className="p-4 text-sm text-slate-600">Loading evidence sources…</p>;
  if (error) return <p role="alert" className="break-words p-4 text-sm text-red-800">Could not load evidence sources: {error}. Close and reopen the picker to try again. Your choices are retained.</p>;
  return <div className="space-y-2">
    <p className="px-1 text-sm text-slate-600">An upcoming output is a reservation, not an existing result.</p>
    {candidates.map(source => <label key={source.id} className="flex cursor-pointer items-start gap-3 rounded-xl border border-slate-200 bg-white px-4 py-3 focus-within:ring-2 focus-within:ring-slate-600">
      <input type="checkbox" className="mt-1 size-4 shrink-0 accent-slate-900" checked={selectedIds.has(source.id)} onChange={() => onToggle(source.id)} aria-label={`Include ${sourceName(source)}`} />
      <span className="min-w-0 flex-1 break-words text-sm">
        <span className="flex flex-wrap justify-between gap-x-4 gap-y-1"><strong className="text-slate-950">{sourceName(source)}</strong><span className="text-slate-700">{selectedIds.has(source.id) ? "Selected" : "Not selected"}</span></span>
        <span className="block text-slate-600">{source.label}</span>
        <span className="block text-slate-700">{source.source === "next" ? "Reserved — not yet generated" : `Existing snapshot · ${source.status || "Availability unknown"}`}</span>
        <span className="block text-slate-600">Source time: {source.timestamp ? formatTimestamp(source.timestamp) : source.source === "next" ? "Not yet generated" : "Unavailable"}</span>
        {source.error ? <span className="block text-red-800">{source.error}</span> : null}
      </span>
    </label>)}
    {!candidates.some(source => source.source !== "next") ? <p className="px-1 text-sm text-slate-600">Saved snapshot unavailable. No saved source has been added.</p> : null}
    {!candidates.length ? <p className="px-1 text-sm text-slate-600">No eligible sources are available yet.</p> : null}
  </div>;
}
