'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';

type Leg={position:number;symbol:string;exchange:string;side:string;quantity:number;limit_price:string;product:string;order_type:string;state:string;filled_quantity:number};
type Intent={simulation_scenario?:string|null;id:string;state:string;module_id:string;account_label:string;connection_mode:string;connection_version:number;created_at:string;approved_at:string|null;approval_expires_at:string|null;approval_stale:boolean;integrity_checked:boolean;legs:Leg[];estimated_gross_notional:string|null;notional_notice:string;warnings:string[];unresolved:boolean;review_digest:string|null;actions:Record<string,boolean>};
type Reviews={schema_version:1;owner_id:number;runtime_enabled:boolean;simulation_only:true;observed_at:string;has_more:boolean;complete_positions_reconciliation:false;intents:Intent[]};

export function OrderReviews(){
 const {data:session,status}=useSession();
 if(status!=='authenticated'||!session?.user?.id)return <p role="status">Sign in again to view private order activity. No order is submitted by signing in.</p>;
 return <OrderReviewsSession key={`${session.user.id}:${session.generation}`} owner={Number(session.user.id)}/>;
}
export function OrderReviewsSession({owner}:{owner:number}){
 const [data,setData]=useState<Reviews|null>(null),[error,setError]=useState(false),[refresh,setRefresh]=useState(0);
 const generation=useRef(0),inflight=useRef(false);
 const [pending,setPending]=useState<string|null>(null),[outcomes,setOutcomes]=useState<Record<string,string>>({});
 useEffect(()=>{
  const ticket=++generation.current,controller=new AbortController();
  void apiService.fetch<Reviews>('/backend-api/order-intents/reviews',{cache:'no-store',signal:controller.signal,timeoutMs:8000}).then(value=>{
   if(value.schema_version!==1||value.owner_id!==owner||typeof value.runtime_enabled!=='boolean'||value.simulation_only!==true||!Array.isArray(value.intents)||value.intents.length>50||value.intents.some(row=>!row||typeof row.id!=='string'||!Array.isArray(row.legs)||!Array.isArray(row.warnings)||!row.actions||Object.entries(row.actions).some(([key,allowed])=>typeof allowed!=='boolean'||(key!=='confirm'&&allowed))||(row.actions.confirm&&(!value.runtime_enabled||row.state!=='awaiting_approval'||!row.integrity_checked||!row.review_digest||!/^[a-f0-9]{64}$/.test(row.review_digest)))))throw new Error('Invalid private order view');
   if(!controller.signal.aborted&&ticket===generation.current){setData(value);setError(false);}
  }).catch(()=>{if(!controller.signal.aborted&&ticket===generation.current){setData(null);setError(true);}});
  return()=>{controller.abort();generation.current=ticket+1;};
 },[owner,refresh]);
 async function confirm(row:Intent){
  if(inflight.current||outcomes[row.id]||!row.actions.confirm||!row.review_digest)return;
  inflight.current=true;setPending(row.id);const ticket=generation.current;
  try{
   await apiService.fetch(`/backend-api/order-intents/${encodeURIComponent(row.id)}/approve`,{method:'POST',body:JSON.stringify({displayed_digest:row.review_digest,action:'confirm_exact_order_or_basket'}),headers:{'Content-Type':'application/json'},timeoutMs:8000});
   if(ticket===generation.current){setOutcomes(previous=>({...previous,[row.id]:'Confirmation returned. Refreshing persisted status; approval is not proof of a fill.'}));setRefresh(v=>v+1);}
  }catch{
   if(ticket===generation.current){setOutcomes(previous=>({...previous,[row.id]:'Confirmation outcome is uncertain or rejected. Do not repeat submission. Refresh authoritative status before deciding what to do.'}));setRefresh(v=>v+1);}
  }finally{if(ticket===generation.current){setPending(null);}inflight.current=false;}
 }
 return <section aria-labelledby="order-review-heading" className="space-y-4 min-w-0 rounded-xl border p-5">
  <h2 id="order-review-heading" className="text-lg font-semibold">Order review and unresolved activity</h2>
  <p>Recorded instructions stay visible when a product module is disabled. Live execution is disabled. An explicitly installed owner simulation can offer exact fake-order confirmation. Status refresh never grants consent.</p>
  <p className="text-sm text-muted-foreground">Disable stops new module work; disconnect revokes a connection. Neither cancels broker orders nor liquidates holdings. Positions require separate authoritative reconciliation.</p>
  <button type="button" className="underline focus-visible:ring-2" disabled={pending!==null} onClick={()=>{if(!inflight.current)setRefresh(v=>v+1);}}>Refresh recorded order status</button>

  {error&&<p role="alert">Order status unavailable. A timeout does not mean an order safely failed. Do not resubmit; refresh status after restoring your session.</p>}
  {!data&&!error&&<p role="status">Loading private order records…</p>}
  {data&&<><p className="text-sm">Records observed <time dateTime={data.observed_at}>{new Date(data.observed_at).toLocaleString()}</time>. This is not a live broker check.</p>
   {data.has_more&&<p role="status">Only 50 records are shown, prioritizing unresolved orders. This is not a complete account history.</p>}
   {!data.intents.length&&<p>No persisted order intents in these account records. This does not establish that your broker has no orders or positions.</p>}
   {data.intents.map(row=><article key={row.id} className="space-y-3 rounded-lg border p-4 break-words" aria-label={`Order ${row.id}`}>
    {outcomes[row.id]&&<p role="status">{outcomes[row.id]}</p>}
    {row.simulation_scenario&&<p>Server simulation scenario: {row.simulation_scenario.replaceAll('_',' ')}. No live provider effect.</p>}
    <h3 className="font-semibold">{row.unresolved?'Unresolved: ':''}{row.state.replaceAll('_',' ')}</h3>
    <p>Intent {row.id} · Account {row.account_label} · {row.connection_mode==='user_owned'?'Your Kite app':'CredX-managed Kite app'} · connection version {row.connection_version}</p>
    <p>Created <time dateTime={row.created_at}>{new Date(row.created_at).toLocaleString()}</time>. Recorded data may be stale; refresh before relying on status.</p>
    <p>Approved: {row.approved_at?new Date(row.approved_at).toLocaleString():'No recorded approval'} · {row.approval_stale?'Approval expired':'Approval is not standing consent'}</p>
    {row.approval_expires_at&&<p>Approval deadline <time dateTime={row.approval_expires_at}>{new Date(row.approval_expires_at).toLocaleString()}</time></p>}
    <ul className="space-y-2" aria-label="Exact persisted basket instructions">{row.legs.map(leg=><li key={leg.position} className="rounded border p-3">Leg {leg.position+1}: {leg.side} {leg.quantity} {leg.exchange}:{leg.symbol} · {leg.order_type} ₹{leg.limit_price} · {leg.product}. Recorded {leg.state}; filled {leg.filled_quantity} of {leg.quantity}. Limit-price protection; no market order fallback.</li>)}</ul>
    <p>Estimated gross notional: {row.estimated_gross_notional===null?'Unavailable':`INR ${row.estimated_gross_notional}`}. {row.notional_notice}</p>
    <ul aria-label="Order warnings">{row.warnings.map((warning,i)=><li key={i}>{warning}</li>)}</ul>
    {row.actions.confirm?<div className="space-y-2 rounded border p-3"><p>Confirm every displayed leg for this masked account. Approval expires within five minutes and never authorizes changed instructions.</p><button type="button" disabled={pending!==null||Boolean(outcomes[row.id])} className="rounded border p-3 font-semibold disabled:opacity-50 focus-visible:ring-2" onClick={()=>confirm(row)}>{pending===row.id?'Confirmation pending — do not repeat':'I confirm this exact synthetic order / basket'}</button></div>:<p>No submission is available. Changed instructions require a new backend review and explicit exact-order confirmation; refreshing this view gives no consent.</p>}
   </article>)}
  </>}
 </section>;
}
