# Stage18 acceptance matrix and evidence limits

Base source: ae15428776d54e0abbc379c8fe63be4e17a5797d. Cloud work date: 23 October 2026. Later unpublished changes are not covered by base CI. Exact candidate file hashes and patch digest accompany the review packet; no source change alone certifies execution.

| Requirement | Actual evidence | Disposition / remaining work |
|---|---|---|
| Migration upgrade/replay/downgrade, rollback and restore | Native ae154 rehearsal XML contains six PostgreSQL migration cases, pg_dump/pg_restore, reflected row/schema equality, new user sequence allocation | Passed selected disposable fixture. Not UAT2 volumes/backup certification; populated cross-family per-owner history/order/orphan coverage remains incomplete. |
| Existing users, concurrent signup, Google regression | Four synthetic user types retained; 19 Google sign-in, two clock, four Stage09 PostgreSQL and three Stage17 composition cases in native XML | Selected synthetic/DB checks passed; real Google OAuth not contacted. |
| Owner, module and lifecycle boundaries | 38 Stage06 and 21 Stage07 cases in native XML; broader cloud Stage09–16 cohort 652 passed | Synthetic implementation evidence, not production provider activation. |
| Modes, connections and changed authority | Cloud test_stage09_connections and test_stage10_authorization | Included in 652; provider and live credential certification false. |
| Imports and numeric evidence | Cloud test_stage11_import_integrity and test_stage11_review_numeric | Included in 652; synthetic only. |
| Durable workflows and disable/retry bindings | Cloud test_stage12_durable_analysis and test_stage12_review_bindings | Included in 652; actual Redis worker crash/replacement is a separate real-service cohort, not implied by imported fixtures. |
| Budgets, output provenance and forged authority | Cloud test_stage13_boundaries, governed_jobs, projection | Included in 652; fake providers, no paid calls. |
| Forged approvals, broker uncertainty, execution and views | Cloud Stage14 HTTP/legacy/order_intents, Stage15 execution, Stage16 order_views | Included in 652; no real orders/trades or actual broker certification. |
| Full HTTP/BFF/WS/tasks/export matrix | Relevant source/CI subsets plus base bundle HTTP smoke | Not a complete cross-product result. Browser and transport-wide coverage still needs explicit evidence. |
| Browser layout/error/account switch | Existing real UI harness extended with fail-closed receipt, exact checks, owner-correct fixtures, blocked external requests/SW/WS, sanitized environment | NOT RUN: Chromium process socket permission failure before pages. 16 helper tests only. Blocking WS deliberately means these browser checks do not certify WS. |
| Bounded load | Native ae154 ASGI sample: 24 requests, configured cap3, zero errors, duration1.212s, p95 0.259s | Internal ASGI+PG, not browser/proxy/network capacity; observed concurrency and threshold not established by that old sample. New 12-navigation/cap3/10s-p95 browser harness prepared, not executed. Wider capacity target unresolved. |
| Exact artifact/offline evidence | Fresh cloud ae154 loopback standalone archive built, extracted, structurally validated, fingerprint/auth/proxy/assets/budgets checked with native HTTP verifier | Base-only synthetic bundle, not CI deployment package, not UAT2 artifact or full backend offline installation. Actual CI deployment bundle/receipt audit remains separate. |
| Production hotfix applicability | Main a9b1e07b (merged be3b3dc) four-file rebalance source/overlap correction carried narrowly into successor; frontend15/backend22 tests pass | Candidate-only, not remote. Preserve Stage18 worker guards. Final exact successor CI still required. |
| Evidence omission protection | Gate now requires all14 selected modules/exact148 named identities, not just23 required cases; rejects substituted/extra cases, skips/errors and contradictory suite summaries | Nine methods pass against independent retained identities. This selected inventory still is not the full public-release matrix. |
| UAT2 / owner / external | No host action in this work; last supplied Stage15 runtime evidence historical | Stages17/18 not deployed; owner acceptance and nine live release gates remain open. |

## Execution qualifications

The 652-case cloud run used actual project dependencies and its native pytest selection. Its individual fixtures use synthetic data, SQLite, detached providers and mocked boundaries as designed; it does not replace PostgreSQL/Redis cases. An initial collection attempt with a global SQLite engine URL failed before tests because application pool options require a PostgreSQL URL; the corrected global URL points to unused loopback port1, while each test retains its own isolated fixture. No provider credentials or external service access were used.

The public production hotfix is preserved as narrow hunks, not a merge/reset from main. The backend test uses the Stage18 existing synthetic fixture rather than the older main-only scoped fixture. The application sources changed by the hotfix are separate from the browser/gate harness changes.

The browser receipt is consistency/provenance evidence, not independent attestation. It starts with an incomplete false receipt, requires every named check, records exact harness/build content hashes and tracked diff digest, and retains false full-release/provider/UAT2/capacity claims. Actual execution remains blocked. No browser success receipt was produced.

Retain all older evidence with its original SHA. Do not relabel a base bundle, 148-case CI run or historical UAT2 result as verification of the unpublished successor. No public release, approval, provider binding, deployment or spending authority follows from this document.

## Prepared browser execution contract

A supported isolated runner must install the locked frontend dependencies, stamp `frontend/lib/generatedBuildInfo.ts` with its exact candidate HEAD, and build the actual frontend before executing `node frontend/scripts/auth-rendering-playwright.mjs`. Keep public URLs on loopback and all live providers disabled. `STAGE18_CHROMIUM_PATH` may select an already supported installed Chromium; it is not permission to bypass a denied launch or install unrecognized binaries. `STAGE18_BROWSER_RECEIPT` selects the run-owned output file. The initial output is incomplete/false and can only become a success receipt after every check and bounded synthetic load completes. Restore the generated source stamp after disposable packaging if it is not part of the intended patch.

The runner verifies the served runtime fingerprint against HEAD, records build-output content digest (excluding transient cache/trace), harness/fixture/build-manifest digests and tracked binary-diff digest. These establish exactly what was inspected, not independent build provenance or production readiness. A clean reviewed candidate with a matching fresh build remains the preferred execution input. No current browser receipt is a pass.

## Successor CI wiring (prepared, not executed here)

The existing PR Checks `frontend-build-benchmark` webpack job already invokes the real Playwright harness. Its prepared changes now check out the exact PR head with persisted credentials disabled, stamp/package/verify that same `SOURCE_SHA`, run the receipt helper tests, and retain the browser result on success or failure. Existing read-only contents permission and deployment separation remain unchanged. No new workflow trigger or deployment job was added. This should execute after separately authorized publication, but is not a claim that CI or Chromium has run on this successor.

The existing Stage18 rehearsal workflow already watches `scripts/public_launch/stage18*` and `backend/tests/test_stage18*`, so it includes the exact-case inventory gate and its native14-module/148-case cohort. That workflow remains unchanged. PostgreSQL/Redis, browser runtime, and full acceptance must be evaluated against the resulting exact published successor and retained artifacts, not this local preparation.
