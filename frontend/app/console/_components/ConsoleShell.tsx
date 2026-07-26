'use client';

import { useEffect, useState, type CSSProperties } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import { useAuth } from '@/hooks/useAuth';
import {
    HiOutlineMenu,
    HiOutlineX,
} from 'react-icons/hi';
import { URLs } from '@/lib/urls';
import { BRAND_ACRONYM, getBrandExpansionLines } from '@/lib/brand';
import { stripRedirectToFromCurrentUrl } from '@/lib/authRedirect';
import { SidebarNavigation } from './SidebarNavigation';

export function ConsoleShell({
    children,
}: {
    children: React.ReactNode;
}) {
    const consoleSidebarStyle = {
        '--console-sidebar-width': '22rem',
    } as CSSProperties;
    const brandExpansionLines = getBrandExpansionLines();
    const { user, logout, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const searchParamString = searchParams.toString();
    const hasRedirectToParam = searchParams.has('redirectTo');
    const [sidebarOpen, setSidebarOpen] = useState(false);
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
                        <Link
                            href={URLs.routes.console.dashboard()}
                            prefetch={false}
                            className="flex flex-col items-center gap-3 text-center"
                        >
                            <div className="rounded-2xl bg-linear-to-r from-indigo-600 via-violet-600 to-fuchsia-600 px-5 py-3 shadow-sm">
                                <span className="text-xs font-bold uppercase tracking-[0.28em] text-white">{BRAND_ACRONYM}</span>
                            </div>
                            <div className="space-y-1 leading-tight">
                                <div className="text-sm font-semibold text-sidebar-foreground">{brandExpansionLines.primary}</div>
                                {brandExpansionLines.secondary ? (
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-muted-foreground">
                                        {brandExpansionLines.secondary}
                                    </div>
                                ) : null}
                            </div>
                        </Link>
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
                        <SidebarNavigation
                            pathname={pathname}
                            user={user}
                            userId={user?.id}
                            onLogout={logout}
                            onNavigate={() => setSidebarOpen(false)}
                        />
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
                <main className="px-4 py-6 sm:px-6 lg:py-6">
                    {loading ? (
                        <div
                            role="status"
                            className="rounded-2xl border border-border bg-card px-5 py-4 text-sm text-muted-foreground"
                        >
                            Restoring your secure session…
                        </div>
                    ) : children}
                </main>
            </div>
        </div>
    );
}
