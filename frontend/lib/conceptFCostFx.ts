import {recordedCostTimestamp,canonicalRecordedCost} from './conceptFCostReceipts';
export type CostFx={owner:number;observedAt:string;status:'valid'|'stale'|'unavailable';value:number|null;source:string|null;asOf:string|null;age:number|null;ttl:number};
export function admitCostFx(raw:unknown,owner:number):CostFx{
 const r=raw as {schema_version?:unknown;owner_id?:unknown;provider_contacted?:unknown;observed_at?:unknown;fx?:Record<string,unknown>};const f=r?.fx;
 if(!r||r.schema_version!==1||r.owner_id!==owner||!Number.isSafeInteger(owner)||owner<1||r.provider_contacted!==false||!recordedCostTimestamp(r.observed_at)||!f||f.pair!=='USD/INR'||!['valid','stale','unavailable'].includes(String(f.status))||!Number.isSafeInteger(f.stale_after_seconds)||Number(f.stale_after_seconds)<=0)throw new Error('Current owned persisted FX evidence required');
 if(f.status==='unavailable'){if(f.value!==null||f.source!==null||f.as_of!==null||f.age_seconds!==null)throw new Error('Unavailable FX must not imply a rate');return {owner,observedAt:r.observed_at as string,status:'unavailable',value:null,source:null,asOf:null,age:null,ttl:Number(f.stale_after_seconds)};}
 if(typeof f.value!=='number'||!Number.isFinite(f.value)||f.value<=0||typeof f.source!=='string'||!f.source.trim()||f.source.length>255||!recordedCostTimestamp(f.as_of)||Date.parse(f.as_of as string)>Date.parse(r.observed_at as string)||!Number.isSafeInteger(f.age_seconds)||Number(f.age_seconds)<0)throw new Error('Attributable finite FX source required');
 return {owner,observedAt:r.observed_at as string,status:f.status as 'valid'|'stale',value:f.value,source:f.source,asOf:f.as_of as string,age:Number(f.age_seconds),ttl:Number(f.stale_after_seconds)};
}
export function costFxRate(fx:CostFx|null,owner:number,now=Date.now()){
 if(!fx||fx.owner!==owner||fx.status!=='valid'||fx.value===null||!Number.isFinite(fx.value)||fx.value<=0||!fx.source?.trim()||fx.source.length>255||!recordedCostTimestamp(fx.asOf)||!Number.isSafeInteger(fx.age)||fx.age===null||fx.age<0||!Number.isSafeInteger(fx.ttl)||fx.ttl<=0||!Number.isFinite(now))return null;
 const stamp=Date.parse(fx.asOf as string);return stamp<=now&&Math.max(fx.age,(now-stamp)/1000)<=fx.ttl?fx.value:null;
}
export function formatCostInr(amount:string|null,fx:CostFx|null,owner:number,now=Date.now()){
 const rate=costFxRate(fx,owner,now);if(amount===null||rate===null||!/^\d{1,18}(?:\.\d{1,12})?$/.test(amount))return null;
 const canonicalRate=canonicalRecordedCost(String(rate));if(canonicalRate===null)return null;
 const atoms=(value:string)=>{const[a,b='']=value.split('.');return BigInt(a)*BigInt(10)**BigInt(12)+BigInt(b.padEnd(12,'0'));};
 const product=atoms(amount)*atoms(canonicalRate);if(product>BigInt(10)**BigInt(39))return null;
 const cents=(product+BigInt(5)*BigInt(10)**BigInt(21))/(BigInt(10)**BigInt(22));
 if(product>BigInt(0)&&cents===BigInt(0))return 'INR <0.01';
 const digits=cents.toString().padStart(3,'0');return 'INR '+digits.slice(0,-2)+'.'+digits.slice(-2);
}
