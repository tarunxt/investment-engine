export type TimingJob={id:number;provider:string;model:string;status:string;created_at:string;updated_at:string};
function stamp(value:unknown){
 if(typeof value!=='string')return null;
 const match=/^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})(?:\.\d+)?(?:Z|[+-](\d{2}):(\d{2}))$/i.exec(value);if(!match)return null;
 const [,y,m,d,h,minute,second,oh,om]=match,year=Number(y),month=Number(m),day=Number(d),leap=year%4===0&&(year%100!==0||year%400===0);
 const days=[31,leap?29:28,31,30,31,30,31,31,30,31,30,31];
 if(month<1||month>12||day<1||day>days[month-1]||Number(h)>23||Number(minute)>59||Number(second)>59||Number(oh??0)>23||Number(om??0)>59)return null;
 const n=Date.parse(value);return Number.isFinite(n)?n:null;
}
/** Intervals from saved timestamps, not measured provider phases or a live clock. */
export function recordedTiming(start:unknown,end:unknown,jobs:TimingJob[]|null){
 const a=stamp(start),b=stamp(end),total=a!==null&&b!==null&&b>=a?(b-a)/1000:null;
 const unknown={total,dispatch:null,finalisation:null,jobs:[] as {id:number;provider:string;model:string;seconds:number}[],parallel:false,complete:false};
 if(total===null||a===null||b===null||!jobs?.length||jobs.length>100||new Set(jobs.map(j=>j.id)).size!==jobs.length)return unknown;
 const windows=jobs.map(job=>({job,a:stamp(job.created_at),b:stamp(job.updated_at)}));
 if(windows.some(w=>!Number.isSafeInteger(w.job.id)||w.job.id<1||!['completed','partial','failed','cancelled'].includes(w.job.status)||w.a===null||w.b===null||w.b<w.a||w.a<a||w.b>b))return unknown;
 const intervals=windows.map(w=>({id:w.job.id,provider:w.job.provider,model:w.job.model,seconds:(w.b!-w.a!)/1000}));
 return {total,dispatch:(Math.min(...windows.map(w=>w.a!))-a)/1000,finalisation:(b-Math.max(...windows.map(w=>w.b!)))/1000,jobs:intervals,parallel:windows.some((w,i)=>windows.some((other,j)=>i<j&&w.a!<other.b!&&other.a!<w.b!)),complete:true};
}
export type RecordedTiming=ReturnType<typeof recordedTiming>;
/** Legacy read endpoints explicitly compare naive audit timestamps as UTC. */
export function legacyUtcTimestamp(value:string){return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value)?value+'Z':value;}
export function admitTimingJob(value:unknown,id:number,expected:{provider:string;model:string}):TimingJob{
 const job=value as TimingJob;
 if(!job||typeof job.provider!=='string'||!job.provider||typeof job.model!=='string'||!job.model||job.id!==id||job.provider!==expected.provider||job.model!==expected.model||typeof job.status!=='string'||typeof job.created_at!=='string'||typeof job.updated_at!=='string')throw new Error('Exact saved timing job required');
 // This endpoint serializes TimestampMixin's explicit datetime.utcnow values without a zone.
 const utc=legacyUtcTimestamp;
 return {id:job.id,provider:job.provider,model:job.model,status:job.status,created_at:utc(job.created_at),updated_at:utc(job.updated_at)};
}
