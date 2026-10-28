export const defaultCalculationColumnWidth=(key:string)=>key==='Stock Info'?152:key==='Job / Run No (Timestamp)'?180:140;
export const distinctCalculationHeaders=(headers:readonly string[])=>[...new Set(headers)];
/** Layout only: calculation values come from the unchanged original row builder. */
export const calculationSheetResource=(market:string)=>'investment-engine:concept-f:calculation-sheet:'+market+':v1';
export function calculationSheetLayout(raw:string|null,owner:number,headers:readonly string[]){
 const defaults={order:[...headers],widths:{} as Record<string,number>};if(raw===null)return defaults;
 if(raw.length>64000)throw Error('Calculation layout exceeds supported bound');
 const value=JSON.parse(raw);
 if(value?.schema!==1||value.owner!==owner||!Array.isArray(value.order)||value.order.length!==headers.length||new Set(value.order).size!==headers.length||value.order.some((key:unknown)=>typeof key!=='string'||!headers.includes(key))||value.order[0]!==headers[0]||!value.widths||typeof value.widths!=='object'||Array.isArray(value.widths))throw Error('Exact owner and complete calculation columns required');
 for(const [key,width] of Object.entries(value.widths))if(!headers.includes(key)||typeof width!=='number'||!Number.isInteger(width)||width<140||width>760)throw Error('Calculation width requires review');
 return{order:value.order as string[],widths:value.widths as Record<string,number>};
}
export function moveCalculationColumn(order:string[],from:string,to:string){
 const a=order.indexOf(from),b=order.indexOf(to);if(a<1||b<1||a===b)return [...order];const next=[...order];next.splice(a,1);next.splice(b,0,from);return next;
}
export const calculationColumnWidth=(value:number)=>Number.isFinite(value)?Math.max(140,Math.min(760,Math.round(value))):180;
export function sortCalculationRows<T extends {id:string;sortValues:Record<string,string|number>}>(rows:T[],field:string,direction:1|-1){
 return [...rows].sort((a,b)=>{const left=a.sortValues[field]??'',right=b.sortValues[field]??'';const delta=typeof left==='number'&&typeof right==='number'?left-right:String(left).localeCompare(String(right),undefined,{numeric:true,sensitivity:'base'});return direction*(delta||a.id.localeCompare(b.id));});
}

/** Bind all inspector content, not just the scalar columns that happen to be visible. */
export function calculationSourceFingerprint(row:{id:string;sortValues:Record<string,string|number>;stock:{key:string;rows?:{meta:{runId:number;jobId:number};cells:Record<string,string>}[]}}){
 return JSON.stringify({id:row.id,stock:row.stock.key,scalars:row.sortValues,sources:(row.stock.rows??[]).filter(item=>row.id===row.stock.key+'-'+item.meta.runId+'-'+item.meta.jobId).map(item=>({identity:item.meta,cells:item.cells}))});
}
