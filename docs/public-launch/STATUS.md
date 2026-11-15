# Public-launch implementation status

19 October 2026. Read stages/01.md, DECISIONS.md, ROUTE_MATRIX.md and RELEASE_GATES.md before subsequent work.

Stage 00 live acceptance remains **BLOCKED**. Both stopped hosts and every preserved artifact are unchanged. Stage 01 development/testing is authorized under the explicit amendment; **no UAT/production deployment or merge** is authorized.

## Stage 01 — implementation baseline

Source implementation complete, local verification recorded below; fresh CI pending. Staging verification and provider approval remain separate, unfulfilled gates. This is not exhaustive security certification.

Branch: codex/stage01-scope-recovery-20261019. Implementation commit: use the commit introducing this ledger (`git log -1 --format=%H -- docs/public-launch/STATUS.md`); subsequent verification-only updates may follow. Base/current fetched main: 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1. No reset of the existing user checkout or edits. The earlier recovery-only commit 940994b201761124fcf86dc3fa14b30627fda48d remains history, superseded by the recovered prompt.

Implemented: complete recovered Stage 01 prompt with provenance and current amendment; persistent decisions/release ledgers; deterministic source inventory with source hashes, full call lists, access class, module/capability, owner-source observations, local guards and possible effects; opt-in userA/userB/admin ORM fixtures, denied network connections and preview-only fake broker; isolated PR-only baseline workflow; reproducible test instructions in BASELINE_CHECKS.md. No runtime files, models, migrations or API behavior changed.

## Concurrent work and deployment evidence

- Google PR #1236 / 0c6e61e5 and prerequisite #1235 / 385f618 are preserved in fetched main. Current auth source matches the minimum preserved base. The preserved Stage 00 ledger historically observed deployed SHA 0c6e61e5; current live ingress/SHA and user population were not inspected. Do not treat historical observation as a fresh live check.
- Relevant open drafts reviewed through current PR metadata, changed-file lists and fetched branch sources: #1237 (owner-only UAT preparation, head 76beca83, targets main); #1238 (isolation evidence/synthetic exports, head 263a1946, targets the UAT branch); #1211 (JWT startup configuration, head 49a2874d, targets main). They remain independent, unmerged and are not silently incorporated into this Stage 01 baseline. Ledger paths will require reconciliation if #1237 later lands. Do not overwrite its historical evidence.
- Full open-PR title/head snapshot is in evidence/open-prs-20261019.json. Historical root ROADMAP.md concerns the trading research pipeline; it is not the public-launch specification.
- Production docs and nginx files were inspected as source examples only. No AWS/service/proxy/database call was made. Actual user count, verified owner internal ID, roster/ownership reconciliation and active ingress remain explicit unknowns, not inferred from email strings.

## Local checks actually run

| Check | Result |
| --- | --- |
| Inventory generation and --check | PASS; counts and source hashes in entrypoints.json; no unresolved registrations found by scanner |
| Synthetic baseline pytest suite | 5 PASS: source coverage/mounts, separate ORM users, identity/profile/role preservation, distinct Google dotted/plus accounts, fake broker cannot submit |
| Existing test_google_signin.py with --noconftest and explicit synthetic environment | 19 PASS; cryptographic fake Google transport and in-memory account tests |
| Python compileall on scripts/public_launch and backend/app | PASS |
| git diff --check | PASS |
| Frontend lint/type/build/browser | NOT RUN: no frontend changes; no isolated browser stack launched |
| PostgreSQL/Redis/container integration | NOT RUN locally: Docker daemon unavailable; existing disposable CI commands documented |

Initial Google suite collection failed because REDIS_URL was omitted from the standalone environment. Adding the explicit unused test-only URL resolved it; this was a test-command setup failure, not a product regression. Existing datetime.utcnow/passlib deprecation warnings remain. No broader test-suite result is claimed.

CI results must be checked against the exact pushed implementation SHA and recorded separately. UAT checks are NOT RUN. The source baseline does not close direct-backend ownership, stream authorization, tenant idempotency, production auth-bypass, broker, privacy, capacity or release gates.

## Remaining blockers and next stage

The original missing-scope blocker is resolved by the parent-supplied Library prompt and Library text confirmation. Supported materialization failed; local bytes and supplied prompt-pack hash remain unverified. Current live population/ingress/deployed verification, target capacity/budget/products/retention/support decisions and both Kite-mode provider approvals remain pending as documented.

Stage 02 private-API ownership is the next planned stage; it is not implemented here. Development of later stages requires applicable user scope/sequence authorization. No later-stage UAT deployment may proceed while Stage 00 is BLOCKED. Return to these ledgers rather than relying on chat memory.

## Publication and fresh CI checkpoint — 20 October 2026

Draft PR: https://github.com/tarunxt/investment-engine/pull/1244 . Published implementation commit: 8a34e186ec04273d02607cca43686b5d7772ec06. Exact tree 6f1086ee6afd388013db87fa155646af7b8a3932 matches locally tested f25811dd792ff759164d1d4aa76e8ae3c53dc1cb; verified after fetching the published branch. Local history is preserved on codex/stage01-local-tested-f25811dd. Publication used the authorized GitHub API after Git push failed before publishing because its configured gh credential helper executable was absent; no credential/access changes were made. Interrupted tree creation was checked and found completed before any follow-up write.

Stage 01 CI run https://github.com/tarunxt/investment-engine/actions/runs/39357546025 passed on 8a34e186 (inventory, syntax, synthetic and Google regressions). Broader PR run https://github.com/tarunxt/investment-engine/actions/runs/39357546149 was still in progress at this checkpoint; backend syntax and deployment-contract jobs had passed. Do not treat pending jobs as passed. This status-only follow-up does not change the tested implementation; any new head CI must be recorded separately. No UAT/production deployment, merge or AWS action occurred. Stage 00 remains BLOCKED.
