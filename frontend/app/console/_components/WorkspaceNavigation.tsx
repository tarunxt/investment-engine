'use client';
import Link from 'next/link';
import {Activity,ArrowUpRight,Bot,BriefcaseBusiness,ChevronRight,Copy,Globe2,HelpCircle,LayoutDashboard,LogOut,Plug2,ReceiptText,ScanSearch,Settings2,Sheet,ShieldCheck,Sparkles,Trophy,UserRound,type LucideIcon} from 'lucide-react';
import {useModules} from '@/providers/ModuleContext';
import {surfaceFor,surfaceVisible} from '@/lib/modulePolicy';
import type {User} from '@/hooks/useAuth';
import {SidebarThemeToggle} from './SidebarThemeToggle';

export function WorkspaceNavigation({pathname,user,onNavigate,onLogout}:{pathname:string;user?:User|null;onNavigate:()=>void;onLogout?:()=>Promise<void>}){
 const {manifest,loading,error}=useModules();
 const modules=(manifest?.modules??[]).filter(m=>m.selection.enabled).flatMap(module=>{
  const path=manifest?.presentation.surfaces.filter(s=>s.module_ids.length===1&&s.module_ids[0]===module.module_id).sort((a,b)=>a.path.length-b.path.length)[0]?.path;
  return path&&surfaceVisible(manifest,path)?[{...module,path}]:[];
 });
 const activeModules=surfaceFor(manifest,pathname)?.module_ids??[];
 const identity=user?.full_name?.trim()||user?.email||'Your account';
 const initials=identity.split(/\s+/).slice(0,2).map(part=>part[0]).join('').toUpperCase();
 function link(href:string,label:string,Icon:LucideIcon,module?:string,notice?:string){
  const exact=href==='/console/dashboard'||href==='/console/profile';
  const active=pathname===href||!exact&&!href.includes('#')&&pathname.startsWith(href+'/')||!!module&&activeModules.includes(module);
  return <Link key={href} href={href} prefetch={false} onClick={onNavigate} aria-current={active?'page':undefined}
   className="group flex min-h-11 min-w-0 items-center gap-3 rounded-xl border border-transparent px-3 py-2.5 text-sm font-medium text-sidebar-foreground/75 transition-colors hover:bg-sidebar-accent hover:text-sidebar-accent-foreground aria-[current=page]:border-sidebar-border aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-primary aria-[current=page]:shadow-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring focus-visible:ring-offset-2 focus-visible:ring-offset-sidebar">
   <Icon aria-hidden="true" focusable="false" className="size-5 shrink-0 text-muted-foreground group-aria-[current=page]:text-sidebar-primary"/>
   <span className="min-w-0 flex-1 break-words">{label}{notice&&<span className="mt-0.5 block text-[11px] font-normal text-muted-foreground">{notice}</span>}</span>
   {module&&<ChevronRight aria-hidden="true" focusable="false" className="size-3.5 shrink-0 text-muted-foreground/70"/>}
  </Link>;
 }
 const heading=(label:string)=><p className="px-3 pb-2 pt-4 text-[10px] font-semibold uppercase tracking-[0.18em] text-muted-foreground">{label}</p>;
 const investment=modules.filter(m=>['zerodha_rebalance','indmoney_us'].includes(m.module_id));
 const other=modules.filter(m=>!['zerodha_rebalance','indmoney_us'].includes(m.module_id));
 const moduleIcons:Record<string,LucideIcon>={zerodha_rebalance:BriefcaseBusiness,indmoney_us:Globe2,bullpen_research:Sparkles,bullpen_live:Bot,copy_trader:Copy,prediction_direct:Bot,market_scanner:ScanSearch,ai_studio:Sparkles,sheets_export:Sheet,sports_rankings:Trophy};
 const moduleLink=(m:typeof modules[number])=>link(m.path,m.label,moduleIcons[m.module_id]??BriefcaseBusiness,m.module_id,!m.availability.available?'Unavailable':m.connection.state==='missing'?'Setup needed':undefined);
 return <div className="flex h-full min-h-0 flex-col">
  <nav aria-label="Workspace" className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-3 pb-3">
   {heading('Home')}{link('/console/dashboard','Dashboard',LayoutDashboard)}{link('/console/profile/activity','My Activity',Activity)}
   {loading?<p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading your modules…</p>:error?<p role="status" className="px-3 py-2 text-xs text-muted-foreground">Module data paused. Core pages remain available.</p>:null}
   {investment.length>0&&<section aria-label="Investing" className="space-y-1">{heading('Investing')}{investment.map(moduleLink)}</section>}
   {other.length>0&&<section aria-label="Selected tools" className="space-y-1">{heading('Your tools')}{other.map(moduleLink)}</section>}
   {heading('Workspace')}{link('/console/profile/connections','Connections',Plug2)}{link('/console/help','Help',HelpCircle)}
   {user?.role==='admin'&&<>{heading('Administration')}{link('/console/admin','Administrator workspace',ShieldCheck)}</>}
  </nav>
  <div className="max-h-[55dvh] shrink-0 space-y-3 overflow-y-auto border-t border-sidebar-border bg-sidebar px-3 pb-3 pt-3">
   <section aria-label="Your account" className="rounded-2xl border border-sidebar-border bg-sidebar-accent/40 p-2">
    <div className="mb-1 flex min-w-0 items-center gap-2.5 px-2 py-2">
     <span aria-hidden="true" className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-xs font-semibold text-white shadow-sm">{initials}</span>
     <div className="min-w-0"><p className="text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">Account</p><p className="truncate text-sm font-semibold text-sidebar-foreground">{identity}</p></div>
    </div>
    {link('/console/profile','Profile',UserRound)}{link('/console/profile/preferences','Preferences',Settings2)}{link('/console/profile/usage','Usage & plan',ReceiptText)}
   </section>
   <SidebarThemeToggle key={user?.id??'signed-out'}/>
   <div className="flex items-center justify-between gap-2 px-2"><Link href="/console/profile/privacy" prefetch={false} onClick={onNavigate} className="inline-flex min-h-11 items-center gap-1 text-xs text-muted-foreground underline underline-offset-4 focus-visible:ring-2 focus-visible:ring-sidebar-ring">Privacy & exports<ArrowUpRight aria-hidden="true" focusable="false" className="size-3"/></Link>
    <button type="button" onClick={()=>{onNavigate();void onLogout?.();}} className="inline-flex min-h-11 items-center gap-2 rounded-lg px-2 text-xs text-sidebar-foreground/75 hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring"><LogOut aria-hidden="true" focusable="false" className="size-4"/>Sign out</button></div>
  </div>
 </div>;
}
