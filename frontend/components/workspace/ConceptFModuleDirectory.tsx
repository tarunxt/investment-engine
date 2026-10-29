'use client';
import {useState} from 'react';
import Link from 'next/link';
import {useSession} from 'next-auth/react';
import {useModules} from '@/providers/ModuleContext';
import {surfaceAllowed,type ModuleState} from '@/lib/modulePolicy';
import {directoryInventory} from '@/lib/conceptFDirectoryInventory';
import {legacyDirectorySections} from '@/lib/conceptFDirectory';

export function ConceptFModuleDirectory(){
 const {data:session,status}=useSession();const {manifest,loading,error,refresh}=useModules();
 const [filter,setFilter]=useState('all');
 if(status!=='authenticated'||!session?.user?.id)return <p role="status">Verifying your private module directory…</p>;
 if(error||manifest&&manifest.owner_id!==Number(session.user.id)||!manifest&&!loading)return <section role="alert" className="concept-f-card space-y-3"><h1 className="text-xl font-bold">Module directory unavailable</h1><p>Your current private policy could not be verified. No module availability or access is inferred.</p><button className="concept-f-secondary" onClick={()=>void refresh()}>Reload private module policy</button></section>;
 if(!manifest)return <p role="status">Loading your private module policy…</p>;
 const modules=manifest.modules.filter(m=>filter==='selected'?m.selection.enabled:filter==='restricted'?(!m.availability.available||m.selection.enabled&&m.capabilities.view?.allowed!==true):true);
 // Reference display groups only. All policy, membership records and grants stay server-authored.
 const areas=[
  {id:'portfolios',label:'Zerodha / INDmoney',ids:['zerodha_rebalance','indmoney_us'],access:'Selected navigation + dashboard',rule:'Only selected modules appear'},
  {id:'bullpen',label:'Bullpen',ids:['bullpen_research','bullpen_live'],access:'Module directory → details',rule:'Availability must be verified'},
  {id:'sports-predictions',label:'Sports / Polymarket',ids:['sports_rankings','prediction_direct'],access:'Module directory → details',rule:'Separate restricted surfaces'},
  {id:'copy-trader',label:'Live Copy Trader',ids:['copy_trader'],access:'Module directory → details',rule:'Do not imply live readiness'},
  {id:'research-utilities',label:'Scanner / AI Studio / Sheets',ids:['market_scanner','ai_studio','sheets_export'],access:'Module directory → details',rule:'Verify scope and permissions'},
 ];
 const groups=areas.map(area=>({...area,members:modules.filter(m=>area.ids.includes(m.module_id))})).filter(area=>area.members.length);
 function renderModule(m:ModuleState){return <article key={m.module_id} data-directory-module-id={m.module_id} className="my-3 space-y-3 rounded-lg border bg-card p-4">
  <h3 className="font-semibold">{m.label}</h3><dl className="space-y-2 text-sm"><div><dt>Your selection</dt><dd>{m.selection.enabled?'Selected':'Not selected'}</dd></div><div><dt>Availability</dt><dd>{m.availability.available?'Availability verified':m.availability.reason??'Unavailable in this runtime'}</dd></div><div><dt>Connection</dt><dd>{m.connection.state}</dd></div><div><dt>View permission</dt><dd>{m.capabilities.view?.allowed?'Allowed by current policy':m.capabilities.view?.reasons.length?m.capabilities.view.reasons.join(', ').replaceAll('_',' ').toLowerCase():'Not allowed; reason unverified'}</dd></div><div><dt>Requirements</dt><dd>{m.requires.length?m.requires.join(', '):'No additional requirements supplied'}</dd></div></dl>
  <Link className="concept-f-text-link min-h-11" href="/console/profile/preferences#modules">Review selection in Preferences</Link>
  {directoryInventory.some(row=>row.module_id===m.module_id)&&<details className="border-t pt-3"><summary className="min-h-11 cursor-pointer">Mapped legacy controls · source inventory</summary><p className="my-3 text-xs text-muted-foreground">These are retained source labels, not implemented controls or runtime grants. No optional data is requested by opening this list.</p><ul className="list-disc space-y-2 pl-5">{directoryInventory.filter(row=>row.module_id===m.module_id).map(row=><li key={row.id} data-directory-source-id={row.id}><span className="text-xs text-muted-foreground">{row.id} · </span>{row.feature}</li>)}</ul></details>}
  {legacyDirectorySections[m.module_id]?.map(area=><details key={area.path} className="border-t pt-3"><summary className="min-h-11 cursor-pointer">{area.label} · source inventory</summary><p className="py-2 text-xs text-muted-foreground">Legacy source is retained; runtime availability is a separate check.</p><ul className="list-disc space-y-2 pl-5">{area.features.map(feature=><li key={feature}>{feature}</li>)}</ul>{surfaceAllowed(manifest,area.path)?<Link className="concept-f-text-link mt-3 inline-block min-h-11" href={area.path} prefetch={false}>Open authorized section →</Link>:<p className="mt-3 text-xs">Unavailable under current selection or runtime policy. This entry activates nothing.</p>}</details>)}
 </article>;}
 return <section className="concept-f-directory space-y-6"><header><h1 className="text-3xl font-bold">One place for module discovery</h1><p className="mt-2 text-sm text-muted-foreground">Profile / modules / optional areas remain discoverable</p></header>
  <nav aria-label="Module directory filters" className="concept-f-tabs">{[['all','All modules'],['selected','Selected'],['restricted','Restricted / unavailable']].map(([value,label])=><button key={value} type="button" aria-pressed={filter===value} onClick={()=>setFilter(value)}>{label}</button>)}</nav>
  <section className="concept-f-card"><h2>Module directory</h2><p className="my-3 text-sm text-muted-foreground">Not every legacy feature is implemented or available in UAT2.</p>
   {loading?<p role="status">Loading module policy…</p>:<div className="overflow-x-auto"><table className="concept-f-table"><thead><tr><th>Area</th><th>Proposed access</th><th>Status / rule</th></tr></thead><tbody>
    {groups.map(area=><tr key={area.id}><th>{area.label}</th><td>{area.access}<small className="mt-1 block text-muted-foreground">{area.members.filter(m=>m.selection.enabled).length} selected / {area.members.length} returned modules</small></td><td><details><summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3"><span>{area.rule}</span><span className="shrink-0 text-primary">Inspect scope</span></summary>{area.members.map(renderModule)}</details></td></tr>)}
    {filter!=='selected'&&<tr><th>Admin / database / maintenance</th><td>Separate authorized area</td><td><details><summary className="flex min-h-11 cursor-pointer items-center justify-between gap-3"><span>Never ordinary-user sidebar</span><span className="shrink-0 text-primary">Inspect scope</span></summary><p className="my-3 text-sm">Administration, database tools and outbound delivery retain separate authorization. These source labels establish no runtime access, delivery or live readiness.</p><ul className="list-disc space-y-2 pl-5">{directoryInventory.filter(row=>row.module_id===null).map(row=><li key={row.id} data-directory-source-id={row.id}><span className="text-xs text-muted-foreground">{row.id} · </span>{row.feature}</li>)}</ul></details></td></tr>}
   </tbody></table></div>}{!groups.length&&filter==='selected'&&!loading&&<p className="py-5">No modules match this filter.</p>}
   <p className="mt-6 text-sm text-muted-foreground">Legacy labels are retained as inventory entries, not promises of shipped support. Selection, availability, entitlement and readiness remain separate checks. No provider or schedule is activated here.</p>
  </section>
 </section>;
}
