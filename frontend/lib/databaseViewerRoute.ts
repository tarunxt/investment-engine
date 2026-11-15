import { getToken } from '@auth/core/jwt';
import { readCookieNames, resolveSessionCookieSecurity } from './authSessionCookie';
import { authorizeDatabaseOwner } from './databaseViewerOwner';
import { proxyDatabaseDestination } from './databaseViewerProxy';

export async function protectedDatabaseDestination(request: Request) {
  const denial = await authorizeDatabaseOwner(request, {
    ownerId: process.env.DATABASE_VIEWER_OWNER_USER_ID,
    backendUrl: process.env.BACKEND_API_URL || process.env.API_URL || 'http://127.0.0.1:8000',
    readSession: async () => {
      const secret = process.env.NEXTAUTH_SECRET || process.env.AUTH_SECRET;
      // Never accept the application's development fallback or bypass identity.
      if (!secret || secret === 'local-auth-disabled-fallback-secret' || process.env.NEXT_PUBLIC_DISABLE_AUTH === 'true') return null;
      return getToken({ req: request, secret, secureCookie: resolveSessionCookieSecurity({
        cookieNames: readCookieNames(request.headers.get('cookie')),
        forwardedProtocol: request.headers.get('x-forwarded-proto'),
        requestProtocol: new URL(request.url).protocol,
        configuredAuthUrl: process.env.NEXTAUTH_URL || process.env.AUTH_URL,
      }) });
    },
  });
  return denial ?? proxyDatabaseDestination(request);
}
