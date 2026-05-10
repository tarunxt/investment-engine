'use client';

import { useEffect } from 'react';
import { useRouter, usePathname } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import Link from 'next/link';

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated } = useAuth();
    const router = useRouter();

    useEffect(() => {
        // Redirect to dashboard if already authenticated
        if (isAuthenticated) {
            console.log('User is authenticated, redirecting to dashboard...');
            router.push('/console/dashboard');
        }
    }, [isAuthenticated, router]);

    // Don't render anything while checking auth or redirecting
    if (isAuthenticated) {
        return null;
    }

    return (
        <div className="min-h-screen bg-gradient-to-br from-blue-50 via-indigo-50 to-purple-50">
            {/* Main Content */}
            <main className="flex-grow">
                {children}
            </main>
        </div>
    );
}