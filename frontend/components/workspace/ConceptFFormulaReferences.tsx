'use client';
import {useState,type ReactNode} from 'react';
import {ConceptFFormulaSourceVersion,type FormulaSourceBinding} from './ConceptFFormulaSourceVersion';
import type {AdvisoryRevision} from '@/lib/conceptFAdvisoryRevision';
import {formulaGroups,formulaDraft,applyFormulaDraft} from '@/lib/conceptFFormulaDraft';
import type {ScoreMatrixFormulaConfig} from '@/app/console/_components/FinalActionablesConsole';

type ReferenceLabel={key:string;label:string;range?:string};
type ActionLabel={category:string;label:string};
/** Read-only references retain current/historical provenance; edits stay explicit. */
export function ConceptFFormulaReferences({config,onSave,onView,sourceLabel,validationNotice,bindings,advisoryRevision,technicalConfidenceBounds,symbolLabels,actionLabels}:{
 validationNotice?:ReactNode;config:ScoreMatrixFormulaConfig;onSave:(next:ScoreMatrixFormulaConfig)=>boolean;
 onView?:(view:string)=>void;sourceLabel?:string;advisoryRevision?:AdvisoryRevision|null;
 bindings?:FormulaSourceBinding[];technicalConfidenceBounds?:{min:number;max:number};
 symbolLabels?:ReferenceLabel[];actionLabels?:ActionLabel[];
}){
 const [pane,setPane]=useState('Reference tables');
 const [editing,setEditing]=useState(false),[draft,setDraft]=useState<Record<string,string>>({});
 const [denominator,setDenominator]=useState(''),[error,setError]=useState<string|null>(null);
 const value=(number:unknown)=>typeof number==='number'&&Number.isFinite(number)?number:'Not verified';
 const label=(key:string,group:string)=>group==='scoreSymbolThresholds'?symbolLabels?.find(row=>row.key===key)?.label??key:group==='actionScores'?actionLabels?.find(row=>row.category===key)?.label??key:key;
 const thresholdRows=symbolLabels?.length?symbolLabels.map(row=>({...row,value:(config.scoreSymbolThresholds as Record<string,number>)[row.key]})):Object.entries(config.scoreSymbolThresholds).map(([key,value])=>({key,label:key,value,range:undefined as string|undefined}));
 const actionKeys=[...new Set([...(actionLabels??[]).map(row=>row.category),...Object.keys(config.actionScores)])];
 const confidenceKnown=technicalConfidenceBounds&&Number.isFinite(technicalConfidenceBounds.min)&&Number.isFinite(technicalConfidenceBounds.max)&&technicalConfidenceBounds.min<=technicalConfidenceBounds.max;
 function begin(){setDraft(formulaDraft(config));setDenominator(config.detailedRationaleDenominator===null?'':String(config.detailedRationaleDenominator));setError(null);setEditing(true);}
 function save(){try{const next=applyFormulaDraft(config,draft,denominator);if(onSave(next))setEditing(false);}catch(error){setError(error instanceof Error?error.message:'Formula draft is invalid');}}
 return <section aria-label="Formula references workspace" className="concept-f-formula-references space-y-5">
  <header><h3 className="text-2xl font-bold lg:text-3xl">Formula references, with verification made visible</h3><p className="mt-2 text-sm">Actionables → Calculations → Score matrix → Reference tables</p></header>
  {validationNotice}
  <nav className="concept-f-tabs" aria-label="Formula reference workspace">
   <button aria-label="Open selected detailed rationale" disabled={!onView} onClick={()=>onView?.('Detailed rationale')}>Detailed rationale</button>
   <button aria-pressed={pane==='Reference tables'} onClick={()=>setPane('Reference tables')}>Reference tables</button>
   <button aria-pressed={pane==='Source version'} onClick={()=>setPane('Source version')}>Source version</button>
  </nav>
  {pane==='Source version'?<ConceptFFormulaSourceVersion config={config} sourceLabel={sourceLabel} bindings={bindings} advisoryRevision={advisoryRevision}/>:<>
   <p className="text-sm">Current owner-local advisory values only. Historical formula versions, current funds and order eligibility are not established.</p>
   <div className="grid gap-5 lg:grid-cols-2" aria-label="Active advisory reference tables">
    <section className="concept-f-card min-w-0 space-y-3" aria-label="Action score mapping">
     <h4 className="font-bold">Action score mapping</h4><p className="text-sm">Exact source action categories and aliases; zero is retained. Saved-Run numeric mappings are not recorded by this contract.</p>
     <div tabIndex={0} role="region" aria-label="Scrollable formula reference table" className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-primary"><table className="concept-f-table"><thead><tr><th scope="col">Action</th><th scope="col">Score</th><th scope="col">Value status</th></tr></thead><tbody>{actionKeys.map(key=>{const number=(config.actionScores as Record<string,number>)[key];return <tr key={key}><th scope="row">{label(key,'actionScores')}</th><td>{value(number)}</td><td>{value(number)==='Not verified'?'Not verified':'Current advisory'}</td></tr>;})}</tbody></table></div>
    </section>
    <section className="concept-f-card min-w-0 space-y-3" aria-label="Confidence multiplier reference">
     <h4 className="font-bold">Confidence multiplier reference</h4>
     <p className="text-sm">{confidenceKnown?'Current code technical confidence input range: '+technicalConfidenceBounds.min+' to '+technicalConfidenceBounds.max+'.':'Confidence source range not supplied; no numeric band is inferred.'} The original direction multiplier follows approved setup or technical bias. No score-dependent band is fabricated.</p>
     <div tabIndex={0} role="region" aria-label="Scrollable formula reference table" className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-primary"><table className="concept-f-table"><thead><tr><th scope="col">Score range</th><th scope="col">Technical Scan</th><th scope="col">Multiplier</th></tr></thead><tbody>{Object.entries(config.technicalScanMultipliers).map(([key,number])=><tr key={key}><td>No score-dependent band</td><th scope="row">{key}</th><td>{value(number)}</td></tr>)}</tbody></table></div>
     <p className="text-xs">Current direction values only. Historical confidence configuration is not established; no score or multiplier is fabricated.</p>
     <button className="concept-f-text-link min-h-11 block" disabled={!onView} onClick={()=>onView?.('Score matrix')}>Consolidation rules / mean–mode →</button>
     <button className="concept-f-text-link min-h-11 block" disabled={!onView} onClick={()=>onView?.('Matched rules')}>Units calculation / saved source version →</button>
    </section>
   </div>
   <section className="concept-f-card min-w-0 space-y-3" aria-label="Score Symbol thresholds">
    <h4 className="font-bold">{thresholdRows.length===6?'Score Symbol matrix · all six threshold controls':'Score Symbol matrix'}</h4><p className="text-sm">Current conditions run top-to-bottom after the original clamp: max(red minimum, min(3, score)). The first matching row wins. Historical score ranges: Not recorded for selected Run; no trade eligibility is established.</p>
    <div tabIndex={0} role="region" aria-label="Scrollable formula reference table" className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-primary"><table className="concept-f-table"><thead><tr><th scope="col">Symbol / threshold control</th><th scope="col">Current score condition</th><th scope="col">Current minimum</th><th scope="col">Source status</th></tr></thead><tbody>{thresholdRows.map(({key,label:rowLabel,value:number,range})=><tr key={key}><th scope="row"><span aria-hidden="true">{['strongPositive','positive','weakPositive'].includes(key)?'↑ ':['weakNegative','negative','strongNegative'].includes(key)?'↓ ':''}</span>{rowLabel}</th><td>{range??'Not verified'}</td><td>{value(number)}</td><td>{value(number)==='Not verified'?'Needs verified source':'Current advisory; historical unverified'}</td></tr>)}</tbody></table></div>
   </section>
   <details className="concept-f-card"><summary className="min-h-11 cursor-pointer font-semibold">Rationale multiplier reference and denominator</summary><p className="my-3 text-sm">All source-defined rationale parameters remain accessible; they are not extra confidence bands.</p><div tabIndex={0} role="region" aria-label="Scrollable formula reference table" className="overflow-x-auto outline-none focus-visible:ring-2 focus-visible:ring-primary"><table className="concept-f-table"><thead><tr><th scope="col">Parameter</th><th scope="col">Active advisory value</th><th scope="col">Value status</th></tr></thead><tbody>{Object.entries(config.detailedRationaleMultipliers).map(([key,number])=><tr key={key}><th scope="row">{key}</th><td>{value(number)}</td><td>{value(number)==='Not verified'?'Not verified':'Current advisory'}</td></tr>)}</tbody></table></div><p className="mt-3">Manual denominator: {config.detailedRationaleDenominator===null?'Automatic source denominator':value(config.detailedRationaleDenominator)}.</p></details>
   <p className="text-sm">Historical configuration provenance is not established by these current values. Reference data is read-only here. A source change must be versioned before recalculation.</p>
   <details><summary className="min-h-11 cursor-pointer">Advanced owner-local advisory preferences</summary>
    <p className="my-3 text-sm">Saving affects only owner-local advisory calculations; it never changes frozen research, eligibility, orders or approvals.</p>
    {!editing?<button className="concept-f-secondary" onClick={begin}>Edit advisory formula references</button>:<fieldset className="space-y-5"><legend>Unsaved advisory reference draft</legend>{formulaGroups.map(group=><section key={group}><h4 className="my-3 font-semibold">{group.replaceAll(/([A-Z])/g,' $1')}</h4><div className="grid gap-3 sm:grid-cols-2">{Object.keys(config[group]).map(key=><label key={key} className="block text-sm">{label(key,group)}<input className="mt-2 block min-h-11 w-full rounded border p-2" aria-label={group+' '+key} inputMode="decimal" value={draft[group+':'+key]??''} onChange={event=>setDraft(previous=>({...previous,[group+':'+key]:event.target.value}))}/></label>)}</div></section>)}<label className="block">Reference manual denominator<input className="mt-2 block min-h-11 rounded border p-2" value={denominator} placeholder="Automatic source denominator" onChange={event=>setDenominator(event.target.value)}/></label><p className="text-xs">Blank denominator retains automatic calculation. All other fields need explicit finite numbers. Source parameter validation remains active.</p>{error&&<p role="alert">{error}</p>}<div className="flex flex-wrap gap-3"><button className="concept-f-secondary" onClick={save}>Save advisory formula references</button><button className="concept-f-secondary" onClick={()=>{setEditing(false);setError(null);}}>Discard reference draft</button></div></fieldset>}
   </details>
   <details><summary className="min-h-11 cursor-pointer">All active reference values</summary><pre className="max-h-96 overflow-auto whitespace-pre-wrap break-words text-xs">{JSON.stringify(config,null,2)}</pre></details>
  </>}
 </section>;
}
