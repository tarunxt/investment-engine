# Public launch status

Stage 00: **BLOCKED: preparation and inspection completed in part; UAT is off.**
Stage 01 must not start until actual isolation and lifecycle gates pass.

Updated 15 October 2026. Branch: `codex/credx-public-launch-uat`; draft PR #1237.

## Verified access and baseline

Authenticated Mac Chrome EC2 Instance Connect works for instance
`i-0b8ad0aebce8510cb`, account ending 9677, Mumbai. This access requirement is
fulfilled; no new user login is required. Read-only root inspection is available.
The deployed checkout and frontend deployment manifest were observed at
`0c6e61e524c7a87c7b9ea79342f17b14a45e97a1`; #1235 and #1236 remain preserved.
Production backend/frontend PIDs are 382132/382541; health checks returned
200/307. No production app, worker, database or Redis restart was performed.

The volume remains 100 GiB. Its initial available space was about 5.10 GiB.
A separately approved manifest identifies exactly 14 redundant archive JSONL
copies (10.32 GiB allocated); primaries and both metadata sets must remain.
Cleanup completed at 19:14:08 UTC on 15 October 2026: all 14 approved copies
removed, 11,077,332,992 bytes recovered and 16,553,050,112 bytes available. All
14 primaries and 28 metadata files were preserved; production PIDs, SHA and
health remained unchanged. See [cleanup receipt](evidence/2026-10-15-archive-cleanup.json). No general retention schedule or broader deletion is
authorized. No raw production data or secrets were copied.

## Implemented preparation

- Capacity sampler, evidence-gated renderer, six systemd/Redis/network candidates,
  dark vhost and log rotation examples. Budgets remain unset pending measurement.
- One-shot dry-run resource watchdog; explicit enforcement stops only fixed UAT
  unit names. It is not installed or scheduled.
- Synthetic retention registry/policy and RETENTION.md; unknown artifacts remain
  protected, and policy output never authorizes physical deletion.
- Independent UAT owner-admission component: non-owner claims rejected before
  profile resolver, exact email semantics, inactive/mismatched accounts denied.
- Independent deterministic synthetic broker, fake AI response and email sink,
  with bounded memory and no external I/O. No production factory imports them.
- 33 local tests pass: 10 original checks, 11 retention, 6 owner policy and 6
  synthetic-adapter tests. These are component tests, not deployed UAT evidence.

## Remaining work and who handles it

**Assistant implementation/testing:** restricted UAT entrypoint and route wiring,
Google verification transport, independent signing configuration, session/CSRF
behavior, barrier, private runtime tests, resource enforcement and lifecycle
proof. `app.uat_main` remains absent; never substitute unrestricted `app.main`.
Production JWT helper still uses its existing placeholder; do not change live
signing or sessions as part of this preparation.

**Assistant measurement/discovery:** representative active-worker, market and
backup windows; measured caps/reserve; full sockets/UID/DB/Redis/network inventory;
DNS and Google client permissions. Idle readings are insufficient. Do not restart
stopped Readiness/Queue workers to obtain measurements.

**Tool preparation:** AGENTS.md mandates `aws-secrets-manager` and `asm-exec` for
credential work. The official skill and wrapper are now staged locally from AWS toolkit commit
`9d76dd4494b7ff76105f52f5d59ae2180dc91289`, Git blob checks verified; the skill
was loaded, wrapper compiled and a no-reference/empty-environment smoke check
passed. No secret was resolved. Runtime installation, hook activation and scoped
resolver/IAM access remain unverified. Tool setup is separate from permission to
create access; do not ask for secret values in chat.

**Specific approval once prepared:** creating dedicated UAT keys/client/access
and activating exact isolated network/security rules. Verify the targets and
present a concrete scope before action. No repeated broad server-access request.

Only `tarun.singh6893@gmail.com` is authorized for eventual UAT, subject to actual
authoritative Google verification. `https://uat.cred-x.in` remains proposed.
Production Google/Sheets configuration and workflows are unchanged. Branch
trigger review confirms main-only deployment and separately named diagnostic
branches; no production workflow was dispatched. No merge, migration, financial
operation, paid storage change or UAT exposure occurred.


## 18 October 2026 audit update

Stage00 remains **BLOCKED**. The historical entries above are not a current deployment inventory. See [requirement-by-requirement audit](STAGE00_AUDIT_20261018.md) for later dedicated-host authorization, completed preparation, partial evidence and missing live gates. Existing-server co-location was not admitted; a dedicated test host does not satisfy that original requirement literally. Current59regression passes do not close private/fault/TLS/realGoogle acceptance. Stage01 remains unauthorized.
