'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';
import {allowedModule,moduleScopeKey,type ModuleCollection} from '@/lib/modulePolicy';
import {admitCombinedHistory,combinedSegments,type CombinedHistory} from '@/lib/conceptFCombinedHistory';
import {historySegments} from '@/lib/indmoneyHistory';

/** Mounted only after deliberate Combined selection; GETs cannot acquire data. */
export function ConceptFCombinedHistory({manifest,masked}:{manifest:ModuleCollection;masked:boolean}){
 const {data:session,status}=useSession(),owner=Number(session?.user?.id);
 const enabled=status==='authenticated'&&Number.isSafeInteger(owner)&&owner>0&&manifest.owner_id===owner&&allowedModule(manifest,'zerodha_rebalance')&&allowedModule(manifest,'indmoney_us');
 const [revision,setRevision]=useState(0),[record,setRecord]=useState<{key:string;value:CombinedHistory}|null>(null),[errorKey,setErrorKey]=useState<string|null>(null);
 const key=owner+':'+String(session?.generation??'')+':'+moduleScopeKey(manifest)+':'+revision;
 useEffect(()=>{const abort=new AbortController();if(!enabled)return()=>abort.abort();
  void apiService.fetch('/backend-api/uat2/simulation/combined-history',{signal:abort.signal,cache:'no-store',timeoutMs:8000}).then(value=>{const admitted=admitCombinedHistory(value,owner,manifest.version);if(!abort.signal.aborted)setRecord({key,value:admitted});}).catch(()=>{if(!abort.signal.aborted)setErrorKey(key);});return()=>abort.abort();
 },[key,enabled,owner,manifest.version]);
 const value=record?.key===key&&enabled?record.value:null,failed=errorKey===key,rows=value?.points??[],known=rows.filter(row=>row.known),loading=enabled&&!value&&!failed;
 const first=rows.length?Date.parse(rows[0].captured_at):0,last=rows.length?Date.parse(rows.at(-1)!.captured_at):0;
 const min=known.length?Math.min(...known.map(row=>row.value!)):0,max=known.length?Math.max(...known.map(row=>row.value!)):0;
 const x=(p:typeof rows[number])=>10+(Date.parse(p.captured_at)-first)/(last-first||1)*680;
 const y=(p:typeof rows[number])=>180-(p.value!-min)/(max-min||1)*150;
 return <section className="concept-f-card min-w-0 space-y-4" aria-label="Combined recorded holdings history">
  <h2>Combined recorded holdings history</h2>
  <p>Exactly coeval owned INR and USD observations with dated persisted FX. Recorded holdings only—not cash, returns, live balances or complete investment performance. Missing instants remain gaps; no current rate or balance is carried backward.</p>
  {!enabled?<p role="status">Both owned, selected and available portfolio modules are required. No combined-history request is made.</p>:failed?<p role="alert">Combined recorded history could not be verified. No empty, zero or complete-history result is inferred.</p>:loading?<p role="status">Reading owned sources and persisted historical FX…</p>:value&&<>
   <p role="status">{known.length} verified coeval observations in this bounded response; history is incomplete.</p>
   {(value.has_more.india||value.has_more.us||value.has_more.fx)&&<p>Source or rate bounds were reached. Older coverage is not complete; no omitted data is filled in.</p>}
   {(value.rejected_sources.india>0||value.rejected_sources.us>0)&&<p>Excluded unverified source records: India {value.rejected_sources.india}, US {value.rejected_sources.us}. No replacement observation is inferred.</p>}
   {!value.continuity_verified&&<p>Excluded or bounded records leave continuity unverified. Verified observations are shown separately; connecting lines are suppressed.</p>}
   {masked?<p>Combined chart and values are masked by your display preference.</p>:known.length>=2?<figure><svg viewBox="0 0 700 210" role="img" aria-label={'INR combined recorded holdings; '+rows.length+' instants; gaps retained'} className="w-full">{combinedSegments(value,historySegments).map((segment,i)=><path key={i} d={segment.map((p,j)=>`${j?'L':'M'} ${x(p)} ${y(p)}`).join(' ')} fill="none" stroke="#078778" strokeWidth="3"/>)}{known.map((p,i)=><circle key={i} cx={x(p)} cy={y(p)} r="3" fill="#078778"/>)}</svg><figcaption>Capture times in UTC; gaps are not interpolated.</figcaption></figure>:<p>A chart requires at least two verified coeval observations. A single point or unavailable coverage is not a performance trend.</p>}
   {!rows.length?<p>No admitted observations were returned in this bounded response. This does not establish an empty portfolio or complete history.</p>:<div className="overflow-x-auto"><table className="concept-f-table"><thead><tr><th>Captured instant</th><th>Recorded INR holding value</th><th>Coverage and provenance</th></tr></thead><tbody>{rows.map(p=><tr key={p.captured_at}><th><time dateTime={p.captured_at}>{p.captured_at}</time></th><td>{!p.known?'Unavailable':masked?'Masked':new Intl.NumberFormat(undefined,{style:'currency',currency:'INR'}).format(p.value!)}</td><td>{p.reasons.length?<p>{p.reasons.map(reason=>reason.replaceAll('_',' ')).join('; ')}</p>:<p>Exact coeval source pair · dated persisted FX</p>}<details><summary className="min-h-11 cursor-pointer">Inspect point provenance</summary><div className="max-w-md break-all space-y-2">{p.india?<p>India receipt {p.india.id} · hash {p.india.source_hash} · recorded INR {masked?'Masked':p.india.value_exact??'Unavailable'}</p>:<p>No unambiguous India source at this instant.</p>}{p.us?<p>US snapshot {p.us.id} · source hash {p.us.source_hash} · content hash {p.us.content_hash} · correction parent {p.us.supersedes_id??'none'} · recorded USD {masked?'Masked':p.us.value_exact??'Unavailable'}</p>:<p>No unambiguous accepted US source at this instant.</p>}{p.fx?<p>Persisted FX record {p.fx.id} · {p.fx.pair} {p.fx.rate} · source {p.fx.source} · as of {p.fx.as_of} · fetched {p.fx.fetched_at}</p>:<p>No unique admitted dated FX record.</p>}<p>No current research readiness, funding or order consent follows from this historical observation.</p></div></details></td></tr>)}</tbody></table></div>}
  </>}
  {enabled&&<button type="button" className="concept-f-secondary" disabled={loading} onClick={()=>setRevision(n=>n+1)}>Review combined history</button>}
 </section>;
}
