'use client';
import Link from 'next/link';
import {useCallback,useSyncExternalStore,useState} from 'react';
import {useSession} from 'next-auth/react';
import {useModules} from '@/providers/ModuleContext';
import {onboardingSteps,onboardingDestination,progressKey,progressValue,readProgress,type OnboardingStep} from '@/lib/onboarding';
const subscribe=(notify:()=>void)=>{window.addEventListener('storage',notify);window.addEventListener('credx-onboarding',notify);return()=>{window.removeEventListener('storage',notify);window.removeEventListener('credx-onboarding',notify);};};
const labels={modules:'Choose modules',connection:'Connect or import one module',snapshot:'Validate your snapshot',research:'Review research setup',plan:'View your plan'};
export function GettingStarted(){
 const {data:session,status}=useSession();
 if(status!=='authenticated'||!session?.user?.id)return <p role="status">Sign in to resume your private setup.</p>;
 return <OwnedGettingStarted key={`${session.user.id}:${session.generation}`} owner={String(session.user.id)}/>;
}
function OwnedGettingStarted({owner}:{owner:string}){
 const {manifest,loading,error}=useModules();const [storageError,setStorageError]=useState(false),[choice,setChoice]=useState('');
 const snapshot=useCallback(()=>{try{return readProgress(localStorage.getItem(progressKey(owner)),owner);}catch{return 'modules' as const;}},[owner]);
 const step=useSyncExternalStore(subscribe,snapshot,()=> 'modules' as const);
 const loaded=useSyncExternalStore(subscribe,()=>true,()=>false);
 const selected=manifest?.owner_id===Number(owner)?manifest.modules.filter(m=>m.selection.enabled):[];
 const chosen=selected.find(m=>m.module_id===choice)??selected[0];
 function navigate(next:OnboardingStep){try{localStorage.setItem(progressKey(owner),progressValue(owner,next));window.dispatchEvent(new Event('credx-onboarding'));}catch{setStorageError(true);}}
 const destination=chosen&&onboardingDestination(chosen.module_id,step);
 return <section className="mx-auto max-w-3xl space-y-6"><header><h1 className="text-3xl font-semibold">Get started at your pace</h1><p className="mt-2">Set up one selected module first. Your other selections, accounts and existing history stay available.</p></header>
 <p className="rounded-xl border p-4">Setup never starts research or submits orders. Research needs a deliberate start after reviewing inputs and usage; a completed plan still needs separate exact order review.</p>
 <nav aria-label="Setup steps" className="flex flex-wrap gap-2">{onboardingSteps.map(value=><button key={value} type="button" disabled={!loaded} aria-current={step===value?'step':undefined} onClick={()=>navigate(value)} className="min-h-11 rounded-lg border px-3 py-2 aria-[current=step]:bg-muted">{labels[value]}</button>)}</nav>
 {(loading||!loaded)&&<p role="status">Restoring your setup…</p>}{error&&<p role="alert">Module status unavailable. No connection or research is started.</p>}{storageError&&<p role="status">This browser could not save your setup position. Your server records are unchanged.</p>}
 <article className="space-y-4 rounded-xl border p-5"><h2 className="text-xl font-semibold">{labels[step]}</h2>
 {step==='modules'?<><p>Select only the modules you need. Nothing is preselected by this guide.</p><Link className="underline" href="/console/profile/preferences#modules">Choose or review my modules</Link></>:<>
 {selected.length>0?<label className="block">Continue with one module<select className="mt-2 block min-h-11 max-w-full rounded border bg-background px-3" value={chosen?.module_id??''} onChange={event=>setChoice(event.target.value)}>{selected.map(m=><option key={m.module_id} value={m.module_id}>{m.label}</option>)}</select></label>:<p>Choose a module first. No optional module data has been requested.</p>}
 {chosen&&!chosen.availability.available?<p role="status">{chosen.label} is selected but unavailable: {chosen.availability.reason??'Launch eligibility is not verified.'}</p>:destination?<Link className="inline-flex min-h-11 items-center rounded-lg border px-4" href={destination}>Open {labels[step].toLowerCase()}</Link>:chosen?<p>This module has no qualified guided setup. Its existing workspace and eligibility controls remain authoritative.</p>:null}
 {step==='connection'&&<p>Use the supported authorization screen and confirm account identity. Own-app configuration is optional advanced setup when supported. In UAT2, the connection screen explicitly offers fake modes only; it never requests real brokerage credentials.</p>}
 {step==='snapshot'&&<p>A successful connection does not prove valid holdings. Review the source timestamp, currency, cash, duplicate rows and unresolved instruments. US imports require preview and explicit acceptance; malformed or partial data must be corrected there.</p>}
 {step==='research'&&<p>Review the account, accepted snapshot, assumptions and usage before starting. Navigating here does not launch paid work. Existing durable runs can be resumed from My Activity.</p>}
 {step==='plan'&&<p>Open the versioned result from the research run. This guide does not claim that a plan exists, that research completed, or that any order was approved.</p>}
 </>}
 </article><div className="flex flex-wrap gap-4"><Link className="min-h-11 underline" href="/console/dashboard">Skip for now · open my workspace</Link><Link className="min-h-11 underline" href="/console/profile/activity">Resume existing activity</Link>{process.env.NEXT_PUBLIC_UAT2==='true'&&<Link className="min-h-11 underline" href="/console/profile/connections">Explore explicitly fake sample setup</Link>}</div><p className="text-sm text-muted-foreground">Only your place in this guide is saved in this browser, separately for each account. Connection, snapshot, research and plan status come from their original server records. No completion or conversion rate is inferred.</p></section>;
}
