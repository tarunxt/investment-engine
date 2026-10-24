'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {apiService} from '@/services/api';
import {usePathname} from 'next/navigation';
import {useModules} from '@/providers/ModuleContext';
import {moduleScopeKey,surfaceAllowed,surfaceVisible} from '@/lib/modulePolicy';
export function ModuleRouteGate({children}:{children:React.ReactNode}){
 const path=usePathname();const {manifest,loading,error,refresh}=useModules();
 const resource=path.match(/^\/console\/(jobs|runs)\/(\d+)$/);
 const resourcePath=resource?'/backend-api/me/modules/resource-access/'+resource[1]+'/'+resource[2]:null;
 const revision=moduleScopeKey(manifest);
 const ownerId=manifest?.owner_id;
 const [access,setAccess]=useState<{key:string;allowed:boolean}|null>(null);
 const accessKey=resourcePath+':'+revision;
 useEffect(()=>{
  if(!resourcePath||ownerId==null)return;
  const controller=new AbortController();
  apiService.fetch<{owner_id:number;allowed:boolean}>(resourcePath,{signal:controller.signal,cache:'no-store'}).then(data=>{if(!controller.signal.aborted)setAccess({key:accessKey,allowed:data.owner_id===ownerId&&data.allowed===true});}).catch(()=>{if(!controller.signal.aborted)setAccess({key:accessKey,allowed:false});});
  return()=>controller.abort();
 },[resourcePath,accessKey,ownerId]);
 // These account and safety screens never depend on optional selections.
 const core=['/console/profile','/console/apis','/console/uat2'].some(p=>path===p||path.startsWith(p+'/'));
 if(core)return children;
 if(loading)return <p role="status">Loading your module preferences…</p>;
 if(!manifest)return <section role="alert"><h1>Module preferences unavailable</h1><p>{error||'Optional data is paused until your preferences can be verified.'}</p><button onClick={()=>void refresh()}>Retry preferences</button><p><Link href="/console/profile/preferences">Open Preferences</Link></p></section>;
 if(['/console/dashboard','/console/jobs','/console/runs'].includes(path)&&!manifest.modules.some(m=>m.selection.enabled))return <section className="mx-auto max-w-2xl space-y-4 rounded-2xl border p-8"><h1 className="text-2xl font-semibold">Choose your modules</h1><p>Your account starts with no modules. Choose the tools you want, then complete their connection setup.</p><p>Selecting a module never starts analysis, schedules or orders.</p><Link className="underline" href="/console/profile/preferences#modules">Choose modules in Preferences</Link></section>;
 if(path==='/console/dashboard'&&!['/console/zerodha','/console/indmoney-us','/console/bullpen-ai'].some(p=>surfaceAllowed(manifest,p)))return <section className="space-y-5"><h1 className="text-2xl font-semibold">Your workspace</h1><p>Your selected modules appear below. Portfolio data is not requested for this workspace.</p><div className="grid gap-4 sm:grid-cols-2">{manifest.modules.filter(m=>m.selection.enabled).map(module=>{const surface=manifest.presentation.surfaces.find(s=>s.module_ids.length===1&&s.module_ids[0]===module.module_id);return <article key={module.module_id} className="rounded-xl border p-5"><h2 className="font-semibold">{module.label}</h2>{surface&&surfaceAllowed(manifest,surface.path)?<Link href={surface.path} className="underline">Open {module.label}</Link>:<p>{!module.availability.available?module.availability.reason||'Temporarily unavailable.':'Setup or eligibility required.'} <Link href="/console/profile/connections" className="underline">Review setup</Link></p>}</article>;})}</div><Link href="/console/profile/preferences#modules" className="underline">Manage modules</Link></section>;
 if(resourcePath&&access?.key!==accessKey)return <p role="status">Checking owned resource access…</p>;
 if((resourcePath&&!access?.allowed)||!surfaceVisible(manifest,path)||!surfaceAllowed(manifest,path))return <section className="space-y-3 rounded-2xl border p-8"><h1 className="text-xl font-semibold">{surfaceVisible(manifest,path)?'Setup or eligibility required':'Module unavailable or disabled'}</h1><p>This screen is paused. No module data was requested.</p><Link className="underline" href="/console/profile/preferences#modules">Open module Preferences</Link><p><Link href="/console/profile/connections">Connection setup</Link></p></section>;
 return <div key={revision}>{children}</div>;
}
