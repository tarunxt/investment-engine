/**
 * Cookie utilities for syncing authentication state to middleware
 */

export interface CookieOptions {
  maxAge?: number; // seconds
  path?: string;
  secure?: boolean;
  sameSite?: 'strict' | 'lax' | 'none';
  httpOnly?: boolean; // Note: httpOnly cookies cannot be set from JavaScript
}

/**
 * Set a cookie from client-side code
 * Note: httpOnly cookies cannot be set from JavaScript
 */
export const setCookie = (
  name: string,
  value: string,
  options: CookieOptions = {}
): void => {
  if (typeof window === 'undefined') return;

  const {
    maxAge = 7 * 24 * 60 * 60, // 7 days default
    path = '/',
    secure = false,
    sameSite = 'lax',
  } = options;

  let cookie = `${encodeURIComponent(name)}=${encodeURIComponent(value)}`;

  if (maxAge) {
    cookie += `; Max-Age=${maxAge}`;
  }

  cookie += `; Path=${path}`;
  cookie += `; SameSite=${sameSite}`;

  if (secure) {
    cookie += '; Secure';
  }

  document.cookie = cookie;
};

/**
 * Get a cookie value
 */
export const getCookie = (name: string): string | null => {
  if (typeof window === 'undefined') return null;

  const cookies = document.cookie.split('; ');
  for (const cookie of cookies) {
    const [cookieName, cookieValue] = cookie.split('=');
    if (decodeURIComponent(cookieName) === name) {
      return decodeURIComponent(cookieValue);
    }
  }

  return null;
};

/**
 * Delete a cookie
 */
export const deleteCookie = (name: string): void => {
  if (typeof window === 'undefined') return;
  setCookie(name, '', { maxAge: -1 });
};

/**
 * Sync access token to cookie for middleware
 * Called after login to make token available to server-side middleware
 */
export const syncTokenToCookie = (accessToken: string): void => {
  setCookie('app_access_token', accessToken, {
    maxAge: 15 * 60, // 15 minutes
    path: '/',
    sameSite: 'lax',
  });
};

/**
 * Clear auth cookies
 * Called on logout to clear token from middleware
 */
export const clearAuthCookies = (): void => {
  deleteCookie('app_access_token');
  deleteCookie('app_refresh_token');
};
