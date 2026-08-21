import { Suspense } from "react";

import { PublicAuthProvider } from "@/providers/PublicAuthProvider";

export default function AuthLayout({
    children,
}: {
    children: React.ReactNode;
}) {
    return (
        <PublicAuthProvider>
            <div className="min-h-screen bg-linear-to-br from-blue-50 via-indigo-50 to-purple-50">
                <main className="grow">
                    <Suspense fallback={null}>{children}</Suspense>
                </main>
            </div>
        </PublicAuthProvider>
    );
}
