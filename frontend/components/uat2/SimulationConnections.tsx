'use client';
import {useCallback,useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import Link from 'next/link';
import {apiService} from '@/services/api';
import {useModules} from '@/providers/ModuleContext';

type Connection={provider:string;id:string;version:number;app_ownership_mode:string;is_current:boolean;status:string;account_label:string|null};
type Mode='user_owned'|'platform_managed';
export function SimulationConnections(){
 const {data:session,status}=useSession();
 if(status!=='authenticated'||!session?.user?.id)return <p>Sign in to review your private simulation connection.</p>;
 return <SimulationConnectionSession key={`${session.user.id}:${session.generation}`} owner={Number(session.user.id)}/>;
}
function SimulationConnectionSession({owner}:{owner:number}){
 const {manifest,refresh}=useModules();
 const [current,setCurrent]=useState<Connection|null>(null),[mode,setMode]=useState<Mode|null>(null);
 const [message,setMessage]=useState('Loading the current simulated connection…'),[busy,setBusy]=useState(false),[verified,setVerified]=useState(false);
 const uncertainSource=useRef(false);
 const active=useRef(true),inflight=useRef(false),controller=useRef<AbortController|null>(null);
 const selected=manifest?.modules.some(m=>m.module_id==='zerodha_rebalance'&&m.selection.enabled&&m.availability.available)??false;
 const load=useCallback(async(signal?:AbortSignal)=>{
  const result=await apiService.fetch<{schema_version:1;owner_id:number;connections:Connection[]}>('/backend-api/me/connections',{cache:'no-store',signal});
  if(result.schema_version!==1||result.owner_id!==owner||!Array.isArray(result.connections)||result.connections.length>50||result.connections.some(row=>!row||typeof row.id!=='string'||!row.id||row.id.length>128||typeof row.status!=='string'||typeof row.provider!=='string'||typeof row.is_current!=='boolean'||!Number.isSafeInteger(row.version)||row.version<1||!['user_owned','platform_managed'].includes(row.app_ownership_mode)))throw new Error('Invalid owned connection response');
  const currentRows=result.connections.filter(row=>row.provider==='zerodha'&&row.is_current);
  if(currentRows.length>1||currentRows.length===0&&result.connections.length===50)throw new Error('Current Kite binding cannot be verified from this bounded list');
  const found=currentRows[0]??null;
  if(active.current&&!signal?.aborted){setCurrent(found);setVerified(true);}return found;
 },[owner]);
 useEffect(()=>{
  active.current=true;const abort=new AbortController();controller.current=abort;
  void load(abort.signal).then(()=>{if(active.current&&!abort.signal.aborted)setMessage('Only fake connections are available. No Kite credentials or provider login is needed.');})
   .catch(()=>{if(active.current&&!abort.signal.aborted){setVerified(false);setMessage('Connection status unavailable. Refresh before changing the binding.');}});
  return()=>{active.current=false;abort.abort();};
 },[load]);
 async function change(operation:()=>Promise<void>,effect:'binding'|'source'|null=null){
  if(inflight.current)return;inflight.current=true;setBusy(true);
  try{await operation();}catch{if(active.current){setVerified(false);setMode(null);if(effect==='source')uncertainSource.current=true;setMessage('The operation was rejected or its response is uncertain. Refresh persisted status before trying a new action.');}}
  finally{inflight.current=false;if(active.current)setBusy(false);}
 }
 return <section aria-labelledby="simulation-connections-heading" className="space-y-3 rounded-xl border p-5 min-w-0">
  <h2 id="simulation-connections-heading" className="text-lg font-semibold">Fake Kite connection and source</h2>
  <p>No brokerage credential entry, real provider approval or live order is available here. Both choices simulate the app ownership model.</p>
  <p role="status">{message}</p>
  <p>{verified?'Current':'Last observed · not verified current'}: {current?`${current.app_ownership_mode==='user_owned'?'User-owned Kite mode':'Managed Kite mode'} · ${current.account_label??'masked fake account'} · ${current.status} · version ${current.version}`:'No current connection'}</p>
  <button className="underline" disabled={busy} onClick={()=>void change(async()=>{const saved=await load(controller.current?.signal);if(uncertainSource.current){const context=await apiService.fetch<{owner_id:number;portfolio:string;source_hash:string;connection:{id:string;version:number}|null;usage:{simulation_only:boolean}}>('/backend-api/runs/analysis-workflows/setup-context?portfolio=india',{cache:'no-store',signal:controller.current?.signal});if(context.owner_id!==owner||context.portfolio!=='india'||context.usage?.simulation_only!==true||!/^[0-9a-f]{64}$/.test(context.source_hash)||!saved||context.connection?.id!==saved.id||context.connection?.version!==saved.version)throw new Error('Owned persisted source required');if(active.current){uncertainSource.current=false;setMessage(`Persisted synthetic source verified: ${context.source_hash}. No acquisition, analysis or order was retried.`);}}else if(active.current)setMessage('Persisted connection refreshed. No connection or order was created.');if(active.current)setMode(null);})}>Refresh simulated connection</button>
  <div className="flex flex-wrap gap-3">{(['user_owned','platform_managed'] as const).map(value=><button key={value} disabled={busy||!verified} className="rounded border px-3 py-2" onClick={()=>setMode(value)}>Review {value==='user_owned'?'user-owned':'managed'} Kite mode (fake)</button>)}</div>
  {mode&&<div className="space-y-2 rounded border p-3"><p>Confirm {mode==='user_owned'?'user-owned':'managed'} mode with a new isolated fake account. Replacing a binding invalidates its old analysis inputs and approvals. Prior evidence stays available for reconciliation.</p>
   <button className="rounded border px-3 py-2" disabled={busy||!verified} onClick={()=>void change(async()=>{
    await apiService.fetch('/backend-api/uat2/simulation/connections',{method:'POST',signal:controller.current?.signal,body:JSON.stringify({mode,key:crypto.randomUUID(),expected_id:current?.id??null,expected_version:current?.version??null})});
    await load(controller.current?.signal);await refresh();if(active.current){setMode(null);setMessage('Fake connection recorded. Explicit source acquisition is the next step; no analysis or order was started.');}
   },'binding')}>Confirm this simulated connection mode</button>
   <button disabled={busy} className="underline ml-3" onClick={()=>setMode(null)}>Keep current binding</button>
  </div>}
  {!selected&&<p>Select Zerodha Rebalance in <Link className="underline" href="/console/profile/preferences#modules">module Preferences</Link> before acquiring the fake India source.</p>}
  <button disabled={busy||!verified||!selected||!current} className="rounded border px-3 py-2 disabled:opacity-50" onClick={()=>void change(async()=>{
   const result=await apiService.fetch<{owner_id:number;simulation_only:boolean;source_hash:string}>('/backend-api/runs/analysis-workflows/synthetic-source',{method:'POST',signal:controller.current?.signal,body:JSON.stringify({portfolio:'india',key:crypto.randomUUID()})});
   if(result.owner_id!==owner||result.simulation_only!==true||!/^[0-9a-f]{64}$/.test(result.source_hash))throw new Error('Invalid acquisition receipt');
   if(active.current)setMessage(`Synthetic source acquired: ${result.source_hash}. Start server analysis separately. New acquisition invalidates workflows using older inputs.`);
  },'source')}>Acquire current fake India source</button>
 </section>;
}
