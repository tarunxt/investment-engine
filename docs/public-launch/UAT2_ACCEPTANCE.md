# UAT2 acceptance

**UAT2 PREVIEW ONLY — owner login verified; remaining acceptance blocked by execution transport.**
Actual URL https://uat2.cred-x.in. No UAT2 READY claim yet.

## Owner acceptance checkpoint — 19 October 2026

Owner reported genuine Google login; parent independently inspected the dashboard
screenshot. This task then inspected the existing authenticated session directly:

- Dashboard shows tarun.singh6893@gmail.com, UAT2 / SIMULATION and build4a8e81ab16c0.
- Preferences loads its real theme/timezone/notification controls. No values changed.
- US portfolio loads the two labelled synthetic holdings UATA/UATB, current1050USD,
  invested1000USD and wallet100USD; its loading state was observed first.
- Authenticated /console/uat2 status reports simulationtrue and exact application
  commit4a8e81ab16c0c141d1f84656afdf548b659de496; unavailable-state control returns
  UAT2_UNAVAILABLE. These are real authenticated BFF/backend responses.
- Actual cookie metadata was inspected origin-scoped without returning values:
  __Host-credx-uat2.session-token, .csrf-token and .callback-url have exact
  domainuat2.cred-x.in, path/, Secure, HttpOnly and SameSite=Lax. Cookie values
  were not logged, copied or disclosed. The Google g_state helper is not an
  application authentication cookie.
- The operator reset failed before mutation: child cwd inherited the SSH user's
  private home, causing PermissionError on .env. A read-only count confirmed one
  synthetic snapshot remained. Code now runs from application cwd and loads the
  serving app model registry;15 controller tests pass. Prepared fix is
  79acc235da9f3ba7babb0b640c97442761b1da3f; it is NOT installed or live-verified yet.

The transfer/install attempt for that fix did not start: exec process creation
failed with exec-server transport disconnected; a subsequent pwd also failed
recovery. Browser transport then closed. No uncertain operation was repeated.
Application remains4a8e81a/controllerc72d41a; the owner session was not signed out.

Read revised Stage00 from Library libfile_8c0887a3e4f88191b24fba523ef6959e,
CredX-UAT2-execution-prompts(1).html. Owner-supplied SHA256:
c25d5b69b160b0a9228667d6374b17f5e6b135ac8e941f2eee7404a81e8f1449.
Only outstanding acceptance is in this task; Stage01 owns stage-instruction sync.
No HTML rewrite, old-UAT recovery, new resources or deadline extension.

Remaining: restore the Mac execution/browser transport; resolve any still-pending
normal tool approval without assuming it approved; install and verify the reset
fix; observe empty fixture then restore populated; complete remaining direct
simulation/WebSocket/logout/expiry checks without disrupting owner state. Preserve
all previously verified deployment, PostgreSQL/Redis, recovery and isolation results.
Stage01 must not deploy until READY plus exact candidate CI/artifact verification.

## Previously verified live

- Fresh approved account 457945009677/Mumbai host i-0d1d4a0b841c98691;
  encrypted separate storage, dedicated users, DB, Redis, artifacts and logs.
- Console-matched SSH fingerprint and native SCP; complete source ZIP/manifest
  checks passed: 127 files, 125 wheels, 677 source and 3116 frontend archive members.
- Offline dependency installation passed on actual Ubuntu 24.04/Python 3.12 host.
- Application4a8e81ab16c0c141d1f84656afdf548b659de496; deployment controller
  c72d41ad2bce465e5f3f5cdbae43693935c38eb3; 15 native tests passed locally and on host.
- Independent secret generated; exact-ARN IAM policy read back. Runtime resolution
  through reviewed asm-exec/AWS MCP and temporary role succeeded. Root mode 0600 config.
- Separate Google client saved; exact UAT2 origin. Production/old clients unchanged.
- GoDaddy uat2 A 16.4.84.155 TTL 600 saved, both authoritative nameservers verified.
- Valid Let's Encrypt certificate, hostname/chain verified; TLS1.3 observed.
- Anonymous /, /login, /console/uat2, /api/auth/session, /backend-api/health and
  /_next/static/missing.js each401 at the barrier.
- Actual frontend /login and backend /health each200 locally; health reports
  environmentuat2 and simulationtrue. Internal ports bind loopback only.
- Synthetic nonowner signed tokens/direct /auth/me, /auth/profile, /uat2/status,
  /zerodha/orders and /auth/refresh requests 403. Registration/password login,
  forgot/reset paths 403. Users after checks: 0. No synthetic test minted an owner
  session or provisioned an owner/profile.
- Fake broker returns SIM IDs; actual dedicated Celery worker completed fake AI
  with cost 0; email sink captured locally; beat schedule empty. Startup confinement
  checked explicit external-socket denial and restricted IPv6 in service cgroups.
- Repeat application deployment passed without rebuilding host. Verified UAT2-only
  backup/schema+data/application rollback passed before owner login. An earlier
  repeat-deploy service-control failure was followed by controlled app closure,
  internal-service verification and successful traced retry; no failure hidden.
- Active Chrony selects Amazon 169.254.169.123, normal leap status and microsecond
  offset. No old helper clock issue inherited. Controller now checks active service.
- Production public HTTP 200 before/after setup and while fresh UAT2 was stopped.
  This is a bounded public-health check, not a production stress test.

## Still pending

- Owner login and dashboard/preferences/populated-US walkthrough passed; only
  remaining screens/states and targeted controls above are pending.
- Genuine nonowner Google testing requires a consenting account; no result fabricated.
  Synthetic backend owner-restriction checks have passed.
- Actual host-only secure cookie metadata and populated-US UI passed. Empty/reset,
  remaining direct simulation, WebSocket and logout/expiry acceptance are pending.
- EC2 stop/start passed: same Elastic IP, persistent UAT2 data/evidence and all
  eight services active after manual controller start; production stayed HTTP 200
  while UAT2 was stopped. Post-restart production HTTP 200 and UAT2 anonymous 401
  were verified with TLS validation at 2026-10-19T16:13:52Z.
- Controllerc72d41a CI passed: PR39282371925 and migration39282372108. New reset-fix CI must be checked separately.
  Baseline application 4a8e81a had PR checks 39273576447 and migration 39273575901
  SUCCESS. New-head CI is not implied by that earlier result.
- Stage01 remains separate, not integrated. Require parent-confirmed tested source.

## Evidence and limits

Operational readbacks are in task-3 uat2-launch-receipt.json and
uat2-security-receipt.json; no secret values. Original complete bundle remains
retained locally. New controller fixes address real-host Chrony, nginx sandbox
paths and runuser lookup; no production pipeline or service was rewritten.

The initial CLI secret/IAM provisioning review was rejected before execution.
One retry passed after checking AGENTS lines 540–542 explicitly permits CLI fallback
when AWS MCP tooling is unavailable. Secret reads remained exclusively through
unchanged asm-exec/AWS MCP. No denied action was rerouted or hidden.

No production/old-UAT infrastructure changes, old-disk deletion or retention
extension. Stop target 21 Oct 2026 21:04IST; retention target 26 Oct 2026 21:04IST.
US$10 allowance is not a guaranteed cap. See UAT2.md for costs and operations.
