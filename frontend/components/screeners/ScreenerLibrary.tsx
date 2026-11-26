"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState, useSyncExternalStore } from "react";
import { Check, Plus } from "lucide-react";
import { useAuth } from "@/hooks/useAuth";
import { captureWorkflowOwner, onWorkflowOwnerInvalidated, type WorkflowOwner } from "@/lib/workflowOwnerLifetime";
import { nativeScreen, screenerApi, screenerHref, strategies, type Library, type Screener, type Strategy } from "@/lib/screenerLibrary";
import { useScreenerLibrary } from "./useScreenerLibrary";
import { ScreenerResults } from "./ScreenerResults";

const button = "inline-flex items-center gap-1.5 rounded-lg border border-indigo-200 bg-white px-3 py-2 text-sm font-medium text-indigo-800 hover:bg-indigo-50 disabled:opacity-50";
const active = "inline-flex items-center rounded-lg bg-indigo-700 px-3 py-2 text-sm font-semibold text-white";
const field = "mt-1 block w-full rounded-lg border border-slate-300 bg-white px-3 py-2";
type Draft = Required<Pick<Screener, "name" | "summary" | "query" | "latest_results">>;
type Props = { screen: string; strategy: Strategy };

export function ScreenerLibrary(props: Props) {
  const { user } = useAuth();
  const owner = useSyncExternalStore(onWorkflowOwnerInvalidated, captureWorkflowOwner, () => null);
  if (!owner || owner.id !== user?.id) return <p role="status">Loading your screeners…</p>;
  return <LibraryPage key={owner.generation} {...props} owner={owner}/>;
}

