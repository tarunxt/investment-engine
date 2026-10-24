'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';
type Report={owner_id:number;stale_data:boolean;unknown_orders:boolean;cost_spike:boolean;source_unavailable:boolean;external_delivery:false;simulation_only:true;correlation_id:string;observed_at:string};
export function SimulationDiagnostics(){
 const {data:session,status}=useSession();
 if(status!=='authenticated'||!session?.user?.id)return null;
 return <DiagnosticsSession key={`${session.user.id}:${session.generation}`} owner={Number(session.user.id)}/>;
}
function DiagnosticsSession({owner}:{owner:number}){
 const [report,setReport]=useState<Report|null>(null),[error,setError]=useState(false),[revision,setRevision]=useState(0);
 useEffect(()=>{
  const controller=new AbortController();
  void apiService.fetch<Report>('/backend-api/account/operations/diagnostics',{cache:'no-store',signal:controller.signal}).then(value=>{
   if(value.owner_id!==owner||value.external_delivery!==false||value.simulation_only!==true||['stale_data','unknown_orders','cost_spike','source_unavailable'].some(key=>typeof value[key as keyof Report]!=='boolean'))throw new Error('Invalid owned diagnostics');
   if(!controller.signal.aborted){setReport(value);setError(false);}
  }).catch(()=>{if(!controller.signal.aborted){setReport(null);setError(true);}});
  return()=>controller.abort();
 },[owner,revision]);
 return <section aria-labelledby="simulation-diagnostics-heading" className="space-y-3 rounded-xl border p-5">
  <h2 id="simulation-diagnostics-heading" className="text-lg font-semibold">Recovery and monitoring</h2>
  <p>External alerts and support delivery are disabled. Refresh these private observations after a timeout; they do not prove a real broker state.</p>
  <button className="underline" onClick={()=>setRevision(value=>value+1)}>Refresh recovery observations</button>
  {error&&<p role="alert">Recovery observations unavailable. Restore your session and refresh; do not resubmit an uncertain order.</p>}
  {!report&&!error&&<p role="status">Loading private recovery observations…</p>}
  {report&&<><ul className="list-disc pl-5 space-y-1"><li>Inputs: {report.source_unavailable?'A selected source is unavailable':report.stale_data?'A source needs refresh':'Current sources observed'}</li><li>Orders: {report.unknown_orders?'Unresolved execution needs reconciliation; do not resubmit':'Order status requires a separate recorded-history check; this diagnostic does not establish whether orders are unresolved.'}</li><li>Budget: {report.cost_spike?'Review the recorded cost/reservation ceiling':'No recorded cost spike'}</li></ul><p className="text-sm">Observed {new Date(report.observed_at).toLocaleString()}. Support reference: {report.correlation_id}. Never include credentials in a support request.</p></>}
 </section>;
}
