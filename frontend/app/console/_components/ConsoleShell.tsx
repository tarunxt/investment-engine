'use client';

import { useEffect, useRef, useState, type CSSProperties } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import {
    HiOutlineMenu,
    HiOutlineX,
} from 'react-icons/hi';
import { URLs } from '@/lib/urls';
import {workspaceFocusable} from '@/lib/workspaceFocus';
import { stripRedirectToFromCurrentUrl } from '@/lib/authRedirect';
import {ConceptFHeader,ConceptFMobileNavigation} from '@/components/workspace/ConceptFNavigation';
import {WorkspaceDisplayProvider} from '@/components/workspace/WorkspaceDisplay';
import dynamic from 'next/dynamic';
const ModuleRouteGate = dynamic(() => import('@/components/modules/ModuleRouteGate').then(m=>m.ModuleRouteGate), {ssr:false,loading:()=> <p role="status">Loading workspace access…</p>});
const SidebarNavigation = dynamic(() => import('./WorkspaceNavigation').then(m=>m.WorkspaceNavigation), {ssr:false,loading:()=> <nav aria-label="Core navigation" className="space-y-3 px-4"><Link href="/console/dashboard">Dashboard</Link><Link href="/console/profile/preferences">My modules</Link><Link href="/console/help">Help</Link></nav>});

