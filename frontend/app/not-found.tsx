"use client";

import Link from "next/link";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { AlertCircle } from "lucide-react";
import { URLs } from "@/lib/urls";
import { useAuth } from "@/hooks/useAuth";

export default function NotFound() {
    const { isAuthenticated, loading } = useAuth();

    return (
        <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
            <Card className="w-full max-w-md shadow-xl">
                <CardHeader className="space-y-2 text-center">
                    <div className="flex justify-center mb-4">
                        <div className="p-3 bg-red-100 rounded-full">
                            <AlertCircle className="h-8 w-8 text-red-600" />
                        </div>
                    </div>
                    <CardTitle className="text-4xl font-bold">404</CardTitle>
                    <CardDescription>Page Not Found</CardDescription>
                </CardHeader>
                <CardContent className="space-y-6">
                    <div className="text-center">
                        <p className="text-slate-600 mb-2">
                            Sorry, the page you're looking for doesn't exist.
                        </p>
                        <p className="text-sm text-slate-500">
                            It might have been moved or deleted.
                        </p>
                    </div>

                    <div className="space-y-2">
                        <Link href={isAuthenticated ? URLs.routes.console.dashboard() : URLs.routes.home()}>
                            <Button className="w-full bg-purple-600 hover:bg-purple-700">
                                {
                                    loading ? "Loading..." : (isAuthenticated ? "Go to Dashboard" : "Go to Home")
                                }
                            </Button>
                        </Link>

                        {!isAuthenticated && loading && (
                            <Link href={URLs.routes.login()}>
                                <Button variant="outline" className="w-full">
                                    Sign In
                                </Button>
                            </Link>
                        )}
                    </div>

                    <div className="pt-4 border-t border-slate-200">
                        <p className="text-xs text-slate-500 text-center">
                            Need help? <a href="#" className="text-purple-600 hover:text-purple-700 font-medium">
                                Contact Support
                            </a>
                        </p>
                    </div>
                </CardContent>
            </Card>
        </div>
    );
}
