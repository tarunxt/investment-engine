"use client";

import { AuthContextType, AuthContext, type User } from "@/hooks/useAuth";
import { clearAuthCookies } from "@/services/cookies";
import { useState, useEffect, useCallback, useRef } from "react";
import { useSession, signIn, signOut as nextSignOut } from "next-auth/react";
import { UserResponse } from "@/types/api";
import { APIError, NetworkError, apiService } from "@/services/api";
import { URLs } from "@/lib/urls";
import {
  clearBrowserPrivateCacheOwner,
  purgeBrowserPrivateDashboardCaches,
  reconcileBrowserPrivateCacheOwner,
} from "@/lib/privateDashboardCache";

const devAuthDisabled =
  process.env.NEXT_PUBLIC_DISABLE_AUTH === "true" ||
  process.env.NODE_ENV === "development";

const devUser: UserResponse = {
  id: 1,
  email: "dev@localhost",
  username: "dev",
  full_name: "Local Developer",
  role: "admin",
  is_active: true,
  is_verified: true,
  created_at: new Date(0).toISOString(),
  updated_at: new Date(0).toISOString(),
  last_login: null,
  profile: {
    user_id: 1,
    avatar_url: null,
    bio: null,
    timezone: "UTC",
    notification_preferences: "all",
    theme_preference: "light",
    created_at: new Date(0).toISOString(),
    updated_at: new Date(0).toISOString(),
  },
};

