# Public-launch implementation status

19 October 2026. Read stages/01.md, DECISIONS.md, ROUTE_MATRIX.md and RELEASE_GATES.md before subsequent work.

Stage 00 live acceptance remains **BLOCKED**. Both stopped hosts and every preserved artifact are unchanged. Stage 01 development/testing is authorized under the explicit amendment; **no UAT/production deployment or merge** is authorized.

## Stage 01 — implementation baseline

Source implementation complete; localhost preview recovery and verification are recorded below; fresh CI pending. Staging verification and provider approval remain separate, unfulfilled gates. This is not exhaustive security certification.

Original baseline branch: codex/stage01-scope-recovery-20261019. Recovery branch: codex/stage01-preview-recovery-20261019, created from exact locally verified clean HEAD f25811dd792ff759164d1d4aa76e8ae3c53dc1cb in task-5; the original task-2 and concurrent UAT2 task-3 workspaces remain unchanged. Baseline implementation commit: f25811dd792ff759164d1d4aa76e8ae3c53dc1cb. Recovery implementation commit: `git log -1 --format=%H -- scripts/public_launch/preview.py`; subsequent verification-only updates may follow. Base/current fetched main: 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1. No reset of the existing user checkout or edits. The earlier recovery-only commit 940994b201761124fcf86dc3fa14b30627fda48d remains history, superseded by the recovered prompt.

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
| Frontend lint/type/build/browser | Production Webpack build and TypeScript PASS during recovery; no frontend source changes. Interactive browser verification tracked below; lint not rerun |
| PostgreSQL/Redis/container integration | NOT RUN by Stage01: fresh Docker checks found both daemon sockets absent. No containers launched; SQLite preview is not PostgreSQL/Redis parity |

Initial Google suite collection failed because REDIS_URL was omitted from the standalone environment. Adding the explicit unused test-only URL resolved it; this was a test-command setup failure, not a product regression. Existing datetime.utcnow/passlib deprecation warnings remain. No broader test-suite result is claimed.

CI results must be checked against the exact pushed implementation SHA and recorded separately. UAT checks are NOT RUN. The source baseline does not close direct-backend ownership, stream authorization, tenant idempotency, production auth-bypass, broker, privacy, capacity or release gates.

## Remaining blockers and next stage

The original missing-scope blocker is resolved by the parent-supplied Library prompt and Library text confirmation. Supported materialization failed; local bytes and supplied prompt-pack hash remain unverified. Current live population/ingress/deployed verification, target capacity/budget/products/retention/support decisions and both Kite-mode provider approvals remain pending as documented.

Stage 02 private-API ownership is the next planned stage; it is not implemented here. Development of later stages requires applicable user scope/sequence authorization. No later-stage UAT deployment may proceed while Stage 00 is BLOCKED. Return to these ledgers rather than relying on chat memory.

## Localhost preview recovery — 19 October 2026

Resumes the built baseline; no subsequent-stage implementation. Added opt-in scripts/public_launch/preview.py, preview_backend.py, preview_network.cjs and verify_preview.py. Real Next.js production runtime plus Auth.js/BFF and existing FastAPI auth/profile router use an isolated synthetic SQLite database. No production runtime, route, model, schema, Google-login or deployment workflow file changed. Other integration paths return explicit unavailable responses; no workers/schedulers or outbound provider calls are enabled.

Current preview: http://localhost:54987/login?redirectTo=/console/profile/preferences ; frontend PID/group 58613, port 54987; backend PID/group 58612, port 54988. See LOCAL_PREVIEW.md for exact start/stop/status commands, synthetic accounts and walkthrough. Processes are deliberately preserved for review.

Recovery checks actually run: 5 baseline PASS, 19 existing Google-login regressions PASS, source inventory --check PASS (no changed runtime registrations), Python compileall PASS, git diff --check PASS, real frontend Webpack build and TypeScript PASS. Running-stack API/BFF smoke: 42 PASS, recorded in evidence/preview-api-checks-20261019.json. No live provider/email/order/data access, no PostgreSQL/Redis or UAT result is claimed. Initial dependency setup lacked pytest-asyncio; installing the existing constrained test requirements resolved that test-environment failure. Initial Next dev runtime exposed the existing development auth redirect loop; the final running preview uses a successful production build with auth enabled.

Browser: Chrome login screen opened and synthetic credentials accepted; backend recorded successful login and profile GET. The interactive tab closed after a status-checkpoint turn before screen/persistence/logout walkthrough completion. Browser focus is reserved for concurrent UAT2 until coordinated; API/BFF checks are complete independently. Interactive browser acceptance remains PENDING until recorded separately.

Fresh origin/main remains 0c6e61e524c7a87c7b9ea79342f17b14a45e97a1. GitHub workflow triggers rechecked before publication: production deployment is push-to-main/manual; this dedicated branch matches neither diagnostic push branch. PR checks are hosted/disposable. No workflow_run/pull_request_target/repository_dispatch trigger or production-pipeline modification. Fresh PR/CI status will be recorded against the exact pushed SHA. External hosting integration connection state remains unverified; no hosting/deployment operation is invoked.

Publication: draft PR https://github.com/tarunxt/investment-engine/pull/1240, initial pushed implementation SHA f9d3351a3280fcea16fb84a1c83466726be73001; original baseline history is preserved in its three commits. The first push failed because the configured Git helper pointed to missing /opt/homebrew/bin/gh. An official checksum-verified CLI was placed in ignored .runtime/stage01-tooling and selected only for that Git command; the retry succeeded without persistent helper/authentication/access changes or token output. No merge, deployment or workflow dispatch. CI was not yet reported at the first post-PR read.

Browser coordination blocker: the prior test tab closed at the checkpoint turn; the in-app browser is unavailable and Chrome does not support background visibility control here. UAT2 was actively editing its own Google/DNS screens. The user-facing Chrome availability question is pending. Automatic approval review denied a non-sensitive coordination message to the UAT2 thread because destination-specific messaging authorization was unclear; no message was delivered and no retry/workaround was used. Existing preview processes remain running and no UAT2 tab or foreground edit was taken over. This leaves interactive browser walkthrough incomplete, independently of the passing API/BFF checks.
