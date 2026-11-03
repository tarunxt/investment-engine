# Focused Audit 9–12 first batch

Based on main b67bec4e390f55eb3faf9e66d454cbfa499f15d4. This branch selectively reuses reviewed candidate work; it does not merge the combined 281-file PR #1407.

- A10-006/007: UTC-aware instant identity for offline replay, duplicate-instant rejection, positive integer horizons and atomic report output. Raw timestamps remain in outputs; valid simulation economics, causal fills, default horizons and replay/sensitivity response fields remain unchanged. The broader validation dossier and evidence-only CLI option are excluded.
- A10-005: additive per-claim explanation metadata and escaped UI text from PR #1406. Existing verdicts, policy version, critical-claim gates and saved history remain unchanged. No calibrated learning or financial-policy change.
- A9-R11: formatter-level credential-pattern redaction and startup presence-only connection diagnostics from PR #1405. All configured output formatters use the redactor. This is bounded pattern protection, not a general private-content detector; separately configured handlers/sinks need their own verification. No historical logs are read or purged.
- A12-005: strict finite numeric nonnegative byte/baseline validation, explicit missing/failed measurement state, candidate identity/time metadata and local synthetic provenance producer from PR #1404. Invalid profile containers and expected build times also fail closed. Existing fixed and relative byte budgets are unchanged. Older reports without evidence now fail as Not measured; they are not grandfathered as passes.

## Verification

Focused Python tests run with outbound socket/DNS operations blocked before imports, inherited by synthetic replay CLI children. Tests use invented records and local temporary files only. The focused command uses `pytest --noconftest` to avoid unrelated application initialization and provider/telemetry fixtures. Four test files are also added to the existing complete hosted recommendation-audit gate; the explanation renderer is added to the existing frontend gate. Budget tests already run in the existing deployment-contract gate.

Commands from repository root:

```
python3 -m pytest --noconftest -q backend/tests/test_walk_forward_input_contract.py backend/tests/test_verifier_explanations.py backend/tests/test_privacy_redaction.py backend/tests/test_privacy_logging_consumers.py
node --test scripts/check-javascript-budgets.test.mjs
node --test frontend/tests/verifier-explanation.test.mjs frontend/tests/recommendation-audit-recovery-policy.test.mjs frontend/tests/runtime-performance-regressions.test.mjs frontend/tests/rebalance-side-effect-policy.test.mjs frontend/tests/investment-recommendation-schema.test.mjs frontend/tests/investment-recommendation-fallback.test.mjs
```

Local result: **82 Python tests plus 25 subtests, 67 budget tests and 31 frontend tests passed, zero failures/skips.**

TypeScript no-emit, scoped component ESLint, changed Python compile checks, JavaScript syntax and diff whitespace checks also pass. Local frontend checks reuse dependencies from the identical main lockfile; no production artifact is built from that test-only symlink.

## Boundaries and remaining gates

No credentials, auth/session settings, migrations, production operations, provider/collector/relay activation, trades, paid requests, publication or deployment. Original user worktree remains unchanged; changes are isolated in this task branch. No model-validation, privacy certification or deployed finding closure is claimed. The combined PR's measured Bullpen bundle-budget regression is not repaired by making the checker stricter; a fresh build/measurement and complete CI remain necessary for any later release.

An initial broader local Python collection attempt stopped for missing SQLAlchemy before tests ran; focused test evidence does not stand in for the full backend suite. Hosted CI has not run for these local commits.
