import { randomUUID } from "node:crypto";
import { fetchDatabaseViewerSocket } from "./databaseViewerSocket.ts";

const hopHeaders = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function forwardingHeaders(source: Headers) {
  const headers = new Headers(source);
  for (const name of (headers.get("connection") || "").split(",")) {
    if (name.trim()) headers.delete(name.trim());
  }
  for (const name of hopHeaders) headers.delete(name);
  headers.delete("host");
  return headers;
}

export function databaseFailurePage(reference: string) {
  // The reference is generated here, never taken from upstream errors or input.
  const safeReference = reference.replace(/[^a-zA-Z0-9-]/g, "");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Database unavailable | Cred-X</title><style>
  body{margin:0;background:#f8fafc;color:#0f172a;font:16px system-ui,sans-serif}main{max-width:640px;margin:10vh auto;padding:32px;border:1px solid #cbd5e1;border-radius:16px;background:white}h1{font-size:28px}p{line-height:1.6;color:#475569}nav{display:flex;flex-wrap:wrap;gap:16px;margin-top:24px}a{padding:12px 18px;border:1px solid #64748b;border-radius:8px;color:#0f172a;text-decoration:none}a:first-child{background:#0f172a;color:white}a:focus-visible{outline:3px solid #2563eb;outline-offset:4px}small{display:block;margin-top:24px;overflow-wrap:anywhere}@media(max-width:700px){main{margin:24px 16px;padding:24px}}
  </style></head><body><main aria-labelledby="title"><h1 id="title" tabindex="-1">Database is unavailable</h1><p>We couldn’t load the Database viewer. Its data could not be checked. This does not mean the database is empty.</p><p>Try again. If the problem continues, share the support reference below with your support contact.</p><nav aria-label="Recovery actions"><a href="/database">Retry Database</a><a href="/console/dashboard">Back to console</a></nav><small>Support reference: ${safeReference}</small></main></body></html>`;
}

export async function proxyDatabaseDestination(request: Request, fetcher: typeof fetch = fetchDatabaseViewerSocket) {
  const reference = `DB-${randomUUID()}`;
  // Virtual URL only: transport is always the private Unix socket.
  const origin = "http://viewer.invalid";
  // Application credentials and identity headers never cross into the viewer.
  const headers = new Headers();
  for (const name of ['accept', 'accept-language']) {
    const value = request.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Application authentication has already been verified by the protected handler.
  const readOnly = request.method === "GET" || request.method === "HEAD";
  try {
    const destination = new URL(origin);
    const path = new URL(request.url).pathname;
    if (path !== '/database' && !path.startsWith('/database/')) return new Response(null, { status: 400 });
    const suffix = path.slice('/database'.length);
    // Reject ambiguous encoded paths, backslashes and dot segments before URL resolution.
    if (/[\\%]/.test(suffix) || suffix.split('/').some(part => part === '.' || part === '..')) return new Response(null, { status: 400 });
    destination.pathname = destination.pathname.replace(/\/$/, '') + (suffix || '/');
    destination.search = new URL(request.url).search;
    const response = await fetcher(destination, {
      method: request.method,
      headers,
      body: readOnly ? undefined : await request.arrayBuffer(),
      redirect: "manual",
      cache: "no-store",
      signal: AbortSignal.any([request.signal, AbortSignal.timeout(10_000)]),
    });
    if (response.status < 500) {
      const responseHeaders = forwardingHeaders(response.headers);
      // fetch decompresses response bodies; do not forward stale wire metadata.
      responseHeaders.delete("set-cookie");
      const location = responseHeaders.get('location');
      if (location) {
        const redirect = new URL(location, destination);
        if (redirect.origin !== destination.origin) return new Response(null, { status: 502, headers: { 'cache-control': 'no-store' } });
        responseHeaders.set('location', '/database' + redirect.pathname + redirect.search);
      }
      responseHeaders.delete("content-encoding");
      responseHeaders.delete("content-length");
      responseHeaders.set("cache-control", "no-store");
      return new Response(request.method === "HEAD" ? null : response.body, {
        status: response.status,
        statusText: response.statusText,
        headers: responseHeaders,
      });
    }
    await response.body?.cancel();
    console.error("Database destination unavailable", { reference, status: response.status });
  } catch {
    console.error("Database destination unavailable", { reference });
  }
  return new Response(request.method === "HEAD" ? null : databaseFailurePage(reference), {
    status: 503,
    headers: {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
      "retry-after": "10",
      "x-support-reference": reference,
    },
  });
}
