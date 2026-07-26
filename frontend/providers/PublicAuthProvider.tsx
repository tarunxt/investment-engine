"use client";

import { useCallback, useMemo, useState } from "react";
import { signIn } from "next-auth/react";

import { AuthContext, type AuthContextType } from "@/hooks/useAuth";
import { URLs } from "@/lib/urls";
import { APIError, NetworkError, apiService } from "@/services/api";

function normalizeAuthError(error: unknown, fallback: string) {
  if (error instanceof NetworkError) {
    return {
      message: "We could not reach the authentication server from your browser.",
      details: [`${error.method} ${error.url}`, error.originalMessage],
    };
  }
  if (error instanceof APIError) {
    return {
      message: error.message || fallback,
      details: [`HTTP ${error.status}`],
    };
  }
  if (error instanceof Error && error.message === "CredentialsSignin") {
    return {
      message: "Invalid email, username, or password.",
      details: [],
    };
  }
  return {
    message: error instanceof Error ? error.message : fallback,
    details: [],
  };
}

export function PublicAuthProvider({
  children,
}: {
  children: React.ReactNode;
}) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);

  const clearError = useCallback(() => {
    setError(null);
    setErrorDetails([]);
  }, []);

  const login = useCallback(
    async (
      emailOrUsername: string,
      password: string,
      redirectTo = URLs.routes.console.dashboard(),
    ) => {
      clearError();
      setLoading(true);
      try {
        const isEmail = emailOrUsername.includes("@");
        const result = await signIn("credentials", {
          [isEmail ? "email" : "username"]: emailOrUsername,
          password,
          callbackUrl: redirectTo,
          redirect: false,
        });
        if (result?.error) throw new Error(result.error);
        window.location.assign(result?.url || redirectTo);
      } catch (loginError) {
        const normalized = normalizeAuthError(loginError, "Login failed");
        setError(normalized.message);
        setErrorDetails(normalized.details);
        throw loginError;
      } finally {
        setLoading(false);
      }
    },
    [clearError],
  );

  const register = useCallback(
    async (
      email: string,
      username: string,
      password: string,
      fullName?: string,
    ) => {
      clearError();
      setLoading(true);
      let created = false;
      try {
        await apiService.register({
          email,
          username,
          password,
          full_name: fullName,
        });
        created = true;
        await login(email, password);
      } catch (registerError) {
        const normalized = normalizeAuthError(
          registerError,
          "Registration failed",
        );
        setError(
          created
            ? "Your account was created, but automatic sign-in failed."
            : normalized.message,
        );
        setErrorDetails(normalized.details);
        throw registerError;
      } finally {
        setLoading(false);
      }
    },
    [clearError, login],
  );

  const value = useMemo<AuthContextType>(
    () => ({
      user: null,
      loading,
      isAuthenticated: false,
      error,
      errorDetails,
      login,
      register,
      logout: async () => undefined,
      refreshAuth: async () => undefined,
      clearError,
    }),
    [clearError, error, errorDetails, loading, login, register],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
