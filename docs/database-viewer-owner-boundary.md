# Private preparation: Database viewer owner boundary

Policy: only the user's individually verified active CredX account. Configure
`DATABASE_VIEWER_OWNER_USER_ID` server-side as the canonical positive decimal
CredX user ID. No default, real identifier, email, role or development identity
is supplied. Missing configuration fails closed. Do not configure or release
this change until separately approved.

Identity evidence: the signed-in browser can GET `/backend-api/auth/me` with its
existing same-origin Auth.js session. The BFF resolves the session and supplies
the bearer server-side. Display only the returned numeric `id` and boolean
`is_active`; never dump cookies, session objects, tokens or the entire profile.
The backend validates the bearer and loads the current active user. `/api/auth/session`
contains cached identity and is not an independent current-active verification.
No browser-side bearer extraction is required or permitted for this handoff.

Every root/child handler checks the genuine session and bounded `/auth/me` read
before forwarding. Denials never invoke the viewer. The direct child rewrite is
removed. Application cookies, bearer and arbitrary identity headers are not
forwarded; viewer Set-Cookie is suppressed, and external redirects are rejected.
Only GET and HEAD are currently eligible. Viewer authentication flows requiring
POST/cookies are deliberately unsupported pending separate review; this patch
is access containment, not a working Adminer deployment or restored service.

GET-only HTTP does not enforce database read-only access. Before any native
viewer start, verify the existing database principal is appropriately restricted,
identify the actual native/systemd runtime and pinned executable provenance,
verify loopback-only exposure and no financial-service startup dependencies.
No Docker provisioning, package installation, credentials, grants or units are
included. If no approved native runtime/login exists, keep the viewer unavailable.

Publication, merge/deployment, the server-side owner setting and runtime start
all need separately scoped approval. Verify unauthenticated/non-owner/root/child
and write denials in production before considering runtime approval. Roll back by
keeping the viewer stopped and the route fail-closed; never restore public
forwarding to a running administrative interface.
