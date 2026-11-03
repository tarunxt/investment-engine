# A9-003 session policy candidate

This implements the approved policy: ordinary logout revokes the current family;
password reset/change revokes every family for that account; using a still-valid
rotated refresh credential at `/auth/refresh` revokes its family. Other accounts
and families remain independent. No replay grace, replacement-token recovery,
new signing key, issuer/audience contract or token lifetime is introduced.

## Source dependencies and release sequence

Existing PR #1408 is preserved; this source was prepared on its exact head
8e16f1e3e72292a8d52e4e53bf3dad6b21387824 and merged current main
ece97f648e52deb357f6d262448f577e28edbe4e plus signing baseline PR #1391
6f65e921ecf64bdd4421ac4e02757dca8aaa04ca. The signing lane branch is untouched.
The candidate includes mandatory configured-key startup; it cannot safely activate
with an absent key or bypass that approval. It does not modify financial controls,
enable workers or perform runtime activation. A9-004 a0ec4958 is excluded.

The root/sole production operator owns activation. Required sequence:

1. Review the exact signing baseline and session diff; pass current exact-head CI
   and independent security review, including the new intent protocol.
2. Complete action-time signing/security confirmation and verify migration heads
   on the actual target through the operator. Never read/publish a key as evidence.
3. Apply reviewed migrations using the approved operator route. They create only
   empty family/intent tables, indexes and a merge revision, without session backfill.
4. Obtain the action-time legacy-session cutover/security confirmation. Deploy the
   reviewed backend and BFF together: old BFFs do not perform durable intent, so a
   mixed old/new refresh deployment does not have the new concurrency guarantee.
5. Perform only operator-approved identity tests, then assess staged activation.

The WebSocket family check changes overlap the A9-002 ownership boundary. The sole
integrator must preserve that lane's ownership/redaction changes; this lane does
not claim to fix the pre-existing run-channel ownership finding independently.
No merge, production migration, real session invalidation or server settings change
was performed while preparing this candidate. PR metadata changes remain on hold.

## Durable state and exact enforcement boundary

`auth_session_families` stores a random opaque family ID, user foreign key,
SHA-256 refresh digest, expiry and active bit. Access tokens preserve their no-type
shape and add `sid`; refresh credentials retain `type=refresh` and add `sid`/`jti`.
Access lifetime stays 15 minutes and refresh lifetime stays seven days; rotation
preserves the existing sliding replacement expiry. No new absolute lifetime cap
is selected. Existing subject/email/role claims remain unchanged otherwise.

All family mutations lock user before family. Password verification/write and
family invalidation share their transaction. Reuse revocation commits before 401,
so the exception does not roll back the security event. Missing/failing storage
never permits a fallback session. Startup selects both complete table mappings;
a missing column/table or unavailable DB prevents startup before prompt seeding.

API authentication checks active user/family at the request boundary. An already
authorized request may complete across a later logout; this does not cancel jobs
or financial work. WebSockets check family/expiry before forwarding messages and
on a five-second idle watch; this is not instantaneous remote memory erasure.

## Cross-BFF refresh intent and uncertainty

Process-local single-flight remains an optimization, not the security boundary.
The BFF first calls `/auth/refresh-intent`. Authoritative token/user/family checks
and user/family locks issue one nonce and commit a digest-only intent before any
refresh dispatch. The table contains only token/nonce digests, family ID and a
started bit. It is neither canonical credential storage nor account authorization.
The existing encrypted HttpOnly Auth.js cookie remains credential custody.

Concurrent or delayed cookie requests find the existing intent and receive 409
with reload/sign-in guidance, without dispatching refresh, recovering credentials
or revoking the successful family's replacement. This claim refusal is distinct
from replaying a credential at the actual refresh endpoint. A direct old rotated
credential at `/auth/refresh` still revokes the family. Omission of a nonce cannot
bypass an existing reservation/unknown outcome for a still-current credential.

The actual refresh path marks an intent started and commits before rotation can
consume it, then reacquires user/family locks and rechecks logout/password state.
No lease expiry, takeover or automatic retry is supplied. Lost claim reply, failed
commit acknowledgement, process death, lost replacement cookie/reply and stalled
transport require reload of a newer existing cookie or reauthentication. No endpoint
returns replacement credentials for an old token. Late results after the BFF's
deadline are discarded. Auth.js updates accept only same-request trusted async
context bound to the previous credential, account and generation; browser-supplied
update fields cannot replace credentials or identity.