export function AuthProvider({
  children,
  initialUser = null,
}: {
  children: React.ReactNode;
  initialUser?: UserResponse | null;
}) {
  const { data: session, status, update } = useSession();
  const [user, setUser] = useState<UserResponse | null>(
    devAuthDisabled ? devUser : initialUser,
  );
  const [loading, setLoading] = useState(!devAuthDisabled && !initialUser);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);
  const previousUserIdRef = useRef<number | null>(initialUser?.id ?? null);

  useEffect(() => {
    const nextUserId = user?.id ?? null;
    const previousUserId = previousUserIdRef.current;
    if (
      previousUserId !== null &&
      nextUserId !== null &&
      previousUserId !== nextUserId
    ) {
      purgeBrowserPrivateDashboardCaches();
    }
    if (nextUserId !== null) {
      reconcileBrowserPrivateCacheOwner(nextUserId);
    }
    previousUserIdRef.current = nextUserId;
  }, [user?.id]);

  const clearErrorState = useCallback(() => {
    setError(null);
    setErrorDetails([]);
  }, []);

  const setStructuredError = useCallback((message: string, details: string[] = []) => {
    setError(message);
    setErrorDetails(details);
  }, []);

  const normalizeAuthError = useCallback((err: unknown, fallbackMessage: string) => {
    if (err instanceof NetworkError) {
      return {
        message: "We could not reach the authentication server from your browser.",
        details: [
          `${err.method} ${err.url}`,
          "This usually means the frontend is pointing at the wrong API URL or the request was blocked before the server responded.",
          `Browser error: ${err.originalMessage}`,
        ],
      };
    }

    if (err instanceof APIError) {
      const details: string[] = [`HTTP ${err.status}`];
      const payload = err.details as Record<string, unknown> | undefined;
      const detail = payload?.detail;
      const rawDetails = Array.isArray(detail)
        ? detail.filter((item): item is string => typeof item === "string")
        : typeof detail === "string"
          ? [detail]
          : [];

      return {
        message: err.message || fallbackMessage,
        details: [...details, ...rawDetails],
      };
    }

    if (err instanceof Error) {
      if (err.message === "CredentialsSignin") {
        return {
          message: "Invalid email, username, or password.",
          details: ["The credentials provider rejected the sign-in attempt."],
        };
      }

      return {
        message: err.message || fallbackMessage,
        details: [],
      };
    }

    return {
      message: fallbackMessage,
      details: [],
    };
  }, []);

  // Remove credentials left by pre-hardening clients. Auth.js's encrypted,
  // HttpOnly cookie is now the only browser session credential.
  useEffect(() => {
    if (devAuthDisabled) return;
    clearAuthCookies();
    performance.mark("console-server-identity-visible");
    performance.mark("auth-client-bootstrap-start");
  }, []);

  // The server-provided user is authoritative for the first render. A delayed
  // /api/auth/session request must never replace already validated children
  // with a restoration screen.
  useEffect(() => {
    if (devAuthDisabled) {
      return;
    }

    if (status === "loading") {
      return;
    }

    if (status === "authenticated" && session) {
      const userData = session.userData as unknown as UserResponse | undefined;
      performance.mark("auth-client-session-ready");
      performance.measure(
        "auth-client-bootstrap",
        "auth-client-bootstrap-start",
        "auth-client-session-ready",
      );
      const timer = window.setTimeout(() => {
        if (userData) {
          setUser(userData);
        }
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    } else if (status === "unauthenticated") {
      performance.mark("auth-client-session-failed");
      performance.measure(
        "auth-client-bootstrap",
        "auth-client-bootstrap-start",
        "auth-client-session-failed",
      );
      purgeBrowserPrivateDashboardCaches();
      clearBrowserPrivateCacheOwner();
      clearAuthCookies();
      const timer = window.setTimeout(() => {
        setUser(null);
        setLoading(false);
      }, 0);
      return () => window.clearTimeout(timer);
    }
  }, [session, status]);

  useEffect(() => {
    apiService.setSessionGeneration(
      session?.generation || (user ? `server-user:${user.id}` : "anonymous"),
    );
  }, [session?.generation, user]);

  const login = useCallback(async (
    emailOrUsername: string,
    password: string,
    redirectTo = URLs.routes.console.dashboard(),
  ) => {
    if (devAuthDisabled) {
      setUser(devUser);
      clearErrorState();
      setLoading(false);
      return;
    }

    clearErrorState();
    setLoading(true);

    try {
      // Determine if input is email or username
      const isEmail = emailOrUsername.includes("@");
      const callbackUrl = redirectTo;

      const result = await signIn("credentials", {
        [isEmail ? "email" : "username"]: emailOrUsername,
        password,
        callbackUrl,
        redirect: false,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      if (typeof window !== "undefined") {
        window.location.assign(result?.url || callbackUrl);
      }
    } catch (err) {
      const normalized = normalizeAuthError(err, "Login failed");
      setStructuredError(normalized.message, normalized.details);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [clearErrorState, normalizeAuthError, setStructuredError]);

  const register = useCallback(async (
    email: string,
    username: string,
    password: string,
    fullName?: string
  ) => {
    if (devAuthDisabled) {
      setUser(devUser);
      clearErrorState();
      setLoading(false);
      return;
    }

    clearErrorState();
    setLoading(true);
    let registrationSucceeded = false;

    try {
      // Direct API call for registration
      await apiService.register({
        email,
        username,
        password,
        full_name: fullName,
      });
      registrationSucceeded = true;

      // Auto-login after registration
      await login(email, password);
    } catch (err) {
      if (registrationSucceeded) {
        const normalized = normalizeAuthError(
          err,
          "Your account was created, but automatic sign-in failed.",
        );
        setStructuredError(
          "Your account was created, but we could not complete automatic sign-in.",
          [
            ...normalized.details,
            "Please use the Sign In button below with the credentials you just created.",
          ],
        );
      } else {
        const normalized = normalizeAuthError(err, "Registration failed");
        setStructuredError(normalized.message, normalized.details);
      }
      throw err;
    } finally {
      setLoading(false);
    }
  }, [clearErrorState, login, normalizeAuthError, setStructuredError]);

  const logout = useCallback(async () => {
    if (devAuthDisabled) {
      setUser(devUser);
      clearErrorState();
      setLoading(false);
      window.location.href = "/console/dashboard";
      return;
    }

    clearErrorState();
    setLoading(true);

    try {
      if (user) {
        await apiService.logout().catch(console.error);
      }
    } catch (err) {
      console.error("Logout API error:", err);
    } finally {
      await nextSignOut({ redirect: false });
      purgeBrowserPrivateDashboardCaches();
      clearBrowserPrivateCacheOwner();
      apiService.setSessionGeneration("anonymous");
      clearAuthCookies();
      setUser(null);
      setLoading(false);
      window.location.href = "/login";
    }
  }, [clearErrorState, user]);

  const refreshAuth = useCallback(async () => {
    if (devAuthDisabled) {
      setUser(devUser);
      setLoading(false);
      clearErrorState();
      return;
    }

    try {
      const updatedSession = await update();
      if (!updatedSession?.user) {
        throw new Error("The authenticated session could not be verified.");
      }
      clearErrorState();
    } catch (refreshError) {
      const normalized = normalizeAuthError(
        refreshError,
        "Your session could not be verified. Reload or sign in again.",
      );
      setStructuredError(normalized.message, normalized.details);
      setLoading(false);
      throw refreshError;
    }
  }, [
    clearErrorState,
    normalizeAuthError,
    setStructuredError,
    update,
  ]);

  const clearError = clearErrorState;

  const value: AuthContextType = {
    user: user ? ({
      ...user,
      full_name: user.full_name ?? undefined,
    } as User) : null,
    loading,
    isAuthenticated: !!user,
    error,
    errorDetails,
    login,
    register,
    logout,
    refreshAuth,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
