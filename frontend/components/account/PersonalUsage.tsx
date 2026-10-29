'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {useAuth} from '@/hooks/useAuth';
import {apiService} from '@/services/api';
import {ownedPersonalUsage,type PersonalUsageRecord as Usage} from '@/lib/personalUsage';
export function PersonalUsage(){
 const {user}=useAuth();const {data:session}=useSession();
 const [retry,setRetry]=useState(0);const scope=`${user?.id}:${session?.generation}:${retry}`;
 const [state,setState]=useState<{scope:string;data?:Usage;error?:string}>({scope:''});
 useEffect(()=>{const controller=new AbortController();if(!user?.id)return;
  apiService.fetch<Usage>('/backend-api/api-usage/limits',{signal:controller.signal,cache:'no-store',timeoutMs:8000}).then(data=>{
   const admitted=ownedPersonalUsage(data,user.id);
   if(!controller.signal.aborted)setState({scope,data:admitted});
  }).catch(()=>{if(!controller.signal.aborted)setState({scope,error:'Recorded usage is unavailable. No zero-cost or provider-billing result is inferred.'});});
  return()=>controller.abort();
 },[scope,user?.id,retry]);
 const current=state.scope===scope?state:null;
 return <section className="mx-auto max-w-4xl space-y-5"><h1 className="text-3xl font-semibold">Usage & plan</h1><p className="text-sm text-muted-foreground">Your own research usage. Provider keys and company billing are kept in the administrator workspace.</p><p className="text-sm text-muted-foreground">Source: governed account budget ledger, in USD. Model-level/provider billing is not supplied by this response; saved-stage estimates remain separate.</p><button className="min-h-11 rounded border px-4" onClick={()=>setRetry(value=>value+1)}>Refresh recorded usage</button>
  {current?.error?<p role="alert" className="rounded-xl border p-4">{current.error}</p>:!current?.data?<p role="status">Loading your usage…</p>:<>
   <p className="text-sm">Recorded budget day: {current.data.day_utc} (UTC).</p>
   {current.data.account?<dl className="grid gap-4 rounded-xl border p-5 sm:grid-cols-3">{[['Recorded cost',current.data.account.spent_usd],['Reserved upper cost',current.data.account.reserved_usd],['Configured test cap',current.data.account.cap_usd]].map(([label,value])=><div key={label}><dt className="text-sm text-muted-foreground">{label}</dt><dd className="mt-1 text-lg font-medium">USD {value}</dd></div>)}</dl>:<p>No budget record is available for this day. Missing records are not a zero-cost guarantee.</p>}
   <p className="text-sm text-muted-foreground">{current.data.pricing_status}</p>
   <h2 className="text-xl font-semibold">Recent research receipts</h2>{current.data.attempts.length?<ul className="space-y-3">{current.data.attempts.map(a=><li key={a.id} className="rounded-xl border p-4"><p className="font-medium">{a.module_id.replaceAll('_',' ')} · {a.status.replaceAll('_',' ')}</p><p className="mt-1 text-sm text-muted-foreground">{a.notice}</p><p className="mt-2 text-xs">Reserved upper bound: USD {a.reserved_upper_usd}. {a.actual_usd===null?'Actual recorded amount unavailable; a reservation is not a settled bill.':'Recorded actual amount: USD '+a.actual_usd+'. This receipt is not an external provider invoice.'}</p></li>)}</ul>:<p>No research receipts were returned for your account.</p>}
  </>}
 </section>;
}
