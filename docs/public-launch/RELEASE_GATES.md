# Stage 00 release gates

**All operational gates are OPEN/BLOCKED. Stage 01 is blocked.** Preparation tests
are not deployment evidence. Store sanitized command output, timestamps, SHA and
reviewer per gate. Do not store tokens, cookies, keys or raw production data.

| Gate | Required evidence | Current result |
|---|---|---|
| Baseline preserved | Current main and runtime artifact SHAs; both login fixes ancestral | Main, deployed checkout and frontend manifest observed at 0c6e61e; runtime health checked; preserve login fixes |
| Capacity | Representative market/worker/backup peaks, reserve, chosen aggregate caps | ACCESS FULFILLED; representative market/worker/backup windows still needed |
| Host safety | Services/proxy/ports/disk/inodes/DB/Redis/schedules inventory | BLOCKED |
| UID isolation | Distinct users, no prod groups/sudo/Polkit restart rights; unreadable secrets without contents | BLOCKED |
| Network isolation | UAT port allowlist; prod DB/Redis/Bullpen, public broker/AI/email and metadata denied; IPv6/UNIX reviewed | EGRESS CANDIDATE; NOT INSTALLED/VERIFIED |
| Database isolation | Fresh synthetic-only DB; non-superuser; prod CONNECT denied; connection/timeouts bounded | NOT PROVISIONED |
| Redis isolation | Separate process, directory, ACL, maxmemory; prod Redis unreachable | CANDIDATE ONLY |
| JWT separation | UAT-specific signing key actually used; prod/UAT cross-token rejection | BLOCKED: hard-coded key in current helper |
| Secrets workflow | Required skill and runtime resolver available, unique credentials provisioned without disclosure | OFFICIAL SKILL/WRAPPER STAGED LOCALLY; runtime resolver/IAM and provisioning unverified |
| Verified owner | Google authoritative verified exact chosen email; independent UAT client; no prod/Sheets client edits | INTENT CONFIRMED, LIVE PROOF MISSING |
| Backend allowlist | Non-owner verified Google identity rejected before DB write/resolver/session; disabled/ambiguous cases deny | NOT WIRED INTO RUNTIME; see component preparation below |
| Alternate auth | Direct password/register/reset/refresh/bypass tests cannot grant UAT access to non-owner | NOT WIRED INTO RUNTIME; see component preparation below |
| Session behavior | Owner login/relogin, CSRF, expiry, refresh; host-only cookies and distinct frontend secret | NOT TESTED |
| Private barrier | Every page/asset/API/WebSocket blocked for unauthenticated/non-owner users, direct backend inaccessible | NOT PROVISIONED |
| Simulation | Deterministic fake adapter only; real adapter/config/task routes rejected and network denied | NOT WIRED INTO RUNTIME; see component preparation below |
| Costs/side effects | Fake AI, email sink, test exports, no live keys, schedulers off | NOT WIRED INTO RUNTIME; see component preparation below |
| Resource enforcement | Effective cgroup CPU/memory/swap/tasks/I/O, all processes accounted for | CANDIDATE ONLY |
| Disk and stop thresholds | Measured production reserve, watchdog, log/artifact bounds; readable stop evidence | WATCHDOG IMPLEMENTED/UNIT TESTED; NOT INSTALLED |
| Safe exposure | DNS authority, dedicated TLS vhost, certificate, tested graceful reload and prod before/after checks | BLOCKED |
| Lifecycle | Stop and redeploy UAT without interrupting production; independent rollback artifact | NOT TESTED |
| Production stability | Before/after health/latency/errors, unchanged running service identities, no financial effects | Backend 200/frontend 307 and unchanged PIDs observed during inspection; UAT lifecycle still untested |
| Branch safety | Trigger review before push, draft PR only, separate future UAT deployment credentials | SOURCE REVIEW COMPLETE |
| Preparation checks | Local capacity-renderer test suite | PASS: 33 local synthetic/preparation tests |
| Retention classification | Writer-time registry, dependency/queue census, holds, exact recovery evidence, reviewed TTLs and quotas | SYNTHETIC PROTOTYPE ONLY; NO LIVE INTEGRATION |
| Physical reclamation | Exact verified manifest, fresh readers/leases/holds checks, user approval, loss-of-redundancy disclosure | PASS for exact approved 14-copy cleanup at 19:14:08 UTC: 10.32 GiB recovered, primaries/metadata preserved; no general retention schedule |

## Next executable sequence

1. Reuse the authenticated Chrome EC2 session; collect representative headroom.
   Verify DNS authority separately. Prepare the mandatory secret skill/resolver
   from verified official provenance before any credential operations.
2. Review this preparation against measured host reality. Complete database and
   network candidates; choose resource ceilings and stop thresholds. If unsafe,
   finish the review and leave UAT off.
3. Implement `app.uat_main` with an environment-specific fail-closed owner policy,
   independent signing/client config and fake adapters. Preserve the production
   Google resolver/registration semantics. Test direct backend access and every
   alternate signup/session path, plus production regression tests. Do not mount
   unrestricted production routers to bypass missing modules.
4. Provision isolated UAT identities/services/data and runtime secrets through the
   required mechanism. Deploy immutable UAT artifacts privately; no prod changes.
5. Complete denied-access tests, resource enforcement and stop/redeploy evidence.
   Configure the independent barrier/TLS/DNS only after private checks pass.
6. Record actual URL/identity/ports/limits/commands/test results, update draft PR.
   Mark Stage 00 PASS only when every gate passes. No production merge or launch.


## Component preparation and responsibility

- Assistant implementation: isolated `app/uat/owner_policy.py` now rejects
  non-owner claims before invoking the account resolver and rechecks active owner
  identity. It consumes already verified claims; it is not a signature verifier
  or an enabled login route. Six synthetic tests pass.
- Assistant implementation: `app/uat/simulation.py` supplies bounded deterministic
  fake orders, zero-cost AI fixtures and an email sink. Six tests cover retries,
  conflicting requests, real configuration rejection, memory bounds and execution
  with socket creation forbidden. Production factories do not import it.
- Still assistant work: restricted entrypoint, actual Google verification transport,
  owner/session route integration, independent JWT wiring, cookies/CSRF/refresh,
  private barrier, resource/health watchdog integration and denied-access tests.
- Measurement work: representative production worker/market/backup peaks, reserve
  and growth. No stopped production worker is restarted for this purpose.
- Access discovery: DNS/certificate and independent Google client permissions must
  be inspected; lack of completed discovery is not a demand for credentials.
- Action-time approval: exact UAT credential creation and specific network/access
  provisioning, after targets are verified and the full proposal is reviewable.
  Existing EC2 access and ordinary branch preparation need no repeated approval.

None of these component tests proves live isolation. Stage 00 remains blocked;
Stage 01 must not start. No UAT service has been activated.


## 18 October 2026 audit update

Stage00 remains **BLOCKED**. The historical entries above are not a current deployment inventory. See [requirement-by-requirement audit](STAGE00_AUDIT_20261018.md) for later dedicated-host authorization, completed preparation, partial evidence and missing live gates. Existing-server co-location was not admitted; a dedicated test host does not satisfy that original requirement literally. Current59regression passes do not close private/fault/TLS/realGoogle acceptance. Stage01 remains unauthorized.

Synthetic export follow-up: fixed memory-only destination now wired through the restricted owner HTTP runtime factory;98source tests pass. Disposable engine CI adds export assertions. Retained AWS candidate is unchanged; deployment/live acceptance remains unverified.
