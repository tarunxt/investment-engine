import {recordedCostTimestamp} from './conceptFCostReceipts';
type Receipt={id:string|number;source_hash:string;captured_at:string;currency:'INR'|'USD';value_exact:string|null;content_hash?:string;supersedes_id?:number|null};
type Fx={id:number;pair:'USD/INR';rate:string;source:string;as_of:string;fetched_at:string};
export type CombinedPoint={captured_at:string;known:boolean;value:number|null;value_exact:string|null;reasons:string[];india:Receipt|null;us:Receipt|null;fx:Fx|null};
export type CombinedHistory={schema_version:1;owner_id:number;module_version:number;simulation_only:true;read_only:true;orders_authorized:false;metric:'coeval_recorded_holdings_inr_v1';currency:'INR';alignment:'exact_capture_instant_only';history_complete:false;continuity_verified:boolean;source_limit:100;fx_limit:400;fx_stale_after_seconds:number;has_more:{india:boolean;us:boolean;fx:boolean};rejected_sources:{india:number;us:number};points:CombinedPoint[];notice:string};
const hash=(x:unknown)=>typeof x==='string'&&/^[a-f0-9]{64}$/.test(x);
const integer=(x:unknown)=>Number.isSafeInteger(x)&&Number(x)>0;
const decimal=(x:unknown)=>typeof x==='string'&&x.length<=1024&&/^(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d{1,3})?$/.test(x)&&Number.isFinite(Number(x))&&Number(x)>=0&&(Number(x)!==0||!/[1-9]/.test(x.split(/[eE]/)[0]));
function exactTotal(inr:string,usd:string,rate:string,total:string){
 const parts=(text:string)=>{const [mantissa,exponent='0']=text.toLowerCase().split('e'),[whole,fraction='']=mantissa.split('.');return {n:BigInt(whole+fraction),s:fraction.length-Number(exponent)};};
 const a=parts(inr),b=parts(usd),c=parts(rate),d=parts(total),product={n:b.n*c.n,s:b.s+c.s},width=Math.max(a.s,product.s,d.s,0);
 const scale=(x:{n:bigint;s:number})=>x.n*BigInt(10)**BigInt(width-x.s);
 return scale(a)+scale(product)===scale(d);
}
function instant(text:string){
 if(!recordedCostTimestamp(text))throw new Error('Recorded instant required');
 const fraction=text.match(/\.(\d+)(?:Z|[+-]\d{2}:\d{2})$/)?.[1]??'';
 return BigInt(Date.parse(text))*BigInt(1000)+BigInt(fraction.padEnd(6,'0').slice(3,6));
}
const reasons=new Set(['india_source_missing','india_source_ambiguous','us_source_missing','us_source_ambiguous','india_value_unknown','us_value_unknown','fx_bound_exceeded','dated_fx_unavailable','dated_fx_ambiguous','combined_value_out_of_range','combined_value_not_representable','india_source_bound_exceeded','us_source_bound_exceeded']);
export function admitCombinedHistory(value:unknown,owner:number,version:number,now=Date.now()):CombinedHistory{
 const x=value as CombinedHistory;
 if(!integer(owner)||!integer(version)||!x||typeof x!=='object'||x.schema_version!==1||x.owner_id!==owner||x.module_version!==version||x.simulation_only!==true||x.read_only!==true||x.orders_authorized!==false||x.metric!=='coeval_recorded_holdings_inr_v1'||x.currency!=='INR'||x.alignment!=='exact_capture_instant_only'||x.history_complete!==false||x.source_limit!==100||x.fx_limit!==400||x.fx_stale_after_seconds!==129600||!x.has_more||!x.rejected_sources||['india','us','fx'].some(k=>typeof x.has_more[k as keyof typeof x.has_more]!=='boolean')||['india','us'].some(k=>!Number.isSafeInteger(x.rejected_sources[k as keyof typeof x.rejected_sources])||x.rejected_sources[k as keyof typeof x.rejected_sources]<0)||!Array.isArray(x.points)||x.points.length>200||typeof x.notice!=='string'||x.notice.length>1024||!Number.isFinite(now))throw new Error('Owned bounded combined history required');
 if(typeof x.continuity_verified!=='boolean'||x.continuity_verified!==(x.rejected_sources.india===0&&x.rejected_sources.us===0&&!Object.values(x.has_more).some(Boolean)))throw new Error('Recorded continuity scope required');
 let previous:bigint|null=null;
 for(const p of x.points){
  if(!p||typeof p.known!=='boolean'||!Array.isArray(p.reasons)||p.reasons.length>10||p.reasons.some(r=>!reasons.has(r)))throw new Error('Recorded gap contract required');
  const at=instant(p.captured_at);
  if(at>BigInt(Math.trunc(now))*BigInt(1000)||previous!==null&&at<=previous)throw new Error('Ordered historical observations required');previous=at;
  for(const [market,r] of [['india',p.india],['us',p.us]] as const){
   if(r===null)continue;
   if(!r||!hash(r.source_hash)||r.captured_at!==p.captured_at||r.currency!==(market==='india'?'INR':'USD')||r.value_exact!==null&&!decimal(r.value_exact))throw new Error('Exact owned native receipt required');
   if(market==='india'){
    if(typeof r.id!=='string'||!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(r.id))throw new Error('Exact India receipt required');
   }else if(!integer(r.id)||!hash(r.content_hash)||r.supersedes_id!==null&&(!integer(r.supersedes_id)||r.supersedes_id===r.id))throw new Error('Exact USD receipt required');
  }
  const fx=p.fx;
  if(fx!==null&&(!fx||!integer(fx.id)||fx.pair!=='USD/INR'||!decimal(fx.rate)||Number(fx.rate)<=0||typeof fx.source!=='string'||!fx.source.trim()||fx.source.length>255||instant(fx.as_of)>at||at-instant(fx.as_of)>BigInt(129600000000)||instant(fx.fetched_at)>BigInt(Math.trunc(now))*BigInt(1000)))throw new Error('Dated persisted FX required');
  if(p.known){if(!p.india||!p.us||!fx||p.india.value_exact===null||p.us.value_exact===null||p.reasons.length||typeof p.value!=='number'||!Number.isFinite(p.value)||p.value<0||!decimal(p.value_exact)||Number(p.value_exact)!==p.value||Object.values(x.has_more).some(Boolean)||!exactTotal(p.india.value_exact,p.us.value_exact,fx.rate,p.value_exact!))throw new Error('Known combined point requires exact sources and FX');}
  else if(p.value!==null||p.value_exact!==null||!p.reasons.length)throw new Error('Unknown value must remain an explicit gap');
 }
 return x;
}

/** Rejected records have no trusted timestamp to place on the chart. Never bridge them. */
export function combinedSegments(value:CombinedHistory,segment:(rows:CombinedPoint[])=>CombinedPoint[][]):CombinedPoint[][]{return value.continuity_verified?segment(value.points):value.points.filter(p=>p.known).map(p=>[p]);}
