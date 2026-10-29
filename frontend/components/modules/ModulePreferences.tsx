'use client';
import {useEffect,useRef,useState} from 'react';
import Link from 'next/link';
import {WalletMinimal} from 'lucide-react';
import {useModules} from '@/providers/ModuleContext';
import {apiService,APIError} from '@/services/api';
import type {ModuleState} from '@/lib/modulePolicy';
type Impact={version:number;active_work:{queued_analysis:number;running_analysis:number;reason:string};dependent_modules:string[]};
export function ModulePreferences({moduleIds,presentation='full'}:{moduleIds?:string[];presentation?:'full'|'compact'|'onboarding'|'profile'}={}){
 const compact=presentation==='compact'||presentation==='profile';
 const {manifest,loading,error,refresh,save}=useModules();const [pending,setPending]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);const [failure,setFailure]=useState<string|null>(null);
 const trigger=useRef<HTMLInputElement|null>(null);const dialogWasOpen=useRef(false);
 const [disable,setDisable]=useState<{module:ModuleState;impact:Impact}|null>(null);
 useEffect(()=>{if(disable)dialogWasOpen.current=true;else if(dialogWasOpen.current){dialogWasOpen.current=false;trigger.current?.focus();}},[disable]);
 async function update(module:ModuleState,enabled:boolean){
  setPending(module.module_id);setFailure(null);setNotice(null);
  try{await save(module.module_id,enabled);setNotice(`${module.label} ${enabled?'selected':'disabled'}. Accounts and data are retained. Schedules remain paused.`);setDisable(null);}
  catch(e){setDisable(null);setFailure(e instanceof APIError&&e.status===409?'Preferences changed or this module is unavailable. Current server preferences were reloaded; review before trying again.':e instanceof Error?e.message:'Could not save module preferences.');}
  finally{setPending(null);}
 }
 async function toggle(module:ModuleState){
  if(!module.selection.enabled){await update(module,true);return;}
  setPending(module.module_id);setFailure(null);
  try{const impact=await apiService.fetch<Impact>('/backend-api/me/modules/disable-impact',{method:'POST',body:JSON.stringify({expected_version:manifest!.version,module_ids:[module.module_id]})});setDisable({module,impact});}
  catch(e){setFailure(e instanceof Error?e.message:'Disable impact unavailable. No selection changed.');await refresh();}
  finally{setPending(null);}
 }
 return <section id="modules" aria-labelledby="modules-title" className={presentation==='onboarding'?'space-y-5':compact?'space-y-3 pt-4':'space-y-5 border-t pt-6'}>
  <div className={presentation!=='full'?'sr-only':undefined}><h2 id="modules-title" className="text-xl font-semibold">Modules</h2><p className="mt-1 text-sm text-muted-foreground">Choose the tools for your workspace. Selecting a module does not connect accounts, spend credits, resume schedules or authorize orders.</p></div>
  {loading&&<p role="status">Loading your modules…</p>}
  {(error||failure)&&<div role="alert" className="rounded-lg border border-red-300 p-4"><p>{failure||error}</p><button type="button" className="mt-2 underline" onClick={()=>void refresh()}>Reload module preferences</button></div>}
  {notice&&<p role="status" className="rounded-lg border p-3">{notice}</p>}
  {manifest&&!manifest.modules.some(m=>m.selection.enabled)&&<div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-indigo-950"><h3 className="font-semibold">Start with the modules you need</h3><p className="text-sm">Your profile is ready. Select a module below, then review its setup and eligibility. Each account keeps its own selections and connections.</p></div>}
  <div className={compact?'grid gap-3':'grid gap-4 sm:grid-cols-2'}>{manifest?.modules.filter(module=>!moduleIds||moduleIds.includes(module.module_id)).map(module=>{
   const selected=module.selection.enabled,available=module.availability.available,ready=module.capabilities.view?.allowed===true;
   const status=!available?'Unavailable':!selected?'Not selected':ready?'Selected':'Selected · setup or eligibility required';
   return <article key={module.module_id} className={presentation==='onboarding'?'concept-f-module-choice flex flex-col rounded-xl border bg-card p-5':compact?'relative rounded-xl border bg-muted/30 p-3':'rounded-xl border bg-card p-5'} data-presentation={presentation} data-selected={selected?'true':'false'} data-module-id={module.module_id}>
    {presentation==='profile'&&<WalletMinimal aria-hidden="true" className="concept-f-profile-module-icon"/>}
    <div className={compact?'flex min-h-11 items-center justify-between gap-3 pr-24':'flex items-start justify-between gap-3'}><div>{presentation==='onboarding'&&<span className="mb-5 inline-flex rounded-lg bg-teal-50 px-3 py-1 text-xs font-semibold text-teal-800">{module.module_id==='zerodha_rebalance'?'INR':'USD'}</span>}<h3 className={presentation==='onboarding'?'text-2xl font-bold':'font-semibold'}>{(presentation==='onboarding'||presentation==='profile')&&module.module_id==='zerodha_rebalance'?'Zerodha':(presentation==='onboarding'||presentation==='profile')&&module.module_id==='indmoney_us'?'INDmoney':module.label}</h3>{presentation==='onboarding'&&<p className="my-3 text-sm text-muted-foreground">{module.module_id==='zerodha_rebalance'?'Review a simulated Indian portfolio.':'Import and review a US snapshot.'}</p>}{presentation==='profile'&&<p className="mt-1 text-sm text-muted-foreground">{module.module_id==='zerodha_rebalance'?'INR portfolio and research':'USD snapshot and manual review'}</p>}{presentation!=='onboarding'&&<p className={presentation==='profile'?'sr-only':'mt-1 text-sm'} id={'module-status-'+module.module_id}>{status}</p>}</div>
     <label className={compact?'absolute right-3 top-3 inline-flex size-11 items-center justify-center':undefined}><input type="checkbox" aria-label={`Select ${module.label}`} aria-describedby={'module-status-'+module.module_id} checked={selected} disabled={!!pending||(!available&&!selected)} onChange={event=>{trigger.current=event.currentTarget;void toggle(module);}} className={presentation==='profile'?'peer sr-only':'mt-1 size-5 accent-indigo-600'} />{presentation==='profile'&&<span aria-hidden="true" className="concept-f-profile-module-switch peer-focus-visible:outline-2 peer-focus-visible:outline-offset-4">{selected?'On':'Off'}</span>}</label>
    </div>
    {presentation==='onboarding'&&<p className="mt-auto pt-8 text-sm font-semibold" id={'module-status-'+module.module_id}>{status}</p>}
    {!available&&<p className="mt-3 text-sm text-muted-foreground">{module.availability.reason||'This module has not passed its launch gate.'}</p>}
    {selected&&presentation!=='onboarding'&&<details open={presentation==='full'?true:undefined} className={compact?'space-y-2 text-sm text-muted-foreground open:mt-3':'mt-3 space-y-2 text-sm text-muted-foreground'}><summary aria-label={compact?`Connection and policy details for ${module.label}`:undefined} className={compact?'absolute right-14 top-3 inline-flex min-h-11 min-w-11 cursor-pointer items-center justify-center rounded-lg text-lg':'sr-only'}>{compact?<><span aria-hidden="true">ⓘ</span><span className="sr-only">Connection and policy details</span></>:'Connection and policy details'}</summary><p>Connection: {module.connection.state.replaceAll('_',' ')} · {module.connection.kind.replaceAll('_',' ')}</p>
     {!ready&&<p>Policy: {Array.from(new Set(Object.values(module.capabilities).flatMap(c=>c.reasons))).map(x=>x.toLowerCase().replaceAll('_',' ')).join('; ')}</p>}
     <p>{module.selection.schedules_paused?'Schedules paused. Selection never resumes work.':'Schedule eligibility still requires a fresh worker check.'}</p>
     <Link className="inline-block underline" href={manifest.presentation.connections_path}>Review connection setup</Link>
    </details>}
    {pending===module.module_id&&<p role="status" className="mt-2 text-sm">Checking and saving…</p>}
   </article>;
  })}</div>
  {presentation!=='onboarding'&&<p className={compact?'flex flex-wrap items-center gap-4 text-xs text-muted-foreground':'text-sm text-muted-foreground'}>{presentation==='full'&&'Core profile, security, connections and safety activity remain available. '}<Link className="underline" href="/console/profile/activity">Open safety activity</Link>{compact?<Link className="underline" href="/console/profile/modules">Discover all modules →</Link>:'.'}</p>}
  {disable&&<div role="alertdialog" aria-modal="true" aria-labelledby="disable-title" aria-describedby="disable-description" onKeyDown={e=>{if(e.key==='Escape'&&!pending)setDisable(null);if(e.key==='Tab'){const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
   <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border bg-background p-6 shadow-xl"><h3 id="disable-title" className="text-lg font-semibold">Disable {disable.module.label}?</h3><div id="disable-description" className="my-4 space-y-2 text-sm"><p>{disable.impact.active_work.queued_analysis} queued analysis; {disable.impact.active_work.running_analysis} running analysis.</p><p>Queued work will be cancelled, running work receives a stop request, and schedules pause. Already accepted effects may finish. Data and connections are retained; this does not liquidate positions.</p><p>{disable.impact.active_work.reason}</p></div><div className="flex gap-4"><button autoFocus type="button" disabled={!!pending} onClick={()=>setDisable(null)} className="rounded-lg border px-4 py-2">Keep selected</button><button type="button" disabled={!!pending||disable.impact.version!==manifest?.version} onClick={()=>void update(disable.module,false)} className="rounded-lg bg-destructive px-4 py-2 text-destructive-foreground">Confirm disable</button></div></div>
  </div>}
 </section>;
}
