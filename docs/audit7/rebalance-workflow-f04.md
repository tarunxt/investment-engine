# REBALANCE-WORKFLOW-F04: policy decision required

Revalidated against fetched origin/main da317a1097cef97089e3a745b9e20b4952af6a48 on 2026-11-01. The defect remains in source. This task adds characterization tests only; it does not fix production behavior or select a financial rule.

## Reproduction and existing contracts

`frontend/tests/rebalance-score-scale-contract.test.mjs` imports the actual TypeScript helpers. Six rationale inputs of 3 have multipliers 3,3,2,1,3,1 (numerator 39, denominator 13). Bullish confidence 8.8 is valid on [0,10], contributes 8.8 with denominator weight 2. Premarket weight is zero. Last-five trend 3 contributes 15 with weight 5; Add more 2.5 contributes 10 with weight 4. Total 72.8/24 is exactly 3.033333333333333. All component bounds pass.

`frontend/lib/scoreMatrixMath.ts` calculates the raw weighted quotient without clamping. `frontend/app/console/_components/FinalActionablesConsole.tsx` defines default multipliers and confidence validation, builds calculatedScore from the quotient, bounds it for action rules via clampScoreToGuardrail, and binds raw calculatedScore to formulaScore. The score matrix and recommendation audit receive calculatedScore and source rows. `frontend/app/console/dashboard/_components/RebalanceWorkflowSections.tsx` passes calculatedScore/formulaScore into basket calculations. `frontend/lib/basketDisplayCalculations.ts` excludes scores outside [-3,3] from saved and current historical means. An excluded sole observation produces null mean and therefore no display allocation. Show all can reveal the raw current score but does not repair historical inclusion.

Formula preferences persist under `investment-engine:final-actionables:score-matrix-formula-config:v1`. Users can configure finite rationale multipliers, action scores, technical bullish/bearish multipliers, symbol thresholds, and a finite denominator override. The score editor adjusts the persisted denominator for missing weights. Saved snapshots use `score-matrix-v1`; existing snapshots and user settings must remain unchanged. A default confidence-only correction cannot guarantee bounded scores for arbitrary user overrides.

## Smallest required policy decision

Choose the canonical meaning of the score consumed by history and allocation, including treatment of legacy raw out-of-range snapshots. These mutually exclusive directions have different financial results:

1. Preserve the raw quotient and introduce an explicit bounded score for action/history/allocation in a new versioned contract. This fixture has raw 3.033333333333333 and bounded 3. Store both meanings for new records. Decide whether legacy raw records remain excluded with an explicit reason or receive a separately labelled derived bounded view; never overwrite originals.
2. Normalize component scales before applying weights, with a separately approved rule for configurable denominators and multipliers. For example, mapping confidence [0,10] to [0,3] would make 8.8 become 2.64 and this fixture 66.64/24 = 2.776666666666667. This is an illustration, not a recommended or implemented financial rule. Specify signed confidence semantics, user overrides and snapshot versioning before implementation.
3. Declare the quotient intentionally unbounded and permit finite out-of-range values in history/allocation. This fixture remains 3.033333333333333. Decide corresponding visibility and action semantics explicitly; removing the reader guard changes financial inclusion and is not an independent technical fix.

Changing denominator 24 to an arbitrary value solely to force this example below 3 is not justified. No weights, bounds, settings, saved history, or permissions were changed by this task.

## Acceptance limits

The supplied Library ID [source-attachment-id] returned NOT_FOUND before materialization for /workspace/audit7-source and the single bounded retry /workspace/audit7-source-retry. No PDF bytes, hash verification or pixel inspection was possible. Evidence here uses the exact finding/preservation text supplied in the delegation and current repository source, not an independently verified attachment.

No production account data was inspected. Existence and inclusion of actual live out-of-range records remains unverified. No actual component browser fixture or live summary/detail/popup acceptance is claimed: runtime behavior is unchanged and policy remains unresolved. Tests cover helper boundaries, missing/zero/malformed, partial/failed/interrupted sources, stale source time, repeat reads, and nonmutation. They intentionally characterize the defect; passing them is not acceptance of the defect as correct behavior. After policy approval, add source-matched component browser fixtures for all affected bindings and versioned snapshot compatibility tests before integration/deployment.

## Local validation

Node v24.19.0. Existing relevant baseline tests: 58 passed, 0 failed (`zerodha-basket-threshold-and-score-math.test.mjs`, `basket-display-calculations.test.mjs`). Combined with the new characterization file: 61 passed, 0 failed. `git diff --check` passed. No application code changed. Dependency installation initially failed because the default npm cache path /home/agent/.npm/_cacache was unavailable; repeating with /tmp/audit7-npm-cache succeeded. This was an environment setup issue, not a baseline test failure. Full application suite/build/browser acceptance was not run.
