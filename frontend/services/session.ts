/**
 * Session Storage Service
 * Single source of truth for all authentication session persistence
 * Handles tokens, user data, and session metadata
 */

import { UserResponse } from "@/types/api";

export interface SessionData {
  accessToken: string | null;
  refreshToken: string | null;
  user: UserResponse | null;
  expiresAt: number | null;
}

const STORAGE_KEYS = {
  ACCESS_TOKEN: "app_access_token",
  REFRESH_TOKEN: "app_refresh_token",
  USER: "app_user",
  SESSION_EXPIRES: "app_session_expires",
} as const;

class SessionStorageService {
  /**
   * Check if we're in browser environment
   */
  private isClient(): boolean {
    return typeof window !== "undefined";
  }

  /**
   * Get complete session data
   */
  getSession(): SessionData {
    if (!this.isClient()) {
      return {
        accessToken: null,
        refreshToken: null,
        user: null,
        expiresAt: null,
      };
    }

    return {
      accessToken: localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN),
      refreshToken: localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN),
      user: this.getUserData(),
      expiresAt: this.getSessionExpiry(),
    };
  }

  /**
   * Save complete session
   */
  setSession(data: Partial<SessionData>): void {
    if (!this.isClient()) return;

    if (data.accessToken !== undefined) {
      if (data.accessToken) {
        localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, data.accessToken);
      } else {
        localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
      }
    }

    if (data.refreshToken !== undefined) {
      if (data.refreshToken) {
        localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, data.refreshToken);
      } else {
        localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
      }
    }

    if (data.user !== undefined) {
      if (data.user) {
        localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(data.user));
      } else {
        localStorage.removeItem(STORAGE_KEYS.USER);
      }
    }

    if (data.expiresAt !== undefined) {
      if (data.expiresAt) {
        localStorage.setItem(
          STORAGE_KEYS.SESSION_EXPIRES,
          data.expiresAt.toString()
        );
      } else {
        localStorage.removeItem(STORAGE_KEYS.SESSION_EXPIRES);
      }
    }
  }

  /**
   * Get access token
   */
  getAccessToken(): string | null {
    if (!this.isClient()) return null;
    return localStorage.getItem(STORAGE_KEYS.ACCESS_TOKEN);
  }

  /**
   * Set access token
   */
  setAccessToken(token: string | null): void {
    if (!this.isClient()) return;
    if (token) {
      localStorage.setItem(STORAGE_KEYS.ACCESS_TOKEN, token);
    } else {
      localStorage.removeItem(STORAGE_KEYS.ACCESS_TOKEN);
    }
  }

  /**
   * Get refresh token
   */
  getRefreshToken(): string | null {
    if (!this.isClient()) return null;
    return localStorage.getItem(STORAGE_KEYS.REFRESH_TOKEN);
  }

  /**
   * Set refresh token
   */
  setRefreshToken(token: string | null): void {
    if (!this.isClient()) return;
    if (token) {
      localStorage.setItem(STORAGE_KEYS.REFRESH_TOKEN, token);
    } else {
      localStorage.removeItem(STORAGE_KEYS.REFRESH_TOKEN);
    }
  }

  /**
   * Set both tokens at once
   */
  setTokens(accessToken: string, refreshToken: string): void {
    this.setAccessToken(accessToken);
    this.setRefreshToken(refreshToken);
  }

  /**
   * Get user data
   */
  getUserData(): UserResponse | null {
    if (!this.isClient()) return null;
    const user = localStorage.getItem(STORAGE_KEYS.USER);
    return user ? JSON.parse(user) : null;
  }

  /**
   * Set user data
   */
  setUserData(user: UserResponse | null): void {
    if (!this.isClient()) return;
    if (user) {
      localStorage.setItem(STORAGE_KEYS.USER, JSON.stringify(user));
    } else {
      localStorage.removeItem(STORAGE_KEYS.USER);
    }
  }

  /**
   * Get session expiry timestamp
   */
  getSessionExpiry(): number | null {
    if (!this.isClient()) return null;
    const expiry = localStorage.getItem(STORAGE_KEYS.SESSION_EXPIRES);
    return expiry ? parseInt(expiry, 10) : null;
  }

  /**
   * Set session expiry
   */
  setSessionExpiry(expiresIn: number): void {
    if (!this.isClient()) return;
    const expiresAt = Date.now() + expiresIn * 1000;
    localStorage.setItem(STORAGE_KEYS.SESSION_EXPIRES, expiresAt.toString());
  }

  /**
   * Check if session is expired
   */
  isSessionExpired(): boolean {
    const expiry = this.getSessionExpiry();
    if (!expiry) return true;
    return Date.now() > expiry;
  }

  /**
   * Check if authenticated (has tokens)
   */
  isAuthenticated(): boolean {
    return !!this.getAccessToken();
  }

  /**
   * Clear entire session
   */
  clearSession(): void {
    if (!this.isClient()) return;
    Object.values(STORAGE_KEYS).forEach((key) => {
      localStorage.removeItem(key);
    });
  }

  /**
   * Sync session to storage (useful for cross-tab sync)
   */
  toJSON(): SessionData {
    return this.getSession();
  }
}

// Export singleton instance
export const sessionStorage = new SessionStorageService();
