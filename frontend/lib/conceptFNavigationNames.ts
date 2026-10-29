/** Labels and ranking only. These functions never replace canonical destinations. */
export function navigationLabel(value:unknown,canonical:string){
 const label=typeof value==='string'?value.replace(/[\p{Cc}\p{Cf}]/gu,' ').trim().slice(0,48):'';
 return {label:label||canonical,canonical,custom:!!label&&label!==canonical};
}
export function navigationRank(href:string,orderedHrefs:readonly string[]){
 const index=orderedHrefs.indexOf(href);return index<0?Number.MAX_SAFE_INTEGER:index;
}
