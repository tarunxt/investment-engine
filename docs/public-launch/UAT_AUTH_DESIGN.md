# Prepared UAT authentication design

This is an offline component design, not a deployed or complete login flow.
Production authentication remains unchanged.

## Callback contract

Use the Google Identity Services JavaScript popup callback. The browser obtains
a server-issued nonce from a future same-origin `POST /auth/google/challenge`,
then passes it to GIS initialization. Its callback sends `credential` and `nonce`
as JSON to same-origin `POST /auth/google`. This is an application callback,
not an OAuth authorization-code redirect. It requires an independent web client
with the exact UAT JavaScript origin; no offline grant, Google refresh token,
client secret or additional API scopes are needed for this identity flow.

The challenge endpoint must set `__Host-credx_uat_login`, Secure, HttpOnly,
SameSite=Strict, Path=/, without Domain, with a five-minute lifetime. Both
endpoints must reject missing or mismatched Origin, duplicate cookies/headers,
non-JSON requests, oversized input and CORS requests from other origins. Return
Cache-Control: no-store, and expire the challenge cookie after completion.
Both endpoints mount only when `create_private_app` receives an explicit
`google_login` dependency. No live dependency or deployable entrypoint exists.

The in-memory challenge component binds nonce to cookie, limits outstanding
challenges to 256, expires after five minutes, and consumes atomically before
profile resolution. A single process is mandatory; multiple workers require a
separately reviewed isolated atomic store. The HTTP adapter caps attempts at 30
per minute per process, bounds bodies to 17 KB, and checks exact origin, host,
JSON shape and duplicate cookies/headers. Restart invalidates challenges.

## Verification and subject binding

The offline Google verifier accepts only RS256, a trusted RSA public key bundle,
an unexpired bundle deadline, the configured UAT audience, Google's issuers,
valid timestamps, the bound nonce, and the explicit verified owner email.
Unknown keys fail closed. Token headers cannot select URLs or algorithms.
The trusted key provider receives no credential or attacker-selected key ID.
The explicit key-cache refresh component accepts an injected HTTP client and
requests only Google's fixed public JWKS URL. It rejects redirects, bounds time
and response size, checks key shape and cache lifetime, and clears the cache on
failure. Tests inject a mocked transport; no live HTTP client is configured.
Approved TLS-verifying client configuration, certificate-only network access
and scheduled rotation remain deployment gates.

After these checks, the resolver receives the verified Google subject and email.
It must persist subject binding, reject conflicting/ambiguous subjects and
provide only an empty synthetic profile. Returned subject, active state and
owner email are checked before token issuance. No production resolver is used.

## Signing and session boundary

Use an independently generated UAT-only random key of at least 32 bytes for
the fixed HS256 backend verifier; inject it through the approved secret tooling.
No key is generated or loaded by these components. Key length is not proof of
entropy or independence: provisioning and isolation evidence remain required.
Issuer is `credx-uat`, audience is `credx-uat-api`, access lifetime is at most
15 minutes. Token issuance must use unique IDs and matching timestamps. Signing
and a concrete secret reference are not implemented. Refresh verification has
a one-day upper bound, but no refresh endpoint or rotation/revocation store is
enabled. Keep refresh disabled until those controls are implemented and tested.

The existing private API uses bearer tokens. A future frontend can hold access
tokens in memory; do not put them in localStorage or reuse production cookies.
The challenge cookie is opaque, not a frontend signed session. If a frontend
session layer is introduced, it needs its own independent signing material and
CSRF tests. None of this removes the separate private access barrier required
for pages, static assets, APIs and WebSockets before any external exposure.

## Synthetic evidence

Run `python -m unittest discover -s scripts/uat/tests -v` after installing
`scripts/uat/requirements-test.txt` in an isolated environment. The PR-only
workflow runs the same suite without deployment credentials or service access.
Tests use transient in-memory RSA keys and public deterministic HMAC fixtures;
no live Google calls, persistent credentials or real user data are involved.

References: [Google ID token verification](https://developers.google.com/identity/gsi/web/guides/verify-google-id-token),
[GIS JavaScript callback and nonce](https://developers.google.com/identity/gsi/web/reference/js-reference),
[PyJWT verification API](https://pyjwt.readthedocs.io/en/stable/api.html).