function LibraryPage({ screen, strategy, owner }: Props & { owner: WorkflowOwner }) {
  const router = useRouter();
  const { library, setLibrary, client, error, reload } = useScreenerLibrary(owner);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState("");
  const [notice, setNotice] = useState("");
  const card = library?.screeners.find(item => item.id === screen);
  const boardName = strategies[strategy];
  const back = "/console/zerodha#" + (strategy === "bfs" ? "bfs-screeners" : "og-screeners");
  async function save(change: { existing: string } | { definition: Draft }) {
    if (!library || busy) return;
    setBusy(true);
    setProblem(""); setNotice("");
    try {
      const updated = await client.post<Library>(screenerApi(), { version: library.version, strategy, ...change });
      setLibrary(updated);
      window.dispatchEvent(new Event("screener-library-changed"));
      if ("definition" in change) router.push(screenerHref(strategy, updated.assigned[strategy].at(-1)));
      else setNotice("Screener added to " + boardName + ".");
    } catch (reason) {
      setProblem(String(reason));
      if ((reason as {status?: number})?.status === 409) reload();
    } finally { setBusy(false); }
  }
  function assign(item: Screener) {
    return library?.assigned[strategy].includes(item.id)
      ? <span className="inline-flex items-center gap-1 text-sm font-medium text-emerald-800"><Check size={16}/>Added to {boardName}</span>
      : <button type="button" disabled={busy} className={button} onClick={() => void save({ existing: item.id })}><Plus size={15}/>Add Screener</button>;
  }

  return <main className="mx-auto max-w-5xl space-y-5 p-4 text-slate-900 sm:p-7">
    <Link href={back} className="text-sm font-medium text-indigo-700 hover:underline">Back to {boardName} · Stage 2</Link>
    <div className="flex flex-wrap items-end justify-between gap-4">
      <h1 className="text-3xl font-semibold tracking-tight">{card?.name ?? "Add Screener"}</h1>
      <label className="text-sm font-medium">Stage 2 board
        <select className={field} value={strategy} disabled={busy} onChange={e => router.push(screenerHref(e.target.value as Strategy, screen === "explore" ? "" : screen))}>
          {Object.entries(strategies).map(([id, name]) => <option key={id} value={id}>{name}</option>)}
        </select>
      </label>
    </div>
    <nav className="flex flex-wrap gap-2 border-b pb-3" aria-label="Screener library">
      {([["explore", "Explore Screeners"], ["create", "Create New Screener"]] as const).map(([id, name]) =>
        <Link key={id} href={screenerHref(strategy, id === "explore" ? "" : id)} aria-current={screen === id ? "page" : undefined}
          className={screen === id ? active : button}>{name}</Link>)}
    </nav>
    {(error || problem) && <p role="alert" className="text-sm text-rose-800">{error || problem} {error && <button onClick={reload} className="underline">Retry</button>}</p>}
    {notice && <p role="status" className="rounded-lg bg-emerald-50 p-3 text-emerald-900">{notice}</p>}
    {!library && !error && <p role="status">Loading your screeners…</p>}
    {library && screen === "explore" && <div className="grid gap-4 sm:grid-cols-2">{library.screeners.map(item =>
      <article key={item.id} className="flex flex-col items-start gap-3 rounded-xl border border-slate-200 bg-white p-5">
        <h2 className="text-lg font-semibold"><Link className="hover:text-indigo-700 hover:underline" href={screenerHref(strategy, item.id)}>{item.name}</Link></h2>
        <p className="flex-1 text-sm leading-6 text-slate-600">{item.summary}</p>{assign(item)}
      </article>)}</div>}
    {library && screen === "create" && <CreateForm fields={library.fields} boardName={boardName} busy={busy} onSave={definition => void save({ definition })}/>}
    {card && <section className="space-y-4 rounded-xl border bg-white p-5">
      <p className="text-slate-700">{card.summary}</p>
      {card.query && <div><h2 className="font-semibold">Screening query</h2>
        <pre className="mt-2 whitespace-pre-wrap break-words rounded-lg bg-slate-50 p-4 text-sm">{card.query}</pre>
        {card.latest_results && <p className="mt-2 text-sm">Requires the latest completed quarter’s results.</p>}</div>}
      <div className="flex flex-wrap items-center gap-4">{assign(card)}
        {nativeScreen(card.id) && <Link href={nativeScreen(card.id)!} className={button}>Open {card.name}</Link>}
      </div>
      {card.query && <ScreenerResults key={card.id} id={card.id} client={client}/>}
    </section>}
    {library && !card && screen !== "explore" && screen !== "create" && <p role="alert">This screener is unavailable in your account.</p>}
  </main>;
}

function CreateForm({ fields, boardName, busy, onSave }: { fields: string[]; boardName: string; busy: boolean; onSave: (draft: Draft) => void }) {
  return <form className="max-w-3xl space-y-5 rounded-xl border bg-white p-5" onSubmit={e => {
    e.preventDefault();
    const data = new FormData(e.currentTarget);
    onSave({ name: String(data.get("name")).trim(), summary: String(data.get("summary")).trim(),
      query: String(data.get("query")).trim(), latest_results: data.has("latest") });
  }}>
    <label className="block text-sm font-medium">Screener name<input required maxLength={80} name="name" className={field}/></label>
    <label className="block text-sm font-medium">Short description<input required maxLength={320} name="summary" className={field}/></label>
    <label className="block text-sm font-medium">Screening query<textarea required name="query" maxLength={4000} rows={6} spellCheck={false}
      className={field+" font-mono"} placeholder="Current price > 100 AND Return on capital employed > 15"/></label>
    <details className="text-sm"><summary className="cursor-pointer font-medium text-indigo-700">Supported fields and syntax</summary>
      <p className="mt-2">{fields.join(" · ")}</p><p className="mt-2">Combine numeric comparisons with AND, OR and parentheses. Enter market capitalization in ₹ crore and percentages as whole numbers.</p>
    </details>
    <label className="flex items-center gap-2 text-sm"><input type="checkbox" name="latest"/>Require results for the latest completed quarter</label>
    <button disabled={busy} className={active+" disabled:opacity-50"}>{busy ? "Saving…" : "Save and add to " + boardName}</button>
  </form>;
}
