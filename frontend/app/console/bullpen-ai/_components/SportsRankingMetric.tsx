"use client";

import { useRef } from "react";
import type { BullpenSportsRankingComparison } from "@/types/api";

const number = (value: number | null | undefined) => value == null ? "—" : value.toLocaleString(undefined, { maximumFractionDigits: 2 });

export function SportsRankingMetric({ comparison, metricKey, title }: {
  comparison?: BullpenSportsRankingComparison | null;
  metricKey: "ranking" | "rating" | "points";
  title?: string | null;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const metric = comparison?.[metricKey];
  const teams = title?.split(/\s+(?:vs\.?|v\.?|@)\s+/i);
  const status = comparison?.status_code ?? "PENDING";
  return <>
    <button type="button" className="block w-full text-left text-[11px] leading-5" onClick={() => dialog.current?.showModal()}
      aria-label={`Ranking details: ${title ?? "event"} (${status})`} title={comparison?.explanation ?? "Waiting for the ranking service"}>
      <span className="block truncate"><strong>A · {comparison?.team_a ?? teams?.[0] ?? "Team A"}</strong>: {number(metric?.team_a)}</span>
      <span className="block truncate"><strong>B · {comparison?.team_b ?? teams?.[1] ?? "Team B"}</strong>: {number(metric?.team_b)}</span>
      <span className="block font-bold">Δ A−B: {number(metric?.delta)}</span>
      {metricKey === "ranking" && <span className={`block underline decoration-dotted ${status === "VALID" ? "text-sky-700" : "text-amber-700"}`}>
        {status === "VALID" ? "Current · source details" : status === "NOT_COMPARABLE" ? "Different ranking scopes · details" : `${status.replaceAll("_", " ").toLowerCase()} · details`}
      </span>}
    </button>
    <dialog ref={dialog} className="m-auto max-h-[85vh] w-[min(90vw,760px)] overflow-y-auto rounded-xl border border-slate-300 bg-white p-6 text-sm text-slate-900 shadow-xl backdrop:bg-black/40">
      <form method="dialog"><button className="float-right rounded border px-3 py-1" aria-label="Close ranking details">Close</button></form>
      <h2 className="mb-3 text-lg font-bold">Ranking details</h2>
      <p className="font-semibold">{title}</p>
      <p className="my-3">{comparison?.explanation ?? "The ranking service has not returned this event yet. Refresh to retry."}</p>
      <p className="mb-4 text-xs">Current reference data, retrieved {comparison?.generated_at ?? "pending"}. This view is not the ranking frozen at the original scan. Rating means points efficiency, not win probability. A zero is a published value; a dash is unavailable or not comparable.</p>
      {Object.entries(comparison?.team_details ?? {}).map(([side, detail]) => <section key={side} className="my-3 rounded border p-3">
        <h3 className="font-bold">{side.toUpperCase()} · {detail.raw_name}</h3>
        <p>{detail.status_code.replaceAll("_", " ")} — {detail.remedy}</p>
        {detail.selected && <dl className="mt-2 grid grid-cols-[110px_1fr] gap-1 break-words text-xs">
          <dt>Matched team</dt><dd>{detail.selected.name} ({detail.selected.canonical_id})</dd>
          <dt>Competition</dt><dd>{detail.selected.competition}</dd>
          <dt>Season / group</dt><dd>{detail.selected.season ?? "Not supplied"} / {detail.selected.group ?? "Overall"}</dd>
          <dt>Ranking type</dt><dd>{detail.selected.ranking_kind}</dd>
          <dt>Source</dt><dd>{detail.selected.source_url ? <a className="text-blue-700 underline" href={detail.selected.source_url} target="_blank" rel="noreferrer">{detail.selected.source_id}</a> : detail.selected.source_id}</dd>
          <dt>Last success</dt><dd>{detail.selected.successful_at ?? "Not supplied"} ({detail.selected.source_status})</dd>
          <dt>Snapshot hash</dt><dd className="break-all">{detail.selected.snapshot_hash ?? "Not supplied"}</dd>
        </dl>}
        {!detail.selected && detail.candidates.length > 0 && <ul className="mt-2 list-inside list-disc text-xs">{detail.candidates.map((c, i) => <li key={i}>{c.name} · {c.source_id} · {c.season} · {c.group}</li>)}</ul>}
      </section>)}
      {comparison?.source_diagnostics?.map((source, i) => <p key={i} className="my-2 break-words text-xs">{source.source_id}: {source.status}; {source.published_rows} published rows. {source.error}</p>)}
      <p className="mt-4 text-xs text-slate-500">Resolver: {comparison?.resolution_version ?? "pending"} · {status}</p>
    </dialog>
  </>;
}
