# Audit6 integration

Baseline: `968ac9c16ca0f88df4c68732c13792787cc66e60`.

Private worker source/test patches were replayed after exact byte-count and SHA-256 verification. These integration commits are not imports of the original worker commits. The report, account data and report screenshots are excluded. Browser fixtures use synthetic data and block external and operational calls.

| Finding | Integrated outcome | Retained limitation |
|---|---|---|
| A6-01 | Dashboard regression coverage only | Already resolved; no production change |
| A6-02 | Events/Threats and history loading/failure provenance | Successful source reads remain necessary |
| A6-03 | Unknown/incomplete/zero estimates and wrapping | No verified-free cost provenance exists |
| A6-04 | Shared selected Swing input markers and counts | Selection and financial semantics preserved |
| A6-05 | Exact venue identity and snapshot-absence disclosure | Historical holding reconciliation unproven |
| A6-06 | Both Bullpen workspace regression coverage only | Already resolved; no production change |
| A6-07 | Bullpen008 source, saved wallet and omitted monitoring states | Source/service availability not restored |
| A6-08 | Cost-history unavailable/cache/stale-response handling | Existing modal Escape/focus/role gaps remain |
| A6-09 | Displayed ticker/exchange/score validation contracts | Custom persisted rules remain intact |
| A6-10 | Unknown nested counts and bounded aggregate waiting | Underlying shared reads are not canceled |
| A6-11 | Trade analytics and learning source states | Historical execution data not reconciled |
| A6-12 | Audit loading/error/filter/page/cache provenance | Existing explicit materialization remains separate from retry |
| A6-13 | Preserve explicit containment/service error provenance | Service availability remains unresolved |
| A6-14 | Original historical partial-output diagnostics/hashes in projection | Stored historical records remain unchanged |
| A6-15 | Sell Batch summary derives verification from mail history | No independent batch source or live batch execution claimed |
| A6-16 | Requested identity vs successful-call telemetry | Actual historical attribution depends on available telemetry |
| A6-17 | UTC parsing, invalid intervals and unattributed gaps | Upstream timestamp anomaly cause unproven |
| A6-18 | Saved lifecycle/status wording and missing completion | Component completion does not prove workflow completion |
| A6-19 | Shared Universal history/failure-source provenance | Service availability remains independent |

Backend changes are additive response projection and a user/job-scoped read of existing successful provider-call telemetry. No migrations, persisted financial/history rewrites, retries, provider execution, credentials, permissions or schedules change. The telemetry query adds a dependency to the detail read; its errors follow the existing request-failure path. The existing deployment classifier reports full-stack; it is unchanged.

## Local verification

Actual-component offline browser checks cover Dashboard, Events/Threats, model estimates, selected-input counts, holding details, Bullpen source states, cost history, Final calculations/deadline recovery, trade analytics, audit paging, mail-source summary, provenance/lifecycle, timing and Universal history. These checks do not establish authenticated production acceptance. Original PDF pixels were unavailable through the supported transfer; no review of them is claimed. Timing 200% coverage uses equivalent viewport/pixel scaling rather than native browser zoom.

Integrated backend checks: 251 passed, 3 explicitly skipped PostgreSQL cases (no acknowledged disposable local target). Local Python is 3.12; CI uses 3.13. Baseline comparisons reproduce the new A6-14/A6-16 regressions. Existing deprecation warnings remain.

The complete required frontend and backend CI suites, build/runtime checks and authenticated production read-back are release gates. Synthetic local evidence is recorded privately; an implementation change is not proof that historical or service findings are closed.
