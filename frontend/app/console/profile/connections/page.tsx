'use client';
import Link from 'next/link';
import {useState} from 'react';
import {ConnectionAuthorization} from '@/components/connections/ConnectionAuthorization';
import {ConnectionBindings} from '@/components/connections/ConnectionBindings';
import {useModules} from '@/providers/ModuleContext';
export default function ConnectionsPage(){
 const [bindingsRevision,setBindingsRevision]=useState(0);
 const {manifest,loading,error,refresh}=useModules();
 return <section className="space-y-5"><h1 className="text-xl font-semibold">Connection setup</h1><ConnectionBindings key={bindingsRevision}/><ConnectionAuthorization onChanged={()=>setBindingsRevision(value=>value+1)}/><p>Connections belong to your account. Module selection does not connect an account or authorize an operation.</p>{loading&&<p role="status">Loading connection readiness…</p>}{error&&<p role="alert">{error} <button onClick={()=>void refresh()}>Retry</button></p>}
 {manifest?.modules.filter(m=>m.selection.enabled).map(module=>{
  const surface=manifest.presentation.surfaces.find(s=>s.module_ids.length===1&&s.module_ids[0]===module.module_id);
  const ready=module.capabilities.view?.allowed===true;
  return <article className="space-y-2 rounded-xl border p-5" key={module.module_id}><h2 className="font-semibold">{module.label}</h2><p>{module.connection.kind.replaceAll('_',' ')} · {module.connection.state.replaceAll('_',' ')}</p><p className="text-sm text-muted-foreground">{!module.availability.available?module.availability.reason:!ready?'Eligibility or connection readiness has not been verified. This screen does not read credentials or bypass the provider launch gate.':'Review the existing integration screen. Any connection or operation still requires its normal authorization.'}</p>{ready&&surface&&<Link className="underline" href={surface.path}>Open {module.label} setup</Link>}</article>;
 })}
 {manifest&&!manifest.modules.some(m=>m.selection.enabled)&&<p>Choose modules before reviewing their setup.</p>}<Link className="underline" href="/console/profile/preferences#modules">Open module Preferences</Link></section>;
}
