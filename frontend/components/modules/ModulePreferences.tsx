'use client';
import {useState} from 'react';
import Link from 'next/link';
import {useModules} from '@/providers/ModuleProvider';
import {apiService,APIError} from '@/services/api';
import type {ModuleState} from '@/lib/modulePolicy';
type Impact={version:number;active_work:{queued_analysis:number;running_analysis:number;reason:string};dependent_modules:string[]};
export function ModulePreferences(){
 const {manifest,loading,error,refresh,save}=useModules();const [pending,setPending]=useState<string|null>(null);const [notice,setNotice]=useState<string|null>(null);const [failure,setFailure]=useState<string|null>(null);
 const [disable,setDisable]=useState<{module:ModuleState;impact:Impact}|null>(null);
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
 return <section id="modules" aria-labelledby="modules-title" className="space-y-5 border-t pt-6">
  <div><h2 id="modules-title" className="text-xl font-semibold">Modules</h2><p className="mt-1 text-sm text-muted-foreground">Choose the tools for your workspace. Selecting a module does not connect accounts, spend credits, resume schedules or authorize orders.</p></div>
  {loading&&<p role="status">Loading your modules…</p>}
  {(error||failure)&&<div role="alert" className="rounded-lg border border-red-300 p-4"><p>{failure||error}</p><button type="button" className="mt-2 underline" onClick={()=>void refresh()}>Reload module preferences</button></div>}
  {notice&&<p role="status" className="rounded-lg border p-3">{notice}</p>}
  {manifest&&!manifest.modules.some(m=>m.selection.enabled)&&<div className="rounded-xl border border-indigo-200 bg-indigo-50 p-4 text-indigo-950"><h3 className="font-semibold">Start with the modules you need</h3><p className="text-sm">Your profile is ready. Select a module below, then review its setup and eligibility. Each account keeps its own selections and connections.</p></div>}
  <div className="grid gap-4 sm:grid-cols-2">{manifest?.modules.map(module=>{
   const selected=module.selection.enabled,available=module.availability.available,ready=module.capabilities.view?.allowed===true;
   const status=!available?'Unavailable':!selected?'Not selected':ready?'Selected':'Selected · setup or eligibility required';
   return <article key={module.module_id} className="rounded-xl border bg-card p-5" data-module-id={module.module_id}>
    <div className="flex items-start justify-between gap-3"><div><h3 className="font-semibold">{module.label}</h3><p className="mt-1 text-sm" id={'module-status-'+module.module_id}>{status}</p></div>
     <input type="checkbox" aria-label={`Select ${module.label}`} aria-describedby={'module-status-'+module.module_id} checked={selected} disabled={!!pending||(!available&&!selected)} onChange={()=>void toggle(module)} className="mt-1 size-5 accent-indigo-600" />
    </div>
    {!available&&<p className="mt-3 text-sm text-muted-foreground">{module.availability.reason||'This module has not passed its launch gate.'}</p>}
    {selected&&<div className="mt-3 space-y-2 text-sm text-muted-foreground"><p>Connection: {module.connection.state.replaceAll('_',' ')} · {module.connection.kind.replaceAll('_',' ')}</p>
     {!ready&&<p>Policy: {Array.from(new Set(Object.values(module.capabilities).flatMap(c=>c.reasons))).map(x=>x.toLowerCase().replaceAll('_',' ')).join('; ')}</p>}
     <p>{module.selection.schedules_paused?'Schedules paused. Selection never resumes work.':'Schedule eligibility still requires a fresh worker check.'}</p>
     <Link className="inline-block underline" href={manifest.presentation.connections_path}>Review connection setup</Link>
    </div>}
    {pending===module.module_id&&<p role="status" className="mt-2 text-sm">Checking and saving…</p>}
   </article>;
  })}</div>
  <p className="text-sm text-muted-foreground">Core profile, security, connections and safety activity remain available. <Link className="underline" href="/console/profile/activity">Open safety activity</Link>.</p>
  {disable&&<div role="alertdialog" aria-modal="true" aria-labelledby="disable-title" aria-describedby="disable-description" onKeyDown={e=>{if(e.key==='Escape'&&!pending)setDisable(null);if(e.key==='Tab'){const buttons=Array.from(e.currentTarget.querySelectorAll<HTMLButtonElement>('button:not(:disabled)'));const first=buttons[0],last=buttons[buttons.length-1];if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}} className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
   <div className="max-h-[90vh] w-full max-w-lg overflow-auto rounded-xl border bg-background p-6 shadow-xl"><h3 id="disable-title" className="text-lg font-semibold">Disable {disable.module.label}?</h3><div id="disable-description" className="my-4 space-y-2 text-sm"><p>{disable.impact.active_work.queued_analysis} queued analysis; {disable.impact.active_work.running_analysis} running analysis.</p><p>Queued work will be cancelled, running work receives a stop request, and schedules pause. Already accepted effects may finish. Data and connections are retained; this does not liquidate positions.</p><p>{disable.impact.active_work.reason}</p></div><div className="flex gap-4"><button autoFocus type="button" disabled={!!pending} onClick={()=>setDisable(null)} className="rounded-lg border px-4 py-2">Keep selected</button><button type="button" disabled={!!pending||disable.impact.version!==manifest?.version} onClick={()=>void update(disable.module,false)} className="rounded-lg bg-destructive px-4 py-2 text-destructive-foreground">Confirm disable</button></div></div>
  </div>}
 </section>;
}