Logout uses the existing family-bound refresh credential solely to revoke, without
competing for refresh intent or needing an unexpired access credential. The response
claims confirmed revocation only after commit. Local cleanup, SDK sign-out and
durable revocation outcomes remain separate. Immediate UI/cache gating, finite SDK
recovery, generic-401 fencing and same-flow logout coalescing are retained. SSR and
private read helpers never refresh or mutate cookies; a supported handler is needed.

There is no automatic intent-row pruning. A future cleanup must retain records for
as long as their credential can still pass JWT verification; no cleanup lease or
new expiry policy is inferred. Database growth/capacity and abuse limits for the
new endpoint need independent review before activation.

## Historical compatibility, migration and rollback

The cryptographic verifier still accepts existing correctly purposed expiring token
shapes. Historical credentials without a family cannot satisfy durable revocation,
so activation deliberately requires those users to sign in again. No legacy session
is silently backfilled from untrusted/browser state. Expired credentials cannot
revoke a currently active family; wrong-purpose credentials cannot rotate or revoke.

New migration chain: `z3a4b5c6d7e8 -> session_families_001 ->
session_refresh_intents_001`; `auth_session_merge_001` joins that chain with main's
existing `audit7_run_policy_001`. No historical revisions are rewritten.
The entire static graph is checked for one head, missing parents and cycles. New
upgrade/downgrade/upgrade bodies were exercised with real Alembic operations inside
a disposable Docker backend. A full historical database upgrade from an empty DB
and upgrade of a production-like snapshot have NOT been executed by this lane.

Schema downgrade tests prove DDL reversibility only. After any revocation event,
rolling back to an application that ignores family state may restore revoked
credentials: that is NOT a safe rollback. Prefer forward repair while retaining
the revocation-aware verifier/tables. An old-code rollback needs an independently
approved security cutover; no automatic downgrade, key rotation or data deletion
is included.

## Fresh isolated acceptance

Guards are installed before application imports: DNS/TCP/providers/process creation
are denied. PostgreSQL fixtures allow only the dedicated synthetic Unix socket;
the disposable database has `--network none`, no exposed ports and no production
credentials/data. New migration tests run only inside a disposable Docker backend.

- 49 token purpose/expiry cases, through the guarded pytest wrapper (`--noconftest`).
- 22 lifecycle/HTTP-body/WebSocket/cleanup cases in
  `backend/scripts/verify-session-lifecycle-offline.py`.
- 13 actual PostgreSQL cases in `verify-session-postgres-disposable.py`, including
  actual FastAPI intent/refresh/logout handlers, row-lock contention, reuse commit,
  account isolation, before/after commit faults, deterministic password race,
  historical cutover and fail-closed missing schema.
- A separate three-OS-process PostgreSQL claim race: one committed intent and two
  conflicts; no replacement disclosure and the family remains active.
- 27 logout/SSR cases plus six actual BFF/Auth.js callback fixtures via
  `node --experimental-vm-modules --test frontend/tests/session-safe-integration-offline.mjs frontend/tests/session-intent-integration-offline.mjs`.
  BFF fixtures run independent VM worker contexts with synthetic HTTP responses;
  they are not two deployed BFF processes or a full browser test.
- Full static migration graph and new migration DDL round trip in Docker.

Backend dependency versions match the relevant pinned requirements (SQLAlchemy
2.0.49, asyncpg 0.30.0, FastAPI 0.136.1, Pydantic 2.13.4, Starlette 1.0.0,
Alembic 1.18.4, python-jose 3.5.0, HTTPX 0.28.1). Psycopg3 is test-only for the
Docker DDL probe; production drivers are unchanged. No expected failure is counted
as a passing result. Earlier token fixture errors were corrected and rerun.

Remaining release gates: independent protocol review; current hosted CI/build;
actual browser cookie and multi-process HTTP BFF acceptance; full migration-target
qualification; A9-002 composition; startup/signing and legacy cutover action-time
approval. This source/test candidate is not a claim of deployed or fully accepted
A9-003.
