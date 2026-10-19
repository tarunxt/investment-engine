# Stage 01 — Establish the implementation baseline

## Latest UAT2 integration amendment — 19 October 2026

The user now authorizes sequential Stage01–20 implementation into the separately approved UAT2, one stage at a time. This task prepares Stage01 source only; parent-confirmed UAT2 owner acceptance is required before the UAT2 task deploys any candidate. Preserve existing UAT2 guards, limits, fake adapters and production Google-login fixes. No infrastructure/security/access or paid-limit changes, real integrations/orders, new AWS resources, production merge or deployment. Stage20 prepares cutover only. Old Stage00 acceptance remains BLOCKED; no old resource action is authorized. This latest boundary supersedes older destination/sequencing language below without changing the recovered Stage01 implementation requirements. See SEQUENTIAL_UAT2_PLAN.md and UAT2_INTEGRATION.md.

## Earlier recovery amendment

19 October 2026: implementation and isolated local/CI testing may proceed while Stage 00 live acceptance remains **BLOCKED**. Prepare a draft PR after checking CI triggers. No UAT or production deployment, merge, AWS launch, access/retention/resource changes, disk movement or deletion. Historical UAT deployment instructions in the source below are overridden. Stage 00 PASS remains prerequisite for Stage 01 UAT deployment. Preserve existing user edits, operator data and deployed Google-login fixes. Do not implement subsequent stages.

## Provenance

Recovered by the parent from Library `libfile_b1c6791622e48191a8210ddc3cb36a5f`, version 2, reported SHA256 `23f6ee74411fbd593705fed838a1759bcb595bf54db0d4733bbe851eb78ddb72`. Library text read on this Mac confirms the complete Stage 01 block below. The supported materialization helper failed to download either source, including a bounded network-enabled attempt; readable local file bytes and the reported hash were **not verified**. No URL substitution or alternative download route was used.

Roadmap: Library `libfile_43334f87beb88191b2d14f9ec7fad95d`, version 1, `CredX-public-launch-roadmap.html`, read in full through Library text. Its historical review is not proof of current deployment or security. Parent source conversation: https://chatgpt.com/c/6ad0f625-e46c-83ee-98eb-6bf28ff09350?messageId=a3e56d41-88aa-58bd-830f-721064d82e81 .

## Recovered complete prompt (historical deployment text overridden above)

