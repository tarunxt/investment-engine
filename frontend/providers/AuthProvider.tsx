"use client";

import { AuthContextType, AuthContext, type User } from "@/hooks/useAuth";
import { syncTokenToCookie, clearAuthCookies } from "@/services/cookies";
import { useState, useEffect, useCallback } from "react";
import { sessionStorage as customSessionStorage } from "@/services/session";
import { useSession, signIn, signOut as nextSignOut } from "next-auth/react";
import { UserResponse } from "@/types/api";
import { apiService } from "@/services/api";

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const { data: session, status, update } = useSession();
  const [user, setUser] = useState<UserResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

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
        // Update NextAuth session
        await update();
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

          // Store expiry time: now + expiresIn seconds
          const expiryTime = Date.now() + (session.userData?.expiresIn || 900) * 1000;
          customSessionStorage.setSessionExpiry(expiryTime);

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

  // Check token expiry on mount and when user changes
  useEffect(() => {
    if (user && isTokenExpired()) {
      queueMicrotask(() => {
        handleTokenExpiry();
      });
    }
  }, [user, isTokenExpired, handleTokenExpiry]);

  // Set up visibility change listener to check token on tab focus
  useEffect(() => {
    const handleVisibilityChange = () => {
      if (!document.hidden && user && isTokenExpired()) {
        handleTokenExpiry();
      }
    };

    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => document.removeEventListener("visibilitychange", handleVisibilityChange);
  }, [user, isTokenExpired, handleTokenExpiry]);

  const login = useCallback(async (emailOrUsername: string, password: string) => {
    setError(null);
    setLoading(true);

    try {
      // Determine if input is email or username
      const isEmail = emailOrUsername.includes("@");

      const result = await signIn("credentials", {
        [isEmail ? "email" : "username"]: emailOrUsername,
        password,
        redirect: false,
      });

      if (result?.error) {
        throw new Error(result.error);
      }

      // Wait for session to update
      await update();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Login failed";
      setError(errorMsg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [update]);

  const register = useCallback(async (
    email: string,
    username: string,
    password: string,
    fullName?: string
  ) => {
    setError(null);
    setLoading(true);

    try {
      // Direct API call for registration
      await apiService.register({
        email,
        username,
        password,
        full_name: fullName,
      });

      // Auto-login after registration
      await login(email, password);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : "Registration failed";
      setError(errorMsg);
      throw err;
    } finally {
      setLoading(false);
    }
  }, [login]);

  const logout = useCallback(async () => {
    setError(null);
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
  }, []);

  const refreshAuth = useCallback(async () => {
    await update();
  }, [update]);

  const clearError = useCallback(() => setError(null), []);

  const value: AuthContextType = {
    user: user ? ({
      ...user,
      full_name: user.full_name ?? undefined,
    } as User) : null,
    loading,
    isAuthenticated: !!user,
    error,
    login,
    register,
    logout,
    refreshAuth,
    clearError,
  };

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}