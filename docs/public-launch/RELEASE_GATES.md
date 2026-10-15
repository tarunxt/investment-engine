# Stage 00 release gates

**All operational gates are OPEN/BLOCKED. Stage 01 is blocked.** Preparation tests
are not deployment evidence. Store sanitized command output, timestamps, SHA and
reviewer per gate. Do not store tokens, cookies, keys or raw production data.

| Gate | Required evidence | Current result |
|---|---|---|
| Baseline preserved | Current main and runtime artifact SHAs; both login fixes ancestral | Main confirmed; deployed SHA unknown |
| Capacity | Representative market/worker/backup peaks, reserve, chosen aggregate caps | BLOCKED: no host access |
| Host safety | Services/proxy/ports/disk/inodes/DB/Redis/schedules inventory | BLOCKED |
| UID isolation | Distinct users, no prod groups/sudo/Polkit restart rights; unreadable secrets without contents | BLOCKED |
| Network isolation | UAT port allowlist; prod DB/Redis/Bullpen, public broker/AI/email and metadata denied; IPv6/UNIX reviewed | EGRESS CANDIDATE; NOT INSTALLED/VERIFIED |
| Database isolation | Fresh synthetic-only DB; non-superuser; prod CONNECT denied; connection/timeouts bounded | NOT PROVISIONED |
| Redis isolation | Separate process, directory, ACL, maxmemory; prod Redis unreachable | CANDIDATE ONLY |
| JWT separation | UAT-specific signing key actually used; prod/UAT cross-token rejection | BLOCKED: hard-coded key in current helper |
| Secrets workflow | Required skill and runtime resolver available, unique credentials provisioned without disclosure | BLOCKED |
| Verified owner | Google authoritative verified exact chosen email; independent UAT client; no prod/Sheets client edits | INTENT CONFIRMED, LIVE PROOF MISSING |
| Backend allowlist | Non-owner verified Google identity rejected before DB write/resolver/session; disabled/ambiguous cases deny | NOT IMPLEMENTED |
| Alternate auth | Direct password/register/reset/refresh/bypass tests cannot grant UAT access to non-owner | NOT IMPLEMENTED |
| Session behavior | Owner login/relogin, CSRF, expiry, refresh; host-only cookies and distinct frontend secret | NOT TESTED |
| Private barrier | Every page/asset/API/WebSocket blocked for unauthenticated/non-owner users, direct backend inaccessible | NOT PROVISIONED |
| Simulation | Deterministic fake adapter only; real adapter/config/task routes rejected and network denied | NOT IMPLEMENTED |
| Costs/side effects | Fake AI, email sink, test exports, no live keys, schedulers off | NOT IMPLEMENTED |
| Resource enforcement | Effective cgroup CPU/memory/swap/tasks/I/O, all processes accounted for | CANDIDATE ONLY |
| Disk and stop thresholds | Measured production reserve, watchdog, log/artifact bounds; readable stop evidence | WATCHDOG IMPLEMENTED/UNIT TESTED; NOT INSTALLED |
| Safe exposure | DNS authority, dedicated TLS vhost, certificate, tested graceful reload and prod before/after checks | BLOCKED |
| Lifecycle | Stop and redeploy UAT without interrupting production; independent rollback artifact | NOT TESTED |
| Production stability | Before/after health/latency/errors, unchanged running service identities, no financial effects | NOT OBSERVED |
| Branch safety | Trigger review before push, draft PR only, separate future UAT deployment credentials | SOURCE REVIEW COMPLETE |
| Preparation checks | Local capacity-renderer test suite | PASS: 10 tests |

## Next executable sequence

1. Restore scoped server/DNS access and the mandatory secret skill/resolver. Inspect
   host read-only; collect representative headroom and deployed SHA evidence.
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
