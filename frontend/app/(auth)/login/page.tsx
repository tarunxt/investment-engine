"use client";

import { useState } from "react";
import Link from "next/link";
import { useAuth } from "@/hooks/useAuth";
import { URLs } from "@/lib/urls";
import { AuthRedirect } from "@/components/AuthRedirect";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormAlert } from "@/components/auth/FormAlert";
import { Loader2 } from "lucide-react";

export default function LoginPage() {
  const { login, loading, error, clearError } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [validationError, setValidationError] = useState<string | null>(null);

  const validateForm = () => {
    if (!email) {
      setValidationError("Email is required");
      return false;
    }
    if (!password) {
      setValidationError("Password is required");
      return false;
    }
    setValidationError(null);
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    try {
      clearError();
      await login(email, password);
      // router will redirect automatically after login
    } catch (err) {
      console.error("Login error:", err);
      // Error is handled by useAuth hook and displayed in error state
    }
  };

  return (
    <AuthRedirect>
      <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">Welcome Back</CardTitle>
            <CardDescription>Sign in to your account to continue</CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Error Alert */}
              {(error || validationError) && (
                <FormAlert
                  type="error"
                  title={validationError ? "Validation Error" : "Login Failed"}
                  message={error || validationError || "Please try again"}
                  onDismiss={clearError}
                />
              )}

              {/* Email Field */}
              <div className="space-y-2">
                <label htmlFor="email" className="text-sm font-medium">
                  Email Address
                </label>
                <Input
                  id="email"
                  type="email"
                  placeholder="you@example.com"
                  value={email}
                  onChange={(e) => {
                    setEmail(e.target.value);
                    setValidationError(null);
                    clearError();
                  }}
                  disabled={loading}
                  className="w-full"
                  autoComplete="email"
                  autoFocus
                />
              </div>

              {/* Password Field */}
              <div className="space-y-2">
                <label htmlFor="password" className="text-sm font-medium">
                  Password
                </label>
                <Input
                  id="password"
                  type="password"
                  placeholder="••••••••"
                  value={password}
                  onChange={(e) => {
                    setPassword(e.target.value);
                    setValidationError(null);
                    clearError();
                  }}
                  disabled={loading}
                  className="w-full"
                  autoComplete="current-password"
                  variant={validationError === "Invalid email or password" ? "error" : "default"}
                />
              </div>

              {/* Sign In Button */}
              <Button
                type="submit"
                disabled={loading}
                className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {loading ? (
                  <div className="flex items-center justify-center gap-2">
                    <Loader2 className="h-4 w-4 animate-spin" />
                    <span>Signing in...</span>
                  </div>
                ) : (
                  "Sign In"
                )}
              </Button>

              <div className="relative">
                <div className="absolute inset-0 flex items-center">
                  <span className="w-full border-t border-slate-200" />
                </div>
                <div className="relative flex justify-center text-xs uppercase">
                  <span className="bg-white px-2 text-slate-500">Don&apos;t have an account?</span>
                </div>
              </div>

              <Link href={URLs.routes.register()}>
                <Button
                  type="button"
                  variant="outline"
                  className="w-full"
                >
                  Create Account
                </Button>
              </Link>

              <div className="text-center mt-2">
                <Link href={URLs.routes.forgotPassword()} className="text-sm text-purple-600 hover:text-purple-700">
                  Forgot password?
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AuthRedirect>
  );
}