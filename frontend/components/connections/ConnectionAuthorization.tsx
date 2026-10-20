'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';

type Binding={id:string;version:number;is_current?:boolean;status:string;app_ownership_mode:string;account_label:string|null};
type Attempt={attempt_id:string;state:string;expires_at:string;simulation:boolean};
type Review={attempt_id:string;account_label:string;app_ownership_mode:string;connection_version:number};
const prefix='/backend-api/me/connection-authorization';

export function ConnectionAuthorization({onChanged}:{onChanged?:()=>void}){
 const {user}=useAuth();const {data:session,status}=useSession();
 if(status!=='authenticated'||!user)return null;
 return <AuthorizationFlow key={`${user.id}:${session?.generation??''}`} owner={user.id} onChanged={onChanged}/>;
}

export function AuthorizationFlow({owner,onChanged}:{owner:number;onChanged?:()=>void}){
 const alive=useRef(true);const [enabled,setEnabled]=useState(false);const [simulation,setSimulation]=useState(false);
 const [rows,setRows]=useState<Binding[]>([]);const [selected,setSelected]=useState<Binding>();
 const [attempt,setAttempt]=useState<Attempt>();const [review,setReview]=useState<Review>();
 const [busy,setBusy]=useState(false);const [message,setMessage]=useState('Checking authorization availability…');
 async function refresh(){
  const data=await apiService.fetch<{owner_id:number;connections:Binding[]}>('/backend-api/me/connections',{cache:'no-store'});
  if(data.owner_id!==owner)throw Error('Owner changed');
  if(alive.current)setRows(data.connections);
 }
 useEffect(()=>{alive.current=true;const controller=new AbortController();
  void apiService.fetch<{enabled:boolean;simulation:boolean}>(prefix+'/config',{signal:controller.signal,cache:'no-store'}).then(async data=>{
   if(alive.current){setEnabled(data.enabled);setSimulation(data.simulation);setMessage(data.simulation?'Synthetic authorization preview. No broker login or provider call.':'Independent provider approval required.');await refresh();}
  }).catch(()=>{if(alive.current)setMessage('Authorization is unavailable. No provider action was performed.');});
  return()=>{alive.current=false;controller.abort();};
 },[owner]); // Session changes remount the complete flow before private state is displayed.
 async function action(operation:()=>Promise<void>){
  if(busy)return;setBusy(true);
  try{await operation();}catch{if(alive.current)setMessage('Authorization did not complete. Existing connections remain available; refresh and start a new attempt.');}
  finally{if(alive.current)setBusy(false);}
 }
 async function post<T>(path:string,body:unknown){return apiService.fetch<T>(prefix+path,{method:'POST',body:JSON.stringify(body),headers:{'Content-Type':'application/json'},cache:'no-store'});}
 async function start(row:Binding){
  const result=await post<Attempt>('/start',{connection_id:row.id,version:row.version});
  if(alive.current){setSelected(row);setAttempt(result);setReview(undefined);setMessage('One-use attempt ready; expires in five minutes.');}
 }
 const current=rows.find(row=>row.is_current);
 return <section className="space-y-3 rounded-xl border p-5 min-w-0" aria-labelledby="authorization-heading">
  <h2 id="authorization-heading" className="font-semibold">Authorize or renew a connection</h2>
  <p role="status" className="break-words">{message}</p>
  {enabled&&simulation&&<div className="flex flex-wrap gap-3">{['user_owned','platform_managed'].map(mode=><button className="rounded border px-3 py-2" key={mode} disabled={busy} onClick={()=>void action(async()=>{
   const row=await post<{connection_id:string;version:number}>('/synthetic-setup',{mode});
   if(alive.current)await start({id:row.connection_id,version:row.version,status:'configured',app_ownership_mode:mode,account_label:null});
  })}>Try {mode==='user_owned'?'your own Kite app':'CredX-managed app'} (synthetic)</button>)}</div>}
  {enabled&&rows.filter(row=>row.is_current).map(row=><article key={row.id} className="space-y-2 rounded border p-3">
   <p>{row.app_ownership_mode==='user_owned'?'Your Kite app':'CredX-managed app'} · {row.account_label??'unverified'} · {row.status.replaceAll('_',' ')}</p>
   <div className="flex flex-wrap gap-3"><button className="underline" disabled={busy} onClick={()=>void action(()=>start(row))}>Reconnect / renew</button>
   <button className="underline" disabled={busy||row.status==='disabled'} onClick={()=>void action(async()=>{
    const result=await post<{local_disabled:boolean;provider_revoked:boolean;provider_revocation_status:string}>('/disconnect',{connection_id:row.id,version:row.version});
    if(alive.current){setAttempt(undefined);setReview(undefined);setMessage(`Local access disabled. Provider revocation: ${result.provider_revocation_status}. Account identity retained for reconciliation.`);await refresh();onChanged?.();}
   })}>Disconnect locally and request revocation</button></div>
  </article>)}
  {attempt&&simulation&&!review&&<button className="rounded border px-3 py-2" disabled={busy} onClick={()=>void action(async()=>{
   const result=await post<Review>('/callback',{attempt_id:attempt.attempt_id,state:attempt.state,request_token:'fake-ok'});
   if(alive.current){setReview(result);setMessage('Review the returned synthetic broker account before connecting. Broker email need not match Google email.');}
  })}>Simulate broker callback</button>}
  {review&&selected&&<div className="space-y-2 rounded border p-3"><p>Review {review.account_label} using {review.app_ownership_mode.replaceAll('_',' ')}.</p>
   {current&&current.id!==selected.id&&<p>Replaces {current.account_label}. Previous approvals become stale and scheduled work pauses.</p>}
   <button className="rounded border px-3 py-2" disabled={busy} onClick={()=>void action(async()=>{
    await post('/confirm',{attempt_id:review.attempt_id,version:review.connection_version,previous_id:current?.id,previous_version:current?.version});
    if(alive.current){setReview(undefined);setAttempt(undefined);setMessage('Connection reviewed. Schedules paused; no module access or financial execution granted.');await refresh();onChanged?.();}
   })}>Confirm this account and app mode</button></div>}
  <p className="text-sm text-muted-foreground">Real provider login, app credentials and live operations remain unavailable in this synthetic preview.</p>
 </section>;
}
