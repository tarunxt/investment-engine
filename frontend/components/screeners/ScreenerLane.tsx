"use client";

import Link from "next/link";
import { useEffect, useRef, useSyncExternalStore } from "react";
import { captureWorkflowOwner, onWorkflowOwnerInvalidated, type WorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { nativeScreeners, screenerHref, type Strategy } from "@/lib/screenerLibrary";
import { useScreenerLibrary } from "./useScreenerLibrary";

function AssignedTiles({ owner, strategy }: { owner: WorkflowOwner; strategy: Strategy }) {
  const { library, error, reload } = useScreenerLibrary(owner);
  if (error) return <p role="alert" className="my-2 text-xs text-rose-800">Couldn’t load added screeners. <button className="underline" onClick={reload}>Retry</button></p>;
  return library?.assigned?.[strategy]?.filter(id => id !== nativeScreeners[strategy]).map(id => {
    const card = library.screeners.find(item => item.id === id);
    return card && <Link key={id} href={screenerHref(strategy, id)} className="mt-2 block rounded-lg border border-slate-200 bg-slate-50 p-3 hover:border-indigo-300">
      <strong className="text-sm">{card.name}</strong><p className="mt-1 text-xs text-slate-600">{card.summary}</p>
    </Link>;
  });
}

export function ScreenerLane({ strategy }: { strategy: Strategy }) {
  const owner = useSyncExternalStore(onWorkflowOwnerInvalidated, captureWorkflowOwner, () => null);
  const anchor = useRef<HTMLDivElement>(null);
  const id = strategy + "-screeners";
  useEffect(() => {
    if (window.location.hash === "#" + id) anchor.current?.closest("section")?.scrollIntoView({block:"center"});
  }, [id]);
  return <>
    {owner && <AssignedTiles key={owner.generation} owner={owner} strategy={strategy}/>}
    <div ref={anchor} id={id} className="mt-auto scroll-mt-20 pt-3">
      <Link href={screenerHref(strategy)} className="inline-flex rounded-lg border border-indigo-200 bg-white px-3 py-1.5 text-sm font-medium text-indigo-800 hover:bg-indigo-50">Add Screener</Link>
    </div>
  </>;
}
