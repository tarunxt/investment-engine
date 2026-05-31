'use client';

import { useEffect, useState } from 'react';
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
import { FullLoader } from '@/components/shared/Loader';
import { UserMenu } from '@/components/dashboard/UserMenu';
import { SidebarNavigation } from './_components/SidebarNavigation';

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const brandExpansionLines = getBrandExpansionLines();
    const { user, logout, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const searchParamString = searchParams.toString();
    const hasRedirectToParam = searchParams.has('redirectTo');
    const [sidebarOpen, setSidebarOpen] = useState(false);

    useEffect(() => {
        if (!hasRedirectToParam) return;
        const cleanedUrl = stripRedirectToFromCurrentUrl(pathname, searchParamString);
        const currentUrl = searchParamString ? `${pathname}?${searchParamString}` : pathname;
        if (cleanedUrl !== currentUrl) {
            // Keep the App Router's internal state aligned with the cleaned URL.
            router.replace(cleanedUrl, { scroll: false });
        }
    }, [hasRedirectToParam, pathname, router, searchParamString]);
    if (loading) {
        return (
            <div className='w-full h-screen flex items-center justify-center'>
                <FullLoader
                    text="Loading..."
                    size="lg"
                    textPosition="bottom"
                />
            </div>
        )
    }

    return (
        <div className="min-h-screen bg-gray-50">
            {/* Mobile sidebar backdrop */}
            {sidebarOpen && (
                <div
                    className="fixed inset-0 z-20 bg-black bg-opacity-50 transition-opacity lg:hidden"
                    onClick={() => setSidebarOpen(false)}
                />
            )}

            {/* Sidebar */}
            <div
                className={`fixed inset-y-0 left-0 z-30 w-64 bg-white shadow-lg transform transition-transform duration-300 ease-in-out lg:translate-x-0 ${sidebarOpen ? 'translate-x-0' : '-translate-x-full'
                    }`}
            >
                <div className="flex flex-col h-full">
                    {/* Logo */}
                    <div className="relative flex h-20 items-center justify-center border-b px-4">
                        <Link href={URLs.routes.console.dashboard()} className="flex flex-col items-center gap-2 text-center">
                            <div className="rounded-2xl bg-linear-to-r from-indigo-600 via-violet-600 to-fuchsia-600 px-3 py-2 shadow-sm">
                                <span className="text-xs font-bold uppercase tracking-[0.28em] text-white">{BRAND_ACRONYM}</span>
                            </div>
                            <div className="leading-tight">
                                <div className="text-sm font-semibold text-gray-900">{brandExpansionLines.primary}</div>
                                {brandExpansionLines.secondary ? (
                                    <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
                                        {brandExpansionLines.secondary}
                                    </div>
                                ) : null}
                            </div>
                        </Link>
                        <button
                            type="button"
                            onClick={() => setSidebarOpen(false)}
                            className="absolute right-4 p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 lg:hidden"
                        >
                            <HiOutlineX />
                        </button>
                    </div>

                    {/* Navigation */}
                    <nav className="flex-1 py-4">
                        <SidebarNavigation
                            pathname={pathname}
                            userId={user?.id}
                            onNavigate={() => setSidebarOpen(false)}
                        />
                    </nav>

                    {/* User info in sidebar (mobile) */}
                    <div className="p-4 border-t lg:hidden">
                        <div className="flex items-center">
                            <div className="shrink-0">
                                <div className="h-8 w-8 rounded-full bg-linear-to-r from-indigo-600 to-purple-600 flex items-center justify-center text-white font-semibold">
                                    {user?.full_name?.[0] || user?.username?.[0]?.toUpperCase() || 'U'}
                                </div>
                            </div>
                            <div className="ml-3">
                                <p className="text-sm font-medium text-gray-900">
                                    {user?.full_name || user?.username}
                                </p>
                                <p className="text-xs text-gray-500">{user?.email}</p>
                            </div>
                        </div>
                    </div>
                </div>
            </div>

            {/* Main content area */}
            <div className="lg:pl-64">
                {/* Top header */}
                <header className="bg-white shadow-sm sticky top-0 z-10">
                    <div className="flex h-16 items-center justify-between gap-4 px-4 sm:px-6">
                        <div className="flex min-w-0 flex-1 items-center">
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                className="p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 lg:hidden"
                            >
                                <HiOutlineMenu />
                            </button>
                        </div>

                        <UserMenu
                            user={user}
                            onLogout={logout}
                            className="shrink-0"
                        />
                    </div>
                </header>

                {/* Page content */}
                <main className="py-6 px-4 sm:px-6">
                    {children}
                </main>
            </div>
        </div>
    );
}
