'use client';

import { useEffect, useState } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import Link from 'next/link';
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
import { FullLoader } from '@/components/shared/Loader';
import { UserMenu } from '@/components/dashboard/UserMenu';

const devAuthEnabled = process.env.NEXT_PUBLIC_DISABLE_AUTH === "true";

export default function DashboardLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, user, logout, loading } = useAuth();
    const router = useRouter();
    const pathname = usePathname();
    const [sidebarOpen, setSidebarOpen] = useState(false);

    useEffect(() => {
        if (devAuthEnabled) return;
        if (loading) return;
        if (!isAuthenticated) {
            router.push('/login');
        }
    }, [isAuthenticated, router, loading]);

    const navigation = [
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
            name: 'Zerodha',
            href: URLs.routes.console.zerodha(),
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
        return pathname.startsWith(href);
    };

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
                    <div className="flex items-center justify-between h-16 px-4 border-b">
                        <Link href={URLs.routes.console.dashboard()} className="flex items-center w-full justify-center space-x-2">
                            <div className="w-8 h-8 bg-linear-to-r from-indigo-600 to-purple-600 rounded-lg flex items-center justify-center">
                                <span className="text-white font-bold text-lg">AI</span>
                            </div>
                        </Link>
                        <button
                            onClick={() => setSidebarOpen(false)}
                            className="p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 lg:hidden"
                        >
                            <HiOutlineX />
                        </button>
                    </div>

                    {/* Navigation */}
                    <nav className="flex-1 px-2 py-4 space-y-1 overflow-y-auto">
                        {navigation.map((item) => (
                            <Link
                                key={item.name}
                                href={item.href}
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
                    <div className="flex items-center justify-between h-16 px-4 sm:px-6">
                        <button
                            onClick={() => setSidebarOpen(true)}
                            className="p-2 rounded-md text-gray-400 hover:text-gray-500 hover:bg-gray-100 lg:hidden"
                        >
                            <HiOutlineMenu />
                        </button>

                        <div className="flex-1" />

                        <UserMenu
                            user={user}
                            onLogout={logout}
                            className="ml-auto"
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
