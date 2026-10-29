'use client';
import {useEffect,useRef,useState} from 'react';
import {usePathname,useRouter,useSearchParams} from 'next/navigation';
import {savedTechnicalSource} from '@/lib/conceptFTechnical';
import {apiService} from '@/services/api';

type Source={holdings:unknown[];currency:string;source_receipt_id:string;content_hash:string};
type Review={previous_source:Source|null;id:string;owner_id:number;simulation_only:true;review_digest:string;state:'preview'|'accepted'|'expired';accepted_receipt:string|null;is_current:boolean;orders_authorized:false;review:{owner_id:number;simulation_only:true;module_version:number;base_receipt:string|null;base_hash:string|null;captured_at:string;expires_at:string;proposed:{holdings:unknown[];currency:string;source_receipt_id:string;content_hash:string}}};
function checked(raw:unknown,owner:number):Review{
 const x=raw as Review;
 if(x?.review?.proposed&&savedTechnicalSource(x.review.proposed,owner).state==='invalid')throw new Error('Saved synthetic study unavailable');
 if(!x||x.owner_id!==owner||x.simulation_only!==true||x.orders_authorized!==false||!['preview','accepted','expired'].includes(x.state)||!x.review||x.review.owner_id!==owner||x.review.simulation_only!==true||!Array.isArray(x.review.proposed?.holdings)||!/^[a-f0-9]{64}$/.test(x.review_digest)||!/^[a-f0-9-]{36}$/.test(x.id))throw new Error('Owned exact review unavailable');
 return x;
}

