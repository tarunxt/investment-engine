'use client';

import { useCallback, useEffect, useMemo, useState } from 'react';
import { RankingReadError, readRankingJson as read, type RankingErrorDetails } from '@/lib/sportsRankingsApi';

type RankingRow = { name: string; rank: number | null; points: number | null; imported_names: string[]; rating?: number; nrr?: number; group?: string; record?: string; rank_label?: string; country?: string; played?: number; won?: number; drawn?: number; lost?: number; goal_difference?: number; roster?: string };
type Competition = { id: string; code: string; code_verified?: boolean; name: string; sport: string; sport_id: string; category: string; scope: string; entry_kind: string; reference_url: string; source_id: string | null; status: string; ranking_kind: string; source_url: string | null; source_as_of: string | null; checked_at: string | null; successful_at: string | null; season: string | null; ranked_count: number; note: string; error: string | null; participants: { name: string; aliases: string[] }[]; events: { title: string; slug: string }[] };
type Detail = Competition & { rows: RankingRow[] };
const base = '/backend-api/api/sports-rankings';

function stamp(value: string | null) {
  return value ? new Date(value).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' }) + ' IST' : 'Not yet checked';
}
function Status({ value }: { value: string }) {
  const color = value === 'ready' ? 'bg-emerald-100 text-emerald-900' : value === 'unavailable' ? 'bg-slate-100 text-slate-700' : 'bg-amber-100 text-amber-900';
  return <span className={`rounded-full px-2 py-1 text-xs font-medium ${color}`}>{value}</span>;
}

function fallbackErrorDetails(message: string): RankingErrorDetails {
  return {
    title: 'Rankings request failed', summary: message,
    cause: 'The page received an unexpected error while loading the rankings repository.',
    steps: ['Retry the request.', 'If it repeats, share the time of the failure with support.'],
    status: null, code: 'UNKNOWN_ERROR', endpoint: base, correlationId: null,
    retryAfter: null, proxyBudgetMs: null, occurredAt: new Date().toISOString(), attempts: 1,
    serviceMessage: null,
  };
}

function detailsFor(error: unknown) {
  return error instanceof RankingReadError ? error.details : fallbackErrorDetails(error instanceof Error ? error.message : 'Unable to load rankings.');
}

