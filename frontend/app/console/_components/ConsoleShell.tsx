'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { SidebarPolicyContext, useSidebarPolicy } from '@/hooks/useSidebarPolicy';
import { useAuth } from '@/hooks/useAuth';
import {
    HiOutlineMenu,
    HiOutlineX,
} from 'react-icons/hi';
import { URLs } from '@/lib/urls';
import { apiService } from '@/services/api';
import { BRAND_ACRONYM } from '@/lib/brand';
import { stripRedirectToFromCurrentUrl } from '@/lib/authRedirect';
import { SidebarNavigation } from './SidebarNavigation';

function emailName(email?: string | null) {
    const first = email?.split('@')[0].split(/[._+0-9-]/)[0];
    return first ? first.charAt(0).toUpperCase() + first.slice(1) : '';
}

export function ConsoleShell({
    children,
}: {
    children: React.ReactNode;
}) {
    const consoleSidebarStyle = {
        '--console-sidebar-width': '22rem',
    } as CSSProperties;
    const { user, logout, loading, error } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const userId = user?.id;
    const { policy, retry } = useSidebarPolicy(userId);
    const dashboardVisible = policy && (policy.visible_ids === null || policy.visible_ids.includes('overview'));
    const [identity, setIdentity] = useState<{userId: number; name: string} | null>(null);
    useEffect(() => {
        if (!userId) return;
        let current = true;
        const load = async () => {
            try {
                const broker = await apiService.zerodhaConnection();
                const name = broker.linked ? broker.profile?.name?.trim().split(/\s+/)[0] || emailName(broker.profile?.email) : '';
                if (current) setIdentity({userId, name});
            } catch {
                if (current) setIdentity(null);
            }
        };
        void load();
        window.addEventListener('broker-connection-changed', load);
        return () => { current = false; window.removeEventListener('broker-connection-changed', load); };
    }, [userId, pathname]);
    const owner = (identity?.userId === userId && identity?.name) || user?.full_name?.trim().split(/\s+/)[0] || emailName(user?.email) || 'Tarun';
    const searchParams = useSearchParams();
    const searchParamString = searchParams.toString();
    const hasRedirectToParam = searchParams.has('redirectTo');
    const [sidebarOpen, setSidebarOpen] = useState(false);
    useEffect(() => {
        performance.mark('console-shell-rendered');
    }, []);
    useEffect(() => {
        if (!loading && !user && !error) {
            router.replace(URLs.routes.login());
        }
    }, [error, loading, router, user]);

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
        <div className="min-h-screen bg-background text-foreground" style={consoleSidebarStyle}>
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 z-20 bg-black bg-opacity-50 transition-opacity lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div
                className={`fixed inset-y-0 left-0 z-30 w-[min(92vw,var(--console-sidebar-width))] border-r border-border bg-sidebar text-sidebar-foreground shadow-lg transform transition-transform duration-300 ease-in-out lg:w-[var(--console-sidebar-width)] lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                    }`}
            >
                <div className="flex flex-col h-full">
                    {/* Logo */}
                    <div className="relative flex min-h-28 items-center justify-center border-b border-sidebar-border px-5 py-5">
                        <div className="relative flex flex-col items-center gap-3 text-center">
                            <div className="rounded-2xl bg-linear-to-r from-indigo-600 via-violet-600 to-fuchsia-600 px-5 py-3 shadow-sm">
                                <span className="text-xs font-bold uppercase tracking-[0.28em] text-white">{BRAND_ACRONYM}</span>
                            </div>
                            <div className="space-y-1 leading-tight">
                                <div className="text-sm font-semibold text-sidebar-foreground">{owner}'s</div>
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                        Investment Engine
                                    </div>
                            </div>
                            {dashboardVisible && <Link href={URLs.routes.console.dashboard()} prefetch={false} aria-label="Dashboard" className="absolute inset-0 rounded-md" />}
                        </div>
                        <button
                            type="button"
                            onClick={() => setSidebarOpen(false)}
                            className="absolute right-4 rounded-md p-2 text-muted-foreground hover:bg-sidebar-accent hover:text-sidebar-accent-foreground lg:hidden"
                        >
                            <HiOutlineX />
                        </button>
                    </div>

                    {/* Navigation */}
                    <div className="flex-1 min-h-0 py-4">
                        {policy ? <SidebarNavigation
                            key={userId}
                            policy={policy}
                            pathname={pathname}
                            user={user}
                            userId={user?.id}
                            onLogout={logout}
                            onNavigate={() => setSidebarOpen(false)}
                        /> : <div className="space-y-3 px-5 text-sm text-muted-foreground" role="status">
                            {policy === null ? <><p>Couldn’t load navigation.</p><button onClick={retry} className="underline">Retry</button></> : <p>Loading navigation…</p>}
                            {user && <button onClick={() => void logout()} className="block underline">Sign out</button>}
                        </div>}
                    </div>

                </div>
            </div>

            {/* Main content area */}
            <div className="lg:pl-[var(--console-sidebar-width)]">
                <button
                    type="button"
                    onClick={() => setSidebarOpen(true)}
                    className="fixed left-4 top-4 z-10 rounded-full border border-border bg-background p-2 text-muted-foreground shadow-sm hover:bg-muted hover:text-foreground lg:hidden"
                    aria-label="Open navigation"
                >
                    <HiOutlineMenu />
                </button>

                {/* Page content */}
                <SidebarPolicyContext.Provider value={policy}>
                <main
                    className="px-4 py-6 sm:px-6 lg:py-6"
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
                    {user ? children : error ? (
                        <button type="button" onClick={() => void logout()} className="rounded border px-4 py-2">
                            Retry sign-out
                        </button>
                    ) : null}
                </main>
                </SidebarPolicyContext.Provider>
            </div>
        </div>
    );
}