/** Deliberate fake-source review. No fetch on mount without a pinned review ID. */
export function ConceptFSnapshotReview({owner,onAccepted,masked=true}:{owner:number;onAccepted:()=>void;masked?:boolean}){
 const query=useSearchParams(),router=useRouter(),path=usePathname();
 const identifier=query.get('sourceReview');
 const [record,setValue]=useState<Review|null>(null),[error,setError]=useState<string|null>(null),[busy,setBusy]=useState(false),[uncertain,setUncertain]=useState(false);
 const value=record?.owner_id===owner&&(!identifier||record.id===identifier)?record:null;
 const [hasKey,setHasKey]=useState(!!query.get('sourceReviewKey'));
 const proposedStudy=value?savedTechnicalSource(value.review.proposed,owner):null;
 const active=useRef(true),inflight=useRef(false),key=useRef<string|null>(query.get('sourceReviewKey'));
 useEffect(()=>{active.current=true;return()=>{active.current=false;};},[]);
 useEffect(()=>{
  const controller=new AbortController();
  if(identifier&&/^[a-f0-9-]{36}$/.test(identifier))void apiService.fetch('/backend-api/uat2/simulation/snapshot-reviews/'+identifier,{cache:'no-store',signal:controller.signal}).then(raw=>{if(!controller.signal.aborted)setValue(checked(raw,owner));}).catch(()=>{if(!controller.signal.aborted)setError('Pinned review unavailable. No current source is substituted.');});
  return()=>controller.abort();
 },[owner,identifier]);
 function pin(id:string){const next=new URLSearchParams(query.toString());next.set('sourceReview',id);next.delete('sourceReviewKey');router.replace(path+'?'+next.toString(),{scroll:false});}
 async function work(action:'preview'|'accept'|'status'){
  if(inflight.current)return;inflight.current=true;setBusy(true);setError(null);
  try{
   if(action==='preview'&&!key.current){key.current=crypto.randomUUID();setHasKey(true);const next=new URLSearchParams(query.toString());next.set('sourceReviewKey',key.current);router.replace(path+'?'+next.toString(),{scroll:false});}
   const url='/backend-api/uat2/simulation/snapshot-reviews'+(action==='preview'?'':'/'+value!.id+(action==='accept'?'/accept':''));
   const raw=await apiService.fetch(url,{method:action==='status'?'GET':'POST',cache:'no-store',...(action==='status'?{}:{body:JSON.stringify(action==='preview'?{key:key.current}:{review_digest:value!.review_digest})})});
   const next=checked(raw,owner);if(active.current){setValue(next);setUncertain(false);if(action==='preview')pin(next.id);if(next.state==='accepted')onAccepted();}
  }catch{if(active.current){setError(action==='status'?'Persisted review unavailable; outcome remains unverified.':'Result rejected or uncertain. Inspect the same persisted review before any retry.');if(action!=='status')setUncertain(true);}}
  finally{inflight.current=false;if(active.current)setBusy(false);}
 }
 const holdings=(source:Source|null)=>!source?<p>No prior accepted acquisition.</p>:<div className="overflow-x-auto"><table className="concept-f-table"><thead><tr><th>Stock</th><th>Quantity</th><th>Recorded price</th></tr></thead><tbody>{source.holdings.map((raw,index)=>{const row=raw as Record<string,unknown>;return <tr key={index}><th>{String(row.tradingsymbol??'Unavailable')}</th><td>{String(row.quantity??'Unavailable')}</td><td>{masked?'₹ ••,•••':String(row.last_price??'Unavailable')}</td></tr>;})}</tbody></table></div>;
 return <section className="concept-f-card"><h2>Review a refreshed simulation snapshot</h2><p className="my-3 text-sm">A preview records proposed synthetic bytes only. Keep the current source, or explicitly accept this exact version. No broker is contacted and no order is authorized.</p>
 {!value&&<button className="concept-f-secondary" disabled={busy} onClick={()=>void work('preview')}>{hasKey?'Inspect same preview request':'Preview synthetic snapshot'}</button>}
 {error&&<p role="alert" className="my-3 text-sm">{error}</p>}
 {value&&<><div className="my-4 grid min-w-0 gap-4 md:grid-cols-2"><div><h3 className="font-semibold">Source recorded before this review</h3><p className="break-all text-xs">{value.review.base_receipt??'None established'}</p><p className="mt-2 text-xs">Frozen baseline for this proposal. Acceptance rechecks the current receipt; another operation may have changed it.</p>{holdings(value.previous_source)}</div><div><h3 className="font-semibold">Proposed exact source</h3><p className="text-sm">{value.review.proposed.holdings.length} holdings · {value.review.proposed.currency} · {value.review.captured_at}</p><p className="mt-2 break-all text-xs">Content {value.review.proposed.content_hash}</p>{holdings(value.review.proposed)}{proposedStudy?.state==='available'&&<><p className="mt-3 text-sm">Includes fifteen fixed synthetic price samples generated with this capture, with stored RSI14 initial seed and SMA5/SMA14. These are test inputs, not market history, a forecast or trading authority. The exact source hash covers this study; inspect it in saved research after deliberate acceptance and research consent.</p><details className="mt-3"><summary className="min-h-11 cursor-pointer">Inspect proposed study inputs and calculation</summary>{masked?<p>Investment values are masked.</p>:<><p className="my-3 text-sm">Stored RSI14 {proposedStudy.rsi??'Undefined'} · SMA5 {proposedStudy.sma5} · SMA14 {proposedStudy.sma14}. Initial14-change ratio uses gain/loss sums {proposedStudy.gain}/{proposedStudy.loss}; no volatility classification supplied.</p><div role="region" aria-label="Proposed synthetic study samples" tabIndex={0} className="overflow-x-auto"><table className="concept-f-table min-w-[30rem]"><thead><tr><th>Generated sample label</th><th>INR close</th></tr></thead><tbody>{proposedStudy.points.map(point=><tr key={point.at}><th>{point.at}</th><td>{point.close}</td></tr>)}</tbody></table></div></>}<p className="mt-3 break-all text-xs">Study {proposedStudy.hash}</p></details></>}</div></div><p className="text-xs">Receipt status is not proof of current connection readiness, source freshness or execution eligibility.</p><p className="text-xs">Review {value.id} · Module version {value.review.module_version} · Expires {value.review.expires_at}</p><p role="status" className="my-3">{value.state==='accepted'?(value.is_current?'Exact snapshot accepted and current.':'Exact snapshot accepted historically; another source is current.'):value.state==='expired'?'Review expired; it grants no source change.':'Preview only; no source change was performed by this review.'}</p><div className="flex flex-wrap gap-3"><button className="concept-f-primary" disabled={busy||uncertain||value.state!=='preview'} onClick={()=>void work('accept')}>Accept exact simulation snapshot</button><button className="concept-f-secondary" disabled={busy} onClick={()=>void work('status')}>Inspect persisted review</button><button className="concept-f-secondary" disabled={busy} onClick={()=>{const next=new URLSearchParams(query.toString());next.delete('sourceReview');router.replace(path+(next.size?'?'+next.toString():''),{scroll:false});setValue(null);key.current=null;setHasKey(false);}}>Keep current snapshot</button></div></>}
 </section>;
}