export default function SportsRankingsPage() {
  const [competitions, setCompetitions] = useState<Competition[]>([]);
  const [selected, setSelected] = useState('epl');
  const [loadedDetail, setDetail] = useState<Detail | null>(null);
  const [query, setQuery] = useState('');
  const [sport, setSport] = useState('All sports');
  const [coverage, setCoverage] = useState('All sources');
  const [group, setGroup] = useState('All groups');
  const [teamQuery, setTeamQuery] = useState('');
  const [importedOnly, setImportedOnly] = useState(false);
  const [error, setError] = useState<RankingErrorDetails | null>(null);
  const [detailError, setDetailError] = useState<RankingErrorDetails | null>(null);
  const [errorDialog, setErrorDialog] = useState<RankingErrorDetails | null>(null);
  const [notice, setNotice] = useState('');
  const [refreshing, setRefreshing] = useState(false);
  const [loading, setLoading] = useState(true);
  const [version, setVersion] = useState(0);
  const reload = useCallback(() => setVersion(v => v + 1), []);

  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const linkedCompetition = params.get('competition');
    const linkedCode = params.get('code');
    if (linkedCompetition) setSelected(linkedCompetition);
    if (linkedCode) setQuery(linkedCode);
  }, []);
  const filtered = useMemo(() => competitions.filter(c =>
    (sport === 'All sports' || c.sport === sport) &&
    (coverage !== 'Connected feeds' || !!c.source_id) &&
    (coverage !== 'Reference only' || !c.source_id) &&
    `${c.code} ${c.name} ${c.sport} ${c.category} ${c.scope} ${c.participants.map(p => [p.name, ...p.aliases].join(' ')).join(' ')}`.toLowerCase().includes(query.toLowerCase())
  ).sort((a, b) => Number(!!b.source_id) - Number(!!a.source_id) || a.sport.localeCompare(b.sport) || a.name.localeCompare(b.name)), [competitions, query, sport, coverage]);
  const activeId = filtered.some(c => c.id === selected) ? selected : filtered[0]?.id;
  const detail = loadedDetail?.id === activeId ? loadedDetail : null;

  useEffect(() => {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout>;
    const load = async () => {
      try {
        const data = await read<{ competitions: Competition[] }>('', controller.signal);
        setCompetitions(data.competitions);
        setError(null);
      } catch (e) {
        if (!controller.signal.aborted) setError(detailsFor(e));
      } finally {
        if (!controller.signal.aborted) { setLoading(false); timer = setTimeout(load, 60000); }
      }
    };
    void load();
    return () => { controller.abort(); clearTimeout(timer); };
  }, [version]);

  useEffect(() => {
    if (!activeId) return;
    const controller = new AbortController();
    read<Detail>('/competitions/' + encodeURIComponent(activeId), controller.signal)
      .then(data => { setDetail(data); setDetailError(null); })
      .catch(e => { if (!controller.signal.aborted) setDetailError(detailsFor(e)); });
    return () => controller.abort();
  }, [activeId, competitions, version]);
  const rows = useMemo(() => (detail?.rows || []).filter(r =>
    (!importedOnly || r.imported_names.length > 0) && (group === 'All groups' || r.group === group) && `${r.name} ${r.country || ''} ${r.imported_names.join(' ')}`.toLowerCase().includes(teamQuery.toLowerCase())
  ), [detail, importedOnly, teamQuery, group]);

  async function refresh() {
    if (!detail?.source_id) return;
    setRefreshing(true); setNotice('');
    try {
      const response = await fetch(base + '/refresh', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ source_id: detail.source_id }) });
      if (!response.ok) { const data = await response.json(); throw new Error(data.detail || 'Unable to queue refresh'); }
      setNotice('Refresh queued. This page checks for results every minute.');
      reload();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Refresh failed.'); }
    finally { setRefreshing(false); }
  }

  async function reconcileCricket() {
    setRefreshing(true); setNotice('');
    try {
      const response = await fetch(base + '/cricket/reconcile', { method: 'POST', signal: AbortSignal.timeout(10000) });
      const data = await response.json();
      if (!response.ok) throw new Error(data.detail || 'Unable to queue cricket reconciliation');
      setNotice(`Reconciliation queued for ${data.sources} cricket sources. Results update here every minute; failed sources retain their last successful rankings.`);
      reload();
    } catch (e) { setNotice(e instanceof Error ? e.message : 'Reconciliation failed.'); }
    finally { setRefreshing(false); }
  }

  return <div className="mx-auto max-w-7xl space-y-6 p-4 text-slate-900 dark:text-slate-100 md:p-8">
    <header className="rounded-2xl bg-slate-950 p-6 text-white">
      <p className="text-xs uppercase tracking-widest text-sky-300">Data & Integrations</p>
      <h1 className="mt-2 text-3xl font-semibold">Sports Rankings</h1>
      <p className="mt-3 max-w-3xl text-sm text-slate-300">Competition and participant repository for Polymarket matching. Supported feeds are checked every 15 minutes; the page updates every minute. Trading analysis is not enabled in this phase.</p>
      <div className="mt-5 flex flex-wrap gap-6 text-sm">
        <span><strong className="text-xl">{!competitions.length && (loading || error) ? '—' : new Set(competitions.map(c => c.sport_id)).size}</strong> sports / disciplines</span>
        <span><strong className="text-xl">{!competitions.length && (loading || error) ? '—' : new Set(competitions.map(c => c.code).filter(Boolean)).size}</strong> Polymarket prefixes</span>
        <span><strong className="text-xl">{!competitions.length && (loading || error) ? '—' : competitions.length}</strong> ranking / competition lists</span>
        <span><strong className="text-xl">{!competitions.length && (loading || error) ? '—' : new Set(competitions.flatMap(c => c.source_id ? [c.source_id] : [])).size}</strong> connected feeds</span>
        <span><strong className="text-xl">{!competitions.length && (loading || error) ? '—' : new Set(competitions.filter(c => c.status === 'ready').map(c => c.source_id)).size}</strong> feeds ready</span>
      </div>
    </header>
    {(error || detailError) && (() => { const issue = (error || detailError)!; return <div role="alert" className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-red-300 bg-red-50 p-4 text-red-900 dark:border-red-800 dark:bg-red-950/40 dark:text-red-100"><button type="button" aria-haspopup="dialog" className="text-left underline decoration-dotted underline-offset-4" onClick={() => setErrorDialog(issue)}>{issue.summary} {competitions.length > 0 && 'Last loaded data remains visible.'} <span className="font-semibold">View details</span></button><button className="rounded-md border border-red-400 px-3 py-1.5 font-semibold hover:bg-red-100 dark:hover:bg-red-900" onClick={reload}>Retry now</button></div>; })()}
    {errorDialog && <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-950/60 p-4" onMouseDown={event => { if (event.currentTarget === event.target) setErrorDialog(null); }}>
      <section role="dialog" aria-modal="true" aria-labelledby="rankings-error-title" className="max-h-[90vh] w-full max-w-2xl overflow-y-auto rounded-2xl bg-white p-6 text-slate-900 shadow-2xl dark:bg-slate-900 dark:text-slate-100">
        <div className="flex items-start justify-between gap-4"><div><p className="text-xs font-bold uppercase tracking-widest text-red-600 dark:text-red-300">Sports Rankings diagnostic</p><h2 id="rankings-error-title" className="mt-1 text-2xl font-semibold">{errorDialog.title}</h2></div><button autoFocus aria-label="Close error details" className="rounded-lg border px-3 py-1.5" onClick={() => setErrorDialog(null)}>Close</button></div>
        <div className="mt-5 space-y-5 text-sm">
          <div><h3 className="font-semibold">What happened</h3><p className="mt-1 text-slate-700 dark:text-slate-300">{errorDialog.cause}</p>{errorDialog.serviceMessage && <p className="mt-2 rounded-lg bg-slate-100 p-3 font-mono text-xs dark:bg-slate-800">Service response: {errorDialog.serviceMessage}</p>}</div>
          <div><h3 className="font-semibold">How to fix it</h3><ol className="mt-2 list-decimal space-y-2 pl-5 text-slate-700 dark:text-slate-300">{errorDialog.steps.map(step => <li key={step}>{step}</li>)}</ol></div>
          <div><h3 className="font-semibold">Technical details</h3><dl className="mt-2 grid gap-x-4 gap-y-2 rounded-lg bg-slate-100 p-4 text-xs dark:bg-slate-800 sm:grid-cols-[150px_1fr]"><dt>Status</dt><dd>{errorDialog.status ?? 'No HTTP response'}</dd><dt>Error code</dt><dd className="font-mono">{errorDialog.code}</dd><dt>Endpoint</dt><dd className="break-all font-mono">{errorDialog.endpoint}</dd><dt>Attempts</dt><dd>{errorDialog.attempts}</dd>{errorDialog.proxyBudgetMs && <><dt>Proxy deadline</dt><dd>{(errorDialog.proxyBudgetMs / 1000).toFixed(1)} seconds</dd></>}{errorDialog.retryAfter && <><dt>Retry-After</dt><dd>{errorDialog.retryAfter} seconds</dd></>}<dt>Occurred</dt><dd>{new Date(errorDialog.occurredAt).toLocaleString()}</dd><dt>Correlation ID</dt><dd className="break-all font-mono">{errorDialog.correlationId || 'Not available (request did not reach the proxy)'}</dd></dl></div>
        </div>
        <div className="mt-6 flex justify-end gap-3"><button className="rounded-lg border px-4 py-2" onClick={() => setErrorDialog(null)}>Cancel</button><button className="rounded-lg bg-red-700 px-4 py-2 font-semibold text-white hover:bg-red-800" onClick={() => { setErrorDialog(null); reload(); }}>Retry now</button></div>
      </section>
    </div>}
    {notice && <p role="status" className="rounded-lg border p-3 text-sm">{notice}</p>}
    {filtered.some(c => c.category === 'Cricket') && <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border p-4 text-sm"><p>Cricket sources are checked every 15 minutes, with a full reconciliation daily at 08:40 IST. You can also request one now.</p><button disabled={refreshing} onClick={reconcileCricket} className="rounded border px-3 py-2 disabled:opacity-50">{refreshing ? 'Queuing…' : 'Reconcile all cricket now'}</button></div>}
    <div className="grid gap-6 lg:grid-cols-[320px_minmax(0,1fr)]">
      <aside className="space-y-3 rounded-xl border border-slate-200 bg-white p-4 dark:border-slate-700 dark:bg-slate-900">
        <label className="block text-sm font-medium" htmlFor="competition-search">Find competition or participant</label>
        <input id="competition-search" className="w-full rounded-lg border bg-transparent p-2" placeholder="hockey, badminton, argpn, team…" value={query} onChange={e => { setQuery(e.target.value); setTeamQuery(''); setGroup('All groups'); setImportedOnly(false); }} />
        <select aria-label="Filter by sport" className="w-full rounded-lg border bg-transparent p-2" value={sport} onChange={e => { setSport(e.target.value); setGroup('All groups'); setTeamQuery(''); setImportedOnly(false); }}>
          {['All sports', ...Array.from(new Set(competitions.map(c => c.sport))).sort()].map(s => <option key={s}>{s}</option>)}
        </select>
        <select aria-label="Filter by ranking availability" className="w-full rounded-lg border bg-transparent p-2" value={coverage} onChange={e => setCoverage(e.target.value)}>{['All sources', 'Connected feeds', 'Reference only'].map(s => <option key={s}>{s}</option>)}</select>
        <p className="text-xs text-slate-500">{loading ? 'Loading repository…' : `${filtered.length} ranking / competition lists`}</p>
        <div className="max-h-[650px] space-y-1 overflow-y-auto">
          {filtered.map(c => <button key={c.id} aria-pressed={activeId === c.id} onClick={() => { setSelected(c.id); setTeamQuery(''); setGroup('All groups'); setImportedOnly(false); setNotice(''); }} className={`w-full rounded-lg p-3 text-left ${activeId === c.id ? 'bg-blue-50 ring-1 ring-blue-400 dark:bg-blue-950' : 'hover:bg-slate-50 dark:hover:bg-slate-800'}`}>
            <div className="flex items-center justify-between gap-2"><code className="text-xs text-blue-600 dark:text-blue-300">{c.code || 'No verified code'}</code><Status value={c.status} /></div>
            <p className="mt-2 text-sm font-medium">{c.name}</p><p className="mt-1 text-xs text-slate-500">{c.sport} · {c.ranked_count} published rows{c.participants.length ? ` · ${c.participants.length} imported names` : ''}</p>
          </button>)}
          {!loading && !filtered.length && <p className="p-3 text-sm">{error && !competitions.length ? 'The repository could not be loaded yet.' : 'No matching competitions.'}</p>}
        </div>
      </aside>
      <section className="min-w-0 space-y-4 rounded-xl border border-slate-200 bg-white p-5 dark:border-slate-700 dark:bg-slate-900">
        {!activeId ? <p>{loading ? 'Loading repository…' : error && !competitions.length ? 'Waiting for the rankings service to recover. This page retries automatically.' : 'No ranking lists match your filters.'}</p> : !detail ? <p>{detailError?.summary || 'Loading rankings…'}</p> : <>
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div><p className="text-xs text-slate-500">{detail.category} · {detail.sport} · <code>{detail.code || 'No verified Polymarket code'}</code></p><h2 className="mt-1 text-xl font-semibold">{detail.name}</h2><p className="mt-1 text-sm">{detail.ranking_kind} {detail.season && `· ${detail.season}`}</p></div>
            <Status value={detail.status} />
          </div>
          <p className="rounded-lg bg-slate-50 p-3 text-sm dark:bg-slate-800">{detail.note}</p>
          <p className="text-sm">{detail.scope}</p>
          <p className="text-xs text-slate-500">{detail.code_verified ? 'Competition code verified from the Polymarket registry or observed parent-event URLs. ' : detail.code ? 'Code inferred from imported event URLs. ' : 'Internal sport IDs are not Polymarket codes. '}{detail.entry_kind === 'imported_competition' ? 'Imported participants are not verified current-season members. ' : ''}Gender, age, format and ranking groups must match the event before comparing participants.</p>
          <div className="flex flex-wrap gap-4 text-sm">
            <a className="text-blue-600 underline dark:text-blue-300" href={detail.reference_url} target="_blank" rel="noreferrer">Reference page</a>
            {detail.source_url && <a className="text-blue-600 underline dark:text-blue-300" href={detail.source_url} target="_blank" rel="noreferrer">Published dataset</a>}
            {detail.source_id && <button disabled={refreshing} className="rounded border px-3 py-1 disabled:opacity-50" onClick={refresh}>{refreshing ? 'Queuing…' : 'Refresh source'}</button>}
          </div>
          <div className="text-xs text-slate-500"><p>Source date / latest completed match: {detail.source_as_of || 'Not supplied by publisher'}</p><p>Last check: {stamp(detail.checked_at)}</p><p>Last successful retrieval: {stamp(detail.successful_at)}</p></div>
          {detail.error && <p role="alert" className="text-sm text-amber-700 dark:text-amber-300">Refresh failed: {detail.error}. Any displayed rankings are from the last successful retrieval.</p>}
          {detail.status === 'stale' && <p className="text-sm text-amber-700 dark:text-amber-300">This feed has not been checked within an hour. Displayed data may be stale.</p>}
          <div className="flex flex-wrap items-center gap-3"><input aria-label="Search teams or players" className="min-w-0 flex-1 rounded-lg border bg-transparent p-2" placeholder="Search teams or players" value={teamQuery} onChange={e => setTeamQuery(e.target.value)} /><label className="text-sm"><input type="checkbox" checked={importedOnly} onChange={e => setImportedOnly(e.target.checked)} /> Imported participants only</label></div>
          {detail.rows.some(r => r.group) && <select aria-label="Filter by ranking group" className="w-full rounded-lg border bg-transparent p-2" value={group} onChange={e => setGroup(e.target.value)}>{['All groups', ...Array.from(new Set(detail.rows.map(r => r.group).filter((g): g is string => !!g)))].map(g => <option key={g}>{g}</option>)}</select>}
          <p className="text-xs text-slate-500">{rows.length} rows · “—” means no matched ranking, not rank zero.</p>
          <div className="max-h-[550px] overflow-auto"><table className="w-full text-left text-sm">
            <thead className="sticky top-0 bg-slate-100 dark:bg-slate-800"><tr>{['Rank / order', 'Team / player', 'Group', 'Rating', 'Points', ...(detail.category === 'Cricket' ? ['NRR'] : []), 'Record / played', 'Imported name'].map(h => <th className="whitespace-nowrap p-3" key={h}>{h}</th>)}</tr></thead>
            <tbody>{rows.map((r, i) => <tr key={`${r.name}-${i}`} className="border-b border-slate-100 dark:border-slate-800"><td className="p-3">{r.rank_label || r.rank || '—'}</td><td className="p-3 font-medium">{r.name}{r.roster && <p className="text-xs font-normal text-slate-500">{r.roster}</p>}</td><td className="p-3 text-xs">{r.group || '—'}</td><td className="p-3">{r.rating ?? '—'}</td><td className="p-3">{r.points ?? '—'}</td>{detail.category === 'Cricket' && <td className="p-3">{r.nrr ?? '—'}</td>}<td className="p-3">{r.record || (r.played ?? '—')}</td><td className="p-3 text-xs">{r.imported_names.join(', ') || '—'}</td></tr>)}</tbody>
          </table>{!rows.length && <p className="p-6 text-sm">{detail.source_id ? 'No matching published rows yet. Check the source status above.' : 'Numeric rankings are not available here for this scope. The source link and ranking guidance above are available.'}</p>}</div>
          <details className="text-xs"><summary className="cursor-pointer">Imported events ({detail.events.length})</summary><ul className="mt-2 space-y-2">{detail.events.map((e, i) => <li key={i}><a className="underline" href={`https://polymarket.com/event/${e.slug}`} target="_blank" rel="noreferrer">{e.title}</a><p className="break-all text-slate-500">{e.slug}</p></li>)}</ul></details>
        </>}
      </section>
    </div>
    <details className="rounded-xl border p-4 text-sm"><summary className="cursor-pointer font-semibold">Full-match head-to-head classification rules</summary><p className="mt-3">Require exactly two distinct opposing participants and a winner, win/loss, moneyline or match-result market for that full match. Yes/No outcomes are not participant names. Exclude sets, maps, periods, innings, halves, scores, spreads, handicaps, totals, player statistics and tournament winners.</p><p className="mt-2">Ordinary races, battle royale events and multi-player golf tournaments are excluded. Their explicit head-to-head or match-play markets may qualify. This repository does not enable trading or change the Bullpen scanner.</p></details>
  </div>;
}
