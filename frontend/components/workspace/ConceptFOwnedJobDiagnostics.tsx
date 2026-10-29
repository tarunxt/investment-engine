'use client';
import {useEffect,useRef,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';
import {URLs} from '@/lib/urls';
import {admitDiagnosticJob,type DiagnosticJob} from '@/lib/conceptFDiagnostics';
import {ConceptFSavedDiagnostics} from './ConceptFSavedDiagnostics';
export function ConceptFOwnedJobDiagnostics({owner,research,version,stage,jobId,provider,model}:{owner:number;research:number;version:number;stage:string;jobId?:number|null;provider?:string;model?:string}){
 const{data:session,status}=useSession();const scope=JSON.stringify([session?.user?.id,session?.generation,owner,research,version,stage,jobId,provider,model]);
 const[saved,setSaved]=useState<{scope:string;state:'pending'|'failed'|'ready';job?:DiagnosticJob}|null>(null);const active=useRef<AbortController|null>(null);
 useEffect(()=>()=>{active.current?.abort();active.current=null;},[scope]);
 const permitted=status==='authenticated'&&Number(session?.user?.id)===owner&&Number.isSafeInteger(owner)&&owner>0&&Number.isSafeInteger(research)&&research>0&&Number.isSafeInteger(version)&&version>=0&&['sync','threats','swing','rebalance','technical','actionables'].includes(stage)&&Number.isSafeInteger(jobId)&&!!jobId&&jobId>0&&!!provider&&!!model;
 const current=permitted&&saved?.scope===scope?saved:null;
 async function read(){if(!permitted||active.current)return;const abort=new AbortController();active.current=abort;setSaved({scope,state:'pending'});try{const raw=await apiService.fetch(URLs.jobs.get(jobId!),{signal:abort.signal,cache:'no-store',timeoutMs:8000});const job=admitDiagnosticJob(raw,jobId!,{provider:provider!,model:model!});if(!abort.signal.aborted)setSaved({scope,state:'ready',job});}catch{if(!abort.signal.aborted)setSaved({scope,state:'failed'});}finally{if(active.current===abort)active.current=null;}}
 if(!permitted)return <p>No exact current-owner job/provider/model binding is available for this stage. No diagnostic request is made.</p>;
 if(current?.state==='ready'&&current.job)return <ConceptFSavedDiagnostics job={current.job} onClose={()=>setSaved(null)}/>;
 return <div className="space-y-3"><button className="concept-f-secondary" disabled={current?.state==='pending'} onClick={()=>void read()}>{current?.state==='pending'?'Reading exact saved diagnostic job…':'Read exact saved job diagnostics'}</button>{current?.state==='failed'&&<p role="alert">Exact saved diagnostic job could not be admitted. No other record, retry safety or financial outcome is inferred.</p>}<p>Read-only owner-authorized job inspection. Reading starts no model, retry or execution; changing owner, session generation or source version clears this presentation.</p></div>;
}
