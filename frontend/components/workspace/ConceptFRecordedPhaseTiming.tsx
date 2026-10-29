'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {ConceptFPhaseIntervals} from './ConceptFPhaseIntervals';
import {URLs} from '@/lib/urls';
import {apiService} from '@/services/api';
import {admitTimingJob,recordedTiming,type TimingJob} from '@/lib/recordedTiming';
type Props={owner:number;research:number;stage:string;jobId?:number|null;provider?:string;model?:string;start?:string|null;end?:string|null};
export function ConceptFRecordedPhaseTiming(props:Props){
 const {data:session,status}=useSession();const scope=`${session?.user?.id}:${session?.generation}:${props.owner}:${props.research}:${props.stage}:${props.jobId}:${props.start}:${props.end}:${props.provider}:${props.model}`;
 const [saved,setSaved]=useState<{scope:string;job:TimingJob|null;failed:boolean}|null>(null);
 useEffect(()=>{const abort=new AbortController();if(status!=='authenticated'||Number(session?.user?.id)!==props.owner||!Number.isSafeInteger(props.jobId)||!props.jobId||props.jobId<1||!props.provider||!props.model)return()=>abort.abort();
 void apiService.get<unknown>(URLs.jobs.get(props.jobId!),{signal:abort.signal,cache:'no-store',timeoutMs:8000}).then(value=>{const job=admitTimingJob(value,props.jobId!,{provider:props.provider!,model:props.model!});if(!abort.signal.aborted)setSaved({scope,job,failed:false});}).catch(()=>{if(!abort.signal.aborted)setSaved({scope,job:null,failed:true});});return()=>abort.abort();
 },[scope,status,session?.user?.id,props.owner,props.jobId,props.provider,props.model]);
 const current=status==='authenticated'&&Number(session?.user?.id)===props.owner&&saved?.scope===scope?saved:null,timing=recordedTiming(props.start,props.end,current?.job?[current.job]:null);
 return <ConceptFPhaseIntervals timing={timing} failed={current?.failed} inconsistent={!!current?.job&&!timing.complete}/>;
}
