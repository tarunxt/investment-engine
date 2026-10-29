import {safeResearchData} from './conceptFResearch';
const secret=/(credential|password|secret|authorization|access.?token|refresh.?token|api.?key|cookie|private.?key)/i;
/** Complete within explicit bounds; never silently truncate a frozen variable or diagnostic preview. */
export function savedStructureText(value:unknown):{state:'available'|'missing'|'blocked';text?:string;reason?:string}{
 if(value===undefined)return {state:'missing'};
 const seen=new WeakSet<object>();
 function copy(item:unknown,depth:number):unknown{
  if(depth>12)throw Error('Nested structure exceeds the supported 12-level bound.');
  if(typeof item==='string')return safeResearchData(item)==='[Restricted]'?'[Restricted]':item;
  if(typeof item==='number'&&!Number.isFinite(item))throw Error('Non-finite source number is unsupported.');
  if(item&&typeof item==='object'){
   if(seen.has(item))throw Error('Repeated or cyclic structure is unsupported.');seen.add(item);
   const entries=Object.entries(item);if(entries.length>200)throw Error('Collection exceeds the supported 200-entry bound.');
   const result=Array.isArray(item)?item.map(child=>copy(child,depth+1)):Object.fromEntries(entries.map(([key,child])=>[key,secret.test(key)?'[Restricted]':copy(child,depth+1)]));seen.delete(item);return result;
  }
  return item;
 }
 try{const text=JSON.stringify(copy(value,0),null,2);if(typeof text!=='string')return {state:'missing'};if(new TextEncoder().encode(text).length>256000)throw Error('Structure exceeds the supported 256,000-byte bound.');return {state:'available',text};}catch(error){return {state:'blocked',reason:error instanceof Error?error.message:'Saved structure could not be safely represented.'};}
}
