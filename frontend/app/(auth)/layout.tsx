'use client';

import { useEffect } from 'react';
import { useRouter } from 'next/navigation';
import { useAuth } from '@/hooks/useAuth';

const devAuthEnabled = process.env.NEXT_PUBLIC_DISABLE_AUTH === "true";

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    const { isAuthenticated } = useAuth();
    const router = useRouter();

    useEffect(() => {
        // Redirect to dashboard if already authenticated
        if (devAuthEnabled || isAuthenticated) {
            console.log('User is authenticated, redirecting to dashboard...');
            router.push('/console/dashboard');
        }
    }, [isAuthenticated, router]);

    // Don't render anything while checking auth or redirecting
    if (devAuthEnabled || isAuthenticated) {
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
