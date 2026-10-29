'use client';
import {useEffect,useState} from 'react';
import {useSession} from 'next-auth/react';
import {apiService} from '@/services/api';
import {URLs} from '@/lib/urls';
import {admitFrozenJobPrompt,type FrozenPromptBinding} from '@/lib/frozenJobPrompt';
import {ConceptFSavedText} from './ConceptFSavedText';
import type {Workflow} from '@/app/console/automated-rebalance/_components/ServerAnalysis';
export function ConceptFFrozenJobPrompt({row,stage,masked}:{row:Workflow;stage?:Workflow['stages'][number];masked:boolean}){
 const {data:session,status}=useSession(),target=stage?row.inputs.plan?.stages?.[stage.stage]:undefined;
 const jobId=stage?.job_id,stageKey=stage?.stage,provider=target?.provider,model=target?.model,promptVersion=target?.prompt_version,planVersion=row.inputs.plan?.version;
 const scope=[session?.user?.id,session?.generation,row.owner_id,row.id,row.portfolio,stageKey,jobId,row.inputs.source_hash,row.inputs.plan_hash,provider,model,promptVersion,planVersion].join(':');
 const [saved,setSaved]=useState<{scope:string;prompt?:string;failed?:boolean}|null>(null);
 const ready=Boolean(Number.isSafeInteger(row.id)&&row.id>0&&['india','indmoney_us'].includes(row.portfolio)&&['threats','swing','rebalance','technical'].includes(stageKey??'')&&[provider,model,promptVersion,planVersion].every(value=>typeof value==='string'&&value.length>0)&&status==='authenticated'&&Number(session?.user?.id)===row.owner_id&&!masked&&Number.isSafeInteger(jobId)&&Number(jobId)>0&&provider&&model&&promptVersion&&planVersion&&/^[a-f0-9]{64}$/.test(row.inputs.source_hash)&&/^[a-f0-9]{64}$/.test(row.inputs.plan_hash));
 useEffect(()=>{const abort=new AbortController();if(!ready)return()=>abort.abort();const expected:FrozenPromptBinding={job:jobId!,research:row.id,stage:stageKey!,portfolio:row.portfolio,provider:provider!,model:model!,sourceHash:row.inputs.source_hash,planHash:row.inputs.plan_hash,promptVersion:promptVersion!,planVersion:planVersion!};
  void apiService.get<unknown>(URLs.jobs.get(expected.job),{signal:abort.signal,cache:'no-store',timeoutMs:8000}).then(value=>{const prompt=admitFrozenJobPrompt(value,expected);if(!abort.signal.aborted)setSaved({scope,prompt});}).catch(()=>{if(!abort.signal.aborted)setSaved({scope,failed:true});});return()=>abort.abort();
 },[ready,scope,row.id,row.owner_id,row.portfolio,row.inputs.source_hash,row.inputs.plan_hash,planVersion,jobId,stageKey,provider,model,promptVersion]);
 const current=ready&&saved?.scope===scope?saved:null;
 return masked?<p>Investment numbers are masked. Reveal deliberately in Profile before reading the saved request.</p>:!ready?<p role="status">Exact saved Job/model/plan binding is not recorded or the current owner is not verified. No request is reconstructed.</p>:!current?<p role="status">Reading the exact owned saved request…</p>:current.failed?<p role="alert">Saved request could not be verified against this exact research, stage and plan. No other Job or template is substituted.</p>:<ConceptFSavedText key={scope} label={'Job '+jobId+' exact frozen request'} value={current.prompt} masked={false}/>;
}
