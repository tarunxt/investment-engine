"use client";

import { useCallback, useMemo, useState } from "react";
import { signIn } from "next-auth/react";

import { AuthContext, type AuthContextType } from "@/hooks/useAuth";

class PublicAuthRequestError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "PublicAuthRequestError";
  }
}

async function registerPublicAccount(input: {
  email: string;
  username: string;
  password: string;
  full_name?: string;
}) {
  let response: Response;
  try {
    response = await fetch("/backend-api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(input),
    });
  } catch {
    throw new PublicAuthRequestError(
      "We could not reach the authentication server from your browser.",
      null,
    );
  }

  if (response.ok) return;
  const payload = await response.json().catch(() => null);
  const detail =
    payload && typeof payload === "object" && "detail" in payload
      ? payload.detail
      : null;
  throw new PublicAuthRequestError(
    typeof detail === "string" && detail.trim()
      ? detail
      : `Registration failed with HTTP ${response.status}.`,
    response.status,
  );
}

function normalizeAuthError(error: unknown, fallback: string) {
  if (error instanceof PublicAuthRequestError && error.status === null) {
    return {
      message: error.message,
      details: [],
    };
  }
  if (error instanceof PublicAuthRequestError) {
    return {
      message: error.message || fallback,
      details: error.status === null ? [] : [`HTTP ${error.status}`],
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
      redirectTo = "/console/dashboard",
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
        await registerPublicAccount({
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