```text
DEPLOYED GOOGLE LOGIN BASELINE (15 October 2026): Preserve PR #1236 / commit 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1 and prerequisite client fix #1235 / 385f618. Recheck current main/deployed SHA before starting; these are minimum preserved changes, not instructions to reset to an older commit. First sign-in with a new supported verified Google email now creates its own standard user and empty profile; repeat login reuses the account; existing user IDs/roles/profiles remain intact; disabled/ambiguous matches fail closed. Do not restore existing-account-only login or rebuild OAuth. Preserve authoritative-Google-email checks and independent accounts; do not merge distinct Gmail profiles, normalize dots/plus aliases into shared ownership, or copy owner integrations.
Production registration behavior does not grant UAT access. UAT must enforce its explicit owner allowlist server-side before signup/session issuance, including direct auth/password/reset paths, behind the UAT access barrier. Reject non-allowlisted identities without provisioning a profile/session in UAT. New production profiles are not evidence of complete tenant isolation or residency eligibility.

MANDATORY UAT BOUNDARY — supersedes earlier deployment instructions:
Keep current cred-x.in production unchanged. All development runs on a dedicated branch in owner-only UAT on the EXISTING server. Simulated execution only: no production broker credentials, tokens, wallet runtime, real orders or live bot starts. No stage in this pack authorizes merging main, production deployment, production database migrations or financial-flag changes. Actual cutover requires a later separate user instruction after UAT acceptance.
Use separate UAT service identity, directories, ports, secrets, cookies/signing keys, OAuth client, database/role, Redis process and worker queues. Enforce access isolation and measured CPU/memory/I/O/disk limits. Do not use a Redis logical database or key prefix as the only boundary. Deploy completed stages only to UAT after stage 00 isolation verification. No stress tests or heavy builds on the shared host; stop UAT if production-impact thresholds are crossed. Shared hosting still has host/kernel/disk failure risk.
Read docs/public-launch/UAT.md and STATUS.md before changes. Preserve production services, current Google login and existing operator data. Do not change the production deployment pipeline. Real provider validation is a separately scoped later activity, never an exception to simulation-only UAT.

Work in https://github.com/tarunxt/investment-engine on the CredX public-launch project. Live app: https://cred-x.in. Module preferences: /console/profile/preferences.

CONFIRMED PRODUCT SCOPE: India residents only; support BOTH user-owned Kite API apps and an approved CredX-managed Kite app with separate user authorizations; financial orders only after explicit user confirmation. Scheduled analysis is allowed; unattended financial execution is excluded. INDmoney is manual import/analysis unless a supported integration is separately established. Keep public Bullpen live/copy/direct execution unavailable under the documented launch gate; research availability needs its own review. Preserve existing operator data and recovery restrictions. Do not rebuild or revert the Google sign-in work.

EXECUTION RULES: Read applicable AGENTS.md and docs/public-launch/STATUS.md first. Inspect current code and Git state; the October 2026 review is historical evidence, not proof a finding still exists. Work on the dedicated integration branch recorded in STATUS.md, using an isolated worktree if necessary; preserve unrelated work. Fetch upstream and integrate relevant changes without force-pushing. Implement this stage, not just a plan. Make routine choices autonomously, recording assumptions. Use synthetic fixtures and fake provider adapters; never expose secrets, send user emails, place real orders, start live bots, or remove recovery gates for testing.

Commit and push tested changes to the UAT integration branch and update its draft PR. Deploy only to isolated UAT; do not merge main or deploy production. If access is blocked, preserve the patch and report exactly what is missing. Update STATUS.md with this stage's result, commit, test commands/results, migrations, blockers and next stage. Treat code complete, staging verified and provider approved as distinct statuses. Do not mark unrun tests as passed. An external blocker may leave a disabled implementation ready, but never counts as approval.

RETURN: implemented behavior, files/commit/PR, tests actually run, remaining blockers and whether the next stage can proceed. Do not ask to continue routine authorized work within this stage.

STAGE 01 — ESTABLISH THE IMPLEMENTATION BASELINE
Prerequisite: 00 (UAT isolation gate passed). Verify completion in the ledger before dependent edits.
Save this stage specification as docs/public-launch/stages/01.md.

Set up the implementation project without changing production behavior.
1. Read current main, open relevant PRs, repository instructions, deployment docs and the current Library report named CredX-public-launch-roadmap.html. If the report is unavailable, use the confirmed scope above and verify findings from source; record the missing reference.
2. Create/reuse one dedicated integration branch and draft PR. Establish docs/public-launch/STATUS.md, DECISIONS.md, ROUTE_MATRIX.md and RELEASE_GATES.md. Record baseline SHA and concurrent Google-login changes. All subsequent stages must read these files rather than depend on chat memory.
3. Inventory every HTTP/WebSocket route, worker, scheduler and export as public, owner-private, shared-read or administrator-only. Record module, capability, owner source, external side effects and existing guards. Inspect actual ingress/deployed SHA read-only if available; distinguish example configs from deployment facts.
4. Add synthetic user A, user B and admin test fixtures without touching production users. Identify how to run PostgreSQL/Redis, browser and broker-fake tests.
5. Record both Kite-mode approval dependencies, target capacity/budget decisions, supported order products, data retention and staging access. Propose defaults where safe; do not silently change confirmed scope.
DONE: persistent implementation ledger, complete entry-point inventory and reproducible baseline checks. Report existing failures separately. No claim of exhaustive security certification.

BASELINE ADDITION: Record the exact current production/main Google-login versions, including #1235 and #1236. Inventory actual current user populations read-only rather than assuming a single legacy user. Track the verified owner separately from other standard users and do not infer ownership from email fragments. Add login integration regression requirements to the ledger.
```
