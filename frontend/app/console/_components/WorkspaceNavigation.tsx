'use client';
import Link from 'next/link';
import {useModules} from '@/providers/ModuleContext';
import {surfaceFor,surfaceVisible} from '@/lib/modulePolicy';
import type {User} from '@/hooks/useAuth';

export function WorkspaceNavigation({pathname,user,onNavigate,onLogout}:{pathname:string;user?:User|null;onNavigate:()=>void;onLogout?:()=>Promise<void>}){
 const {manifest,loading,error}=useModules();
 const modules=(manifest?.modules??[]).filter(m=>m.selection.enabled).flatMap(module=>{
  const path=manifest?.presentation.surfaces.filter(s=>s.module_ids.length===1&&s.module_ids[0]===module.module_id).sort((a,b)=>a.path.length-b.path.length)[0]?.path;
  return path&&surfaceVisible(manifest,path)?[{...module,path}]:[];
 });
 const activeModules=surfaceFor(manifest,pathname)?.module_ids??[];
 const link=(href:string,label:string,module?:string)=><Link key={href} href={href} prefetch={false} onClick={onNavigate} aria-current={pathname===href||href!=='/console/dashboard'&&pathname.startsWith(href+'/')||module&&activeModules.includes(module)?'page':undefined} className="flex min-h-11 items-center rounded-lg px-3 py-2 text-sm font-medium hover:bg-sidebar-accent aria-[current=page]:bg-sidebar-accent aria-[current=page]:text-sidebar-accent-foreground focus-visible:outline-2 focus-visible:outline-offset-2">{label}</Link>;
 return <div className="flex h-full min-h-0 flex-col">
  <nav aria-label="Workspace" className="min-h-0 flex-1 space-y-1 overflow-y-auto px-3 pb-4">
   {link('/console/dashboard','Dashboard')}
   {loading?<p role="status" className="px-3 py-2 text-xs text-muted-foreground">Loading your modules…</p>:error?<p role="status" className="px-3 py-2 text-xs text-muted-foreground">Module data paused. Core pages remain available.</p>:null}
   {modules.map(m=>link(m.path,m.label+(!m.availability.available?' · Unavailable':m.connection.state==='missing'?' · Setup needed':''),m.module_id))}
   {link('/console/profile/activity','My Activity')}
   <div className="my-3 border-t border-sidebar-border" />
   {link('/console/profile/connections','Connections')}
   {link('/console/profile/usage','Usage & plan')}
   {link('/console/help','Help')}
   {user?.role==='admin'?<><div className="my-3 border-t border-sidebar-border" />{link('/console/admin','Administrator workspace')}</>:null}
  </nav>
  <details className="relative shrink-0 border-t border-sidebar-border p-3">
   <summary className="min-h-11 cursor-pointer truncate rounded-lg px-2 py-3 text-sm font-medium" aria-label="Account menu">{user?.full_name?.trim()||user?.email||'Your account'}</summary>
   <div className="absolute inset-x-3 bottom-full z-40 max-h-[60dvh] space-y-1 overflow-y-auto rounded-xl border border-border bg-background p-2 shadow-lg">
    {link('/console/profile','Profile')}{link('/console/profile/preferences#modules','My modules')}
    {link('/console/profile/preferences','Notifications & appearance')}{link('/console/profile/security','Security & privacy')}
    <button type="button" onClick={()=>{onNavigate();void onLogout?.();}} className="min-h-11 w-full rounded-lg px-3 text-left text-sm hover:bg-muted">Sign out</button>
   </div>
  </details>
 </div>;
}
