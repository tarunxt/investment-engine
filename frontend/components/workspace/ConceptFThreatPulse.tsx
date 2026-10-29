'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import Link from 'next/link';
import {apiService} from '@/services/api';
import {allowedModule,moduleScopeKey,type ModuleCollection} from '@/lib/modulePolicy';
import {admitThreatIndex,type ThreatMeta} from '@/lib/conceptFSavedThreats';
import {ConceptFThreatSummary} from './ConceptFThreatSummary';
type PulseRow={portfolio:'india'|'indmoney_us';loaded:number|null;hasMore:boolean;items:ThreatMeta[]};
/** Mounted only in the deliberately opened advanced overview. Historical
 * metadata counts never become current-risk flags or a new report request. */
export function ConceptFThreatPulse({manifest,embedded=false}:{manifest:ModuleCollection;embedded?:boolean}){
 const {data:session,status}=useSession(),owner=Number(session?.user?.id);
 const authorized=status==='authenticated'&&Number.isSafeInteger(owner)&&owner>0&&manifest.owner_id===owner;
 const portfolios=(['india','indmoney_us'] as const).filter(portfolio=>allowedModule(manifest,portfolio==='india'?'zerodha_rebalance':'indmoney_us'));
 const portfolioKey=portfolios.join(',');
 const [retry,setRetry]=useState(0);
 const key=retry+':'+owner+':'+String(session?.generation??'')+':'+moduleScopeKey(manifest)+':'+portfolioKey;
 const [record,setRecord]=useState<{key:string;rows:PulseRow[]}|null>(null);
 useEffect(()=>{const abort=new AbortController();if(!authorized||!portfolioKey)return()=>abort.abort();
  void Promise.all((portfolioKey.split(',') as ('india'|'indmoney_us')[]).map(async portfolio=>{try{const value=await apiService.fetch('/backend-api/uat2/simulation/threat-history/'+portfolio,{signal:abort.signal,cache:'no-store',timeoutMs:8000});const page=admitThreatIndex(value,owner,portfolio);return {portfolio,loaded:page.items.length,hasMore:page.hasMore,items:page.items};}catch{return {portfolio,loaded:null,hasMore:false,items:[]};}})).then(rows=>{if(!abort.signal.aborted)setRecord({key,rows});});return()=>abort.abort();
 },[key,authorized,portfolioKey,owner]);
 const current=record?.key===key?record:null;
 return <section className={embedded?'space-y-3':'concept-f-card space-y-3'} aria-label="Recorded Threat Pulse"><h2>Threat Pulse</h2><p className="text-xs leading-relaxed text-muted-foreground">Current portfolio risk flags are not verified by saved model reports. Opening this view reads metadata only; it never starts a scan.</p>{!authorized?<p role="status">Owned risk-history scope is not verified.</p>:!portfolios.length?<p>No selected available investment module can supply report metadata. Safety history remains available.</p>:<><div className="grid gap-4 sm:grid-cols-2">{portfolios.map(portfolio=>{const row=current?.rows.find(value=>value.portfolio===portfolio),root=portfolio==='india'?'/console/zerodha':'/console/indmoney-us';return <div key={portfolio} className="min-w-0 text-sm"><h3 className="font-semibold">{portfolio==='india'?'India / INR':'US / USD'}</h3><p role="status" className="mt-1 text-xs">{!row?'Reading owned report metadata…':row.loaded===null?'Saved report metadata unavailable; no zero-risk or empty-history result is inferred.':row.hasMore?row.loaded+'+ saved reports in bounded metadata pages.':row.loaded+' saved report metadata records returned.'}</p><details className="mt-2"><summary className="concept-f-text-link min-h-11 cursor-pointer">Inspect {portfolio==='india'?'India':'US'} risk and events</summary><div className="pt-2"><Link prefetch={false} className="concept-f-text-link inline-flex min-h-11 items-center text-xs" href={root+'/research/threat-history'}>Inspect owned saved reports →</Link><Link prefetch={false} className="concept-f-text-link inline-flex min-h-11 items-center text-xs" href={root+'/events'}>Inspect saved events →</Link>{row&&row.loaded!==null&&row.items.length>0&&<ConceptFThreatSummary key={key+portfolio} owner={owner} portfolio={portfolio} items={row.items} scopeKey={key}/>}</div></details></div>;})}</div>{current?.rows.some(row=>row.loaded===0)&&<p className="text-xs">No metadata in a returned page does not mean there are no risks.</p>}{(current?.rows.some(row=>row.loaded===null)||retry>0)&&<button className="concept-f-secondary aria-disabled:opacity-60" aria-disabled={!current} aria-busy={!current} onClick={()=>{if(current)setRetry(value=>value+1);}}>{!current?'Reading saved risk metadata…':current.rows.some(row=>row.loaded===null)?'Retry saved risk metadata':'Refresh saved risk metadata'}</button>}</>}</section>;
}
