'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';
type Data={schema_version:1;owner_id:number;read_only:true;complete_live_positions:false;notice:string;sources:{label:string;snapshot_id:number|null;captured_at:string|null;verification:string;groups:{kind:string;items:{symbol:string;quantity:string}[];truncated_or_invalid:boolean}[]}[]};
export function RecordedPositions(){
 const {data:session,status}=useSession();
 if(status!=='authenticated'||!session?.user?.id)return <p>Sign in to view your recorded holdings and positions.</p>;
 return <RecordedPositionsSession key={`${session.user.id}:${session.generation}`} owner={Number(session.user.id)}/>;
}
export function RecordedPositionsSession({owner}:{owner:number}){
 const [data,setData]=useState<Data|null>(null),[error,setError]=useState(false);
 useEffect(()=>{const controller=new AbortController();void apiService.fetch<Data>('/backend-api/order-intents/positions',{cache:'no-store',signal:controller.signal,timeoutMs:8000}).then(value=>{
  if(value.owner_id!==owner||value.schema_version!==1||value.read_only!==true||value.complete_live_positions!==false||!Array.isArray(value.sources))throw new Error('Invalid owned positions view');
  if(!controller.signal.aborted)setData(value);
 }).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[owner]);
 return <section aria-labelledby="recorded-positions-heading" className="space-y-3 rounded-xl border p-5 min-w-0"><h2 id="recorded-positions-heading" className="font-semibold">Recorded holdings and positions</h2>
 {error?<p role="alert">Recorded positions unavailable. No empty-position or live reconciliation result is inferred.</p>:!data?<p role="status">Loading recorded positions…</p>:<><p>{data.notice}</p>{data.sources.map(source=><article key={source.label} className="space-y-2 rounded border p-3 break-words"><h3 className="font-medium">{source.label}</h3><p>{source.verification.replaceAll('_',' ')} · {source.captured_at?<time dateTime={source.captured_at}>{new Date(source.captured_at).toLocaleString()}</time>:'No snapshot recorded'}</p>{source.groups.map(group=><div key={group.kind}><h4>{group.kind.replaceAll('_',' ')}</h4><ul>{group.items.map((item,i)=><li key={i}>{item.symbol}: recorded quantity {item.quantity}</li>)}</ul>{group.truncated_or_invalid&&<p>Some rows are omitted or invalid. This is an incomplete record.</p>}{!group.items.length&&<p>No valid rows in this recorded group; current broker positions are unknown.</p>}</div>)}</article>)}</>}
 </section>;
}
