'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname, useSearchParams } from 'next/navigation';
import Link from 'next/link';
import type { IconType } from 'react-icons';
import { useAuth } from '@/hooks/useAuth';
import {
    HiOutlineViewGrid,
    HiOutlineMenu,
    HiOutlineX,
    HiOutlineUser,
    HiOutlineBriefcase,
    HiOutlineBookOpen,
    HiOutlineTrendingUp,
    HiOutlineCube,
} from 'react-icons/hi';
import { URLs } from '@/lib/urls';
import { stripRedirectToFromCurrentUrl } from '@/lib/authRedirect';
import { FullLoader } from '@/components/shared/Loader';
import { UserMenu } from '@/components/dashboard/UserMenu';

type NavigationItem = {
    name: string;
    href: string;
    icon: IconType;
};

type NavigationGroup = {
    name: string;
    icon: IconType;
    children: NavigationItem[];
};

type NavigationEntry = NavigationItem | NavigationGroup;

type PortfolioHeader = {
    title: string;
    subtitle: string;
};

const PORTFOLIO_HEADERS: Array<{ prefix: string; header: PortfolioHeader }> = [
    {
        prefix: URLs.routes.console.zerodha(),
        header: {
            title: 'Zerodha',
            subtitle: 'Kite Connect integration — save daywise portfolio history and manage orders',
        },
    },
    {
        prefix: URLs.routes.console.indmoneyUs(),
        header: {
            title: 'IndMoney US',
            subtitle: 'Manual US portfolio tracking for INDmoney when no direct API is available.',
        },
    },
];

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { user, logout, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const searchParams = useSearchParams();
    const searchParamString = searchParams.toString();
    const hasRedirectToParam = searchParams.has('redirectTo');
    const [sidebarOpen, setSidebarOpen] = useState(false);
    const [portfolioOpen, setPortfolioOpen] = useState(false);

    useEffect(() => {
        if (!hasRedirectToParam) return;
        const cleanedUrl = stripRedirectToFromCurrentUrl(pathname, searchParamString);
        const currentUrl = searchParamString ? `${pathname}?${searchParamString}` : pathname;
        if (cleanedUrl !== currentUrl) {
            // Keep the App Router's internal state aligned with the cleaned URL.
            router.replace(cleanedUrl, { scroll: false });
        }
    }, [hasRedirectToParam, pathname, router, searchParamString]);

    const portfolioChildren: NavigationItem[] = [
        {
            name: 'Zerodha',
            href: URLs.routes.console.zerodha(),
            icon: HiOutlineTrendingUp,
        },
        {
            name: 'IndMoney US',
            href: URLs.routes.console.indmoneyUs(),
            icon: HiOutlineTrendingUp,
        },
    ];

    const navigation: NavigationEntry[] = [
        {
            name: 'Dashboard',
            href: URLs.routes.console.dashboard(),
            icon: HiOutlineViewGrid,
        },
        {
            name: 'Runs',
            href: URLs.routes.console.runs(),
            icon: HiOutlineBriefcase,
        },
        {
            name: 'Prompts',
            href: URLs.routes.console.prompts(),
            icon: HiOutlineBookOpen,
        },
        {
            name: 'Portfolio',
            children: portfolioChildren,
            icon: HiOutlineTrendingUp,
        },
        {
            name: 'APIs',
            href: URLs.routes.console.apis(),
            icon: HiOutlineCube,
        },
        {
            name: 'Google Sheets',
            href: URLs.routes.console.googleSheets(),
            icon: HiOutlineViewGrid,
        },
        {
            name: 'Profile',
            href: URLs.routes.profile.root(),
            icon: HiOutlineUser,
        },
    ];

    const isActive = (href: string) => {
        if (href === '/dashboard') {
            return pathname === href;
        }
        if (href === URLs.routes.console.zerodha()) {
            return pathname === href || pathname.startsWith(`${href}/`);
        }
        if (href === URLs.routes.console.indmoneyUs()) {
            return pathname === href || pathname.startsWith(`${href}/`);
        }
        return pathname.startsWith(href);
    };

    const isPortfolioActive =
        pathname.startsWith('/console/zerodha') || pathname.startsWith('/console/indmoney-us');
    const isPortfolioExpanded = portfolioOpen || isPortfolioActive;
    const activePortfolioHeader =
        PORTFOLIO_HEADERS.find(({ prefix }) => pathname === prefix || pathname.startsWith(`${prefix}/`))?.header ?? null;

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
                                <span className="text-xs font-bold uppercase tracking-[0.28em] text-white">TIE</span>
                            </div>
                            <div className="leading-tight">
                                <div className="text-sm font-semibold text-gray-900">Tarun&apos;s</div>
                                <div className="text-[11px] uppercase tracking-[0.18em] text-gray-500">
                                    Investment Engine
                                </div>
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
                    <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
                        {navigation.map((item) => (
                            'children' in item ? (
                                <div key={item.name} className="space-y-1">
                                    <button
                                        type="button"
                                        onClick={() => setPortfolioOpen((current) => !current)}
                                        className={`flex w-full items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${isPortfolioActive
                                            ? 'bg-indigo-50 text-indigo-600'
                                            : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                                            }`}
                                    >
                                        <item.icon
                                            className={`mr-3 h-5 w-5 ${isPortfolioActive ? 'text-indigo-600' : 'text-gray-400'
                                                }`}
                                        />
                                        <span>Portfolio</span>
                                        <span className="ml-auto text-xs text-gray-400">
                                            {isPortfolioExpanded ? 'v' : '>'}
                                        </span>
                                    </button>
                                    {isPortfolioExpanded && (
                                        <div className="ml-6 space-y-1 border-l border-gray-200 pl-3">
                                            {item.children.map((child) => (
                                                <Link
                                                    key={child.name}
                                                    href={child.href}
                                                    onClick={() => setSidebarOpen(false)}
                                                    className={`flex items-center rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive(child.href)
                                                        ? 'bg-indigo-50 text-indigo-600'
                                                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                                                        }`}
                                                >
                                                    <span className={`mr-2 text-xs ${isActive(child.href) ? 'text-indigo-500' : 'text-gray-300'}`}>
                                                        •
                                                    </span>
                                                    {child.name}
                                                </Link>
                                            ))}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <Link
                                    key={item.name}
                                    href={item.href}
                                    onClick={() => setSidebarOpen(false)}
                                    className={`flex items-center px-4 py-2 text-sm font-medium rounded-lg transition-colors ${isActive(item.href)
                                        ? 'bg-indigo-50 text-indigo-600'
                                        : 'text-gray-600 hover:bg-gray-50 hover:text-gray-900'
                                        }`}
                                >
                                    <item.icon
                                        className={`mr-3 h-5 w-5 ${isActive(item.href) ? 'text-indigo-600' : 'text-gray-400'
                                            }`}
                                    />
                                    {item.name}
                                </Link>
                            )
                        ))}
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
                        <div className="flex min-w-0 flex-1 items-center gap-3">
                            <button
                                type="button"
                                onClick={() => setSidebarOpen(true)}
                                className="p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 lg:hidden"
                            >
                                <HiOutlineMenu />
                            </button>

                            {activePortfolioHeader ? (
                                <div className="min-w-0 leading-tight">
                                    <div className="truncate text-base font-semibold tracking-tight text-gray-950">
                                        {activePortfolioHeader.title}
                                    </div>
                                    <div className="truncate text-xs text-gray-500">
                                        {activePortfolioHeader.subtitle}
                                    </div>
                                </div>
                            ) : (
                                <div className="flex-1" />
                            )}
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
