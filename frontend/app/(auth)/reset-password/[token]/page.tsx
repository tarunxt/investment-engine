"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter, useParams } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormAlert } from "@/components/auth/FormAlert";
import { Loader2, ArrowLeft, CheckCircle2, EyeOff, Eye } from "lucide-react";
import { URLs } from "@/lib/urls";
import { apiService } from "@/services/api";

export default function ResetPasswordPage() {
  const router = useRouter();
  const params = useParams();
  const token = params.token as string;

  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);
  const [passwordVisible, setPasswordVisible] = useState<boolean>(true);

  const validateForm = () => {
    if (!password) {
      setValidationError("New password is required");
      return false;
    }
    if (password.length < 8) {
      setValidationError("Password must be at least 8 characters long");
      return false;
    }
    if (password !== confirmPassword) {
      setValidationError("Passwords do not match");
      return false;
    }
    setValidationError(null);
    return true;
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!validateForm()) return;

    setLoading(true);
    setError(null);

    try {
      await apiService.resetPassword({
        token,
        new_password: password,
        confirm_password: confirmPassword,
      });

      setSuccess(true);
      setTimeout(() => {
        router.push(URLs.routes.login());
      }, 3000);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to reset password";
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
      <Card className="w-full max-w-md shadow-xl">
        <CardHeader className="space-y-2">
          <CardTitle className="text-2xl">Reset Your Password</CardTitle>
          <CardDescription>
            Choose a strong new password for your account
          </CardDescription>
        </CardHeader>
        <CardContent>
          <form onSubmit={handleSubmit} className="space-y-4">
            {/* Success State */}
            {success && (
              <div className="space-y-4 text-center py-4">
                <div className="flex justify-center">
                  <CheckCircle2 className="h-12 w-12 text-green-500" />
                </div>
                <div className="space-y-2">
                  <h3 className="text-xl font-semibold text-green-600">Password Reset Successfully!</h3>
                  <p className="text-slate-600">
                    Your password has been updated. Redirecting you to login...
                  </p>
                </div>
                <Link href={URLs.routes.login()} className="block">
                  <Button className="w-full bg-purple-600 hover:bg-purple-700">
                    Go to Login Now
                  </Button>
                </Link>
              </div>
            )}

            {!success && (
              <>
                {/* Error Alert */}
                {(error || validationError) && (
                  <FormAlert
                    type="error"
                    title={validationError ? "Validation Error" : "Reset Failed"}
                    message={error || validationError || "Please try again"}
                    onDismiss={() => {
                      setError(null);
                      setValidationError(null);
                    }}
                  />
                )}

                <div className="space-y-2">
                  <label htmlFor="password" className="text-sm font-medium">
                    New Password
                  </label>
                  <div className="relative">
                    <Input
                      id="password"
                      type={passwordVisible ? 'password' : 'text'}
                      placeholder="••••••••"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      disabled={loading}
                      className="w-full"
                      autoFocus
                    />
                    <button
                      type="button"
                      className="absolute inset-y-0 right-0 pr-3 flex items-center cursor-pointer"
                      onClick={() => setPasswordVisible(!passwordVisible)}
                    >
                      {
                        passwordVisible ? <EyeOff size={18} /> : <Eye size={18} />
                      }
                    </button>
                  </div>
                </div>

                <div className="space-y-2">
                  <label htmlFor="confirmPassword" className="text-sm font-medium">
                    Confirm New Password
                  </label>
                  <Input
                    id="confirmPassword"
                    type="password"
                    placeholder="••••••••"
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    disabled={loading}
                    className="w-full"
                  />
                </div>

                <Button
                  type="submit"
                  disabled={loading}
                  className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {loading ? (
                    <div className="flex items-center justify-center gap-2">
                      <Loader2 className="h-4 w-4 animate-spin" />
                      <span>Resetting...</span>
                    </div>
                  ) : (
                    "Reset Password"
                  )}
                </Button>

                <div className="flex items-center justify-center pt-2">
                  <Link
                    href={URLs.routes.login()}
                    className="text-sm text-purple-600 hover:text-purple-700 font-medium flex items-center gap-1"
                  >
                    <ArrowLeft className="h-4 w-4" />
                    Back to Sign In
                  </Link>
                </div>
              </>
            )}
          </form>
        </CardContent>
      </Card>
    </div>
  );
}
