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
import dynamic from 'next/dynamic';
const ModuleRouteGate = dynamic(() => import('@/components/modules/ModuleRouteGate').then(m=>m.ModuleRouteGate), {ssr:false,loading:()=> <p role="status">Loading workspace access…</p>});
const SidebarNavigation = dynamic(() => import('./WorkspaceNavigation').then(m=>m.WorkspaceNavigation), {ssr:false,loading:()=> <nav aria-label="Core navigation" className="space-y-3 px-4"><Link href="/console/dashboard">Dashboard</Link><Link href="/console/profile/preferences">My modules</Link><Link href="/console/help">Help</Link></nav>});

export function ConsoleShell({
    children,
}: {
    children: React.ReactNode;
}) {
    const consoleSidebarStyle = {
        '--console-sidebar-width': '16rem',
    } as CSSProperties;
    const { user, logout, loading, error } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
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
        <div data-workspace-shell="authenticated" className="min-h-screen bg-background text-foreground" style={consoleSidebarStyle}>
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
                      <Link href="/console/dashboard" prefetch={false} className="flex min-h-11 items-center gap-2.5 rounded-lg font-semibold tracking-tight focus-visible:ring-2 focus-visible:ring-sidebar-ring"><span aria-hidden="true" className="flex size-9 items-center justify-center rounded-xl bg-gradient-to-br from-violet-500 to-indigo-600 text-sm font-bold text-white shadow-sm">CX</span><span className="text-lg">Cred-X</span></Link>
                      <button type="button" onClick={()=>setSidebarOpen(false)} aria-label="Close navigation" className="min-h-11 min-w-11 rounded-lg lg:hidden"><HiOutlineX/></button>
                    </div>

                    {/* Navigation */}
                    <div className="flex-1 min-h-0 pt-3">
                        <SidebarNavigation
                            pathname={pathname}
                            user={user}
                            onLogout={logout}
                            onNavigate={() => setSidebarOpen(false)}
                        />
                    </div>

                </div>
            </div>

            {/* Main content area */}
            <div className="lg:pl-[var(--console-sidebar-width)]">
                <div className="sticky top-0 z-10 flex h-16 items-center gap-3 border-b border-border bg-background px-4 lg:hidden">
                <button
                    type="button"
                    ref={triggerRef}
                    onClick={() => setSidebarOpen(true)}
                    className="inline-flex min-h-11 min-w-11 items-center justify-center rounded-full border border-border bg-background p-2 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground lg:hidden"
                    aria-label="Open navigation"
                    aria-expanded={sidebarOpen}
                    aria-controls="console-sidebar"
                >
                    <HiOutlineMenu />
                </button><span className="font-medium">Workspace</span></div>

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
        </div>
    );
}
