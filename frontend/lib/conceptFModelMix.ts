export const modelMixResource='investment-engine:model-mixes:v1';
export const protectedSystemMix='compatible-models-system';
export type SavedMix={id:string;name:string;targets:string[];[key:string]:unknown};
export function readModelMixes(raw:string|null):SavedMix[]{
 if(raw===null)return [];
 const data:unknown=JSON.parse(raw);
 if(!Array.isArray(data)||data.length>200)throw new Error('Saved template inventory requires review');
 const ids=new Set<string>();
 for(const x of data){if(!x||typeof x!=='object'||typeof x.id!=='string'||!x.id||x.id.length>160||ids.has(x.id)||typeof x.name!=='string'||!x.name.trim()||x.name.length>160||x.locked!==undefined&&typeof x.locked!=='boolean'||!Array.isArray(x.targets)||!x.targets.length||x.targets.length>100||x.targets.some((key:unknown)=>typeof key!=='string'||key.length>256||!/^.{1,100}::.{1,150}$/.test(key)))throw new Error('Saved template format requires review; original retained');ids.add(x.id);}
 return data;
}
export function renameMix(items:SavedMix[],id:string,name:string):SavedMix[]{
 if(id===protectedSystemMix||items.find(item=>item.id===id)?.locked===true)throw new Error('System templates are protected');
 const cleaned=name.trim();if(!cleaned||cleaned.length>160||items.some(x=>x.id!==id&&x.name.toLocaleLowerCase()===cleaned.toLocaleLowerCase()))throw new Error('Use a unique bounded template name');
 if(!items.some(x=>x.id===id))throw new Error('Current template required');
 return items.map(item=>item.id===id?{...item,name:cleaned,updated_at:new Date().toISOString()}:item);
}

export function isProtectedMix(mix:SavedMix|undefined){return !!mix&&(mix.id===protectedSystemMix||mix.locked===true);}
export function splitMixTarget(key:string){
 const pieces=key.split('::');
 if(pieces.length!==2||!pieces[0]||!pieces[1]||pieces[0].length>100||pieces[1].length>150||/[\r\n\t]/.test(key))throw new Error('Ambiguous historical target; original mix retained');
 return {provider:pieces[0],model:pieces[1]};
}
export function mixCatalogue(items:SavedMix[],recorded?:string){
 const keys=[...new Set([...(recorded?[recorded]:[]),...items.flatMap(item=>item.targets)])];
 if(keys.length>200)throw new Error('Historical catalogue exceeds the 200-row editor bound; no partial mix is substituted');
 return keys.map(key=>({key,...splitMixTarget(key)}));
}
export function mixCounts(targets:string[]){
 const result:Record<string,number>={};for(const key of targets){splitMixTarget(key);result[key]=(result[key]??0)+1;}return result;
}
export function expandMixDraft(counts:Record<string,number>,catalogue:string[],mode:'single'|'multiple'){
 const entries=Object.entries(counts);
 if(!entries.length||entries.some(([key,count])=>!catalogue.includes(key)||!Number.isSafeInteger(count)||count<1||count>100))throw new Error('Choose known targets with whole multipliers from 1 to 100');
 const total=entries.reduce((sum,[,count])=>sum+count,0);
 if(total>100)throw new Error('The preserved template contract allows at most 100 target entries; nothing was truncated');
 if(mode==='single'&&(entries.length!==1||total!==1))throw new Error('This stage needs one model with multiplier 1; the original mix is retained');
 return entries.flatMap(([key,count])=>Array.from({length:count},()=>key));
}