export function ConsoleShell({
    children,
}: {
    children: React.ReactNode;
}) {
    const consoleSidebarStyle = {
        '--console-sidebar-width': process.env.NEXT_PUBLIC_UAT2==='true'?'13.875rem':'16rem',
    } as CSSProperties;
    const conceptF=process.env.NEXT_PUBLIC_UAT2==='true';
    const { user, logout, loading, error } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const mobilePortfolioHeader=conceptF&&pathname==='/console/dashboard';
    const searchParams = useSearchParams();
    const researchHistory=conceptF&&(/^\/console\/auto-rebalance-runs\/(zerodha|indmoneyUs)\/[1-9][0-9]*$/.test(pathname)&&['model-history','rationale-detail','stock-evidence','calculation-sheet','formula-references'].includes(searchParams.get('workspace')??'')||/^\/console\/(zerodha|indmoney-us)\/final-actionables$/.test(pathname)&&['stock-flow','calculation-sheet','formula-references'].includes(searchParams.get('workspace')??''));
    const usResearchSummary=conceptF&&pathname==='/console/indmoney-us/research'&&searchParams.get('workspace')==='us-summary'&&/^[1-9][0-9]*$/.test(searchParams.get('research')??'');
    const diagnosticHistory=conceptF&&/^\/console\/auto-rebalance-runs\/(zerodha|indmoneyUs)\/[1-9][0-9]*$/.test(pathname)&&searchParams.get('workspace')==='model-history'&&searchParams.get('jobView')==='Diagnostics';
    const planCalculation=conceptF&&/^\/console\/(zerodha|indmoney-us)\/final-actionables$/.test(pathname)&&!['stock-flow','calculation-sheet','formula-references'].includes(searchParams.get('workspace')??'');
    const searchParamString = searchParams.toString();
    const hasRedirectToParam = searchParams.has('redirectTo');
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const sidebarRef=useRef<HTMLDivElement>(null);
    const triggerRef=useRef<HTMLButtonElement>(null);
    const [mobile,setMobile]=useState(false);
    useEffect(()=>{const media=window.matchMedia('(max-width: 1023px)');const update=()=>setMobile(media.matches);update();media.addEventListener('change',update);return()=>media.removeEventListener('change',update);},[]);
    useEffect(()=>{
      if(!sidebarOpen||!mobile)return;
      const root=sidebarRef.current;
      const trigger=triggerRef.current;
      const items=()=>workspaceFocusable(root);
      items()[0]?.focus();
      const keys=(event:KeyboardEvent)=>{if(event.key==='Escape'){event.preventDefault();setSidebarOpen(false);}if(event.key==='Tab'){const list=items(),first=list[0],last=list.at(-1);if(event.shiftKey&&document.activeElement===first){event.preventDefault();last?.focus();}else if(!event.shiftKey&&document.activeElement===last){event.preventDefault();first?.focus();}}};
      document.addEventListener('keydown',keys);
      return()=>{document.removeEventListener('keydown',keys);trigger?.focus();};
    },[sidebarOpen,mobile]);
    useEffect(() => {
        performance.mark('console-shell-rendered');
    }, []);
    useEffect(() => {
        if (!loading && !user) {
            router.replace(URLs.routes.login());
        }
    }, [loading, router, user]);

    useEffect(() => {
        if (!hasRedirectToParam) return;
        const cleanedUrl = stripRedirectToFromCurrentUrl(pathname, searchParamString);
        const currentUrl = searchParamString ? `${pathname}?${searchParamString}` : pathname;
        if (cleanedUrl !== currentUrl) {
            // Keep the App Router's internal state aligned with the cleaned URL.
            router.replace(cleanedUrl, { scroll: false });
        }
    }, [hasRedirectToParam, pathname, router, searchParamString]);
    return (
        <WorkspaceDisplayProvider owner={conceptF?user?.id??null:null}><div data-workspace-shell="authenticated" data-concept-f={conceptF?'true':undefined} className="min-h-screen bg-background text-foreground" style={consoleSidebarStyle}>
            <a href="#workspace-main" className="sr-only focus:not-sr-only focus:fixed focus:left-4 focus:top-2 focus:z-50 focus:rounded-lg focus:bg-background focus:p-3">Skip to main content</a>
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 z-20 bg-black/50 transition-opacity lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div
                ref={sidebarRef}
                inert={mobile&&!sidebarOpen}
                role={mobile&&sidebarOpen?"dialog":undefined}
                aria-modal={mobile&&sidebarOpen?true:undefined}
                aria-label="Workspace navigation"
                id="console-sidebar"
                className={`fixed inset-y-0 left-0 z-30 w-[min(92vw,var(--console-sidebar-width))] border-r border-border bg-sidebar text-sidebar-foreground shadow-lg transform transition-transform duration-300 ease-in-out lg:w-[var(--console-sidebar-width)] lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                    }`}
            >
                <div className="flex flex-col h-full">
                    <div className="flex h-16 shrink-0 items-center justify-between border-b border-sidebar-border px-5">
                      <Link href="/console/dashboard" prefetch={false} className="flex min-h-11 items-center gap-2.5 rounded-lg font-semibold tracking-tight text-sidebar-foreground focus-visible:ring-2 focus-visible:ring-sidebar-ring"><span aria-hidden="true" data-brand-mark className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white shadow-sm">{conceptF?<svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 18 9 11l5 3 7-10M3 21h18"/></svg>:"CX"}</span><span className="text-lg">Cred-X</span></Link>
                      <button type="button" onClick={()=>setSidebarOpen(false)} aria-label="Close navigation" className="min-h-11 min-w-11 rounded-lg lg:hidden"><HiOutlineX/></button>
                    </div>

                    {/* Navigation */}
                    <div className="flex-1 min-h-0 pt-3">
                        <SidebarNavigation
                            pathname={pathname}
                            researchHistory={researchHistory&&!diagnosticHistory} diagnosticHistory={diagnosticHistory} usResearchSummary={usResearchSummary}
                            planCalculation={planCalculation}
                            user={user}
                            onLogout={logout}
                            onNavigate={() => setSidebarOpen(false)}
                        />
                    </div>

                </div>
            </div>

            {/* Main content area */}
            <div className="lg:pl-[var(--console-sidebar-width)]">
                {conceptF&&<ConceptFHeader pathname={pathname} researchHistory={researchHistory&&!diagnosticHistory} diagnosticHistory={diagnosticHistory} usResearchSummary={usResearchSummary} planCalculation={planCalculation}/>}
                <div data-mobile-workspace-header data-portfolio-mobile-header={mobilePortfolioHeader?true:undefined} className="sticky top-0 z-10 flex h-16 data-[portfolio-mobile-header=true]:h-[4.75rem] items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
                <button
                    type="button"
                    ref={triggerRef}
                    onClick={event => {triggerRef.current=event.currentTarget;setSidebarOpen(true);}}
                    data-brand-navigation={mobilePortfolioHeader?true:undefined} className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-background p-2 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-primary data-[brand-navigation=true]:rounded-xl data-[brand-navigation=true]:border-transparent data-[brand-navigation=true]:bg-teal-600 data-[brand-navigation=true]:text-white lg:hidden"
                    aria-label="Open navigation"
                    aria-expanded={sidebarOpen}
                    aria-controls="console-sidebar"
                >
                    <>{mobilePortfolioHeader?<svg aria-hidden="true" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.7"><path d="M3 18 9 11l5 3 7-10M3 21h18"/></svg>:<HiOutlineMenu />}</>
                </button><span className={mobilePortfolioHeader?"text-2xl font-bold":"font-medium"}>{conceptF?'Cred-X':'Workspace'}</span>{mobilePortfolioHeader?<Link href="/console/profile" prefetch={false} aria-label="Open your profile" className="ml-auto inline-flex min-h-11 min-w-11 items-center justify-center rounded-full focus-visible:ring-2 focus-visible:ring-primary"><span aria-hidden="true" className="inline-flex size-8 items-center justify-center rounded-full bg-slate-600 text-xs font-bold text-white">{user?.username?.trim().slice(0,2).toUpperCase()||'U'}</span></Link>:conceptF&&<span className="ml-auto text-[10px] font-semibold uppercase tracking-wider">Simulation</span>}</div>

                {/* Page content */}
                <main
                    id="workspace-main"
                    tabIndex={-1}
                    className="min-w-0 px-4 py-6 sm:px-6"
                    data-console-shell="authenticated"
                >
                    {error ? (
                        <div
                            role="alert"
                            className="mb-4 rounded-2xl border border-amber-300 bg-amber-50 px-5 py-4 text-sm text-amber-900"
                        >
                            {error}
                        </div>
                    ) : null}
                    <ModuleRouteGate>{children}</ModuleRouteGate>
                </main>
            </div>
            {conceptF&&<ConceptFMobileNavigation pathname={pathname} expanded={sidebarOpen} onMore={trigger=>{if(trigger)triggerRef.current=trigger;setSidebarOpen(true);}}/>}
        </div></WorkspaceDisplayProvider>
    );
}
