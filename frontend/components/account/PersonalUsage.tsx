'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
type Usage={owner_id:number;day_utc:string;pricing_status:string;account:null|{spent_usd:string;reserved_usd:string;cap_usd:string};attempts:{id:string;module_id:string;status:string;notice:string}[]};
export function PersonalUsage(){
 const {user}=useAuth();const {data:session}=useSession();const scope=`${user?.id}:${session?.generation}`;
 const [state,setState]=useState<{scope:string;data?:Usage;error?:string}>({scope:''});
 useEffect(()=>{const controller=new AbortController();if(!user?.id)return;
  apiService.fetch<Usage>('/backend-api/api-usage/limits',{signal:controller.signal,cache:'no-store'}).then(data=>{
   if(data.owner_id!==user.id)throw new Error('Personal usage ownership could not be verified.');
   if(!controller.signal.aborted)setState({scope,data});
  }).catch(()=>{if(!controller.signal.aborted)setState({scope,error:'Your usage could not be loaded. Refresh this page to try again.'});});
  return()=>controller.abort();
 },[scope,user?.id]);
 const current=state.scope===scope?state:null;
 return <section className="mx-auto max-w-4xl space-y-5"><h1 className="text-3xl font-semibold">Usage & plan</h1><p className="text-sm text-muted-foreground">Your own research usage. Provider keys and company billing are kept in the administrator workspace.</p>
  {current?.error?<p role="alert" className="rounded-xl border p-4">{current.error}</p>:!current?.data?<p role="status">Loading your usage…</p>:<>
   <p className="text-sm">Recorded budget day: {current.data.day_utc} (UTC).</p>
   {current.data.account?<dl className="grid gap-4 rounded-xl border p-5 sm:grid-cols-3">{[['Recorded cost',current.data.account.spent_usd],['Reserved upper cost',current.data.account.reserved_usd],['Configured test cap',current.data.account.cap_usd]].map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-medium">USD {value}</dd></div>)}</dl>:<p>No budget record is available for this day. Missing records are not a zero-cost guarantee.</p>}
   <p className="text-sm text-muted-foreground">{current.data.pricing_status}</p>
   <h2 className="text-xl font-semibold">Recent research receipts</h2>{current.data.attempts.length?<ul className="space-y-3">{current.data.attempts.map(a=><li key={a.id} className="rounded-xl border p-4"><p className="font-medium">{a.module_id.replaceAll('_',' ')} · {a.status.replaceAll('_',' ')}</p><p className="mt-1 text-sm text-muted-foreground">{a.notice}</p></li>)}</ul>:<p>No research receipts were returned for your account.</p>}
  </>}
 </section>;
}
