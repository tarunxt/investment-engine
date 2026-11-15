/** Owner identity comes only from the current authenticated backend user. */
export async function authorizeDatabaseOwner(request: Request, options: {
  ownerId?: string;
  readSession: () => Promise<{ accessToken?: unknown } | null>;
  backendUrl: string;
  fetcher?: typeof fetch;
}): Promise<Response | null> {
  const deny = (status: number) => new Response(null, {
    status, headers: { 'cache-control': 'no-store' },
  });
  if (!options.ownerId || !/^[1-9][0-9]*$/.test(options.ownerId)) return deny(503);
  try {
    const session = await options.readSession();
    if (typeof session?.accessToken !== 'string' || !session.accessToken.trim()) return deny(401);
    const response = await (options.fetcher ?? fetch)(`${options.backendUrl.replace(/\/+$/, '')}/auth/me`, {
      headers: { Authorization: `Bearer ${session.accessToken}` },
      redirect: 'manual', cache: 'no-store', signal: AbortSignal.any([request.signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) return deny(response.status === 401 || response.status === 403 ? response.status : 503);
    const user = await response.json();
    request.signal.throwIfAborted();
    if (!Number.isSafeInteger(user?.id) || user.id <= 0 || user.is_active !== true || String(user.id) !== options.ownerId) return deny(403);
    // No upstream viewer writes are approved. HTTP restrictions do not establish
    // database read-only privileges; those must be verified independently.
    if (request.method !== 'GET' && request.method !== 'HEAD') return deny(405);
    return null;
  } catch {
    return deny(503);
  }
}
