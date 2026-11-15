# Cred-X CDN and edge-cache rules

This is an operator guide. It does not authorize automatic DNS, Cloudflare, or
CloudFront account changes.

## Safe cache policy

Cache only content-addressed public build assets:

| Path | Edge/browser policy |
| --- | --- |
| `/_next/static/*` | Public, one year, immutable; cache key includes full path and query |
| Explicit versioned public fonts/images | Public, long-lived only when filename changes with content |
| Public unversioned images | Short TTL with revalidation |

Always bypass cache for:

- `/console/*`;
- `/api/auth/*`;
- `/backend-api/*`;
- `api.cred-x.in/*`;
- WebSocket and streaming paths;
- any request with `Authorization` or Auth.js/session cookies;
- every non-GET/HEAD method;
- redirects and responses containing `Set-Cookie`;
- responses marked `private`, `no-store`, or `no-cache`.

Do not create a “cache everything” rule for HTML. Never use a shared CDN cache
for portfolio, threat, run, order, audit, session, or other user-specific data.

## Cloudflare outline

1. Proxy the website hostnames only after verifying origin certificates and
   rollback.
2. Add a highest-priority bypass rule for the excluded paths, methods,
   authorization headers, and session cookies above.
3. Add a lower-priority cache rule matching only
   `^/_next/static/` with edge and browser TTL of one year and origin
   `Cache-Control` respected.
4. Enable Brotli at the edge. Do not assume the origin Nginx has the Brotli
   module.
5. Preserve WebSocket support and do not buffer streaming routes.
6. Verify `Age`, `CF-Cache-Status`, `Cache-Control`, `Content-Type`, compressed
   transfer size, and that authenticated HTML always bypasses.

## CloudFront outline

Use separate cache behaviors:

- `/_next/static/*`: GET/HEAD only, compression enabled, one-year cache policy,
  no cookies or authorization forwarded, query strings only if asset URLs use
  them.
- default behavior: caching disabled, all required cookies and authorization
  forwarded to the origin.
- `/backend-api/*`, `/api/auth/*`, and `/console/*`: explicit caching-disabled
  behaviors so a later default-policy change cannot expose private data.

Use Origin Shield only after measuring benefit. Keep API mutations and WebSocket
routes off the static behavior.

## Verification

From a clean browser and a second request:

```bash
curl -sS -D - -o /dev/null \
  https://cred-x.in/_next/static/chunks/<hashed-file>.js
curl -sS -D - -o /dev/null https://cred-x.in/console/dashboard
curl -sS -D - -o /dev/null https://cred-x.in/backend-api/health/live
```

The hashed asset must be public/immutable and compressed when accepted. Console
and proxy responses must never be publicly cacheable. Repeat the checks with an
authenticated test account without printing cookies or tokens.
