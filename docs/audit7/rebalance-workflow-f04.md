# REBALANCE-WORKFLOW-F04: approved raw/effective allocation policy

Revalidated against fetched origin/main da317a1097cef97089e3a745b9e20b4952af6a48 on 2026-11-01. The defect was present in source. Following the user’s explicit approval at 11:36:07 UTC, this branch implements the raw/effective split for new frontend allocation calculations. Local checks do not establish production acceptance.

## Reproduction and existing contracts

`frontend/tests/rebalance-score-scale-contract.test.mjs` imports the actual TypeScript helpers. Six rationale inputs of 3 have multipliers 3,3,2,1,3,1 (numerator 39, denominator 13). Bullish confidence 8.8 is valid on [0,10], contributes 8.8 with denominator weight 2. Premarket weight is zero. Last-five trend 3 contributes 15 with weight 5; Add more 2.5 contributes 10 with weight 4. Total 72.8/24 is exactly 3.033333333333333. All component bounds pass.

`frontend/lib/scoreMatrixMath.ts` calculates the raw weighted quotient without clamping. `frontend/app/console/_components/FinalActionablesConsole.tsx` defines default multipliers and confidence validation, builds calculatedScore from the quotient, bounds it for action rules via clampScoreToGuardrail, and binds raw calculatedScore to formulaScore. The score matrix and recommendation audit receive calculatedScore and source rows. `frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx` passes calculatedScore/formulaScore into basket calculations. `frontend/lib/basketDisplayCalculations.ts` excludes scores outside [-3,3] from saved and current historical means. An excluded sole observation produces null mean and therefore no display allocation. Show all can reveal the raw current score but does not repair historical inclusion.

Formula preferences persist under `investment-engine:final-actionables:score-matrix-formula-config:v1`. Users can configure finite rationale multipliers, action scores, technical bullish/bearish multipliers, symbol thresholds, and a finite denominator override. The score editor adjusts the persisted denominator for missing weights. Saved snapshots use `score-matrix-v1`; existing snapshots and user settings must remain unchanged. A default confidence-only correction cannot guarantee bounded scores for arbitrary user overrides.

## Implemented frontend contract

Allocation policy ID: `score-matrix-raw-effective-v2` (`ALLOCATION_SCORE_POLICY`). This is an additive allocation interpretation, not a rewrite of the configured formula or saved `score-matrix-v1` records. No database/API schema, snapshot writer, formula weights, action rules, denominator or settings changes are included.

`allocationScoreContract(rawScore)` returns:

- `scorePolicy`: `score-matrix-raw-effective-v2`.
- `rawScore`: the finite raw quotient, otherwise null.
- `effectiveScore`: `min(3, max(-3, rawScore))`, otherwise null.

`CurrentScoreCalculation.score` remains the raw score supplied by the existing calculation. A current observation opts in only when all three additive fields match the canonical contract. Invalid or unknown policy fields fail current eligibility. The hook attaches the policy to a new current calculation; source identity, same-market, positive run IDs, terminal completed/partial statuses, exact venue and server as-of/window guards all remain required. A valid current row in the mean uses `score = effectiveScore`, retaining `rawScore`, `effectiveScore`, and `scorePolicy` explicitly. Overlapping source runs still count once.

Exact example: raw 72.8/24 = 3.033333333333333, effective 3. Negative raw −72.8/24 retains its raw value and uses effective −3. A custom denominator of 1 still computes raw 72.8 and effective 3; missing/nonfinite values stay unavailable and known zero stays zero. Neither weights nor the raw formula are normalized.

Original saved observations, including immutable backend captures, always retain the existing [-3,3] reader guard. Even adding new policy-shaped fields to an old row cannot opt it into current calculation semantics. No original out-of-range record is re-admitted. `historicalMean.excludedRows` provides the retained original row plus an explicit out-of-range/unchanged-eligibility reason. The history detail displays that reason. New current calculations remain labelled as observations made at server response as-of, not original saved decisions.

The basket row and popup summary show separately labelled raw/effective scores only after the current source has passed eligibility; pending, failed and stale scope results are not shown. History detail distinguishes raw/original score from the score used in the mean. The current matrix detail shows the same explanatory component; frozen read-only matrix detail does not acquire an effective score label. Raw overflow warnings no longer call valid formula inputs inconsistent.

## F05 integration dependency

The independent backend validator worker owns `backend/app/domains/recommendation_audit/deterministic.py` and any new capture/validation policy. This frontend task makes no backend changes. Coordinate the exact policy identifier above and compare raw arithmetic independently from the bounded effective interpretation; never overwrite old captured `score`, `formula_action`, findings or versions. Existing backend `score_outside_guardrail` error behavior remains outside this commit until F05 integration. No new saved-history formula version is emitted by this frontend allocation change.

## Acceptance limits

The initially supplied attachment identifier mistakenly included the version suffix and returned NOT_FOUND on two bounded attempts. The coordinator corrected the identifier and supplied the complete canonical search result. Those earlier 404s do not establish that the real file is inaccessible. The current skill’s supported search-result download helper, with that complete unchanged result and an executor-local destination, failed before transfer with `library download request failed: hosted apps tools/list request failed: network`. One bounded retry with network access explicitly enabled returned the same error. No guessed URL, alternate transfer or restriction bypass was attempted. No readable PDF bytes, hash verification or pixel inspection was possible. Evidence here uses the exact finding/preservation text supplied in the delegation and current repository source, not an independently verified attachment. Attachment identifiers and local transfer paths are intentionally omitted from repository artifacts.

No production account data was inspected. Existence and inclusion of actual live out-of-range records remains unverified. Actual local component browser fixtures verify row, summary and popup detail bindings; live production acceptance remains unverified. Tests cover helper boundaries, missing/zero/malformed, partial/failed/interrupted sources, stale source time, repeat reads, and nonmutation. The original characterization assertions preserve the raw-formula and legacy-exclusion counterexample; additional tests verify the approved new current-calculation behavior. Frontend tests verify raw arithmetic, legacy eligibility and snapshot nonmutation. Backend validator/capture compatibility and combined integration acceptance remain with F05 and the sole integrator.

## Local validation

Node v24.19.0. Existing relevant baseline tests: 58 passed, 0 failed (`zerodha-basket-threshold-and-score-math.test.mjs`, `basket-display-calculations.test.mjs`). Before implementation, combined with the characterization file: 61 passed, 0 failed. After implementation, the broader relevant suite (score math, basket display, raw/effective contract, final actionables calculation/rendering and history persistence) passed 110 tests with 0 failures. `git diff --check` passed. Dependency installation initially failed because the default npm cache path /home/agent/.npm/_cacache was unavailable; repeating with /tmp/audit7-npm-cache succeeded. This was an environment setup issue, not a baseline test failure. The full application suite and production build were not run. `npx tsc --noEmit` passed. `node scripts/rebalance-score-policy-offline-playwright.mjs` passed against actual production components in local Chromium, verifying positive/negative saturation, custom denominator, zero/missing, partial/failed/stale/error, interrupted reads, repeated popup flows, row/summary/detail labels and original legacy exclusion. The existing broader basket browser fixture also passed all 13 cases. All external browser requests were blocked and none occurred. No production live acceptance is claimed.
