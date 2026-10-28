'use client';
import Link from 'next/link';
import {useEffect,useState} from 'react';
import {useRouter} from 'next/navigation';
import {useSession} from 'next-auth/react';
import {useModules} from '@/providers/ModuleContext';
import {allowedModule} from '@/lib/modulePolicy';
import {apiService} from '@/services/api';
import {moduleRoot} from './ModuleWorkspace';
export function LegacyResearchRoute(){const {data:session}=useSession();const {manifest}=useModules();const router=useRouter();const [error,setError]=useState(false);
 useEffect(()=>{const match=window.location.hash.match(/^#analysis-workflow-([1-9]\d{0,12})$/);if(!match||!session?.user?.id)return;const controller=new AbortController();void apiService.fetch<{owner_id:number;id:number;portfolio:'india'|'indmoney_us'}>('/backend-api/runs/analysis-workflows/'+match[1],{signal:controller.signal,cache:'no-store'}).then(row=>{if(row.owner_id!==Number(session.user.id)||row.id!==Number(match[1])||!['india','indmoney_us'].includes(row.portfolio)||!allowedModule(manifest,row.portfolio==='india'?'zerodha_rebalance':'indmoney_us'))throw new Error('Owned selected workflow required');if(!controller.signal.aborted)router.replace(moduleRoot(row.portfolio)+`/research#analysis-workflow-${row.id}`);}).catch(()=>{if(!controller.signal.aborted)setError(true);});return()=>controller.abort();},[session?.user?.id,session?.generation,manifest,router]);
 return <section className="space-y-4"><h1 className="text-2xl font-semibold">Choose your research workspace</h1><p>Research now belongs to its module and account. This legacy entry never starts another workflow.</p>{error&&<p role="alert">This workflow could not be verified for your current account and module access. No new research was started. Open My Activity to review retained records.</p>}{manifest?.modules.filter(m=>m.selection.enabled&&['zerodha_rebalance','indmoney_us'].includes(m.module_id)).map(m=><p key={m.module_id}><Link className="inline-flex min-h-11 items-center underline" href={moduleRoot(m.module_id==='zerodha_rebalance'?'india':'indmoney_us')+'/research'}>Open {m.label} research</Link></p>)}<Link className="underline" href="/console/profile/activity">Owned activity and recovery</Link></section>;
}
