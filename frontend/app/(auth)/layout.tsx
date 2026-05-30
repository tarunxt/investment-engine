'use client';

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';
import { isClientAuthBypassed, resolveAuthRedirectTarget } from '@/lib/authRedirect';

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated, loading } = useAuth();
    const router = useRouter();
    const searchParams = useSearchParams();
    const redirectTo = resolveAuthRedirectTarget(searchParams.get('redirectTo'));

    useEffect(() => {
        if (loading) return;
        if (isClientAuthBypassed || isAuthenticated) {
            router.replace(redirectTo);
        }
    }, [isAuthenticated, loading, redirectTo, router]);

    if (loading) {
        return null;
    }

    if (isClientAuthBypassed || isAuthenticated) {
        return null;
    }

    return (
        <div className="min-h-screen bg-linear-to-br from-blue-50 via-indigo-50 to-purple-50">
            {/* Main Content */}
            <main className="grow">
                {children}
            </main>
        </div>
    );
}
