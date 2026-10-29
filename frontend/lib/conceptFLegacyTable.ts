export const legacyLayoutResource='investment-engine:concept-f:recommendation-layout:v1';
export const summaryFields=['Exchange Symbol','Stock Symbol','Action (Buy/Add/Sell All/Trim/Hold/Buy New)','Current Units','Final Units','Units Change','Confidence Score (0-100)','Technical Setup'];
export function readLegacyColumns(raw:string|null,owner:number,available:readonly string[]):string[]{
 if(!raw)return ['Stock Symbol',...available.filter(key=>key!=='Stock Symbol'&&summaryFields.includes(key))].filter(key=>available.includes(key));
 const value=JSON.parse(raw);
 if(value?.schema!==1||value.owner!==owner||!Array.isArray(value.headers)||value.headers.length>100||value.headers.some((x:unknown)=>typeof x!=='string'))throw new Error('Owner-scoped column preference requires review');
 return [...new Set<string>(['Stock Symbol',...value.headers.filter((key:string)=>available.includes(key))])].filter(key=>available.includes(key));
}
export function legacyWidths(raw:string|null,owner:number,available:readonly string[]):Record<string,number>{
 if(!raw)return {};readLegacyColumns(raw,owner,available);
 const value=JSON.parse(raw).widths;if(value===undefined)return {};
 if(!value||typeof value!=='object'||Array.isArray(value))throw new Error('Column widths require review');
 const result:Record<string,number>={};for(const [key,width] of Object.entries(value)){
  if(typeof width!=='number'||!Number.isFinite(width)||width<100||width>600)throw new Error('Unsupported column width');
  if(available.includes(key))result[key]=width;
 }return result;
}
export function boundedColumnWidth(width:number){return Math.max(100,Math.min(600,Math.round(width)));}
export function moveLegacyColumn(columns:string[],field:string,before:string):string[]{
 if(!columns.includes(field)||!columns.includes(before)||field===before||field==='Stock Symbol')return [...columns];
 const next=columns.filter(key=>key!==field),index=next.indexOf(before);next.splice(before==='Stock Symbol'?index+1:index,0,field);return ['Stock Symbol',...next.filter(key=>key!=='Stock Symbol')];
}
export function legacyRows(rows:Record<string,string>[],filter:string,sort:{field:string;direction:1|-1}|null){
 const found=rows.map((cells,index)=>({cells,index})).filter(row=>(row.cells['Stock Symbol']??'').toLocaleLowerCase().includes(filter.trim().toLocaleLowerCase()));
 return sort?found.sort((a,b)=>{
  const left=a.cells[sort.field]??'',right=b.cells[sort.field]??'',difference=unitDifference(left,right);
  const comparison=difference===null?left.localeCompare(right,undefined,{numeric:true}):difference==='0'?0:difference.startsWith('-')?-1:1;
  return sort.direction*comparison||a.index-b.index;
 }):found;
}
export function metadataColumn(key:string){return ['Stock Symbol','Exchange Symbol','LLM','LLM Name + Model','Run #','Run Date','Run Time'].includes(key);}
import {unitDifference} from './conceptFStockFlow';

/** Keyboard equivalent of drag reorder; the stock identity column stays pinned. */
export function shiftLegacyColumn(columns:string[],field:string,direction:-1|1){
 const from=columns.indexOf(field),to=from+direction;
 if(from<0||field==='Stock Symbol'||to<1||to>=columns.length)return [...columns];
 const next=[...columns];[next[from],next[to]]=[next[to],next[from]];return next;
}
