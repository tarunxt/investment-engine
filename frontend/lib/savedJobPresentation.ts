/** Display only: recorded timestamps never establish provider execution duration. */
export function savedJobState(status:string){
 const value=status.toLowerCase();
 return value==='completed'?{label:'Complete',tone:'complete'}:value==='partial'?{label:'Partial',tone:'partial'}:value==='failed'?{label:'Error',tone:'error'}:{label:status||'Unknown',tone:'unknown'};
}
export function savedJobElapsed(start:string,end:string){
 const aware=(value:string)=>/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value);
 if(!aware(start)||!aware(end))return null;
 const a=Date.parse(start),b=Date.parse(end);return Number.isFinite(a)&&Number.isFinite(b)&&b>=a?Math.floor((b-a)/1000):null;
}
