"use client";

import { AuthContextType, AuthContext, type User } from "@/hooks/useAuth";
import { syncTokenToCookie, clearAuthCookies } from "@/services/cookies";
import { useState, useEffect, useCallback } from "react";
import {
  AUTH_TOKENS_REFRESHED_EVENT,
  type RefreshedAuthTokens,
  sessionStorage as customSessionStorage,
} from "@/services/session";
import { useSession, signIn, signOut as nextSignOut } from "next-auth/react";
import { UserResponse } from "@/types/api";
import { APIError, NetworkError, apiService } from "@/services/api";
import { URLs } from "@/lib/urls";

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

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status, update } = useSession();
  const [user, setUser] = useState<UserResponse | null>(devAuthDisabled ? devUser : null);
  const [loading, setLoading] = useState(!devAuthDisabled);
  const [error, setError] = useState<string | null>(null);
  const [errorDetails, setErrorDetails] = useState<string[]>([]);

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

  // Check if token is expired
  const isTokenExpired = useCallback((): boolean => {
    const expiryTime = customSessionStorage.getSessionExpiry();
    if (!expiryTime) return true;

    const now = Date.now();
    const isExpired = now >= expiryTime;

    if (isExpired) {
      console.warn("Access token has expired");
    }

    return isExpired;
  }, []);

  // Refresh token or logout if expired
  const handleTokenExpiry = useCallback(async () => {
    const refreshToken = customSessionStorage.getRefreshToken();

    if (!refreshToken) {
      // No refresh token, must logout
      await nextSignOut({ redirect: false });
      customSessionStorage.clearSession();
      clearAuthCookies();
      setUser(null);
      return;
    }

    try {
      // Try to refresh the token
      console.log("Token expired, attempting refresh...");

      const data = await apiService.refreshToken();

      if (data.access_token && data.refresh_token) {
        // refreshToken emits an event that persists this rotated pair in the
        // Auth.js JWT as well as local storage.
        console.log("Token refreshed successfully");
      }
    } catch (err) {
      console.error("Token refresh failed, logging out:", err);
      // Refresh failed, logout the user
      await nextSignOut({ redirect: false });
      customSessionStorage.clearSession();
      clearAuthCookies();
      setUser(null);
    }
  }, [update]);

  // Sync NextAuth session with custom storage
  useEffect(() => {
    if (devAuthDisabled) {
      return;
    }

    // Only sync when status is no longer loading
    if (status === "loading") {
      return;
    }

    // Sync authenticated session
    if (status === "authenticated" && session) {
      // Get user data from session
      const userData = session.userData || session.user;

      if (userData) {
        // eslint-disable-next-line react-hooks/set-state-in-effect
        setUser(userData as UserResponse);

        // Sync to existing session storage for backward compatibility
        if (session.accessToken) {
          customSessionStorage.setTokens(
            session.accessToken as string,
            session.refreshToken as string || ""
          );
          customSessionStorage.setUserData(userData as UserResponse);

          // setSessionExpiry accepts a duration in seconds, not an absolute
          // timestamp. Passing a timestamp kept expired tokens looking valid
          // for decades and deferred refresh until requests were already 401.
          customSessionStorage.setSessionExpiry(session.expiresIn ?? 900);

          syncTokenToCookie(session.accessToken as string);
        }
      }
    }
    // Clear session when unauthenticated
    else if (status === "unauthenticated") {
      setUser(null);
      customSessionStorage.clearSession();
      clearAuthCookies();
    }

    // Always ensure loading is false when status is not "loading"
    setLoading(false);
  }, [session, status]);

  // Keep Auth.js's cookie-backed JWT aligned with credentials refreshed by
  // apiService. This prevents a hard navigation from restoring a stale token
  // and firing a burst of unauthorized page-load requests.
  useEffect(() => {
    if (devAuthDisabled) return;

    const handleTokensRefreshed = (event: Event) => {
      const { accessToken, refreshToken, expiresIn } = (
        event as CustomEvent<RefreshedAuthTokens>
      ).detail;
      void update({ accessToken, refreshToken, expiresIn });
    };

    window.addEventListener(AUTH_TOKENS_REFRESHED_EVENT, handleTokensRefreshed);
    return () => {
      window.removeEventListener(AUTH_TOKENS_REFRESHED_EVENT, handleTokensRefreshed);
    };
  }, [update]);

  // Check token expiry on mount and when user changes
  useEffect(() => {
    if (devAuthDisabled) {
      return;
    }

    if (user && isTokenExpired()) {
      queueMicrotask(() => {
        handleTokenExpiry();
      });
    }
  }, [user, isTokenExpired, handleTokenExpiry]);

  // Set up visibility change listener to check token on tab focus
  useEffect(() => {
    if (devAuthDisabled) {
      return;
    }

    const handleVisibilityChange = () => {
      if (!document.hidden && user && isTokenExpired()) {
        handleTokenExpiry();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [user, isTokenExpired, handleTokenExpiry]);

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
      // Call API logout if needed
      const token = customSessionStorage.getAccessToken();
      if (token) {
        await apiService.logout().catch(console.error);
      }
    } catch (err) {
      console.error("Logout API error:", err);
    } finally {
      await nextSignOut({ redirect: false });
      customSessionStorage.clearSession();
      clearAuthCookies();
      setUser(null);
      setLoading(false);
      window.location.href = "/login";
    }
  }, [clearErrorState]);

  const refreshAuth = useCallback(async () => {
    if (devAuthDisabled) {
      setUser(devUser);
      setLoading(false);
      clearErrorState();
      return;
    }

    await update();
  }, [clearErrorState, update]);

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
