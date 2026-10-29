'use client';
import Link from 'next/link';
import type {conceptFPortfolios} from '@/lib/conceptFDashboard';
import type {WorkspaceRun} from '@/lib/workspaceTask';
import {recordedCostTimestamp} from '@/lib/conceptFCostReceipts';
import {researchStateLabel} from '@/lib/researchProgress';
type Portfolio=ReturnType<typeof conceptFPortfolios>[number];
export function ConceptFMobileDashboard({portfolios,task,href,run,known,attention,critical=false,money,onMore}:{portfolios:Portfolio[];task:{reason:string;label:string}|null;href:string;run:WorkspaceRun|undefined;known:boolean;attention:number;critical?:boolean;money:(value:number|null|undefined,currency:string)=>string;onMore:()=>void}){
 const first=portfolios[0],saved=run&&Number.isSafeInteger(run.id)&&run.id>0&&portfolios.some(p=>p.allowed&&p.portfolio===run.portfolio)?run:null;
 if(!first)return null;
 const verifiedCount=(p:Portfolio)=>p.allowed&&p.snapshot&&Number.isSafeInteger(p.snapshot.holdings_count)&&p.snapshot.holdings_count>=0;
 const count=(p:Portfolio)=>verifiedCount(p)?p.snapshot!.holdings_count+' holdings · recorded snapshot':'No verified holding count';
 const urgent=critical||!known;
 const savedHref=saved?(saved.portfolio==='india'?'/console/zerodha':'/console/indmoney-us')+'/research?research='+saved.id+'&workspace=stage-overview':null;
 return <section aria-label="Mobile portfolio dashboard" className="space-y-4 md:hidden">
  <header><h1 className="text-2xl font-bold">Your portfolio</h1><p className="mt-3 inline-flex rounded bg-amber-50 px-3 py-1 text-xs font-bold text-amber-800">SIMULATION</p></header>
  <section aria-label={'Primary native portfolio '+first.currency} className="py-1"><p className="text-sm text-muted-foreground">{first.label} / {first.currency}</p><p className="my-2 text-3xl font-bold">{first.allowed?money(first.value,first.currency):'Unavailable'}</p><p className="text-xs text-teal-700 dark:text-teal-300">{count(first)}</p></section>
  <article className="concept-f-card relative"><p className="pr-10 text-sm text-muted-foreground">Next useful action</p>
   {!urgent&&task&&<details><summary aria-label="Why this action?" className="concept-f-text-link absolute right-2 top-2 inline-flex size-11 cursor-pointer list-none items-center justify-center rounded-full">?</summary><p className="my-3 text-sm">{task.reason} Opening this review does not start research or send orders.</p></details>}
   <h2 className="my-3 text-xl font-bold">{task?.label??'Review selected modules'}</h2>
   {urgent&&<p role="status" className="my-3 text-sm">{task?.reason??'Recorded safety status is unavailable. Inspect saved activity before any new instruction.'}</p>}
   <Link href={href} className="concept-f-primary flex w-full items-center justify-center">{task?.label??'Review modules'}</Link>
  </article>
  {portfolios.slice(1).map(p=>{const at=recordedCostTimestamp(p.snapshot?.captured_at),body=<><p className="text-sm text-muted-foreground">{p.label} / {p.currency}</p><p className="my-3 text-2xl font-bold">{p.allowed?money(p.value,p.currency):'Unavailable'}</p><p className={verifiedCount(p)?'sr-only':'text-xs text-muted-foreground'}>{count(p)}</p><p className="mt-2 text-xs text-amber-700 dark:text-amber-300">{at?<time dateTime={at} title={'Captured source instant: '+at}>As of {new Date(at).toLocaleDateString('en-GB',{day:'numeric',month:'short',timeZone:'UTC'})} UTC</time>:'Source time unavailable'} · check freshness</p></>;return <article className="concept-f-card" key={p.module.module_id}>{p.allowed?<Link aria-label={'Open '+p.label+' portfolio'} className="block rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" href={p.root+'/portfolio'}>{body}</Link>:body}</article>;})}
  <article className="concept-f-card">{saved&&savedHref?<Link aria-label="View saved details →" className="block rounded focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-primary" href={savedHref}><p className="text-sm text-muted-foreground">Recorded research activity</p><h2 className="my-1 text-lg font-bold">Research {saved.id} · {saved.status==='completed'?'Complete':researchStateLabel(saved.status)}</h2><span className="concept-f-text-link">View saved details →</span></Link>:<><p className="text-sm text-muted-foreground">Recorded research activity</p><h2 className="my-1 text-lg font-bold">Saved research unavailable</h2><p className="text-sm">No current research result is inferred from this missing projection.</p></>}</article>
  <button className="concept-f-text-link min-h-11" onClick={onMore}>More portfolio detail</button>
  <footer aria-label="Recorded safety status"><p className="text-sm">{known?attention+' recorded reviews need attention':'Recorded review status unknown'}</p><Link className="concept-f-text-link inline-flex min-h-11 items-center text-sm" href="/console/profile/activity">Inspect saved safety activity →</Link></footer>
 </section>;
}
