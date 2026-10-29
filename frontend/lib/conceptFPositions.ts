import {safeResearchData} from './conceptFResearch';
export type RecordedPosition={key:string;symbol:string;exchange:string|null;product:string|null;quantity:number|null;m2m:number|null};
export function recordedPositionGroup(raw:unknown){
 if(raw===undefined||raw===null)return{state:'missing' as const,rows:[] as RecordedPosition[],invalid:0};
 if(!Array.isArray(raw))return{state:'invalid' as const,rows:[] as RecordedPosition[],invalid:0};
 if(raw.length>1000)return{state:'oversized' as const,rows:[] as RecordedPosition[],invalid:raw.length};
 const rows:RecordedPosition[]=raw.flatMap((value,index)=>{const r=value&&typeof value==='object'&&!Array.isArray(value)?value as Record<string,unknown>:null;if(!r||typeof r.tradingsymbol!=='string'||!/^[A-Z0-9&_.-]{1,64}$/.test(r.tradingsymbol))return[];return[{key:String(index)+':'+r.tradingsymbol,symbol:r.tradingsymbol,exchange:typeof r.exchange==='string'&&/^[A-Z0-9_]{1,24}$/.test(r.exchange)?r.exchange:null,product:typeof r.product==='string'&&r.product.length<=64?String(safeResearchData(r.product)):null,quantity:typeof r.quantity==='number'&&Number.isFinite(r.quantity)?r.quantity:null,m2m:typeof r.m2m==='number'&&Number.isFinite(r.m2m)?r.m2m:null}];});
 return{state:!raw.length?'empty' as const:rows.length===raw.length?'available' as const:'partial' as const,rows,invalid:raw.length-rows.length};
}
