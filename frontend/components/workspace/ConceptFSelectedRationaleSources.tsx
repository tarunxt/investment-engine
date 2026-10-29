'use client';
import {useState} from 'react';
import type {StockConsensus} from '@/app/console/_components/FinalActionablesConsole';
import {ConceptFRationalePairs} from './ConceptFRationalePairs';
import {ConceptFDetailPanel} from './ConceptFDetailPanel';
import {ConceptFSavedText} from './ConceptFSavedText';
/** Parent supplies only the already verified explicit Run/job projection. This view never acquires another source. */
export function ConceptFSelectedRationaleSources({sources,masked}:{sources:StockConsensus['rows'];masked:boolean}){
 const [active,setActive]=useState<{run:number;job:number;field:string;index:number;symbol:string;fingerprint:string}|null>(null);
 const candidate=active?sources[active.index]:undefined;
 const source=active&&candidate&&candidate.meta.runId===active.run&&candidate.meta.jobId===active.job&&candidate.cells['Stock Symbol']===active.symbol&&JSON.stringify([candidate.meta,candidate.cells])===active.fingerprint&&Object.hasOwn(candidate.cells,active.field)?candidate:undefined;
 if(sources.length>200)return <p role="status">Selected rationale sources exceed the explicit 200-row presentation bound. Inspect exact owned source jobs separately; no subset is presented as complete.</p>;
 return <section className="space-y-4" aria-label="Explicit selected rationale contributors"><h3 className="font-bold">Saved rationale by selected model source</h3><p>These are the actual recorded source strings and scores. Current formula averages, multipliers and temporary drafts above remain separate.</p>{sources.map((row,index)=><details key={row.meta.runId+':'+row.meta.jobId+':'+index}><summary className="min-h-11 cursor-pointer">Run {row.meta.runId} / job {row.meta.jobId} · {row.meta.provider}/{row.meta.model}</summary><ConceptFRationalePairs headers={Object.keys(row.cells)} row={row.cells} masked={masked} onOpen={field=>setActive({run:row.meta.runId,job:row.meta.jobId,field,index,symbol:row.cells['Stock Symbol'],fingerprint:JSON.stringify([row.meta,row.cells])})}/><a className="concept-f-text-link inline-flex min-h-11 items-center" href={'/console/jobs/'+row.meta.jobId}>Open complete owned source job →</a></details>)}{!sources.length&&<p>No selected saved rationale source is established.</p>}{active&&!source&&<p role="status">The exact saved rationale changed or is unavailable. Reopen the intended source; no replacement content is shown.</p>}{active&&source&&<ConceptFDetailPanel title={active.field+' · selected job '+active.job} onClose={()=>setActive(null)}>{masked?<p>Investment numbers are masked.</p>:<ConceptFSavedText key={active.run+':'+active.job+':'+active.index+':'+active.field} label={active.field+' · selected job '+active.job} value={source.cells[active.field]} masked={false}/>}</ConceptFDetailPanel>}</section>;
}
