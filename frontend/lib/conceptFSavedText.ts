import {safeResearchData} from './conceptFResearch';
/** Bounded complete text navigation, with whole-source redaction before splitting. */
export function savedTextPages(value:unknown):{state:'missing'|'empty'|'restricted'|'over_bound'|'available';pages:string[]}{
 if(typeof value!=='string')return {state:'missing',pages:[]};
 if(!value.length)return {state:'empty',pages:[]};
 if(new TextEncoder().encode(value).length>256000)return {state:'over_bound',pages:[]};
 if(safeResearchData(value)==='[Restricted]')return {state:'restricted',pages:[]};
 const pages:string[]=[];
 for(let start=0;start<value.length;){let end=Math.min(start+16000,value.length);if(end<value.length&&value.charCodeAt(end-1)>=0xd800&&value.charCodeAt(end-1)<=0xdbff&&value.charCodeAt(end)>=0xdc00&&value.charCodeAt(end)<=0xdfff)end--;pages.push(value.slice(start,end));start=end;}
 return {state:'available',pages};
}
