"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { FormAlert } from "@/components/auth/FormAlert";
import { Loader2, ArrowLeft } from "lucide-react";
import { URLs } from "@/lib/urls";
import { AuthRedirect } from "@/components/AuthRedirect";
import { apiService } from "@/services/api";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);
  const [validationError, setValidationError] = useState<string | null>(null);

  const validateForm = () => {
    if (!email) {
      setValidationError("Email is required");
      return false;
    }
    if (!email.includes("@")) {
      setValidationError("Please enter a valid email address");
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
      await apiService.forgotPassword({ email });
      setSuccess(true);
      // Keep email for success message but allow clearing for "Send Another"
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Failed to request password reset";
      setError(errorMsg);
    } finally {
      setLoading(false);
    }
  };

  return (
    <AuthRedirect>
      <div className="min-h-screen flex items-center justify-center bg-linear-to-br from-slate-900 via-purple-900 to-slate-900 p-4">
        <Card className="w-full max-w-md shadow-xl">
          <CardHeader className="space-y-2">
            <CardTitle className="text-2xl">Reset Your Password</CardTitle>
            <CardDescription>
              Enter your email address and we'll send you a link to reset your password
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleSubmit} className="space-y-4">
              {/* Success Alert */}
              {success && (
                <FormAlert
                  type="success"
                  title="Check Your Email"
                  message={`Password reset instructions have been sent to ${email}`}
                  details={[
                    "Check your inbox and spam folder",
                    "Click the link in the email to reset your password",
                    "The link will expire in 24 hours",
                  ]}
                  onDismiss={() => setSuccess(false)}
                />
              )}

              {/* Error Alert */}
              {(error || validationError) && (
                <FormAlert
                  type="error"
                  title={validationError ? "Validation Error" : "Request Failed"}
                  message={error || validationError || "Please try again"}
                  onDismiss={() => {
                    setError(null);
                    setValidationError(null);
                  }}
                />
              )}

              {/* Email Field */}
              {!success && (
                <>
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
                        setError(null);
                      }}
                      disabled={loading}
                      className="w-full"
                      autoComplete="email"
                      autoFocus
                    />
                  </div>

                  {/* Submit Button */}
                  <Button
                    type="submit"
                    disabled={loading}
                    className="w-full bg-purple-600 hover:bg-purple-700 disabled:opacity-50 disabled:cursor-not-allowed"
                  >
                    {loading ? (
                      <div className="flex items-center justify-center gap-2">
                        <Loader2 className="h-4 w-4 animate-spin" />
                        <span>Sending...</span>
                      </div>
                    ) : (
                      "Send Reset Link"
                    )}
                  </Button>
                </>
              )}

              {/* Success - Send Another or Back to Login */}
              {success && (
                <div className="space-y-2">
                  <Button
                    onClick={() => setSuccess(false)}
                    variant="outline"
                    className="w-full"
                  >
                    Send Another Email
                  </Button>
                  <Link href={URLs.routes.login()}>
                    <Button className="w-full bg-purple-600 hover:bg-purple-700">
                      Back to Login
                    </Button>
                  </Link>
                </div>
              )}

              {/* Back to Login Link */}
              <div className="flex items-center justify-center pt-2">
                <Link
                  href={URLs.routes.login()}
                  className="text-sm text-purple-600 hover:text-purple-700 font-medium flex items-center gap-1"
                >
                  <ArrowLeft className="h-4 w-4" />
                  Back to Sign In
                </Link>
              </div>
            </form>
          </CardContent>
        </Card>
      </div>
    </AuthRedirect>
  );
}
